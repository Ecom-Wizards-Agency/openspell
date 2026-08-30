/** Pure categorical option derivation for the in-memory Grid. */
import type { GridRow } from './rows.js';
import { fieldAccessor } from './rows.js';

export interface FilterOption {
  /** Exact value stored in FilterCondition.values. */
  value: string;
  /** Calm operator-facing label; never interpreted as HTML. */
  label: string;
}

/**
 * Build stable options from the complete authorized result set.
 *
 * Case variants collapse under the same semantics as IN/NOT_IN. The first
 * observed spelling remains the value so saved-view chips look like the data.
 */
export function buildCategoricalOptions(
  rows: readonly GridRow[],
  columnId: string,
): FilterOption[] {
  const read = fieldAccessor(columnId);
  const byNormalized = new Map<string, FilterOption>();
  for (const row of rows) {
    const actual = read(row);
    if (actual === null || actual === undefined) continue;
    const value = String(actual).trim();
    if (value === '') continue;
    const normalized = value.toLowerCase();
    if (byNormalized.has(normalized)) continue;
    byNormalized.set(normalized, {
      value,
      label: actual === true ? 'Yes' : actual === false ? 'No' : value,
    });
  }
  return [...byNormalized.values()].sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: 'base' }),
  );
}

export function searchFilterOptions(
  options: readonly FilterOption[],
  search: string,
): FilterOption[] {
  const query = search.trim().toLowerCase();
  if (query === '') return options as FilterOption[];
  return options.filter((option) => option.label.toLowerCase().includes(query));
}

/** Union selected values with all searched options, preserving option order. */
export function selectAllFilterOptions(
  selected: readonly string[],
  matching: readonly FilterOption[],
): string[] {
  const wanted = new Set(selected.map((value) => value.toLowerCase()));
  const next = [...selected];
  for (const option of matching) {
    const normalized = option.value.toLowerCase();
    if (wanted.has(normalized)) continue;
    wanted.add(normalized);
    next.push(option.value);
  }
  return next;
}

export function toggleFilterOption(selected: readonly string[], value: string): string[] {
  const normalized = value.toLowerCase();
  if (selected.some((candidate) => candidate.toLowerCase() === normalized)) {
    return selected.filter((candidate) => candidate.toLowerCase() !== normalized);
  }
  return [...selected, value];
}
