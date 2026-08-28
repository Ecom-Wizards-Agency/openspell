/**
 * Read-only Amazon Marketing Stream normalization and dayparting proposals.
 *
 * AWS SQS is the delivery boundary, but the source-specific subscriber is not
 * duplicated here: it must hand this module shared-contract ledger events.
 * Every raw payload stays intact in the append-only database ledger. This
 * module only understands the documented normalization seam (`metrics` rows)
 * and refuses an unknown payload rather than guessing Amazon fields.
 */
import { randomUUID } from 'node:crypto';
import {
  appendMarketingStreamEvents,
  marketingStreamScopeKey,
  persistDaypartingScheduleProposal,
  replaceMarketingStreamHourlyFacts,
  snapshotLatestMarketingStreamEvents,
  type DbHandle,
  type MarketingStreamAppendResult,
  type MarketingStreamProjectionResult,
  type MarketingStreamScope,
  type MarketingStreamSnapshot,
  type StoredMarketingStreamEvent,
} from '@wizard-ads/db';
import {
  DaypartingScheduleProposal,
  MarketingStreamHourlyFact,
  MarketingStreamLedgerEvent,
  MarketingStreamNormalizationCounts,
  type DaypartingScheduleBlock,
  type DaypartingScheduleProposal as DaypartingScheduleProposalValue,
  type MarketingStreamHourlyFact as MarketingStreamHourlyFactValue,
  type MarketingStreamLedgerEvent as MarketingStreamLedgerEventValue,
  type MarketingStreamNormalizationCounts as MarketingStreamNormalizationCountsValue,
} from '@wizard-ads/shared';

export interface MarketingStreamRefusal {
  index: number;
  messageId: string | null;
  scope: MarketingStreamScope | null;
  reason: string;
}

export interface MarketingStreamNormalizationPolicy {
  profileTimeZone: string;
  currencyCode: string;
  /** Hours after the event hour during which evidence remains settling. */
  settlingWindowHours: number;
  /** Budget-usage percentage at which the hour is marked capped. */
  budgetCappedAtPercent: number;
  now: Date;
}

export interface MarketingStreamNormalizedSnapshot {
  scopes: MarketingStreamScope[];
  expectedSourceEventIds: Record<string, string[]>;
  facts: MarketingStreamHourlyFactValue[];
  refusals: MarketingStreamRefusal[];
}

export interface MarketingStreamBatchResult {
  counts: MarketingStreamNormalizationCountsValue;
  append: MarketingStreamAppendResult;
  projection: MarketingStreamProjectionResult;
  refusals: MarketingStreamRefusal[];
}

export interface MarketingStreamStore {
  append(input: {
    orgId: string;
    profileId: string;
    events: readonly MarketingStreamLedgerEventValue[];
  }): Promise<MarketingStreamAppendResult>;
  snapshot(input: {
    orgId: string;
    profileId: string;
    scopes: readonly MarketingStreamScope[];
  }): Promise<MarketingStreamSnapshot>;
  replace(input: {
    orgId: string;
    profileId: string;
    scopes: readonly MarketingStreamScope[];
    expectedSourceEventIds: Readonly<Record<string, readonly string[]>>;
    facts: readonly MarketingStreamHourlyFactValue[];
  }): Promise<MarketingStreamProjectionResult>;
  persistProposal(input: {
    orgId: string;
    proposal: DaypartingScheduleProposalValue;
  }): Promise<{ status: 'inserted' | 'already_present'; proposal: DaypartingScheduleProposalValue }>;
}

export class DbMarketingStreamStore implements MarketingStreamStore {
  constructor(private readonly handle: DbHandle) {}

  append(input: Parameters<MarketingStreamStore['append']>[0]): ReturnType<MarketingStreamStore['append']> {
    return appendMarketingStreamEvents(this.handle, input);
  }

  snapshot(input: Parameters<MarketingStreamStore['snapshot']>[0]): ReturnType<MarketingStreamStore['snapshot']> {
    return snapshotLatestMarketingStreamEvents(this.handle, input);
  }

  replace(input: Parameters<MarketingStreamStore['replace']>[0]): ReturnType<MarketingStreamStore['replace']> {
    return replaceMarketingStreamHourlyFacts(this.handle, input);
  }

