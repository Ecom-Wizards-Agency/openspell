/**
 * Experiments: the A/B-test tracker's read and write model (WP-19).
 *
 * Like the feedback helpers, every function here takes an `orgId` and puts it in
 * the WHERE clause even where RLS would already do it. The web tier connects as
 * the application's own role rather than as `authenticated`, so RLS is the
 * second fence, not the first: a query that forgets the org predicate would be a
 * cross-tenant read in the browser even though the same query is safe from
 * PostgREST. The two layers are tested separately for that reason.
 *
 * The comparison view is the one piece of real arithmetic. It derives
 * before / during / after windows of equal length from the fact tables and
 * recomputes every ratio from summed bases (sum/sum, never the mean of ratios),
 * exactly as the grid and the doctrine engine do. It is a rough measurement, not
 * a randomized test, and the UI says so — but the numbers it does show are the
 * real ones, verified against a direct SQL sum in the query suite.
 */
import type { DbHandle } from '../client.js';
import type { ExperimentScope } from '../schema/experiments.js';
import { toDate, toDateOrNull } from './pg-time.js';
import type { JsonValue } from './goto.js';

export type ExperimentQueryHandle = Pick<DbHandle, 'sql'>;

export const EXPERIMENT_TYPES = [
  'bid_push',
  'creative',
  'listing_content',
  'price',
  'placement',
  'other',
] as const;
export type ExperimentType = (typeof EXPERIMENT_TYPES)[number];

export const EXPERIMENT_METRICS = ['acos', 'cvr', 'ctr', 'sales', 'share'] as const;
export type ExperimentMetric = (typeof EXPERIMENT_METRICS)[number];

export const EXPERIMENT_STATUSES = [
  'planned',
  'running',
  'ended',
  'analyzed',
  'aborted',
] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

/** "Live" — still shading a chart, and worth reading a window off. */
export const ACTIVE_EXPERIMENT_STATUSES = ['running', 'ended', 'analyzed'] as const;

/**
 * The transitions a status may make. A test is planned, then run, then ended,
 * then analyzed; and it may be aborted from any non-terminal state. Anything
 * else is a mistake worth an error rather than a silent no-op.
 */
const ALLOWED_TRANSITIONS: Record<ExperimentStatus, readonly ExperimentStatus[]> = {
  planned: ['running', 'aborted'],
  running: ['ended', 'aborted'],
  ended: ['analyzed', 'running', 'aborted'],
  analyzed: ['running', 'aborted'],
  aborted: [],
};

export function canTransition(from: ExperimentStatus, to: ExperimentStatus): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

export interface ExperimentRecord {
  id: string;
  orgId: string;
  profileId: string;
  name: string;
  hypothesis: string;
  type: ExperimentType;
  scope: ExperimentScope;
  metricFocus: ExperimentMetric;
  startAt: Date;
  endAt: Date | null;
  status: ExperimentStatus;
  resultNote: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  statusChangedAt: Date;
}

export interface ExperimentEventRecord {
  id: number;
  experimentId: string;
  orgId: string;
  fromStatus: ExperimentStatus | null;
  toStatus: ExperimentStatus;
  note: string | null;
  actorId: string | null;
  createdAt: Date;
}

interface ExperimentDbRow {
  id: string;
  org_id: string;
  profile_id: string;
  name: string;
  hypothesis: string;
  type: ExperimentType;
  scope: ExperimentScope;
  metric_focus: ExperimentMetric;
  start_at: Date | string;
  end_at: Date | string | null;
  status: ExperimentStatus;
  result_note: string | null;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  status_changed_at: Date | string;
}

const toRecord = (row: ExperimentDbRow): ExperimentRecord => ({
  id: row.id,
  orgId: row.org_id,
  profileId: row.profile_id,
  name: row.name,
  hypothesis: row.hypothesis,
  type: row.type,
  scope: (row.scope ?? {}) as ExperimentScope,
  metricFocus: row.metric_focus,
  startAt: toDate(row.start_at),
  endAt: toDateOrNull(row.end_at),
  status: row.status,
  resultNote: row.result_note,
  createdBy: row.created_by,
  createdAt: toDate(row.created_at),
  updatedAt: toDate(row.updated_at),
  statusChangedAt: toDate(row.status_changed_at),
});

