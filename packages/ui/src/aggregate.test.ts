/**
 * The one arithmetic property this whole package exists to guarantee: a
 * grouped ACOS is `sum(spend) / sum(sales)`, never the mean of the ACOSes.
 *
 * The tests below build cases where the two answers are far apart, because a
 * test where averaging happens to agree with sum/sum proves nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  MixedCurrencyError,
  assertSingleCurrency,
  grandTotal,
  groupRows,
  uniqueGroupLevels,
} from './aggregate.js';
import { syntheticSearchTermRows } from './fixtures.js';
import { deriveMetric } from './metrics.js';
import type { GridRow } from './rows.js';
import { resolveField } from './rows.js';

function row(
  id: string,
  campaign: string,
  totals: Partial<GridRow['totals']>,
  comparison: Partial<GridRow['totals']> | null = null,
  currencyCode = 'USD',
): GridRow {
  const zero = { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0, units: 0 };
  return {
    id,
    dimensions: { campaign_name: campaign },
    totals: { ...zero, ...totals },
    comparison: comparison === null ? null : { ...zero, ...comparison },
    currencyCode,
  };
}

describe('groupRows', () => {
  it('recomputes ACOS from summed bases, not from averaged ratios', () => {
    // 100% ACOS and 10% ACOS. Mean of ratios = 55%. Correct = 110/1010 ≈ 10.9%.
    const rows = [
      row('a', 'Campaign', { spend: 10, sales: 10 }),
      row('b', 'Campaign', { spend: 100, sales: 1000 }),
    ];

    const [group] = groupRows(rows, ['campaign_name']);
    expect(group).toBeDefined();
    expect(group?.totals.spend).toBe(110);
    expect(group?.totals.sales).toBe(1010);

    const acos = resolveField(group as GridRow, 'acos') as number;
    expect(acos).toBeCloseTo(110 / 1010, 12);
    expect(acos).not.toBeCloseTo((1.0 + 0.1) / 2, 3);
  });

  it('recomputes CVR from summed bases', () => {
    // 50% CVR on 2 clicks, 1% CVR on 1000 clicks. Mean = 25.5%; correct ≈ 1.1%.
    const rows = [
      row('a', 'Campaign', { clicks: 2, orders: 1 }),
      row('b', 'Campaign', { clicks: 1000, orders: 10 }),
    ];
    const [group] = groupRows(rows, ['campaign_name']);
    const cvr = resolveField(group as GridRow, 'cvr') as number;
    expect(cvr).toBeCloseTo(11 / 1002, 12);
    expect(cvr).toBeLessThan(0.02);
  });

  it.each(['ctr', 'cvr', 'cpc', 'cpa', 'rpc', 'aov', 'acos', 'roas', 'cpm'])(
    'recomputes %s at group level exactly as it would at row level with the same sums',
    (metric) => {
      const rows = syntheticSearchTermRows(400, { seed: 7 });
      const [group] = groupRows(rows, ['ad_product']);
      expect(group).toBeDefined();
      const expected = deriveMetric(metric, (group as GridRow).totals);
      expect(resolveField(group as GridRow, metric)).toEqual(expected);
    },
  );

  it('sums only the entities that reported in the comparison window', () => {
    const rows = [
      row('a', 'Campaign', { spend: 10, sales: 40 }, { spend: 8, sales: 32 }),
      row('b', 'Campaign', { spend: 5, sales: 10 }, null),
    ];
    const [group] = groupRows(rows, ['campaign_name']);
    expect(group?.comparison).toEqual(
      expect.objectContaining({ spend: 8, sales: 32 }),
    );
    // The delta compares like with like: 15/50 now against 8/32 then.
    expect(resolveField(group as GridRow, 'acos_comparison')).toBeCloseTo(0.25, 12);
  });

  it('leaves the comparison null when no member had one, so deltas are null not zero', () => {
    const rows = [row('a', 'Campaign', { spend: 10, sales: 40 }, null)];
    const [group] = groupRows(rows, ['campaign_name']);
    expect(group?.comparison).toBeNull();
    expect(resolveField(group as GridRow, 'acos_delta_percent')).toBeNull();
    expect(resolveField(group as GridRow, 'acos_delta_absolute')).toBeNull();
  });

  it('drops dimensions outside the group key rather than showing one member’s value', () => {
    const rows = [
      { ...row('a', 'Campaign', { spend: 1 }), dimensions: { campaign_name: 'Campaign', bid: 0.5 } },
      { ...row('b', 'Campaign', { spend: 1 }), dimensions: { campaign_name: 'Campaign', bid: 9.9 } },
    ];
    const [group] = groupRows(rows, ['campaign_name']);
    expect(group?.dimensions).toEqual({ campaign_name: 'Campaign' });
    expect(resolveField(group as GridRow, 'bid')).toBeNull();
  });

  it('unions tag ids across members', () => {
    const rows = [
      { ...row('a', 'C', { spend: 1 }), tagIds: ['brand'] },
      { ...row('b', 'C', { spend: 1 }), tagIds: ['generic', 'brand'] },
    ];
    const [group] = groupRows(rows, ['campaign_name']);
    expect(group?.tagIds).toEqual(['brand', 'generic']);
  });

  it('counts every source row it folded', () => {
    const rows = syntheticSearchTermRows(1000, { seed: 3 });
    const groups = groupRows(rows, ['campaign_name']);
    const folded = groups.reduce((sum, group) => sum + group.groupSize, 0);
    expect(folded).toBe(rows.length);
  });

  it('builds three ordered levels without losing source rows or base metrics', () => {
    const rows = syntheticSearchTermRows(3_597, { seed: 31 });
    const groups = groupRows(rows, ['campaign_name', 'ad_group_name', 'match_type']);
    const deepest = groups.filter((group) => group.isLeafGroup);
    const inputSpend = rows.reduce((sum, item) => sum + item.totals.spend, 0);

    expect(new Set(groups.map((group) => group.groupDepth))).toEqual(new Set([0, 1, 2]));
    expect(deepest.reduce((sum, group) => sum + group.groupSize, 0)).toBe(rows.length);
    expect(deepest.reduce((sum, group) => sum + group.totals.spend, 0)).toBeCloseTo(inputSpend, 6);

    for (const depth of [0, 1, 2]) {
      const level = groups.filter((group) => group.groupDepth === depth);
      expect(level.reduce((sum, group) => sum + group.groupSize, 0)).toBe(rows.length);
      expect(level.reduce((sum, group) => sum + group.totals.spend, 0)).toBeCloseTo(inputSpend, 6);
    }

    for (const group of groups) {
      expect(resolveField(group, 'acos')).toEqual(deriveMetric('acos', group.totals));
      expect(resolveField(group, 'ctr')).toEqual(deriveMetric('ctr', group.totals));
    }

    for (const group of groups.filter((candidate) => candidate.groupDepth > 0)) {
      expect(groups.some((candidate) => candidate.id === group.parentGroupId)).toBe(true);
      expect(group.groupPath).toHaveLength(group.groupDepth + 1);
      expect(group.groupColumnId).toBe(group.groupBy[group.groupDepth]);
    }
  });

  it('uses deterministic, collision-safe hierarchy identities', () => {
    const rows = syntheticSearchTermRows(200, { seed: 17 });
    const levels = ['campaign_name', 'ad_group_name', 'match_type'];
    const forward = groupRows(rows, levels).map((group) => group.id).sort();
    const reverse = groupRows([...rows].reverse(), levels).map((group) => group.id).sort();
    expect(reverse).toEqual(forward);

    const awkward = [
      {
        ...rows[0]!,
        id: 'awkward-string',
        dimensions: { ...rows[0]!.dimensions, campaign_name: 'a\u0000b', match_type: '1' },
      },
      {
        ...rows[1]!,
        id: 'awkward-number',
        dimensions: { ...rows[1]!.dimensions, campaign_name: 'a', match_type: 1 },
      },
    ];
    const ids = groupRows(awkward, ['campaign_name', 'match_type']).map((group) => group.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('deduplicates repeated dimensions without changing their order', () => {
    expect(uniqueGroupLevels(['campaign_name', 'match_type', 'campaign_name', '', 'ad_product']))
      .toEqual(['campaign_name', 'match_type', 'ad_product']);
  });
});

describe('currency', () => {
  it('refuses to aggregate across currencies', () => {
    const rows = [
      row('a', 'C', { spend: 10 }, null, 'USD'),
      row('b', 'C', { spend: 10 }, null, 'EUR'),
    ];
    expect(() => groupRows(rows, ['campaign_name'])).toThrow(MixedCurrencyError);
    expect(() => grandTotal(rows)).toThrow(MixedCurrencyError);
    expect(() => assertSingleCurrency(rows)).toThrow(/USD, EUR|EUR, USD/);
  });

  it('reports the single currency in play, and null for an empty set', () => {
    expect(assertSingleCurrency([row('a', 'C', {}, null, 'JPY')])).toBe('JPY');
    expect(assertSingleCurrency([])).toBeNull();
  });
});

describe('grandTotal', () => {
  it('equals the sum of the group totals', () => {
    const rows = syntheticSearchTermRows(2000, { seed: 11 });
    const groups = groupRows(rows, ['campaign_name']);
    const total = grandTotal(rows);
    const summedFromGroups = groups.reduce((sum, group) => sum + group.totals.spend, 0);
    expect(total?.totals.spend).toBeCloseTo(summedFromGroups, 6);
  });

  it('is null on an empty set rather than a row of zeroes', () => {
    expect(grandTotal([])).toBeNull();
  });
});
