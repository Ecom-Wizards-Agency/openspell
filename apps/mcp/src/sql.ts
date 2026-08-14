/**
 * The query builder.
 *
 * Everything a caller supplies is either matched against a whitelist in
 * `catalog.ts` / `metrics.ts` and replaced by a fragment this file owns, or
 * bound as a parameter. No caller string is ever concatenated into SQL. That is
 * the whole security model of the `query` tool, and it is why there is no raw
 * SQL passthrough anywhere in this server.
 *
 * The shape of a statement is always the same four layers:
 *
 *   base   aggregate (or not, at daily grain) the fact source over the window
 *   cmp    the same aggregate over the comparison window, when one is asked for
 *   rows   join the two, add derived ratios and the four-column delta model
 *   final  filter, sort, limit
 *
 * Filters land in `final`, over the joined row, so a filter on a ratio and a
 * filter on a campaign name behave identically and neither can be evaluated
 * before the numbers it refers to exist.
 */
import { ToolError } from './errors.js';
import { levelDefinition } from './catalog.js';
import type { Dimension, DimensionType, EntityLevel } from './catalog.js';
import {
  ALL_METRICS,
  BASE_METRICS,
  DERIVED_METRICS,
  deriveSql,
  isBaseMetric,
  isDerivedMetric,
} from './metrics.js';
import type { BaseMetric, MetricName } from './metrics.js';

export interface DateWindow {
  from: string;
  to: string;
}

