import type { DbHandle } from '@wizard-ads/db';

export interface StrategyCoverageRow {
  reportType: string;
  source: string;
  status: string;
  earliestReturnedDate: string | null;
  latestLoadedDate: string | null;
  latestSettledDate: string | null;
  missingDates: string[];
}

export interface StrategyBatchRow {
  id: string;
  tag: string;
  optGroup: string;
  lever: string;
  status: string;
  appliedOn: string | null;
  cooldownUntil: string | null;
  exportedAt: string;
  rows: number;
}

export interface StrategyObservationSummary {
  total: number;
  synchronized: number;
  settling: number;
  complete: number;
  supportedLift: number;
  hold: number;
  revert: number;
}

export interface StrategyKnowledgeSummary {
  rankObservations: number;
  latestRankDate: string | null;
  sqpRows: number;
  latestSqpWeek: string | null;
  sqpImpressionShares: number;
  sqpClickShares: number;
  sqpPurchaseShares: number;
  stockSignals: number;
  latestStockWeek: string | null;
}

export interface StrategyRunDiagnostics {
  runId: string;
  blockedOutOfStock: number;
  skippedInactive: number;
  skippedMissingStrategy: number;
  corridorsAvailable: number;
  corridorsMissing: number;
  preconditionNotes: number;
}

export interface StrategyEvidence {
  coverage: StrategyCoverageRow[];
  batches: StrategyBatchRow[];
  observations: StrategyObservationSummary;
  knowledge: StrategyKnowledgeSummary;
  diagnostics: StrategyRunDiagnostics | null;
}

interface CoverageWire {
  report_type: string;
  source: string;
  status: string;
  earliest_returned_date: string | null;
  latest_loaded_date: string | null;
  latest_settled_date: string | null;
  missing_dates: string[] | null;
}

interface BatchWire {
  id: string;
  tag: string;
  opt_group: string;
  lever: string;
  status: string;
  applied_on: string | null;
  cooldown_until: string | null;
  exported_at: Date | string;
  rows: number | string;
}

interface ObservationWire {
  total: number | string;
  synchronized: number | string;
  settling: number | string;
  complete: number | string;
  supported_lift: number | string;
  hold: number | string;
  revert: number | string;
}

interface KnowledgeWire {
  rank_observations: number | string;
  latest_rank_date: string | null;
  sqp_rows: number | string;
  latest_sqp_week: string | null;
  sqp_impression_shares: number | string;
  sqp_click_shares: number | string;
  sqp_purchase_shares: number | string;
  stock_signals: number | string;
  latest_stock_week: string | null;
}

interface DiagnosticsWire {
  run_id: string;
  blocked_out_of_stock: number | string | null;
  skipped_inactive: number | string | null;
  skipped_missing_strategy: number | string | null;
  corridors_available: number | string | null;
  corridors_missing: number | string | null;
  precondition_notes: number | string | null;
}

