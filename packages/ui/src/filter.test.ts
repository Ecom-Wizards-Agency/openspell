import { describe, expect, it } from 'vitest';
import {
  FilterError,
  applyFilterSet,
  evaluateFilter,
  filterKeyToColumnId,
  filterSetOf,
  matchesFilterSet,
  validateFilterSet,
} from './filter.js';
import { syntheticSearchTermRows } from './fixtures.js';
import { buildGridModel, buildGridModelSafely } from './pipeline.js';
import type { GridRow } from './rows.js';

const zero = { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0, units: 0 };

function row(overrides: Partial<GridRow> = {}): GridRow {
  return {
    id: 'r1',
    dimensions: { campaign_name: 'Dev | SP | Rank | Widget', campaign_state: 'enabled', bid: 0.75 },
    totals: { ...zero, impressions: 1000, clicks: 50, spend: 40, sales: 100, orders: 5, units: 5 },
    comparison: { ...zero, impressions: 900, clicks: 40, spend: 20, sales: 100, orders: 5, units: 5 },
    currencyCode: 'USD',
    ...overrides,
  };
}

describe('the key mapping', () => {
  it('is a lowercase, and nothing else', () => {
    expect(filterKeyToColumnId('CAMPAIGN_NAME')).toBe('campaign_name');
    expect(filterKeyToColumnId('ACOS_DELTA_PERCENT')).toBe('acos_delta_percent');
  });
});

describe('metric filters', () => {
  it('reads percent-scaled thresholds as percents', () => {
    // Row ACOS is 40/100 = 0.4. The operator types 30, meaning 30%.
    expect(evaluateFilter(row(), { key: 'ACOS', conditions: [{ operator: '>', values: ['30'] }] })).toBe(true);
    expect(evaluateFilter(row(), { key: 'ACOS', conditions: [{ operator: '>', values: ['50'] }] })).toBe(false);
  });

  it('tolerates a typed percent sign and thousands separators', () => {
    expect(evaluateFilter(row(), { key: 'ACOS', conditions: [{ operator: '>', values: ['30%'] }] })).toBe(true);
    expect(
      evaluateFilter(row(), { key: 'IMPRESSIONS', conditions: [{ operator: '>=', values: ['1,000'] }] }),
    ).toBe(true);
  });

  it('combines conditions on one key with an explicit logical operator', () => {
    const between = {
      key: 'ACOS',
      conditions: [
        { operator: '>=' as const, values: ['30'] },
        { operator: '<=' as const, values: ['50'] },
      ],
      logical_operator: 'AND' as const,
    };
    expect(evaluateFilter(row(), between)).toBe(true);

    const either = { ...between, logical_operator: 'OR' as const };
    expect(evaluateFilter(row(), either)).toBe(true);
  });

  it('never matches a null value, in either direction', () => {
    // No sales: ACOS is undefined, not zero, and not infinite.
    const noSales = row({ totals: { ...zero, clicks: 10, spend: 25 } });
    expect(evaluateFilter(noSales, { key: 'ACOS', conditions: [{ operator: '>', values: ['30'] }] })).toBe(false);
    expect(evaluateFilter(noSales, { key: 'ACOS', conditions: [{ operator: '<', values: ['30'] }] })).toBe(false);
    // ...and IS_NULL is how you actually find those rows.
    expect(evaluateFilter(noSales, { key: 'ACOS', conditions: [{ operator: 'IS_NULL', values: [] }] })).toBe(true);
  });

  it('rejects a non-numeric threshold rather than matching nothing quietly', () => {
    expect(() =>
      evaluateFilter(row(), { key: 'SPEND', conditions: [{ operator: '>', values: ['lots'] }] }),
    ).toThrow(FilterError);
  });
});

