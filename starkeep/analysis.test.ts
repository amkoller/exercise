// @vitest-environment node
// The analysis SQL (./analysisSql.ts) over Starkeep-shaped rows. Every expected
// value was worked by hand from the Supabase migration the statement comes
// from, so these cases check that the SQLite port answers as Postgres does.
// ./handlers.test.ts compares the tool text against api/mcp.ts as well.
import { describe, expect, it } from "vitest";
import type { RowClient } from "../src/data/starkeep/rows.js";
import { asPgTimestamptz, createAnalysisReads } from "./analysis.js";

type Tables = Record<string, Record<string, unknown>[]>;

/** A row client that answers `selectAll` from `tables` and nothing else. */
function reads(tables: Tables) {
  const rows = { selectAll: async (table: string) => tables[table] ?? [] } as unknown as RowClient;
  return createAnalysisReads(rows);
}

const CREATED = "2026-01-01T00:00:00.000Z";

function exercise(id: string, name: string, extra: Record<string, unknown> = {}) {
  return { id, name, cue: "", default_sets: 3, default_rep_low: 10, default_rep_high: 12, created_at: CREATED, archived_at: null, ...extra };
}

function session(id: string, performed_on: string, workout_day_id: string | null = null) {
  return { id, performed_on, workout_day_id, created_at: CREATED };
}

let setCounter = 0;
function set(session_id: string, exercise_id: string, set_number: number, weight: number, reps: number) {
  setCounter += 1;
  return { id: `set-${String(setCounter).padStart(4, "0")}`, session_id, exercise_id, set_number, weight, reps };
}

function day(id: string, name: string, position: number, extra: Record<string, unknown> = {}) {
  return { id, name, position, program_id: null, program_position: null, created_at: CREATED, archived_at: null, ...extra };
}

function program(id: string, name: string, archived_at: string | null = null) {
  return { id, name, created_at: CREATED, archived_at };
}

/** `target_sets` is JSON text in Starkeep. */
const scheme = (sets: unknown) => (sets === null ? null : JSON.stringify(sets));

function dayExercise(workout_day_id: string, exercise_id: string, position: number, target_sets: unknown = null) {
  return { id: `${workout_day_id}/${exercise_id}`, workout_day_id, exercise_id, position, target_sets: scheme(target_sets) };
}

function history(workout_day_id: string, exercise_id: string, recorded_at: string, target_sets: unknown) {
  return { id: `${workout_day_id}/${exercise_id}@${recorded_at}`, workout_day_id, exercise_id, recorded_at, target_sets: scheme(target_sets) };
}

describe("progression_for_exercise (0005_analysis_rpc.sql)", () => {
  const exercises = [exercise("e1", "Bench Press"), exercise("e2", "Incline BENCH"), exercise("e3", "Squat"), exercise("e4", "50%_Curl")];
  const sessions = [session("s1", "2026-08-03"), session("s2", "2026-08-01"), session("s3", "2026-08-03")];
  const session_sets = [
    set("s1", "e1", 1, 100, 5),
    set("s1", "e1", 2, 105, 5),
    set("s2", "e2", 1, 60, 10),
    set("s3", "e1", 1, 110, 3),
    set("s1", "e3", 1, 200, 5),
    set("s2", "e4", 1, 20, 12),
    set("missing-session", "e1", 1, 500, 5), // inner join drops it
    set("s1", "missing-exercise", 1, 500, 5), // inner join drops it
  ];
  const analysis = reads({ exercises, sessions, session_sets });

  it("aggregates matching sets per day, case-insensitively, ordered by date", async () => {
    expect(await analysis.progressionForExercise("bench")).toEqual([
      { performed_on: "2026-08-01", sets: 1, top_weight: 60, volume: 600 },
      // s1 and s3 share the day: 100*5 + 105*5 + 110*3 = 1355
      { performed_on: "2026-08-03", sets: 3, top_weight: 110, volume: 1355 },
    ]);
  });

  it("returns no rows for empty tables or no match", async () => {
    expect(await reads({}).progressionForExercise("bench")).toEqual([]);
    expect(await analysis.progressionForExercise("deadlift")).toEqual([]);
  });

  it("treats % and _ in the name as LIKE wildcards (the SQL does not escape them)", async () => {
    // '%b_nch%' matches both bench exercises; '%%%' matches every exercise.
    expect((await analysis.progressionForExercise("b_nch")).map((r) => r.sets)).toEqual([1, 3]);
    expect(await analysis.progressionForExercise("%")).toEqual([
      { performed_on: "2026-08-01", sets: 2, top_weight: 60, volume: 840 },
      { performed_on: "2026-08-03", sets: 4, top_weight: 200, volume: 2355 },
    ]);
  });

  it("rounds the volume as exact numeric, half away from zero", async () => {
    const rows = await reads({
      sessions: [session("s1", "2026-08-01")],
      session_sets: [set("s1", "e1", 1, 16.4, 3), set("s1", "e1", 2, 0.1, 3)],
      exercises: [exercise("e1", "Curl")],
    }).progressionForExercise("curl");
    // 49.2 + 0.3 = 49.5 exactly -> 50 (a float sum gives 49.49999999999999 -> 49)
    expect(rows).toEqual([{ performed_on: "2026-08-01", sets: 2, top_weight: 16.4, volume: 50 }]);
  });
});

