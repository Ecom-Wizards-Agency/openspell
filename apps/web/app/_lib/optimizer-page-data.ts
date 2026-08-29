import {
  getRecommendationRun,
  listRecommendationRuns,
  listRecommendations,
  readOptimizationWorkspace,
} from '@wizard-ads/db';
import type { DbHandle } from '@wizard-ads/db';
import { RECOMMENDATIONS_ENGINE_VERSION } from '@wizard-ads/worker';
import { loadOptimizerCampaignFacts } from './optimizer-campaigns';
import { loadProfileDailyRows, loadReportLedger } from './dashboard-data';
import { precedingPeriod } from './periods';
import type { Period } from './periods';

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

  const runsPromise = listRecommendationRuns(handle, {
    orgId,
    profileId: profile.id,
    limit: RUN_HISTORY_LIMIT,
  });
  const workspacePromise = readOptimizationWorkspace(handle, {
    orgId,
    profileId: profile.id,
  });
  const accountRowsPromise = loadProfileDailyRows(
    handle,
    orgId,
    profile.id,
    profile.label,
    accountWindow,
  );
  const ledgerPromise = loadReportLedger(handle, orgId, profile.id);
  const campaignFactsPromise = loadOptimizerCampaignFacts(handle, {
    orgId,
    profileId: profile.id,
    period,
    comparison: precedingPeriod(period),
  });
  const requestedRunPromise = input.requestedRunId
    ? getRecommendationRun(handle, { orgId, runId: input.requestedRunId })
    : Promise.resolve(null);

  const allRuns = await runsPromise;
  const runs = allRuns.filter(
    (candidate) => candidate.engineVersion === RECOMMENDATIONS_ENGINE_VERSION,
  );
  const requestedRun = await requestedRunPromise;
  const selectedRequestedRun =
    requestedRun !== null &&
    requestedRun.profileId === profile.id &&
    requestedRun.engineVersion === RECOMMENDATIONS_ENGINE_VERSION
      ? requestedRun
      : null;
  const newestRunId = runs[0]?.id ?? null;
  const run =
    selectedRequestedRun ??
    (newestRunId === null
      ? null
      : await getRecommendationRun(handle, { orgId, runId: newestRunId }));
  const recordsPromise =
    run === null
      ? Promise.resolve([])
      : listRecommendations(handle, { orgId, runId: run.id });

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
