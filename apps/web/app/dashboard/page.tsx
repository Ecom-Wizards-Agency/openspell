/**
 * `/dashboard` — the per-profile dashboard.
 *
 * A server component that reads the database and hands plain data to
 * presentational components. No Amazon call happens here (they all live in the
 * worker) and no doctrine value is hardcoded here (they arrive from the profile
 * row).
 *
 * The page is arranged around one idea: **say how much to trust these numbers
 * before showing them.** So the freshness bar and the crosscheck chip sit above
 * the tiles, not below, and they answer two different questions on purpose — the
 * bar says whether our numbers are current, the chip says whether they agree
 * with the incumbent's. A profile can be fresh and wrong, or stale and verified,
 * and an operator needs to see which.
 *
 * WP-21 replaced WP-06's `packages/ui` dashboard widgets with the `src/ui`
 * equivalents so the whole screen follows the theme; the data path is unchanged.
 *
 * Entry goes through `gate()`, the same guard `/settings` and `/sync-status`
 * use: anonymous visitors are sent to `/login`, and every read below is scoped
 * by the org the gate resolved.
 */
import { Suspense } from 'react';
import { analyzeAccount, classifyCampaignCategory, computePacing, evaluate, pacingFlag } from '@wizard-ads/core';
import type { DailyRow, Flag } from '@wizard-ads/core';
import { readOptimizationWorkspace } from '@wizard-ads/db';
import type { DbHandle } from '@wizard-ads/db';
import { loadCrosscheckPanel } from '@wizard-ads/crosscheck-cli';
import { assessFreshness } from '@wizard-ads/ui';
import { CrosscheckChip } from '../crosscheck/panel';
import { gate } from '../../src/auth/guard';
import { gateMessage } from '../../src/ui/gate-message';
import { Badge, Card, EmptyState, PageHeader } from '../../src/ui/primitives';
import { FlagsCard, FreshnessBar, PacingCard } from '../../src/ui/dashboard';
import { Cockpit } from '../../src/ui/cockpit';
import { kpiTiles, totalsOf } from '../../src/optimizer/view';
import type { FlagView, PacingView } from '../../src/ui/dashboard';
import { page } from '../../src/ui/tokens';
import { OperatorContext } from '../../src/ui/operator-context';
import { readStrategyEvidence } from '../../src/strategy/overview';
import { loadCampaignDailyRows, loadProfileDailyRows, loadReportLedger } from '../_lib/dashboard-data';
import { withDatabase } from '../_lib/db';
import { addDays, periodFromParams, settledComparisonWindows, todayIso } from '../_lib/periods';
import { listProfiles, requestedProfileId, selectProfile } from '../_lib/profiles';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ profile?: string; from?: string; to?: string }>;
}

