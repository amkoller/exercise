import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createSupabaseStub } from "../data/supabaseStub.js";
import { PAGE_SIZE, createSupabaseSyncStore } from "./store.js";
import { createMemorySyncStore } from "./testing/memoryStore.js";
import type { StoredCredential } from "./types.js";

type Call = [method: string, ...args: unknown[]];
interface Query {
  table: string;
  calls: Call[];
}
type Responder = (q: Query) => { data: unknown; error: unknown };

/** A Supabase client double that records every builder chain and answers each with `respond`. */
function recordingClient(respond: Responder) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, calls: [] };
      queries.push(q);
      const builder: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) => Promise.resolve(respond(q)).then(ok, fail);
            }
            return (...args: unknown[]) => {
              q.calls.push([String(prop), ...args]);
              return builder;
            };
          },
        },
      );
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, queries };
}

const has = (q: Query, method: string, ...args: unknown[]) =>
  q.calls.some(([m, ...a]) => m === method && JSON.stringify(a) === JSON.stringify(args));
const ok = (data: unknown) => ({ data, error: null });

function activityRow(i: number) {
  return { id: `id-${i}`, source: "garmin", source_id: `s-${i}`, started_at: "2026-06-01T10:00:00Z", sport: "cycling", environment: "indoor" };
}