  persistProposal(
    input: Parameters<MarketingStreamStore['persistProposal']>[0],
  ): ReturnType<MarketingStreamStore['persistProposal']> {
    return persistDaypartingScheduleProposal(this.handle, input);
  }
}

export class MarketingStreamNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketingStreamNormalizationError';
  }
}

/**
 * Validate, append, normalize, and replace every uncontaminated affected hour.
 * A malformed event is retained in neither the ledger nor facts. A valid
 * ledger event with an unsupported metric payload is retained for diagnosis,
 * while its affected scope keeps the previous canonical projection.
 */
export async function processMarketingStreamBatch(
  store: MarketingStreamStore,
  input: {
    orgId: string;
    profileId: string;
    events: readonly unknown[];
    policy: MarketingStreamNormalizationPolicy;
  },
): Promise<MarketingStreamBatchResult> {
  validatePolicy(input.policy);
  const staged = stageLedgerEvents(input.profileId, input.events);
  const append = staged.events.length === 0
    ? emptyAppend(staged.events.length)
    : await store.append({ orgId: input.orgId, profileId: input.profileId, events: staged.events });
  const snapshot = append.affectedScopes.length === 0
    ? emptySnapshot(input.orgId, input.profileId)
    : await store.snapshot({
        orgId: input.orgId,
        profileId: input.profileId,
        scopes: append.affectedScopes,
      });
  const normalized = normalizeMarketingStreamSnapshot(snapshot, input.policy);
  const projection = normalized.scopes.length === 0
    ? emptyProjection()
    : await store.replace({
        orgId: input.orgId,
        profileId: input.profileId,
        scopes: normalized.scopes,
        expectedSourceEventIds: normalized.expectedSourceEventIds,
        facts: normalized.facts,
      });
  if (projection.factsInserted !== normalized.facts.length) {
    throw new MarketingStreamNormalizationError(
      `normalized ${normalized.facts.length} facts but persisted ${projection.factsInserted}`,
    );
  }
  const refusals = [...staged.refusals, ...normalized.refusals];
  const counts = MarketingStreamNormalizationCounts.parse({
    receivedMessages: input.events.length,
    duplicateMessages: append.duplicateMessages,
    revisedMessages: append.revisedMessages,
    refusedMessages: refusals.length,
    normalizedRows: projection.factsInserted,
  });
  if (append.insertedMessages + append.duplicateMessages + staged.refusals.length !== input.events.length) {
    throw new MarketingStreamNormalizationError('received-message counts do not reconcile');
  }
  return { counts, append, projection, refusals };
}

/** Pure latest-revision event projection for affected hours. */
export function normalizeMarketingStreamSnapshot(
  snapshot: MarketingStreamSnapshot,
  policy: MarketingStreamNormalizationPolicy,
): MarketingStreamNormalizedSnapshot {
  validatePolicy(policy);

  const refusalByScope = new Map<string, MarketingStreamRefusal[]>();
  const recordsByScope = new Map<string, ParsedEvent[]>();
  snapshot.events.forEach((event, index) => {
    const scope = { adProduct: event.adProduct, utcHour: truncateUtcHour(event.eventTime) };
    try {
      if (new Date(event.receivedAt) > policy.now) {
        throw new MarketingStreamNormalizationError('message receive time is in the future');
      }
      const records = parseEventMetrics(event, policy.currencyCode);
      const parsed = recordsByScope.get(marketingStreamScopeKey(scope)) ?? [];
      parsed.push({ event, records });
      recordsByScope.set(marketingStreamScopeKey(scope), parsed);
    } catch (error) {
      const refusal: MarketingStreamRefusal = {
        index,
        messageId: event.messageId,
        scope,
        reason: error instanceof Error ? error.message : String(error),
      };
      const refusals = refusalByScope.get(marketingStreamScopeKey(scope)) ?? [];
      refusals.push(refusal);
      refusalByScope.set(marketingStreamScopeKey(scope), refusals);
    }
  });

  const scopes = snapshot.scopes.filter((scope) => !refusalByScope.has(marketingStreamScopeKey(scope)));
  const allowed = new Set(scopes.map(marketingStreamScopeKey));
  const expectedSourceEventIds = Object.fromEntries(scopes.map((scope) => {
    const key = marketingStreamScopeKey(scope);
    return [key, [...(snapshot.sourceEventIds[key] ?? [])]];
  }));
  const facts: MarketingStreamHourlyFactValue[] = [];
  for (const scope of scopes) {
    const parsed = recordsByScope.get(marketingStreamScopeKey(scope)) ?? [];
    facts.push(...aggregateScope(snapshot.profileId, scope, parsed, policy));
  }
  for (const fact of facts) {
    if (!allowed.has(marketingStreamScopeKey({ adProduct: fact.adProduct, utcHour: fact.utcHour }))) {
      throw new MarketingStreamNormalizationError('normalized a fact outside the accepted scopes');
    }
  }
  const refusals = [...refusalByScope.values()].flat();
  return { scopes, expectedSourceEventIds, facts, refusals };
}

