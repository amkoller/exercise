/**
 * The eight strength analysis reads, as SQLite statements over a snapshot of
 * the user's own rows (`./analysis.ts`).
 *
 * Each statement is the body of the Supabase RPC that `api/mcp.ts` calls,
 * copied from the migration named above it and changed only where SQLite or
 * Starkeep's tables differ. Keep the two in step: a change to an RPC belongs
 * here too, and the parity tests in `./handlers.test.ts` compare the tool text
 * of both backends.
 *
 * Changes every statement shares:
 * - Starkeep's soft-delete column is `archived_at`, not `deleted_at`.
 * - Parameters are named (`$exercise_name`) where the function used its
 *   argument names, and `$workout_day_id` replaces the positional `$1`.
 * - Postgres sorts nulls last in ascending order, and SQLite sorts them first,
 *   so a nullable sort key says `nulls last`.
 * - Postgres leaves rows that tie on every sort key in no particular order.
 *   Each statement appends the rows' ids as a final tiebreak, so the order is
 *   stable and still one Postgres could return.
 * - `ilike` becomes `like … escape '\'`. SQLite's `like` ignores case, and
 *   Postgres's default escape character is the backslash. SQLite folds case
 *   for ASCII letters only, so `ü` does not match `Ü` as it does in Postgres.
 *
 * Results come back with SQLite's types: `0` and `1` for booleans and JSON
 * text for `target_sets`. `./analysis.ts` turns them into what PostgREST
 * prints.
 */

/** A table the statements read, as `starkeep.manifest.json` names it. */
export type AnalysisTable =
  | "programs"
  | "exercises"
  | "workout_days"
  | "workout_day_exercises"
  | "workout_day_exercise_scheme_history"
  | "sessions"
  | "session_sets";

export interface AnalysisStatement {
  /** Every table the statement reads, which the snapshot loads. */
  tables: readonly AnalysisTable[];
  sql: string;
}

/**
 * `round(sum(ss.weight * ss.reps))` with Postgres's exact `numeric`.
 *
 * Starkeep stores `weight` as a float, and a float sum misses a half by a hair:
 * 16.4 × 3 + 0.1 × 3 is 49.49999999999999, which rounds to 49 where Postgres
 * gets 50. Summing whole thousandths keeps the sum exact for any weight with
 * up to three decimals, and SQLite's `round` goes half away from zero, as
 * Postgres's does.
 */
const VOLUME = "round(sum(round(ss.weight * 1000) * ss.reps) / 1000.0)";

/** `0005_analysis_rpc.sql`, with `VOLUME` for the volume. */
export const PROGRESSION_FOR_EXERCISE: AnalysisStatement = {
  tables: ["session_sets", "sessions", "exercises"],
  sql: String.raw`
    select s.performed_on,
           count(*)                        as sets,
           max(ss.weight)                  as top_weight,
           ${VOLUME}                       as volume
    from session_sets ss
    join sessions  s on s.id = ss.session_id
    join exercises e on e.id = ss.exercise_id
    where e.name like '%' || $exercise_name || '%' escape '\'
    group by s.performed_on
    order by s.performed_on`,
};

/**
 * `0005_analysis_rpc.sql`. `date_trunc('week', d)::date` is the Monday on or
 * before `d`: SQLite's `weekday 0` moves to the Sunday on or after it, and six
 * days back from there is that Monday.
 */
export const WEEKLY_VOLUME: AnalysisStatement = {
  tables: ["sessions", "session_sets"],
  sql: String.raw`
    select date(s.performed_on, 'weekday 0', '-6 days') as week,
           count(distinct s.id)                         as sessions,
           ${VOLUME}                                    as total_volume
    from sessions s
    left join session_sets ss on ss.session_id = s.id
    group by 1
    order by 1`,
};

/**
 * `0005_analysis_rpc.sql`. Postgres subtracts two dates to a day count, and
 * SQLite subtracts their Julian day numbers.
 */
export const TRAINING_GAPS: AnalysisStatement = {
  tables: ["sessions"],
  sql: String.raw`
    select performed_on,
           cast(julianday(performed_on) - julianday(lag(performed_on) over (order by performed_on)) as integer)
             as days_since_prev
    from (select distinct performed_on from sessions) d
    order by performed_on`,
};

