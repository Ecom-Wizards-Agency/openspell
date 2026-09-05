/**
 * Time Machine (WP-30): the account's change history, read-only.
 *
 * AdLabs ships a per-account change log; this is ours, built over data we
 * already record and adding no history table. Three sources feed one reverse-chronological
 * timeline:
 *
 *  - `entity_changes` — every bid / budget / state diff the entity sync noticed.
 *    Its `source` says whether *we* caused it (`apply`) or somebody changed it
 *    outside wizard-ads (`sync`); the latter is the point of recording it at all.
 *  - `apply_batches` / `apply_rows` — the operator's exported changes, one row
 *    per field per opt-group batch, carrying lifecycle evidence, note and lever.
 *  - Native write plans, approvals and execution evidence — each approved
 *    keyword-bid action and its independently recorded inverse.
 *
 * Legacy export history owns its linked sync changes. Native history replaces
 * only its exact source rows and write-attributed mirror diffs. Ordinary sync
 * events and native conflict observations remain visible even after the legacy
 * linker attaches them to a batch; that link is not native attribution evidence.
 *
 * Every statement carries an explicit `org_id` and `profile_id` predicate. The
 * web tier connects as the application's own role, so RLS is the second fence,
 * not the first: a query that forgot the org predicate would be a cross-tenant
 * read in the browser even though the same query is safe from PostgREST.
 */
import { createHash } from 'node:crypto';
import {
  ReversionBatchPreview,
  serializeApplyRows,
} from '@wizard-ads/shared';
import type {
  ApplyEntityType,
  ApplyRow,
  ApplyValue,
  ReversionBatchPreview as ReversionBatchPreviewType,
  ReversionRowPreview,
} from '@wizard-ads/shared';
import type { DbHandle, QuerySql } from '../client.js';
import type { JsonValue } from './goto.js';
import { lockCurrentApplyStates } from './apply-state.js';
import { toDate, toDateOrNull } from './pg-time.js';
import { TimeMachineCursor, TimeMachineInstant, compareTimeMachineCursors, type TimeMachineNativeWrite } from '@wizard-ads/shared/time-machine-writes';
import { SpWriteOperationId } from '@wizard-ads/shared/sp-write-application';
import { listNativeTimeline, nativeTimelineRoots } from './time-machine-writes.js';

export type TimeMachineQueryHandle = Pick<DbHandle, 'sql'>;
interface TimeMachineReadHandle {
  sql: QuerySql;
}

/** How the change was recorded — the filter the timeline groups by source. */
export type ChangeSource = 'sync' | 'apply';

export interface TimelineEntry {
  /** Stable across all sources — the React key and dedupe handle. */
  id: string;
  source: ChangeSource;
  entityType: string;
  amazonId: string;
  entityName: string | null;
  field: string;
  oldValue: JsonValue;
  newValue: JsonValue;
  observedAt: Date;
  /** Exact keyset time; Date alone discards PostgreSQL microseconds. */
  observedAtExact: string;
  write: TimeMachineNativeWrite | null;
  /** Present only for an operator apply-batch entry. */
  batch: {
    id: string;
    tag: string;
    optGroup: string;
    lever: string;
    note: string;
    status: string;
    sourceBatchId: string | null;
    exportedAt: Date;
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
  /** Return entries strictly older than this stable `(observed_at, id)` key. */
  before?: { observedAt: string; id: string } | null;
  /** Optional focus on one native operation, including its exact plan identity. */
  operation?: SpWriteOperationId | null;
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
  observed_at_exact: string;
  batch_id: string | null;
  batch_tag: string | null;
  batch_opt_group: string | null;
  batch_lever: string | null;
  batch_note: string | null;
  batch_status: string | null;
  batch_source_batch_id: string | null;
  batch_exported_at: Date | string | null;
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
  observedAtExact: TimeMachineInstant.parse(row.observed_at_exact),
  write: null,
  batch:
    row.batch_id === null
      ? null
      : {
          id: row.batch_id,
          tag: row.batch_tag ?? '',
          optGroup: row.batch_opt_group ?? '',
          lever: row.batch_lever ?? '',
          note: row.batch_note ?? '',
          status: row.batch_status ?? 'staged',
          sourceBatchId: row.batch_source_batch_id,
          exportedAt: toDate(row.batch_exported_at ?? row.observed_at),
        },
});

