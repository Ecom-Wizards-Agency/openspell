/**
 * Metrics: the summed bases, and the ratios recomputed from them.
 *
 * One rule governs this file, and it is the single most common source of
 * quietly wrong numbers in ads tooling: **a derived metric is never averaged.**
 * ACOS over a group of targets is total spend divided by total sales, not the
 * mean of each target's ACOS. AdLabs enforces this by refusing `GROUP BY` in
 * their query layer and routing every aggregation through `group_by_column`;
 * we enforce it by defining each ratio once, as a numerator and a denominator
 * over summed bases, and generating both the TypeScript computation and the SQL
 * expression from that one descriptor.
 *
 * Two descriptors would be two chances to disagree. There is one.
 */

export const BASE_METRICS = [
  'impressions',
  'clicks',
  'spend',
  'sales',
  'orders',
  'units',
] as const;
export type BaseMetric = (typeof BASE_METRICS)[number];

export type BaseTotals = Record<BaseMetric, number>;

interface RatioDescriptor {
  numerator: BaseMetric;
  denominator: BaseMetric;
  /** CPM is per thousand impressions; everything else is a plain ratio. */
  multiplier?: number;
  description: string;
}

export const DERIVED_METRICS = {
  ctr: { numerator: 'clicks', denominator: 'impressions', description: 'clicks / impressions' },
  cvr: { numerator: 'orders', denominator: 'clicks', description: 'orders / clicks' },
  cpc: { numerator: 'spend', denominator: 'clicks', description: 'spend / clicks' },
  cpa: { numerator: 'spend', denominator: 'orders', description: 'spend / orders' },
  acos: { numerator: 'spend', denominator: 'sales', description: 'spend / sales' },
  roas: { numerator: 'sales', denominator: 'spend', description: 'sales / spend' },
  rpc: { numerator: 'sales', denominator: 'clicks', description: 'sales / clicks' },
  aov: { numerator: 'sales', denominator: 'orders', description: 'sales / orders' },
  cpm: {
    numerator: 'spend',
    denominator: 'impressions',
    multiplier: 1000,
    description: 'spend / impressions * 1000',
  },
} satisfies Record<string, RatioDescriptor>;

export type DerivedMetric = keyof typeof DERIVED_METRICS;
export const DERIVED_METRIC_NAMES = Object.keys(DERIVED_METRICS) as DerivedMetric[];

export type MetricName = BaseMetric | DerivedMetric;
export const ALL_METRICS: MetricName[] = [...BASE_METRICS, ...DERIVED_METRIC_NAMES];

export const isBaseMetric = (name: string): name is BaseMetric =>
  (BASE_METRICS as readonly string[]).includes(name);

export const isDerivedMetric = (name: string): name is DerivedMetric =>
  Object.hasOwn(DERIVED_METRICS, name);

/**
 * A ratio over summed bases. Null, never zero, when the denominator is zero:
 * "no clicks" and "a CVR of zero" are different statements, and only one of
 * them is true of a target nobody clicked.
 */
export function derive(totals: BaseTotals, metric: DerivedMetric): number | null {
  const descriptor: RatioDescriptor = DERIVED_METRICS[metric];
  const denominator = totals[descriptor.denominator];
  if (!denominator) return null;
  return (totals[descriptor.numerator] * (descriptor.multiplier ?? 1)) / denominator;
}

export function deriveAll(totals: BaseTotals): Record<DerivedMetric, number | null> {
  const out = {} as Record<DerivedMetric, number | null>;
  for (const name of DERIVED_METRIC_NAMES) out[name] = derive(totals, name);
  return out;
}

/**
 * The same ratio as SQL, over an aggregate expression per base metric.
 *
 * `nullif(..., 0)` is what makes the SQL agree with `derive`: divide by zero
 * yields null on both paths rather than an error on one and a zero on the other.
 */
export function deriveSql(
  metric: DerivedMetric,
  aggregate: (base: BaseMetric) => string,
): string {
  const descriptor: RatioDescriptor = DERIVED_METRICS[metric];
  const numerator =
    descriptor.multiplier === undefined
      ? aggregate(descriptor.numerator)
      : `(${aggregate(descriptor.numerator)} * ${descriptor.multiplier})`;
  return `(${numerator}) / nullif(${aggregate(descriptor.denominator)}, 0)`;
}

/** Percent change, with the sign convention stated once for the whole server. */
export function deltaPercent(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null || prior === 0) return null;
  return ((current - prior) / Math.abs(prior)) * 100;
}

export function deltaAbsolute(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null) return null;
  return current - prior;
}

export const emptyTotals = (): BaseTotals => ({
  impressions: 0,
  clicks: 0,
  spend: 0,
  sales: 0,
  orders: 0,
  units: 0,
});
