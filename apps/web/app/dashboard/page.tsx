/**
 * `/dashboard` — the per-profile dashboard.
 *
 * A server component that reads the database and hands plain data to
 * presentational components. No Amazon call happens here (they all live in the
 * worker) and no doctrine value is hardcoded here (they arrive from the
 * profile row).
 *
 * The page is arranged around one idea: **say how much to trust these numbers
 * before showing them.** So the freshness banner and the crosscheck chip sit
 * above the tiles, not below, and they answer two different questions on
 * purpose — the banner says whether our numbers are current, the chip says
 * whether they agree with the incumbent's. A profile can be fresh and wrong, or
 * stale and verified, and an operator needs to see which.
 *
 * Entry goes through `gate()`, the same guard `/settings` and `/sync-status`
 * use: anonymous visitors are sent to `/login`, and every read below is scoped
 * by the org the gate resolved. This page shipped without either, which meant a
 * public URL rendering the first profile in the database — whoever owned it.
 */
import type { CSSProperties } from 'react';
import { analyzeAccount, classifyCampaignCategory, computePacing, evaluate, pacingFlag } from '@wizard-ads/core';
import type { DailyRow, Flag } from '@wizard-ads/core';
import { loadCrosscheckPanel } from '@wizard-ads/crosscheck-cli';
import {
  FlagsPanel,
  FreshnessBanner,
  PacingWidget,
  ProfileSwitcher,
  StatTile,
  TrendChart,
  assessFreshness,
  deriveMetric,
  tokens,
} from '@wizard-ads/ui';
import type { FlagView, PacingView, TrendPoint } from '@wizard-ads/ui';
import { CrosscheckChip } from '../crosscheck/panel';
import { gate } from '../../src/auth/guard';
import { gateMessage } from '../../src/ui/gate-message';
import { loadCampaignDailyRows, loadProfileDailyRows, loadProvisionalDates, loadReportLedger } from '../_lib/dashboard-data';
import { withDatabase } from '../_lib/db';
import { addDays, periodFromParams, precedingPeriod, todayIso } from '../_lib/periods';
import { listProfiles, selectProfile } from '../_lib/profiles';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ profile?: string; from?: string; to?: string }>;
}

export default async function DashboardPage({ searchParams }: PageProps) {
  // Authorization before anything else: `gate()` redirects an anonymous
  // visitor to `/login` and hands back the org every read below is scoped to.
  const entry = await gate();
  if (entry.state !== 'ok') {
    return (
      <Shell>
        <h1 style={heading}>Dashboard</h1>
        <p style={muted}>{gateMessage(entry.state)}</p>
      </Shell>
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

    // The analyzer needs the report date, the day before it, and the seven
    // before that. Reading the whole selected window plus that runway covers
    // both the trend charts and the deltas from one query.
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
      <Shell>
        <h1 style={heading}>Dashboard</h1>
        <p style={muted}>{gateMessage('no-database')}</p>
      </Shell>
    );
  }

  if (data.profile === null) {
    return (
      <Shell>
        <h1 style={heading}>Dashboard</h1>
        <ProfileSwitcher profiles={data.profiles} selectedId={null} hrefFor={hrefFor} />
      </Shell>
    );
  }

  const { profile, accountRows = [], campaignRows = [], ledger = [], provisional = [] } = data;
  const context = { currencyCode: profile.currencyCode };

  // Categories drive flag suppression: a wide ACOS swing on a Rank/SKW campaign
  // is an attribution artifact, and the engine can only know that if the rows
  // carry a category.
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

  return (
    <Shell>
      <header style={{ display: 'flex', flexDirection: 'column', gap: tokens.space(3) }}>
        <div>
          <h1 style={heading}>Dashboard</h1>
          <p style={muted}>
            {profile.label} · {period.start} to {period.end} · compared against {comparison.start} to{' '}
            {comparison.end} · all figures in {profile.currencyCode}
          </p>
        </div>

        <ProfileSwitcher profiles={data.profiles} selectedId={profile.id} hrefFor={hrefFor} />

        <FreshnessBanner assessment={freshness}>
          {data.crosscheck ? <CrosscheckChip chip={data.crosscheck.chip} /> : null}
        </FreshnessBanner>

        {provisional.some((date) => date >= period.start && date <= period.end) ? (
          <p style={{ ...muted, color: tokens.color.warn }}>
            {provisional.length} day(s) in this window are still attributing. Same-day sales restate
            for 14 days; those days are shown, not hidden, and should not be read as a trend.
          </p>
        ) : null}
      </header>

      <section aria-label="Headline metrics" style={tileRow}>
        {['spend', 'sales', 'acos', 'cpc'].map((metric) => {
          const delta = analysis.accountSeries.deltas[metric];
          return (
            <StatTile
              key={metric}
              metric={metric}
              value={periodValue(inPeriod, metric)}
              priorValue={delta?.priorValue ?? null}
              priorPctChange={delta?.priorPctChange ?? null}
              trailing7Avg={delta?.trailing7Avg ?? null}
              trailing7PctChange={delta?.trailing7PctChange ?? null}
              context={context}
              label={`${labelFor(metric)} (period)`}
            />
          );
        })}
      </section>

      <section aria-label="Trends" style={chartGrid}>
        <ChartCard title="Spend and sales">
          <TrendChart
            ariaLabel="Daily spend and sales"
            series={[
              { label: 'Spend', points: series(inPeriod, 'spend'), color: tokens.color.accent },
              { label: 'Sales', points: series(inPeriod, 'sales'), color: tokens.color.good },
            ]}
            caption={profile.currencyCode}
          />
        </ChartCard>
        <ChartCard title="ACOS and CPC">
          <TrendChart
            ariaLabel="Daily ACOS and CPC"
            series={[
              { label: 'ACOS', points: series(inPeriod, 'acos'), color: tokens.color.bad },
              { label: 'CPC', points: series(inPeriod, 'cpc'), color: tokens.color.textMuted, dashed: true },
            ]}
            caption="ACOS as a fraction; CPC in profile currency"
          />
        </ChartCard>
      </section>

      <section style={panelGrid}>
        <PacingWidget pacing={pacing as PacingView | null} context={context} />
        <FlagsPanel active={activeFlags as FlagView[]} suppressed={flags.suppressed as FlagView[]} />
      </section>

      <p style={muted}>
        <a href={`/grid?profile=${profile.id}&from=${period.start}&to=${period.end}`} style={link}>
          Open the grid for this profile →
        </a>
      </p>
    </Shell>
  );
}

