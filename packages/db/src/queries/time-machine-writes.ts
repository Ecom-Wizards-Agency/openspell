import { createHash } from 'node:crypto';
import { SpWriteAccounting, SpWriteAction, SpWriteAuthorizationReceipt, SpWriteExecutionSnapshot,
  serializeSpWriteActionFingerprint } from '@wizard-ads/shared/sp-writes';
import { TimeMachineInstant, TimeMachineNativeWrite } from '@wizard-ads/shared/time-machine-writes';
import type { QuerySql } from '../client.js';
import type { TimelineEntry, TimelineFilter } from './time-machine.js';

/** Reused by native projection and exact legacy suppression in the same read snapshot. */
export function nativeTimelineRoots(sql: QuerySql, scope: { orgId: string; profileId: string }) {
  return sql`
    select child.org_id, child.profile_id, child.execution_id, child.plan_id, child.approval_id, child.generation,
      p.direction, p.source_execution_id, p.source_plan_id, p.fingerprint,
      receipt.approved_at, receipt.artifact as receipt_artifact, preview.artifact as preview_artifact,
      exists(select 1 from public.sp_write_execution_requests request
        where request.org_id = child.org_id and request.profile_id = child.profile_id
          and request.execution_id = child.execution_id and request.plan_id = child.plan_id
          and request.approval_id = child.approval_id and request.generation = child.generation) as queued
    from public.sp_write_cycle_plans child
    join public.sp_write_plans p on p.org_id = child.org_id and p.profile_id = child.profile_id and p.plan_id = child.plan_id
    join public.sp_write_authorization_receipts receipt on receipt.org_id = child.org_id and receipt.profile_id = child.profile_id
      and receipt.execution_id = child.execution_id and receipt.approval_id = child.approval_id and receipt.generation = child.generation
    join public.sp_write_preview_evidence preview on preview.org_id = child.org_id and preview.profile_id = child.profile_id
      and preview.plan_id = case when p.direction = 'forward' then p.plan_id else p.source_plan_id end
    where child.org_id = ${scope.orgId}::uuid and child.profile_id = ${scope.profileId}::uuid`;
}

type AccountingRow = Record<string, unknown>;
function snapshot(row: AccountingRow): SpWriteExecutionSnapshot {
  const accounting = Object.fromEntries(Object.keys(SpWriteAccounting.shape).map((key) => [
    key, row[key.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase())],
  ]));
  return SpWriteExecutionSnapshot.parse({ accounting, status: row['status'] });
}

interface NativeRow {
  id: string; execution_id: string; plan_id: string; action_id: string; amazon_entity_id: string;
  direction: 'forward' | 'inverse'; source_execution_id: string | null; source_plan_id: string | null;
  entry_at: string; receipt_artifact: unknown; action_artifact: unknown; queued: boolean;
  accounting: AccountingRow; mirror_counts: unknown; observation: unknown; mirror_receipt: unknown;
  phase: string; refusal: string | null; entity_name: string | null;
  inverse_summaries: Array<{ executionId: string; planId: string; accounting: AccountingRow; mirror: unknown }>;
  batch: { id: string; tag: string; optGroup: string; lever: string; note: string; status: string;
    sourceBatchId: string | null; exportedAt: string } | null;
}

function toNativeEntry(row: NativeRow): TimelineEntry {
  const action = SpWriteAction.parse(row.action_artifact);
  if (action.routeKey !== 'sp.v3.keywords.update' || action.changes.bid === undefined || action.changes.state !== undefined
    || action.actionId !== row.action_id || action.entity.keywordId !== row.amazon_entity_id
    || createHash('sha256').update(serializeSpWriteActionFingerprint(action)).digest('hex') !== action.fingerprint) {
    throw new Error('native timeline action evidence mismatch');
  }
  const receipt = SpWriteAuthorizationReceipt.parse(row.receipt_artifact);
  const inverseSummaries = row.inverse_summaries.map((inverse) => ({
    operation: { executionId: inverse.executionId, planId: inverse.planId }, snapshot: snapshot(inverse.accounting), mirror: inverse.mirror,
  }));
  const write = TimeMachineNativeWrite.parse({
    execution: { operation: { executionId: row.execution_id, planId: row.plan_id },
      admission: row.queued ? 'queued' : 'approved_pending_start', receipt, snapshot: snapshot(row.accounting), mirror: row.mirror_counts,
      original: row.source_execution_id === null ? null : { executionId: row.source_execution_id, planId: row.source_plan_id },
      inverses: inverseSummaries.map((inverse) => inverse.operation) },
    actor: { kind: 'operator', userId: receipt.approvedBy }, actionId: row.action_id, direction: row.direction,
    change: { key: 'keyword.bid', ...action.changes.bid }, provenance: action.sources[0], phase: row.phase, refusal: row.refusal,
    observation: row.observation, mirrorReceipt: row.mirror_receipt, inverseSummaries,
  });
  const observedAtExact = TimeMachineInstant.parse(row.entry_at);
  return { id: row.id, source: 'apply', entityType: 'keyword', amazonId: row.amazon_entity_id, entityName: row.entity_name,
    field: 'bid', oldValue: write.change.expected.amount, newValue: write.change.requested.amount,
    observedAt: new Date(observedAtExact), observedAtExact, write,
    batch: row.batch === null ? null : { ...row.batch, exportedAt: new Date(row.batch.exportedAt) } };
}

