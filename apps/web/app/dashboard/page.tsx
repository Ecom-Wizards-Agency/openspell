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
import { loadCampaignDailyRows, loadProfileDailyRows, loadProvisionalDates, loadReportLedger } from '../_lib/dashboard-data';
import { withDatabase } from '../_lib/db';
import { addDays, periodFromParams, precedingPeriod, todayIso } from '../_lib/periods';
import { listProfiles, selectProfile } from '../_lib/profiles';

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
  const today = todayIso();
  const period = periodFromParams(params, today);
  const comparison = precedingPeriod(period);

  const data = await withDatabase(async (handle) => {
    const profiles = await listProfiles(handle, orgId);
    const profile = selectProfile(profiles, params.profile);
    if (profile === null) return { profiles, profile: null };

    const window = { start: addDays(period.start, -8), end: period.end };
    const [ledger, accountRows, campaignRows, provisional, crosscheck] = await Promise.all([
      loadReportLedger(handle, orgId, profile.id),
      loadProfileDailyRows(handle, orgId, profile.id, profile.label, window),
      loadCampaignDailyRows(handle, orgId, profile.id, profile.label, window),
      loadProvisionalDates(handle, orgId, profile.id, window),
      loadCrosscheckPanel(handle, { profileId: profile.id }).catch(() => null),
    ]);

    return { profiles, profile, ledger, accountRows, campaignRows, provisional, crosscheck };
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

  const { profile, accountRows = [], campaignRows = [], ledger = [], provisional = [] } = data;
  const context = { currencyCode: profile.currencyCode };

  const categorised: DailyRow[] = campaignRows.map((row) => ({
    ...row,
    category: classifyCampaignCategory(row.campaignName),
  }));

  const reportDate = accountRows.length > 0 ? (accountRows[accountRows.length - 1] as DailyRow).date : period.end;
  const analysis = analyzeAccount(profile.label, reportDate, accountRows, categorised);
  const flags = evaluate(analysis, null, profile.goalLens);

  const pacing = computePacing(
    accountRows.map((row) => ({ date: row.date, spend: row.spend })),
    reportDate,
    profile.monthlyBudget,
  );
  const pacingAlert = pacingFlag(pacing, null);
  const activeFlags: Flag[] = pacingAlert === null ? flags.active : [pacingAlert, ...flags.active];

  const freshness = assessFreshness(ledger, { now: new Date() });
  const inPeriod = accountRows.filter((row) => row.date >= period.start && row.date <= period.end);

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
        subtitle={`${profile.label} · ${period.start} to ${period.end} · compared against ${comparison.start} to ${comparison.end} · all figures in ${profile.currencyCode}`}
      />

      <div className="wa-stack">
        <FreshnessBar assessment={freshness}>
          {data.crosscheck ? <CrosscheckChip chip={data.crosscheck.chip} /> : null}
        </FreshnessBar>

        {provisional.some((date) => date >= period.start && date <= period.end) ? (
          <p className="wa-banner wa-banner--warn" style={{ display: 'block' }}>
            {provisional.length} day(s) in this window are still attributing. Same-day sales restate
            for 14 days; those days are shown, not hidden, and should not be read as a trend.
          </p>
        ) : null}

        <section aria-label="Headline metrics" className="wa-kpis">
          {kpis.map(({ metric, label, scale, better }) => {
            const delta = analysis.accountSeries.deltas[metric];
            return (
              <KpiTile
                key={metric}
                label={`${label} (period)`}
                value={periodValue(inPeriod, metric)}
                scale={scale}
                better={better}
                context={context}
                deltas={[
                  {
                    caption: 'vs prior period',
                    pct: delta?.priorPctChange ?? null,
                    reference: delta?.priorValue ?? null,
                  },
                  {
                    caption: 'vs trailing-7 avg',
                    pct: delta?.trailing7PctChange ?? null,
                    reference: delta?.trailing7Avg ?? null,
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
                caption="Advertising cost of sales, as a fraction of sales."
                series={[{ label: 'ACOS', points: series(inPeriod, 'acos') }]}
              />
              <TrendChart
                title="CPC"
                ariaLabel="Daily CPC"
                scale="money"
                currencyCode={profile.currencyCode}
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

/**
 * Period totals, from sums.
 *
 * The tiles show the whole selected window, not the last day, so `spend` is a
 * sum and `acos` is `sum(spend)/sum(sales)` over that window — the same rule the
 * grid's group-by follows, applied to the same numbers, so a tile and a grid
 * total can never disagree.
 */
function periodValue(rows: readonly DailyRow[], metric: string): number | null {
  if (rows.length === 0) return null;
  const totals = { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0, units: 0 };
  for (const row of rows) {
    totals.impressions += row.impressions;
    totals.clicks += row.clicks;
    totals.spend += row.spend;
    totals.sales += row.sales;
    totals.orders += row.orders;
  }
  return deriveMetric(metric, totals);
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