/**
 * Period totals, from sums.
 *
 * The tiles show the whole selected window, not the last day, so `spend` is a
 * sum and `acos` is `sum(spend)/sum(sales)` over that window — the same rule
 * the grid's group-by follows, applied to the same numbers, so a tile and a
 * grid total can never disagree.
 */
function periodValue(rows: readonly DailyRow[], metric: string): number | null {
  if (rows.length === 0) return null;
  const totals = {
    impressions: 0,
    clicks: 0,
    spend: 0,
    sales: 0,
    orders: 0,
    units: 0,
  };
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

function labelFor(metric: string): string {
  return { spend: 'Spend', sales: 'Sales', acos: 'ACOS', cpc: 'CPC' }[metric] ?? metric;
}

const hrefFor = (profileId: string): string => `/dashboard?profile=${profileId}`;

function Shell({ children }: { children: React.ReactNode }) {
  return <main style={main}>{children}</main>;
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={card}>
      <h3 style={{ fontSize: tokens.font.size.lg, margin: 0 }}>{title}</h3>
      {children}
    </section>
  );
}

const main: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  fontFamily: tokens.font.sans,
  gap: tokens.space(5),
  margin: '0 auto',
  maxWidth: '80rem',
  padding: '2rem 1.5rem',
};

const heading: CSSProperties = { fontSize: tokens.font.size.xl, margin: '0 0 0.25rem' };
const muted: CSSProperties = { color: tokens.color.textMuted, fontSize: tokens.font.size.base, margin: 0 };
const link: CSSProperties = { color: tokens.color.accent };
const tileRow: CSSProperties = {
  display: 'grid',
  gap: tokens.space(3),
  gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))',
};
const chartGrid: CSSProperties = {
  display: 'grid',
  gap: tokens.space(3),
  gridTemplateColumns: 'repeat(auto-fit, minmax(20rem, 1fr))',
};
const panelGrid: CSSProperties = {
  display: 'grid',
  gap: tokens.space(3),
  gridTemplateColumns: 'repeat(auto-fit, minmax(22rem, 1fr))',
};
const card: CSSProperties = {
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  display: 'flex',
  flexDirection: 'column',
  gap: tokens.space(2),
  padding: tokens.space(3),
};