describe("createSupabaseSyncStore (h)", () => {
  it("filters every read on the owner and pages list reads by 1000", async () => {
    const { client, queries } = recordingClient((q) => {
      const range = q.calls.find(([m]) => m === "range");
      if (q.table === "external_activities" && range && !q.calls.some(([m]) => m === "gte")) {
        const from = range[1] as number;
        const n = from === 0 ? PAGE_SIZE : from === PAGE_SIZE ? 3 : 0;
        return ok(Array.from({ length: n }, (_, i) => activityRow(from + i)));
      }
      if (range) return ok([]);
      return ok(null);
    });
    const store = createSupabaseSyncStore(client, "owner-1");
    const all = await store.listAllActivities();
    expect(all).toHaveLength(PAGE_SIZE + 3);
    expect(all[PAGE_SIZE].id).toBe(`id-${PAGE_SIZE}`);
    const pages = queries.filter((q) => q.table === "external_activities");
    expect(pages).toHaveLength(3);
    expect(has(pages[0], "range", 0, 999)).toBe(true);
    expect(has(pages[1], "range", 1000, 1999)).toBe(true);
    expect(has(pages[2], "range", 1003, 2002)).toBe(true);
    expect(has(pages[0], "order", "started_at")).toBe(true);

    queries.length = 0;
    await store.listActivitiesBetween("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");
    await store.listFtpHistory();
    await store.listStrengthSessions();
    await store.getAthleteSettings();
    await store.hasActivity("garmin", "s-1");
    await store.getStream("id-1", "power");
    await store.getDailyLoad("2026-06-01");
    await store.getSyncState("peloton");
    await store.getCredential("peloton");
    for (const q of queries) expect(has(q, "eq", "user_id", "owner-1"), `${q.table} filters user_id`).toBe(true);
    expect(queries.map((q) => q.table)).toEqual([
      "external_activities",
      "ftp_history",
      "sessions",
      "athlete_settings",
      "external_activities",
      "activity_streams",
      "daily_training_load",
      "sync_state",
      "provider_credentials",
    ]);
    for (const q of queries.slice(0, 3)) expect(has(q, "range", 0, 999)).toBe(true);
    expect(has(queries[0], "gte", "started_at", "2026-01-01T00:00:00Z")).toBe(true);
  });

  it("stamps the owner on writes and limits updateActivityDerived to the patched columns", async () => {
    const { client, queries } = recordingClient((q) => {
      if (q.table === "external_activities" && q.calls.some(([m]) => m === "update")) return ok(activityRow(1));
      if (q.table === "external_activities" && q.calls.some(([m]) => m === "upsert")) return ok([activityRow(1)]);
      return ok(null);
    });
    const store = createSupabaseSyncStore(client, "owner-1");
    await store.upsertActivity({ source: "garmin", sourceId: "s-1", startedAt: "2026-06-01T10:00:00Z", sport: "cycling", environment: "indoor", providerPayload: {} });
    const upsert = queries[0].calls.find(([m]) => m === "upsert") as Call;
    expect((upsert[1] as Record<string, unknown>[])[0].user_id).toBe("owner-1");

    queries.length = 0;
    await store.updateActivityDerived("id-1", { tss: 50, ftpUsedW: 249.6, pairedActivityId: null });
    const update = queries[0].calls.find(([m]) => m === "update") as Call;
    const row = update[1] as Record<string, unknown>;
    expect(row).toMatchObject({ tss: 50, ftp_used_w: 250, paired_activity_id: null });
    expect(Object.keys(row).sort()).toEqual(["ftp_used_w", "paired_activity_id", "tss", "updated_at"]);
    expect(row).not.toHaveProperty("provider_payload");
    expect(has(queries[0], "eq", "user_id", "owner-1")).toBe(true);
    expect(has(queries[0], "eq", "id", "id-1")).toBe(true);

    queries.length = 0;
    await store.upsertDailyTrainingLoad([{ date: "2026-06-01", tssTotal: 1, tssBySource: {}, ctl: 1, atl: 1, tsb: 0 }]);
    const dtl = queries[0].calls.find(([m]) => m === "upsert") as Call;
    expect((dtl[1] as Record<string, unknown>[])[0].user_id).toBe("owner-1");
  });

  it("skips FTP history entries already stored with the same (effectiveFrom, source)", async () => {
    const { client, queries } = recordingClient((q) => {
      const range = q.calls.find(([m]) => m === "range");
      if (range) {
        return ok(range[1] === 0 ? [{ id: "h1", effective_from: "2026-01-01T00:00:00+00:00", ftp_w: 240, source: "peloton_test", source_ref: null }] : []);
      }
      const insert = q.calls.find(([m]) => m === "insert");
      return ok({ id: "h2", ...(insert?.[1] as object) });
    });
    const store = createSupabaseSyncStore(client, "owner-1");
    const added = await store.addFtpHistoryEntries([
      { effectiveFrom: "2026-01-01T00:00:00.000Z", ftpW: 240, source: "peloton_test", sourceRef: null },
      { effectiveFrom: "2026-02-01T00:00:00.000Z", ftpW: 250, source: "peloton_test", sourceRef: null },
      { effectiveFrom: "2026-02-01T00:00:00.000Z", ftpW: 250, source: "peloton_test", sourceRef: null },
    ]);
    expect(added).toHaveLength(1);
    const inserts = queries.filter((q) => q.calls.some(([m]) => m === "insert"));
    expect(inserts).toHaveLength(1);
    expect((inserts[0].calls.find(([m]) => m === "insert") as Call)[1]).toMatchObject({ user_id: "owner-1", effective_from: "2026-02-01T00:00:00.000Z" });
  });

  it("deleteFtpHistoryEntries deletes by id within the owner and counts the deleted rows", async () => {
    const { client, queries } = recordingClient(() => ok([{ id: "h1" }, { id: "h2" }]));
    const store = createSupabaseSyncStore(client, "owner-1");
    expect(await store.deleteFtpHistoryEntries(["h1", "h2", "h3"])).toBe(2);
    expect(queries).toHaveLength(1);
    expect(queries[0].table).toBe("ftp_history");
    expect(has(queries[0], "delete")).toBe(true);
    expect(has(queries[0], "eq", "user_id", "owner-1")).toBe(true);
    expect(has(queries[0], "in", "id", ["h1", "h2", "h3"])).toBe(true);

    queries.length = 0;
    expect(await store.deleteFtpHistoryEntries([])).toBe(0);
    expect(queries).toHaveLength(0);
  });

  it("saveCredential is a compare-and-swap on rotated_at", async () => {
    const cred: StoredCredential = { ciphertext: "c", iv: "i", authTag: "t", keyId: "k1", accessExpiresAt: null, rotatedAt: "2026-06-02T00:00:00Z", revokedAt: null };
    let updated: unknown[] = [];
    let insertError: unknown = null;
    const { client, queries } = recordingClient((q) => {
      if (q.calls.some(([m]) => m === "update")) return ok(updated);
      return { data: insertError ? null : [{ id: "x" }], error: insertError };
    });
    const store = createSupabaseSyncStore(client, "owner-1");

    updated = [{ id: "x" }];
    expect(await store.saveCredential("peloton", cred, "2026-06-01T00:00:00Z")).toBe(true);
    expect(has(queries[0], "eq", "rotated_at", "2026-06-01T00:00:00Z")).toBe(true);
    expect(has(queries[0], "eq", "user_id", "owner-1")).toBe(true);

    updated = [];
    queries.length = 0;
    expect(await store.saveCredential("peloton", cred, "2026-06-01T00:00:00Z")).toBe(false);
    expect(queries).toHaveLength(1);

    // First save: no row matches rotated_at is null, so it inserts.
    queries.length = 0;
    expect(await store.saveCredential("peloton", cred, null)).toBe(true);
    expect(has(queries[0], "is", "rotated_at", null)).toBe(true);
    expect((queries[1].calls.find(([m]) => m === "insert") as Call)[1]).toMatchObject({ user_id: "owner-1", provider: "peloton", key_id: "k1" });

    // A concurrent first save won: the insert hits the unique constraint.
    insertError = { code: "23505", message: "duplicate key" };
    expect(await store.saveCredential("peloton", cred, null)).toBe(false);
  });
});

