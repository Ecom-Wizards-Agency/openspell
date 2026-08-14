/**
 * The Campaign Optimizer's view model.
 *
 * Pure functions from the data the page already loads — the recommendation run's
 * proposals and the profile's daily facts — to the three things the AdLabs
 * "Bid Optimizer" layout puts on screen (`tools/recon/04-optimizer.md`): the KPI
 * tile row, the optimization-group rollup, and the settings summary chip. The
 * page renders these and computes nothing else, so the arithmetic can be tested
 * without a browser.
 *
 * The one rule that governs every number here is the grid's rule
 * (`02-data-grid.md` §4): a ratio is recomputed from summed bases, never
 * averaged. KPI values go through `deriveMetric`, which is the only path that
 * produces a ratio, so ACOS on a tile and ACOS on the grid can never disagree.
 */
import { deriveMetric } from '@wizard-ads/ui';
import type { BaseTotals } from '@wizard-ads/ui';
import type { ProposalView } from '../recommendations/view';

/** The AdLabs stat-tile row, in its order (`02-data-grid.md` §0). */
export const KPI_METRICS = [
  'spend',
  'sales',
  'orders',
  'roas',
  'acos',
  'rpc',
  'impressions',
  'clicks',
  'ctr',
  'cpc',
  'aov',
  'cpa',
  'cvr',
  'cpm',
] as const;

const META: Record<
  string,
  { label: string; scale: 'money' | 'percent' | 'ratio' | 'integer'; better: 'higher' | 'lower' | null }
> = {
  spend: { label: 'Spend', scale: 'money', better: null },
  sales: { label: 'Sales', scale: 'money', better: 'higher' },
  orders: { label: 'Orders', scale: 'integer', better: 'higher' },
  roas: { label: 'ROAS', scale: 'ratio', better: 'higher' },
  acos: { label: 'ACOS', scale: 'percent', better: 'lower' },
  rpc: { label: 'RPC', scale: 'money', better: 'higher' },
  impressions: { label: 'Impressions', scale: 'integer', better: null },
  clicks: { label: 'Clicks', scale: 'integer', better: null },
  ctr: { label: 'CTR', scale: 'percent', better: 'higher' },
  cpc: { label: 'CPC', scale: 'money', better: 'lower' },
  aov: { label: 'AOV', scale: 'money', better: 'higher' },
  cpa: { label: 'CPA', scale: 'money', better: 'lower' },
  cvr: { label: 'CVR', scale: 'percent', better: 'higher' },
  cpm: { label: 'CPM', scale: 'money', better: 'lower' },
};

export interface KpiTileModel {
  metric: string;
  label: string;
  scale: 'money' | 'percent' | 'ratio' | 'integer';
  better: 'higher' | 'lower' | null;
  value: number | null;
  prev: number | null;
  deltaPct: number | null;
}

/** Sum a set of daily rows into base totals. Absent is absent, not zero. */
export function totalsOf(
  rows: readonly { impressions: number; clicks: number; spend: number; sales: number; orders: number }[],
): BaseTotals {
  const totals: BaseTotals = { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0, units: 0 };
  for (const row of rows) {
    totals.impressions += row.impressions;
    totals.clicks += row.clicks;
    totals.spend += row.spend;
    totals.sales += row.sales;
    totals.orders += row.orders;
  }
  return totals;
}

/** The KPI tile row: value this period, value last period, and the delta. */
export function kpiTiles(period: BaseTotals, comparison: BaseTotals): KpiTileModel[] {
  return KPI_METRICS.map((metric) => {
    const meta = META[metric] ?? { label: metric, scale: 'money' as const, better: null };
    const value = deriveMetric(metric, period);
    const prev = deriveMetric(metric, comparison);
    const deltaPct = value !== null && prev !== null && prev !== 0 ? (value - prev) / prev : null;
    return { metric, label: meta.label, scale: meta.scale, better: meta.better, value, prev, deltaPct };
  });
}

export interface OptimizationGroup {
  /** The grouping key (a campaign, until a real opt-group model exists). */
  key: string;
  label: string;
  /** Target ACOS shared by the group's proposals, when they agree; else null. */
  targetAcos: number | null;
  /** Prioritization / objective label shared by the group, when they agree. */
  objective: string | null;
  proposals: ProposalView[];
  /** The reason clusters inside the group, largest first. */
  reasons: { label: string; count: number }[];
}

/**
 * Group proposals into optimization groups.
 *
 * There is no backing optimization-group model yet (`04-optimizer.md` §4 — a
 * group is a named set of campaigns with its own target ACOS and prioritization;
 * our schema carries neither), so the campaign stands in as the group and the
 * strategy the run resolved for it supplies the target/objective. When a real
 * group model lands this function keys on it instead; nothing else changes.
 */
export function optimizationGroups(proposals: readonly ProposalView[]): OptimizationGroup[] {
  const byKey = new Map<string, ProposalView[]>();
  for (const proposal of proposals) {
    const key = campaignOf(proposal);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(proposal);
    else byKey.set(key, [proposal]);
  }
  return [...byKey.entries()]
    .map(([key, group]) => {
      const targetAcos = uniform(group.map((p) => p.strategy.targetAcos));
      const objective = uniform(group.map((p) => p.strategy.objective));
      const reasonCounts = new Map<string, number>();
      for (const proposal of group) {
        reasonCounts.set(proposal.reasonLabel, (reasonCounts.get(proposal.reasonLabel) ?? 0) + 1);
      }
      return {
        key,
        label: key,
        targetAcos,
        objective,
        proposals: group,
        reasons: [...reasonCounts.entries()]
          .map(([label, count]) => ({ label, count }))
          .sort((a, b) => b.count - a.count),
      };
    })
    .sort((a, b) => b.proposals.length - a.proposals.length);
}

function campaignOf(proposal: ProposalView): string {
  const scope = proposal.scope;
  const head = scope.split(' › ')[0];
  return head === undefined || head.trim() === '' ? 'Ungrouped' : head;
}

/** The value every element shares, or null when they disagree or the list is empty. */
function uniform<T>(values: readonly T[]): T | null {
  if (values.length === 0) return null;
  const first = values[0];
  return values.every((value) => value === first) ? (first ?? null) : null;
}

export interface SettingsSummary {
  targetAcos: number | null;
  objective: string | null;
  /** True when the run used one policy across every proposal. */
  uniform: boolean;
}

/**
 * The run's policy, for the toolbar chip AdLabs collapses the settings modal
 * into (`04-optimizer.md` §3): `Settings · Target ACOS 30% · Balanced`. When the
 * run assigned strategy per campaign the chip says so rather than picking one.
 */
export function settingsSummary(proposals: readonly ProposalView[]): SettingsSummary {
  const acos = uniform(proposals.map((p) => p.strategy.targetAcos));
  const objective = uniform(proposals.map((p) => p.strategy.objective));
  return { targetAcos: acos, objective, uniform: acos !== null && objective !== null };
}
