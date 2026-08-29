import { evaluateRecommendationEvidence } from '@wizard-ads/core';
import type { DbHandle, QuerySql } from '@wizard-ads/db';
import {
  OptimizationRunContext,
  TenantStrategy,
  type IsoDate,
  type OptimizationGroup,
  type RecommendationEvidencePolicy,
} from '@wizard-ads/shared';

const DAY_MS = 86_400_000;
export const RECOMMENDATION_OBSERVATION_LIMIT = 100;

interface CandidateRow {
  recommendation_id: string;
  org_id: string;
  profile_id: string;
  group_id: string | null;
  group_role: string | null;
  group_snapshot: unknown;
  run_id: string;
  due_at: Date | string | null;
  window_start: string | null;
  window_end: string | null;
  lookback_days: number;
  strategy_snapshot: unknown;
  entity_type: string;
  entity_id: string;
  campaign_id: string | null;
  ad_group_id: string | null;
  field: string;
  old_value: unknown;
  new_value: unknown;
  exported_at: Date | string;
  synchronized_value: unknown;
  synchronized_at: Date | string | null;
  prior_recommendation_id: string | null;
  apply_row_count: number;
}

export interface RecommendationObservationReconcileCounts {
  scanned: number;
  evaluated: number;
  inserted: number;
  unchanged: number;
  refused: number;
  refusalReasons: Record<string, number>;
}