describe("sets_for_exercise (0010_sets_for_exercise_rpc.sql)", () => {
  const exercises = [exercise("e1", "Bench Press"), exercise("e2", "Incline Bench"), exercise("e3", "Squat")];
  const sessions = [session("s1", "2026-08-03"), session("s2", "2026-08-01"), session("s3", "2026-08-03")];
  const session_sets = [
    set("s1", "e1", 2, 105, 5),
    set("s1", "e1", 1, 100, 5),
    set("s2", "e2", 1, 60, 10),
    set("s3", "e1", 1, 110, 3),
    set("s1", "e3", 1, 200, 5),
    set("missing-session", "e1", 1, 500, 5),
  ];
  const analysis = reads({ exercises, sessions, session_sets });

  it("returns each matching set ordered by date, then set number, then set id", async () => {
    expect(await analysis.setsForExercise("BENCH")).toEqual([
      { performed_on: "2026-08-01", set_number: 1, weight: 60, reps: 10 },
      // s1 and s3 tie on (2026-08-03, 1): the set ids break the tie
      { performed_on: "2026-08-03", set_number: 1, weight: 100, reps: 5 },
      { performed_on: "2026-08-03", set_number: 1, weight: 110, reps: 3 },
      { performed_on: "2026-08-03", set_number: 2, weight: 105, reps: 5 },
    ]);
  });

  it("returns no rows for empty tables or no match", async () => {
    expect(await reads({}).setsForExercise("bench")).toEqual([]);
    expect(await analysis.setsForExercise("row")).toEqual([]);
  });

  it("matches names containing regex metacharacters such as a hyphen", async () => {
    const rows = await reads({
      sessions: [session("s1", "2026-08-01")],
      session_sets: [set("s1", "p", 1, 0, 8)],
      exercises: [exercise("p", "Pull-Up (wide)")],
    }).setsForExercise("pull-up (");
    expect(rows).toEqual([{ performed_on: "2026-08-01", set_number: 1, weight: 0, reps: 8 }]);
  });

  it("treats _ as a single-character wildcard", async () => {
    expect(await analysis.setsForExercise("sq_at")).toEqual([{ performed_on: "2026-08-03", set_number: 1, weight: 200, reps: 5 }]);
  });
});