describe('text filters', () => {
  it('LIKE is a case-insensitive contains, over any of the values', () => {
    expect(
      evaluateFilter(row(), { key: 'CAMPAIGN_NAME', conditions: [{ operator: 'LIKE', values: ['rank'] }] }),
    ).toBe(true);
    expect(
      evaluateFilter(row(), { key: 'CAMPAIGN_NAME', conditions: [{ operator: 'LIKE', values: ['nope', 'widget'] }] }),
    ).toBe(true);
  });

  it('IN and NOT_IN are exact, not substring', () => {
    expect(
      evaluateFilter(row(), { key: 'CAMPAIGN_STATE', conditions: [{ operator: 'IN', values: ['enabled', 'paused'] }] }),
    ).toBe(true);
    expect(
      evaluateFilter(row(), { key: 'CAMPAIGN_STATE', conditions: [{ operator: 'NOT_IN', values: ['archived'] }] }),
    ).toBe(true);
  });

  it('normalizes surrounding whitespace for exact categorical matches', () => {
    const padded = row({ dimensions: { ...row().dimensions, campaign_state: ' Enabled ' } });
    expect(
      evaluateFilter(padded, {
        key: 'CAMPAIGN_STATE',
        conditions: [{ operator: 'IN', values: ['Enabled'] }],
      }),
    ).toBe(true);
    expect(
      evaluateFilter(padded, {
        key: 'CAMPAIGN_STATE',
        conditions: [{ operator: 'NOT_IN', values: [' enabled '] }],
      }),
    ).toBe(false);
  });

  it('keeps surrounding whitespace significant for free-text equality', () => {
    const padded = row({
      dimensions: { ...row().dimensions, campaign_name: ' Rank campaign ' },
    });
    expect(
      evaluateFilter(padded, {
        key: 'CAMPAIGN_NAME',
        conditions: [{ operator: '=', values: ['Rank campaign'] }],
      }),
    ).toBe(false);
    expect(
      evaluateFilter(padded, {
        key: 'CAMPAIGN_NAME',
        conditions: [{ operator: '=', values: [' Rank campaign '] }],
      }),
    ).toBe(true);
  });

  it('compares a numeric dimension numerically', () => {
    expect(evaluateFilter(row(), { key: 'BID', conditions: [{ operator: '>', values: ['0.5'] }] })).toBe(true);
    expect(evaluateFilter(row(), { key: 'BID', conditions: [{ operator: '>', values: ['1.5'] }] })).toBe(false);
  });
});

describe('the _NOT twin', () => {
  it('negates the whole filter, so precedence is never ambiguous', () => {
    const contains = { key: 'CAMPAIGN_NAME', conditions: [{ operator: 'LIKE' as const, values: ['rank'] }] };
    expect(evaluateFilter(row(), contains)).toBe(true);
    expect(evaluateFilter(row(), { ...contains, key: 'CAMPAIGN_NAME_NOT' })).toBe(false);
  });
});

describe('delta meta-filters', () => {
  it('take the metric as the first condition and the threshold after it', () => {
    // Spend 40 vs 20 = +100%.
    const worse = {
      key: 'DELTA_PERCENT',
      conditions: [{ values: ['SPEND'] }, { operator: '>' as const, values: ['50'] }],
    };
    expect(evaluateFilter(row(), worse)).toBe(true);

    const absolute = {
      key: 'DELTA_ABSOLUTE',
      conditions: [{ values: ['SPEND'] }, { operator: '>=' as const, values: ['20'] }],
    };
    expect(evaluateFilter(row(), absolute)).toBe(true);
  });

  it('reject an unknown metric by name', () => {
    expect(() =>
      evaluateFilter(row(), { key: 'DELTA_PERCENT', conditions: [{ values: ['NONSENSE'] }] }),
    ).toThrow(FilterError);
  });
});

describe('tag filters', () => {
  it('are the whole tag interface: any-of, and its negation', () => {
    const tagged = row({ tagIds: ['brand', 'hero'] });
    expect(evaluateFilter(tagged, { key: 'TAG', conditions: [{ values: ['brand'] }] })).toBe(true);
    expect(evaluateFilter(tagged, { key: 'TAG', conditions: [{ values: ['generic'] }] })).toBe(false);
    expect(evaluateFilter(tagged, { key: 'TAG_NOT', conditions: [{ values: ['generic'] }] })).toBe(true);
    expect(evaluateFilter(row(), { key: 'TAG', conditions: [{ values: ['brand'] }] })).toBe(false);
  });
});

