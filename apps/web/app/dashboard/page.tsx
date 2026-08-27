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
import type { CSSProperties } from 'react';
import { analyzeAccount, classifyCampaignCategory, computePacing, evaluate, pacingFlag } from '@wizard-ads/core';
import type { DailyRow, Flag } from '@wizard-ads/core';
import { loadCrosscheckPanel } from '@wizard-ads/crosscheck-cli';
import { assessFreshness, deriveMetric } from '@wizard-ads/ui';
import { CrosscheckChip } from '../crosscheck/panel';
import { gate } from '../../src/auth/guard';
import { gateMessage } from '../../src/ui/gate-message';
import { Card, EmptyState, PageHeader } from '../../src/ui/primitives';
import { FlagsCard, FreshnessBar, KpiTile, PacingCard } from '../../src/ui/dashboard';
import type { FlagView, PacingView } from '../../src/ui/dashboard';
import { TrendChart } from '../../src/ui/viz';
import type { TrendPoint } from '../../src/ui/viz';
import { page } from '../../src/ui/tokens';
import { loadCampaignDailyRows, loadProfileDailyRows, loadReportLedger } from '../_lib/dashboard-data';
import { loadExperimentWindows } from '../_lib/experiment-windows';
import { comparePeriodMetric } from '../../src/dashboard/kpis';
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
    const [ledger, accountRows, campaignRows, crosscheck, experimentWindows] = await Promise.all([
      loadReportLedger(handle, orgId, profile.id),
      loadProfileDailyRows(handle, orgId, profile.id, profile.label, accountWindow),
      loadCampaignDailyRows(handle, orgId, profile.id, profile.label, analysisWindow),
      loadCrosscheckPanel(handle, { profileId: profile.id }).catch(() => null),
      loadExperimentWindows(handle, orgId, profile.id).catch(() => []),
    ]);

    return { profiles, profile, ledger, accountRows, campaignRows, crosscheck, experimentWindows };
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
            <a className="wa-btn wa-btn--primary wa-btn--sm" href="/settings/connections">
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
    experimentWindows = [],
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
  const currentWindow = settled.current;
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

  const kpis: { metric: string; label: string; scale: 'money' | 'percent'; better: 'higher' | 'lower' | null }[] = [
    { metric: 'spend', label: 'Spend', scale: 'money', better: null },
    { metric: 'sales', label: 'Sales', scale: 'money', better: 'higher' },
    { metric: 'acos', label: 'ACOS', scale: 'percent', better: 'lower' },
    { metric: 'cpc', label: 'CPC', scale: 'money', better: 'lower' },
  ];

  return (
    <main style={page}>
      <PageHeader
        title="Dashboard"
        subtitle={`${profile.label} · ${period.start} to ${period.end} · ${settled.current === null || settled.comparison === null ? 'no settled KPI comparison yet' : `settled KPI window ${settled.current.start} to ${settled.current.end} compared against ${settled.comparison.start} to ${settled.comparison.end}`} · all figures in ${profile.currencyCode}`}
      />

      <div className="wa-stack">
        <FreshnessBar assessment={freshness}>
          {data.crosscheck ? <CrosscheckChip chip={data.crosscheck.chip} /> : null}
        </FreshnessBar>

        <section aria-label="Headline metrics" className="wa-kpis">
          {kpis.map(({ metric, label, scale, better }) => {
            const comparisonMetric = comparePeriodMetric(settledRows, comparisonRows, metric);
            return (
              <KpiTile
                key={metric}
                label={`${label} (settled)`}
                value={comparisonMetric.value}
                scale={scale}
                better={better}
                context={context}
                deltas={[
                  {
                    caption: 'vs prior period',
                    pct: comparisonMetric.deltaPct,
                    reference: comparisonMetric.reference,
                  },
                ]}
              />
            );
          })}
        </section>

        <section aria-label="Trends" className="wa-grid-2">
          <Card>
            <TrendChart
              title="Spend and sales"
              ariaLabel="Daily spend and sales"
              scale="money"
              aggregatable
              currencyCode={profile.currencyCode}
              windows={experimentWindows}
              settlingWindow={settlingWindow}
              caption={`Spend and sales are additive, so weekly and monthly roll up by sum. In ${profile.currencyCode}.`}
              series={[
                { label: 'Spend', points: series(inPeriod, 'spend') },
                { label: 'Sales', points: series(inPeriod, 'sales') },
              ]}
            />
          </Card>
          <Card>
            <div style={twoCharts}>
              <TrendChart
                title="ACOS"
                ariaLabel="Daily ACOS"
                scale="percent"
                currencyCode={profile.currencyCode}
                windows={experimentWindows}
                settlingWindow={settlingWindow}
                caption="Advertising cost of sales, as a fraction of sales."
                series={[{ label: 'ACOS', points: series(inPeriod, 'acos') }]}
              />
              <TrendChart
                title="CPC"
                ariaLabel="Daily CPC"
                scale="money"
                currencyCode={profile.currencyCode}
                settlingWindow={settlingWindow}
                caption={`Cost per click, in ${profile.currencyCode}.`}
                series={[{ label: 'CPC', points: series(inPeriod, 'cpc') }]}
              />
            </div>
          </Card>
        </section>

        <section className="wa-grid-2">
          <PacingCard pacing={pacing as PacingView | null} context={context} />
          <FlagsCard active={activeFlags as FlagView[]} suppressed={flags.suppressed as FlagView[]} />
        </section>

        <p className="wa-page-sub">
          <a href={`/grid?profile=${profile.id}&from=${period.start}&to=${period.end}`}>
            Open the grid for this profile →
          </a>
        </p>
      </div>
    </main>
  );
}

function series(rows: readonly DailyRow[], metric: string): TrendPoint[] {
  return rows.map((row) => ({
    date: row.date,
    value: deriveMetric(metric, {
      impressions: row.impressions,
      clicks: row.clicks,
      spend: row.spend,
      sales: row.sales,
      orders: row.orders,
      units: 0,
    }),
  }));
}

const twoCharts: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '1.25rem' };
