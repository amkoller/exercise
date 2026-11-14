import { describe, expect, it } from "vitest";
import { SYNC_USAGE, SyncUsageError, formatRefetchResult, parseSyncArgs, providersOf } from "./cli.js";

describe("parseSyncArgs", () => {
  it.each([
    [["--source", "garmin", "--full"], { source: "garmin", mode: "full" }],
    [["--source", "peloton", "--incremental"], { source: "peloton", mode: "incremental" }],
    [["--incremental", "--source=all"], { source: "all", mode: "incremental" }],
    [
      ["--source", "peloton", "--full", "--recompute-all"],
      { source: "peloton", mode: "full", recomputeAll: true, reseedPelotonToken: false },
    ],
    [
      ["--source", "peloton", "--incremental", "--reseed-peloton-token"],
      { source: "peloton", mode: "incremental", recomputeAll: false, reseedPelotonToken: true },
    ],
    [["--source", "all", "--full", "--reseed-peloton-token", "--recompute-all"], { recomputeAll: true, reseedPelotonToken: true }],
    [["--source", "garmin", "--refetch-streams"], { source: "garmin", mode: "refetch-streams" }],
    [["--refetch-streams", "--source", "garmin", "--limit", "25"], { mode: "refetch-streams", limit: 25 }],
    [["--source=garmin", "--refetch-streams", "--limit=1"], { mode: "refetch-streams", limit: 1 }],
  ] as const)("(f) accepts %j", (argv, expected) => {
    expect(parseSyncArgs(argv)).toMatchObject({ recomputeAll: false, reseedPelotonToken: false, ...expected, help: false });
  });

  it.each([
    [[], "--source is required"],
    [["--full"], "--source is required"],
    [["--source", "garmin"], "exactly one of --full, --incremental and --refetch-streams"],
    [["--source", "garmin", "--full", "--incremental"], "exactly one of --full, --incremental and --refetch-streams"],
    [["--source", "garmin", "--full", "--refetch-streams"], "exactly one of --full, --incremental and --refetch-streams"],
    [["--source", "garmin", "--incremental", "--refetch-streams"], "exactly one of --full, --incremental and --refetch-streams"],
    [["--source", "peloton", "--refetch-streams"], "--refetch-streams needs --source garmin"],
    [["--source", "all", "--refetch-streams"], "--refetch-streams needs --source garmin"],
    [["--source", "garmin", "--refetch-streams", "--recompute-all"], "--refetch-streams does not take --recompute-all"],
    [["--source", "garmin", "--full", "--limit", "5"], "--limit needs --refetch-streams"],
    [["--source", "garmin", "--refetch-streams", "--limit"], "--limit needs a value"],
    [["--source", "garmin", "--refetch-streams", "--limit", "0"], "--limit must be a positive integer, not 0"],
    [["--source", "garmin", "--refetch-streams", "--limit", "2.5"], "--limit must be a positive integer"],
    [["--source", "garmin", "--refetch-streams", "--limit", "1", "--limit", "2"], "--limit given more than once"],
    [["--source", "strava", "--full"], "--source must be garmin, peloton or all"],
    [["--source"], "--source needs a value"],
    [["--source", "--full"], "--source needs a value"],
    [["--source", "garmin", "--source", "peloton", "--full"], "more than once"],
    [["--source", "garmin", "--full", "--verbose"], "unknown argument: --verbose"],
    [["--source", "garmin", "--full", "extra"], "unknown argument: extra"],
    [["--source", "garmin", "--full", "--reseed-peloton-token"], "--reseed-peloton-token needs --source peloton or all"],
  ] as const)("(f) rejects %j", (argv, message) => {
    expect(() => parseSyncArgs(argv)).toThrowError(SyncUsageError);
    expect(() => parseSyncArgs(argv)).toThrowError(message);
  });

  it("--refetch-streams without --limit sets no limit", () => {
    expect(parseSyncArgs(["--source", "garmin", "--refetch-streams"])).not.toHaveProperty("limit");
  });

  it("usage errors carry the usage text", () => {
    try {
      parseSyncArgs(["--bogus"]);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain(SYNC_USAGE);
    }
  });

  it.each([[["--help"]], [["-h"]], [["--source", "garmin", "--full", "--incremental", "--help"]]])(
    "(f) --help wins: %j",
    (argv) => {
      expect(parseSyncArgs(argv).help).toBe(true);
    },
  );

  it("--help still rejects unknown arguments", () => {
    expect(() => parseSyncArgs(["--help", "--nope"])).toThrowError("unknown argument: --nope");
  });
});

describe("formatRefetchResult", () => {
  it("prints the counts and the notes", () => {
    expect(
      formatRefetchResult({ candidates: 3, refetched: 2, failed: 1, remaining: 0, done: true, error: null, notes: ["fit failed (http 406): 1 ride, e.g. activity 7"] }),
    ).toEqual(["garmin refetch: candidates 3, refetched 2, failed 1, done true", "  fit failed (http 406): 1 ride, e.g. activity 7"]);
  });

  it("prints the resumable count after a transient stop or a limit", () => {
    expect(formatRefetchResult({ candidates: 5, refetched: 1, failed: 0, remaining: 4, done: false, error: "Garmin x returned HTTP 429", notes: [] })).toEqual([
      "garmin refetch: candidates 5, refetched 1, failed 0, done false",
      "garmin refetch stopped: Garmin x returned HTTP 429; 4 rides left, rerun to resume",
    ]);
    expect(formatRefetchResult({ candidates: 5, refetched: 1, failed: 0, remaining: 4, done: false, error: null, notes: [] })[1]).toBe(
      "garmin refetch: 4 rides left, rerun to continue",
    );
  });
});

describe("providersOf", () => {
  it("expands all", () => {
    expect(providersOf("all")).toEqual(["garmin", "peloton"]);
    expect(providersOf("garmin")).toEqual(["garmin"]);
    expect(providersOf("peloton")).toEqual(["peloton"]);
  });
});
