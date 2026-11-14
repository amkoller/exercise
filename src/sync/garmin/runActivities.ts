/** Garmin rides: resumable newest-first backfill, then a daily incremental sync (AI-638). */
import { MAX_FIT_START_OFFSET_S, channelsFromFitWithStart, fitStartOffsetS } from "../fitChannels.js";
import { SyncDeadlineError } from "../http.js";
import { ingestActivity } from "../ingest.js";
import { persistActivity } from "../persist.js";
import type { SyncStore } from "../store.js";
import type { Channels, IngestContext, SyncRunResult } from "../types.js";
import { FitError } from "../../fit/index.js";
import type { ExternalActivity } from "../../types.js";
import { ACTIVITY_PAGE_SIZE, GarminAuthError, GarminHttpError, type GarminClient } from "./client.js";
import { garminToProvider } from "./normalize.js";
import { DAY_MS, LOOKBACK_DAYS, errorMessage, finishRun, successAdvances, utcDate } from "./runShared.js";
import type { GarminActivitiesCursor, GarminListItem } from "./types.js";

export interface GarminRunOptions {
  mode: "full" | "incremental";
  /** Epoch ms; no new item is started at or after it. */
  deadlineMs: number;
  now: () => number;
  ingestContext: () => Promise<IngestContext>;
}

const SOURCE = "garmin_activities" as const;

/**
 * Whether a FIT download failure ends the run (AI-861). Auth and deadline refusals, Garmin 429
 * and 5xx answers (after the client's retries) and network errors (fetch rejects with a
 * TypeError) are transient: the caller rethrows them, so the ride stays unstored and the next
 * run retries it. Any other HTTP status (a 4xx such as 406 or 404) is permanent: retrying would
 * fail the same way. Decode errors are never passed here: they are all permanent, so a decoder
 * TypeError cannot stall the sync on one file.
 */
export function isTransientFitFailure(e: unknown): boolean {
  if (e instanceof GarminAuthError || e instanceof SyncDeadlineError) return true;
  if (e instanceof GarminHttpError) return e.status === 429 || e.status >= 500;
  return e instanceof TypeError;
}

/**
 * Downloads and decodes a ride's FIT. A transient download failure is rethrown; a permanent
 * download failure or any decode error is returned as `{ failure }` for the run's tally.
 */
async function fetchFit(
  client: GarminClient,
  id: number | string,
): Promise<{ fit: ReturnType<typeof channelsFromFitWithStart> } | { failure: unknown }> {
  let zip: Uint8Array;
  try {
    zip = await client.activityFitZip(id);
  } catch (e) {
    if (isTransientFitFailure(e)) throw e;
    return { failure: e };
  }
  try {
    return { fit: channelsFromFitWithStart(zip, "zip") };
  } catch (e) {
    return { failure: e };
  }
}

/** The fitFailures key of a permanent failure: `http <status>`, `fit: <message>` or `error: <message>`. */
export function fitFailureKey(e: unknown): string {
  if (e instanceof GarminHttpError) return `http ${e.status}`;
  if (e instanceof FitError) return `fit: ${e.message.slice(0, 80)}`;
  return `error: ${errorMessage(e).slice(0, 80)}`;
}

/** Per-run tally of permanent FIT failures, by key, with the first activity id of each. */
export class FitFailures {
  readonly counts: Record<string, number> = {};
  private readonly examples = new Map<string, string>();

  add(e: unknown, activityId: string | number): void {
    const key = fitFailureKey(e);
    this.counts[key] = (this.counts[key] ?? 0) + 1;
    if (!this.examples.has(key)) this.examples.set(key, String(activityId));
  }

  get total(): number {
    return Object.values(this.counts).reduce((a, b) => a + b, 0);
  }

  /** One note per key, in first-seen order: `fit failed (<key>): <n> rides, e.g. activity <id>`. */
  notes(): string[] {
    return [...this.examples].map(
      ([key, id]) => `fit failed (${key}): ${this.counts[key]} ${this.counts[key] === 1 ? "ride" : "rides"}, e.g. activity ${id}`,
    );
  }
}

