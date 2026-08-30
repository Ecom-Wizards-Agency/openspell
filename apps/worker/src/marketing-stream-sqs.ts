/**
 * Always-on Amazon Marketing Stream SQS ingress.
 *
 * The queue accepts Amazon's documented sponsored-ads records directly, or a
 * legacy `MarketingStreamBatchEnvelope`. Both may arrive inside the standard
 * SNS `Notification.Message` string. Provider identity is resolved against an
 * enabled Ads profile before the record becomes an internal ledger event; no
 * campaign id is ever used to infer tenant scope.
 *
 * This module has no Amazon Ads write client. SQS DeleteMessage is an
 * acknowledgement of durable ingestion, not an advertising mutation.
 */
import { createHash } from 'node:crypto';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import type { DbHandle } from '@wizard-ads/db';
import {
  MarketingStreamBatchEnvelope,
  MarketingStreamLedgerEvent,
  type MarketingStreamBatchEnvelope as MarketingStreamBatchEnvelopeValue,
  type MarketingStreamLedgerEvent as MarketingStreamLedgerEventValue,
  type MarketingStreamNormalizationCounts,
} from '@wizard-ads/shared';
import { resolveStrategy } from '@wizard-ads/strategy';
import {
  DbMarketingStreamStore,
  processMarketingStreamBatch,
  type MarketingStreamBatchResult,
  type MarketingStreamNormalizationPolicy,
  type MarketingStreamStore,
} from './dayparting.js';
import { marketplaceIdForCountry } from './marketplaces.js';

const RECEIVE_BATCH_SIZE = 10;
const LONG_POLL_SECONDS = 20;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

export interface MarketingStreamQueueMessage {
  messageId: string | null;
  receiptHandle: string | null;
  body: string | null;
  approximateReceiveCount: number | null;
}

/** Narrow transport seam: unit tests never need AWS credentials or a queue. */
export interface MarketingStreamQueueClient {
  receive(queueUrl: string, signal: AbortSignal): Promise<MarketingStreamQueueMessage[]>;
  delete(queueUrl: string, receiptHandle: string): Promise<void>;
  destroy(): void;
}

export class AwsMarketingStreamQueueClient implements MarketingStreamQueueClient {
  constructor(private readonly client = new SQSClient({})) {}

  async receive(queueUrl: string, signal: AbortSignal): Promise<MarketingStreamQueueMessage[]> {
    const response = await this.client.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: RECEIVE_BATCH_SIZE,
      WaitTimeSeconds: LONG_POLL_SECONDS,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    }), { abortSignal: signal });
    return (response.Messages ?? []).map(toQueueMessage);
  }

  async delete(queueUrl: string, receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
  }

  destroy(): void {
    this.client.destroy();
  }
}

export interface MarketingStreamRuntimeContext {
  profileTimeZone: string;
  currencyCode: string;
  settlingWindowHours: number;
  budgetCappedAtPercent: number;
}

export interface MarketingStreamRuntimeContextLoader {
  load(input: { orgId: string; profileId: string }): Promise<MarketingStreamRuntimeContext>;
}

export interface MarketingStreamProfileScope {
  orgId: string;
  profileId: string;
}

export interface MarketingStreamProfileScopeResolver {
  resolve(input: { advertiserId: string; marketplaceId: string }): Promise<MarketingStreamProfileScope>;
}

interface MarketingStreamProfileCandidate extends MarketingStreamProfileScope {
  countryCode: string;
}

export class DbMarketingStreamProfileScopeResolver implements MarketingStreamProfileScopeResolver {
  constructor(private readonly handle: DbHandle) {}

  async resolve(input: { advertiserId: string; marketplaceId: string }): Promise<MarketingStreamProfileScope> {
    const candidates = await this.handle.sql<{
      id: string;
      org_id: string;
      country_code: string;
    }[]>`
      select id, org_id, country_code
        from public.ad_profiles
       where sync_enabled = true
         and (
           amazon_profile_id = ${input.advertiserId}
           or amazon_account_id = ${input.advertiserId}
         )
    `;
    return resolveMarketingStreamProfileScope(
      candidates.map((candidate) => ({
        orgId: candidate.org_id,
        profileId: candidate.id,
        countryCode: candidate.country_code,
      })),
      input.marketplaceId,
    );
  }
}