/**
 * The timeline for one profile, newest first.
 *
 * Native and legacy candidates use the same filters and one read snapshot.
 * Approval time orders native actions; later execution evidence does not move
 * those entries across page boundaries.
 */
export async function listTimeline(
  handle: TimeMachineQueryHandle,
  filter: TimelineFilter,
): Promise<TimelineEntry[]> {
  const limit = Math.min(Math.max(filter.limit ?? 500, 1), 2000);
  const normalized = { ...filter, limit, field: filter.field?.trim() || null,
    before: filter.before == null ? null : TimeMachineCursor.parse(filter.before),
    operation: filter.operation == null ? null : SpWriteOperationId.parse(filter.operation) };
  const result = await handle.sql.begin('isolation level repeatable read read only', async (sql) => {
    const native = await listNativeTimeline(sql, normalized);
    const legacy = normalized.operation === null ? await listLegacyTimeline({ sql }, normalized) : [];
    const entries = [...legacy, ...native].sort((left, right) => compareTimeMachineCursors(
      { observedAt: right.observedAtExact, id: right.id }, { observedAt: left.observedAtExact, id: left.id },
    )).slice(0, limit);
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error('timeline entry identities do not close');
    return { entries };
  });
  return result.entries;
}

async function listLegacyTimeline(
  handle: TimeMachineReadHandle, filter: TimelineFilter,
): Promise<TimelineEntry[]> {
  const entityTypes = filter.entityTypes?.length ? [...filter.entityTypes] : null;
  const field = filter.field ?? null;
  const source = filter.source ?? null;
  const from = filter.from ?? null;
  const to = filter.to ?? null;
  const limit = Math.min(Math.max(filter.limit ?? 500, 1), 2000);
  const beforeObservedAt = filter.before?.observedAt ?? null;
  const beforeId = filter.before?.id ?? null;

  const rows = await handle.sql<TimelineRow[]>`
    with native_roots as (${nativeTimelineRoots(handle.sql, filter)}), timeline as (
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
        ,null::text                                   as batch_status
        ,null::uuid                                   as batch_source_batch_id
        ,null::timestamptz                            as batch_exported_at
      from public.entity_changes ec
      where ec.org_id = ${filter.orgId}
        and ec.profile_id = ${filter.profileId}
        -- A legacy batch link does not establish native-write attribution.
        and (ec.apply_batch_id is null
          or exists(select 1 from public.apply_batches b where b.org_id = ec.org_id
            and b.profile_id = ec.profile_id and b.id = ec.apply_batch_id
            and b.source_kind = 'mcp_keyword_proposals')
          or exists(select 1 from native_roots n where n.direction = 'forward'
            and n.org_id = ec.org_id and n.profile_id = ec.profile_id
            and n.preview_artifact #>> '{provenance,applyBatchId}' = ec.apply_batch_id::text)
          or exists(select 1 from public.sp_write_mirror_observations m
          where m.org_id = ec.org_id and m.profile_id = ec.profile_id and m.entity_change_id = ec.id
            and m.change_attribution = 'observation'))
        and not exists(select 1 from public.sp_write_mirror_observations m
          join native_roots n on n.org_id = m.org_id and n.profile_id = m.profile_id
            and n.execution_id = m.execution_id and n.plan_id = m.plan_id
          join public.sp_write_plan_actions a on a.org_id = n.org_id and a.profile_id = n.profile_id
            and a.plan_id = n.plan_id and a.action_id = m.action_id
          where m.entity_change_id = ec.id and m.change_attribution = 'write'
            and a.route_key = 'sp.v3.keywords.update' and a.artifact -> 'changes' ? 'bid')
        and (${entityTypes}::text[] is null or ec.entity_type::text = any(${entityTypes}::text[]))
        and (${field}::text is null or ec.field = ${field}::text)
        and (${source}::text is null or ec.source::text = ${source}::text)
        and (${from}::timestamptz is null or ec.observed_at >= ${from}::timestamptz)
        and (${to}::timestamptz is null or ec.observed_at <= ${to}::timestamptz)
      union all
      select
        'apply:' || ar.id::text                       as id,
        'apply'                                       as source,
        ar.entity_type::text                          as entity_type,
        ar.entity_id                                  as amazon_id,
        ar.entity_name                                as entity_name,
        ar.field                                      as field,
        ar.old_value                                  as old_value,
        ar.new_value                                  as new_value,
        coalesce(ab.applied_at, ab.exported_at, ab.created_at) as observed_at,
        ab.id                                         as batch_id,
        ab.tag                                        as batch_tag,
        ab.opt_group                                  as batch_opt_group,
        ar.lever                                      as batch_lever,
        ab.note                                       as batch_note
        ,ab.status::text                              as batch_status
        ,ab.source_batch_id                           as batch_source_batch_id
        ,ab.exported_at                               as batch_exported_at
      from public.apply_rows ar
      join public.apply_batches ab on ab.id = ar.batch_id
      where ar.org_id = ${filter.orgId}
        and ab.org_id = ${filter.orgId}
        and ab.profile_id = ${filter.profileId}
        and ab.source_kind = 'legacy_export'
        and not exists(select 1 from native_roots n join public.sp_write_plan_actions a
          on a.org_id = n.org_id and a.profile_id = n.profile_id and a.plan_id = n.plan_id
          where n.direction = 'forward' and a.route_key = 'sp.v3.keywords.update'
            and a.artifact -> 'changes' ? 'bid' and a.artifact -> 'sources' @> jsonb_build_array(
              jsonb_build_object('kind', 'apply_row', 'applyRowId', ar.id::text, 'changeKey', 'keyword.bid')))
        and (${entityTypes}::text[] is null or ar.entity_type::text = any(${entityTypes}::text[]))
        and (${field}::text is null or ar.field = ${field}::text)
        and (${source}::text is null or ${source}::text = 'apply')
        and (${from}::timestamptz is null
             or coalesce(ab.applied_at, ab.exported_at, ab.created_at) >= ${from}::timestamptz)
        and (${to}::timestamptz is null
             or coalesce(ab.applied_at, ab.exported_at, ab.created_at) <= ${to}::timestamptz)
    )
    select *, to_char(observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as observed_at_exact
      from timeline
     where (${beforeObservedAt}::timestamptz is null
            or (observed_at, id collate "C") < (${beforeObservedAt}::timestamptz, ${beforeId}::text collate "C"))
    order by observed_at desc, id collate "C" desc
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
    with native_roots as (${nativeTimelineRoots(handle.sql, input)})
    select ec.entity_type::text as entity_type, ec.field as field
      from public.entity_changes ec
     where ec.org_id = ${input.orgId}
       and ec.profile_id = ${input.profileId}
       and (ec.apply_batch_id is null
         or exists(select 1 from public.apply_batches b where b.org_id = ec.org_id
           and b.profile_id = ec.profile_id and b.id = ec.apply_batch_id
           and b.source_kind = 'mcp_keyword_proposals')
         or exists(select 1 from native_roots n where n.direction = 'forward'
           and n.org_id = ec.org_id and n.profile_id = ec.profile_id
           and n.preview_artifact #>> '{provenance,applyBatchId}' = ec.apply_batch_id::text)
         or exists(select 1 from public.sp_write_mirror_observations m
           where m.org_id = ec.org_id and m.profile_id = ec.profile_id
             and m.entity_change_id = ec.id and m.change_attribution = 'observation'))
    union
    select ar.entity_type::text as entity_type, ar.field as field
      from public.apply_rows ar
      join public.apply_batches ab on ab.id = ar.batch_id
     where ar.org_id = ${input.orgId}
       and ab.org_id = ${input.orgId}
       and ab.profile_id = ${input.profileId}
       and ab.source_kind = 'legacy_export'
    union
    select 'keyword' as entity_type, 'bid' as field from native_roots n
      join public.sp_write_plan_actions a on a.org_id = n.org_id and a.profile_id = n.profile_id and a.plan_id = n.plan_id
      where a.route_key = 'sp.v3.keywords.update' and a.artifact -> 'changes' ? 'bid'
  `;
  const entityTypes = [...new Set(rows.map((row) => row.entity_type))].sort();
  const fields = [...new Set(rows.map((row) => row.field))].sort();
  return { entityTypes, fields };
}