export type DaypartingMetric = 'conversion_rate' | 'roas';

export interface DaypartingModelConfig {
  baselineLabel: string;
  metric: DaypartingMetric;
  /** Operator-approved baseline in the same unit as `metric`. */
  baselineValue: number;
  /** Pseudo-evidence weight that shrinks sparse cells toward the baseline. */
  priorWeight: number;
  /** Cells below this denominator are omitted from the schedule. */
  minimumCellWeight: number;
  minimumAdjustmentPercent: number;
  maximumAdjustmentPercent: number;
  /** Operator-selected legal export increment. */
  adjustmentStepPercent: number;
}

/**
 * Generate a proposal from settled facts only. Missing or ineligible cells
 * remain at baseline and therefore do not appear as schedule blocks.
 */
export function proposeDaypartingSchedule(
  facts: readonly MarketingStreamHourlyFactValue[],
  config: DaypartingModelConfig,
): DaypartingScheduleProposalValue {
  validateModelConfig(config);
  if (facts.length === 0) throw new MarketingStreamNormalizationError('dayparting needs hourly facts');
  const parsed = facts.map((fact) => MarketingStreamHourlyFact.parse(fact));
  const profileId = parsed[0]!.profileId;
  const campaignId = parsed[0]!.campaignId;
  for (const [index, fact] of parsed.entries()) {
    if (fact.profileId !== profileId || fact.campaignId !== campaignId) {
      throw new MarketingStreamNormalizationError(`fact ${index} is outside the proposal campaign`);
    }
  }
  const settled = parsed.filter((fact) => fact.settlingState === 'settled');
  if (settled.length === 0) {
    throw new MarketingStreamNormalizationError('dayparting needs settled evidence');
  }

  const cells = new Map<string, ModelCell>();
  for (const fact of settled) {
    const key = `${fact.localDayOfWeek}|${fact.localHour}`;
    const cell = cells.get(key) ?? {
      dayOfWeek: fact.localDayOfWeek,
      hour: fact.localHour,
      numerator: 0,
      weight: 0,
    };
    if (config.metric === 'conversion_rate') {
      cell.numerator += fact.purchases;
      cell.weight += fact.clicks;
    } else {
      cell.numerator += fact.sales;
      cell.weight += fact.cost;
    }
    cells.set(key, cell);
  }

  const hourlyBlocks: DaypartingScheduleBlock[] = [];
  for (const cell of [...cells.values()].sort(compareCells)) {
    if (cell.weight < config.minimumCellWeight || cell.weight <= 0) continue;
    const observed = cell.numerator / cell.weight;
    const shrunk = (
      observed * cell.weight + config.baselineValue * config.priorWeight
    ) / (cell.weight + config.priorWeight);
    const relativePercent = (shrunk / config.baselineValue - 1) * 100;
    const adjustmentPercent = quantize(
      clamp(relativePercent, config.minimumAdjustmentPercent, config.maximumAdjustmentPercent),
      config.adjustmentStepPercent,
    );
    if (adjustmentPercent === 0) continue;
    hourlyBlocks.push({
      dayOfWeek: cell.dayOfWeek,
      startHour: cell.hour,
      endHour: cell.hour + 1,
      adjustmentPercent,
      confidence: round(cell.weight / (cell.weight + config.priorWeight), 6),
    });
  }

  const dates = settled.map((fact) => fact.localDate).sort();
  return DaypartingScheduleProposal.parse({
    id: randomUUID(),
    profileId,
    campaignId,
    baselineLabel: config.baselineLabel,
    evidenceStart: dates[0],
    evidenceEnd: dates.at(-1),
    settledHours: new Set(settled.map((fact) => fact.utcHour)).size,
    blocks: mergeAdjacentDaypartingBlocks(hourlyBlocks),
    status: 'proposed',
  });
}