describe("createSupabaseSyncStore stream candidates (AI-861, supabaseStub)", () => {
  const tables = () => ({
    external_activities: [
      { id: "g1", user_id: "owner-1", source: "garmin", provider_payload: { activityId: 1 } },
      { id: "g2", user_id: "owner-1", source: "garmin", provider_payload: { activityId: 2 } },
      { id: "g3", user_id: "owner-1", source: "garmin", provider_payload: null },
      { id: "p1", user_id: "owner-1", source: "peloton", provider_payload: { id: "p" } },
      { id: "x1", user_id: "owner-2", source: "garmin", provider_payload: { activityId: 9 } },
    ],
    activity_streams: [
      { id: "s1", user_id: "owner-1", activity_id: "g1", channel: "altitude" },
      { id: "s2", user_id: "owner-1", activity_id: "g1", channel: "distance" },
      { id: "s3", user_id: "owner-1", activity_id: "g2", channel: "power" },
      { id: "s4", user_id: "owner-1", activity_id: "p1", channel: "power" },
      { id: "s5", user_id: "owner-2", activity_id: "x1", channel: "power" },
    ],
  });
  const foreignKeys = [{ from: "activity_streams", column: "activity_id", to: "external_activities" }];

  it("listActivityIdsWithStreams pages the owner's stream rows of one source into a set", async () => {
    const stub = createSupabaseStub({ tables: tables(), foreignKeys, maxRows: 2 });
    const store = createSupabaseSyncStore(stub.client, "owner-1");
    expect(await store.listActivityIdsWithStreams("garmin")).toEqual(new Set(["g1", "g2"]));
    expect(await store.listActivityIdsWithStreams("peloton")).toEqual(new Set(["p1"]));
    const garmin = stub.queries.slice(0, 3);
    expect(garmin.map((q) => q.table)).toEqual(["activity_streams", "activity_streams", "activity_streams"]); // 2 + 1 + empty
    expect(stub.filters(garmin[0]!)).toEqual([
      ["eq", "user_id", "owner-1"],
      ["eq", "external_activities.source", "garmin"],
    ]);
    // Never the stream values: they are the bulk of the table.
    expect(String(garmin[0]!.steps[0]!.args[0])).not.toContain("values");
  });

  it("getActivityProviderPayload reads provider_payload of one owned activity", async () => {
    const stub = createSupabaseStub({ tables: tables(), foreignKeys });
    const store = createSupabaseSyncStore(stub.client, "owner-1");
    expect(await store.getActivityProviderPayload("g2")).toEqual({ activityId: 2 });
    expect(await store.getActivityProviderPayload("g3")).toBeNull();
    expect(await store.getActivityProviderPayload("x1")).toBeNull(); // another owner's
    expect(await store.getActivityProviderPayload("missing")).toBeNull();
    const q = stub.queries[0]!;
    expect(q.table).toBe("external_activities");
    expect(q.steps[0]).toEqual({ method: "select", args: ["provider_payload"] });
    expect(stub.filters(q)).toEqual([
      ["eq", "user_id", "owner-1"],
      ["eq", "id", "g2"],
    ]);
  });

  it("surfaces a read error", async () => {
    const stub = createSupabaseStub();
    stub.reply({ error: { message: "boom" } }, { error: { message: "nope" } });
    const store = createSupabaseSyncStore(stub.client, "owner-1");
    await expect(store.listActivityIdsWithStreams("garmin")).rejects.toMatchObject({ message: "boom" });
    await expect(store.getActivityProviderPayload("g1")).rejects.toMatchObject({ message: "nope" });
  });
});

