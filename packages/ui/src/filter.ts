/**
 * The filter DSL.
 *
 * Grammar is the recon's, verbatim (`02-data-grid.md` §3), because one filter
 * vocabulary shared by grid, dashboard widget, saved view and deep link is the
 * strongest single design decision in the product we are cloning:
 *
 *   {"key": "ACOS",
 *    "conditions": [{"operator": ">", "values": ["30"]}],
 *    "logical_operator": "AND"}
 *
 * Three properties are copied deliberately:
 *
 *  - `values` is always an array, even for one scalar. A caller that never has
 *    to ask "is this the scalar form or the list form" never gets it wrong.
 *  - Conditions on the same key combine with an explicit `logical_operator`,
 *    so "ACOS between 30 and 60" is one filter, not two that might be OR-ed.
 *  - Exclusion is a separate key (`CAMPAIGN_NAME_NOT`), not a modifier, which
 *    removes the "does NOT_LIKE bind before or after the OR" ambiguity.
 *
 * One thing is deliberately NOT copied. AdLabs uses uppercase filter keys and
 * lowercase result columns, and its own documentation warns callers about the
 * mismatch. Here a filter key is the uppercase spelling of the column id and
 * nothing else, mechanically: `filterKeyToColumnId` is a `toLowerCase()`, and
 * `_NOT` is the only suffix that carries meaning. Two casings, one name.
 *
 * Percent-scaled metrics take percent-shaped values: `ACOS > 30` means 30%,
 * not 3000%, because that is what an operator types. The conversion happens
 * once, here, using the metric registry's `scale` -- never in a caller.
 */
import { metricSpec } from './metrics.js';
import type { GridRow } from './rows.js';
import { DELTA_ABSOLUTE_SUFFIX, DELTA_PERCENT_SUFFIX, fieldAccessor, parseFieldId } from './rows.js';

export type LogicalOperator = 'AND' | 'OR';

export type FilterOperator =
  | '>'
  | '<'
  | '>='
  | '<='
  | '='
  | '<>'
  | 'IN'
  | 'NOT_IN'
  | 'LIKE'
  | 'NOT_LIKE'
  | 'IS_NULL'
  | 'IS_NOT_NULL';

export interface FilterCondition {
  operator?: FilterOperator;
  values: readonly string[];
}

export interface Filter {
  key: string;
  conditions: readonly FilterCondition[];
  logical_operator?: LogicalOperator;
}

/**
 * A filter set: groups of filters. Filters inside a group are AND-ed (the grid
 * default); groups are OR-ed together. One group is the ordinary case and the
 * shape a saved view stores.
 */
export interface FilterGroup {
  filters: readonly Filter[];
}

export interface FilterSet {
  groups: readonly FilterGroup[];
}

export const EMPTY_FILTER_SET: FilterSet = { groups: [] };

/** The two meta keys that take a metric name as their first condition. */
export const DELTA_PERCENT_KEY = 'DELTA_PERCENT';
export const DELTA_ABSOLUTE_KEY = 'DELTA_ABSOLUTE';

/** Tag keys. WP-08 owns tag UI; these are the seam the grid offers it. */
export const TAG_KEY = 'TAG';
export const TAG_NOT_KEY = 'TAG_NOT';

const NEGATED_SUFFIX = '_NOT';

export class FilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilterError';
  }
}

/** `CAMPAIGN_NAME` -> `campaign_name`. The whole mapping. */
export function filterKeyToColumnId(key: string): string {
  return key.toLowerCase();
}

export function columnIdToFilterKey(columnId: string): string {
  return columnId.toUpperCase();
}

/**
 * Percent-scaled metrics are stored as fractions and typed as percents, so
 * `ACOS > 30` has to become `acos > 0.3` exactly once. Delta-percent columns
 * are percent-shaped too, for the same reason.
 */
