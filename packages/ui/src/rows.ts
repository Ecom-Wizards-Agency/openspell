/**
 * The grid's row model and its field resolver.
 *
 * A `GridRow` carries base sums, never derived metrics. Everything a cell,
 * a filter or a sort comparator asks for is computed on demand by
 * `resolveField`, which is why a 50k-row grid can sort by ACOS without ever
 * materialising 50k ACOS values it is about to throw away -- and why a group-by
 * cannot accidentally sum a ratio: there is no ratio on the row to sum.
 *
 * ## The four-column metric model
 *
 * Recon (`02-data-grid.md` §2) : every metric ships as four columns.
 *
 *   acos                  selected period
 *   acos_comparison       the comparison period
 *   acos_delta_absolute   difference
 *   acos_delta_percent    relative change
 *
 * The comparison period defaults to the immediately preceding period of the
 * same length, which is what lets every grid show a delta without the operator
 * choosing a baseline. We copy that default.
 *
 * One convention, stated once, because the recon records AdLabs shipping two:
 * **`_delta_percent` is always a fraction** (0.1 means +10%), on every entity,
 * for every metric. `_delta_absolute` is in the metric's own unit, so for a
 * percent-scaled metric it is a difference of fractions -- percentage points.
 */
import type { BaseTotals } from './metrics.js';
import { deriveMetric, metricSpec, safeRatio } from './metrics.js';

export const COMPARISON_SUFFIX = '_comparison';
export const DELTA_ABSOLUTE_SUFFIX = '_delta_absolute';
export const DELTA_PERCENT_SUFFIX = '_delta_percent';

/** A dimension value. Numbers that are identifiers, not measurements, live here. */
export type DimensionValue = string | number | boolean | null;

export interface GridRow {
  /** Stable across renders and re-sorts. The virtualizer's key. */
  id: string;
  /** Non-metric columns: ids, names, states, bids, dates. */
  dimensions: Record<string, DimensionValue>;
  /** Selected-period base sums. */
  totals: BaseTotals;
  /**
   * Comparison-period base sums, or null when the comparison window holds no
   * row for this entity. Null propagates to every delta rather than being
   * treated as zero: an entity that did not exist last week did not have zero
   * spend, it had no spend figure at all.
   */
  comparison: BaseTotals | null;
  /** The profile's currency. Mixing these in one view is a bug; see `assertSingleCurrency`. */
  currencyCode: string;
  /**
   * Tag ids on this row. WP-08 owns tags; the grid only needs the ids to make
   * `TAG` / `TAG_NOT` filter keys work, which is the whole tag interface here.
   */
  tagIds?: readonly string[];
}

export interface FieldRef {
  metric: string;
  part: 'value' | 'comparison' | 'delta_absolute' | 'delta_percent';
}

/**
 * Split a column id into metric plus part. Returns null for a dimension column,
 * which is how `resolveField` decides where to look.
 */
export function parseFieldId(columnId: string): FieldRef | null {
  for (const [suffix, part] of [
    [DELTA_ABSOLUTE_SUFFIX, 'delta_absolute'],
    [DELTA_PERCENT_SUFFIX, 'delta_percent'],
    [COMPARISON_SUFFIX, 'comparison'],
  ] as const) {
    if (columnId.endsWith(suffix)) {
      const metric = columnId.slice(0, -suffix.length);
      return metricSpec(metric) ? { metric, part } : null;
    }
  }
  return metricSpec(columnId) ? { metric: columnId, part: 'value' } : null;
}

/**
 * The value behind any column id, for any row.
 *
 * Metric columns are derived from base sums here and nowhere else. Dimension
 * columns are read straight off `dimensions`. An unknown id is `null`, never a
 * thrown error: a saved view that names a column the current entity level does
 * not have should render an empty cell, not blank the page.
 */
export function resolveField(row: GridRow, columnId: string): DimensionValue {
  const ref = parseFieldId(columnId);
  if (ref === null) return row.dimensions[columnId] ?? null;

  const current = deriveMetric(ref.metric, row.totals);
  if (ref.part === 'value') return current;

  const previous = row.comparison === null ? null : deriveMetric(ref.metric, row.comparison);
  if (ref.part === 'comparison') return previous;
  if (current === null || previous === null) return null;
  if (ref.part === 'delta_absolute') return current - previous;
  return safeRatio(current - previous, Math.abs(previous));
}

/**
 * A resolver bound to one column, built once and called many times.
 *
 * `resolveField` re-parses the column id on every call, which is free at one
 * row and measurable at fifty thousand: the 50k perf suite showed the parse
 * dominating both filtering and sorting. Hot paths (compiled filters, sort keys,
 * CSV rows) take an accessor; one-off lookups keep using `resolveField`.
 */
export function fieldAccessor(columnId: string): (row: GridRow) => DimensionValue {
  const ref = parseFieldId(columnId);
  if (ref === null) return (row) => row.dimensions[columnId] ?? null;

  const { metric, part } = ref;
  if (part === 'value') return (row) => deriveMetric(metric, row.totals);
  if (part === 'comparison') {
    return (row) => (row.comparison === null ? null : deriveMetric(metric, row.comparison));
  }
  if (part === 'delta_absolute') {
    return (row) => {
      if (row.comparison === null) return null;
      const current = deriveMetric(metric, row.totals);
      const previous = deriveMetric(metric, row.comparison);
      return current === null || previous === null ? null : current - previous;
    };
  }
  return (row) => {
    if (row.comparison === null) return null;
    const current = deriveMetric(metric, row.totals);
    const previous = deriveMetric(metric, row.comparison);
    if (current === null || previous === null) return null;
    return safeRatio(current - previous, Math.abs(previous));
  };
}

/** Numeric view of a field, for filters and sorts. Non-numbers are null. */
export function resolveNumber(row: GridRow, columnId: string): number | null {
  const value = resolveField(row, columnId);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** String view of a field, for text filters. */
export function resolveText(row: GridRow, columnId: string): string | null {
  const value = resolveField(row, columnId);
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : String(value);
}