// ---------------------------------------------------------------------------
// Time Machine v2: immutable export batches and evidence-backed reversions.
// ---------------------------------------------------------------------------

export interface ReversionBatchSummary {
  batchId: string;
  sourceBatchId: string | null;
  profileId: string;
  tag: string;
  optGroup: string;
  lever: string;
  lifecycleStatus: ReversionBatchPreviewType['lifecycleStatus'];
  exportedAt: Date;
  appliedAt: Date | null;
  exportedProposals: number;
  reversibleRows: number;
  unsupportedRows: number;
}

interface ReversionBatchHeaderRow {
  id: string;
  source_batch_id: string | null;
  active_reversion_batch_id: string | null;
  profile_id: string;
  tag: string;
  opt_group: string;
  lever: string;
  note: string;
  status: string;
  exported_at: Date | string;
  applied_at: Date | string | null;
  artifact_sha256: string | null;
  exported_proposals: number;
  reversible_rows: number;
  unsupported_rows: number;
}

interface ReversionEvidenceRow {
  row_id: string;
  recommendation_id: string | null;
  entity_type: ApplyEntityType;
  entity_id: string;
  entity_name: string | null;
  field: string;
  old_value: unknown;
  new_value: unknown;
  supported: boolean;
  present: boolean;
  current_value: unknown;
  current_synced_at: Date | string | null;
  synchronized_value: unknown;
  synchronized_at: Date | string | null;
  has_unlinked_exact_change: boolean;
}