describe("weekly_volume (0005_analysis_rpc.sql)", () => {
  it("buckets sessions into Monday-start weeks across several weeks and a year boundary", async () => {
    const sessions = [
      session("c", "2026-08-31"), // Monday -> its own week
      session("a", "2026-08-24"), // Monday
      session("b", "2026-08-30"), // Sunday -> same week as a
      session("f", "2026-09-01"), // Tuesday, no sets -> counts in week 08-31
      session("d", "2026-09-09"), // Wednesday, no sets -> week 09-07 with null volume
      session("e", "2026-01-01"), // Thursday -> week of Monday 2025-12-29
    ];
    const session_sets = [
      set("a", "x", 1, 100, 10), // 1000
      set("a", "x", 2, 50, 5), // 250
      set("b", "x", 1, 102.5, 3), // 307.5
      set("c", "x", 1, 16.4, 3), // 49.2
      set("c", "x", 2, 0.1, 3), // 0.3
      set("e", "x", 1, 20, 10), // 200
      set("not-a-session", "x", 1, 999, 9), // no matching session: ignored
    ];
    expect(await reads({ sessions, session_sets }).weeklyVolume()).toEqual([
      { week: "2025-12-29", sessions: 1, total_volume: 200 },
      { week: "2026-08-24", sessions: 2, total_volume: 1558 }, // 1557.5 rounds half away from zero
      { week: "2026-08-31", sessions: 2, total_volume: 50 }, // 49.5 exactly -> 50
      { week: "2026-09-07", sessions: 1, total_volume: null },
    ]);
  });

  it("counts a session once however many sets it has", async () => {
    const sessions = [session("a", "2026-08-25")];
    const session_sets = [set("a", "x", 1, 10, 1), set("a", "x", 2, 10, 1), set("a", "y", 1, 10, 1)];
    expect(await reads({ sessions, session_sets }).weeklyVolume()).toEqual([{ week: "2026-08-24", sessions: 1, total_volume: 30 }]);
  });

  it("returns no rows without sessions", async () => {
    expect(await reads({}).weeklyVolume()).toEqual([]);
    expect(await reads({ session_sets: [set("a", "x", 1, 10, 1)] }).weeklyVolume()).toEqual([]);
  });
});

describe("training_gaps (0005_analysis_rpc.sql)", () => {
  it("returns day gaps between distinct dates in date order, null first", async () => {
    const sessions = [
      session("a", "2026-08-05"),
      session("b", "2026-08-01"),
      session("c", "2026-08-01"), // same day collapses
      session("d", "2026-09-02"),
      session("e", "2027-01-01"),
    ];
    expect(await reads({ sessions }).trainingGaps()).toEqual([
      { performed_on: "2026-08-01", days_since_prev: null },
      { performed_on: "2026-08-05", days_since_prev: 4 },
      { performed_on: "2026-09-02", days_since_prev: 28 },
      { performed_on: "2027-01-01", days_since_prev: 121 },
    ]);
  });

  it("returns a single null-gap row for one date and nothing for no sessions", async () => {
    expect(await reads({ sessions: [session("a", "2026-08-26")] }).trainingGaps()).toEqual([
      { performed_on: "2026-08-26", days_since_prev: null },
    ]);
    expect(await reads({}).trainingGaps()).toEqual([]);
  });
});