export const FILTER_OPERATORS = [
  '>',
  '<',
  '>=',
  '<=',
  '=',
  '<>',
  'IN',
  'NOT_IN',
  'LIKE',
  'NOT_LIKE',
  'IS_NULL',
  'IS_NOT_NULL',
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export interface FilterCondition {
  /** Uppercase column name, or DELTA_PERCENT / DELTA_ABSOLUTE / ACOS_TO_TARGET. */
  key: string;
  operator: FilterOperator;
  values?: string[];
  /** Required by the delta keys: which metric's delta to filter on. */
  metric?: string;
}

export interface SortSpec {
  column: string;
  direction: 'asc' | 'desc';
}

export type Grain = 'period' | 'daily';

export interface FactQuerySpec {
  level: EntityLevel;
  orgId: string;
  profileId: string;
  window: DateWindow;
  /** Adds `<metric>_comparison`, `_delta_absolute` and `_delta_percent` columns. */
  compare?: DateWindow | undefined;
  grain: Grain;
  /** Defaults to the level's natural key (plus `date` at daily grain). */
  dimensions?: readonly string[] | undefined;
  /** Defaults to every metric the level carries. */
  metrics?: readonly MetricName[] | undefined;
  filters?: readonly FilterCondition[] | undefined;
  sort?: readonly SortSpec[] | undefined;
  limit: number;
  offset?: number | undefined;
  /** Denominator for ACOS_TO_TARGET. Null makes the key unusable, with a reason. */
  targetAcos?: number | null | undefined;
}

export interface ColumnMeta {
  name: string;
  type: DimensionType;
  kind: 'dimension' | 'metric' | 'comparison' | 'delta';
}

export interface BuiltQuery {
  text: string;
  params: unknown[];
  columns: ColumnMeta[];
}

class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

const DELTA_SUFFIXES = ['_comparison', '_delta_absolute', '_delta_percent'] as const;

function resolveDimensions(
  level: EntityLevel,
  spec: FactQuerySpec,
  extra: readonly string[],
): string[] {
  const definition = levelDefinition(level);
  const requested = spec.dimensions ? [...spec.dimensions] : [...definition.defaultDimensions];
  if (spec.grain === 'daily' && !requested.includes('date')) requested.push('date');
  requested.push(...extra);

  const seen = new Set<string>();
  for (const name of requested) {
    if (!Object.hasOwn(definition.dimensions, name)) {
      throw new ToolError(
        'invalid_argument',
        `${level} has no dimension "${name}". Available: ${Object.keys(definition.dimensions).join(', ')}`,
      );
    }
    if (seen.has(name)) continue;
    seen.add(name);
  }
  return [...seen];
}

function resolveMetrics(
  level: EntityLevel,
  spec: FactQuerySpec,
  extra: readonly MetricName[],
): MetricName[] {
  const definition = levelDefinition(level);
  const unavailable = new Set<string>(definition.unavailableMetrics ?? []);
  // Defaulting drops what the level cannot report; asking for it by name is an
  // error. "Every metric" must mean every metric that exists here, or a
  // placement query would fail on a column no placement report has ever had.
  const requested = spec.metrics
    ? [...spec.metrics, ...extra]
    : [...ALL_METRICS.filter((metric) => !unavailable.has(metric)), ...extra];

  const out: MetricName[] = [];
  for (const metric of requested) {
    if (!isBaseMetric(metric) && !isDerivedMetric(metric)) {
      throw new ToolError('invalid_argument', `unknown metric "${metric}"`);
    }
    if (unavailable.has(metric)) {
      throw new ToolError(
        'invalid_argument',
        `${level} does not report "${metric}". This is a property of the report, not of the account.`,
      );
    }
    if (!out.includes(metric)) out.push(metric);
  }
  return out;
}

/**
 * Columns a filter or a sort names but the caller did not select.
 *
 * Filtering on a campaign name should not require remembering to select it
 * first. Every name here still comes from the level's whitelist, so widening
 * the selection widens nothing a caller could not have asked for outright; the
 * only consequence is that the column comes back in the result, which is the
 * behaviour a reader wants anyway.
 */
function impliedColumns(
  level: EntityLevel,
  spec: FactQuerySpec,
): { dimensions: string[]; metrics: MetricName[] } {
  const definition = levelDefinition(level);
  const dimensions: string[] = [];
  const metrics: MetricName[] = [];

  const consider = (raw: string | undefined): void => {
    if (!raw) return;
    const key = raw.toUpperCase();
    if (key === 'ACOS_TO_TARGET') {
      metrics.push('acos');
      return;
    }
    if (key === 'DELTA_PERCENT' || key === 'DELTA_ABSOLUTE') return;

    let name = raw.toLowerCase();
    for (const suffix of DELTA_SUFFIXES) {
      if (name.endsWith(suffix)) name = name.slice(0, -suffix.length);
    }
    if (Object.hasOwn(definition.dimensions, name)) dimensions.push(name);
    else if (isBaseMetric(name) || isDerivedMetric(name)) metrics.push(name);
  };

  for (const filter of spec.filters ?? []) {
    consider(filter.key);
    consider(filter.metric);
  }
  for (const sort of spec.sort ?? []) consider(sort.column);

  return { dimensions, metrics };
}

/** Base metrics needed to compute everything asked for, ratios included. */
function requiredBases(metrics: readonly MetricName[]): BaseMetric[] {
  const needed = new Set<BaseMetric>();
  for (const metric of metrics) {
    if (isBaseMetric(metric)) {
      needed.add(metric);
      continue;
    }
    const { numerator, denominator } = DERIVED_METRICS[metric];
    needed.add(numerator);
    needed.add(denominator);
  }
  return BASE_METRICS.filter((base) => needed.has(base));
}

function dimensionExpression(dimension: Dimension, grain: Grain): string {
  if (grain === 'period' && dimension.aggregate) return dimension.aggregate;
  return dimension.sql;
}

function joinsFor(level: EntityLevel, dimensions: readonly string[]): string[] {
  const definition = levelDefinition(level);
  const keys = new Set<string>();
  for (const name of dimensions) {
    const dimension = definition.dimensions[name];
    for (const key of dimension?.requires ?? []) keys.add(key);
  }
  // A level whose fact source only makes sense through a join (product) always
  // carries it, even when the caller asked for no dimension that needs it.
  if (level === 'product') keys.add('singleAsin');

  const clauses: string[] = [];
  for (const key of keys) {
    const clause = definition.joins[key];
    if (!clause) throw new ToolError('invalid_argument', `${level} cannot join "${key}"`);
    clauses.push(clause);
  }
  return clauses;
}

function selectBlock(
  level: EntityLevel,
  dimensions: readonly string[],
  bases: readonly BaseMetric[],
  grain: Grain,
): { select: string[]; groupBy: string[] } {
  const definition = levelDefinition(level);
  const select: string[] = [];
  const groupBy: string[] = [];

  for (const name of dimensions) {
    const dimension = definition.dimensions[name];
    if (!dimension) throw new ToolError('invalid_argument', `unknown dimension "${name}"`);
    const expression = dimensionExpression(dimension, grain);
    select.push(`${expression} as ${name}`);
    if (grain === 'period' && !dimension.aggregate) groupBy.push(expression);
  }

  for (const base of bases) {
    select.push(grain === 'period' ? `sum(f.${base})::float8 as ${base}` : `f.${base}::float8 as ${base}`);
  }

  return { select, groupBy };
}

function windowPredicate(params: Params, orgId: string, profileId: string, window: DateWindow): string {
  return [
    `f.org_id = ${params.add(orgId)}::uuid`,
    // The profile predicate is not decoration. AdLabs' get_entity_data returns
    // every profile the key can see regardless of the profile_id argument
    // (docs/ads-runtime-notes.md), and callers have been silently filtering it
    // post-fetch ever since. Here it is a predicate on the fact scan.
    `f.profile_id = ${params.add(profileId)}::uuid`,
    `f.date >= ${params.add(window.from)}::date`,
    `f.date <= ${params.add(window.to)}::date`,
  ].join(' and ');
}

function aggregateCte(
  name: string,
  spec: FactQuerySpec,
  dimensions: readonly string[],
  bases: readonly BaseMetric[],
  window: DateWindow,
  params: Params,
  grain: Grain,
): string {
  const definition = levelDefinition(spec.level);
  const { select, groupBy } = selectBlock(spec.level, dimensions, bases, grain);
  const joins = joinsFor(spec.level, dimensions);

  const where = [windowPredicate(params, spec.orgId, spec.profileId, window)];
  if (definition.where) where.push(definition.where);

  return [
    `${name} as (`,
    `  select ${select.join(', ')}`,
    `    from ${definition.source} f`,
    ...joins.map((clause) => `    ${clause}`),
    `   where ${where.join(' and ')}`,
    groupBy.length > 0 ? `   group by ${groupBy.join(', ')}` : '',
    ')',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function columnType(level: EntityLevel, name: string): DimensionType {
  const dimension = levelDefinition(level).dimensions[name];
  return dimension?.type ?? 'number';
}

/** Build the whole statement. */
export function buildFactQuery(spec: FactQuerySpec): BuiltQuery {
  const params = new Params();
  const implied = impliedColumns(spec.level, spec);
  const dimensions = resolveDimensions(spec.level, spec, implied.dimensions);
  const metrics = resolveMetrics(spec.level, spec, implied.metrics);
  const bases = requiredBases(metrics);
  const comparable = spec.compare !== undefined && spec.grain === 'period';

  const ctes = [aggregateCte('base', spec, dimensions, bases, spec.window, params, spec.grain)];
  if (comparable && spec.compare) {
    ctes.push(aggregateCte('cmp', spec, dimensions, bases, spec.compare, params, 'period'));
  }

  const columns: ColumnMeta[] = [];
  const rowSelect: string[] = [];

  for (const name of dimensions) {
    rowSelect.push(`base.${name}`);
    columns.push({ name, type: columnType(spec.level, name), kind: 'dimension' });
  }

  const metricExpression = (metric: MetricName, alias: string): string =>
    isBaseMetric(metric)
      ? `coalesce(${alias}.${metric}, 0)`
      : deriveSql(metric, (base) => `${alias}.${base}`);

  for (const metric of metrics) {
    rowSelect.push(`${metricExpression(metric, 'base')} as ${metric}`);
    columns.push({ name: metric, type: 'number', kind: 'metric' });

    if (!comparable) continue;
    const current = metricExpression(metric, 'base');
    const prior = metricExpression(metric, 'cmp');
    rowSelect.push(`${prior} as ${metric}_comparison`);
    rowSelect.push(`(${current}) - (${prior}) as ${metric}_delta_absolute`);
    // One convention for the whole server: delta_percent is a true percent
    // (+12.5 means twelve and a half percent up), never a ratio. AdLabs returns
    // both conventions from different entities; we return one.
    rowSelect.push(
      `case when (${prior}) is null or (${prior}) = 0 then null ` +
        `else (((${current}) - (${prior})) / abs(${prior})) * 100 end as ${metric}_delta_percent`,
    );
    columns.push({ name: `${metric}_comparison`, type: 'number', kind: 'comparison' });
    columns.push({ name: `${metric}_delta_absolute`, type: 'number', kind: 'delta' });
    columns.push({ name: `${metric}_delta_percent`, type: 'number', kind: 'delta' });
  }

  const joinOn =
    dimensions.length > 0
      ? dimensions.map((name) => `cmp.${name} is not distinct from base.${name}`).join(' and ')
      : 'true';

  const rowsCte = [
    'joined as (',
    `  select ${rowSelect.join(', ')}`,
    '    from base',
    comparable ? `    left join cmp on ${joinOn}` : '',
    ')',
  ]
    .filter((line) => line !== '')
    .join('\n');

  const known = new Map(columns.map((column) => [column.name, column]));
  const where = spec.filters?.map((filter) => filterSql(filter, known, spec, params)) ?? [];
  const orderBy = (spec.sort ?? []).map((sort) => sortSql(sort, known));

  const text = [
    `with ${[...ctes, rowsCte].join(',\n')}`,
    'select *',
    '  from joined',
    where.length > 0 ? ` where ${where.join(' and ')}` : '',
    orderBy.length > 0 ? ` order by ${orderBy.join(', ')}` : '',
    ` limit ${params.add(spec.limit)}`,
    spec.offset ? ` offset ${params.add(spec.offset)}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return { text, params: params.values, columns };
}

function filterSql(
  filter: FilterCondition,
  columns: Map<string, ColumnMeta>,
  spec: FactQuerySpec,
  params: Params,
): string {
  if (!FILTER_OPERATORS.includes(filter.operator)) {
    throw new ToolError('invalid_argument', `unknown filter operator "${filter.operator}"`);
  }

  const { expression, type } = filterTarget(filter, columns, spec);
  const values = filter.values ?? [];

  switch (filter.operator) {
    case 'IS_NULL':
      return `(${expression}) is null`;
    case 'IS_NOT_NULL':
      return `(${expression}) is not null`;
    case 'IN':
    case 'NOT_IN': {
      if (values.length === 0) {
        throw new ToolError('invalid_argument', `${filter.key} ${filter.operator} needs at least one value`);
      }
      const placeholders = values.map((value) => cast(params.add(coerce(value, type)), type));
      return `(${expression}) ${filter.operator === 'IN' ? 'in' : 'not in'} (${placeholders.join(', ')})`;
    }
    case 'LIKE':
    case 'NOT_LIKE': {
      const value = single(filter, values);
      if (type !== 'string') {
        throw new ToolError('invalid_argument', `${filter.key} is not a text column; LIKE does not apply`);
      }
      // Case-insensitive on purpose. Match-type and state casing differs between
      // Amazon's own surfaces, and a literal that returns zero rows because of a
      // capital letter is the exact trap the runtime notes warn about.
      return `(${expression}) ${filter.operator === 'LIKE' ? 'ilike' : 'not ilike'} ${params.add(value)}`;
    }
    default: {
      const value = single(filter, values);
      return `(${expression}) ${filter.operator} ${cast(params.add(coerce(value, type)), type)}`;
    }
  }
}

function filterTarget(
  filter: FilterCondition,
  columns: Map<string, ColumnMeta>,
  spec: FactQuerySpec,
): { expression: string; type: DimensionType } {
  const key = filter.key.toUpperCase();

  if (key === 'ACOS_TO_TARGET') {
    if (!spec.targetAcos) {
      throw new ToolError(
        'invalid_argument',
        'ACOS_TO_TARGET needs a target ACOS on the profile, and this profile has none set. ' +
          'Set it in the web app, or filter on ACOS directly.',
      );
    }
    const column = columns.get('acos');
    if (!column) throw new ToolError('invalid_argument', 'ACOS_TO_TARGET needs the acos metric selected');
    return { expression: `acos / ${spec.targetAcos}`, type: 'number' };
  }

  if (key === 'DELTA_PERCENT' || key === 'DELTA_ABSOLUTE') {
    if (!filter.metric) {
      throw new ToolError('invalid_argument', `${key} needs a "metric", e.g. {"key":"${key}","metric":"acos"}`);
    }
    const suffix = key === 'DELTA_PERCENT' ? '_delta_percent' : '_delta_absolute';
    const name = `${filter.metric.toLowerCase()}${suffix}`;
    const column = columns.get(name);
    if (!column) {
      throw new ToolError(
        'invalid_argument',
        `${key} on "${filter.metric}" needs a comparison window and that metric selected`,
      );
    }
    return { expression: name, type: 'number' };
  }

  const name = key.toLowerCase();
  const column = columns.get(name);
  if (!column) {
    const available = [...columns.keys()]
      .filter((candidate) => !DELTA_SUFFIXES.some((suffix) => candidate.endsWith(suffix)))
      .map((candidate) => candidate.toUpperCase());
    throw new ToolError(
      'invalid_argument',
      `no filter key "${filter.key}" at this level. Available: ${available.join(', ')}`,
    );
  }
  return { expression: name, type: column.type };
}

function sortSql(sort: SortSpec, columns: Map<string, ColumnMeta>): string {
  const column = columns.get(sort.column.toLowerCase());
  if (!column) {
    throw new ToolError('invalid_argument', `cannot sort by "${sort.column}": it is not a selected column`);
  }
  const direction = sort.direction === 'asc' ? 'asc' : 'desc';
  // Nulls last in both directions: a null ratio means "no denominator", and it
  // is never the answer to "show me the worst".
  return `${column.name} ${direction} nulls last`;
}

function single(filter: FilterCondition, values: readonly string[]): string {
  const value = values[0];
  if (values.length !== 1 || value === undefined) {
    throw new ToolError('invalid_argument', `${filter.key} ${filter.operator} takes exactly one value`);
  }
  return value;
}

function coerce(value: string, type: DimensionType): unknown {
  if (type !== 'number') return value;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ToolError('invalid_argument', `expected a number, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function cast(placeholder: string, type: DimensionType): string {
  switch (type) {
    case 'number':
      return `${placeholder}::float8`;
    case 'date':
      return `${placeholder}::date`;
    case 'boolean':
      return `${placeholder}::boolean`;
    default:
      return `${placeholder}::text`;
  }
}

/**
 * How much of a profile's spend the product level can attribute.
 *
 * Program rule 4 as a query: the product view drops ad groups that advertise
 * more than one ASIN, because splitting their spend would be an invention. What
 * it must never do is drop them quietly, so every product response carries the
 * spend it covered and the spend it did not.
 */
export function buildProductCoverageQuery(
  orgId: string,
  profileId: string,
  window: DateWindow,
): BuiltQuery {
  const params = new Params();
  const org = params.add(orgId);
  const profile = params.add(profileId);
  const from = params.add(window.from);
  const to = params.add(window.to);

  const text = `
    with facts as (
      select f.ad_group_id, sum(f.cost)::float8 as spend, count(*)::int as row_count
        from public.fact_sp_target_daily f
       where f.org_id = ${org}::uuid and f.profile_id = ${profile}::uuid
         and f.date >= ${from}::date and f.date <= ${to}::date
       group by f.ad_group_id
    ),
    single_asin as (
      select ad_group_id
        from public.product_ads
       where profile_id = ${profile}::uuid and asin is not null
       group by ad_group_id
      having count(distinct asin) = 1
    )
    select
      coalesce(sum(facts.spend), 0)::float8 as total_spend,
      coalesce(sum(facts.spend) filter (where single_asin.ad_group_id is not null), 0)::float8 as attributed_spend,
      count(*) filter (where single_asin.ad_group_id is null)::int as excluded_ad_groups
    from facts
    left join single_asin on single_asin.ad_group_id = facts.ad_group_id
  `;

  return { text, params: params.values, columns: [] };
}
