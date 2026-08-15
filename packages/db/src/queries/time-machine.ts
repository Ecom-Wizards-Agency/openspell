/**
 * Time Machine (WP-30): the account's change history, read-only.
 *
 * AdLabs ships a per-account change log; this is ours, built over data we
 * already record and adding no table. Two sources feed one reverse-chronological
 * timeline:
 *
 *  - `entity_changes` — every bid / budget / state diff the entity sync noticed.
 *    Its `source` says whether *we* caused it (`apply`) or somebody changed it
 *    outside wizard-ads (`sync`); the latter is the point of recording it at all.
 *  - `apply_batches` / `apply_rows` — the operator's own applied changes, one row
 *    per field per opt-group batch, carrying the batch's note and lever.
 *
 * The two would double-count an applied change that the next sync also observes,
 * so the `entity_changes` branch is narrowed to rows with **no** `apply_batch_id`
 * (a sync-detected or otherwise unattributed change), and the apply branch owns
 * everything an operator batch touched. An entry is therefore attributed to
 * exactly one source.
 *
 * Every statement carries an explicit `org_id` and `profile_id` predicate. The
 * web tier connects as the application's own role, so RLS is the second fence,
 * not the first: a query that forgot the org predicate would be a cross-tenant
 * read in the browser even though the same query is safe from PostgREST.
 */
import type { DbHandle } from '../client.js';
import type { JsonValue } from './goto.js';
import { toDate } from './pg-time.js';

export type TimeMachineQueryHandle = Pick<DbHandle, 'sql'>;

/** How the change was recorded — the filter the timeline groups by source. */
export type ChangeSource = 'sync' | 'apply';

export interface TimelineEntry {
  /** Stable, unique across both sources — the React key and dedupe handle. */
  id: string;
  source: ChangeSource;
  entityType: string;
  amazonId: string;
  entityName: string | null;
  field: string;
  oldValue: JsonValue;
  newValue: JsonValue;
  observedAt: Date;
  /** Present only for an operator apply-batch entry. */
  batch: {
    id: string;
    tag: string;
    optGroup: string;
    lever: string;
    note: string;
  } | null;
}

export interface TimelineFilter {
  orgId: string;
  profileId: string;
  /** Entity types to include (e.g. `keyword`, `campaign`). Empty / omitted = all. */
  entityTypes?: readonly string[] | null;
  /** A single field name (e.g. `bid`, `budget`, `state`). Omitted = all. */
  field?: string | null;
  /** Restrict to one source. Omitted = both. */
  source?: ChangeSource | null;
  /** Inclusive ISO date-or-timestamp bounds on `observed_at`. */
  from?: string | null;
  to?: string | null;
  limit?: number;
}

interface TimelineRow {
  id: string;
  source: ChangeSource;
  entity_type: string;
  amazon_id: string;
  entity_name: string | null;
  field: string;
  old_value: JsonValue;
  new_value: JsonValue;
  observed_at: Date | string;
  batch_id: string | null;
  batch_tag: string | null;
  batch_opt_group: string | null;
  batch_lever: string | null;
  batch_note: string | null;
}

const toEntry = (row: TimelineRow): TimelineEntry => ({
  id: row.id,
  source: row.source,
  entityType: row.entity_type,
  amazonId: row.amazon_id,
  entityName: row.entity_name,
  field: row.field,
  oldValue: row.old_value,
  newValue: row.new_value,
  observedAt: toDate(row.observed_at),
  batch:
    row.batch_id === null
      ? null
      : {
          id: row.batch_id,
          tag: row.batch_tag ?? '',
          optGroup: row.batch_opt_group ?? '',
          lever: row.batch_lever ?? '',
          note: row.batch_note ?? '',
        },
});

/**
 * The timeline for one profile, newest first.
 *
 * `entity_changes` (sync-detected, no batch) unioned with `apply_rows` (operator
 * batches). Filters bind as nullable parameters so a filtered and an unfiltered
 * call are the same statement, and the `source` filter selects a branch by
 * making the other contribute nothing.
 */
