/**
 * Filter, then group, then sort, then total. One function, one order, one place
 * the counts come from.
 *
 * The order matters and is not negotiable. Grouping before filtering would let
 * a filter on ACOS drop groups whose members individually failed it; sorting
 * before grouping would be wasted work on rows about to be folded away. And the
 * counts (`total`, `shown`) are produced here rather than by the caller, because
 * "exported N of M" on the export button has to be the same N and M the grid
 * footer shows -- if two call sites compute them, one of them is eventually
 * wrong and nobody notices.
 */
import type { GroupedRow } from './aggregate.js';
import { grandTotal, groupRows } from './aggregate.js';
import type { FilterSet } from './filter.js';
import { FilterError, applyFilterSet } from './filter.js';
import type { GridRow } from './rows.js';
import type { SortRule } from './sort.js';
import { applySort } from './sort.js';

export interface GridQuery {
  filter?: FilterSet;
  sort?: readonly SortRule[];
  /** Dimension column ids. Empty means no grouping. */
  groupBy?: readonly string[];
}

export interface GridModel {
  /** The rows to render, in display order. */
  rows: GridRow[];
  /** Rows before filtering. */
  total: number;
  /** Rows after filtering, before grouping. */
  matched: number;
  /** Rows on screen (equals `matched` when not grouping). */
  shown: number;
  /** Sums over the filtered set. Null on an empty result. */
  totalsRow: GroupedRow | null;
  grouped: boolean;
}

/**
 * The model, or the unfiltered model plus the reason the filter was rejected.
 *
 * Filters come from three places an implementer does not control: a toolbar a
 * human is typing into, a saved view written by an older build, and a shared
 * deep link. All three can carry a filter this build refuses -- an operator on
 * the wrong column type, a metric that no longer exists. None of them may take
 * the page down, and the ungrouped rows are still worth showing while the
 * operator fixes the filter, so a rejected filter degrades to "here is
 * everything, and here is what was wrong with what you asked for".
 *
 * A thrown `FilterError` from inside a render is how this was found: it blanked
 * the grid, which is the one outcome worse than an unhelpful filter.
 */
export interface GridModelResult {
  model: GridModel;
  /** Null when the query was accepted in full. */
  filterError: string | null;
}

export function buildGridModelSafely(
  rows: readonly GridRow[],
  query: GridQuery = {},
): GridModelResult {
  try {
    return { model: buildGridModel(rows, query), filterError: null };
  } catch (error) {
    if (!(error instanceof FilterError)) throw error;
    const withoutFilter: GridQuery = { ...query };
    delete withoutFilter.filter;
    return { model: buildGridModel(rows, withoutFilter), filterError: error.message };
  }
}

export function buildGridModel(rows: readonly GridRow[], query: GridQuery = {}): GridModel {
  const filtered = query.filter ? applyFilterSet(rows, query.filter) : (rows as GridRow[]);
  const groupBy = query.groupBy ?? [];
  const grouped = groupBy.length > 0;
  const shaped: GridRow[] = grouped ? groupRows(filtered, groupBy) : filtered;
  const sorted = applySort(shaped, query.sort ?? []);

  return {
    rows: sorted,
    total: rows.length,
    matched: filtered.length,
    shown: sorted.length,
    // Totals always come from the pre-grouping filtered set: summing group rows
    // and summing their members give the same base sums, but only one of them
    // stays right if grouping ever drops a row.
    totalsRow: grandTotal(filtered),
    grouped,
  };
}
