/**
 * `/optimizer` — the Campaign Optimizer, laid out like AdLabs' "Bid Optimizer"
 * (`tools/recon/04-optimizer.md`).
 *
 * This is the AdLabs-style *presentation* of the recommendations the engine
 * (WP-07) already produces. It reads them — it does not compute them — and lays
 * them out the way the recon says the incumbent does: a KPI tile row, a
 * daily/weekly/monthly trend chart, the reason-coverage clusters, and a preview
 * grouped into optimization groups, each proposal carrying the change-reasons /
 * limit-reasons split as two separate pill columns. Campaign buckets are named
 * honestly; they do not stand in for the persisted optimization-group model.
 * The three-act QA-and-apply
 * gesture stays where it is tested and trusted, on `/recommendations`; this page
 * links through to it.
 *
 * Entry goes through `gate()`, the same guard the dashboard and grid use, and
 * every read below is scoped by the org the gate resolved.
 */
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { assessFreshness } from '@wizard-ads/ui';
import { gate } from '../../src/auth/guard';
import { can } from '../../src/auth/roles';
import { canonicalProfilePath } from '../../src/data/active-profile';
import { gateMessage } from '../../src/ui/gate-message';
import { Button, EmptyState, PageHeader } from '../../src/ui/primitives';
import { FreshnessBar } from '../../src/ui/dashboard';
import { OperatorContext } from '../../src/ui/operator-context';
import { Cockpit } from '../../src/ui/cockpit';
import { page } from '../../src/ui/tokens';
import { toProposalView } from '../../src/recommendations/view';
import { reasonCoverage } from '../../src/recommendations/view';
import {
  kpiTiles,
  campaignReviewGroups,
  settingsSummary,
  totalsOf,
} from '../../src/optimizer/view';
import { buildOptimizerCampaignRows } from '../../src/optimizer/campaigns';
import { loadOptimizerPageData } from '../_lib/optimizer-page-data';
import { periodFromParams, settledComparisonWindows, todayIso } from '../_lib/periods';
import { listProfiles, requestedProfileId, selectProfile } from '../_lib/profiles';
import { OptimizerGroupTable, ReasonCoverageRow, SettingsChip } from './optimizer-view';
import { CampaignWorkspace } from './campaign-workspace';
import { runOptimizerNow } from './actions';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{
    profile?: string;
    from?: string;
    to?: string;
    run?: string;
    preset?: string;
  }>;
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
            <a className="wa-btn wa-btn--sm" href="/settings/connections">
              Connect Amazon Ads
            </a>
          }
        />
      </main>
    );
  }
  const canonical = canonicalProfilePath('/optimizer', { ...params }, profile.id);
  if (canonical !== null) redirect(canonical);

  const {
    runs,
    run,
    records,
    optimizationWorkspace,
    periodRows,
    comparisonRows,
    ledger,
    campaignFacts,
  } = await loadOptimizerPageData({
    handle,
    orgId,
    profile,
    period,
    settledComparison: settled.comparison,
    ...(params.run === undefined ? {} : { requestedRunId: params.run }),
  });
  const proposals = records.map((record) =>
    toProposalView(record, { strategySnapshot: run?.strategySnapshot ?? null }),
  );

  // Same clamp the dashboard applies: never claim settled days that have no
  // synced facts behind them.
  const coverageStart = periodRows[0]?.date ?? null;
  const currentWindow =
    settled.current !== null && coverageStart !== null && coverageStart > settled.current.start
      ? { start: coverageStart, end: settled.current.end }
      : settled.current;
  const settledRows =
    currentWindow === null
      ? []
      : periodRows.filter(
          (row) => row.date >= currentWindow.start && row.date <= currentWindow.end,
        );
  const tiles = kpiTiles(
    settledRows.length === 0 ? null : totalsOf(settledRows),
    comparisonRows.length === 0 ? null : totalsOf(comparisonRows),
  );
  const campaignGroups = campaignReviewGroups(proposals);
  const coverage = reasonCoverage(proposals);
  const summary = settingsSummary(proposals);
  const campaignRows = buildOptimizerCampaignRows(
    campaignFacts,
    optimizationWorkspace.groups,
    proposals,
  );
  const freshness = assessFreshness(ledger, { now: new Date() });

  const cockpitDays = periodRows.map((row) => ({
    date: row.date,
    impressions: row.impressions,
    clicks: row.clicks,
    spend: row.spend,
    sales: row.sales,
    orders: row.orders,
  }));

  return (
    <main style={page}>
      <PageHeader
        title="Campaign Optimizer"
        subtitle="Campaign performance, group context, and read-only recommendation previews"
        actions={
          <div className="wa-row" style={{ gap: '0.5rem' }}>
            {mayRunOptimizer && optimizationWorkspace.groups.length === 0 ? (
              <form action={runOptimizerNow}>
                <input type="hidden" name="profileId" value={profile.id} />
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  data-testid="optimizer-run-now"
                  title="Queue a seven-day preview using the last complete profile-local day"
                >
                  Run now
                </Button>
              </form>
            ) : null}
            {mayRunOptimizer && optimizationWorkspace.groups.length > 0 ? (
              <a className="wa-btn wa-btn--primary wa-btn--sm" href={`/optimizer/groups?profile=${profile.id}`}>
                Run group previews
              </a>
            ) : null}
            <SettingsChip summary={summary} group={run?.groupSnapshot} />
            <a
              className="wa-btn wa-btn--sm"
              href={`/recommendations?profile=${profile.id}${run === null ? '' : `&run=${run.id}`}`}
            >
              Open review →
            </a>
          </div>
        }
      />

      <div className="wa-stack">
        <OperatorContext
          account={profile.label}
          marketplace={profile.countryCode}
          currencyCode={profile.currencyCode}
          timezone={profile.timezone}
          path="/optimizer"
          period={period}
          today={today}
          selectedPresetId={params.preset}
          preserved={{
            profile: profile.id,
            ...(run === null ? {} : { run: run.id }),
            preset: params.preset,
          }}
        />

        <FreshnessBar assessment={freshness} />

        {runs.length > 1 ? (
          <details className="wa-run-history">
            <summary>
              <span aria-hidden="true" className="wa-run-history__icon">↺</span>
              <span className="wa-run-history__label">Run history</span>
              <span className="wa-run-history__meta">
                {run?.groupSnapshot?.name ?? 'Legacy profile run'}
              </span>
              <span className="wa-run-history__status" data-status={run?.status ?? 'none'}>
                {formatRunStatus(run?.status ?? 'none')}
              </span>
              <span className="wa-run-history__count">{runs.length} runs</span>
            </summary>
            <nav className="wa-row" aria-label="Optimizer runs" style={{ marginTop: '0.625rem' }}>
              {runs.slice(0, 20).map((candidate) => (
                <a
                  className={`wa-pill ${candidate.id === run?.id ? 'wa-pill--reason' : ''}`}
                  href={`/optimizer?profile=${profile.id}&run=${candidate.id}&from=${period.start}&to=${period.end}`}
                  key={candidate.id}
                  aria-current={candidate.id === run?.id ? 'page' : undefined}
                >
                  {candidate.groupSnapshot?.name ?? 'Legacy profile'} · {candidate.createdAt.toISOString().slice(0, 10)} · {candidate.status === 'succeeded' ? `${candidate.proposalsCount} proposals` : candidate.status}
                </a>
              ))}
            </nav>
          </details>
        ) : null}

        <Cockpit
          days={cockpitDays}
          tiles={tiles}
          currencyCode={profile.currencyCode}
          settlingStart={settled.settling.start}
          coverageStart={coverageStart}
          preferenceKey={profile.id}
        />

        <CampaignWorkspace
          key={`${profile.id}:${period.start}:${period.end}`}
          rows={campaignRows}
          currencyCode={profile.currencyCode}
          profileId={profile.id}
          period={period}
          run={run === null ? null : { id: run.id, status: run.status }}
        />

        {run === null ? (
          <p className="wa-page-sub">No recommendation preview has run yet. Campaigns remain visible above; queue a preview when the group settings are ready.</p>
        ) : run.status !== 'succeeded' ? (
          <p className="wa-page-sub" role="status">
            {run.status === 'queued'
              ? 'Recommendation preview queued. It will use the last complete profile-local evidence window.'
              : run.status === 'running'
                ? 'Recommendation preview is assembling facts, strategy, pacing, and bid corridors.'
                : 'The recommendation preview failed. Campaign performance above remains available; check Sync status before retrying.'}
          </p>
        ) : (
          <>
            <ReasonCoverageRow coverage={coverage} total={proposals.length} />

            {campaignGroups.length === 0 ? null : (
              <section aria-label="Campaign drill-down" className="wa-stack">
                <h2 className="wa-section-title" style={{ margin: 0 }}>
                  {run.groupSnapshot ? `${run.groupSnapshot.name} campaign drill-down` : 'Legacy campaign drill-down'} · {campaignGroups.length}
                </h2>
                {campaignGroups.map((group) => (
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

function formatRunStatus(status: string): string {
  return status.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
}