/** Merge consecutive hours with the same proposed adjustment. */
export function mergeAdjacentDaypartingBlocks(
  blocks: readonly DaypartingScheduleBlock[],
): DaypartingScheduleBlock[] {
  const sorted = [...blocks].sort((left, right) =>
    left.dayOfWeek - right.dayOfWeek || left.startHour - right.startHour,
  );
  const merged: DaypartingScheduleBlock[] = [];
  for (const block of sorted) {
    const parsed = DaypartingScheduleProposal.shape.blocks.element.parse(block);
    const prior = merged.at(-1);
    if (
      prior &&
      prior.dayOfWeek === parsed.dayOfWeek &&
      prior.endHour === parsed.startHour &&
      prior.adjustmentPercent === parsed.adjustmentPercent
    ) {
      prior.endHour = parsed.endHour;
      prior.confidence = Math.min(prior.confidence, parsed.confidence);
    } else {
      merged.push({ ...parsed });
    }
  }
  return merged;
}

export function exportDaypartingSchedule(
  proposalValue: DaypartingScheduleProposalValue,
): { json: string; csv: string } {
  const proposal = DaypartingScheduleProposal.parse(proposalValue);
  const header = [
    'profile_id', 'campaign_id', 'baseline', 'evidence_start', 'evidence_end',
    'settled_hours', 'day_of_week', 'start_hour', 'end_hour',
    'adjustment_percent', 'confidence', 'status',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const block of proposal.blocks) {
    lines.push([
      proposal.profileId,
      proposal.campaignId,
      proposal.baselineLabel,
      proposal.evidenceStart,
      proposal.evidenceEnd,
      proposal.settledHours,
      block.dayOfWeek,
      block.startHour,
      block.endHour,
      block.adjustmentPercent,
      block.confidence,
      proposal.status,
    ].map(csvCell).join(','));
  }
  return { json: JSON.stringify(proposal, null, 2), csv: `${lines.join('\n')}\n` };
}

interface MetricRecord {
  campaignId: string;
  impressions: number;
  clicks: number;
  cost: number;
  purchases: number;
  sales: number;
  budgetUsagePercent: number | null;
}

interface ParsedEvent {
  event: StoredMarketingStreamEvent;
  records: MetricRecord[];
}

interface ModelCell {
  dayOfWeek: number;
  hour: number;
  numerator: number;
  weight: number;
}

function stageLedgerEvents(
  profileId: string,
  values: readonly unknown[],
): { events: MarketingStreamLedgerEventValue[]; refusals: MarketingStreamRefusal[] } {
  const events: MarketingStreamLedgerEventValue[] = [];
  const refusals: MarketingStreamRefusal[] = [];
  values.forEach((value, index) => {
    const parsed = MarketingStreamLedgerEvent.safeParse(value);
    if (!parsed.success) {
      refusals.push({ index, messageId: readMessageId(value), scope: null, reason: 'invalid ledger event' });
      return;
    }
    if (parsed.data.profileId !== profileId) {
      refusals.push({ index, messageId: parsed.data.messageId, scope: null, reason: 'event belongs to another profile' });
      return;
    }
    if (new Date(parsed.data.receivedAt) < new Date(parsed.data.eventTime)) {
      refusals.push({ index, messageId: parsed.data.messageId, scope: null, reason: 'event was received before it occurred' });
      return;
    }
    events.push(parsed.data);
  });
  return { events, refusals };
}

function parseEventMetrics(event: StoredMarketingStreamEvent, currencyCode: string): MetricRecord[] {
  const payload = event.rawPayload;
  const payloadCurrency = optionalString(payload['currencyCode']);
  if (payloadCurrency !== null && payloadCurrency !== currencyCode) {
    throw new MarketingStreamNormalizationError(
      `message currency ${payloadCurrency} does not match profile currency ${currencyCode}`,
    );
  }
  const rawMetrics = payload['metrics'];
  if (!Array.isArray(rawMetrics)) {
    throw new MarketingStreamNormalizationError('raw payload has no metrics array');
  }
  return rawMetrics.map((value, index) => parseMetricRecord(event, value, index));
}