export default async function DashboardPage({ searchParams }: PageProps) {
  const entry = await gate();
  if (entry.state !== 'ok') {
    return (
      <main style={page}>
        <PageHeader title="Dashboard" />
        <p className="wa-page-sub">{gateMessage(entry.state)}</p>
      </main>
    );
  }
  const orgId = entry.context.active?.orgId ?? '';

  const params = await searchParams;
  const profileId = await requestedProfileId(params.profile);
  const today = todayIso();
  const period = periodFromParams(params, today);
  const settled = settledComparisonWindows(period, today);
  const analysisWindow = { start: addDays(period.start, -8), end: period.end };

  const data = await withDatabase(async (handle) => {
    const profiles = await listProfiles(handle, orgId);
    const profile = selectProfile(profiles, profileId);
    if (profile === null) return { profiles, profile: null };

    const accountWindow = {
      start:
        settled.comparison !== null && settled.comparison.start < analysisWindow.start
          ? settled.comparison.start
          : analysisWindow.start,
      end: period.end,
    };
    const [ledger, accountRows, campaignRows, crosscheck] = await Promise.all([
      loadReportLedger(handle, orgId, profile.id),
      loadProfileDailyRows(handle, orgId, profile.id, profile.label, accountWindow),
      loadCampaignDailyRows(handle, orgId, profile.id, profile.label, analysisWindow),
      loadCrosscheckPanel(handle, { profileId: profile.id }).catch(() => null),
    ]);

    return { profiles, profile, ledger, accountRows, campaignRows, crosscheck };
  });

  if (data === null) {
    return (
      <main style={page}>
        <PageHeader title="Dashboard" />
        <p className="wa-page-sub">{gateMessage('no-database')}</p>
      </main>
    );
  }

  if (data.profile === null) {
    return (
      <main style={page}>
        <PageHeader title="Dashboard" />
        <EmptyState
          title="No profiles yet"
          body="This organisation has no advertising profiles. Connect Amazon Ads and the roster lands on the next OAuth callback; the dashboard fills itself from the first sync."
          action={
            <a className="wa-btn wa-btn--sm" href="/settings/connections">
              Connect Amazon Ads
            </a>
          }
        />
      </main>
    );
  }

  const {
    profile,
    accountRows = [],
    campaignRows = [],
    ledger = [],
  } = data;
  const context = { currencyCode: profile.currencyCode };

  const categorised: DailyRow[] = campaignRows.map((row) => ({
    ...row,
    category: classifyCampaignCategory(row.campaignName),
  }));

  const analysisRows = accountRows.filter(
    (row) => row.date >= analysisWindow.start && row.date <= analysisWindow.end,
  );
  const reportDate =
    analysisRows.length > 0
      ? (analysisRows[analysisRows.length - 1] as DailyRow).date
      : period.end;
  const analysis = analyzeAccount(profile.label, reportDate, analysisRows, categorised);
  const flags = evaluate(analysis, null, profile.goalLens);

  const pacing = computePacing(
    analysisRows.map((row) => ({ date: row.date, spend: row.spend })),
    reportDate,
    profile.monthlyBudget,
  );
  const pacingAlert = pacingFlag(pacing, null);
  const activeFlags: Flag[] = pacingAlert === null ? flags.active : [pacingAlert, ...flags.active];

  const freshness = assessFreshness(ledger, { now: new Date() });
  const inPeriod = accountRows.filter((row) => row.date >= period.start && row.date <= period.end);
  // A young profile's facts may begin after the settled window opens. Claiming
  // a sixteen-day window while summing four days of rows overstates confidence,
  // so the window is clamped to actual coverage and the subtitle says so.
  const coverageStart = accountRows[0]?.date ?? null;
  const currentWindow =
    settled.current !== null && coverageStart !== null && coverageStart > settled.current.start
      ? { start: coverageStart, end: settled.current.end }
      : settled.current;
  const coverageClamped =
    settled.current !== null && currentWindow !== null && currentWindow.start !== settled.current.start;
  const comparisonWindow = settled.comparison;
  const settledRows =
    currentWindow === null
      ? []
      : accountRows.filter((row) => row.date >= currentWindow.start && row.date <= currentWindow.end);
  const comparisonRows =
    comparisonWindow === null
      ? []
      : accountRows.filter(
          (row) => row.date >= comparisonWindow.start && row.date <= comparisonWindow.end,
        );
  const settlingWindow = {
    label: 'Settling · 14-day attribution window',
    start: settled.settling.start,
    end: settled.settling.end,
  };

  const cockpitDays = inPeriod.map((row) => ({
    date: row.date,
    impressions: row.impressions,
    clicks: row.clicks,
    spend: row.spend,
    sales: row.sales,
    orders: row.orders,
  }));
  const tiles = kpiTiles(
    settledRows.length === 0 ? null : totalsOf(settledRows),
    comparisonRows.length === 0 ? null : totalsOf(comparisonRows),
  );

  const byCampaign = new Map<string, { name: string; category: string; spend: number; sales: number; clicks: number; orders: number }>();
  for (const row of categorised) {
    const name = row.campaignName ?? '(unknown campaign)';
    const acc = byCampaign.get(name) ?? {
      name,
      category: String(row.category ?? classifyCampaignCategory(name)),
      spend: 0,
      sales: 0,
      clicks: 0,
      orders: 0,
    };
    acc.spend += row.spend;
    acc.sales += row.sales;
    acc.clicks += row.clicks;
    acc.orders += row.orders;
    byCampaign.set(name, acc);
  }
  const campaignSummary = [...byCampaign.values()].sort((a, b) => b.spend - a.spend).slice(0, 12);


  return (
    <main style={page}>
      <PageHeader
        title="Dashboard"
        subtitle="Performance, operating constraints, and the next decisions that need attention"
      />

      <div className="wa-stack">
        <OperatorContext
          account={profile.label}
          marketplace={profile.countryCode}
          currencyCode={profile.currencyCode}
          timezone={profile.timezone}
          path="/dashboard"
          period={period}
          today={today}
          preserved={{ profile: profile.id }}
        />
        <details className="wa-dashboard-context">
          <summary>Comparison and attribution coverage</summary>
          <p>
            {currentWindow === null || settled.comparison === null
              ? 'No settled KPI comparison is available yet.'
              : `Settled KPIs use ${currentWindow.start} to ${currentWindow.end}${coverageClamped ? ' from the first synced day' : ''}, compared with ${settled.comparison.start} to ${settled.comparison.end}.`}
            {' '}Recent conversion days remain in the chart and are marked as settling.
          </p>
        </details>

        <FreshnessBar assessment={freshness}>
          {data.crosscheck ? <CrosscheckChip chip={data.crosscheck.chip} /> : null}
        </FreshnessBar>

        <Cockpit
          days={cockpitDays}
          tiles={tiles}
          currencyCode={profile.currencyCode}
          settlingStart={settlingWindow.start}
          coverageStart={accountRows[0]?.date ?? null}
          preferenceKey={profile.id}
        />

        <section className="wa-grid-2">
          <PacingCard pacing={pacing as PacingView | null} context={context} />
          <Suspense fallback={<OperatingStatusLoading />}>
            <OperatingStatus
              handle={entry.handle}
              orgId={orgId}
              profileId={profile.id}
            />
          </Suspense>
        </section>

        <FlagsCard active={activeFlags as FlagView[]} suppressed={flags.suppressed as FlagView[]} />

        <CampaignTable rows={campaignSummary} currencyCode={profile.currencyCode} profileId={profile.id} period={period} />

      </div>
    </main>
  );
}