function readCursor(raw: unknown): GarminActivitiesCursor | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as { mode?: unknown; start?: unknown };
  if (c.mode === "incremental") return { mode: "incremental" };
  if (c.mode === "backfill" && typeof c.start === "number" && Number.isInteger(c.start) && c.start >= 0) {
    return { mode: "backfill", start: c.start };
  }
  return null;
}

/**
 * One run. Backfill (while backfill_complete is false, in either mode) pages the whole history
 * newest first from the saved offset; incremental pages last_success_at − 3 days to today.
 * Stored rides are skipped. The deadline is checked before each item; the cursor then points
 * at the current page, so the next run re-reads it and skips what this one stored.
 */
export async function runGarminActivities(
  client: GarminClient,
  store: SyncStore,
  opts: GarminRunOptions,
): Promise<SyncRunResult> {
  const startedMs = opts.now();
  const state = await store.getSyncState(SOURCE);
  let backfillComplete = state?.backfillComplete ?? false;
  const saved = readCursor(state?.cursor);
  const backfill = !backfillComplete;
  let start = backfill && saved?.mode === "backfill" ? saved.start : 0;
  const cursorAt = (s: number): GarminActivitiesCursor =>
    backfillComplete ? { mode: "incremental" } : { mode: "backfill", start: s };

  let fetched = 0;
  let upserted = 0;
  let skipped = 0;
  let earliest: string | null = null;
  let tokenOk = false;
  const notes: string[] = [];
  const fitFailures = new FitFailures();

  const finish = (done: boolean, error: unknown) =>
    finishRun(store, opts.now, {
      source: SOURCE,
      cursor: cursorAt(start),
      backfillComplete,
      fetched,
      upserted,
      skipped,
      done,
      earliestAffected: earliest,
      error,
      tokenOk,
      // The FIT failure notes go first, so last_error starts with the first failure's key.
      notes: [...fitFailures.notes(), ...notes],
      startedMs,
      advanceSuccess: successAdvances(backfill, done, state?.lastSuccessAt),
    });

  async function processItem(item: GarminListItem): Promise<void> {
    if (typeof item.activityId !== "number") {
      skipped++;
      return;
    }
    const id = item.activityId;
    if (await store.hasActivity("garmin", String(id))) return;
    const detail = await client.activityDetail(id);
    let channels: Channels | null = null;
    let fitStartTime: string | null = null;
    // A transient download failure throws out of fetchFit and ends the run: the ride stays
    // unstored and the cursor stays on this page, so the next run fetches it in full.
    const got = await fetchFit(client, id);
    if ("fit" in got) ({ channels, startTime: fitStartTime } = got.fit);
    else {
      // Permanent: summary only (no streams, flat TSS), counted for the run's notes.
      fitFailures.add(got.failure, id);
      skipped++;
    }
    const provider = garminToProvider(item, detail.timeZoneUnitDTO?.timeZone ?? null);
    // Slot 0 of the channels is the FIT's first record, which can trail beginTimestamp (GPS lock,
    // auto-start). The streams keep startedAt and carry the gap as start_offset_s.
    const offset = fitStartOffsetS(provider.startedAt, fitStartTime);
    const result = ingestActivity(provider, channels, await opts.ingestContext(), offset.offsetS);
    await persistActivity(store, result);
    upserted++;
    if (!offset.ok) {
      // A corrupt FIT header: the streams are stored at offset 0 and the ride is flagged.
      skipped++;
      notes.push(
        `activity ${id}: FIT start ${fitStartTime} is more than ${MAX_FIT_START_OFFSET_S} s from ${provider.startedAt}; streams stored at offset 0`,
      );
    }
    if (earliest === null || Date.parse(provider.startedAt) < Date.parse(earliest)) earliest = provider.startedAt;
  }

  let done = false;
  let error: unknown = null;
  try {
    await client.token();
    tokenOk = true;

    let window: { startDate: string; endDate: string } | undefined;
    if (!backfill) {
      const nowMs = opts.now();
      const base = state?.lastSuccessAt ? Date.parse(state.lastSuccessAt) : nowMs;
      window = { startDate: utcDate(base - LOOKBACK_DAYS * DAY_MS), endDate: utcDate(nowMs) };
    }

    pages: for (;;) {
      if (opts.now() >= opts.deadlineMs) break;
      const page = await client.searchActivities({ start, limit: ACTIVITY_PAGE_SIZE, ...window });
      fetched += page.length;
      if (page.length === 0) {
        if (backfill) backfillComplete = true;
        start = 0;
        done = true;
        break;
      }
      for (const item of page) {
        if (opts.now() >= opts.deadlineMs) break pages;
        await processItem(item);
      }
      start += page.length;
    }
  } catch (e) {
    error = e;
  }
  return finish(done, error);
}

