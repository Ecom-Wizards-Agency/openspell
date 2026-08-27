/**
 * `/optimizer` — the Campaign Optimizer, laid out like AdLabs' "Bid Optimizer"
 * (`tools/recon/04-optimizer.md`).
 *
 * This is the AdLabs-style *presentation* of the recommendations the engine
 * (WP-07) already produces. It reads them — it does not compute them — and lays
 * them out the way the recon says the incumbent does: a KPI tile row, a
 * daily/weekly/monthly trend chart, the reason-coverage clusters, and a preview
 * grouped into optimization groups, each proposal carrying the change-reasons /
 * limit-reasons split as two separate pill columns. The three-act QA-and-apply
 * gesture stays where it is tested and trusted, on `/recommendations`; this page
 * links through to it.
 *
 * Entry goes through `gate()`, the same guard the dashboard and grid use, and
 * every read below is scoped by the org the gate resolved.
 */
import type { ReactNode } from 'react';
import {
  getRecommendationRun,
  listRecommendationRuns,
  listRecommendations,
} from '@wizard-ads/db';
import { RECOMMENDATIONS_ENGINE_VERSION } from '@wizard-ads/worker';
import { assessFreshness } from '@wizard-ads/ui';
import { gate } from '../../src/auth/guard';
import { can } from '../../src/auth/roles';
import { gateMessage } from '../../src/ui/gate-message';
import { Button, Card, EmptyState, PageHeader } from '../../src/ui/primitives';
import { KpiTile, FreshnessBar } from '../../src/ui/dashboard';
import { TrendChart } from '../../src/ui/viz';
import type { TrendPoint } from '../../src/ui/viz';
import { page } from '../../src/ui/tokens';
import { toProposalView } from '../../src/recommendations/view';
import { reasonCoverage } from '../../src/recommendations/view';
import {
  kpiTiles,
  optimizationGroups,
  settingsSummary,
  totalsOf,
} from '../../src/optimizer/view';
import { loadProfileDailyRows, loadReportLedger } from '../_lib/dashboard-data';
import { periodFromParams, settledComparisonWindows, todayIso } from '../_lib/periods';
import { listProfiles, requestedProfileId, selectProfile } from '../_lib/profiles';
import { OptimizerGroupTable, ReasonCoverageRow, SettingsChip } from './optimizer-view';
import { runOptimizerNow } from './actions';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ profile?: string; from?: string; to?: string; run?: string }>;
}

