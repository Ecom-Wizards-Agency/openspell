/**
 * N-gram rows and columns for the shared DataGrid.
 *
 * The explorer reuses WP-06's grid rather than growing a second table: sorting,
 * filtering, column widths, pinning and CSV export are already solved there and
 * an n-gram set is exactly the kind of thing an operator sorts by spend and
 * scans. This module is the adapter and nothing else — it does not touch the
 * grid's internals.
 *
 * The grid's governing rule holds here for free: a `GridRow` carries only base
 * sums, so CVR, ACOS, CPC and RPC on an n-gram row are derived at display time
 * from `sum(orders)/sum(clicks)` and friends. There is no ratio on the row that
 * a group-by could average.
 *
 * One honesty note the UI repeats to the reader: **gram totals overlap and do
 * not sum to account spend**, because a search term's spend is attributed to
 * every gram it contains. `search_terms` (how many distinct terms a gram
 * appeared in) is the column that keeps that visible.
 */
import type { NgramRow } from '@wizard-ads/core';
import type { GridColumn, GridRow } from '@wizard-ads/ui';

export const GRAM_SIZES = [1, 2, 3] as const;
export type GramSize = (typeof GRAM_SIZES)[number];

export const GRAM_SIZE_LABELS: Record<GramSize, string> = {
  1: 'Unigrams',
  2: 'Bigrams',
  3: 'Trigrams',
};

const dimension = (id: string, header: string, options: Partial<GridColumn> = {}): GridColumn => ({
  id,
  header,
  kind: 'dimension',
  scale: 'text',
  align: 'left',
  width: 220,
  ...options,
});

const metric = (
  id: string,
  header: string,
  scale: GridColumn['scale'],
  description: string,
): GridColumn => ({
  id,
  header,
  kind: 'metric',
  scale,
  align: 'right',
  width: 104,
  description,
});

/**
 * The explorer's columns.
 *
 * Single columns, not the grid's four-column comparison set: an n-gram set has
 * no comparison period, and shipping empty `(prev)` and delta columns would be
 * three plausible blanks per metric.
 */
export function ngramColumns(): GridColumn[] {
  return [
    dimension('gram', 'Gram', { pinned: true, width: 260 }),
    dimension('n', 'n', { width: 56, align: 'right', scale: 'integer', filterKind: 'numeric' }),
    dimension('search_terms', 'Search terms', {
      width: 120,
      align: 'right',
      scale: 'integer',
      filterKind: 'numeric',
      description: 'Distinct search terms this gram appeared in. Gram totals overlap; this is the honesty column.',
    }),
    metric('impressions', 'Impressions', 'integer', 'Pooled impressions of every term containing the gram.'),
    metric('clicks', 'Clicks', 'integer', 'Pooled clicks. The evidence behind every ratio to the right.'),
    metric('spend', 'Spend', 'money', 'Pooled spend. Overlaps across grams by construction.'),
    metric('sales', 'Sales', 'money', 'Pooled attributed sales.'),
    metric('orders', 'Orders', 'integer', 'Pooled attributed purchases.'),
    metric('ctr', 'CTR', 'percent', 'clicks / impressions, recomputed at this level.'),
    metric('cvr', 'CVR', 'percent', 'orders / clicks, recomputed at this level.'),
    metric('cpc', 'CPC', 'money', 'spend / clicks.'),
    metric('rpc', 'RPC', 'money', 'sales / clicks — the input to every White Box bid.'),
    metric('acos', 'ACOS', 'percent', 'spend / sales, recomputed at this level.'),
  ];
}

export const DEFAULT_NGRAM_COLUMNS = [
  'gram',
  'n',
  'search_terms',
  'clicks',
  'spend',
  'sales',
  'orders',
  'cvr',
  'rpc',
  'acos',
];

/** N-gram rows to grid rows. Base sums only; every ratio is derived on display. */
export function toGridRows(rows: readonly NgramRow[], currencyCode: string): GridRow[] {
  return rows.map((row) => ({
    id: `${row.n}:${row.gram}`,
    dimensions: {
      gram: row.gram,
      n: row.n,
      search_terms: row.searchTerms,
    },
    totals: {
      impressions: row.impressions,
      clicks: row.clicks,
      spend: row.cost,
      sales: row.sales,
      orders: row.purchases,
      // The search-term fact carries units alongside purchases; the n-gram
      // aggregation does not, so units is left equal to orders rather than
      // invented. No column shows it.
      units: row.purchases,
    },
    comparison: null,
    currencyCode,
  }));
}