/** One bounded native candidate window, inside the caller's read-only transaction. */
export async function listNativeTimeline(sql: QuerySql, filter: TimelineFilter): Promise<TimelineEntry[]> {
  if (filter.source === 'sync' || (filter.field && filter.field !== 'bid')
    || (filter.entityTypes?.length && !filter.entityTypes.includes('keyword'))) return [];
  const rows = await sql<NativeRow[]>`
    with roots as materialized (${nativeTimelineRoots(sql, filter)}), selected as materialized (
      select r.*, a.action_id, a.amazon_entity_id, a.artifact as action_artifact,
        'write:' || r.plan_id::text || ':' || a.action_id::text || ':keyword.bid' as id
      from roots r join public.sp_write_plan_actions a
        on a.org_id = r.org_id and a.profile_id = r.profile_id and a.plan_id = r.plan_id
      where a.route_key = 'sp.v3.keywords.update' and a.artifact -> 'changes' ? 'bid'
        and (${filter.from ?? null}::timestamptz is null or r.approved_at >= ${filter.from ?? null}::timestamptz)
        and (${filter.to ?? null}::timestamptz is null or r.approved_at <= ${filter.to ?? null}::timestamptz)
        and (${filter.operation?.executionId ?? null}::uuid is null or (r.execution_id = ${filter.operation?.executionId ?? null}::uuid
          and r.plan_id = ${filter.operation?.planId ?? null}::uuid))
        and (${filter.before?.observedAt ?? null}::timestamptz is null or
          (r.approved_at, ('write:' || r.plan_id::text || ':' || a.action_id::text || ':keyword.bid') collate "C")
          < (${filter.before?.observedAt ?? null}::timestamptz, ${filter.before?.id ?? null}::text collate "C"))
      order by r.approved_at desc,
        ('write:' || r.plan_id::text || ':' || a.action_id::text || ':keyword.bid') collate "C" desc limit ${filter.limit ?? 500}
    ), operations as materialized (
      select r.*, to_jsonb(accounting) as accounting, mirrors.counts as mirror_counts
      from roots r join public.sp_write_execution_accounting accounting
        on accounting.org_id = r.org_id and accounting.profile_id = r.profile_id
          and accounting.execution_id = r.execution_id and accounting.plan_id = r.plan_id
      cross join lateral (
        select jsonb_build_object('observations', count(o.observation_id)::int,
          'pending', count(o.observation_id) filter (where m.observation_id is null)::int,
          'promoted', count(*) filter (where m.outcome = 'promoted')::int,
          'alreadyCurrent', count(*) filter (where m.outcome = 'already_current')::int,
          'superseded', count(*) filter (where m.outcome = 'superseded')::int,
          'missing', count(*) filter (where m.outcome = 'missing')::int) as counts
        from public.sp_write_observations o left join public.sp_write_mirror_observations m
          on m.org_id = o.org_id and m.profile_id = o.profile_id and m.observation_id = o.observation_id
            and m.execution_id = o.execution_id and m.plan_id = o.plan_id and m.observation_fingerprint = o.fingerprint
        where o.org_id = r.org_id and o.profile_id = r.profile_id and o.execution_id = r.execution_id and o.plan_id = r.plan_id
      ) mirrors
      where exists(select 1 from selected s where s.execution_id = r.execution_id
        and (s.plan_id = r.plan_id or (s.direction = 'forward' and s.plan_id = r.source_plan_id)))
    )
    select s.id, s.execution_id::text, s.plan_id::text, s.action_id::text, s.amazon_entity_id, s.direction,
      s.source_execution_id::text, s.source_plan_id::text, s.receipt_artifact, s.action_artifact, s.queued,
      to_char(s.approved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as entry_at,
      op.accounting, op.mirror_counts, observation.artifact as observation, mirror.artifact as mirror_receipt,
      case when observation.observation_id is not null then observation.outcome::text
        when resolution.resolution_kind = 'refusal' then 'refused'
        when result.outcome = 'authoritative_rejected' then 'rejected'
        when result.outcome = 'accepted' then 'awaiting_observation'
        when result.outcome = 'ambiguous' then 'ambiguous'
        when resolution.resolution_kind = 'intent' then 'awaiting_result' else 'queued' end as phase,
      disposition.reason::text as refusal, coalesce(source_row.entity_name, keyword.name) as entity_name,
      coalesce((select jsonb_agg(jsonb_build_object('executionId', inverse.execution_id, 'planId', inverse.plan_id,
        'accounting', inverse.accounting, 'mirror', inverse.mirror_counts) order by inverse.approved_at, inverse.plan_id)
        from operations inverse where inverse.org_id = s.org_id and inverse.profile_id = s.profile_id
          and inverse.source_execution_id = s.execution_id and inverse.source_plan_id = s.plan_id), '[]'::jsonb) as inverse_summaries,
      case when s.direction = 'forward' then jsonb_build_object('id', s.preview_artifact #>> '{provenance,applyBatchId}',
        'tag', s.preview_artifact #>> '{provenance,tag}', 'optGroup', s.preview_artifact #>> '{provenance,optGroup}',
        'lever', s.preview_artifact #>> '{provenance,lever}', 'note', s.preview_artifact #>> '{provenance,note}',
        'status', coalesce(batch.status::text, 'staged'), 'sourceBatchId', batch.source_batch_id,
        'exportedAt', s.preview_artifact #>> '{provenance,exportedAt}') else null end as batch
    from selected s join operations op on op.org_id = s.org_id and op.profile_id = s.profile_id
      and op.execution_id = s.execution_id and op.plan_id = s.plan_id
    left join public.sp_write_action_resolutions resolution on resolution.org_id = s.org_id and resolution.profile_id = s.profile_id
      and resolution.execution_id = s.execution_id and resolution.plan_id = s.plan_id and resolution.action_id = s.action_id
    left join public.sp_write_predispatch_dispositions disposition on disposition.org_id = s.org_id and disposition.profile_id = s.profile_id
      and disposition.disposition_id = resolution.disposition_id
    left join public.sp_write_provider_results result_head on result_head.org_id = s.org_id and result_head.profile_id = s.profile_id
      and result_head.intent_id = resolution.intent_id
    left join public.sp_write_provider_result_positions result on result.org_id = s.org_id and result.profile_id = s.profile_id
      and result.result_id = result_head.result_id and result.intent_id = resolution.intent_id and result.action_id = s.action_id
    left join public.sp_write_observations observation on observation.org_id = s.org_id and observation.profile_id = s.profile_id
      and observation.execution_id = s.execution_id and observation.plan_id = s.plan_id and observation.action_id = s.action_id
    left join public.sp_write_mirror_observations mirror on mirror.org_id = s.org_id and mirror.profile_id = s.profile_id
      and mirror.observation_id = observation.observation_id and mirror.observation_fingerprint = observation.fingerprint
    left join public.apply_batches batch on batch.org_id = s.org_id and batch.profile_id = s.profile_id
      and batch.id = (s.preview_artifact #>> '{provenance,applyBatchId}')::uuid
    left join public.apply_rows source_row on source_row.org_id = s.org_id and source_row.profile_id = s.profile_id
      and source_row.batch_id = batch.id and source_row.id = (s.action_artifact #>> '{sources,0,applyRowId}')::uuid
    left join public.keywords keyword on keyword.org_id = s.org_id and keyword.profile_id = s.profile_id and keyword.amazon_id = s.amazon_entity_id
    order by s.approved_at desc, s.id collate "C" desc`;
  return rows.map(toNativeEntry);
}