async function OperatingStatus({
  handle,
  orgId,
  profileId,
}: {
  handle: DbHandle;
  orgId: string;
  profileId: string;
}) {
  const [workspace, evidence] = await Promise.all([
    readOptimizationWorkspace(handle, { orgId, profileId }),
    readStrategyEvidence(handle, { orgId, profileId }),
  ]);
  const openBatch = evidence.batches.find((batch) => batch.status === 'staged') ?? null;
  const stockNeedsReview = evidence.knowledge.stockSignals > 0;
  const observationNeedsReview = evidence.observations.revert > 0 || evidence.observations.settling > 0;

  return (
    <div id="operating-status">
      <Card
        title="Operating status"
        subtitle="Account constraints and evidence behind the next optimizer decision."
        actions={<a className="wa-btn wa-btn--ghost wa-btn--sm" href={`/optimizer/groups?profile=${profileId}`}>Manage groups</a>}
      >
        <div className="wa-operating-status">
          <OperatingSignal
            label="Stock gate"
            value={stockNeedsReview ? 'Review' : 'Unknown'}
            detail={stockNeedsReview
              ? `${evidence.knowledge.stockSignals} stock signal${evidence.knowledge.stockSignals === 1 ? '' : 's'} need review.`
              : 'No validated inventory signal is available.'}
            tone={stockNeedsReview ? 'warn' : 'neutral'}
          />
          <OperatingSignal
            label="Optimization groups"
            value={`${workspace.assignedCampaigns}/${workspace.campaigns.length} assigned`}
            detail={workspace.unassignedCampaigns === 0
              ? `${workspace.groups.length} group${workspace.groups.length === 1 ? '' : 's'} cover the campaign roster.`
              : `${workspace.unassignedCampaigns} campaign${workspace.unassignedCampaigns === 1 ? '' : 's'} still need a group.`}
            tone={workspace.unassignedCampaigns === 0 && workspace.campaigns.length > 0 ? 'good' : 'warn'}
          />
          <OperatingSignal
            label="Open export batch"
            value={openBatch === null ? 'Clear' : `${openBatch.rows} staged`}
            detail={openBatch === null
              ? 'No exported change set is waiting for operator handling.'
              : `${openBatch.optGroup} · ${openBatch.lever} · Amazon unchanged`}
            tone={openBatch === null ? 'good' : 'warn'}
          />
          <OperatingSignal
            label="Evidence loop"
            value={evidence.observations.revert > 0
              ? `${evidence.observations.revert} revert`
              : evidence.observations.settling > 0
                ? `${evidence.observations.settling} observing`
                : `${evidence.observations.complete} complete`}
            detail={`${evidence.observations.synchronized} synchronized · ${evidence.observations.hold} hold`}
            tone={evidence.observations.revert > 0 ? 'bad' : observationNeedsReview ? 'warn' : 'neutral'}
          />
        </div>
        <div className="wa-operating-status__actions">
          <a href={`/optimizer?profile=${profileId}`}>Open Campaign Optimizer →</a>
          <a href={`/recommendations?profile=${profileId}`}>Review recommendations →</a>
        </div>
      </Card>
    </div>
  );
}