function lifecycleStatus(row: Pick<ReversionBatchHeaderRow, 'source_batch_id' | 'status'>): ReversionBatchPreviewType['lifecycleStatus'] {
  if (row.status === 'abandoned') return 'abandoned';
  if (row.status === 'reverted') return 'verified_reverted';
  if (row.source_batch_id !== null) return 'reversion_exported';
  if (row.status === 'applied') return 'applied_externally';
  return 'exported';
}

function scalar(value: unknown): { valid: true; value: ApplyValue } | { valid: false; value: null } {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return { valid: true, value };
  }
  return { valid: false, value: null };
}

function sameScalar(left: ApplyValue, right: ApplyValue): boolean {
  return typeof left === typeof right && Object.is(left, right);
}

function classifyReversionRow(
  batchId: string,
  exportedAt: Date,
  row: ReversionEvidenceRow,
): ReversionRowPreview {
  const original = scalar(row.old_value);
  const exported = scalar(row.new_value);
  const current = scalar(row.current_value);
  const synchronized = scalar(row.synchronized_value);
  const synchronizedAt = toDateOrNull(row.synchronized_at);
  const currentSyncedAt = toDateOrNull(row.current_synced_at);

  let state: ReversionRowPreview['state'];
  let reason: string;

  if (!original.valid || !exported.valid) {
    state = 'unsupported';
    reason = 'The exported row contains a structured value that the staged-apply bridge cannot invert.';
  } else if (!row.supported) {
    state = 'unsupported';
    reason = 'This entity field does not have a verified current-state adapter.';
  } else if (!row.present) {
    state = 'conflict';
    reason = 'The entity is missing or deleted in the current synchronized mirror.';
  } else if (synchronizedAt === null) {
    state = row.has_unlinked_exact_change ? 'ambiguous' : 'awaiting_sync';
    reason = row.has_unlinked_exact_change
      ? 'An exact change was observed, but it cannot be attributed uniquely to this export.'
      : 'The exported value has not appeared in a uniquely linked synchronization event.';
  } else if (
    currentSyncedAt === null ||
    currentSyncedAt.getTime() < exportedAt.getTime()
  ) {
    state = 'conflict';
    reason = 'The current mirror has not been synchronized since this batch was exported.';
  } else if (!current.valid) {
    state = 'unsupported';
    reason = 'The current synchronized value is not a scalar value.';
  } else if (sameScalar(current.value, exported.value)) {
    state = 'ready';
    reason = 'The exported value was uniquely observed and still matches the current synchronized value.';
  } else if (sameScalar(current.value, original.value)) {
    state = 'already_reverted';
    reason = 'The current synchronized value already equals the original value.';
  } else {
    state = 'conflict';
    reason = 'The current synchronized value differs from the value this export expected to apply.';
  }

  const originalValue = original.value;
  const exportedValue = exported.value;
  return {
    batchId,
    rowId: row.row_id,
    recommendationId: row.recommendation_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityName: row.entity_name,
    field: row.field,
    originalValue,
    proposedValue: exportedValue,
    exportedValue,
    synchronizedValue: synchronizedAt === null || !synchronized.valid ? null : synchronized.value,
    synchronizedAt: synchronizedAt?.toISOString() ?? null,
    currentValue: current.valid ? current.value : null,
    currentSyncedAt: currentSyncedAt?.toISOString() ?? null,
    inverseValue: originalValue,
    state,
    conflict: state === 'conflict' || state === 'ambiguous',
    exportAllowed: state === 'ready',
    reason,
  };
}

