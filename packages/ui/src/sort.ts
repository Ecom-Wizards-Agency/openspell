/**
 * Multi-column sorting.
 *
 * Two decisions worth stating:
 *
 *  - **Nulls sort last in both directions.** Sorting by ACOS descending to find
 *    the worst offenders should not put every zero-sales row at the top just
 *    because their ACOS is undefined; sorting ascending should not put them
 *    there either. Absent is not extreme, it is absent.
 *  - **The sort is stable.** Rows equal on every active key keep their incoming
 *    order, so adding a third sort key never reshuffles the two above it.
 */
import type { DimensionValue, GridRow } from './rows.js';
import { fieldAccessor, resolveField } from './rows.js';

export interface SortRule {
  columnId: string;
  direction: 'asc' | 'desc';
}

/**
 * One collator, reused.
 *
 * `String.prototype.localeCompare` builds a collator on every call. On the 50k
 * fixture, a three-key sort spent 1.5 seconds doing almost nothing else. A
 * hoisted `Intl.Collator` is the same comparison an order of magnitude cheaper.
 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareValues(a: DimensionValue, b: DimensionValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return collator.compare(String(a), String(b));
}

const isMissing = (value: DimensionValue): boolean =>
  value === null || value === undefined || value === '';

export function compareRows(a: GridRow, b: GridRow, rules: readonly SortRule[]): number {
  for (const rule of rules) {
    const left = resolveField(a, rule.columnId);
    const right = resolveField(b, rule.columnId);
    if (isMissing(left) && isMissing(right)) continue;
    if (isMissing(left)) return 1;
    if (isMissing(right)) return -1;
    const result = compareValues(left, right);
    if (result !== 0) return rule.direction === 'asc' ? result : -result;
  }
  return 0;
}

/**
 * Stable multi-sort. Returns a new array; the input is never mutated.
 *
 * Sort keys are resolved once per row per rule rather than inside the
 * comparator, which would evaluate them O(n log n) times. On 50k rows that is
 * the difference between one derived-metric computation each and roughly
 * seventeen.
 */
export function applySort(rows: readonly GridRow[], rules: readonly SortRule[]): GridRow[] {
  if (rules.length === 0 || rows.length < 2) return rows as GridRow[];

  const count = rows.length;
  const keys: DimensionValue[][] = rules.map((rule) => {
    const read = fieldAccessor(rule.columnId);
    const column: DimensionValue[] = new Array<DimensionValue>(count);
    for (let i = 0; i < count; i += 1) column[i] = read(rows[i] as GridRow);
    return column;
  });
  const descending = rules.map((rule) => rule.direction === 'desc');

  const order = new Array<number>(count);
  for (let i = 0; i < count; i += 1) order[i] = i;

  order.sort((ia, ib) => {
    for (let r = 0; r < keys.length; r += 1) {
      const column = keys[r] as DimensionValue[];
      const left = column[ia] as DimensionValue;
      const right = column[ib] as DimensionValue;
      const leftMissing = isMissing(left);
      const rightMissing = isMissing(right);
      if (leftMissing && rightMissing) continue;
      if (leftMissing) return 1;
      if (rightMissing) return -1;
      const result = compareValues(left, right);
      if (result !== 0) return descending[r] === true ? -result : result;
    }
    return ia - ib;
  });

  const out: GridRow[] = new Array<GridRow>(count);
  for (let i = 0; i < count; i += 1) out[i] = rows[order[i] as number] as GridRow;
  return out;
}

/**
 * Click behaviour: first click sorts descending (the useful direction for a
 * metric), second ascending, third removes the key. Shift-click appends rather
 * than replacing, which is what makes multi-sort discoverable.
 */
export function toggleSort(
  rules: readonly SortRule[],
  columnId: string,
  append: boolean,
): SortRule[] {
  const existing = rules.find((rule) => rule.columnId === columnId);
  const others = append ? rules.filter((rule) => rule.columnId !== columnId) : [];

  if (existing === undefined) return [...others, { columnId, direction: 'desc' }];
  if (existing.direction === 'desc') return [...others, { columnId, direction: 'asc' }];
  return [...others];
}