export function resolveMarketingStreamProfileScope(
  candidates: readonly MarketingStreamProfileCandidate[],
  marketplaceId: string,
): MarketingStreamProfileScope {
  const matches = candidates.filter(
    (candidate) => marketplaceIdForCountry(candidate.countryCode) === marketplaceId,
  );
  if (matches.length === 0) {
    throw new MarketingStreamConfigurationError(
      'provider advertiser and marketplace are not bound to an enabled profile',
    );
  }
  if (matches.length !== 1) {
    throw new MarketingStreamConfigurationError(
      'provider advertiser and marketplace resolve to more than one enabled profile',
    );
  }
  return { orgId: matches[0]!.orgId, profileId: matches[0]!.profileId };
}

/**
 * Load operational identity from the profile and doctrine from the layered
 * tenant/profile strategy. Missing policy is an error, never a hidden default.
 */
export class DbMarketingStreamRuntimeContextLoader implements MarketingStreamRuntimeContextLoader {
  constructor(private readonly handle: DbHandle) {}

  async load(input: { orgId: string; profileId: string }): Promise<MarketingStreamRuntimeContext> {
    const [profile, strategyRows] = await Promise.all([
      this.handle.sql<{
        timezone: string;
        currency_code: string;
        goal_lens: string | null;
      }[]>`
        select timezone, currency_code, goal_lens
          from public.ad_profiles
         where org_id = ${input.orgId}
           and id = ${input.profileId}
      `,
      this.handle.sql<{ profile_id: string | null; doc: Record<string, unknown> }[]>`
        select profile_id, doc
          from public.profile_strategy
         where org_id = ${input.orgId}
           and (profile_id is null or profile_id = ${input.profileId})
      `,
    ]);
    const account = profile[0];
    if (!account) throw new MarketingStreamConfigurationError('profile scope is not configured');
    const tenant = strategyRows.find((row) => row.profile_id === null)?.doc ?? null;
    const override = strategyRows.find((row) => row.profile_id === input.profileId)?.doc ?? null;
    const resolved = resolveStrategy({ goal: account.goal_lens, tenant, profile: override });
    const dayparting = resolved.value.dayparting;
    if (!dayparting) {
      throw new MarketingStreamConfigurationError('tenant dayparting policy is not configured');
    }
    return {
      profileTimeZone: account.timezone,
      currencyCode: account.currency_code,
      settlingWindowHours: dayparting.settling_window_hours,
      budgetCappedAtPercent: dayparting.budget_capped_at_percent,
    };
  }
}

export class MarketingStreamConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketingStreamConfigurationError';
  }
}

export class MarketingStreamDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketingStreamDeliveryError';
  }
}

