import { describe, expect, it } from 'vitest';
import {
  DERIVED_METRIC_NAMES,
  deltaAbsolute,
  deltaPercent,
  derive,
  deriveAll,
  deriveSql,
  emptyTotals,
} from './metrics.js';
import type { BaseTotals } from './metrics.js';

const totals = (overrides: Partial<BaseTotals>): BaseTotals => ({ ...emptyTotals(), ...overrides });

describe('derived metrics', () => {
  it('recomputes a ratio from summed bases rather than averaging ratios', () => {
    // Two rows: one big and efficient, one tiny and terrible. The mean of the
    // two ACOSes is 0.5; the correct answer, total spend over total sales, is
    // 0.108. This is the bug the whole module exists to make impossible.
    const rowA = totals({ spend: 100, sales: 1000 });
    const rowB = totals({ spend: 9, sales: 10 });
    const meanOfRatios = ((derive(rowA, 'acos') ?? 0) + (derive(rowB, 'acos') ?? 0)) / 2;

    const summed = totals({ spend: rowA.spend + rowB.spend, sales: rowA.sales + rowB.sales });
    expect(derive(summed, 'acos')).toBeCloseTo(109 / 1010, 12);
    expect(meanOfRatios).toBeCloseTo(0.5, 12);
    expect(derive(summed, 'acos')).not.toBeCloseTo(meanOfRatios, 3);
  });

  it('returns null, never zero, when the denominator is zero', () => {
    const noClicks = totals({ impressions: 500, spend: 0 });
    expect(derive(noClicks, 'cvr')).toBeNull();
    expect(derive(noClicks, 'cpc')).toBeNull();
    // Spend with no sales: ACOS is undefined, not infinite and not zero.
    expect(derive(totals({ spend: 40 }), 'acos')).toBeNull();
  });

  it('computes every ratio it advertises', () => {
    const row = totals({ impressions: 1000, clicks: 50, spend: 25, sales: 200, orders: 10, units: 12 });
    const all = deriveAll(row);
    expect(Object.keys(all).sort()).toEqual([...DERIVED_METRIC_NAMES].sort());
    expect(all.ctr).toBeCloseTo(0.05, 12);
    expect(all.cvr).toBeCloseTo(0.2, 12);
    expect(all.cpc).toBeCloseTo(0.5, 12);
    expect(all.cpa).toBeCloseTo(2.5, 12);
    expect(all.acos).toBeCloseTo(0.125, 12);
    expect(all.roas).toBeCloseTo(8, 12);
    expect(all.rpc).toBeCloseTo(4, 12);
    expect(all.aov).toBeCloseTo(20, 12);
    expect(all.cpm).toBeCloseTo(25, 12);
  });

  it('generates SQL from the same descriptor as the TypeScript computation', () => {
    expect(deriveSql('acos', (base) => `b.${base}`)).toBe('(b.spend) / nullif(b.sales, 0)');
    expect(deriveSql('cpm', (base) => `b.${base}`)).toBe(
      '((b.spend * 1000)) / nullif(b.impressions, 0)',
    );
  });
});

describe('deltas', () => {
  it('reports a true percent, not a ratio', () => {
    expect(deltaPercent(112.5, 100)).toBeCloseTo(12.5, 12);
    expect(deltaAbsolute(112.5, 100)).toBeCloseTo(12.5, 12);
  });

  it('declines to divide by a zero baseline', () => {
    expect(deltaPercent(10, 0)).toBeNull();
    expect(deltaPercent(null, 10)).toBeNull();
    expect(deltaAbsolute(10, null)).toBeNull();
  });
});