function OperatingStatusLoading() {
  return (
    <Card title="Operating status" subtitle="Loading account constraints and decision evidence…">
      <div className="wa-operating-status" aria-busy="true">
        {['Stock gate', 'Optimization groups', 'Open export batch', 'Evidence loop'].map((label) => (
          <div className="wa-operating-signal" key={label}><span>{label}</span><strong>—</strong></div>
        ))}
      </div>
    </Card>
  );
}

function OperatingSignal({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
}) {
  return (
    <div className="wa-operating-signal">
      <span>{label}</span>
      <strong>{value}</strong>
      <Badge tone={tone}>{detail}</Badge>
    </div>
  );
}



function CampaignTable({
  rows,
  currencyCode,
  profileId,
  period,
}: {
  rows: { name: string; category: string; spend: number; sales: number; clicks: number; orders: number }[];
  currencyCode: string;
  profileId: string;
  period: { start: string; end: string };
}) {
  if (rows.length === 0) return null;
  const money = (v: number) =>
    v.toLocaleString('en-US', { style: 'currency', currency: currencyCode, maximumFractionDigits: v >= 100 ? 0 : 2 });
  const totalSpend = rows.reduce((a, r) => a + r.spend, 0) || 1;
  return (
    <Card>
      <div className="wa-card-head">
        <h2 className="wa-card-title">Top campaigns by spend</h2>
        <a className="wa-btn wa-btn--ghost wa-btn--sm" href={`/grid?profile=${profileId}&from=${period.start}&to=${period.end}`}>
          Open the grid →
        </a>
      </div>
      <table className="wa-table wa-table--dense">
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Campaign</th>
            <th style={{ textAlign: 'left' }}>Category</th>
            <th>Spend</th>
            <th>Share</th>
            <th>Ad Sales</th>
            <th>ACOS</th>
            <th>Clicks</th>
            <th>Orders</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td style={{ textAlign: 'left' }}>
                <span className="wa-campaign-name">
                  {row.name.split(' | ').map((seg, i) => (
                    <span key={i} className={i === 0 ? 'wa-campaign-seg wa-campaign-seg--head' : 'wa-campaign-seg'}>
                      {seg}
                    </span>
                  ))}
                </span>
              </td>
              <td style={{ textAlign: 'left' }}>
                <span className={`wa-cat wa-cat--${row.category.toLowerCase()}`}>{row.category}</span>
              </td>
              <td>{money(row.spend)}</td>
              <td>
                <span className="wa-sharebar" aria-label={`${((row.spend / totalSpend) * 100).toFixed(0)}% of listed spend`}>
                  <span className="wa-sharebar__fill" style={{ width: `${Math.max(3, (row.spend / totalSpend) * 100)}%` }} />
                </span>
              </td>
              <td>{money(row.sales)}</td>
              <td>{row.spend > 0 && row.sales > 0 ? `${((row.spend / row.sales) * 100).toFixed(1)}%` : '—'}</td>
              <td>{row.clicks.toLocaleString('en-US')}</td>
              <td>{row.orders.toLocaleString('en-US')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