/** `0010_sets_for_exercise_rpc.sql`. */
export const SETS_FOR_EXERCISE: AnalysisStatement = {
  tables: ["session_sets", "sessions", "exercises"],
  sql: String.raw`
    select s.performed_on,
           ss.set_number,
           ss.weight,
           ss.reps
    from session_sets ss
    join sessions  s on s.id = ss.session_id
    join exercises e on e.id = ss.exercise_id
    where e.name like '%' || $exercise_name || '%' escape '\'
    order by s.performed_on, ss.set_number, ss.id`,
};

/**
 * `0011_workout_history_filters.sql`. The `date` parameters arrive as
 * `YYYY-MM-DD` text, which `./analysis.ts` checks first, and compare as text.
 */
export const GET_WORKOUT_HISTORY: AnalysisStatement = {
  tables: ["sessions", "workout_days", "session_sets", "exercises"],
  sql: String.raw`
    select s.id                as session_id,
           s.performed_on      as performed_on,
           wd.id                as workout_day_id,
           wd.name              as workout_day_name,
           e.id                 as exercise_id,
           e.name               as exercise_name,
           ss.set_number        as set_number,
           ss.weight            as weight,
           ss.reps              as reps
    from sessions s
    left join workout_days wd on wd.id = s.workout_day_id
    left join session_sets ss on ss.session_id = s.id
    left join exercises e on e.id = ss.exercise_id
    where ($start_date is null or s.performed_on >= $start_date)
      and ($end_date is null or s.performed_on <= $end_date)
      and (
        $exercise_name is null
        -- Escape the caller's literal text before wrapping it in our own % wildcards,
        -- so a name containing % or _ is matched as a literal substring.
        or e.name like '%' || replace(replace(replace($exercise_name, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
      )
    order by s.performed_on, s.id, ss.set_number nulls last, ss.id`,
};

/** `20260906151951_scheme_history.sql`. */
export const SCHEME_HISTORY_FOR_DAY_EXERCISE: AnalysisStatement = {
  tables: ["workout_day_exercise_scheme_history"],
  sql: String.raw`
    select h.target_sets, h.recorded_at
    from workout_day_exercise_scheme_history h
    where h.workout_day_id = $workout_day_id
      and h.exercise_id = $exercise_id
    order by h.recorded_at, h.id`,
};

/**
 * `20260906152003_adherence_for_day_rpc.sql`.
 *
 * - SQLite has no `lateral` join. Each lateral subquery becomes a scalar
 *   subquery in the select list, with the same `where` and `order by`.
 * - `recorded_at::date` becomes `date(recorded_at)`. Both take the UTC day,
 *   because Supabase's sessions run in UTC.
 * - `jsonb_array_length` and `jsonb_array_elements` become `json_array_length`
 *   and `json_each`. `(elem->>'reps')::int` becomes
 *   `cast(elem.value ->> 'reps' as integer)`. Postgres refuses a scheme whose
 *   reps are not whole numbers, and SQLite truncates them. The MCP tools and
 *   the app write only whole reps.
 * - `exercise_name` sorts with `collate nocase`, the closest SQLite collation
 *   to Postgres's `en_US`. The two can still differ on punctuation and spaces.
 */