export async function listReversionBatches(
  handle: TimeMachineQueryHandle,
  input: { orgId: string; profileId: string; limit?: number },
): Promise<ReversionBatchSummary[]> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const rows = await handle.sql<ReversionBatchHeaderRow[]>`
    with native_roots as (${nativeTimelineRoots(handle.sql, input)})
    select id, source_batch_id,
           (select child.id from public.apply_batches child
             where child.org_id = apply_batches.org_id
               and child.profile_id = apply_batches.profile_id
               and child.source_batch_id = apply_batches.id
               and child.status <> 'abandoned'
             order by child.exported_at desc limit 1) as active_reversion_batch_id,
           profile_id, tag, opt_group, lever, note,
           status::text as status, exported_at, applied_at, artifact_sha256,
           exported_proposals, reversible_rows, unsupported_rows
      from public.apply_batches
     where org_id = ${input.orgId}
       and profile_id = ${input.profileId}
       and source_kind = 'legacy_export'
       and not exists(select 1 from native_roots n where n.direction = 'forward'
         and n.preview_artifact #>> '{provenance,applyBatchId}' = apply_batches.id::text)
     order by exported_at desc, id desc
     limit ${limit}
  `;
  return rows.map((row) => ({
    batchId: row.id,
    sourceBatchId: row.source_batch_id,
    profileId: row.profile_id,
    tag: row.tag,
    optGroup: row.opt_group,
    lever: row.lever,
    lifecycleStatus: lifecycleStatus(row),
    exportedAt: toDate(row.exported_at),
    appliedAt: toDateOrNull(row.applied_at),
    exportedProposals: row.exported_proposals,
    reversibleRows: row.reversible_rows,
    unsupportedRows: row.unsupported_rows,
  }));
}

