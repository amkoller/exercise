import { zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { BT, data, def, encodeFit, type FitItem } from "../../fit/testing/encodeFit.js";
import { context } from "../__fixtures__/rides.js";
import { createMemorySyncStore } from "../testing/memoryStore.js";
import type { SyncState } from "../../types.js";
import { FIT_ACCEPT, createGarminClient } from "./client.js";
import { refetchStreams, runGarminActivities } from "./runActivities.js";
import { fakeGarmin, pagedSearch, type FakeGarminOptions } from "./__fixtures__/fakeGarmin.js";
import { JWT_IAT, LIST_PAGE, fitZipFor } from "./__fixtures__/garmin.js";

const baseState: SyncState = {
  source: "garmin_activities",
  cursor: null,
  lastRunAt: null,
  lastSuccessAt: null,
  itemsFetched: 0,
  itemsUpserted: 0,
  lastError: null,
  backfillComplete: false,
  authStatus: "ok",
};

const NOW = JWT_IAT * 1000 + 3_600_000; // 2026-01-01T01:00Z, inside the synthetic token's life

function setup(o: FakeGarminOptions = {}, syncState: SyncState[] = []) {
  const fake = fakeGarmin(o);
  const clock = { t: NOW };
  const now = () => clock.t;
  const client = createGarminClient({ fetch: fake.fetch, apiKey: "k", sleep: async () => {}, now });
  const store = createMemorySyncStore("user-1", { syncState });
  const upsert = vi.spyOn(store, "upsertActivity");
  const opts = { mode: "full" as const, deadlineMs: NOW + 60_000, now, ingestContext: async () => context() };
  return { fake, clock, client, store, upsert, opts };
}

const searches = (fake: ReturnType<typeof fakeGarmin>) =>
  fake.dataCalls().filter((c) => c.url.pathname.startsWith("/activitylist-service"));

describe("runGarminActivities", () => {
  it("(d) backfills newest first, stops on an empty page and marks the backfill complete", async () => {
    const { fake, client, store, opts } = setup({ search: pagedSearch(LIST_PAGE) });
    const r = await runGarminActivities(client, store, opts);
    expect(r).toMatchObject({ source: "garmin_activities", fetched: 3, upserted: 3, skipped: 0, done: true, error: null });
    expect(r.earliestAffected).toBe("2026-06-01T14:00:00.000Z");
    expect(searches(fake).map((c) => c.url.searchParams.get("start"))).toEqual(["0", "3"]);
    const s = store.state.syncState.get("garmin_activities")!;
    expect(s).toMatchObject({
      backfillComplete: true,
      cursor: { mode: "incremental" },
      authStatus: "ok",
      lastError: null,
      itemsFetched: 3,
      itemsUpserted: 3,
      lastRunAt: new Date(NOW).toISOString(),
      lastSuccessAt: new Date(NOW).toISOString(),
    });
    const road = [...store.state.activities.values()].find((a) => a.sourceId === "900000003")!;
    expect(road.timezone).toBe("America/New_York");
    expect(road.subType).toBe("road_biking");
    expect(store.state.streams.get(road.id)?.map((x) => x.channel)).toEqual(["distance"]);
    expect(store.state.payloads.get(road.id)).toEqual(LIST_PAGE[0]);
  });

  it("(e) saves the cursor at the page start when the deadline hits mid-page, and resumes without duplicates", async () => {
    const s = setup({
      search: pagedSearch(LIST_PAGE),
      fit: (id) => {
        s.clock.t = Math.max(s.clock.t, NOW + 60_000); // the deadline passes while item 1 is downloading
        return fitZipFor(id);
      },
    });
    const first = await runGarminActivities(s.client, s.store, s.opts);
    expect(first).toMatchObject({ fetched: 3, upserted: 1, done: false, error: null });
    expect(s.store.state.syncState.get("garmin_activities")).toMatchObject({
      backfillComplete: false,
      cursor: { mode: "backfill", start: 0 },
    });

    s.opts.deadlineMs = NOW + 3_600_000;
    const second = await runGarminActivities(s.client, s.store, s.opts);
    expect(second).toMatchObject({ upserted: 2, done: true, error: null });
    expect(s.upsert.mock.calls.map(([row]) => row.sourceId)).toEqual(["900000003", "900000002", "900000001"]);
    expect(s.store.state.activities.size).toBe(3);
    // The backfill holds last_success_at at its first run, which is when it read the newest rides.
    expect(s.store.state.syncState.get("garmin_activities")).toMatchObject({
      backfillComplete: true,
      lastSuccessAt: new Date(NOW).toISOString(),
      lastRunAt: new Date(NOW + 60_000).toISOString(),
    });
    expect(searches(s.fake).map((c) => c.url.searchParams.get("start"))).toEqual(["0", "0", "3"]);
  });

  it("resumes a saved backfill offset", async () => {
    const s = setup({ search: pagedSearch(LIST_PAGE) }, [
      { ...baseState, cursor: { mode: "backfill", start: 2 } },
    ]);
    const r = await runGarminActivities(s.client, s.store, { ...s.opts, mode: "incremental" });
    expect(r).toMatchObject({ fetched: 1, upserted: 1, done: true });
    expect(searches(s.fake).map((c) => c.url.searchParams.get("start"))).toEqual(["2", "3"]);
  });

  it("(f) incremental pages from last_success_at − 3 days to today and skips stored rides", async () => {
    const lastSuccessAt = "2025-12-30T05:00:00.000Z";
    const s = setup({ search: (q) => (q.get("start") === "0" ? LIST_PAGE.slice(0, 2) : []) }, [
      { ...baseState, backfillComplete: true, cursor: { mode: "incremental" }, lastSuccessAt },
    ]);
    await s.store.upsertActivity({
      source: "garmin",
      sourceId: "900000002",
      startedAt: "2026-06-02T13:00:00.000Z",
      sport: "cycling",
      environment: "outdoor",
      providerPayload: {},
    });
    s.upsert.mockClear();
    const r = await runGarminActivities(s.client, s.store, { ...s.opts, mode: "incremental" });
    expect(r).toMatchObject({ fetched: 2, upserted: 1, done: true, error: null });
    const q = searches(s.fake).map((c) => Object.fromEntries(c.url.searchParams));
    expect(q).toEqual([
      { activityType: "cycling", limit: "99", start: "0", startDate: "2025-12-27", endDate: "2026-01-01" },
      { activityType: "cycling", limit: "99", start: "2", startDate: "2025-12-27", endDate: "2026-01-01" },
    ]);
    expect(s.upsert.mock.calls.map(([row]) => row.sourceId)).toEqual(["900000003"]);
    expect(s.store.state.syncState.get("garmin_activities")!.lastSuccessAt).toBe(new Date(NOW).toISOString());
  });

  it("keeps last_success_at when an incremental run is cut short", async () => {
    const lastSuccessAt = "2025-12-30T05:00:00.000Z";
    const s = setup({ search: pagedSearch(LIST_PAGE) }, [
      { ...baseState, backfillComplete: true, cursor: { mode: "incremental" }, lastSuccessAt },
    ]);
    s.opts.deadlineMs = NOW;
    const r = await runGarminActivities(s.client, s.store, { ...s.opts, mode: "incremental" });
    expect(r).toMatchObject({ upserted: 0, done: false, error: null });
    expect(s.store.state.syncState.get("garmin_activities")).toMatchObject({
      lastSuccessAt,
      lastRunAt: new Date(NOW).toISOString(),
      cursor: { mode: "incremental" },
    });
  });

  it("(b) a token 500 stops the run after one request and sets reconnect_required", async () => {
    const s = setup({ tokens: [() => new Response("", { status: 500 })], search: pagedSearch(LIST_PAGE) });
    const r = await runGarminActivities(s.client, s.store, s.opts);
    expect(r).toMatchObject({ done: false, upserted: 0, error: "GARMIN_API_KEY rejected (HTTP 500)" });
    expect(s.fake.calls).toHaveLength(1);
    expect(s.store.state.syncState.get("garmin_activities")).toMatchObject({
      authStatus: "reconnect_required",
      lastError: "GARMIN_API_KEY rejected (HTTP 500)",
      lastSuccessAt: null,
      cursor: { mode: "backfill", start: 0 },
    });
  });

  it("(i) a corrupt FIT gives a summary-only row with flat TSS and the run continues", async () => {
    const s = setup({
      search: pagedSearch(LIST_PAGE),
      fit: (id) => (id === "900000003" ? new Uint8Array([1, 2, 3, 4]) : fitZipFor(id)),
    });
    const r = await runGarminActivities(s.client, s.store, s.opts);
    expect(r).toMatchObject({ upserted: 3, skipped: 1, done: true, error: null });
    const road = [...s.store.state.activities.values()].find((a) => a.sourceId === "900000003")!;
    expect(road.tssSource).toBe("estimated_flat");
    expect(road.tss).not.toBeNull();
    expect(road.hasPower).toBe(false);
    expect(road.avgPowerW).toBe(200); // Garmin's summary value survives
    expect(s.store.state.streams.get(road.id)).toEqual([]);
  });

  it("a failed FIT download also falls back to summary only", async () => {
    const s = setup({
      search: pagedSearch(LIST_PAGE),
      fit: () => new Response("gone", { status: 404 }),
    });
    const r = await runGarminActivities(s.client, s.store, s.opts);
    expect(r).toMatchObject({ upserted: 3, skipped: 3, done: true, error: null });
    expect(r.notes).toEqual(["fit failed (http 404): 3 rides, e.g. activity 900000003"]);
  });

  it("records a non-auth error with the cursor at the failing page", async () => {
    const s = setup({
      search: (q) => (q.get("start") === "0" ? LIST_PAGE : new Response("down", { status: 503 })),
    });
    const r = await runGarminActivities(s.client, s.store, s.opts);
    expect(r).toMatchObject({ upserted: 3, done: false, error: expect.stringContaining("HTTP 503") });
    expect(s.store.state.syncState.get("garmin_activities")).toMatchObject({
      authStatus: "ok",
      cursor: { mode: "backfill", start: 3 },
      lastSuccessAt: null,
    });
  });

  describe("FIT start alignment (AI-645)", () => {
    const streamsOf = (store: ReturnType<typeof setup>["store"], sourceId: string) => {
      const a = [...store.state.activities.values()].find((x) => x.sourceId === sourceId)!;
      return { activity: a, streams: store.state.streams.get(a.id)! };
    };

    it("stores startOffsetS = 0 on every stream when the FIT starts at beginTimestamp", async () => {
      const s = setup({ search: pagedSearch(LIST_PAGE) });
      const r = await runGarminActivities(s.client, s.store, s.opts);
      expect(r).toMatchObject({ upserted: 3, skipped: 0, error: null });
      expect(r.notes).toBeUndefined();
      for (const item of LIST_PAGE) {
        const { streams } = streamsOf(s.store, String(item.activityId));
        expect(streams.length).toBeGreaterThan(0);
        for (const st of streams) expect(st.startOffsetS).toBe(0);
      }
      expect(s.store.state.syncState.get("garmin_activities")!.lastError).toBeNull();
    });

    it("stores startOffsetS = 7 on every stream when the first record is 7 s after beginTimestamp", async () => {
      const s = setup({ search: pagedSearch(LIST_PAGE), fit: (id) => fitZipFor(id, 7) });
      const r = await runGarminActivities(s.client, s.store, s.opts);
      expect(r).toMatchObject({ upserted: 3, skipped: 0, done: true, error: null });
      const { activity, streams } = streamsOf(s.store, "900000003");
      expect(activity.startedAt).toBe("2026-06-03T12:00:00.000Z"); // startedAt is unchanged
      expect(streams.map((x) => x.channel)).toEqual(["distance"]);
      for (const st of streams) {
        expect(st.startOffsetS).toBe(7);
        expect(st.values).toHaveLength(5); // not padded or trimmed
      }
    });

    it("floors a sub-second gap and allows a FIT that starts before beginTimestamp", async () => {
      const items = [
        { ...LIST_PAGE[0]!, beginTimestamp: LIST_PAGE[0]!.beginTimestamp! - 500 }, // FIT 0.5 s later → 0
        { ...LIST_PAGE[1]!, beginTimestamp: LIST_PAGE[1]!.beginTimestamp! + 3000 }, // FIT 3 s earlier → -3
      ];
      const s = setup({ search: pagedSearch(items) });
      const r = await runGarminActivities(s.client, s.store, s.opts);
      expect(r).toMatchObject({ upserted: 2, skipped: 0, error: null });
      expect(streamsOf(s.store, "900000003").streams.map((x) => x.startOffsetS)).toEqual([0]);
      expect(streamsOf(s.store, "900000002").streams.map((x) => x.startOffsetS)).toEqual([-3]);
    });

    it("ignores FIT timing more than 3600 s off, stores offset 0, counts it skipped and notes last_error", async () => {
      const s = setup({
        search: pagedSearch(LIST_PAGE),
        fit: (id) => (id === "900000003" ? fitZipFor(id, 3601) : id === "900000002" ? fitZipFor(id, 3600) : fitZipFor(id)),
      });
      const r = await runGarminActivities(s.client, s.store, s.opts);
      expect(r).toMatchObject({ upserted: 3, skipped: 1, done: true, error: null });
      expect(r.notes).toHaveLength(1);
      expect(r.notes![0]).toContain("activity 900000003");
      const road = streamsOf(s.store, "900000003");
      expect(road.streams.length).toBeGreaterThan(0);
      for (const st of road.streams) expect(st.startOffsetS).toBe(0);
      expect(road.activity.startedAt).toBe("2026-06-03T12:00:00.000Z");
      // Exactly 3600 s is within the guard.
      expect(streamsOf(s.store, "900000002").streams.map((x) => x.startOffsetS)).toEqual([3600]);
      const state = s.store.state.syncState.get("garmin_activities")!;
      expect(state.lastError).toContain("activity 900000003");
      expect(state.lastSuccessAt).toBe(new Date(NOW).toISOString()); // a note does not fail the run
    });

    it("applies the guard to a FIT that starts long before beginTimestamp", async () => {
      const s = setup({ search: pagedSearch(LIST_PAGE.slice(0, 1)), fit: (id) => fitZipFor(id, -7200) });
      const r = await runGarminActivities(s.client, s.store, s.opts);
      expect(r).toMatchObject({ upserted: 1, skipped: 1, error: null });
      expect(streamsOf(s.store, "900000003").streams.map((x) => x.startOffsetS)).toEqual([0]);
    });
  });
});

describe("FIT failure classification (AI-861)", () => {
  const status = (n: number) => () => new Response("no", { status: n });

  it("downloads the FIT with the probe's Accept header", async () => {
    const s = setup({ search: pagedSearch(LIST_PAGE.slice(0, 1)) });
    await runGarminActivities(s.client, s.store, s.opts);
    const dl = s.fake.dataCalls().filter((c) => c.url.pathname.startsWith("/download-service"));
    expect(dl).toHaveLength(1);
    expect(dl[0]!.headers.Accept).toBe("application/zip, application/x-zip-compressed, application/octet-stream");
    expect(FIT_ACCEPT).toBe("application/zip, application/x-zip-compressed, application/octet-stream");
  });

  it("a 429 past the retries ends the run with the ride unstored and the cursor on the page", async () => {
    const s = setup({ search: pagedSearch(LIST_PAGE), fit: (id) => (id === "900000002" ? status(429)() : fitZipFor(id)) });
    const r = await runGarminActivities(s.client, s.store, s.opts);
    expect(r).toMatchObject({ upserted: 1, done: false, error: expect.stringContaining("HTTP 429") });
    expect([...s.store.state.activities.values()].map((a) => a.sourceId)).toEqual(["900000003"]);
    expect(s.store.state.syncState.get("garmin_activities")).toMatchObject({
      cursor: { mode: "backfill", start: 0 },
      lastError: expect.stringContaining("HTTP 429"),
      lastSuccessAt: null,
    });
  });

  it.each([500, 503])("a %i ends the run", async (code) => {
    const s = setup({ search: pagedSearch(LIST_PAGE), fit: status(code) });
    const r = await runGarminActivities(s.client, s.store, s.opts);
    expect(r).toMatchObject({ upserted: 0, done: false, error: expect.stringContaining(`HTTP ${code}`) });
    expect(s.store.state.activities.size).toBe(0);
  });

  it("a network error (TypeError from fetch) ends the run", async () => {
    const s = setup({ search: pagedSearch(LIST_PAGE), fit: () => { throw new TypeError("fetch failed"); } });
    const r = await runGarminActivities(s.client, s.store, s.opts);
    expect(r).toMatchObject({ upserted: 0, done: false, error: "fetch failed" });
    expect(s.store.state.activities.size).toBe(0);
  });

  it("a 406 stores the ride summary-only, notes it and writes the key into last_error", async () => {
    const s = setup({ search: pagedSearch(LIST_PAGE), fit: (id) => (id === "900000001" ? fitZipFor(id) : status(406)()) });
    const r = await runGarminActivities(s.client, s.store, s.opts);
    expect(r).toMatchObject({ upserted: 3, skipped: 2, done: true, error: null });
    expect(r.notes).toEqual(["fit failed (http 406): 2 rides, e.g. activity 900000003"]);
    const road = [...s.store.state.activities.values()].find((a) => a.sourceId === "900000003")!;
    expect(road.tssSource).toBe("estimated_flat");
    expect(s.store.state.streams.get(road.id)).toEqual([]);
    const state = s.store.state.syncState.get("garmin_activities")!;
    expect(state.lastError).toMatch(/^fit failed \(http 406\)/);
    expect(state.lastSuccessAt).toBe(new Date(NOW).toISOString());
  });

  it("a FitError is noted by its message, one note per key", async () => {
    const s = setup({
      search: pagedSearch(LIST_PAGE),
      fit: (id) => (id === "900000001" ? status(404)() : new Uint8Array([1, 2, 3, 4])),
    });
    const r = await runGarminActivities(s.client, s.store, s.opts);
    expect(r).toMatchObject({ upserted: 3, skipped: 3, done: true, error: null });
    expect(r.notes).toHaveLength(2);
    expect(r.notes![0]).toMatch(/^fit failed \(fit: not a readable ZIP: .*\): 2 rides, e.g. activity 900000003$/);
    expect(r.notes![1]).toBe("fit failed (http 404): 1 ride, e.g. activity 900000001");
    expect(s.store.state.syncState.get("garmin_activities")!.lastError).toMatch(/^fit failed \(fit: not a readable ZIP/);
  });
});

/** Seconds from the Unix epoch to the FIT epoch. */
const FIT_EPOCH_S = 631_065_600;

/** A zipped outdoor FIT: `seconds` records at 10 m/s, climbing 60 m over the ride. */
function climbingFitZip(startMs: number, seconds = 900): Uint8Array {
  const t0 = Math.floor(startMs / 1000) - FIT_EPOCH_S;
  const items: FitItem[] = [
    def(0, 20, [
      { num: 253, baseType: BT.uint32 },
      { num: 5, baseType: BT.uint32 }, // distance, cm
      { num: 2, baseType: BT.uint16 }, // altitude, (m + 500) * 5
    ]),
  ];
  for (let i = 0; i < seconds; i++) items.push(data(0, [t0 + i, i * 1000, Math.round((500 + (60 * i) / (seconds - 1)) * 5)]));
  return zipSync({ "ride.fit": encodeFit(items) });
}

const startOf = (id: string) => LIST_PAGE.find((i) => String(i.activityId) === id)!.beginTimestamp!;

describe("refetchStreams (AI-861)", () => {
  /** Stores LIST_PAGE summary-only (every FIT 406), then switches the FIT answers to `fit`. */
  async function summaryOnly(fit: (id: string) => Uint8Array | Response = (id) => climbingFitZip(startOf(id))) {
    const answers = { fit: (_id: string): Uint8Array | Response => new Response("", { status: 406 }) };
    const s = setup({ search: pagedSearch(LIST_PAGE), fit: (id) => answers.fit(id) });
    await runGarminActivities(s.client, s.store, s.opts);
    answers.fit = fit;
    s.upsert.mockClear();
    const refetchOpts = { deadlineMs: s.opts.deadlineMs, now: s.opts.now, ingestContext: s.opts.ingestContext };
    return { ...s, refetchOpts };
  }

  const byId = (store: ReturnType<typeof setup>["store"], sourceId: string) =>
    [...store.state.activities.values()].find((a) => a.sourceId === sourceId)!;

  it("reingests every Garmin ride without streams, oldest first, writing streams, biggest climb and best efforts", async () => {
    const s = await summaryOnly();
    // A Peloton ride without streams and a Garmin ride with streams are not candidates.
    await s.store.upsertActivity({ source: "peloton", sourceId: "p-1", startedAt: "2026-05-01T10:00:00Z", sport: "cycling", environment: "indoor", providerPayload: {} });
    const withStreams = byId(s.store, "900000002");
    await s.store.replaceStreams(withStreams.id, [{ channel: "distance", values: [0, 1] }]);
    s.upsert.mockClear();

    const r = await refetchStreams(s.client, s.store, s.refetchOpts);
    expect(r).toEqual({ candidates: 2, refetched: 2, failed: 0, remaining: 0, done: true, error: null, notes: [] });
    expect(s.upsert.mock.calls.map(([row]) => row.sourceId)).toEqual(["900000001", "900000003"]);

    const road = byId(s.store, "900000003");
    expect(s.store.state.streams.get(road.id)!.map((x) => x.channel).sort()).toEqual(["altitude", "distance"]);
    expect(road.biggestClimbM).toBeGreaterThan(50);
    expect(road.bestEfforts).toEqual([expect.objectContaining({ label: "5 mile" })]);
    expect(road.timezone).toBe("America/New_York");
    expect(s.store.state.payloads.get(road.id)).toEqual(LIST_PAGE[0]);
    // The ride kept its id: the upsert matched on (source, sourceId).
    expect(s.store.state.activities.size).toBe(4);

    const again = await refetchStreams(s.client, s.store, s.refetchOpts);
    expect(again).toMatchObject({ candidates: 0, refetched: 0, done: true });
  });

  it("--limit reingests the oldest n and leaves the rest for a rerun", async () => {
    const s = await summaryOnly();
    const r = await refetchStreams(s.client, s.store, { ...s.refetchOpts, limit: 1 });
    expect(r).toMatchObject({ candidates: 3, refetched: 1, failed: 0, remaining: 2, done: false, error: null });
    expect(s.upsert.mock.calls.map(([row]) => row.sourceId)).toEqual(["900000001"]);
  });

  it("a transient failure stops the run with the remaining count", async () => {
    const s = await summaryOnly((id) => (id === "900000002" ? new Response("", { status: 503 }) : climbingFitZip(startOf(id))));
    const r = await refetchStreams(s.client, s.store, s.refetchOpts);
    expect(r).toMatchObject({ candidates: 3, refetched: 1, failed: 0, remaining: 2, done: false, error: expect.stringContaining("HTTP 503") });
    expect(s.store.state.streams.get(byId(s.store, "900000003").id)).toEqual([]);
  });

  it("a permanent failure is noted and leaves the ride as it is", async () => {
    const s = await summaryOnly((id) => (id === "900000002" ? new Uint8Array([9, 9]) : climbingFitZip(startOf(id))));
    const before = byId(s.store, "900000002");
    const r = await refetchStreams(s.client, s.store, s.refetchOpts);
    expect(r).toMatchObject({ candidates: 3, refetched: 2, failed: 1, remaining: 0, done: true, error: null });
    expect(r.notes).toEqual([expect.stringMatching(/^fit failed \(fit: not a readable ZIP.*\): 1 ride, e.g. activity 900000002$/)]);
    expect(byId(s.store, "900000002")).toEqual(before);
  });

  it("a FIT with no record channels counts as failed, not refetched", async () => {
    const empty = (id: string) => {
      const t0 = Math.floor(startOf(id) / 1000) - FIT_EPOCH_S;
      return zipSync({ "ride.fit": encodeFit([def(0, 20, [{ num: 253, baseType: BT.uint32 }]), data(0, [t0]), data(0, [t0 + 1])]) });
    };
    const s = await summaryOnly((id) => (id === "900000001" ? empty(id) : climbingFitZip(startOf(id))));
    const r = await refetchStreams(s.client, s.store, s.refetchOpts);
    expect(r).toMatchObject({ candidates: 3, refetched: 2, failed: 1, remaining: 0, done: true, error: null });
    expect(r.notes).toEqual(["fit failed (fit: FIT has no record channels): 1 ride, e.g. activity 900000001"]);
    expect(s.upsert.mock.calls.map(([row]) => row.sourceId)).toEqual(["900000002", "900000003"]);
  });

  it("starts no ride past the deadline", async () => {
    const s = await summaryOnly();
    const r = await refetchStreams(s.client, s.store, { ...s.refetchOpts, deadlineMs: NOW });
    expect(r).toMatchObject({ candidates: 3, refetched: 0, remaining: 3, done: false, error: null });
  });
});