export default async function OptimizerPage({ searchParams }: PageProps): Promise<ReactNode> {
  const entry = await gate();
  if (entry.state !== 'ok') {
    return (
      <main style={page}>
        <PageHeader title="Campaign Optimizer" />
        <p className="wa-page-sub">{gateMessage(entry.state)}</p>
      </main>
    );
  }
  const { handle, context } = entry;
  const orgId = context.active?.orgId ?? '';
  const mayRunOptimizer = can(context.active?.role, 'editTargets');

  const params = await searchParams;
  const profileId = await requestedProfileId(params.profile);
  const today = todayIso();
  const period = periodFromParams(params, today);
  const settled = settledComparisonWindows(period, today);

  const profiles = await listProfiles(handle, orgId);
  const profile = selectProfile(profiles, profileId);
  if (profile === null) {
    return (
      <main style={page}>
        <PageHeader title="Campaign Optimizer" />
        <EmptyState
          title="No profiles yet"
          body="This organisation has no advertising profiles. Connect Amazon Ads and the roster lands on the next OAuth callback; the optimizer fills itself from the first recommendation run."
          action={
            <a className="wa-btn wa-btn--primary wa-btn--sm" href="/settings/connections">
              Connect Amazon Ads
            </a>
          }
        />
      </main>
    );
  }

  const runs = (await listRecommendationRuns(handle, { orgId, profileId: profile.id, limit: 100 }))
    .filter((candidate) => candidate.engineVersion === RECOMMENDATIONS_ENGINE_VERSION);
  const runId = runs.find((candidate) => candidate.id === params.run)?.id ?? runs[0]?.id ?? null;
  const run = runId === null ? null : await getRecommendationRun(handle, { orgId, runId });
  const records =
    run === null ? [] : await listRecommendations(handle, { orgId, runId: run.id });
  const proposals = records.map((record) =>
    toProposalView(record, { strategySnapshot: run?.strategySnapshot ?? null }),
  );

  const [periodRows, comparisonRows, ledger] = await Promise.all([
    loadProfileDailyRows(handle, orgId, profile.id, profile.label, period),
    settled.comparison === null
      ? Promise.resolve([])
      : loadProfileDailyRows(handle, orgId, profile.id, profile.label, settled.comparison),
    loadReportLedger(handle, orgId, profile.id),
  ]);

  const currentWindow = settled.current;
  const settledRows =
    currentWindow === null
      ? []
      : periodRows.filter(
          (row) => row.date >= currentWindow.start && row.date <= currentWindow.end,
        );
  const tiles = kpiTiles(totalsOf(settledRows), totalsOf(comparisonRows));
  const groups = optimizationGroups(proposals);
  const coverage = reasonCoverage(proposals);
  const summary = settingsSummary(proposals);
  const freshness = assessFreshness(ledger, { now: new Date() });
  const context2 = { currencyCode: profile.currencyCode };

  const spend: TrendPoint[] = periodRows.map((row) => ({ date: row.date, value: row.spend }));
  const sales: TrendPoint[] = periodRows.map((row) => ({ date: row.date, value: row.sales }));
  const settlingWindow = {
    label: 'Settling · 14-day attribution window',
    start: settled.settling.start,
    end: settled.settling.end,
  };

  return (
    <main style={page}>
      <PageHeader
        title="Campaign Optimizer"
        subtitle={`${profile.label} · ${period.start} to ${period.end} · ${settled.current === null || settled.comparison === null ? 'no settled KPI comparison yet' : `settled KPI window ${settled.current.start} to ${settled.current.end} compared against ${settled.comparison.start} to ${settled.comparison.end}`} · all figures in ${profile.currencyCode}`}
        actions={
          <div className="wa-row" style={{ gap: '0.5rem' }}>
            {mayRunOptimizer ? (
              <form action={runOptimizerNow}>
                <input type="hidden" name="profileId" value={profile.id} />
                <Button
                  type="submit"
                  size="sm"
                  data-testid="optimizer-run-now"
                  title="Queue a seven-day preview using the last complete profile-local day"
                >
                  Run now
                </Button>
              </form>
            ) : null}
            <SettingsChip summary={summary} />
            <a
              className="wa-btn wa-btn--primary wa-btn--sm"
              href={`/recommendations?profile=${profile.id}${run === null ? '' : `&run=${run.id}`}`}
            >
              Open review →
            </a>
          </div>
        }
      />

      <div className="wa-stack">
        <FreshnessBar assessment={freshness} />

        {run === null ? (
          <EmptyState
            title="No optimizer run yet"
            body="The weekly engine writes a recommendation run for this profile; until it does there is nothing to preview here. That is not the same as nothing to do — the grid and dashboard read the same facts today."
            action={
              <a className="wa-btn wa-btn--sm" href={`/grid?profile=${profile.id}`}>
                Open the grid
              </a>
            }
          />
        ) : run.status !== 'succeeded' ? (
          <EmptyState
            title={
              run.status === 'queued'
                ? 'Optimizer run queued'
                : run.status === 'running'
                  ? 'Optimizer run in progress'
                  : 'Optimizer run failed'
            }
            body={
              run.status === 'queued'
                ? 'The preview is in the worker queue. It will use the last complete seven-day window in this profile’s timezone.'
                : run.status === 'running'
                  ? 'The worker is assembling facts, doctrine, pacing, and bid corridors now. Refresh shortly to see the preview.'
                  : 'The worker recorded this run as failed. Queue a new preview after checking sync freshness and strategy settings.'
            }
          />
        ) : (
          <>
            <section aria-label="Headline metrics" className="wa-kpis wa-kpis--dense">
              {tiles.map((tile) => (
                <KpiTile
                  key={tile.metric}
                  label={`${tile.label} (settled)`}
                  value={tile.value}
                  scale={tile.scale}
                  better={tile.better}
                  context={context2}
                  deltas={[{ caption: 'vs prior period', pct: tile.deltaPct, reference: tile.prev }]}
                />
              ))}
            </section>

            <Card>
              <TrendChart
                title="Spend and sales"
                ariaLabel="Daily spend and sales for the optimizer window"
                scale="money"
                aggregatable
                currencyCode={profile.currencyCode}
                settlingWindow={settlingWindow}
                caption={`Additive metrics, so weekly and monthly roll up by sum. In ${profile.currencyCode}.`}
                series={[
                  { label: 'Spend', points: spend },
                  { label: 'Sales', points: sales },
                ]}
              />
            </Card>

            <ReasonCoverageRow coverage={coverage} total={proposals.length} />

            {groups.length === 0 ? (
              <EmptyState
                title="This run proposed nothing"
                body="The engine found no bid, budget or targeting change worth proposing for this profile in this window. On a healthy account that is the expected result more weeks than not."
              />
            ) : (
              <section aria-label="Optimization groups" className="wa-stack">
                <h2 className="wa-section-title" style={{ margin: 0 }}>
                  Optimization groups · {groups.length}
                </h2>
                {groups.map((group) => (
                  <OptimizerGroupTable
                    key={group.key}
                    group={group}
                    bidHistoryContext={{
                      profileId: profile.id,
                      window: period,
                      currencyCode: profile.currencyCode,
                    }}
                  />
                ))}
              </section>
            )}

            <p className="wa-page-sub">
              This is a read-only preview. To QA rows, edit values, and stage an export, open the{' '}
              <a href={`/recommendations?profile=${profile.id}&run=${run.id}`}>full review →</a>
            </p>
          </>
        )}
      </div>
    </main>
  );
}