/** One tenant/profile-scoped evidence read for the read-only Strategy Overview. */
export async function readStrategyEvidence(
  handle: Pick<DbHandle, 'sql'>,
  input: { orgId: string; profileId: string },
): Promise<StrategyEvidence> {
  const [coverage, batches, observationRows, knowledgeRows, diagnosticRows] = await Promise.all([
    handle.sql<CoverageWire[]>`
      select report_type, source::text as source, status::text as status,
             earliest_returned_date::text, latest_loaded_date::text,
             latest_settled_date::text, missing_dates::text[]
        from public.report_coverage
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
       order by report_type, grain, source
    `,
    handle.sql<BatchWire[]>`
      select b.id, b.tag, b.opt_group, b.lever, b.status::text as status,
             b.applied_on::text,
             case when b.applied_on is null then null
                  else (b.applied_on + b.cooldown_days)::text end as cooldown_until,
             b.exported_at,
             count(r.id)::int as rows
        from public.apply_batches b
        left join public.apply_rows r
          on r.org_id = ${input.orgId}
         and r.profile_id = ${input.profileId}
         and r.batch_id = b.id
       where b.org_id = ${input.orgId} and b.profile_id = ${input.profileId}
       group by b.id
       order by b.exported_at desc, b.id desc
       limit 8
    `,
    handle.sql<ObservationWire[]>`
      select count(*)::int as total,
             count(*) filter (where synchronized_at is not null)::int as synchronized,
             count(*) filter (where evidence_state in ('awaiting_sync', 'observing'))::int as settling,
             count(*) filter (where evidence_state = 'complete')::int as complete,
             count(*) filter (where decision = 'continue')::int as supported_lift,
             count(*) filter (where decision = 'hold')::int as hold,
             count(*) filter (where decision = 'revert')::int as revert
        from public.recommendation_observations
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
    `,
    handle.sql<KnowledgeWire[]>`
      select
        (select count(*)::int from public.rank_observations r
          where r.org_id = ${input.orgId} and r.profile_id = ${input.profileId}) as rank_observations,
        (select max(r.observed_on)::text from public.rank_observations r
          where r.org_id = ${input.orgId} and r.profile_id = ${input.profileId}) as latest_rank_date,
        (select count(*)::int from public.fact_sqp_weekly s
          where s.org_id = ${input.orgId} and s.profile_id = ${input.profileId}) as sqp_rows,
        (select max(s.week_start)::text from public.fact_sqp_weekly s
          where s.org_id = ${input.orgId} and s.profile_id = ${input.profileId}) as latest_sqp_week,
        (select count(*)::int from public.fact_sqp_weekly s
          where s.org_id = ${input.orgId} and s.profile_id = ${input.profileId}
            and s.impression_share is not null) as sqp_impression_shares,
        (select count(*)::int from public.fact_sqp_weekly s
          where s.org_id = ${input.orgId} and s.profile_id = ${input.profileId}
            and s.click_share is not null) as sqp_click_shares,
        (select count(*)::int from public.fact_sqp_weekly s
          where s.org_id = ${input.orgId} and s.profile_id = ${input.profileId}
            and s.purchase_share is not null) as sqp_purchase_shares,
        (select count(*)::int from public.supa_flags f
          where f.org_id = ${input.orgId} and f.profile_id = ${input.profileId}
            and coalesce(f.out_of_stock_days, 0) > 0) as stock_signals,
        (select max(f.week_start)::text from public.supa_flags f
          where f.org_id = ${input.orgId} and f.profile_id = ${input.profileId}
            and coalesce(f.out_of_stock_days, 0) > 0) as latest_stock_week
    `,
    handle.sql<DiagnosticsWire[]>`
      select a.target_id as run_id,
             nullif(a.payload #>> '{narrative,diagnostics,blockedOutOfStock}', '')::int as blocked_out_of_stock,
             nullif(a.payload #>> '{narrative,diagnostics,skippedInactive}', '')::int as skipped_inactive,
             nullif(a.payload #>> '{narrative,diagnostics,skippedMissingStrategy}', '')::int as skipped_missing_strategy,
             nullif(a.payload #>> '{narrative,diagnostics,corridorsAvailable}', '')::int as corridors_available,
             nullif(a.payload #>> '{narrative,diagnostics,corridorsMissing}', '')::int as corridors_missing,
             nullif(a.payload #>> '{narrative,diagnostics,preconditionNotes}', '')::int as precondition_notes
        from public.audit_log a
        join public.recommendation_runs r
          on r.id::text = a.target_id
         and r.org_id = ${input.orgId}
         and r.profile_id = ${input.profileId}
       where a.org_id = ${input.orgId}
         and a.action = 'recommendation.run.succeeded'
         and a.target_type = 'recommendation_run'
       order by a.created_at desc, a.id desc
       limit 1
    `,
  ]);

  const observations = observationRows[0];
  const knowledge = knowledgeRows[0];
  const diagnostics = diagnosticRows[0];
  return {
    coverage: coverage.map((row) => ({
      reportType: row.report_type,
      source: row.source,
      status: row.status,
      earliestReturnedDate: row.earliest_returned_date,
      latestLoadedDate: row.latest_loaded_date,
      latestSettledDate: row.latest_settled_date,
      missingDates: row.missing_dates ?? [],
    })),
    batches: batches.map((row) => ({
      id: row.id,
      tag: row.tag,
      optGroup: row.opt_group,
      lever: row.lever,
      status: row.status,
      appliedOn: row.applied_on,
      cooldownUntil: row.cooldown_until,
      exportedAt: dateTime(row.exported_at),
      rows: count(row.rows),
    })),
    observations: {
      total: count(observations?.total),
      synchronized: count(observations?.synchronized),
      settling: count(observations?.settling),
      complete: count(observations?.complete),
      supportedLift: count(observations?.supported_lift),
      hold: count(observations?.hold),
      revert: count(observations?.revert),
    },
    knowledge: {
      rankObservations: count(knowledge?.rank_observations),
      latestRankDate: knowledge?.latest_rank_date ?? null,
      sqpRows: count(knowledge?.sqp_rows),
      latestSqpWeek: knowledge?.latest_sqp_week ?? null,
      sqpImpressionShares: count(knowledge?.sqp_impression_shares),
      sqpClickShares: count(knowledge?.sqp_click_shares),
      sqpPurchaseShares: count(knowledge?.sqp_purchase_shares),
      stockSignals: count(knowledge?.stock_signals),
      latestStockWeek: knowledge?.latest_stock_week ?? null,
    },
    diagnostics: diagnostics === undefined ? null : {
      runId: diagnostics.run_id,
      blockedOutOfStock: count(diagnostics.blocked_out_of_stock),
      skippedInactive: count(diagnostics.skipped_inactive),
      skippedMissingStrategy: count(diagnostics.skipped_missing_strategy),
      corridorsAvailable: count(diagnostics.corridors_available),
      corridorsMissing: count(diagnostics.corridors_missing),
      preconditionNotes: count(diagnostics.precondition_notes),
    },
  };
}

function count(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function dateTime(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