export interface RecommendationObserverLogger {
  info(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

/**
 * Reconcile a bounded set of exported target-bid recommendations.
 *
 * Each candidate is serialized by tenant/profile. The latest identical state
 * is a checked no-op, so a retry records new history only when synchronized or
 * settled evidence actually changes.
 */
export async function reconcileRecommendationObservations(
  handle: DbHandle,
  options: { limit?: number; now?: Date } = {},
): Promise<RecommendationObservationReconcileCounts> {
  const limit = Math.min(Math.max(options.limit ?? RECOMMENDATION_OBSERVATION_LIMIT, 1), 500);
  const now = options.now ?? new Date();
  const candidates = await readCandidates(handle, limit);
  const counts: RecommendationObservationReconcileCounts = {
    scanned: candidates.length,
    evaluated: 0,
    inserted: 0,
    unchanged: 0,
    refused: 0,
    refusalReasons: {},
  };

  for (const candidate of candidates) {
    const outcome = await handle.sql.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`${candidate.org_id}:${candidate.profile_id}`}, 77))`;
      const fresh = await readCandidate(sql, candidate.org_id, candidate.recommendation_id);
      if (fresh === null) return { kind: 'refused', reason: 'candidate_changed' } as const;
      const prepared = prepareCandidate(fresh);
      if (!prepared.ok) return { kind: 'refused', reason: prepared.reason } as const;

      const settledThrough = await readSettledThrough(sql, fresh);
      const matchedPairs = prepared.synchronizedAt === null
        ? []
        : await readMatchedPairs(sql, fresh, prepared.observationWindowStart, prepared.observationWindowEnd);
      const evaluation = evaluateRecommendationEvidence({
        context: prepared.context,
        seed: {
          recommendationId: fresh.recommendation_id,
          priorRecommendationId: fresh.prior_recommendation_id,
          groupId: prepared.context.groupId,
          expectedValue: prepared.expectedValue,
          synchronizedValue: prepared.synchronizedValue,
          synchronizedAt: prepared.synchronizedAt,
          observationWindowStart: prepared.observationWindowStart,
          observationWindowEnd: prepared.observationWindowEnd,
        },
        preChangeValue: prepared.preChangeValue,
        settledThrough,
        matchedPairs,
        policy: prepared.policy,
      });
      const revertSuffix = evaluation.revertToValue === null
        ? ''
        : `; exact_revert_value=${formatNumber(evaluation.revertToValue)}`;
      const evidenceNote = `${evaluation.observation.evidenceNote}; incremental_volume=purchases_7d${revertSuffix}`;

      const [latest] = await sql<ObservationComparable[]>`
        select expected_value, synchronized_value, synchronized_at,
               observation_window_start::text as observation_window_start,
               observation_window_end::text as observation_window_end,
               evidence_state::text as evidence_state, decision::text as decision,
               pre_incremental_volume, post_incremental_volume, evidence_note
          from public.recommendation_observations
         where org_id = ${fresh.org_id}
           and profile_id = ${fresh.profile_id}
           and recommendation_id = ${fresh.recommendation_id}
         order by observed_at desc, id desc
         limit 1
         for update
      `;
      const next = {
        expectedValue: evaluation.observation.expectedValue,
        synchronizedValue: evaluation.observation.synchronizedValue,
        synchronizedAt: evaluation.observation.synchronizedAt,
        observationWindowStart: evaluation.observation.observationWindowStart,
        observationWindowEnd: evaluation.observation.observationWindowEnd,
        evidenceState: evaluation.observation.evidenceState,
        decision: evaluation.observation.decision,
        preIncrementalVolume: evaluation.observation.preIncrementalVolume,
        postIncrementalVolume: evaluation.observation.postIncrementalVolume,
        evidenceNote,
      };
      if (latest !== undefined && sameObservation(latest, next)) return { kind: 'unchanged' } as const;

      const inserted = await sql<{ id: string }[]>`
        insert into public.recommendation_observations
          (org_id, profile_id, recommendation_id, prior_recommendation_id, group_id,
           expected_value, synchronized_value, synchronized_at,
           observation_window_start, observation_window_end, evidence_state, decision,
           pre_incremental_volume, post_incremental_volume, evidence_note, observed_at)
        values (${fresh.org_id}, ${fresh.profile_id}, ${fresh.recommendation_id},
                ${fresh.prior_recommendation_id}, ${prepared.context.groupId},
                ${next.expectedValue}, ${next.synchronizedValue}, ${next.synchronizedAt},
                ${next.observationWindowStart}::date, ${next.observationWindowEnd}::date,
                ${next.evidenceState}::public.recommendation_evidence_state,
                ${next.decision}::public.recommendation_evidence_decision,
                ${next.preIncrementalVolume}, ${next.postIncrementalVolume},
                ${next.evidenceNote}, ${now.toISOString()}::timestamptz)
        returning id
      `;
      if (inserted.length !== 1) throw new Error(`Offered 1 recommendation observation, wrote ${inserted.length}`);
      return { kind: 'inserted' } as const;
    });

    if (outcome.kind === 'refused') {
      counts.refused += 1;
      counts.refusalReasons[outcome.reason] = (counts.refusalReasons[outcome.reason] ?? 0) + 1;
    } else {
      counts.evaluated += 1;
      counts[outcome.kind] += 1;
    }
  }

  if (counts.evaluated + counts.refused !== counts.scanned) {
    throw new Error(`Scanned ${counts.scanned} recommendations, accounted ${counts.evaluated + counts.refused}`);
  }
  if (counts.inserted + counts.unchanged !== counts.evaluated) {
    throw new Error(`Evaluated ${counts.evaluated} recommendations, persisted or retained ${counts.inserted + counts.unchanged}`);
  }
  return counts;
}

export class RecommendationObservationPass {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly handle: DbHandle,
    private readonly logger: RecommendationObserverLogger,
    private readonly intervalMs = 5 * 60_000,
    private readonly reconcile: typeof reconcileRecommendationObservations = reconcileRecommendationObservations,
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<RecommendationObservationReconcileCounts | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const counts = await this.reconcile(this.handle);
      if (counts.scanned > 0) this.logger.info('Recommendation observations reconciled', { ...counts });
      return counts;
    } catch (error) {
      this.logger.error('Recommendation observation reconciliation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      this.running = false;
    }
  }
}

interface PreparedCandidate {
  ok: true;
  context: ReturnType<typeof OptimizationRunContext.parse>;
  policy: RecommendationEvidencePolicy;
  expectedValue: number;
  preChangeValue: number;
  synchronizedValue: number | null;
  synchronizedAt: string | null;
  observationWindowStart: IsoDate;
  observationWindowEnd: IsoDate;
}

function prepareCandidate(candidate: CandidateRow): PreparedCandidate | { ok: false; reason: string } {
  const strategy = TenantStrategy.safeParse(candidate.strategy_snapshot);
  if (!strategy.success || strategy.data.recommendation_evidence === undefined) {
    return { ok: false, reason: 'missing_evidence_policy' };
  }
  if (
    candidate.group_id === null || candidate.group_role === null ||
    candidate.window_start === null || candidate.window_end === null
  ) return { ok: false, reason: 'missing_group_context' };
  if (candidate.apply_row_count !== 1) return { ok: false, reason: 'ambiguous_apply_rows' };
  const group = candidate.group_snapshot as OptimizationGroup;
  const context = OptimizationRunContext.safeParse({
    runId: candidate.run_id,
    profileId: candidate.profile_id,
    groupId: candidate.group_id,
    groupRole: candidate.group_role,
    groupSnapshot: group,
    dueAt: toDate(candidate.due_at ?? candidate.exported_at).toISOString(),
    windowStart: candidate.window_start,
    windowEnd: candidate.window_end,
  });
  if (!context.success) return { ok: false, reason: 'invalid_group_context' };
  const expectedValue = numericJson(candidate.new_value);
  const preChangeValue = numericJson(candidate.old_value);
  if (expectedValue === null || preChangeValue === null) return { ok: false, reason: 'non_numeric_export' };
  if (!['keyword', 'product_target'].includes(candidate.entity_type)) return { ok: false, reason: 'unsupported_entity_grain' };
  if (candidate.campaign_id === null || candidate.ad_group_id === null) return { ok: false, reason: 'missing_fact_grain' };

  const synchronizedAt = candidate.synchronized_at === null ? null : toDate(candidate.synchronized_at).toISOString();
  const start = (synchronizedAt ?? toDate(candidate.exported_at).toISOString()).slice(0, 10) as IsoDate;
  const end = addDays(start, candidate.lookback_days - 1);
  const synchronizedValue = candidate.synchronized_at === null ? null : numericJson(candidate.synchronized_value);
  return {
    ok: true,
    context: context.data,
    policy: strategy.data.recommendation_evidence,
    expectedValue,
    preChangeValue,
    synchronizedValue,
    synchronizedAt,
    observationWindowStart: start,
    observationWindowEnd: end,
  };
}

async function readCandidates(handle: DbHandle, limit: number): Promise<CandidateRow[]> {
  return await queryCandidates(handle.sql, null, null, limit);
}

async function readCandidate(
  sql: QuerySql,
  orgId: string,
  recommendationId: string,
): Promise<CandidateRow | null> {
  const rows = await queryCandidates(sql, orgId, recommendationId, 1);
  return rows[0] ?? null;
}

async function queryCandidates(
  sql: QuerySql,
  orgId: string | null,
  recommendationId: string | null,
  limit: number,
): Promise<CandidateRow[]> {
  return await sql<CandidateRow[]>`
    select recommendation.id as recommendation_id,
           recommendation.org_id, recommendation.profile_id,
           run.group_id, run.group_role::text as group_role, run.group_snapshot,
           run.id as run_id, run.due_at, run.window_start::text as window_start,
           run.window_end::text as window_end, run.lookback_days, run.strategy_snapshot,
           recommendation.entity_type::text as entity_type, recommendation.entity_id,
           recommendation.campaign_id, recommendation.ad_group_id, recommendation.field,
           apply_row.old_value, apply_row.new_value, batch.exported_at,
           linked.new_value as synchronized_value, linked.observed_at as synchronized_at,
           prior.id as prior_recommendation_id, apply_row.apply_row_count
      from public.recommendations recommendation
      join public.recommendation_runs run
        on run.org_id = recommendation.org_id
       and run.profile_id = recommendation.profile_id
       and run.id = recommendation.run_id
      join lateral (
        select candidate.*, count(*) over ()::int as apply_row_count
          from public.apply_rows candidate
         where candidate.org_id = recommendation.org_id
           and candidate.profile_id = recommendation.profile_id
           and candidate.recommendation_id = recommendation.id
         order by candidate.created_at, candidate.id
         limit 1
      ) apply_row on true
      join public.apply_batches batch
        on batch.org_id = apply_row.org_id
       and batch.profile_id = apply_row.profile_id
       and batch.id = apply_row.batch_id
      left join lateral (
        select change.new_value, change.observed_at
          from public.entity_changes change
         where change.org_id = apply_row.org_id
           and change.profile_id = apply_row.profile_id
           and change.apply_row_id = apply_row.id
           and change.source = 'sync'
         order by change.observed_at, change.id
         limit 1
      ) linked on true
      left join lateral (
        select previous.id
          from public.recommendations previous
          join public.recommendation_runs previous_run
            on previous_run.org_id = previous.org_id
           and previous_run.profile_id = previous.profile_id
           and previous_run.id = previous.run_id
         where previous.org_id = recommendation.org_id
           and previous.profile_id = recommendation.profile_id
           and previous.id <> recommendation.id
           and previous.status = 'exported'
           and previous.entity_type = recommendation.entity_type
           and previous.entity_id = recommendation.entity_id
           and previous.field = recommendation.field
           and previous_run.group_id = run.group_id
           and previous.created_at < recommendation.created_at
         order by previous.created_at desc, previous.id desc
         limit 1
      ) prior on true
      left join lateral (
        select observation.evidence_state::text as evidence_state,
               observation.observation_window_end,
               observation.observed_at
          from public.recommendation_observations observation
         where observation.org_id = recommendation.org_id
           and observation.profile_id = recommendation.profile_id
           and observation.recommendation_id = recommendation.id
         order by observation.observed_at desc, observation.id desc
         limit 1
      ) latest_observation on true
     where recommendation.status = 'exported'
       and batch.source_batch_id is null
       and batch.status in ('staged', 'applied')
       and (${orgId}::uuid is null or recommendation.org_id = ${orgId}::uuid)
       and (${recommendationId}::uuid is null or recommendation.id = ${recommendationId}::uuid)
       and (
         latest_observation.observed_at is null
         or (latest_observation.evidence_state = 'awaiting_sync' and linked.observed_at is not null)
         or (
           latest_observation.evidence_state = 'observing'
           and exists (
             select 1 from public.report_coverage coverage
              where coverage.org_id = recommendation.org_id
                and coverage.profile_id = recommendation.profile_id
                and coverage.report_type = 'spTargeting'
                and coverage.grain = 'sp_target'
                and coverage.source in ('amazon_reporting_v3', 'amazon_unified_reporting')
                and coverage.status = 'complete'
                and coverage.latest_settled_date >= latest_observation.observation_window_end
           )
         )
         or exists (
           select 1 from public.fact_sp_target_daily revised
            where revised.org_id = recommendation.org_id
              and revised.profile_id = recommendation.profile_id
              and revised.campaign_id = recommendation.campaign_id
              and revised.ad_group_id = recommendation.ad_group_id
              and revised.target_id = recommendation.entity_id
              and revised.loaded_at > latest_observation.observed_at
         )
       )
     order by (run.strategy_snapshot ? 'recommendation_evidence') desc,
              latest_observation.observed_at nulls first, batch.exported_at, recommendation.id
     limit ${limit}
  `;
}

interface ObservationComparable {
  expected_value: number | string;
  synchronized_value: number | string | null;
  synchronized_at: Date | string | null;
  observation_window_start: string;
  observation_window_end: string;
  evidence_state: string;
  decision: string;
  pre_incremental_volume: number | string | null;
  post_incremental_volume: number | string | null;
  evidence_note: string;
}

function sameObservation(row: ObservationComparable, next: {
  expectedValue: number;
  synchronizedValue: number | null;
  synchronizedAt: string | null;
  observationWindowStart: string;
  observationWindowEnd: string;
  evidenceState: string;
  decision: string;
  preIncrementalVolume: number | null;
  postIncrementalVolume: number | null;
  evidenceNote: string;
}): boolean {
  return Number(row.expected_value) === next.expectedValue &&
    nullableNumber(row.synchronized_value) === next.synchronizedValue &&
    nullableIso(row.synchronized_at) === next.synchronizedAt &&
    row.observation_window_start === next.observationWindowStart &&
    row.observation_window_end === next.observationWindowEnd &&
    row.evidence_state === next.evidenceState && row.decision === next.decision &&
    nullableNumber(row.pre_incremental_volume) === next.preIncrementalVolume &&
    nullableNumber(row.post_incremental_volume) === next.postIncrementalVolume &&
    row.evidence_note === next.evidenceNote;
}

async function readSettledThrough(sql: QuerySql, candidate: CandidateRow): Promise<IsoDate | null> {
  const [row] = await sql<{ settled_through: string | null }[]>`
    select max(latest_settled_date)::text as settled_through
      from public.report_coverage
     where org_id = ${candidate.org_id} and profile_id = ${candidate.profile_id}
       and report_type = 'spTargeting' and grain = 'sp_target'
       and source in ('amazon_reporting_v3', 'amazon_unified_reporting')
       and status = 'complete'
  `;
  return row?.settled_through as IsoDate | null ?? null;
}

async function readMatchedPairs(
  sql: QuerySql,
  candidate: CandidateRow,
  postStart: IsoDate,
  postEnd: IsoDate,
): Promise<{ matchKey: string; preIncrementalVolume: number; postIncrementalVolume: number }[]> {
  const days = dateDistance(postStart, postEnd) + 1;
  const preStart = addDays(postStart, -days);
  const rows = await sql<{ day_offset: number; pre_volume: number | string; post_volume: number | string }[]>`
    with offsets as (select generate_series(0, ${days - 1})::int as day_offset),
    pre as (
      select (f.date - ${preStart}::date)::int as day_offset, sum(f.purchases_7d)::numeric as volume
        from public.fact_sp_target_daily f
       where f.org_id = ${candidate.org_id} and f.profile_id = ${candidate.profile_id}
         and f.campaign_id = ${candidate.campaign_id} and f.ad_group_id = ${candidate.ad_group_id}
         and f.target_id = ${candidate.entity_id}
         and f.date between ${preStart}::date and ${addDays(postStart, -1)}::date
       group by f.date
    ), post as (
      select (f.date - ${postStart}::date)::int as day_offset, sum(f.purchases_7d)::numeric as volume
        from public.fact_sp_target_daily f
       where f.org_id = ${candidate.org_id} and f.profile_id = ${candidate.profile_id}
         and f.campaign_id = ${candidate.campaign_id} and f.ad_group_id = ${candidate.ad_group_id}
         and f.target_id = ${candidate.entity_id}
         and f.date between ${postStart}::date and ${postEnd}::date
       group by f.date
    )
    select offsets.day_offset, pre.volume as pre_volume, post.volume as post_volume
      from offsets join pre using (day_offset) join post using (day_offset)
     order by offsets.day_offset
  `;
  return rows.map((row) => ({
    matchKey: `day-offset:${row.day_offset}`,
    preIncrementalVolume: Number(row.pre_volume),
    postIncrementalVolume: Number(row.post_volume),
  }));
}

function numericJson(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function addDays(date: string, days: number): IsoDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10) as IsoDate;
}

function dateDistance(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS);
}

function toDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Recommendation observation received an invalid timestamp');
  return date;
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : toDate(value).toISOString();
}

function nullableNumber(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}
