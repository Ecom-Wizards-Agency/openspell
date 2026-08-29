import {
  getRecommendationRun,
  listRecommendationRuns,
  listRecommendations,
  readOptimizationWorkspace,
} from '@wizard-ads/db';
import type { DbHandle, RecommendationRunDetail } from '@wizard-ads/db';
import { RECOMMENDATIONS_ENGINE_VERSION } from '@wizard-ads/worker';
import { loadOptimizerCampaignFacts } from './optimizer-campaigns';
import { loadProfileDailyRows, loadReportLedger } from './dashboard-data';
import { precedingPeriod } from './periods';
import type { Period } from './periods';
import { withServerTiming } from './server-timing';

const RUN_HISTORY_LIMIT = 20;

export interface OptimizerPageDataInput {
  handle: DbHandle;
  orgId: string;
  profile: { id: string; label: string };
  period: Period;
  settledComparison: Period | null;
  requestedRunId?: string;
}

/**
 * Load the optimizer's independent evidence in one concurrent wave.
 *
 * Recommendation detail still depends on choosing a run, but daily facts,
 * freshness, campaign facts, and group settings do not. Starting them before
 * the run lookup removes the old two-phase waterfall. Current and comparison
 * profile facts share one database scan and are split only after the read.
 */
export async function loadOptimizerPageData(input: OptimizerPageDataInput) {
  const { handle, orgId, profile, period, settledComparison } = input;
  const accountWindow = {
    start:
      settledComparison !== null && settledComparison.start < period.start
        ? settledComparison.start
        : period.start,
    end: period.end,
  };

  const runsPromise = withServerTiming(
    'optimizer.runs',
    () => listRecommendationRuns(handle, {
      orgId,
      profileId: profile.id,
      limit: RUN_HISTORY_LIMIT,
    }),
    (runs) => runs.length,
  );
  const workspacePromise = withServerTiming(
    'optimizer.workspace',
    () => readOptimizationWorkspace(handle, {
      orgId,
      profileId: profile.id,
    }),
    (workspace) => workspace.groups.length + workspace.campaigns.length,
  );
  const accountRowsPromise = withServerTiming(
    'optimizer.account_rows',
    () => loadProfileDailyRows(
      handle,
      orgId,
      profile.id,
      profile.label,
      accountWindow,
    ),
    (rows) => rows.length,
  );
  const ledgerPromise = withServerTiming(
    'optimizer.report_ledger',
    () => loadReportLedger(handle, orgId, profile.id),
    (rows) => rows.length,
  );
  const campaignFactsPromise = loadOptimizerCampaignFacts(handle, {
    orgId,
    profileId: profile.id,
    period,
    comparison: precedingPeriod(period),
  });
  const requestedRunPromise = input.requestedRunId
    ? withServerTiming(
        'optimizer.requested_run',
        () => getRecommendationRun(handle, { orgId, runId: input.requestedRunId as string }),
        (run) => (run === null ? 0 : 1),
      )
    : Promise.resolve(null);
  // The common newest-run route can select its immutable strategy snapshot in
  // the same wave as the run summaries. It no longer waits for the list and
  // then re-reads the complete run before recommendation detail can start.
  const latestRunSnapshotPromise = input.requestedRunId
    ? Promise.resolve(null)
    : loadLatestRunSnapshot(handle, { orgId, profileId: profile.id });

  const [allRuns, requestedRun, latestRunSnapshot] = await Promise.all([
    runsPromise,
    requestedRunPromise,
    latestRunSnapshotPromise,
  ]);
  const runs = allRuns.filter(
    (candidate) => candidate.engineVersion === RECOMMENDATIONS_ENGINE_VERSION,
  );
  const selectedRequestedRun =
    requestedRun !== null &&
    requestedRun.profileId === profile.id &&
    requestedRun.engineVersion === RECOMMENDATIONS_ENGINE_VERSION
      ? requestedRun
      : null;
  const newestRun = runs[0] ?? null;
  const run =
    selectedRequestedRun ??
    (newestRun === null
      ? null
      : latestRunSnapshot?.id === newestRun.id
        ? { ...newestRun, strategySnapshot: latestRunSnapshot.strategySnapshot }
        : await withServerTiming(
            'optimizer.latest_run_detail',
            () => getRecommendationRun(handle, { orgId, runId: newestRun.id }),
            (detail) => (detail === null ? 0 : 1),
          ));
  const recordsPromise =
    run === null
      ? Promise.resolve([])
      : withServerTiming(
          'optimizer.recommendations',
          () => listRecommendations(handle, { orgId, runId: run.id }),
          (records) => records.length,
        );

  const [optimizationWorkspace, accountRows, ledger, campaignFacts, records] =
    await Promise.all([
      workspacePromise,
      accountRowsPromise,
      ledgerPromise,
      campaignFactsPromise,
      recordsPromise,
    ]);
  const periodRows = accountRows.filter(
    (row) => row.date >= period.start && row.date <= period.end,
  );
  const comparisonRows =
    settledComparison === null
      ? []
      : accountRows.filter(
          (row) => row.date >= settledComparison.start && row.date <= settledComparison.end,
        );

  return {
    runs,
    run,
    records,
    optimizationWorkspace,
    periodRows,
    comparisonRows,
    ledger,
    campaignFacts,
  };
}

interface LatestRunSnapshotRow {
  id: string;
  strategy_snapshot: RecommendationRunDetail['strategySnapshot'];
}

async function loadLatestRunSnapshot(
  handle: Pick<DbHandle, 'sql'>,
  input: { orgId: string; profileId: string },
): Promise<{ id: string; strategySnapshot: RecommendationRunDetail['strategySnapshot'] } | null> {
  return withServerTiming('optimizer.latest_run_snapshot', async () => {
    const rows = await handle.sql<LatestRunSnapshotRow[]>`
      select id, strategy_snapshot
        from public.recommendation_runs
       where org_id = ${input.orgId}
         and profile_id = ${input.profileId}
         and engine_version = ${RECOMMENDATIONS_ENGINE_VERSION}
       order by coalesce(finished_at, created_at) desc
       limit 1
    `;
    const row = rows[0];
    return row === undefined
      ? null
      : { id: row.id, strategySnapshot: row.strategy_snapshot };
  }, (snapshot) => (snapshot === null ? 0 : 1));
}