describe("createMemorySyncStore", () => {
  it("listActivityIdsWithStreams and getActivityProviderPayload", async () => {
    const store = createMemorySyncStore("owner");
    const g = await store.upsertActivity({ source: "garmin", sourceId: "1", startedAt: "2026-06-01T10:00:00Z", sport: "cycling", environment: "outdoor", providerPayload: { a: 1 } });
    const g2 = await store.upsertActivity({ source: "garmin", sourceId: "2", startedAt: "2026-06-02T10:00:00Z", sport: "cycling", environment: "outdoor", providerPayload: { a: 2 } });
    const p = await store.upsertActivity({ source: "peloton", sourceId: "1", startedAt: "2026-06-01T10:00:00Z", sport: "cycling", environment: "indoor", providerPayload: { b: 1 } });
    await store.replaceStreams(g.id, [{ channel: "power", values: [1] }]);
    await store.replaceStreams(g2.id, []);
    await store.replaceStreams(p.id, [{ channel: "power", values: [1] }]);
    expect(await store.listActivityIdsWithStreams("garmin")).toEqual(new Set([g.id]));
    expect(await store.listActivityIdsWithStreams("peloton")).toEqual(new Set([p.id]));
    expect(await store.getActivityProviderPayload(g2.id)).toEqual({ a: 2 });
    expect(await store.getActivityProviderPayload("missing")).toBeNull();
  });

  it("saveCredential compares rotatedAt", async () => {
    const store = createMemorySyncStore("owner");
    const c = (rotatedAt: string | null): StoredCredential => ({ ciphertext: "c", iv: "i", authTag: "t", keyId: "k", accessExpiresAt: null, rotatedAt, revokedAt: null });
    expect(await store.saveCredential("peloton", c("2026-06-01T00:00:00Z"), "2026-01-01T00:00:00Z")).toBe(false);
    expect(await store.saveCredential("peloton", c("2026-06-01T00:00:00Z"), null)).toBe(true);
    expect(await store.saveCredential("peloton", c("2026-06-02T00:00:00Z"), null)).toBe(false);
    expect(await store.saveCredential("peloton", c("2026-06-02T00:00:00Z"), "2026-06-01T00:00:00.000Z")).toBe(true);
    expect((await store.getCredential("peloton"))?.rotatedAt).toBe("2026-06-02T00:00:00Z");
  });

  it("addFtpHistoryEntries skips existing (effectiveFrom, source)", async () => {
    const store = createMemorySyncStore("owner");
    const e = { effectiveFrom: "2026-01-01T00:00:00Z", ftpW: 240, source: "peloton_test" as const, sourceRef: null };
    expect(await store.addFtpHistoryEntries([e, e])).toHaveLength(1);
    expect(await store.addFtpHistoryEntries([{ ...e, effectiveFrom: "2026-01-01T00:00:00.000Z" }, { ...e, source: "manual" }])).toHaveLength(1);
    expect(await store.listFtpHistory()).toHaveLength(2);
  });

  it("deleteFtpHistoryEntries removes only the given ids", async () => {
    const e = (id: string, effectiveFrom: string) => ({ id, effectiveFrom, ftpW: 240, source: "peloton_manual" as const, sourceRef: null });
    const store = createMemorySyncStore("owner", { ftpHistory: [e("a", "2026-01-01T00:00:00Z"), e("b", "2026-01-02T00:00:00Z"), e("c", "2026-01-03T00:00:00Z")] });
    expect(await store.deleteFtpHistoryEntries(["a", "c", "missing"])).toBe(2);
    expect((await store.listFtpHistory()).map((h) => h.id)).toEqual(["b"]);
    expect(await store.deleteFtpHistoryEntries([])).toBe(0);
  });
});
