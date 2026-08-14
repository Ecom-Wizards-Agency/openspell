import { describe, expect, it } from 'vitest';
import { syntheticSearchTermRows } from './fixtures.js';
import type { GridRow } from './rows.js';
import { applySort, compareRows, toggleSort } from './sort.js';

const zero = { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0, units: 0 };

function row(id: string, spend: number, sales: number, name = 'z'): GridRow {
  return {
    id,
    dimensions: { campaign_name: name },
    totals: { ...zero, spend, sales },
    comparison: null,
    currencyCode: 'USD',
  };
}

describe('applySort', () => {
  it('sorts nulls last in both directions', () => {
    // The middle row has no sales, so no ACOS. It belongs at the bottom either way.
    const rows = [row('a', 10, 100), row('b', 10, 0), row('c', 90, 100)];

    const desc = applySort(rows, [{ columnId: 'acos', direction: 'desc' }]);
    expect(desc.map((r) => r.id)).toEqual(['c', 'a', 'b']);

    const asc = applySort(rows, [{ columnId: 'acos', direction: 'asc' }]);
    expect(asc.map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });

  it('is stable: equal rows keep their incoming order', () => {
    const rows = [row('a', 5, 10), row('b', 5, 10), row('c', 5, 10)];
    expect(applySort(rows, [{ columnId: 'spend', direction: 'desc' }]).map((r) => r.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('adding a third key never reshuffles the two above it', () => {
    const rows = [
      row('a', 5, 10, 'Alpha'),
      row('b', 5, 10, 'Alpha'),
      row('c', 5, 10, 'Beta'),
    ];
    const two = applySort(rows, [
      { columnId: 'campaign_name', direction: 'asc' },
      { columnId: 'spend', direction: 'desc' },
    ]);
    const three = applySort(rows, [
      { columnId: 'campaign_name', direction: 'asc' },
      { columnId: 'spend', direction: 'desc' },
      { columnId: 'sales', direction: 'desc' },
    ]);
    expect(three.map((r) => r.id)).toEqual(two.map((r) => r.id));
  });

  it('does not mutate the input', () => {
    const rows = [row('a', 1, 10), row('b', 9, 10)];
    const before = rows.map((r) => r.id);
    applySort(rows, [{ columnId: 'spend', direction: 'desc' }]);
    expect(rows.map((r) => r.id)).toEqual(before);
  });

  it('agrees with the pairwise comparator it replaced', () => {
    const rules = [
      { columnId: 'campaign_name', direction: 'asc' as const },
      { columnId: 'acos', direction: 'desc' as const },
    ];
    const rows = syntheticSearchTermRows(300, { seed: 42 });
    const fast = applySort(rows, rules);
    const slow = [...rows]
      .map((r, index) => ({ r, index }))
      .sort((a, b) => compareRows(a.r, b.r, rules) || a.index - b.index)
      .map((entry) => entry.r);
    expect(fast.map((r) => r.id)).toEqual(slow.map((r) => r.id));
  });

  it('returns the same array when there is nothing to sort', () => {
    const rows = [row('a', 1, 1)];
    expect(applySort(rows, [])).toBe(rows);
  });
});

describe('toggleSort', () => {
  it('cycles descending, ascending, off', () => {
    let rules = toggleSort([], 'spend', false);
    expect(rules).toEqual([{ columnId: 'spend', direction: 'desc' }]);
    rules = toggleSort(rules, 'spend', false);
    expect(rules).toEqual([{ columnId: 'spend', direction: 'asc' }]);
    rules = toggleSort(rules, 'spend', false);
    expect(rules).toEqual([]);
  });

  it('replaces without shift, appends with it', () => {
    const first = toggleSort([], 'spend', false);
    expect(toggleSort(first, 'acos', false)).toEqual([{ columnId: 'acos', direction: 'desc' }]);
    expect(toggleSort(first, 'acos', true)).toEqual([
      { columnId: 'spend', direction: 'desc' },
      { columnId: 'acos', direction: 'desc' },
    ]);
  });
});
