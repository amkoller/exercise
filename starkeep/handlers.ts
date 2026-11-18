/**
 * The Starkeep implementation of all 32 MCP tools (AI-604).
 *
 * `api/mcp.ts` (the Supabase handler set) is the behavioural reference: same
 * validation, same lookups in the same order, same error texts, same output
 * shapes, all formatted with `src/mcp/format.ts` so the text is identical.
 *
 * - The eight strength read tools run the Supabase RPCs' own SQL, ported to
 *   SQLite in `./analysisSql.ts`, over a snapshot of the caller's rows
 *   (`./analysis.ts`).
 * - Write tools use the Starkeep DataLayer, plus row-client reads for the raw
 *   checks `api/mcp.ts` does against Postgres (live-row lookups by id,
 *   duplicate link, attachment, current membership).
 *
 * - The seven ride analytics read tools (AI-654) are the shared
 *   `src/analysis/rides` handlers over this request's DataLayer. Starkeep has
 *   no ride tables yet (decision 3): its ride reads answer "nothing stored",
 *   so these tools return the empty-account answer, as Supabase does for a
 *   user with no rides.
 *
 * Built per request over a transport carrying that request's user token
 * (see `mcp.ts`); nothing here holds a client between requests.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DataLayer } from "../src/data/DataLayer.js";
import { ExerciseInUseError } from "../src/data/starkeep.js";
import type { Row, RowClient, Where } from "../src/data/starkeep/rows.js";
import type { McpToolHandlers } from "../src/mcp/handlers.js";
import {
  catchToolError,
  invalidIdError,
  toolError,
  toolResult,
  UUID_PATTERN,
  validateReps,
  validateSets,
  validateWeight,
} from "../src/mcp/format.js";
import type { AnalysisReads } from "./analysis.js";
import { createRideToolHandlers } from "../src/analysis/rides/index.js";
import { DEFAULT_ATHLETE_TIMEZONE } from "../src/metrics/dates.js";

// ---- Starkeep rows (starkeep.manifest.json tables) --------------------------

const T = {
  programs: "programs",
  exercises: "exercises",
  days: "workout_days",
  links: "workout_day_exercises",
  history: "workout_day_exercise_scheme_history",
  sessions: "sessions",
  sets: "session_sets",
} as const;

interface SkExercise extends Row {
  id: string;
  name: string;
  cue: string;
  default_sets: number;
  default_rep_low: number;
  default_rep_high: number;
  created_at: string;
  archived_at: string | null;
}

interface SkProgram extends Row {
  id: string;
  name: string;
  created_at: string;
  archived_at: string | null;
}

interface SkDay extends Row {
  id: string;
  name: string;
  position: number;
  program_id: string | null;
  program_position: number | null;
  created_at: string;
  archived_at: string | null;
}

interface SkLink extends Row {
  id: string;
  workout_day_id: string;
  exercise_id: string;
  position: number;
  /** JSON text of a `{weight, reps}[]` scheme, or null. */
  target_sets: string | null;
}

// ---- helpers ------------------------------------------------------------------

/**
 * Postgres compares uuids by value, so `api/mcp.ts` finds a row whatever the
 * case of the id it was given. The row API compares `text` exactly, and every
 * Starkeep id is lowercase (`crypto.randomUUID()`, or a Postgres uuid's text
 * form when imported), so lookups use the lowercased id. Output still echoes
 * the caller's id where `api/mcp.ts` echoes its input.
 */
const key = (id: string): string => id.toLowerCase();

/**
 * Postgres's own text for a malformed `uuid` argument. `api/mcp.ts` surfaces
 * it as "<tool> failed: invalid input syntax for type uuid: …" wherever an id
 * reaches a uuid column unvalidated and the error is not swallowed (findDay,
 * the RPCs taking ids). Here no column is a uuid, so the same check is made by
 * hand to keep the text identical.
 */
function assertUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) throw new Error(`invalid input syntax for type uuid: "${value}"`);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : ((e as { message?: string })?.message ?? String(e));
}