describe("get_workout_history (0011_workout_history_filters.sql)", () => {
  const SA = "aaaaaaaa-0000-4000-8000-000000000001";
  const SB = "bbbbbbbb-0000-4000-8000-000000000002";
  const SC = "cccccccc-0000-4000-8000-000000000003";
  const SD = "dddddddd-0000-4000-8000-000000000004";

  const workout_days = [day("d1", "Push", 0, { archived_at: "2026-08-20T00:00:00.000Z" }), day("d2", "Pull", 1)];
  const exercises = [exercise("e1", "Bench Press"), exercise("e2", "Row"), exercise("e3", "50%_Curl")];
  const sessions = [
    session(SB, "2026-08-01", "d1"),
    session(SA, "2026-08-01", "d2"),
    session(SC, "2026-08-02", null),
    session(SD, "2026-08-03", "day-not-stored"),
  ];
  const session_sets = [
    set(SB, "e1", 2, 100, 5),
    set(SB, "e1", 1, 95, 5),
    set(SA, "e2", 1, 60, 10),
    set(SA, "e3", 1, 20, 12),
    set(SD, "e1", 1, 105, 5),
    set(SD, "exercise-not-stored", 2, 80, 8),
  ];
  const analysis = reads({ sessions, workout_days, session_sets, exercises });
  const all = { startDate: null, endDate: null, exerciseName: null };

  const rowA2 = { session_id: SA, performed_on: "2026-08-01", workout_day_id: "d2", workout_day_name: "Pull", exercise_id: "e2", exercise_name: "Row", set_number: 1, weight: 60, reps: 10 };
  const rowA3 = { ...rowA2, exercise_id: "e3", exercise_name: "50%_Curl", weight: 20, reps: 12 };
  // d1 is archived, and get_workout_history does not filter archived days.
  const rowB1 = { session_id: SB, performed_on: "2026-08-01", workout_day_id: "d1", workout_day_name: "Push", exercise_id: "e1", exercise_name: "Bench Press", set_number: 1, weight: 95, reps: 5 };
  const rowB2 = { ...rowB1, set_number: 2, weight: 100 };
  const rowC = { session_id: SC, performed_on: "2026-08-02", workout_day_id: null, workout_day_name: null, exercise_id: null, exercise_name: null, set_number: null, weight: null, reps: null };
  // The day row is not stored, so wd.id and wd.name are null although s.workout_day_id is set.
  const rowD1 = { session_id: SD, performed_on: "2026-08-03", workout_day_id: null, workout_day_name: null, exercise_id: "e1", exercise_name: "Bench Press", set_number: 1, weight: 105, reps: 5 };
  const rowD2 = { ...rowD1, exercise_id: null, exercise_name: null, set_number: 2, weight: 80, reps: 8 };

  it("returns every set and set-less session ordered by date, session id, set number", async () => {
    // SA's two set-1 rows tie on every Postgres sort key: the set ids break the tie.
    expect(await analysis.getWorkoutHistory(all)).toEqual([rowA2, rowA3, rowB1, rowB2, rowC, rowD1, rowD2]);
  });

  it("applies inclusive start and end dates", async () => {
    expect(await analysis.getWorkoutHistory({ ...all, startDate: "2026-08-02", endDate: "2026-08-02" })).toEqual([rowC]);
    expect(await analysis.getWorkoutHistory({ ...all, startDate: "2026-08-02" })).toEqual([rowC, rowD1, rowD2]);
    expect(await analysis.getWorkoutHistory({ ...all, endDate: "2026-08-01" })).toEqual([rowA2, rowA3, rowB1, rowB2]);
    expect(await analysis.getWorkoutHistory({ ...all, startDate: "2026-08-04" })).toEqual([]);
  });

  it("refuses a date that is not a date, with Postgres's message", async () => {
    await expect(analysis.getWorkoutHistory({ ...all, startDate: "2026-02-30" })).rejects.toThrow(
      'invalid input syntax for type date: "2026-02-30"',
    );
    await expect(analysis.getWorkoutHistory({ ...all, endDate: "today" })).rejects.toThrow(
      'invalid input syntax for type date: "today"',
    );
  });

  it("filters by a case-insensitive literal substring, dropping rows without an exercise", async () => {
    expect(await analysis.getWorkoutHistory({ ...all, exerciseName: "BENCH" })).toEqual([rowB1, rowB2, rowD1]);
    // % and _ are escaped, so they only match themselves.
    expect(await analysis.getWorkoutHistory({ ...all, exerciseName: "_" })).toEqual([rowA3]);
    expect(await analysis.getWorkoutHistory({ ...all, exerciseName: "0%_c" })).toEqual([rowA3]);
    expect(await analysis.getWorkoutHistory({ ...all, exerciseName: "b_nch" })).toEqual([]);
    expect(await analysis.getWorkoutHistory({ ...all, exerciseName: "bench", startDate: "2026-08-02" })).toEqual([rowD1]);
  });

  it("returns no rows for empty tables", async () => {
    expect(await reads({}).getWorkoutHistory(all)).toEqual([]);
  });
});

