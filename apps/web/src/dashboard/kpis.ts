import type { DailyRow } from '@wizard-ads/core';
import { deriveMetric } from '@wizard-ads/ui';

export interface PeriodMetricComparison {
  value: number | null;
  reference: number | null;
  deltaPct: number | null;
}

/** Sum bases over one period and derive the requested metric once. */
export function periodValue(rows: readonly DailyRow[], metric: string): number | null {
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

/** Compare equal-grain period aggregates; absence and a zero baseline stay distinct. */
export function comparePeriodMetric(
  currentRows: readonly DailyRow[],
  comparisonRows: readonly DailyRow[],
  metric: string,
): PeriodMetricComparison {
  const value = periodValue(currentRows, metric);
  const reference = periodValue(comparisonRows, metric);
  const deltaPct =
    value === null || reference === null || reference === 0
      ? null
      : (value - reference) / Math.abs(reference);
  return { value, reference, deltaPct };
}
