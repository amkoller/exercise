/**
 * The strength analysis reads behind the MCP read tools: the SQL in
 * `./analysisSql.ts`, run over a snapshot of the caller's own rows.
 *
 * The snapshot comes from `createSnapshotCache` in
 * `@starkeep/app-client/snapshot`, which copies rows into an in-memory SQLite.
 * Exercise loads the rows through the request's own row client, and not
 * through `createSnapshotSql`, because that helper authenticates a browser
 * session. `/mcp` callers carry a delegation token instead, and the row client
 * already forwards it, so the data server applies the delegation's user, mode
 * and revocation to every load.
 *
 * Each read loads the tables its statement names into a new snapshot, runs the
 * statement and drops the snapshot. Nothing is kept between reads. An MCP
 * client that logs a set and then asks for its weekly volume expects to see
 * that set, and it has no Refresh button to ask for a newer copy. Loading
 * every time also means no snapshot outlives the request that loaded it, so
 * one user's rows can never answer another user's read.
 *
 * The results are shaped the way PostgREST prints the RPCs' results, so the
 * tool text matches `api/mcp.ts`: booleans instead of `0` and `1`, `target_sets`
 * as JSON with `jsonb`'s key order, and `recorded_at` as a `timestamptz`.
 */

import { createSnapshotCache, type SnapshotRow } from "@starkeep/app-client/snapshot";
import manifest from "../starkeep.manifest.json" with { type: "json" };
import type { RowClient } from "../src/data/starkeep/rows.js";
import {
  ADHERENCE_FOR_DAY,
  GET_DAY_TEMPLATES,
  GET_WORKOUT_HISTORY,
  PROGRESSION_FOR_EXERCISE,
  SCHEME_HISTORY_FOR_DAY_EXERCISE,
  SETS_FOR_EXERCISE,
  TRAINING_GAPS,
  WEEKLY_VOLUME,
  type AnalysisStatement,
} from "./analysisSql.js";

/** Any parsed JSON value. */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type ResultRow = Record<string, unknown>;

const TABLES = manifest.infraRequirements.appSpecificSyncable.tables;

/**
 * Postgres `jsonb` does not keep the key order it was given: it stores (and
 * PostgREST prints) an object's keys shortest first, then bytewise. So a
 * scheme written as `{"weight":100,"reps":5}` comes back from the Supabase
 * RPCs as `{"reps":5,"weight":100}`. Re-key parsed JSON the same way so the
 * tool text is identical.
 */
function asJsonb(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(asJsonb);
  if (value === null || typeof value !== "object") return value;
  const byte = (k: string) => Buffer.from(k, "utf8");
  const keys = Object.keys(value).sort((a, b) => {
    const x = byte(a);
    const y = byte(b);
    return x.length - y.length || Buffer.compare(x, y);
  });
  return Object.fromEntries(keys.map((k) => [k, asJsonb(value[k]!)]));
}

/** `target_sets` is JSON text in Starkeep and `jsonb` in Supabase. */
function parseJson(raw: unknown): JsonValue {
  return raw === null || raw === undefined ? null : asJsonb(JSON.parse(String(raw)) as JsonValue);
}

/**
 * A Starkeep timestamp (`toISOString()`: `2026-08-01T00:00:00.000Z`) as
 * PostgREST prints a `timestamptz` in Supabase's UTC session:
 * `2026-08-01T00:00:00+00:00`, fractional seconds only when non-zero and
 * without trailing zeros (`…:00.12+00:00`). Anything else passes through.
 */
export function asPgTimestamptz(ts: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(ts);
  if (!m) return ts;
  const fraction = (m[2] ?? "").replace(/0+$/, "");
  return `${m[1]}${fraction ? `.${fraction}` : ""}+00:00`;
}

/**
 * The RPCs take `date` arguments, and Postgres refuses text that is not one.
 * The statements compare dates as `YYYY-MM-DD` text, so anything else is
 * refused here with Postgres's message.
 */
function assertDate(value: string | null): void {
  if (value === null) return;
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
  if (!valid) throw new Error(`invalid input syntax for type date: "${value}"`);
}

export interface AnalysisReads {
  progressionForExercise(exerciseName: string): Promise<ResultRow[]>;
  setsForExercise(exerciseName: string): Promise<ResultRow[]>;
  weeklyVolume(): Promise<ResultRow[]>;
  trainingGaps(): Promise<ResultRow[]>;
  getDayTemplates(): Promise<ResultRow[]>;
  getWorkoutHistory(p: { startDate: string | null; endDate: string | null; exerciseName: string | null }): Promise<ResultRow[]>;
  schemeHistoryForDayExercise(workoutDayId: string, exerciseId: string): Promise<ResultRow[]>;
  adherenceForDay(p: { workoutDayId: string | null; startDate: string | null; endDate: string | null }): Promise<ResultRow[]>;
}

/** The analysis reads over one request's row client. */
export function createAnalysisReads(rows: RowClient): AnalysisReads {
  async function run(statement: AnalysisStatement, params: Record<string, string | null> = {}): Promise<ResultRow[]> {
    const snapshot = createSnapshotCache({ tables: TABLES });
    try {
      const result = await snapshot.query({
        scope: "request",
        tables: statement.tables,
        load: (table) => rows.selectAll<SnapshotRow>(table),
        sql: statement.sql,
        params,
        maxAge: 0,
      });
      return result.rows;
    } finally {
      snapshot.clear();
    }
  }

  return {
    progressionForExercise: (exerciseName) => run(PROGRESSION_FOR_EXERCISE, { exercise_name: exerciseName }),

    setsForExercise: (exerciseName) => run(SETS_FOR_EXERCISE, { exercise_name: exerciseName }),

    weeklyVolume: () => run(WEEKLY_VOLUME),

    trainingGaps: () => run(TRAINING_GAPS),

    async getDayTemplates() {
      return (await run(GET_DAY_TEMPLATES)).map((r) => ({
        ...r,
        is_available: r.is_available === 1,
        target_sets: parseJson(r.target_sets),
        uses_default_scheme: r.uses_default_scheme === 1,
      }));
    },

    async getWorkoutHistory({ startDate, endDate, exerciseName }) {
      assertDate(startDate);
      assertDate(endDate);
      return run(GET_WORKOUT_HISTORY, { start_date: startDate, end_date: endDate, exercise_name: exerciseName });
    },

    async schemeHistoryForDayExercise(workoutDayId, exerciseId) {
      const found = await run(SCHEME_HISTORY_FOR_DAY_EXERCISE, { workout_day_id: workoutDayId, exercise_id: exerciseId });
      return found.map((r) => ({
        target_sets: parseJson(r.target_sets),
        recorded_at: asPgTimestamptz(String(r.recorded_at)),
      }));
    },

    async adherenceForDay({ workoutDayId, startDate, endDate }) {
      assertDate(startDate);
      assertDate(endDate);
      return run(ADHERENCE_FOR_DAY, { for_workout_day_id: workoutDayId, start_date: startDate, end_date: endDate });
    },
  };
}