/** One source batch, reconstructed from immutable rows and exact sync links. */
export async function getReversionBatchPreview(
  handle: TimeMachineReadHandle,
  input: { orgId: string; batchId: string },
): Promise<ReversionBatchPreviewType | null> {
  const [header] = await handle.sql<ReversionBatchHeaderRow[]>`
    select id, source_batch_id,
           (select child.id from public.apply_batches child
             where child.org_id = apply_batches.org_id
               and child.profile_id = apply_batches.profile_id
               and child.source_batch_id = apply_batches.id
               and child.status <> 'abandoned'
             order by child.exported_at desc limit 1) as active_reversion_batch_id,
           profile_id, tag, opt_group, lever, note,
           status::text as status, exported_at, applied_at, artifact_sha256,
           exported_proposals, reversible_rows, unsupported_rows
      from public.apply_batches
     where org_id = ${input.orgId} and id = ${input.batchId}
       and source_kind = 'legacy_export'
       and not exists(select 1 from public.sp_write_plans p
         join public.sp_write_authorization_receipts r on r.org_id = p.org_id
           and r.profile_id = p.profile_id and r.plan_id = p.plan_id
         where p.org_id = apply_batches.org_id and p.profile_id = apply_batches.profile_id
           and p.direction = 'forward' and p.artifact #>> '{source,applyBatchId}' = apply_batches.id::text)
  `;
  if (header === undefined) return null;

  const evidence = await handle.sql<ReversionEvidenceRow[]>`
    select ar.id as row_id, ar.recommendation_id,
           ar.entity_type::text as entity_type, ar.entity_id, ar.entity_name,
           ar.field, ar.old_value, ar.new_value,
           current_state.supported, current_state.present,
           current_state.current_value, current_state.current_synced_at,
           linked.new_value as synchronized_value,
           linked.observed_at as synchronized_at,
           exists (
             select 1
               from public.entity_changes possible
              where possible.org_id = b.org_id
                and possible.profile_id = b.profile_id
                and possible.apply_batch_id is null
                and possible.source = 'sync'
                and possible.entity_type::text =
                    (case when ar.entity_type = 'placement' then 'campaign' else ar.entity_type::text end)
                and possible.amazon_id = ar.entity_id
                and app.canonical_apply_field(possible.entity_type::text, possible.field)
                    = app.canonical_apply_field(ar.entity_type::text, ar.field)
                and possible.old_value = ar.old_value
                and possible.new_value = ar.new_value
                and possible.observed_at >= b.exported_at
           ) as has_unlinked_exact_change
      from public.apply_batches b
      join public.apply_rows ar
        on ar.org_id = b.org_id
       and ar.profile_id = b.profile_id
       and ar.batch_id = b.id
      cross join lateral app.resolve_apply_current_value(
        b.org_id, b.profile_id, ar.entity_type, ar.entity_id, ar.field
      ) current_state
      left join lateral (
        select ec.new_value, ec.observed_at
          from public.entity_changes ec
         where ec.org_id = b.org_id
           and ec.profile_id = b.profile_id
           and ec.apply_row_id = ar.id
         order by ec.observed_at, ec.id
         limit 1
      ) linked on true
     where b.org_id = ${input.orgId}
       and b.id = ${input.batchId}
     order by ar.created_at, ar.id
  `;

  const exportedAt = toDate(header.exported_at);
  const rows = evidence.map((row) => classifyReversionRow(header.id, exportedAt, row));
  const readyRows = rows.filter((row) => row.exportAllowed).length;
  const blockedRows = header.exported_proposals - readyRows;
  let exportAllowed = true;
  let reason = `${readyRows} synchronized changes are ready for an exact inverse export.`;

  if (header.source_batch_id !== null) {
    exportAllowed = false;
    reason = 'A reversion export is an immutable audit record and cannot itself be inverted here.';
  } else if (header.active_reversion_batch_id !== null) {
    exportAllowed = false;
    reason = 'This batch already has an active reversion export.';
  } else if (header.status === 'abandoned') {
    exportAllowed = false;
    reason = 'This export was abandoned.';
  } else if (header.status === 'reverted') {
    exportAllowed = false;
    reason = 'This batch is already verified as reverted.';
  } else if (header.artifact_sha256 === null) {
    exportAllowed = false;
    reason = 'This legacy export has no immutable artifact fingerprint.';
  } else if (header.unsupported_rows > 0) {
    exportAllowed = false;
    reason = `${header.unsupported_rows} exported create rows do not have an invertible old value.`;
  } else if (rows.length !== header.reversible_rows) {
    exportAllowed = false;
    reason = `The ledger expected ${header.reversible_rows} reversible rows but reconstructed ${rows.length}.`;
  } else if (rows.length === 0) {
    exportAllowed = false;
    reason = 'This export contains no reversible update rows.';
  } else if (readyRows !== rows.length) {
    exportAllowed = false;
    reason = `${rows.length - readyRows} of ${rows.length} rows are waiting, ambiguous, unsupported, or conflicted.`;
  }

  return ReversionBatchPreview.parse({
    batchId: header.id,
    sourceBatchId: header.source_batch_id,
    activeReversionBatchId: header.active_reversion_batch_id,
    profileId: header.profile_id,
    tag: header.tag,
    optGroup: header.opt_group,
    lever: header.lever,
    note: header.note,
    lifecycleStatus: lifecycleStatus(header),
    exportedAt: exportedAt.toISOString(),
    appliedAt: toDateOrNull(header.applied_at)?.toISOString() ?? null,
    artifactSha256: header.artifact_sha256,
    exportedProposals: header.exported_proposals,
    reversibleRows: header.reversible_rows,
    unsupportedRows: header.unsupported_rows,
    rows,
    readyRows,
    blockedRows,
    exportAllowed,
    reason,
  });
}

export interface ReversionExportResult {
  batchId: string;
  sourceBatchId: string;
  tag: string;
  rows: ApplyRow[];
  artifactSha256: string;
}

/**
 * Create a new immutable staged batch containing the exact inverse rows. The
 * source is re-read under a transaction lock, so a stale browser preview can
 * never authorize a conflicting export. Nothing is sent to Amazon.
 */