export class ExperimentNotFound extends Error {
  constructor(message = 'Experiment not found') {
    super(message);
    this.name = 'ExperimentNotFound';
  }
}

export class InvalidExperimentTransition extends Error {
  constructor(from: ExperimentStatus, to: ExperimentStatus) {
    super(`An experiment cannot move from ${from} to ${to}`);
    this.name = 'InvalidExperimentTransition';
  }
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

export function normalizeExperimentName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, ' ');
  if (!normalized) throw new Error('An experiment name cannot be empty');
  if (normalized.length > 200) throw new Error('An experiment name cannot exceed 200 characters');
  return normalized;
}

export function normalizeExperimentText(text: string | undefined, label: string): string {
  const normalized = (text ?? '').trim();
  if (normalized.length > 20_000) throw new Error(`An experiment ${label} cannot exceed 20000 characters`);
  return normalized;
}

const uniqueStrings = (values: unknown): string[] | undefined => {
  if (!Array.isArray(values)) return undefined;
  const cleaned = Array.from(
    new Set(values.filter((value): value is string => typeof value === 'string' && value.trim() !== '')),
  ).map((value) => value.trim());
  return cleaned.length > 0 ? cleaned : undefined;
};

/** Keep only the known keys, drop empties, so a stored scope has a shape. */
export function normalizeScope(scope: unknown): ExperimentScope {
  const source = (scope ?? {}) as Record<string, unknown>;
  const result: ExperimentScope = {};
  const campaignIds = uniqueStrings(source['campaignIds']);
  const adGroupIds = uniqueStrings(source['adGroupIds']);
  const targetIds = uniqueStrings(source['targetIds']);
  const asins = uniqueStrings(source['asins']);
  const searchTerms = uniqueStrings(source['searchTerms']);
  if (campaignIds) result.campaignIds = campaignIds;
  if (adGroupIds) result.adGroupIds = adGroupIds;
  if (targetIds) result.targetIds = targetIds;
  if (asins) result.asins = asins;
  if (searchTerms) result.searchTerms = searchTerms;
  if (typeof source['note'] === 'string' && source['note'].trim() !== '') {
    result.note = source['note'].trim();
  }
  return result;
}

function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value ?? {});
  if (serialized === undefined) throw new Error('Experiment scope must be JSON-serializable');
  return serialized;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface CreateExperimentInput {
  orgId: string;
  profileId: string;
  createdBy?: string | null;
  name: string;
  hypothesis?: string;
  type: ExperimentType;
  scope?: ExperimentScope;
  metricFocus: ExperimentMetric;
  startAt?: Date | string | null;
  endAt?: Date | string | null;
  status?: ExperimentStatus;
}