export function createStarkeepHandlers(data: DataLayer, rows: RowClient, analysis: AnalysisReads): McpToolHandlers {
  async function firstRow<R extends Row>(table: string, where: Where, select?: string[]): Promise<R | null> {
    const { rows: found } = await rows.select<R>(table, { where, select, limit: 1 });
    return found[0] ?? null;
  }

  // The id lookups api/mcp.ts makes against live (`deleted_at is null`) rows.
  // The DataLayer has only by-name lookups and an unfiltered getExercise, so
  // these read the row API directly with `archived_at` null.
  async function findDay(dayId: string): Promise<SkDay | null> {
    // findDay in api/mcp.ts throws Postgres's uuid error rather than swallowing it.
    assertUuid(dayId);
    return firstRow<SkDay>(T.days, { id: key(dayId), archived_at: null });
  }

  async function findExercise(exerciseId: string): Promise<SkExercise | null> {
    // Every caller has validated exerciseId as a UUID already.
    return firstRow<SkExercise>(T.exercises, { id: key(exerciseId), archived_at: null });
  }

  async function findProgram(programId: string): Promise<SkProgram | null> {
    // findProgram in api/mcp.ts ignores its query error, so a malformed id is
    // simply "not found" there; with no uuid column here, it is the same.
    return firstRow<SkProgram>(T.programs, { id: key(programId), archived_at: null });
  }

  async function link(dayId: string, exerciseId: string): Promise<SkLink | null> {
    return firstRow<SkLink>(T.links, { workout_day_id: key(dayId), exercise_id: key(exerciseId) }, ["id"]);
  }

  /**
   * A read tool: api/mcp.ts reports an RPC error as "<tool> failed: <message>".
   * Anything the fetch or the analysis throws is reported the same way.
   */
  async function readTool(toolName: string, run: () => Promise<unknown>): Promise<CallToolResult> {
    try {
      return toolResult(await run());
    } catch (e) {
      return toolError(`${toolName} failed: ${errorMessage(e)}`);
    }
  }

  return {
    // The seven ride analytics read tools, shared with api/mcp.ts (src/analysis/rides).
    // Starkeep has no env: the same default zone the Supabase server falls back to.
    ...createRideToolHandlers((run) => run(data), { defaultTimeZone: DEFAULT_ATHLETE_TIMEZONE }),
    progression_for_exercise: ({ exercise_name }) =>
      readTool("progression_for_exercise", () => analysis.progressionForExercise(exercise_name)),

    sets_for_exercise: ({ exercise_name }) =>
      readTool("sets_for_exercise", () => analysis.setsForExercise(exercise_name)),

    weekly_volume: () => readTool("weekly_volume", () => analysis.weeklyVolume()),

    training_gaps: () => readTool("training_gaps", () => analysis.trainingGaps()),

    get_day_templates: () => readTool("get_day_templates", () => analysis.getDayTemplates()),

    get_workout_history: ({ start_date, end_date, exercise_name }) =>
      readTool("get_workout_history", () =>
        analysis.getWorkoutHistory({
          startDate: start_date ?? null,
          endDate: end_date ?? null,
          exerciseName: exercise_name ?? null,
        }),
      ),

    scheme_history_for_day_exercise: ({ workout_day_id, exercise_id }) =>
      readTool("scheme_history_for_day_exercise", async () => {
        assertUuid(workout_day_id);
        assertUuid(exercise_id);
        return analysis.schemeHistoryForDayExercise(key(workout_day_id), key(exercise_id));
      }),

    adherence_for_day: ({ workout_day_id, start_date, end_date }) =>
      readTool("adherence_for_day", async () => {
        if (workout_day_id !== undefined) assertUuid(workout_day_id);
        return analysis.adherenceForDay({
          workoutDayId: workout_day_id === undefined ? null : key(workout_day_id),
          startDate: start_date ?? null,
          endDate: end_date ?? null,
        });
      }),

    create_day_template: ({ name, program_id }) =>
      catchToolError("create_day_template", async () => {
        let program: SkProgram | null = null;
        if (program_id) {
          program = await findProgram(program_id);
          if (!program) return toolError(`create_day_template failed: Program ${program_id} not found.`);
        }
        const day = await data.createDay(name);
        if (program) await data.addDayToProgram(day.id, program.id);
        // Same explicit subset as api/mcp.ts (createDay's program fields predate addDayToProgram).
        return toolResult({
          id: day.id,
          name: day.name,
          position: day.position,
          exerciseIds: day.exerciseIds,
          programId: program_id ?? null,
        });
      }),

    rename_day_template: ({ day_id, name }) =>
      catchToolError("rename_day_template", async () => {
        const dayIdError = invalidIdError("rename_day_template", "day_id", day_id);
        if (dayIdError) return dayIdError;
        const day = await findDay(day_id);
        if (!day) return toolError(`rename_day_template failed: Day template ${day_id} not found.`);
        await data.updateDayName(day.id, name);
        return toolResult({ id: day.id, name, position: day.position });
      }),

    delete_day_template: ({ day_id }) =>
      catchToolError("delete_day_template", async () => {
        const dayIdError = invalidIdError("delete_day_template", "day_id", day_id);
        if (dayIdError) return dayIdError;
        const day = await findDay(day_id);
        if (!day) return toolError(`delete_day_template failed: Day template ${day_id} not found.`);
        await data.deleteDay(day.id);
        return toolResult({ id: day.id, name: day.name, deleted: true });
      }),

    create_exercise: ({ name, cue, default_sets, default_rep_low, default_rep_high }) =>
      catchToolError("create_exercise", async () => {
        const repLow = default_rep_low ?? 10;
        const repHigh = default_rep_high ?? 12;
        const sets = default_sets ?? 3;
        const repLowError = validateReps(repLow);
        if (repLowError) return toolError(`create_exercise failed: default_rep_low ${repLowError}`);
        const repHighError = validateReps(repHigh);
        if (repHighError) return toolError(`create_exercise failed: default_rep_high ${repHighError}`);
        const setsError = validateSets(sets);
        if (setsError) return toolError(`create_exercise failed: default_sets ${setsError}`);

        const exercise = await data.createExercise({
          name,
          cue: cue ?? "",
          defaultSets: sets,
          defaultRepLow: repLow,
          defaultRepHigh: repHigh,
        });
        return toolResult(exercise);
      }),

    update_exercise: ({ id, name, cue, default_sets, default_rep_low, default_rep_high }) =>
      catchToolError("update_exercise", async () => {
        const idError = invalidIdError("update_exercise", "id", id);
        if (idError) return idError;
        if (
          name === undefined &&
          cue === undefined &&
          default_sets === undefined &&
          default_rep_low === undefined &&
          default_rep_high === undefined
        ) {
          return toolError("update_exercise failed: must provide at least one field to update.");
        }
        if (default_rep_low !== undefined) {
          const repLowError = validateReps(default_rep_low);
          if (repLowError) return toolError(`update_exercise failed: default_rep_low ${repLowError}`);
        }
        if (default_rep_high !== undefined) {
          const repHighError = validateReps(default_rep_high);
          if (repHighError) return toolError(`update_exercise failed: default_rep_high ${repHighError}`);
        }
        if (default_sets !== undefined) {
          const setsError = validateSets(default_sets);
          if (setsError) return toolError(`update_exercise failed: default_sets ${setsError}`);
        }

        // api/mcp.ts's findExerciseRepRange does not filter deleted_at, and
        // neither does getExercise: an archived exercise can still be edited.
        const existing = await data.getExercise(key(id));
        if (!existing) return toolError(`update_exercise failed: Exercise ${id} not found.`);

        const nextRepLow = default_rep_low ?? existing.defaultRepLow;
        const nextRepHigh = default_rep_high ?? existing.defaultRepHigh;
        if (nextRepLow > nextRepHigh) {
          return toolError(
            `update_exercise failed: default_rep_low (${nextRepLow}) must be less than or equal to default_rep_high (${nextRepHigh}).`,
          );
        }

        const exercise = await data.updateExercise(existing.id, {
          name,
          cue,
          defaultSets: default_sets,
          defaultRepLow: default_rep_low,
          defaultRepHigh: default_rep_high,
        });
        return toolResult(exercise);
      }),

    list_exercises: async () => {
      // Not wrapped, as in api/mcp.ts: a failure surfaces as the SDK's own tool error.
      // The DataLayer already orders by name with Supabase's en_US collation.
      return toolResult(await data.listExercises());
    },

    delete_exercise: ({ exercise_id }) =>
      catchToolError("delete_exercise", async () => {
        const exerciseIdError = invalidIdError("delete_exercise", "exercise_id", exercise_id);
        if (exerciseIdError) return exerciseIdError;
        const exercise = await findExercise(exercise_id);
        if (!exercise) return toolError(`delete_exercise failed: Exercise ${exercise_id} not found.`);

        // The Starkeep deleteExercise makes api/mcp.ts's usage check itself
        // (attached, then logged sets, then scheme history) and refuses with
        // ExerciseInUseError; report it in api/mcp.ts's words.
        try {
          await data.deleteExercise(exercise.id);
        } catch (e) {
          if (!(e instanceof ExerciseInUseError)) throw e;
          return toolError(
            e.usage === "day"
              ? `delete_exercise failed: Exercise ${exercise_id} is attached to one or more days; use remove_exercise_from_day to detach it first.`
              : `delete_exercise failed: Exercise ${exercise_id} has logged sets or scheme history and cannot be deleted.`,
          );
        }
        return toolResult({ id: exercise.id, name: exercise.name, deleted: true });
      }),

    add_exercise_to_day: ({ day_id, exercise_id }) =>
      catchToolError("add_exercise_to_day", async () => {
        const dayIdError = invalidIdError("add_exercise_to_day", "day_id", day_id);
        if (dayIdError) return dayIdError;
        const exerciseIdError = invalidIdError("add_exercise_to_day", "exercise_id", exercise_id);
        if (exerciseIdError) return exerciseIdError;
        const day = await findDay(day_id);
        if (!day) return toolError(`add_exercise_to_day failed: Day template ${day_id} not found.`);
        const exercise = await findExercise(exercise_id);
        if (!exercise) return toolError(`add_exercise_to_day failed: Exercise ${exercise_id} not found.`);

        if (await link(day_id, exercise_id)) {
          return toolError(`add_exercise_to_day failed: Exercise ${exercise_id} is already on day ${day_id}.`);
        }

        await data.addExerciseToDay(day.id, exercise.id);
        return toolResult({ day_id, exercise_id });
      }),

    remove_exercise_from_day: ({ day_id, exercise_id }) =>
      catchToolError("remove_exercise_from_day", async () => {
        const dayIdError = invalidIdError("remove_exercise_from_day", "day_id", day_id);
        if (dayIdError) return dayIdError;
        const exerciseIdError = invalidIdError("remove_exercise_from_day", "exercise_id", exercise_id);
        if (exerciseIdError) return exerciseIdError;
        const day = await findDay(day_id);
        if (!day) return toolError(`remove_exercise_from_day failed: Day template ${day_id} not found.`);
        const exercise = await findExercise(exercise_id);
        if (!exercise) return toolError(`remove_exercise_from_day failed: Exercise ${exercise_id} not found.`);

        await data.removeExerciseFromDay(day.id, exercise.id);
        return toolResult({ day_id, exercise_id, removed: true });
      }),

    reorder_day_exercises: ({ day_id, exercise_ids }) =>
      catchToolError("reorder_day_exercises", async () => {
        const dayIdError = invalidIdError("reorder_day_exercises", "day_id", day_id);
        if (dayIdError) return dayIdError;
        const invalidExerciseIds = exercise_ids.filter((id) => !UUID_PATTERN.test(id));
        if (invalidExerciseIds.length) {
          return toolError(
            `reorder_day_exercises failed: expected UUIDs for exercise_ids, got ${invalidExerciseIds.map((id) => `"${id}"`).join(", ")}.`,
          );
        }

        const day = await findDay(day_id);
        if (!day) return toolError(`reorder_day_exercises failed: Day template ${day_id} not found.`);

        if (new Set(exercise_ids).size !== exercise_ids.length) {
          return toolError(`reorder_day_exercises failed: exercise_ids contains duplicate ids.`);
        }

        const current = await rows.selectAll<SkLink>(T.links, {
          where: { workout_day_id: day.id },
          select: ["exercise_id"],
          order: ["position.asc"],
        });
        const currentIds = new Set(current.map((r) => r.exercise_id));
        const requestedIds = new Set(exercise_ids);
        const missing = [...currentIds].filter((id) => !requestedIds.has(id));
        const extra = [...requestedIds].filter((id) => !currentIds.has(id));
        if (missing.length || extra.length) {
          const parts: string[] = [];
          if (missing.length) parts.push(`missing [${missing.join(", ")}]`);
          if (extra.length) parts.push(`unexpected [${extra.join(", ")}]`);
          return toolError(
            `reorder_day_exercises failed: exercise_ids ${parts.join(" and ")}. Use add_exercise_to_day/remove_exercise_from_day to change membership instead.`,
          );
        }

        await data.updateDayExercises(day.id, exercise_ids);
        return toolResult({ day_id, exercise_ids });
      }),

    set_day_exercise_scheme: ({ day_id, exercise_id, sets }) =>
      catchToolError("set_day_exercise_scheme", async () => {
        const dayIdError = invalidIdError("set_day_exercise_scheme", "day_id", day_id);
        if (dayIdError) return dayIdError;
        const exerciseIdError = invalidIdError("set_day_exercise_scheme", "exercise_id", exercise_id);
        if (exerciseIdError) return exerciseIdError;
        const day = await findDay(day_id);
        if (!day) return toolError(`set_day_exercise_scheme failed: Day template ${day_id} not found.`);
        const exercise = await findExercise(exercise_id);
        if (!exercise) return toolError(`set_day_exercise_scheme failed: Exercise ${exercise_id} not found.`);

        if (!(await link(day_id, exercise_id))) {
          return toolError(`set_day_exercise_scheme failed: Exercise ${exercise_id} is not on day ${day_id}.`);
        }

        if (sets) {
          for (const [i, s] of sets.entries()) {
            const weightError = validateWeight(s.weight);
            if (weightError) return toolError(`set_day_exercise_scheme failed: set ${i + 1} weight ${weightError}`);
            const repsError = validateReps(s.reps);
            if (repsError) return toolError(`set_day_exercise_scheme failed: set ${i + 1} reps ${repsError}`);
          }
        }

        const setEntries =
          sets && sets.length > 0 ? sets.map((s, i) => ({ setNumber: i + 1, weight: s.weight, reps: s.reps })) : null;
        await data.setDayExerciseTarget(day.id, exercise.id, setEntries);
        return toolResult({ day_id, exercise_id, sets: setEntries });
      }),

    create_program: ({ name }) =>
      catchToolError("create_program", async () => toolResult(await data.createProgram(name))),

    rename_program: ({ program_id, name }) =>
      catchToolError("rename_program", async () => {
        const program = await findProgram(program_id);
        if (!program) return toolError(`rename_program failed: Program ${program_id} not found.`);
        await data.renameProgram(program.id, name);
        return toolResult({ id: program.id, name });
      }),

    delete_program: ({ program_id }) =>
      catchToolError("delete_program", async () => {
        const program = await findProgram(program_id);
        if (!program) return toolError(`delete_program failed: Program ${program_id} not found.`);
        await data.deleteProgram(program.id);
        return toolResult({ id: program.id, name: program.name, deleted: true });
      }),

    add_day_to_program: ({ day_id, program_id }) =>
      catchToolError("add_day_to_program", async () => {
        const day = await findDay(day_id);
        if (!day) return toolError(`add_day_to_program failed: Day template ${day_id} not found.`);
        if (day.program_id) {
          return toolError(`add_day_to_program failed: Day ${day_id} is already in program ${day.program_id}; remove it first.`);
        }
        const program = await findProgram(program_id);
        if (!program) return toolError(`add_day_to_program failed: Program ${program_id} not found.`);
        await data.addDayToProgram(day.id, program.id);
        return toolResult({ day_id, program_id });
      }),

    remove_day_from_program: ({ day_id }) =>
      catchToolError("remove_day_from_program", async () => {
        const day = await findDay(day_id);
        if (!day) return toolError(`remove_day_from_program failed: Day template ${day_id} not found.`);
        await data.removeDayFromProgram(day.id);
        return toolResult({ day_id, removed: true });
      }),

    reorder_program_days: ({ program_id, day_ids }) =>
      catchToolError("reorder_program_days", async () => {
        const program = await findProgram(program_id);
        if (!program) return toolError(`reorder_program_days failed: Program ${program_id} not found.`);

        if (new Set(day_ids).size !== day_ids.length) {
          return toolError(`reorder_program_days failed: day_ids contains duplicate ids.`);
        }

        const current = await rows.selectAll<SkDay>(T.days, {
          where: { program_id: program.id, archived_at: null },
          select: ["id"],
          order: ["program_position.asc"],
        });
        const currentIds = new Set(current.map((r) => r.id));
        const requestedIds = new Set(day_ids);
        const missing = [...currentIds].filter((id) => !requestedIds.has(id));
        const extra = [...requestedIds].filter((id) => !currentIds.has(id));
        if (missing.length || extra.length) {
          const parts: string[] = [];
          if (missing.length) parts.push(`missing [${missing.join(", ")}]`);
          if (extra.length) parts.push(`unexpected [${extra.join(", ")}]`);
          return toolError(
            `reorder_program_days failed: day_ids ${parts.join(" and ")}. Use add_day_to_program/remove_day_from_program to change membership instead.`,
          );
        }

        await data.reorderProgramDays(program.id, day_ids);
        return toolResult({ program_id, day_ids });
      }),
  };
}
