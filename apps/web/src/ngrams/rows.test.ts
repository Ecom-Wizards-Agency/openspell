/**
 * The n-gram to grid-row adapter.
 *
 * The assertion that matters: **no ratio is stored on a row.** The grid derives
 * CVR, ACOS, RPC and CPC from base sums at whatever level it is displaying, and
 * that only holds if the adapter hands it sums. A row carrying a precomputed
 * ACOS would be summable, and a summed ACOS is the most common quietly wrong
 * number in ads tooling.
 */
import { describe, expect, it } from 'vitest';
import { aggregateNgrams } from '@wizard-ads/core';
import type { SearchTermRow } from '@wizard-ads/core';
import { resolveField } from '@wizard-ads/ui';
import { DEFAULT_NGRAM_COLUMNS, ngramColumns, toGridRows } from './rows';

const TERMS: SearchTermRow[] = [
  { searchTerm: 'blue widget', impressions: 100, clicks: 10, cost: 5, purchases7d: 1, sales7d: 25 },
  { searchTerm: 'blue widget set', impressions: 50, clicks: 4, cost: 2, purchases7d: 0, sales7d: 0 },
  { searchTerm: 'red widget', impressions: 20, clicks: 2, cost: 1, purchases7d: 0, sales7d: 0 },
];

describe('toGridRows', () => {
  it('carries base sums only, and derives every ratio at display time', () => {
    const grams = aggregateNgrams(TERMS, { sizes: [1] });
    const rows = toGridRows(grams, 'USD');
    const widget = rows.find((row) => row.dimensions['gram'] === 'widget');
    expect(widget).toBeDefined();
    if (widget === undefined) return;

    // Pooled over all three terms.
    expect(widget.totals).toEqual({
      impressions: 170,
      clicks: 16,
      spend: 8,
      sales: 25,
      orders: 1,
      units: 1,
    });
    // No ratio anywhere on the row...
    expect(Object.keys(widget.totals)).not.toContain('acos');
    expect(Object.keys(widget.dimensions)).toEqual(['gram', 'n', 'search_terms']);
    // ...but every ratio resolves from the sums.
    expect(resolveField(widget, 'acos')).toBeCloseTo(8 / 25, 6);
    expect(resolveField(widget, 'cvr')).toBeCloseTo(1 / 16, 6);
    expect(resolveField(widget, 'rpc')).toBeCloseTo(25 / 16, 6);
    // The honesty column: three distinct terms contained this gram.
    expect(widget.dimensions['search_terms']).toBe(3);
    expect(widget.comparison).toBeNull();
  });

  it('gives every row a stable id that separates the same text at two sizes', () => {
    const grams = aggregateNgrams(TERMS, { sizes: [1, 2] });
    const rows = toGridRows(grams, 'USD');
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(rows.some((row) => row.id === '1:widget')).toBe(true);
    expect(rows.some((row) => row.id === '2:blue widget')).toBe(true);
  });
});

describe('ngramColumns', () => {
  it('offers single columns, not the grid\'s comparison set', () => {
    const ids = ngramColumns().map((column) => column.id);
    expect(ids).toContain('spend');
    // An n-gram set has no comparison period; shipping the deltas would be
    // three plausible blanks per metric.
    expect(ids.some((id) => id.endsWith('_comparison'))).toBe(false);
    expect(ids.some((id) => id.endsWith('_delta_percent'))).toBe(false);
    for (const id of DEFAULT_NGRAM_COLUMNS) expect(ids).toContain(id);
  });

  it('marks count dimensions as numeric filters', () => {
    const byId = new Map(ngramColumns().map((column) => [column.id, column]));
    expect(byId.get('n')?.filterKind).toBe('numeric');
    expect(byId.get('search_terms')?.filterKind).toBe('numeric');
    expect(byId.get('gram')?.filterKind).toBeUndefined();
  });
});
