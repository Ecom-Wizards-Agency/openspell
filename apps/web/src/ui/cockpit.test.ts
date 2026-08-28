/**
 * The cockpit's honesty rules, pinned.
 *
 * Two invariants matter more than anything visual on this component:
 *
 *  1. Weekly and monthly buckets are Monday-anchored / calendar-month keys, so
 *     a bucket never mixes two reporting weeks.
 *  2. Ratio metrics are derived from bucket SUMS, never averaged across days.
 *     An average of daily ACOS values is a different (wrong) number whenever
 *     spend is uneven across the bucket — the exact case a spiky account hits.
 */
import { describe, expect, it } from 'vitest';
import { bucketKey, partitionKpiTiles, seriesFor } from './cockpit';
import type { CockpitDay } from './cockpit';

const day = (date: string, over: Partial<CockpitDay> = {}): CockpitDay => ({
  date,
  impressions: 1000,
  clicks: 10,
  spend: 10,
  sales: 40,
  orders: 2,
  ...over,
});

describe('bucketKey', () => {
  it('daily buckets are the date itself', () => {
    expect(bucketKey('2026-08-27', 'D')).toBe('2026-08-27');
  });

  it('weekly buckets anchor to the Monday of that week', () => {
    // 2026-08-27 is a Thursday; its week starts Monday 2026-08-24.
    expect(bucketKey('2026-08-27', 'W')).toBe('2026-08-24');
    // A Monday is its own anchor, and a Sunday belongs to the week behind it.
    expect(bucketKey('2026-08-24', 'W')).toBe('2026-08-24');
    expect(bucketKey('2026-08-23', 'W')).toBe('2026-08-17');
  });

  it('monthly buckets are the calendar month', () => {
    expect(bucketKey('2026-08-01', 'M')).toBe('2026-08');
    expect(bucketKey('2026-08-31', 'M')).toBe('2026-08');
  });
});

describe('seriesFor', () => {
  it('sums additive metrics into the bucket', () => {
    const days = [day('2026-08-24', { spend: 10 }), day('2026-08-25', { spend: 30 })];
    const points = seriesFor(days, 'spend', 'W');
    expect(points).toEqual([{ date: '2026-08-24', value: 40 }]);
  });

  it('derives ratios from bucket sums, not from averaged daily ratios', () => {
    // Day one: ACOS 100/1000 = 10%. Day two: ACOS 10/20 = 50%.
    // Averaging daily ratios says 30%; the truthful bucket says 110/1020.
    const days = [
      day('2026-08-24', { spend: 100, sales: 1000 }),
      day('2026-08-25', { spend: 10, sales: 20 }),
    ];
    const [point] = seriesFor(days, 'acos', 'W');
    expect(point?.value).toBeCloseTo(110 / 1020, 10);
  });

  it('keeps separate weeks separate and sorts them', () => {
    const days = [day('2026-08-27'), day('2026-08-20')]; // Thu of two adjacent weeks
    const points = seriesFor(days, 'spend', 'W');
    expect(points.map((p) => p.date)).toEqual(['2026-08-17', '2026-08-24']);
  });
});

describe('partitionKpiTiles', () => {
  it('keeps exactly the four operator KPIs primary and preserves every supporting metric', () => {
    const tiles = ['ctr', 'acos', 'spend', 'orders', 'sales', 'clicks'].map((metric) => ({
      metric,
      label: metric,
      scale: metric === 'orders' || metric === 'clicks' ? ('integer' as const) : ('money' as const),
      better: null,
      value: 1,
      prev: 1,
      deltaPct: 0,
    }));

    const groups = partitionKpiTiles(tiles);
    expect(groups.primary.map((tile) => tile.metric)).toEqual(['spend', 'sales', 'orders', 'acos']);
    expect(groups.supporting.map((tile) => tile.metric)).toEqual(['ctr', 'clicks']);
    expect([...groups.primary, ...groups.supporting]).toHaveLength(tiles.length);
  });
});