function parseMetricRecord(
  event: StoredMarketingStreamEvent,
  value: unknown,
  index: number,
): MetricRecord {
  if (!isRecord(value)) throw new MarketingStreamNormalizationError(`metric ${index} is not an object`);
  const campaignId = requiredString(value['campaignId'], `metric ${index} campaignId`);
  if (event.dataset === 'traffic') {
    const impressions = metric(value['impressions'], `metric ${index} impressions`, true);
    const clicks = metric(value['clicks'], `metric ${index} clicks`, true);
    if (clicks > impressions) {
      throw new MarketingStreamNormalizationError(`metric ${index} has more clicks than impressions`);
    }
    return {
      campaignId,
      impressions,
      clicks,
      cost: metric(value['cost'], `metric ${index} cost`),
      purchases: 0,
      sales: 0,
      budgetUsagePercent: null,
    };
  }
  if (event.dataset === 'conversion') {
    return {
      campaignId,
      impressions: 0,
      clicks: 0,
      cost: 0,
      purchases: metric(value['purchases'], `metric ${index} purchases`, true),
      sales: metric(value['sales'], `metric ${index} sales`),
      budgetUsagePercent: null,
    };
  }
  return {
    campaignId,
    impressions: 0,
    clicks: 0,
    cost: 0,
    purchases: 0,
    sales: 0,
    budgetUsagePercent: metric(value['budgetUsagePercent'], `metric ${index} budgetUsagePercent`),
  };
}

function aggregateScope(
  profileId: string,
  scope: MarketingStreamScope,
  parsedEvents: readonly ParsedEvent[],
  policy: MarketingStreamNormalizationPolicy,
): MarketingStreamHourlyFactValue[] {
  const campaigns = new Map<string, {
    impressions: number;
    clicks: number;
    cost: number;
    purchases: number;
    sales: number;
    budgetUsagePercent: number | null;
    sourceEventIds: Set<string>;
  }>();
  let latestRevisionReceivedAt: Date | null = null;
  for (const parsed of parsedEvents) {
    if (parsed.event.revision > 0) {
      const receivedAt = new Date(parsed.event.receivedAt);
      if (latestRevisionReceivedAt === null || receivedAt > latestRevisionReceivedAt) {
        latestRevisionReceivedAt = receivedAt;
      }
    }
    for (const record of parsed.records) {
      const aggregate = campaigns.get(record.campaignId) ?? {
        impressions: 0,
        clicks: 0,
        cost: 0,
        purchases: 0,
        sales: 0,
        budgetUsagePercent: null,
        sourceEventIds: new Set<string>(),
      };
      aggregate.impressions += record.impressions;
      aggregate.clicks += record.clicks;
      aggregate.cost += record.cost;
      aggregate.purchases += record.purchases;
      aggregate.sales += record.sales;
      aggregate.budgetUsagePercent = maxNullable(aggregate.budgetUsagePercent, record.budgetUsagePercent);
      aggregate.sourceEventIds.add(parsed.event.id);
      campaigns.set(record.campaignId, aggregate);
    }
  }

  const utcHour = truncateUtcHour(scope.utcHour);
  const hourDate = new Date(utcHour);
  const ageHours = (policy.now.getTime() - hourDate.getTime()) / 3_600_000;
  if (ageHours < 0) throw new MarketingStreamNormalizationError(`future Stream hour ${utcHour}`);
  const revisionAgeHours = latestRevisionReceivedAt === null
    ? Number.POSITIVE_INFINITY
    : (policy.now.getTime() - latestRevisionReceivedAt.getTime()) / 3_600_000;
  const settlingState = ageHours < policy.settlingWindowHours
    ? 'settling'
    : revisionAgeHours < policy.settlingWindowHours
      ? 'revised'
      : 'settled';
  const local = profileLocalParts(policy.profileTimeZone, hourDate);
  return [...campaigns.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([campaignId, value]) =>
    MarketingStreamHourlyFact.parse({
      profileId,
      adProduct: scope.adProduct,
      campaignId,
      utcHour,
      profileTimeZone: policy.profileTimeZone,
      localDate: local.date,
      localHour: local.hour,
      localDayOfWeek: local.dayOfWeek,
      currencyCode: policy.currencyCode,
      impressions: value.impressions,
      clicks: value.clicks,
      cost: round(value.cost, 6),
      purchases: value.purchases,
      sales: round(value.sales, 6),
      budgetUsagePercent: value.budgetUsagePercent,
      budgetCapped: value.budgetUsagePercent !== null && value.budgetUsagePercent >= policy.budgetCappedAtPercent,
      settlingState,
      sourceEvents: value.sourceEventIds.size,
    }),
  );
}