export async function createExperiment(
  handle: ExperimentQueryHandle,
  input: CreateExperimentInput,
): Promise<ExperimentRecord> {
  if (!EXPERIMENT_TYPES.includes(input.type)) throw new Error(`Unknown experiment type: ${input.type}`);
  if (!EXPERIMENT_METRICS.includes(input.metricFocus)) {
    throw new Error(`Unknown experiment metric: ${input.metricFocus}`);
  }
  const status = input.status ?? 'planned';
  if (!EXPERIMENT_STATUSES.includes(status)) throw new Error(`Unknown experiment status: ${status}`);
  const name = normalizeExperimentName(input.name);
  const hypothesis = normalizeExperimentText(input.hypothesis, 'hypothesis');
  const scope = normalizeScope(input.scope);

  const rows = await handle.sql<{ id: string }[]>`
    insert into public.experiments
      (org_id, profile_id, created_by, name, hypothesis, type, scope, metric_focus,
       start_at, end_at, status)
    values (
      ${input.orgId}, ${input.profileId}, ${input.createdBy ?? null}, ${name}, ${hypothesis},
      ${input.type}::public.experiment_type, ${serializeJson(scope)}::text::jsonb,
      ${input.metricFocus}::public.experiment_metric,
      coalesce(${toTimestampParam(input.startAt)}::timestamptz, now()),
      ${toTimestampParam(input.endAt)}::timestamptz,
      ${status}::public.experiment_status
    )
    returning id
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error('Creating an experiment returned no row');
  await handle.sql`
    insert into public.experiment_events (experiment_id, org_id, from_status, to_status, note, actor_id)
    values (${id}, ${input.orgId}, null, ${status}::public.experiment_status, 'Created', ${input.createdBy ?? null})
  `;
  const created = await getExperiment(handle, { orgId: input.orgId, experimentId: id });
  if (!created) throw new Error('An experiment was created but could not be read back');
  return created;
}

export async function getExperiment(
  handle: ExperimentQueryHandle,
  input: { orgId: string; experimentId: string },
): Promise<ExperimentRecord | null> {
  const rows = await handle.sql<ExperimentDbRow[]>`
    select id, org_id, profile_id, name, hypothesis, type::text as type, scope,
           metric_focus::text as metric_focus, start_at, end_at, status::text as status,
           result_note, created_by, created_at, updated_at, status_changed_at
      from public.experiments
     where org_id = ${input.orgId} and id = ${input.experimentId}
  `;
  return rows[0] ? toRecord(rows[0]) : null;
}

export interface ListExperimentsInput {
  orgId: string;
  profileId?: string | null;
  status?: ExperimentStatus | null;
  statuses?: readonly ExperimentStatus[] | null;
  limit?: number;
}

export async function listExperiments(
  handle: ExperimentQueryHandle,
  input: ListExperimentsInput,
): Promise<ExperimentRecord[]> {
  const statuses = input.statuses?.length ? [...input.statuses] : null;
  const rows = await handle.sql<ExperimentDbRow[]>`
    select id, org_id, profile_id, name, hypothesis, type::text as type, scope,
           metric_focus::text as metric_focus, start_at, end_at, status::text as status,
           result_note, created_by, created_at, updated_at, status_changed_at
      from public.experiments
     where org_id = ${input.orgId}
       and (${input.profileId ?? null}::uuid is null or profile_id = ${input.profileId ?? null}::uuid)
       and (${input.status ?? null}::text is null or status::text = ${input.status ?? null})
       and (${statuses}::text[] is null or status::text = any(${statuses}::text[]))
     order by start_at desc, created_at desc, id
     limit ${input.limit ?? 500}
  `;
  return rows.map(toRecord);
}

/**
 * The windows the chart-overlay provider shades: live experiments for one
 * profile, with just the fields a decoration layer needs.
 */
export interface ExperimentWindow {
  id: string;
  name: string;
  type: ExperimentType;
  status: ExperimentStatus;
  start: string;
  /** Null while running: the band runs to the right edge of the chart. */
  end: string | null;
}

export async function listExperimentWindows(
  handle: ExperimentQueryHandle,
  input: { orgId: string; profileId: string },
): Promise<ExperimentWindow[]> {
  const rows = await handle.sql<
    { id: string; name: string; type: ExperimentType; status: ExperimentStatus; start: string; end: string | null }[]
  >`
    select id, name, type::text as type, status::text as status,
           start_at::date::text as start, end_at::date::text as end
      from public.experiments
     where org_id = ${input.orgId}
       and profile_id = ${input.profileId}
       and status::text = any(${[...ACTIVE_EXPERIMENT_STATUSES]}::text[])
     order by start_at
  `;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    status: row.status,
    start: row.start,
    end: row.end,
  }));
}

export interface UpdateExperimentInput {
  orgId: string;
  experimentId: string;
  actorId?: string | null;
  name?: string;
  hypothesis?: string;
  type?: ExperimentType;
  scope?: ExperimentScope;
  metricFocus?: ExperimentMetric;
  startAt?: Date | string | null;
}

/** The creator's or an admin's edit of an experiment's descriptive fields. */
export async function updateExperiment(
  handle: ExperimentQueryHandle,
  input: UpdateExperimentInput,
): Promise<ExperimentRecord> {
  const current = await getExperiment(handle, input);
  if (!current) throw new ExperimentNotFound();

  const name = input.name === undefined ? current.name : normalizeExperimentName(input.name);
  const hypothesis =
    input.hypothesis === undefined ? current.hypothesis : normalizeExperimentText(input.hypothesis, 'hypothesis');
  const type = input.type ?? current.type;
  if (!EXPERIMENT_TYPES.includes(type)) throw new Error(`Unknown experiment type: ${type}`);
  const metricFocus = input.metricFocus ?? current.metricFocus;
  if (!EXPERIMENT_METRICS.includes(metricFocus)) throw new Error(`Unknown experiment metric: ${metricFocus}`);
  const scope = input.scope === undefined ? current.scope : normalizeScope(input.scope);
  const startAt = input.startAt === undefined ? null : toTimestampParam(input.startAt);

  const rows = await handle.sql<{ id: string }[]>`
    update public.experiments
       set name = ${name},
           hypothesis = ${hypothesis},
           type = ${type}::public.experiment_type,
           metric_focus = ${metricFocus}::public.experiment_metric,
           scope = ${serializeJson(scope)}::text::jsonb,
           start_at = coalesce(${startAt}::timestamptz, start_at)
     where org_id = ${input.orgId} and id = ${input.experimentId}
    returning id
  `;
  if (!rows[0]) throw new ExperimentNotFound();
  const updated = await getExperiment(handle, input);
  if (!updated) throw new ExperimentNotFound();
  return updated;
}

/**
 * Move the status, recording the transition and honouring the window rules:
 * moving to `ended` stamps `end_at` if it is not already set; moving back to
 * `running` clears it so the band re-opens.
 */
export async function transitionExperiment(
  handle: ExperimentQueryHandle,
  input: {
    orgId: string;
    experimentId: string;
    to: ExperimentStatus;
    note?: string | null;
    resultNote?: string | null;
    actorId?: string | null;
  },
): Promise<ExperimentRecord> {
  if (!EXPERIMENT_STATUSES.includes(input.to)) throw new Error(`Unknown experiment status: ${input.to}`);
  const current = await getExperiment(handle, input);
  if (!current) throw new ExperimentNotFound();
  if (!canTransition(current.status, input.to)) {
    throw new InvalidExperimentTransition(current.status, input.to);
  }

  const noteProvided = input.resultNote !== undefined;
  const resultNote = noteProvided ? (input.resultNote?.trim() || null) : null;

  const rows = await handle.sql<{ id: string }[]>`
    update public.experiments
       set status = ${input.to}::public.experiment_status,
           end_at = case
                      when ${input.to} = 'ended' then coalesce(end_at, now())
                      when ${input.to} = 'running' then null
                      else end_at
                    end,
           result_note = case when ${noteProvided} then ${resultNote}::text else result_note end
     where org_id = ${input.orgId} and id = ${input.experimentId}
    returning id
  `;
  if (!rows[0]) throw new ExperimentNotFound();

  // Only log an event when the status actually moved: a result-note edit that
  // leaves the status alone is not a transition.
  if (current.status !== input.to) {
    await handle.sql`
      insert into public.experiment_events (experiment_id, org_id, from_status, to_status, note, actor_id)
      values (${input.experimentId}, ${input.orgId}, ${current.status}::public.experiment_status,
              ${input.to}::public.experiment_status, ${input.note ?? null}, ${input.actorId ?? null})
    `;
  }

  const updated = await getExperiment(handle, input);
  if (!updated) throw new ExperimentNotFound();
  return updated;
}

export async function listExperimentEvents(
  handle: ExperimentQueryHandle,
  input: { orgId: string; experimentId: string },
): Promise<ExperimentEventRecord[]> {
  const rows = await handle.sql<
    {
      id: string | number;
      experiment_id: string;
      org_id: string;
      from_status: ExperimentStatus | null;
      to_status: ExperimentStatus;
      note: string | null;
      actor_id: string | null;
      created_at: Date | string;
    }[]
  >`
    select id, experiment_id, org_id, from_status::text as from_status, to_status::text as to_status,
           note, actor_id, created_at
      from public.experiment_events
     where org_id = ${input.orgId} and experiment_id = ${input.experimentId}
     order by created_at, id
  `;
  return rows.map((row) => ({
    id: Number(row.id),
    experimentId: row.experiment_id,
    orgId: row.org_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    note: row.note,
    actorId: row.actor_id,
    createdAt: toDate(row.created_at),
  }));
}

// ---------------------------------------------------------------------------
// entity_changes inside the window
// ---------------------------------------------------------------------------

export interface EntityChangeInWindow {
  id: number;
  entityType: string;
  amazonId: string;
  entityName: string | null;
  field: string;
  oldValue: JsonValue;
  newValue: JsonValue;
  source: string;
  observedAt: Date;
}

/**
 * "What actually changed during this test." entity_changes for the experiment's
 * profile inside its window, narrowed to the scoped ids when the scope names
 * any — a change to an unrelated campaign is not part of this test.
 */
export async function listEntityChangesInWindow(
  handle: ExperimentQueryHandle,
  experiment: Pick<ExperimentRecord, 'orgId' | 'profileId' | 'scope' | 'startAt' | 'endAt'>,
  now: Date = new Date(),
): Promise<EntityChangeInWindow[]> {
  const scopeIds = [
    ...(experiment.scope.campaignIds ?? []),
    ...(experiment.scope.adGroupIds ?? []),
    ...(experiment.scope.targetIds ?? []),
  ];
  const ids = scopeIds.length > 0 ? scopeIds : null;
  // Bind timestamps as ISO strings with an explicit cast: the Drizzle-attached
  // admin handle installs an identity serializer that rejects a bound `Date`.
  const startParam = experiment.startAt.toISOString();
  const endParam = (experiment.endAt ?? now).toISOString();

  const rows = await handle.sql<
    {
      id: string | number;
      entity_type: string;
      amazon_id: string;
      entity_name: string | null;
      field: string;
      old_value: JsonValue;
      new_value: JsonValue;
      source: string;
      observed_at: Date | string;
    }[]
  >`
    select id, entity_type::text as entity_type, amazon_id, entity_name, field,
           old_value, new_value, source::text as source, observed_at
      from public.entity_changes
     where org_id = ${experiment.orgId}
       and profile_id = ${experiment.profileId}
       and observed_at >= ${startParam}::timestamptz
       and observed_at <= ${endParam}::timestamptz
       and (${ids}::text[] is null or amazon_id = any(${ids}::text[]))
     order by observed_at desc, id desc
     limit 500
  `;
  return rows.map((row) => ({
    id: Number(row.id),
    entityType: row.entity_type,
    amazonId: row.amazon_id,
    entityName: row.entity_name,
    field: row.field,
    oldValue: row.old_value,
    newValue: row.new_value,
    source: row.source,
    observedAt: toDate(row.observed_at),
  }));
}

// ---------------------------------------------------------------------------
// Before / during / after comparison
// ---------------------------------------------------------------------------

export interface MetricTotals {
  impressions: number;
  clicks: number;
  spend: number;
  sales: number;
  orders: number;
}

export interface DerivedMetrics {
  impressions: number;
  clicks: number;
  spend: number;
  sales: number;
  orders: number;
  acos: number | null;
  cvr: number | null;
  ctr: number | null;
  cpc: number | null;
  roas: number | null;
}

export interface ComparisonWindow {
  label: 'before' | 'during' | 'after';
  start: string;
  end: string;
  /** Facts summed over the scoped entities. Null when the scope names no ad entity. */
  scoped: DerivedMetrics | null;
  /** The whole profile over the same window, as a rough control. */
  profile: DerivedMetrics;
}

export interface ExperimentComparison {
  /** True when the scope named campaign or target ids we could sum ad-facts over. */
  hasScopedFacts: boolean;
  windowDays: number;
  windows: ComparisonWindow[];
}

const ratio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? numerator / denominator : null;

export function deriveMetrics(totals: MetricTotals): DerivedMetrics {
  return {
    ...totals,
    acos: ratio(totals.spend, totals.sales),
    cvr: ratio(totals.orders, totals.clicks),
    ctr: ratio(totals.clicks, totals.impressions),
    cpc: ratio(totals.spend, totals.clicks),
    roas: ratio(totals.sales, totals.spend),
  };
}

/** Days between two YYYY-MM-DD dates, inclusive. */
function inclusiveDays(start: string, end: string): number {
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  return Math.max(1, Math.round(ms / 86_400_000) + 1);
}

function shiftDate(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

const isoDate = (value: Date): string => value.toISOString().slice(0, 10);

async function sumScopedFacts(
  handle: ExperimentQueryHandle,
  orgId: string,
  profileId: string,
  scope: ExperimentScope,
  start: string,
  end: string,
): Promise<MetricTotals | null> {
  const campaignIds = scope.campaignIds ?? [];
  const targetIds = scope.targetIds ?? [];
  if (campaignIds.length === 0 && targetIds.length === 0) return null;

  const rows = await handle.sql<
    { impressions: string; clicks: string; spend: string; sales: string; orders: string }[]
  >`
    select
      coalesce(sum(impressions), 0) as impressions,
      coalesce(sum(clicks), 0) as clicks,
      coalesce(sum(cost), 0) as spend,
      coalesce(sum(sales_7d), 0) as sales,
      coalesce(sum(purchases_7d), 0) as orders
    from public.fact_sp_target_daily
   where org_id = ${orgId}
     and profile_id = ${profileId}
     and date between ${start} and ${end}
     and (
       (${campaignIds}::text[] <> '{}'::text[] and campaign_id = any(${campaignIds}::text[]))
       or (${targetIds}::text[] <> '{}'::text[] and target_id = any(${targetIds}::text[]))
     )
  `;
  const row = rows[0];
  return {
    impressions: Number(row?.impressions ?? 0),
    clicks: Number(row?.clicks ?? 0),
    spend: Number(row?.spend ?? 0),
    sales: Number(row?.sales ?? 0),
    orders: Number(row?.orders ?? 0),
  };
}

async function sumProfileFacts(
  handle: ExperimentQueryHandle,
  orgId: string,
  profileId: string,
  start: string,
  end: string,
): Promise<MetricTotals> {
  const rows = await handle.sql<
    { impressions: string; clicks: string; spend: string; sales: string; orders: string }[]
  >`
    select
      coalesce(sum(impressions), 0) as impressions,
      coalesce(sum(clicks), 0) as clicks,
      coalesce(sum(cost), 0) as spend,
      coalesce(sum(sales_7d), 0) as sales,
      coalesce(sum(purchases_7d), 0) as orders
    from public.fact_profile_daily
   where org_id = ${orgId}
     and profile_id = ${profileId}
     and date between ${start} and ${end}
  `;
  const row = rows[0];
  return {
    impressions: Number(row?.impressions ?? 0),
    clicks: Number(row?.clicks ?? 0),
    spend: Number(row?.spend ?? 0),
    sales: Number(row?.sales ?? 0),
    orders: Number(row?.orders ?? 0),
  };
}

/**
 * Before / during / (after, when ended) windows of equal length for the scoped
 * entities, next to the profile-level control. All sums from the fact tables;
 * ratios recomputed from those sums. The `after` window only exists once the
 * experiment has an end date — a still-running test has no after.
 */
export async function computeComparison(
  handle: ExperimentQueryHandle,
  experiment: Pick<ExperimentRecord, 'orgId' | 'profileId' | 'scope' | 'startAt' | 'endAt'>,
  now: Date = new Date(),
): Promise<ExperimentComparison> {
  const duringStart = isoDate(experiment.startAt);
  const duringEnd = isoDate(experiment.endAt ?? now);
  const windowDays = inclusiveDays(duringStart, duringEnd);

  const bounds: { label: ComparisonWindow['label']; start: string; end: string }[] = [
    { label: 'before', start: shiftDate(duringStart, -windowDays), end: shiftDate(duringStart, -1) },
    { label: 'during', start: duringStart, end: duringEnd },
  ];
  // Only when the experiment has actually ended is there a window after it, and
  // only up to today: summing days that have not happened would invent zeros.
  if (experiment.endAt) {
    const afterStart = shiftDate(duringEnd, 1);
    const afterEnd = shiftDate(duringEnd, windowDays);
    const cappedEnd = afterEnd > isoDate(now) ? isoDate(now) : afterEnd;
    if (cappedEnd >= afterStart) {
      bounds.push({ label: 'after', start: afterStart, end: cappedEnd });
    }
  }

  const windows: ComparisonWindow[] = [];
  for (const bound of bounds) {
    const [scoped, profile] = await Promise.all([
      sumScopedFacts(handle, experiment.orgId, experiment.profileId, experiment.scope, bound.start, bound.end),
      sumProfileFacts(handle, experiment.orgId, experiment.profileId, bound.start, bound.end),
    ]);
    windows.push({
      label: bound.label,
      start: bound.start,
      end: bound.end,
      scoped: scoped === null ? null : deriveMetrics(scoped),
      profile: deriveMetrics(profile),
    });
  }

  const hasScopedFacts =
    (experiment.scope.campaignIds?.length ?? 0) > 0 || (experiment.scope.targetIds?.length ?? 0) > 0;
  return { hasScopedFacts, windowDays, windows };
}

// ---------------------------------------------------------------------------
// A small timestamp param helper, local so packages/db keeps no upward import.
// ---------------------------------------------------------------------------

function toTimestampParam(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}
