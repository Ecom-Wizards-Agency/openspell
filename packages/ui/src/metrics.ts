/**
 * The metric registry: which numbers are additive, which are ratios, and how a
 * ratio is rebuilt from the sums underneath it.
 *
 * This file is the single answer to the one question the recon says AdLabs got
 * right and everybody else gets wrong (`tools/recon/02-data-grid.md` §4):
 *
 *   "Do not use GROUP BY in query. Use group_by_column -- it correctly
 *    recalculates derived metrics (ACOS, ROAS, CTR, CVR, CPC, RPC, CPA, CPM,
 *    AOV)."
 *
 * So: a ratio is never stored on a row, never summed and never averaged. It is
 * a function of two base sums, evaluated at whatever aggregation level is being
 * displayed. `aggregate.ts` is the only caller that matters, and it cannot get
 * this wrong because there is nothing else it could call.
 *
 * `scale` is carried as data rather than inferred from the metric's name, for
 * the reason the dashboard recon gives (`03-dashboards.md` §3): a renderer that
 * guesses "acos sounds like a percent" is one rename away from printing 2430%.
 */

/** Base metrics: the additive ones. Everything else is a function of these. */
export const BASE_METRICS = [
  'impressions',
  'clicks',
  'spend',
  'sales',
  'orders',
  'units',
] as const;

export type BaseMetric = (typeof BASE_METRICS)[number];

/** A row of summable figures. Absent means absent, not zero. */
export type BaseTotals = Record<BaseMetric, number>;

export const ZERO_TOTALS: BaseTotals = {
  impressions: 0,
  clicks: 0,
  spend: 0,
  sales: 0,
  orders: 0,
  units: 0,
};

/**
 * How a value is rendered and compared.
 *
 * `percent` values are stored as fractions (0.243) and rendered as 24.3%.
 * `money` values are rendered in the profile's own currency and never summed
 * across profiles -- see `assertSingleCurrency` in `aggregate.ts`.
 */
export type MetricScale = 'integer' | 'money' | 'percent' | 'ratio' | 'decimal';

export interface MetricSpec {
  /** Lowercase, snake_case: the column id. Filter keys are the uppercase twin. */
  key: string;
  label: string;
  scale: MetricScale;
  /**
   * Which direction is good. Used only for delta colouring; a metric with
   * `null` is one where "up" is neither good nor bad (impressions, spend).
   */
  better: 'higher' | 'lower' | null;
  /**
   * `null` for a base metric. For a derived metric: numerator and denominator
   * base sums, plus an optional multiplier (CPM is per thousand).
   */
  derived: { numerator: BaseMetric; denominator: BaseMetric; factor?: number } | null;
}

/**
 * Every metric the grid knows, in display order.
 *
 * Deliberately absent, and why: `actc` (add-to-cart) and `cpa`'s cart-add
 * cousins need a cart-add figure our fact tables do not carry, so the column
 * would be a plausible wrong number rather than a missing one. The recon lists
 * them; we ship the ones we can source.
 */
export const METRIC_SPECS: readonly MetricSpec[] = [
  { key: 'impressions', label: 'Impressions', scale: 'integer', better: null, derived: null },
  { key: 'clicks', label: 'Clicks', scale: 'integer', better: null, derived: null },
  { key: 'spend', label: 'Spend', scale: 'money', better: null, derived: null },
  { key: 'sales', label: 'Sales', scale: 'money', better: 'higher', derived: null },
  { key: 'orders', label: 'Orders', scale: 'integer', better: 'higher', derived: null },
  { key: 'units', label: 'Units', scale: 'integer', better: 'higher', derived: null },
  {
    key: 'ctr',
    label: 'CTR',
    scale: 'percent',
    better: 'higher',
    derived: { numerator: 'clicks', denominator: 'impressions' },
  },
  {
    key: 'cvr',
    label: 'CVR',
    scale: 'percent',
    better: 'higher',
    derived: { numerator: 'orders', denominator: 'clicks' },
  },
  {
    key: 'cpc',
    label: 'CPC',
    scale: 'money',
    better: 'lower',
    derived: { numerator: 'spend', denominator: 'clicks' },
  },
  {
    key: 'cpm',
    label: 'CPM',
    scale: 'money',
    better: 'lower',
    derived: { numerator: 'spend', denominator: 'impressions', factor: 1000 },
  },
  {
    key: 'cpa',
    label: 'CPA',
    scale: 'money',
    better: 'lower',
    derived: { numerator: 'spend', denominator: 'orders' },
  },
  {
    key: 'rpc',
    label: 'RPC',
    scale: 'money',
    better: 'higher',
    derived: { numerator: 'sales', denominator: 'clicks' },
  },
  {
    key: 'aov',
    label: 'AOV',
    scale: 'money',
    better: 'higher',
    derived: { numerator: 'sales', denominator: 'orders' },
  },
  {
    key: 'acos',
    label: 'ACOS',
    scale: 'percent',
    better: 'lower',
    derived: { numerator: 'spend', denominator: 'sales' },
  },
  {
    key: 'roas',
    label: 'ROAS',
    scale: 'ratio',
    better: 'higher',
    derived: { numerator: 'sales', denominator: 'spend' },
  },
];

const BY_KEY = new Map(METRIC_SPECS.map((spec) => [spec.key, spec]));

export function metricSpec(key: string): MetricSpec | undefined {
  return BY_KEY.get(key);
}

export const DERIVED_METRIC_KEYS: readonly string[] = METRIC_SPECS.filter(
  (spec) => spec.derived !== null,
).map((spec) => spec.key);

/**
 * Divide, honestly.
 *
 * A zero denominator is `null`, not zero and not Infinity: ACOS on a row with
 * no sales is *undefined*, and rendering it as 0% would read as perfect
 * efficiency on the single worst row in the account.
 */
export function safeRatio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator === 0) return null;
  return numerator / denominator;
}

/**
 * One derived metric, from base sums. The only way a ratio is ever produced.
 */
export function deriveMetric(key: string, totals: BaseTotals): number | null {
  const spec = BY_KEY.get(key);
  if (!spec) return null;
  if (spec.derived === null) return totals[key as BaseMetric] ?? null;
  const ratio = safeRatio(totals[spec.derived.numerator], totals[spec.derived.denominator]);
  if (ratio === null) return null;
  return spec.derived.factor === undefined ? ratio : ratio * spec.derived.factor;
}

/** Every metric, base and derived, for one set of base sums. */
export function deriveAll(totals: BaseTotals): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const spec of METRIC_SPECS) out[spec.key] = deriveMetric(spec.key, totals);
  return out;
}

/** Add `b` into `a`, in place. Base metrics only, by construction. */
export function addTotals(a: BaseTotals, b: BaseTotals): BaseTotals {
  a.impressions += b.impressions;
  a.clicks += b.clicks;
  a.spend += b.spend;
  a.sales += b.sales;
  a.orders += b.orders;
  a.units += b.units;
  return a;
}

export function emptyTotals(): BaseTotals {
  return { ...ZERO_TOTALS };
}