function scaleInputValue(columnId: string, raw: number): number {
  const ref = parseFieldId(columnId);
  if (ref === null) return raw;
  if (ref.part === 'delta_percent') return raw / 100;
  const spec = metricSpec(ref.metric);
  if (spec === undefined) return raw;
  const percentish = spec.scale === 'percent';
  if (!percentish) return raw;
  // delta_absolute on a percent metric is percentage points: same scaling.
  return raw / 100;
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim().replace(/[%,]/g, '');
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function compare(actual: number, operator: FilterOperator, expected: number): boolean {
  switch (operator) {
    case '>':
      return actual > expected;
    case '<':
      return actual < expected;
    case '>=':
      return actual >= expected;
    case '<=':
      return actual <= expected;
    case '=':
      return actual === expected;
    case '<>':
      return actual !== expected;
    default:
      throw new FilterError(`operator ${operator} is not valid on a numeric column`);
  }
}

/**
 * Filters are **compiled**, not interpreted.
 *
 * Everything that depends only on the filter -- which column, which accessor,
 * the parsed threshold, the percent scaling, the lowercased needles -- is
 * resolved once, and what remains per row is a closure call. Interpreting the
 * filter per row cost 33ms on the 50k-row set, twice the frame budget, almost
 * entirely in re-parsing the same strings fifty thousand times; compiled it is
 * comfortably inside one frame, which is what makes filter-as-you-type
 * possible on a set that size.
 *
 * A null actual value never matches a comparison. That is the honest reading:
 * a target with no sales has no ACOS, so it is neither above nor below 30%, and
 * silently treating it as 0% would put every wasted-spend row in the "great
 * efficiency" bucket. Operators who want those rows filter on `IS_NULL`.
 */
export type RowPredicate = (row: GridRow) => boolean;

const ALWAYS: RowPredicate = () => true;

function compileCondition(columnId: string, condition: FilterCondition): RowPredicate {
  const operator = condition.operator ?? '=';
  const read = fieldAccessor(columnId);

  if (operator === 'IS_NULL') return (row) => read(row) === null;
  if (operator === 'IS_NOT_NULL') return (row) => read(row) !== null;

  const isMetricColumn = parseFieldId(columnId) !== null;

  if (isMetricColumn) {
    const raw = toNumber(condition.values[0]);
    if (raw === null) throw new FilterError(`${columnId}: "${condition.values[0]}" is not a number`);
    const expected = scaleInputValue(columnId, raw);
    return (row) => {
      const actual = read(row);
      if (typeof actual !== 'number' || !Number.isFinite(actual)) return false;
      return compare(actual, operator, expected);
    };
  }

  // A dimension column holding a number (bid, budget) still compares
  // numerically -- but only when the operator is one a number understands.
  const numeric = operator === 'LIKE' || operator === 'NOT_LIKE' ? null : toNumber(condition.values[0]);
  const needles = condition.values.map((value) => value.toLowerCase());
  const exactNeedles = new Set(needles);

  return (row) => {
    const actual = read(row);
    if (numeric !== null && typeof actual === 'number') return compare(actual, operator, numeric);
    const text = actual === null || actual === undefined ? null : String(actual);
    return matchText(text, operator, needles, exactNeedles);
  };
}

/** Needles arrive pre-lowercased from the compiler. */
function matchText(
  actual: string | null,
  operator: FilterOperator,
  needles: readonly string[],
  exactNeedles: ReadonlySet<string>,
): boolean {
  const haystack = (actual ?? '').toLowerCase();
  switch (operator) {
    case 'LIKE':
      return needles.some((needle) => haystack.includes(needle));
    case 'NOT_LIKE':
      return !needles.some((needle) => haystack.includes(needle));
    case '=':
    case 'IN':
      return exactNeedles.has(haystack);
    case '<>':
    case 'NOT_IN':
      return !exactNeedles.has(haystack);
    default:
      throw new FilterError(`operator ${operator} is not valid on a text column`);
  }
}

function combinePredicates(parts: readonly RowPredicate[], operator: LogicalOperator): RowPredicate {
  if (parts.length === 0) return ALWAYS;
  if (parts.length === 1) return parts[0] as RowPredicate;
  return operator === 'OR'
    ? (row) => parts.some((part) => part(row))
    : (row) => parts.every((part) => part(row));
}

function compileTagFilter(filter: Filter, negated: boolean): RowPredicate {
  const wanted = new Set(filter.conditions.flatMap((condition) => [...condition.values]));
  if (wanted.size === 0) return ALWAYS;
  return (row) => {
    const held = row.tagIds ?? [];
    let hit = false;
    for (const tagId of held) {
      if (wanted.has(tagId)) {
        hit = true;
        break;
      }
    }
    return negated ? !hit : hit;
  };
}

/**
 * The delta meta-filters. First condition names the metric, the rest are the
 * threshold: "show me everything whose ACOS got more than 10% worse" is one
 * key covering every metric, which is worth stealing outright.
 */
function compileDeltaFilter(filter: Filter, suffix: string): RowPredicate {
  const [head, ...rest] = filter.conditions;
  const metric = head?.values[0];
  if (metric === undefined) throw new FilterError(`${filter.key}: first condition must name a metric`);
  const columnId = `${metric.toLowerCase()}${suffix}`;
  if (parseFieldId(columnId) === null) throw new FilterError(`${filter.key}: unknown metric "${metric}"`);
  if (rest.length === 0) {
    const read = fieldAccessor(columnId);
    return (row) => read(row) !== null;
  }
  return combinePredicates(
    rest.map((condition) => compileCondition(columnId, condition)),
    filter.logical_operator ?? 'AND',
  );
}

export function compileFilter(filter: Filter): RowPredicate {
  if (filter.key === TAG_KEY) return compileTagFilter(filter, false);
  if (filter.key === TAG_NOT_KEY) return compileTagFilter(filter, true);
  if (filter.key === DELTA_PERCENT_KEY) return compileDeltaFilter(filter, DELTA_PERCENT_SUFFIX);
  if (filter.key === DELTA_ABSOLUTE_KEY) return compileDeltaFilter(filter, DELTA_ABSOLUTE_SUFFIX);

  const negated = filter.key.endsWith(NEGATED_SUFFIX);
  const baseKey = negated ? filter.key.slice(0, -NEGATED_SUFFIX.length) : filter.key;
  const columnId = filterKeyToColumnId(baseKey);
  const inner = combinePredicates(
    filter.conditions.map((condition) => compileCondition(columnId, condition)),
    filter.logical_operator ?? 'AND',
  );
  return negated ? (row) => !inner(row) : inner;
}

/** Filters within a group are AND-ed; groups are OR-ed; an empty set matches all. */
export function compileFilterSet(set: FilterSet): RowPredicate {
  if (set.groups.length === 0) return ALWAYS;
  const groups = set.groups.map((group) => combinePredicates(group.filters.map(compileFilter), 'AND'));
  return combinePredicates(groups, 'OR');
}

/** Single-row convenience. Compiles, then calls; fine for one row, not for many. */
export function evaluateFilter(row: GridRow, filter: Filter): boolean {
  return compileFilter(filter)(row);
}

export function evaluateGroup(row: GridRow, group: FilterGroup): boolean {
  return group.filters.every((filter) => evaluateFilter(row, filter));
}

export function matchesFilterSet(row: GridRow, set: FilterSet): boolean {
  return compileFilterSet(set)(row);
}

export function applyFilterSet(rows: readonly GridRow[], set: FilterSet): GridRow[] {
  if (set.groups.length === 0) return rows as GridRow[];
  const matches = compileFilterSet(set);
  const out: GridRow[] = [];
  for (const row of rows) if (matches(row)) out.push(row);
  return out;
}

/**
 * Validate a filter set without a row to test it against, so a saved view or a
 * deep link fails at load with a message naming the key, rather than silently
 * matching nothing. Returns the problems; empty means valid.
 */
export function validateFilterSet(set: FilterSet, knownColumnIds: readonly string[]): string[] {
  const known = new Set(knownColumnIds);
  const problems: string[] = [];

  for (const group of set.groups) {
    for (const filter of group.filters) {
      if (filter.conditions.length === 0) {
        problems.push(`${filter.key}: no conditions`);
        continue;
      }
      if (filter.key === TAG_KEY || filter.key === TAG_NOT_KEY) continue;
      if (filter.key === DELTA_PERCENT_KEY || filter.key === DELTA_ABSOLUTE_KEY) {
        const metric = filter.conditions[0]?.values[0];
        if (metric === undefined || metricSpec(metric.toLowerCase()) === undefined) {
          problems.push(`${filter.key}: first condition must name a known metric`);
        }
        continue;
      }
      const negated = filter.key.endsWith(NEGATED_SUFFIX);
      const columnId = filterKeyToColumnId(negated ? filter.key.slice(0, -NEGATED_SUFFIX.length) : filter.key);
      if (parseFieldId(columnId) === null && !known.has(columnId)) {
        problems.push(`${filter.key}: no such column on this entity level`);
      }
    }
  }

  return problems;
}

/** Convenience for the common single-group case. */
export function filterSetOf(...filters: readonly Filter[]): FilterSet {
  return { groups: [{ filters }] };
}
