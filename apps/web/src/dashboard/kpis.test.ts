import { describe, expect, it } from 'vitest';
import type { DailyRow } from '@wizard-ads/core';
import { comparePeriodMetric } from './kpis.js';

const row = (date: string, spend: number, sales: number): DailyRow => ({
  account: 'Synthetic account',
  date,
  level: 'account',
  impressions: 100,
  clicks: 10,
  spend,
  sales,
  orders: 2,
});

describe('comparePeriodMetric', () => {
  it('compares period sums rather than the final days', () => {
    const result = comparePeriodMetric(
      [row('2026-08-01', 10, 20), row('2026-08-02', 20, 80)],
      [row('2026-07-01', 5, 40), row('2026-07-02', 15, 60)],
      'sales',
    );
    expect(result).toEqual({ value: 100, reference: 100, deltaPct: 0 });
  });

  it('recomputes ratio metrics from summed bases', () => {
    const result = comparePeriodMetric(
      [row('2026-08-01', 10, 50), row('2026-08-02', 20, 50)],
      [row('2026-07-01', 40, 100)],
      'acos',
    );
    expect(result.value).toBeCloseTo(0.3, 10);
    expect(result.reference).toBeCloseTo(0.4, 10);
    expect(result.deltaPct).toBeCloseTo(-0.25, 10);
  });

  it('does not turn an absent comparison period into zero', () => {
    expect(comparePeriodMetric([row('2026-08-01', 10, 20)], [], 'sales')).toEqual({
      value: 20,
      reference: null,
      deltaPct: null,
    });
  });
});