function profileLocalParts(
  timeZone: string,
  date: Date,
): { date: string; hour: number; dayOfWeek: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
  } catch (cause) {
    throw new MarketingStreamNormalizationError(
      `invalid profile timezone: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const value = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((part) => part.type === type)?.value;
    if (!found) throw new MarketingStreamNormalizationError(`timezone formatter omitted ${type}`);
    return found;
  };
  const weekdays: Readonly<Record<string, number>> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const weekday = value('weekday');
  const dayOfWeek = weekdays[weekday];
  if (dayOfWeek === undefined) throw new MarketingStreamNormalizationError(`unknown weekday ${weekday}`);
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    hour: Number(value('hour')),
    dayOfWeek,
  };
}

function validatePolicy(policy: MarketingStreamNormalizationPolicy): void {
  if (!Number.isFinite(policy.now.getTime())) throw new MarketingStreamNormalizationError('now is invalid');
  nonnegative('settlingWindowHours', policy.settlingWindowHours);
  nonnegative('budgetCappedAtPercent', policy.budgetCappedAtPercent);
  if (!/^[A-Z]{3}$/.test(policy.currencyCode)) {
    throw new MarketingStreamNormalizationError('currencyCode must be ISO 4217');
  }
  profileLocalParts(policy.profileTimeZone, policy.now);
}

function validateModelConfig(config: DaypartingModelConfig): void {
  if (config.baselineLabel.trim().length === 0) throw new MarketingStreamNormalizationError('baseline label is required');
  positive('baselineValue', config.baselineValue);
  positive('priorWeight', config.priorWeight);
  nonnegative('minimumCellWeight', config.minimumCellWeight);
  positive('adjustmentStepPercent', config.adjustmentStepPercent);
  if (config.minimumAdjustmentPercent > config.maximumAdjustmentPercent) {
    throw new MarketingStreamNormalizationError('minimum adjustment exceeds maximum adjustment');
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MarketingStreamNormalizationError(`${label} is required`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MarketingStreamNormalizationError('currencyCode must be a non-empty string');
  }
  return value;
}

function metric(value: unknown, label: string, integer = false): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || (integer && !Number.isInteger(parsed))) {
    throw new MarketingStreamNormalizationError(`${label} must be a non-negative${integer ? ' integer' : ''}`);
  }
  return parsed;
}

function readMessageId(value: unknown): string | null {
  return isRecord(value) && typeof value['messageId'] === 'string' ? value['messageId'] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncateUtcHour(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new MarketingStreamNormalizationError(`invalid UTC hour ${value}`);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function maxNullable(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function compareCells(left: ModelCell, right: ModelCell): number {
  return left.dayOfWeek - right.dayOfWeek || left.hour - right.hour;
}

function quantize(value: number, step: number): number {
  return round(Math.round(value / step) * step, 6);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function round(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

function positive(label: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new MarketingStreamNormalizationError(`${label} must be positive`);
}

function nonnegative(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new MarketingStreamNormalizationError(`${label} must be non-negative`);
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function emptyAppend(offeredMessages: number): MarketingStreamAppendResult {
  return {
    offeredMessages,
    insertedMessages: 0,
    duplicateMessages: 0,
    revisedMessages: 0,
    affectedScopes: [],
  };
}

function emptySnapshot(orgId: string, profileId: string): MarketingStreamSnapshot {
  return { orgId, profileId, scopes: [], events: [], sourceEventIds: {} };
}

function emptyProjection(): MarketingStreamProjectionResult {
  return { scopesReplaced: 0, factsDeleted: 0, factsInserted: 0, factsReadBack: 0 };
}