export async function createReversionExport(
  handle: TimeMachineQueryHandle,
  input: {
    orgId: string;
    batchId: string;
    tag: string;
    note: string;
    actorId?: string | null;
  },
): Promise<ReversionExportResult> {
  const note = input.note.trim();
  if (note.length === 0) throw new Error('A reversion export requires a note.');
  const tag = input.tag.trim();
  if (tag.length === 0) throw new Error('A reversion export requires a batch tag.');

  return await handle.sql.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`time-machine:${input.orgId}:${input.batchId}`}, 0))`;
    await sql`
      select id from public.apply_batches
       where org_id = ${input.orgId} and id = ${input.batchId}
       for update
    `;
    const initialPreview = await getReversionBatchPreview({ sql }, {
      orgId: input.orgId,
      batchId: input.batchId,
    });
    if (initialPreview === null) throw new Error('Not found');
    await lockCurrentApplyStates({ sql }, {
      orgId: input.orgId,
      profileId: initialPreview.profileId,
      targets: initialPreview.rows.map((row) => ({
        key: row.rowId,
        entityType: row.entityType,
        entityId: row.entityId,
        field: row.field,
      })),
    });
    const preview = await getReversionBatchPreview({ sql }, {
      orgId: input.orgId,
      batchId: input.batchId,
    });
    if (preview === null) throw new Error('Not found');
    if (!preview.exportAllowed) throw new Error(`Reversion blocked: ${preview.reason}`);

    const rows: ApplyRow[] = preview.rows.map((row) => ({
      entityType: row.entityType,
      entityId: row.entityId,
      field: row.field,
      old: row.exportedValue,
      new: row.inverseValue,
      ...(row.entityName === null ? {} : { name: row.entityName }),
    }));
    if (rows.length !== preview.readyRows || rows.length !== preview.reversibleRows) {
      throw new Error(
        `Reversion preview offered ${preview.reversibleRows} rows, prepared ${rows.length}`,
      );
    }
    const artifactSha256 = createHash('sha256')
      .update(serializeApplyRows(rows))
      .digest('hex');
    const [batch] = await sql<{ id: string }[]>`
      insert into public.apply_batches
        (org_id, profile_id, tag, opt_group, lever, note, status, source_batch_id,
         exported_at, artifact_sha256, exported_proposals, reversible_rows,
         unsupported_rows, created_by)
      values (${input.orgId}, ${preview.profileId}, ${tag}, ${preview.optGroup},
              'revert', ${note}, 'staged', ${preview.batchId}, now(), ${artifactSha256},
              ${rows.length}, ${rows.length}, 0, ${input.actorId ?? null}::uuid)
      returning id
    `;
    const batchId = batch?.id;
    if (batchId === undefined) throw new Error('Failed to create the reversion export.');

    const inserted = await sql<{ id: string }[]>`
      insert into public.apply_rows
        (batch_id, org_id, profile_id, entity_type, entity_id, entity_name,
         field, old_value, new_value, lever)
      select ${batchId}, ${input.orgId}, ${preview.profileId},
             offered.entity_type::public.apply_entity_type, offered.entity_id,
             offered.entity_name, offered.field, offered.old_value::jsonb,
             offered.new_value::jsonb, 'revert'
        from unnest(
               ${rows.map((row) => row.entityType)}::text[],
               ${rows.map((row) => row.entityId)}::text[],
               ${rows.map((row) => row.name ?? null)}::text[],
               ${rows.map((row) => row.field)}::text[],
               ${rows.map((row) => JSON.stringify(row.old))}::text[],
               ${rows.map((row) => JSON.stringify(row.new))}::text[]
             ) offered(entity_type, entity_id, entity_name, field, old_value, new_value)
      returning id
    `;
    if (inserted.length !== rows.length) {
      throw new Error(`Reversion offered ${rows.length} rows, wrote ${inserted.length}`);
    }

    await sql`
      insert into public.audit_log
        (org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
      values (${input.orgId}, 'user', ${input.actorId ?? null}, 'reversion.exported',
              'apply_batch', ${batchId},
              ${JSON.stringify({ sourceBatchId: preview.batchId, rows: rows.length, artifactSha256 })}::text::jsonb,
              'web')
    `;

    return { batchId, sourceBatchId: preview.batchId, tag, rows, artifactSha256 };
  });
}