describe('groups', () => {
  it('AND inside a group, OR between groups', () => {
    const set = {
      groups: [
        {
          filters: [
            { key: 'ACOS', conditions: [{ operator: '>' as const, values: ['90'] }] },
            { key: 'SPEND', conditions: [{ operator: '>' as const, values: ['1'] }] },
          ],
        },
        { filters: [{ key: 'CAMPAIGN_NAME', conditions: [{ operator: 'LIKE' as const, values: ['rank'] }] }] },
      ],
    };
    // First group fails (ACOS is 40%), second matches.
    expect(matchesFilterSet(row(), set)).toBe(true);
  });

  it('an empty set matches everything and returns the same array', () => {
    const rows = syntheticSearchTermRows(50, { seed: 5 });
    expect(applyFilterSet(rows, { groups: [] })).toBe(rows);
  });

  it('filters a real set down and never invents rows', () => {
    const rows = syntheticSearchTermRows(5000, { seed: 5 });
    const kept = applyFilterSet(rows, filterSetOf({ key: 'CLICKS', conditions: [{ operator: '>=', values: ['10'] }] }));
    expect(kept.length).toBeLessThan(rows.length);
    expect(kept.every((r) => r.totals.clicks >= 10)).toBe(true);
    // Rule 4, mechanically: outputs counted against inputs.
    const manual = rows.filter((r) => r.totals.clicks >= 10).length;
    expect(kept.length).toBe(manual);
  });
});

describe('a filter this build refuses', () => {
  /**
   * Regression guard. The toolbar could emit `SEARCH_TERM > x` — a numeric
   * operator on a text column — because its operator `<select>` displayed the
   * first option while its state still held the previous column's operator.
   * `buildGridModelSafely` is what keeps that from blanking the page.
   */
  it('degrades to the unfiltered set instead of throwing out of a render', () => {
    const rows = syntheticSearchTermRows(200, { seed: 8 });
    const bad = filterSetOf({ key: 'SEARCH_TERM', conditions: [{ operator: '>', values: ['x'] }] });

    expect(() => buildGridModel(rows, { filter: bad })).toThrow(FilterError);

    const safe = buildGridModelSafely(rows, { filter: bad, sort: [{ columnId: 'spend', direction: 'desc' }] });
    expect(safe.filterError).toContain('not valid on a text column');
    expect(safe.model.shown).toBe(rows.length);
    // The rest of the query still applies: only the filter was dropped.
    expect(safe.model.rows[0]?.totals.spend).toBeGreaterThanOrEqual(
      safe.model.rows[1]?.totals.spend ?? 0,
    );
  });

  it('reports null when the query was accepted in full', () => {
    const rows = syntheticSearchTermRows(50, { seed: 9 });
    const good = filterSetOf({ key: 'CLICKS', conditions: [{ operator: '>=', values: ['1'] }] });
    expect(buildGridModelSafely(rows, { filter: good }).filterError).toBeNull();
  });

  it('does not swallow errors that are not about the filter', () => {
    const rows = syntheticSearchTermRows(4, { seed: 9 });
    const mixed = [...rows, { ...(rows[0] as GridRow), id: 'eur', currencyCode: 'EUR' }];
    expect(() => buildGridModelSafely(mixed)).toThrow(/refusing to aggregate across currencies/);
  });
});

describe('validateFilterSet', () => {
  it('names the offending key instead of silently matching nothing', () => {
    const problems = validateFilterSet(
      filterSetOf({ key: 'NOT_A_COLUMN', conditions: [{ operator: '=', values: ['x'] }] }),
      ['campaign_name'],
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('NOT_A_COLUMN');
  });

  it('accepts metric keys without needing them in the column list', () => {
    expect(validateFilterSet(filterSetOf({ key: 'ACOS', conditions: [{ operator: '>', values: ['1'] }] }), [])).toEqual([]);
  });

  it('flags a filter with no conditions', () => {
    expect(validateFilterSet(filterSetOf({ key: 'ACOS', conditions: [] }), [])).toHaveLength(1);
  });
});