describe("scheme_history_for_day_exercise (20260906151951_scheme_history.sql)", () => {
  const D1 = "11111111-0000-4000-8000-000000000001";
  const E1 = "eeeeeeee-0000-4000-8000-000000000001";
  const workout_day_exercise_scheme_history = [
    history(D1, E1, "2026-08-03T10:00:00.000Z", [{ weight: 110, reps: 5 }]),
    history(D1, E1, "2026-08-01T00:00:00.002Z", [{ weight: 100, reps: 5 }]),
    history(D1, E1, "2026-08-01T00:00:00.001Z", [{ weight: 95, reps: 5 }]),
    history(D1, E1, "2026-08-01T23:00:00.000Z", null), // a cleared scheme
    history(D1, "other-exercise", "2026-07-01T00:00:00.000Z", [{ weight: 1, reps: 1 }]),
    history("other-day", E1, "2026-07-01T00:00:00.000Z", [{ weight: 2, reps: 2 }]),
  ];
  const analysis = reads({ workout_day_exercise_scheme_history });

  it("returns the pair's rows in time order, printed as jsonb and timestamptz", async () => {
    expect(await analysis.schemeHistoryForDayExercise(D1, E1)).toEqual([
      { target_sets: [{ reps: 5, weight: 95 }], recorded_at: "2026-08-01T00:00:00.001+00:00" },
      { target_sets: [{ reps: 5, weight: 100 }], recorded_at: "2026-08-01T00:00:00.002+00:00" },
      { target_sets: null, recorded_at: "2026-08-01T23:00:00+00:00" },
      { target_sets: [{ reps: 5, weight: 110 }], recorded_at: "2026-08-03T10:00:00+00:00" },
    ]);
  });

  it("prints jsonb's key order: shortest key first", async () => {
    const [row] = await analysis.schemeHistoryForDayExercise(D1, E1);
    expect(JSON.stringify(row!.target_sets)).toBe('[{"reps":5,"weight":95}]');
  });

  it("returns no rows for empty tables or an unknown pair", async () => {
    expect(await reads({}).schemeHistoryForDayExercise(D1, E1)).toEqual([]);
    expect(await analysis.schemeHistoryForDayExercise("nope", E1)).toEqual([]);
  });
});