export interface MarketingStreamConsumerLogger {
  info(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export interface MarketingStreamConsumerStatus {
  enabled: true;
  running: boolean;
  stopping: boolean;
  inFlight: number;
  received: number;
  acknowledged: number;
  failed: number;
  providerFailures: number;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorKind: string | null;
}

export type MarketingStreamProcessor = (
  store: MarketingStreamStore,
  input: {
    orgId: string;
    profileId: string;
    events: readonly unknown[];
    policy: MarketingStreamNormalizationPolicy;
  },
) => Promise<MarketingStreamBatchResult>;

export interface MarketingStreamSqsConsumerOptions {
  queueUrl: string;
  queue?: MarketingStreamQueueClient;
  store: MarketingStreamStore;
  contexts: MarketingStreamRuntimeContextLoader;
  /** Required only when consuming Amazon's provider-native record. */
  profiles?: MarketingStreamProfileScopeResolver;
  process?: MarketingStreamProcessor;
  now?: () => Date;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  logger?: MarketingStreamConsumerLogger;
}

const consoleLogger: MarketingStreamConsumerLogger = {
  info: (message, details) => console.info(message, details ?? {}),
  error: (message, details) => console.error(message, details ?? {}),
};

export class MarketingStreamSqsConsumer {
  private readonly queueUrl: string;
  private readonly queue: MarketingStreamQueueClient;
  private readonly store: MarketingStreamStore;
  private readonly contexts: MarketingStreamRuntimeContextLoader;
  private readonly profiles: MarketingStreamProfileScopeResolver | undefined;
  private readonly process: MarketingStreamProcessor;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly logger: MarketingStreamConsumerLogger;
  private readonly counters = {
    received: 0,
    acknowledged: 0,
    failed: 0,
    providerFailures: 0,
  };
  private controller: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private inFlight = 0;
  private stopping = false;
  private lastSuccessAt: string | null = null;
  private lastErrorAt: string | null = null;
  private lastErrorKind: string | null = null;

  constructor(options: MarketingStreamSqsConsumerOptions) {
    if (options.queueUrl.trim().length === 0) {
      throw new MarketingStreamConfigurationError('Marketing Stream queue URL is empty');
    }
    this.queueUrl = options.queueUrl;
    this.queue = options.queue ?? new AwsMarketingStreamQueueClient();
    this.store = options.store;
    this.contexts = options.contexts;
    this.profiles = options.profiles;
    this.process = options.process ?? processMarketingStreamBatch;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? abortableDelay;
    this.logger = options.logger ?? consoleLogger;
  }

  status(): MarketingStreamConsumerStatus {
    return {
      enabled: true,
      running: this.loop !== null,
      stopping: this.stopping,
      inFlight: this.inFlight,
      ...this.counters,
      lastSuccessAt: this.lastSuccessAt,
      lastErrorAt: this.lastErrorAt,
      lastErrorKind: this.lastErrorKind,
    };
  }

  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.controller = new AbortController();
    this.loop = this.run(this.controller.signal).finally(() => {
      this.loop = null;
      this.controller = null;
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.controller?.abort();
    await this.loop;
    this.queue.destroy();
  }

  /** One long poll, exposed for deterministic runtime tests. */
  async pollOnce(signal: AbortSignal = new AbortController().signal): Promise<number> {
    const messages = await this.queue.receive(this.queueUrl, signal);
    this.counters.received += messages.length;
    for (const message of messages) await this.processDelivery(message);
    return messages.length;
  }

  private async run(signal: AbortSignal): Promise<void> {
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      try {
        await this.pollOnce(signal);
        consecutiveFailures = 0;
      } catch (error) {
        if (signal.aborted || isAbortError(error)) break;
        consecutiveFailures += 1;
        this.counters.providerFailures += 1;
        this.recordError(error);
        this.logger.error('Marketing Stream SQS receive failed', {
          errorKind: errorKind(error),
          retrying: true,
        });
        const retryMs = Math.min(RETRY_BASE_MS * (2 ** Math.min(consecutiveFailures - 1, 5)), RETRY_MAX_MS);
        await this.sleep(retryMs, signal).catch((sleepError: unknown) => {
          if (!signal.aborted && !isAbortError(sleepError)) throw sleepError;
        });
      }
    }
  }

  private async processDelivery(message: MarketingStreamQueueMessage): Promise<void> {
    this.inFlight += 1;
    try {
      if (!message.body) throw new MarketingStreamDeliveryError('SQS delivery has no body');
      if (!message.receiptHandle) throw new MarketingStreamDeliveryError('SQS delivery has no receipt handle');
      const payload = parseMarketingStreamSqsBody(message.body);
      const envelope = payload.kind === 'envelope'
        ? payload.envelope
        : await this.providerEnvelope(payload.record);
      let context: MarketingStreamRuntimeContext;
      try {
        context = await this.contexts.load({
          orgId: envelope.orgId,
          profileId: envelope.profileId,
        });
      } catch (error) {
        if (error instanceof MarketingStreamConfigurationError) {
          // Optional modelling policy must not become a raw-data-loss gate.
          // The scoped FK/tenant checks in the ledger append still reject an
          // unknown profile. A later SQS redelivery is idempotent and can
          // project these events once policy exists.
          const append = await this.store.append({
            orgId: envelope.orgId,
            profileId: envelope.profileId,
            events: envelope.events,
          });
          if (
            append.offeredMessages !== envelope.events.length ||
            append.insertedMessages + append.duplicateMessages !== envelope.events.length
          ) {
            throw new MarketingStreamDeliveryError('deferred raw-ledger counts do not reconcile');
          }
          this.logger.info('Marketing Stream evidence retained; projection deferred', {
            messageId: message.messageId,
            receivedEvents: envelope.events.length,
            insertedEvents: append.insertedMessages,
            duplicateEvents: append.duplicateMessages,
          });
        }
        throw error;
      }
      const result = await this.process(this.store, {
        orgId: envelope.orgId,
        profileId: envelope.profileId,
        events: envelope.events,
        policy: { ...context, now: this.now() },
      });
      assertCompletedEnvelope(envelope, result);

      // Receipt deletion is deliberately last. A crash after persistence and
      // before this call redelivers an idempotent batch; a crash before
      // persistence never acknowledges data it did not durably count.
      await this.queue.delete(this.queueUrl, message.receiptHandle);
      this.counters.acknowledged += 1;
      this.lastSuccessAt = this.now().toISOString();
      this.logger.info('Marketing Stream SQS delivery acknowledged', {
        messageId: message.messageId,
        receiveCount: message.approximateReceiveCount,
        receivedEvents: result.counts.receivedMessages,
        duplicateEvents: result.counts.duplicateMessages,
        revisedEvents: result.counts.revisedMessages,
        normalizedRows: result.counts.normalizedRows,
      });
    } catch (error) {
      this.counters.failed += 1;
      this.recordError(error);
      this.logger.error('Marketing Stream SQS delivery left for redrive', {
        messageId: message.messageId,
        receiveCount: message.approximateReceiveCount,
        errorKind: errorKind(error),
      });
    } finally {
      this.inFlight -= 1;
    }
  }

  private recordError(error: unknown): void {
    this.lastErrorAt = this.now().toISOString();
    this.lastErrorKind = errorKind(error);
  }

  private async providerEnvelope(
    record: ParsedMarketingStreamProviderRecord,
  ): Promise<MarketingStreamBatchEnvelopeValue> {
    if (!this.profiles) {
      throw new MarketingStreamConfigurationError('provider profile resolver is not configured');
    }
    const scope = await this.profiles.resolve({
      advertiserId: record.advertiserId,
      marketplaceId: record.marketplaceId,
    });
    return marketingStreamProviderEnvelope(record, scope, this.now());
  }
}

export function createMarketingStreamSqsConsumer(input: {
  handle: DbHandle;
  queueUrl: string;
  queue?: MarketingStreamQueueClient;
  logger?: MarketingStreamConsumerLogger;
}): MarketingStreamSqsConsumer {
  return new MarketingStreamSqsConsumer({
    queueUrl: input.queueUrl,
    queue: input.queue,
    store: new DbMarketingStreamStore(input.handle),
    contexts: new DbMarketingStreamRuntimeContextLoader(input.handle),
    profiles: new DbMarketingStreamProfileScopeResolver(input.handle),
    logger: input.logger,
  });
}

type SupportedProviderDatasetId =
  | 'sp-traffic'
  | 'sp-conversion'
  | 'sb-traffic'
  | 'sb-conversion'
  | 'sd-traffic'
  | 'sd-conversion'
  | 'budget-usage';

export interface ParsedMarketingStreamProviderRecord {
  advertiserId: string;
  marketplaceId: string;
  idempotencyId: string;
  datasetId: SupportedProviderDatasetId;
  dataset: MarketingStreamLedgerEventValue['dataset'];
  adProduct: MarketingStreamLedgerEventValue['adProduct'];
  eventTime: string;
  rawProviderRecord: Record<string, unknown>;
  normalizedMetric: Record<string, unknown>;
  currencyCode: string | null;
}

export type ParsedMarketingStreamSqsBody =
  | { kind: 'envelope'; envelope: MarketingStreamBatchEnvelopeValue }
  | { kind: 'provider'; record: ParsedMarketingStreamProviderRecord };

/** Accept direct SQS delivery or the normal SNS notification wrapper. */
export function parseMarketingStreamSqsBody(body: string): ParsedMarketingStreamSqsBody {
  let decoded = parseJson(body);
  if (isRecord(decoded) && decoded['Type'] === 'Notification') {
    const message = decoded['Message'];
    if (typeof message !== 'string') {
      throw new MarketingStreamDeliveryError('SNS notification has no string Message');
    }
    decoded = parseJson(message);
  } else if (isRecord(decoded) && decoded['Type'] === 'SubscriptionConfirmation') {
    throw new MarketingStreamDeliveryError('subscription confirmation needs the provisioning workflow');
  }
  const parsed = MarketingStreamBatchEnvelope.safeParse(decoded);
  if (parsed.success) return { kind: 'envelope', envelope: parsed.data };
  if (isRecord(decoded) && decoded['schema'] === 'wizard-ads.marketing-stream-batch.v1') {
    throw new MarketingStreamDeliveryError('SQS body is not a Marketing Stream batch envelope');
  }
  return { kind: 'provider', record: parseMarketingStreamProviderRecord(decoded) };
}

/** Pure provider-record adapter. The original record is retained byte-for-field in `rawProviderRecord`. */
export function parseMarketingStreamProviderRecord(value: unknown): ParsedMarketingStreamProviderRecord {
  if (!isRecord(value)) throw new MarketingStreamDeliveryError('provider record is not an object');
  const datasetId = providerDatasetId(value['dataset_id']);
  const advertiserId = providerString(value['advertiser_id'], 'advertiser_id');
  const marketplaceId = providerString(value['marketplace_id'], 'marketplace_id');
  const idempotencyId = providerString(value['idempotency_id'], 'idempotency_id');
  const dataset = datasetId === 'budget-usage'
    ? 'budget_usage'
    : datasetId.endsWith('-traffic') ? 'traffic' : 'conversion';
  const adProduct = datasetId === 'budget-usage'
    ? providerBudgetAdProduct(value['advertising_product_type'])
    : providerAdProduct(datasetId);
  const eventTime = providerInstant(
    datasetId === 'budget-usage' ? value['usage_updated_timestamp'] : value['time_window_start'],
    datasetId === 'budget-usage' ? 'usage_updated_timestamp' : 'time_window_start',
  );
  const currencyCode = datasetId === 'budget-usage'
    ? null
    : providerCurrency(value['currency']);
  return {
    advertiserId,
    marketplaceId,
    idempotencyId,
    datasetId,
    dataset,
    adProduct,
    eventTime,
    rawProviderRecord: { ...value },
    normalizedMetric: providerMetric(value, datasetId),
    currencyCode,
  };
}

export function marketingStreamProviderEnvelope(
  record: ParsedMarketingStreamProviderRecord,
  scope: MarketingStreamProfileScope,
  receivedAt: Date,
): MarketingStreamBatchEnvelopeValue {
  if (!Number.isFinite(receivedAt.getTime())) {
    throw new MarketingStreamDeliveryError('provider receive time is invalid');
  }
  const rawPayload: Record<string, unknown> = {
    providerRecord: record.rawProviderRecord,
    metrics: [record.normalizedMetric],
  };
  if (record.currencyCode !== null) rawPayload['currencyCode'] = record.currencyCode;
  const event = MarketingStreamLedgerEvent.parse({
    profileId: scope.profileId,
    messageId: record.idempotencyId,
    dataset: record.dataset,
    adProduct: record.adProduct,
    eventTime: record.eventTime,
    receivedAt: receivedAt.toISOString(),
    // Sponsored-ads performance restatements are incremental records with new
    // idempotency ids. Do not invent a replacement version that Amazon did not send.
    revision: 0,
    payloadHash: createHash('sha256').update(stableJson(record.rawProviderRecord)).digest('hex'),
    rawPayload,
  });
  return MarketingStreamBatchEnvelope.parse({
    schema: 'wizard-ads.marketing-stream-batch.v1',
    orgId: scope.orgId,
    profileId: scope.profileId,
    events: [event],
  });
}

function providerMetric(
  value: Record<string, unknown>,
  datasetId: SupportedProviderDatasetId,
): Record<string, unknown> {
  if (datasetId === 'budget-usage') {
    if (value['budget_scope_type'] !== 'CAMPAIGN') {
      throw new MarketingStreamDeliveryError('budget-usage record is not campaign scoped');
    }
    return {
      campaignId: providerString(value['budget_scope_id'], 'budget_scope_id'),
      budgetUsagePercent: providerNumber(
        value['budget_usage_percentage'],
        'budget_usage_percentage',
      ),
    };
  }
  const campaignId = providerString(value['campaign_id'], 'campaign_id');
  if (datasetId.endsWith('-traffic')) {
    return {
      campaignId,
      impressions: providerNumber(value['impressions'], 'impressions', true),
      clicks: providerNumber(value['clicks'], 'clicks', true),
      cost: providerNumber(value['cost'], 'cost'),
    };
  }
  // Fourteen-day click attribution is the one conversion window shared by
  // current SP, SB and SD sponsored-ads Stream schemas. View attribution stays
  // in the raw record and is not silently mixed into this comparable measure.
  return {
    campaignId,
    purchases: providerNumber(value['attributed_conversions_14d'], 'attributed_conversions_14d', true),
    sales: providerNumber(value['attributed_sales_14d'], 'attributed_sales_14d'),
  };
}

function providerDatasetId(value: unknown): SupportedProviderDatasetId {
  const parsed = providerString(value, 'dataset_id');
  switch (parsed) {
    case 'sp-traffic':
    case 'sp-conversion':
    case 'sb-traffic':
    case 'sb-conversion':
    case 'sd-traffic':
    case 'sd-conversion':
    case 'budget-usage':
      return parsed;
    default:
      throw new MarketingStreamDeliveryError('provider dataset is not supported by dayparting');
  }
}

function providerAdProduct(datasetId: SupportedProviderDatasetId): 'SP' | 'SB' | 'SD' {
  if (datasetId.startsWith('sp-')) return 'SP';
  if (datasetId.startsWith('sb-')) return 'SB';
  if (datasetId.startsWith('sd-')) return 'SD';
  throw new MarketingStreamDeliveryError('budget-usage record has no advertising product');
}

function providerBudgetAdProduct(value: unknown): 'SP' | 'SB' | 'SD' {
  const parsed = providerString(value, 'advertising_product_type').toLowerCase();
  if (parsed === 'sp') return 'SP';
  if (parsed === 'sb') return 'SB';
  if (parsed === 'sd') return 'SD';
  throw new MarketingStreamDeliveryError('budget-usage advertising product is unsupported');
}

function providerString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MarketingStreamDeliveryError(`provider ${field} is required`);
  }
  return value.trim();
}