export const ADHERENCE_FOR_DAY: AnalysisStatement = {
  tables: [
    "sessions",
    "session_sets",
    "workout_days",
    "exercises",
    "workout_day_exercise_scheme_history",
    "workout_day_exercises",
  ],
  sql: String.raw`
    with actual as (
      select
        s.id                as session_id,
        s.performed_on      as performed_on,
        s.workout_day_id    as workout_day_id,
        wd.name             as workout_day_name,
        ss.exercise_id      as exercise_id,
        e.name              as exercise_name,
        e.default_sets      as default_sets,
        e.default_rep_low   as default_rep_low,
        e.default_rep_high  as default_rep_high,
        count(*)            as actual_sets,
        avg(ss.reps)        as actual_avg_reps,
        max(ss.weight)      as actual_top_weight
      from sessions s
      join session_sets ss on ss.session_id = s.id
      left join workout_days wd on wd.id = s.workout_day_id
      left join exercises e on e.id = ss.exercise_id
      where ($for_workout_day_id is null or s.workout_day_id = $for_workout_day_id)
        and ($start_date is null or s.performed_on >= $start_date)
        and ($end_date is null or s.performed_on <= $end_date)
      group by s.id, s.performed_on, s.workout_day_id, wd.name, ss.exercise_id, e.name,
               e.default_sets, e.default_rep_low, e.default_rep_high
    ),
    resolved as (
      select
        a.*,
        case
          when exists (
            select 1
            from workout_day_exercise_scheme_history sh
            where sh.workout_day_id = a.workout_day_id
              and sh.exercise_id = a.exercise_id
              and date(sh.recorded_at) <= a.performed_on
          )
          then (
            select sh.target_sets
            from workout_day_exercise_scheme_history sh
            where sh.workout_day_id = a.workout_day_id
              and sh.exercise_id = a.exercise_id
              and date(sh.recorded_at) <= a.performed_on
            order by sh.recorded_at desc, sh.id desc
            limit 1
          )
          else (
            select wde.target_sets
            from workout_day_exercises wde
            where wde.workout_day_id = a.workout_day_id
              and wde.exercise_id = a.exercise_id
            limit 1
          )
        end as target_sets_json
      from actual a
    ),
    targets as (
      select
        r.*,
        coalesce(json_array_length(r.target_sets_json), r.default_sets) as target_sets_count,
        coalesce(
          (select min(cast(elem.value ->> 'reps' as integer))
           from json_each(coalesce(r.target_sets_json, '[]')) elem),
          r.default_rep_low
        ) as target_rep_low,
        coalesce(
          (select max(cast(elem.value ->> 'reps' as integer))
           from json_each(coalesce(r.target_sets_json, '[]')) elem),
          r.default_rep_high
        ) as target_rep_high,
        (select max(cast(elem.value ->> 'weight' as real))
         from json_each(coalesce(r.target_sets_json, '[]')) elem) as target_weight
      from resolved r
    )
    select
      session_id,
      performed_on,
      workout_day_id,
      workout_day_name,
      exercise_id,
      exercise_name,
      actual_sets,
      target_sets_count as target_sets,
      case
        when actual_sets < target_sets_count then 'under'
        when actual_sets > target_sets_count then 'over'
        else 'match'
      end as sets_status,
      round(actual_avg_reps, 1) as actual_avg_reps,
      target_rep_low,
      target_rep_high,
      case
        when actual_avg_reps < target_rep_low then 'under'
        when actual_avg_reps > target_rep_high then 'over'
        else 'match'
      end as reps_status,
      actual_top_weight,
      target_weight,
      case
        when target_weight is null then null
        when actual_top_weight < target_weight then 'under'
        when actual_top_weight > target_weight then 'over'
        else 'match'
      end as weight_status
    from targets
    order by performed_on, session_id, exercise_name collate nocase nulls last, exercise_id`,
};

/** `20260906180100_day_sequencing.sql`. */
export const GET_DAY_TEMPLATES: AnalysisStatement = {
  tables: ["sessions", "session_sets", "workout_days", "programs", "workout_day_exercises", "exercises"],
  sql: String.raw`
    with day_done as (
      select distinct s.workout_day_id
      from sessions s
      join session_sets ss on ss.session_id = s.id
      where s.workout_day_id is not null
    ),
    program_next as (
      select wd.program_id, min(wd.program_position) as next_position
      from workout_days wd
      left join day_done dd on dd.workout_day_id = wd.id
      where wd.program_id is not null and wd.archived_at is null and dd.workout_day_id is null
      group by wd.program_id
    )
    select wd.id                                                 as workout_day_id,
           wd.name                                                as workout_day_name,
           wd.position                                            as workout_day_position,
           p.id                                                   as program_id,
           p.name                                                 as program_name,
           case when p.id is null then null else wd.program_position end as program_position,
           coalesce(p.id is null or wd.program_position = pn.next_position, false) as is_available,
           e.id                                                   as exercise_id,
           e.name                                                 as exercise_name,
           e.cue                                                  as exercise_cue,
           wde.position                                           as exercise_position,
           wde.target_sets                                        as target_sets,
           wde.target_sets is null                                as uses_default_scheme,
           e.default_sets                                         as default_sets,
           e.default_rep_low                                      as default_rep_low,
           e.default_rep_high                                     as default_rep_high
    from workout_days wd
    left join programs p on p.id = wd.program_id and p.archived_at is null
    left join program_next pn on pn.program_id = p.id
    left join workout_day_exercises wde on wde.workout_day_id = wd.id
    left join exercises e on e.id = wde.exercise_id
    where wd.archived_at is null
    order by wd.position, wde.position nulls last, wd.created_at, wd.id, wde.id`,
};