export interface RefetchStreamsOptions {
  /** Process at most this many candidates (oldest first). */
  limit?: number;
  /** Epoch ms; no new ride is started at or after it. */
  deadlineMs: number;
  now: () => number;
  ingestContext: () => Promise<IngestContext>;
}

export interface RefetchStreamsResult {
  /** Garmin rides stored without any stream row. */
  candidates: number;
  refetched: number;
  /** Permanent failures: the ride is left summary-only. */
  failed: number;
  /** Candidates not attempted (limit, deadline or a transient error); a rerun picks them up. */
  remaining: number;
  done: boolean;
  error: string | null;
  notes: string[];
}

/**
 * Repairs Garmin rides stored summary-only (AI-861): for every Garmin ride with no stream row,
 * oldest first, downloads the FIT and reingests the ride from its stored list item, writing the
 * streams and every stream-derived column (TSS, power curve, best efforts, biggest climb).
 * Failures are classified like the sync's: a transient one ends the run (rerun to resume), a
 * permanent one is noted and leaves the ride as it is.
 */
export async function refetchStreams(
  client: GarminClient,
  store: SyncStore,
  opts: RefetchStreamsOptions,
): Promise<RefetchStreamsResult> {
  const [all, withStreams] = await Promise.all([store.listAllActivities(), store.listActivityIdsWithStreams("garmin")]);
  const candidates: ExternalActivity[] = all.filter((a) => a.source === "garmin" && !withStreams.has(a.id));
  const todo = opts.limit === undefined ? candidates : candidates.slice(0, opts.limit);
  const fitFailures = new FitFailures();
  const notes: string[] = [];
  let refetched = 0;
  let error: string | null = null;
  let attempted = 0;

  try {
    for (const row of todo) {
      if (opts.now() >= opts.deadlineMs) break;
      const payload = await store.getActivityProviderPayload(row.id);
      if (payload === null || typeof payload !== "object") {
        attempted++;
        fitFailures.add(new Error("no provider_payload stored"), row.sourceId);
        continue;
      }
      const got = await fetchFit(client, row.sourceId);
      if (!("fit" in got)) {
        attempted++;
        fitFailures.add(got.failure, row.sourceId);
        continue;
      }
      const { fit } = got;
      if (Object.values(fit.channels).every((v) => !v || v.length === 0)) {
        // Nothing to store: the ride would stay a candidate, so it counts as failed, not refetched.
        attempted++;
        fitFailures.add(new FitError("FIT has no record channels"), row.sourceId);
        continue;
      }
      const provider = garminToProvider(payload as GarminListItem, row.timezone);
      const offset = fitStartOffsetS(provider.startedAt, fit.startTime);
      const result = ingestActivity(provider, fit.channels, await opts.ingestContext(), offset.offsetS);
      await persistActivity(store, result);
      attempted++;
      refetched++;
      if (!offset.ok) {
        notes.push(
          `activity ${row.sourceId}: FIT start ${fit.startTime} is more than ${MAX_FIT_START_OFFSET_S} s from ${provider.startedAt}; streams stored at offset 0`,
        );
      }
    }
  } catch (e) {
    error = errorMessage(e);
  }

  const remaining = candidates.length - attempted;
  return {
    candidates: candidates.length,
    refetched,
    failed: fitFailures.total,
    remaining,
    done: error === null && remaining === 0,
    error,
    notes: [...fitFailures.notes(), ...notes],
  };
}