function providerCurrency(value: unknown): string {
  const parsed = providerString(value, 'currency');
  if (!/^[A-Z]{3}$/.test(parsed)) {
    throw new MarketingStreamDeliveryError('provider currency is not ISO 4217');
  }
  return parsed;
}

function providerInstant(value: unknown, field: string): string {
  const parsed = providerString(value, field);
  const date = new Date(parsed);
  if (!Number.isFinite(date.getTime())) {
    throw new MarketingStreamDeliveryError(`provider ${field} is not an ISO timestamp`);
  }
  return date.toISOString();
}

function providerNumber(value: unknown, field: string, integer = false): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
    || (integer && (!Number.isSafeInteger(value)))
  ) {
    throw new MarketingStreamDeliveryError(
      `provider ${field} must be a non-negative${integer ? ' safe integer' : ' number'}`,
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new MarketingStreamDeliveryError('provider record is not JSON serializable');
  return encoded;
}

function assertCompletedEnvelope(
  envelope: MarketingStreamBatchEnvelopeValue,
  result: MarketingStreamBatchResult,
): void {
  const counts: MarketingStreamNormalizationCounts = result.counts;
  if (counts.receivedMessages !== envelope.events.length) {
    throw new MarketingStreamDeliveryError('processed event count does not match the envelope');
  }
  if (result.append.offeredMessages !== envelope.events.length) {
    throw new MarketingStreamDeliveryError('ledger offered count does not match the envelope');
  }
  if (result.append.insertedMessages + result.append.duplicateMessages !== envelope.events.length) {
    throw new MarketingStreamDeliveryError('ledger persisted count does not match the envelope');
  }
  if (
    counts.duplicateMessages !== result.append.duplicateMessages
    || counts.revisedMessages !== result.append.revisedMessages
  ) {
    throw new MarketingStreamDeliveryError('normalization and ledger event counts disagree');
  }
  if (counts.refusedMessages !== 0) {
    throw new MarketingStreamDeliveryError('one or more events were refused');
  }
  if (counts.normalizedRows !== result.projection.factsInserted) {
    throw new MarketingStreamDeliveryError('normalized row count does not match fact writes');
  }
  if (result.projection.factsInserted !== result.projection.factsReadBack) {
    throw new MarketingStreamDeliveryError('hourly fact read-back count does not match writes');
  }
}

function toQueueMessage(message: Message): MarketingStreamQueueMessage {
  const count = message.Attributes?.ApproximateReceiveCount;
  const parsedCount = count === undefined ? null : Number(count);
  return {
    messageId: message.MessageId ?? null,
    receiptHandle: message.ReceiptHandle ?? null,
    body: message.Body ?? null,
    approximateReceiveCount: Number.isInteger(parsedCount) && parsedCount !== null ? parsedCount : null,
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new MarketingStreamDeliveryError('SQS body is not valid JSON');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorKind(error: unknown): string {
  if (error instanceof Error && error.name.trim().length > 0) return error.name;
  return 'UnknownError';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(abortError());
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}