export async function listTimeline(
  handle: TimeMachineQueryHandle,
  filter: TimelineFilter,
): Promise<TimelineEntry[]> {
  const entityTypes = filter.entityTypes?.length ? [...filter.entityTypes] : null;
  const field = filter.field?.trim() || null;
  const source = filter.source ?? null;
  const from = filter.from ?? null;
  const to = filter.to ?? null;
  const limit = Math.min(Math.max(filter.limit ?? 500, 1), 2000);

  const rows = await handle.sql<TimelineRow[]>`
    (
      select
        'change:' || ec.id::text                      as id,
        ec.source::text                               as source,
        ec.entity_type::text                          as entity_type,
        ec.amazon_id                                  as amazon_id,
        ec.entity_name                                as entity_name,
        ec.field                                      as field,
        ec.old_value                                  as old_value,
        ec.new_value                                  as new_value,
        ec.observed_at                                as observed_at,
        null::uuid                                    as batch_id,
        null::text                                    as batch_tag,
        null::text                                    as batch_opt_group,
        null::text                                    as batch_lever,
        null::text                                    as batch_note
      from public.entity_changes ec
      where ec.org_id = ${filter.orgId}
        and ec.profile_id = ${filter.profileId}
        and ec.apply_batch_id is null
        and (${entityTypes}::text[] is null or ec.entity_type::text = any(${entityTypes}::text[]))
        and (${field}::text is null or ec.field = ${field}::text)
        and (${source}::text is null or ec.source::text = ${source}::text)
        and (${from}::timestamptz is null or ec.observed_at >= ${from}::timestamptz)
        and (${to}::timestamptz is null or ec.observed_at <= ${to}::timestamptz)
    )
    union all
    (
      select
        'apply:' || ar.id::text                       as id,
        'apply'                                        as source,
        ar.entity_type::text                          as entity_type,
        ar.entity_id                                  as amazon_id,
        ar.entity_name                                as entity_name,
        ar.field                                      as field,
        ar.old_value                                  as old_value,
        ar.new_value                                  as new_value,
        coalesce(ab.applied_on::timestamptz, ab.created_at) as observed_at,
        ab.id                                         as batch_id,
        ab.tag                                        as batch_tag,
        ab.opt_group                                  as batch_opt_group,
        ar.lever                                      as batch_lever,
        ab.note                                       as batch_note
      from public.apply_rows ar
      join public.apply_batches ab on ab.id = ar.batch_id
      where ar.org_id = ${filter.orgId}
        and ab.org_id = ${filter.orgId}
        and ab.profile_id = ${filter.profileId}
        and (${entityTypes}::text[] is null or ar.entity_type::text = any(${entityTypes}::text[]))
        and (${field}::text is null or ar.field = ${field}::text)
        and (${source}::text is null or ${source}::text = 'apply')
        and (${from}::timestamptz is null
             or coalesce(ab.applied_on::timestamptz, ab.created_at) >= ${from}::timestamptz)
        and (${to}::timestamptz is null
             or coalesce(ab.applied_on::timestamptz, ab.created_at) <= ${to}::timestamptz)
    )
    order by observed_at desc, id desc
    limit ${limit}
  `;
  return rows.map(toEntry);
}

export interface TimelineFacets {
  entityTypes: string[];
  fields: string[];
}

/**
 * The distinct entity types and fields present across both sources for a
 * profile, so the filter controls offer only values that would return something.
 * Independent of the current filter on purpose: a filter control that hides the
 * option that would widen the view is a trap.
 */
export async function listTimelineFacets(
  handle: TimeMachineQueryHandle,
  input: { orgId: string; profileId: string },
): Promise<TimelineFacets> {
  const rows = await handle.sql<{ entity_type: string; field: string }[]>`
    select ec.entity_type::text as entity_type, ec.field as field
      from public.entity_changes ec
     where ec.org_id = ${input.orgId}
       and ec.profile_id = ${input.profileId}
       and ec.apply_batch_id is null
    union
    select ar.entity_type::text as entity_type, ar.field as field
      from public.apply_rows ar
      join public.apply_batches ab on ab.id = ar.batch_id
     where ar.org_id = ${input.orgId}
       and ab.org_id = ${input.orgId}
       and ab.profile_id = ${input.profileId}
  `;
  const entityTypes = [...new Set(rows.map((row) => row.entity_type))].sort();
  const fields = [...new Set(rows.map((row) => row.field))].sort();
  return { entityTypes, fields };
}