describe("adherence_for_day (20260906152003_adherence_for_day_rpc.sql)", () => {
  const exercises = [
    exercise("e1", "Bench", { default_sets: 3, default_rep_low: 8, default_rep_high: 10 }),
    exercise("e2", "curl", { default_sets: 3, default_rep_low: 10, default_rep_high: 12 }),
    exercise("e3", "Squat", { default_sets: 3, default_rep_low: 5, default_rep_high: 8 }),
  ];
  // d2 is archived; adherence_for_day still joins its name.
  const workout_days = [day("d1", "Push", 0), day("d2", "Legs", 1, { archived_at: "2026-09-01T00:00:00.000Z" })];
  const workout_day_exercises = [
    dayExercise("d1", "e1", 0, [{ weight: 100, reps: 5 }, { weight: 100, reps: 5 }, { weight: 105, reps: 3 }]),
    dayExercise("d1", "e2", 1, null),
    dayExercise("d2", "e3", 0, [{ weight: 200, reps: 5 }]),
  ];
  const workout_day_exercise_scheme_history = [
    history("d1", "e1", "2026-08-01T12:00:00.000Z", [{ weight: 90, reps: 8 }, { weight: 95, reps: 6 }]),
    // 2026-08-11 in UTC, so it is not in effect on 08-10
    history("d1", "e1", "2026-08-11T04:30:00.000Z", [{ weight: 110, reps: 5 }]),
    // scheme cleared on 08-05: from then on defaults apply, not the current day scheme
    history("d2", "e3", "2026-08-05T00:00:00.000Z", null),
  ];
  const sessions = [
    session("s1", "2026-07-30", "d1"),
    session("s2", "2026-08-10", "d1"),
    session("s3", "2026-08-11", "d1"),
    session("s4", "2026-08-06", "d2"),
    session("s5", "2026-08-04", "d2"),
    session("s6", "2026-08-12", null),
    session("s7", "2026-08-13", "d1"), // no sets: the inner join yields nothing
  ];
  const session_sets = [
    set("s1", "e2", 1, 20, 12),
    set("s1", "e1", 1, 100, 5),
    set("s1", "e1", 2, 100, 5),
    set("s1", "e1", 3, 105, 3),
    set("s1", "e2", 2, 20, 10),
    set("s2", "e1", 1, 95, 8),
    set("s2", "e1", 2, 95, 8),
    set("s2", "e1", 3, 95, 8),
    set("s2", "e1", 4, 95, 7),
    set("s3", "e1", 1, 105, 5),
    set("s3", "e1", 2, 105, 4),
    set("s4", "e3", 1, 180, 6),
    set("s4", "e3", 2, 180, 6),
    set("s4", "e3", 3, 180, 6),
    set("s5", "e3", 1, 210, 5),
    set("s6", "gone", 1, 50, 5),
    set("s6", "e1", 1, 60, 11),
    set("s6", "e1", 2, 60, 11),
    set("s6", "e1", 3, 60, 12),
    set("no-session", "e1", 1, 1, 1),
  ];
  const tables = { sessions, session_sets, workout_days, exercises, workout_day_exercises, workout_day_exercise_scheme_history };
  const analysis = reads(tables);
  const all = { workoutDayId: null, startDate: null, endDate: null };

  const push = { workout_day_id: "d1", workout_day_name: "Push" };
  const legs = { workout_day_id: "d2", workout_day_name: "Legs" };

  // s1 (07-30): no history yet -> current day scheme for e1 (3 sets, reps 3..5, weight 105)
  const s1Bench = { session_id: "s1", performed_on: "2026-07-30", ...push, exercise_id: "e1", exercise_name: "Bench", actual_sets: 3, target_sets: 3, sets_status: "match", actual_avg_reps: 4.3, target_rep_low: 3, target_rep_high: 5, reps_status: "match", actual_top_weight: 105, target_weight: 105, weight_status: "match" };
  // e2 on d1 has no history and no current scheme -> exercise defaults, no weight target
  const s1Curl = { session_id: "s1", performed_on: "2026-07-30", ...push, exercise_id: "e2", exercise_name: "curl", actual_sets: 2, target_sets: 3, sets_status: "under", actual_avg_reps: 11, target_rep_low: 10, target_rep_high: 12, reps_status: "match", actual_top_weight: 20, target_weight: null, weight_status: null };
  // s5 (08-04): d2/e3 history starts 08-05 -> current scheme (1 set, 5 reps, 200)
  const s5Squat = { session_id: "s5", performed_on: "2026-08-04", ...legs, exercise_id: "e3", exercise_name: "Squat", actual_sets: 1, target_sets: 1, sets_status: "match", actual_avg_reps: 5, target_rep_low: 5, target_rep_high: 5, reps_status: "match", actual_top_weight: 210, target_weight: 200, weight_status: "over" };
  // s4 (08-06): the latest history row is the cleared scheme -> e3 defaults 3 x 5..8
  const s4Squat = { session_id: "s4", performed_on: "2026-08-06", ...legs, exercise_id: "e3", exercise_name: "Squat", actual_sets: 3, target_sets: 3, sets_status: "match", actual_avg_reps: 6, target_rep_low: 5, target_rep_high: 8, reps_status: "match", actual_top_weight: 180, target_weight: null, weight_status: null };
  // s2 (08-10): first history row (2 sets, reps 6..8, weight 95); avg 31/4 = 7.75 -> 7.8
  const s2Bench = { session_id: "s2", performed_on: "2026-08-10", ...push, exercise_id: "e1", exercise_name: "Bench", actual_sets: 4, target_sets: 2, sets_status: "over", actual_avg_reps: 7.8, target_rep_low: 6, target_rep_high: 8, reps_status: "match", actual_top_weight: 95, target_weight: 95, weight_status: "match" };
  // s3 (08-11): second history row (1 x 5 @ 110); avg 4.5 < 5
  const s3Bench = { session_id: "s3", performed_on: "2026-08-11", ...push, exercise_id: "e1", exercise_name: "Bench", actual_sets: 2, target_sets: 1, sets_status: "over", actual_avg_reps: 4.5, target_rep_low: 5, target_rep_high: 5, reps_status: "under", actual_top_weight: 105, target_weight: 110, weight_status: "under" };
  // s6 (08-12): no day -> no history or scheme -> defaults; avg 34/3 = 11.33 > 10
  const s6Bench = { session_id: "s6", performed_on: "2026-08-12", workout_day_id: null, workout_day_name: null, exercise_id: "e1", exercise_name: "Bench", actual_sets: 3, target_sets: 3, sets_status: "match", actual_avg_reps: 11.3, target_rep_low: 8, target_rep_high: 10, reps_status: "over", actual_top_weight: 60, target_weight: null, weight_status: null };
  // exercise not stored: the null name sorts last, and null targets make every CASE fall through to 'match'
  const s6Gone = { session_id: "s6", performed_on: "2026-08-12", workout_day_id: null, workout_day_name: null, exercise_id: "gone", exercise_name: null, actual_sets: 1, target_sets: null, sets_status: "match", actual_avg_reps: 5, target_rep_low: null, target_rep_high: null, reps_status: "match", actual_top_weight: 50, target_weight: null, weight_status: null };

  it("compares each session's exercises against the scheme in effect on that date", async () => {
    expect(await analysis.adherenceForDay(all)).toEqual([s1Bench, s1Curl, s5Squat, s4Squat, s2Bench, s3Bench, s6Bench, s6Gone]);
  });

  it("filters by day and by inclusive date range", async () => {
    expect(await analysis.adherenceForDay({ ...all, workoutDayId: "d2" })).toEqual([s5Squat, s4Squat]);
    expect(await analysis.adherenceForDay({ ...all, startDate: "2026-08-10", endDate: "2026-08-11" })).toEqual([s2Bench, s3Bench]);
    expect(await analysis.adherenceForDay({ ...all, workoutDayId: "d1", startDate: "2026-08-11" })).toEqual([s3Bench]);
  });

  it("orders exercise names case-insensitively, as en_US does", async () => {
    const rows = await reads({
      ...tables,
      exercises: [exercise("x1", "bench"), exercise("x2", "Curl")],
      sessions: [session("s1", "2026-08-01")],
      session_sets: [set("s1", "x2", 1, 10, 10), set("s1", "x1", 1, 10, 10)],
    }).adherenceForDay(all);
    expect(rows.map((r) => r.exercise_name)).toEqual(["bench", "Curl"]);
  });

  it("reads reps and weights written as JSON strings", async () => {
    const text = { ...tables, workout_day_exercises: [dayExercise("d2", "e3", 0, [{ weight: "200", reps: "5" }])] };
    expect(await reads(text).adherenceForDay({ workoutDayId: "d2", startDate: null, endDate: "2026-08-04" })).toEqual([s5Squat]);
  });

  it("returns no rows for empty tables", async () => {
    expect(await reads({}).adherenceForDay(all)).toEqual([]);
  });
});

describe("get_day_templates (20260906180100_day_sequencing.sql)", () => {
  const ARCHIVED = "2026-08-20T00:00:00.000Z";
  const exercises = [
    exercise("e1", "Bench", { cue: "tuck elbows", default_sets: 3, default_rep_low: 8, default_rep_high: 10 }),
    exercise("e2", "Row", { cue: "", default_sets: 4, default_rep_low: 10, default_rep_high: 12 }),
  ];
  const programs = [program("p1", "Block"), program("p2", "Old", ARCHIVED)];
  const workout_days = [
    day("dH", "P1 unpositioned", 7, { program_id: "p1", program_position: null }),
    day("dA", "Upper", 0),
    day("dB", "P1 Day1", 1, { program_id: "p1", program_position: 1 }),
    day("dC", "P1 Day2", 2, { program_id: "p1", program_position: 2 }),
    day("dD", "P1 Day3", 3, { program_id: "p1", program_position: 3 }),
    day("dE", "Archived", 4, { program_id: "p1", program_position: 0, archived_at: ARCHIVED }),
    day("dF", "In archived program", 5, { program_id: "p2", program_position: 1 }),
    day("dG", "Empty", 6),
  ];
  const targetScheme = [{ weight: 100, reps: 5 }];
  const workout_day_exercises = [
    dayExercise("dA", "e1", 1, targetScheme),
    dayExercise("dA", "e2", 0, null),
    dayExercise("dB", "e1", 0),
    dayExercise("dC", "e2", 0),
    dayExercise("dD", "e1", 0),
    dayExercise("dE", "e1", 0),
    dayExercise("dF", "e1", 0),
  ];
  const sessions = [session("s1", "2026-08-01", "dB"), session("s2", "2026-08-02", "dC"), session("s3", "2026-08-03", null)];
  // dB is done (its session has a set); dC's session has no sets, so dC is not done.
  const session_sets = [set("s1", "e1", 1, 100, 5), set("s3", "e1", 1, 100, 5)];
  const tables = { workout_days, programs, workout_day_exercises, exercises, sessions, session_sets };

  const e1Cols = { exercise_id: "e1", exercise_name: "Bench", exercise_cue: "tuck elbows" };
  const e1Defaults = { default_sets: 3, default_rep_low: 8, default_rep_high: 10 };
  const e2Cols = { exercise_id: "e2", exercise_name: "Row", exercise_cue: "" };
  const e2Defaults = { default_sets: 4, default_rep_low: 10, default_rep_high: 12 };
  const noExercise = { exercise_id: null, exercise_name: null, exercise_cue: null, exercise_position: null, target_sets: null, uses_default_scheme: true, default_sets: null, default_rep_low: null, default_rep_high: null };
  const untracked = { program_id: null, program_name: null, program_position: null, is_available: true };
  const block = (position: number, is_available: boolean) => ({ program_id: "p1", program_name: "Block", program_position: position, is_available });

  it("lists live days with ordered exercises, program info and availability", async () => {
    expect(await reads(tables).getDayTemplates()).toEqual([
      { workout_day_id: "dA", workout_day_name: "Upper", workout_day_position: 0, ...untracked, ...e2Cols, exercise_position: 0, target_sets: null, uses_default_scheme: true, ...e2Defaults },
      { workout_day_id: "dA", workout_day_name: "Upper", workout_day_position: 0, ...untracked, ...e1Cols, exercise_position: 1, target_sets: [{ reps: 5, weight: 100 }], uses_default_scheme: false, ...e1Defaults },
      { workout_day_id: "dB", workout_day_name: "P1 Day1", workout_day_position: 1, ...block(1, false), ...e1Cols, exercise_position: 0, target_sets: null, uses_default_scheme: true, ...e1Defaults },
      // next position is 2: dB is done, and the archived dE (position 0) is ignored
      { workout_day_id: "dC", workout_day_name: "P1 Day2", workout_day_position: 2, ...block(2, true), ...e2Cols, exercise_position: 0, target_sets: null, uses_default_scheme: true, ...e2Defaults },
      { workout_day_id: "dD", workout_day_name: "P1 Day3", workout_day_position: 3, ...block(3, false), ...e1Cols, exercise_position: 0, target_sets: null, uses_default_scheme: true, ...e1Defaults },
      // dE is archived: excluded. dF's program is archived: treated as untracked.
      { workout_day_id: "dF", workout_day_name: "In archived program", workout_day_position: 5, ...untracked, ...e1Cols, exercise_position: 0, target_sets: null, uses_default_scheme: true, ...e1Defaults },
      { workout_day_id: "dG", workout_day_name: "Empty", workout_day_position: 6, ...untracked, ...noExercise },
      // a null program_position never equals next_position -> coalesce(..., false)
      { workout_day_id: "dH", workout_day_name: "P1 unpositioned", workout_day_position: 7, ...block(7, false), program_position: null, ...noExercise },
    ]);
  });

  it("marks no day available once every day of a program is done", async () => {
    const rows = await reads({
      ...tables,
      workout_days: [day("dB", "P1 Day1", 1, { program_id: "p1", program_position: 1 })],
      sessions: [session("s1", "2026-08-01", "dB")],
      session_sets: [set("s1", "e1", 1, 100, 5)],
    }).getDayTemplates();
    expect(rows.map((r) => [r.workout_day_id, r.is_available])).toEqual([["dB", false]]);
  });

  it("orders by day position, then exercise position, and breaks ties by creation and id", async () => {
    const rows = await reads({
      ...tables,
      workout_days: [day("x2", "Second", 0), day("x1", "First", 0)],
      workout_day_exercises: [dayExercise("x2", "e2", 0), dayExercise("x2", "e1", 0)],
    }).getDayTemplates();
    // Postgres's keys put x2's exercises (position 0) before x1's empty row
    // (null position, last); the ids order the two x2 rows.
    expect(rows.map((r) => [r.workout_day_id, r.exercise_id])).toEqual([
      ["x2", "e1"],
      ["x2", "e2"],
      ["x1", null],
    ]);
  });

  it("returns no rows for empty tables or when every day is archived", async () => {
    expect(await reads({}).getDayTemplates()).toEqual([]);
    expect(await reads({ ...tables, workout_days: [day("dZ", "Gone", 0, { archived_at: ARCHIVED })] }).getDayTemplates()).toEqual([]);
  });
});

describe("asPgTimestamptz", () => {
  it("formats like PostgREST", () => {
    expect(asPgTimestamptz("2026-08-01T00:00:00.000Z")).toBe("2026-08-01T00:00:00+00:00");
    expect(asPgTimestamptz("2026-08-01T00:00:00.120Z")).toBe("2026-08-01T00:00:00.12+00:00");
    expect(asPgTimestamptz("2026-08-01")).toBe("2026-08-01");
  });
});
