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
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import {
  resolveMarketingStreamSubscriptionBinding,
  type DbHandle,
} from '@wizard-ads/db';
import {
  type AmazonMarketingStreamDatasetId,
  MarketingStreamBatchEnvelope,
  MarketingStreamLedgerEvent,
  type MarketingStreamBatchEnvelope as MarketingStreamBatchEnvelopeValue,
  type MarketingStreamLedgerEvent as MarketingStreamLedgerEventValue,
  type MarketingStreamNormalizationCounts,
  type MarketingStreamSubscriptionBinding,
} from '@wizard-ads/shared';
import { resolveStrategy } from '@wizard-ads/strategy';
import {
  DbMarketingStreamStore,
  processMarketingStreamBatch,
  type MarketingStreamBatchResult,
  type MarketingStreamNormalizationPolicy,
  type MarketingStreamStore,
} from './dayparting.js';

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
  configuration?(queueUrl: string): Promise<MarketingStreamQueueConfiguration>;
  extendVisibility?(queueUrl: string, receiptHandle: string, seconds: number): Promise<void>;
  destroy(): void;
}

export interface MarketingStreamQueueConfiguration {
  visibilityTimeoutSeconds: number;
  maxReceiveCount: number;
  deadLetterQueueConfigured: boolean;
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

  async configuration(queueUrl: string): Promise<MarketingStreamQueueConfiguration> {
    const response = await this.client.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['VisibilityTimeout', 'RedrivePolicy'],
    }));
    const visibilityTimeoutSeconds = Number(response.Attributes?.VisibilityTimeout);
    const redrivePolicy = parseRedrivePolicy(response.Attributes?.RedrivePolicy);
    const configuration = {
      visibilityTimeoutSeconds,
      maxReceiveCount: redrivePolicy.maxReceiveCount,
      deadLetterQueueConfigured: redrivePolicy.deadLetterTargetArn.length > 0,
    };
    assertQueueConfiguration(configuration);
    return configuration;
  }

  async extendVisibility(queueUrl: string, receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: seconds,
    }));
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

export type MarketingStreamProfileScope = MarketingStreamSubscriptionBinding;

export interface MarketingStreamProfileScopeResolver {
  resolve(input: {
    advertiserId: string;
    marketplaceId: string;
    datasetId: AmazonMarketingStreamDatasetId;
  }): Promise<MarketingStreamProfileScope>;
}

export class DbMarketingStreamProfileScopeResolver implements MarketingStreamProfileScopeResolver {
  constructor(private readonly handle: DbHandle) {}

  async resolve(input: {
    advertiserId: string;
    marketplaceId: string;
    datasetId: AmazonMarketingStreamDatasetId;
  }): Promise<MarketingStreamProfileScope> {
    return resolveMarketingStreamSubscriptionBinding(this.handle, input);
  }
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
  redriveEligible: number;
  rawRowsInserted: number;
  rawRowsDuplicated: number;
  normalizeJobsOffered: number;
  normalizeJobsCreated: number;
  normalizeJobsAlreadyPresent: number;
  visibilityHeartbeats: number;
  visibilityHeartbeatFailures: number;
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

export interface MarketingStreamNormalizeScheduler {
  enqueue(input: {
    orgId: string;
    profileId: string;
    messageIds: readonly string[];
    runAt: Date;
    dedupeKey: string;
  }): Promise<boolean>;
}

export interface MarketingStreamSqsConsumerOptions {
  queueUrl: string;
  queue?: MarketingStreamQueueClient;
  store: MarketingStreamStore;
  contexts: MarketingStreamRuntimeContextLoader;
  /** Required only when consuming Amazon's provider-native record. */
  profiles?: MarketingStreamProfileScopeResolver;
  process?: MarketingStreamProcessor;
  /** Production schedules durable replay; the inline processor remains a narrow test seam. */
  scheduler?: MarketingStreamNormalizeScheduler;
  now?: () => Date;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** Test seam; production derives one third of the configured visibility timeout. */
  visibilityHeartbeatIntervalMs?: number;
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
  private readonly scheduler: MarketingStreamNormalizeScheduler | undefined;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly logger: MarketingStreamConsumerLogger;
  private readonly counters = {
    received: 0,
    acknowledged: 0,
    failed: 0,
    providerFailures: 0,
    redriveEligible: 0,
    rawRowsInserted: 0,
    rawRowsDuplicated: 0,
    normalizeJobsOffered: 0,
    normalizeJobsCreated: 0,
    normalizeJobsAlreadyPresent: 0,
    visibilityHeartbeats: 0,
    visibilityHeartbeatFailures: 0,
  };
  private controller: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private inFlight = 0;
  private stopping = false;
  private lastSuccessAt: string | null = null;
  private lastErrorAt: string | null = null;
  private lastErrorKind: string | null = null;
  private queueConfiguration: MarketingStreamQueueConfiguration | null = null;
  private readonly visibilityHeartbeatIntervalMs: number | undefined;

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
    this.scheduler = options.scheduler;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? abortableDelay;
    this.visibilityHeartbeatIntervalMs = options.visibilityHeartbeatIntervalMs;
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
    await this.ensureQueueConfiguration();
    if (signal.aborted) throw abortError();
    const messages = await this.queue.receive(this.queueUrl, signal);
    this.counters.received += messages.length;
    const groups = new Map<string, PreparedMarketingStreamDelivery[]>();
    for (const message of messages) {
      let heartbeat: MarketingStreamVisibilityHeartbeat | null = null;
      try {
        if (!message.body) throw new MarketingStreamDeliveryError('SQS delivery has no body');
        if (!message.receiptHandle) throw new MarketingStreamDeliveryError('SQS delivery has no receipt handle');
        if (this.queue.extendVisibility && this.queueConfiguration) {
          const intervalMs = visibilityHeartbeatInterval(
            this.queueConfiguration.visibilityTimeoutSeconds,
            this.visibilityHeartbeatIntervalMs,
          );
          heartbeat = new MarketingStreamVisibilityHeartbeat({
            renew: async () => {
              await this.queue.extendVisibility!(
                this.queueUrl,
                message.receiptHandle!,
                this.queueConfiguration!.visibilityTimeoutSeconds,
              );
              this.counters.visibilityHeartbeats += 1;
            },
            intervalMs,
            delay: abortableDelay,
            onFailure: (error) => {
              this.counters.visibilityHeartbeatFailures += 1;
              this.recordError(error);
              this.logger.error('Marketing Stream visibility heartbeat failed', {
                messageId: message.messageId,
                errorKind: errorKind(error),
              });
            },
          });
          await heartbeat.start();
        }
        const payload = parseMarketingStreamSqsBody(message.body);
        const envelope = payload.kind === 'envelope'
          ? payload.envelope
          : await this.providerEnvelope(payload.record);
        const key = `${envelope.orgId}|${envelope.profileId}`;
        const group = groups.get(key) ?? [];
        group.push({ message, envelope, heartbeat });
        groups.set(key, group);
      } catch (error) {
        await heartbeat?.stop();
        this.recordDeliveryFailure(message, error);
      }
    }
    for (const group of groups.values()) await this.processGroup(group);
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

  private async processGroup(group: readonly PreparedMarketingStreamDelivery[]): Promise<void> {
    const first = group[0];
    if (!first) return;
    this.inFlight += group.length;
    try {
      assertHealthyHeartbeats(group);
      const envelope = mergeDeliveryGroup(group);
      const receivedEvents = envelope.events.length;
      let insertedEvents = 0;
      let duplicateEvents = 0;
      if (this.scheduler) {
        const append = await this.store.append({
          orgId: envelope.orgId,
          profileId: envelope.profileId,
          events: envelope.events,
        });
        assertHealthyHeartbeats(group);
        if (
          append.offeredMessages !== receivedEvents
          || append.insertedMessages + append.duplicateMessages !== receivedEvents
        ) {
          throw new MarketingStreamDeliveryError('grouped raw-ledger counts do not reconcile');
        }
        insertedEvents = append.insertedMessages;
        duplicateEvents = append.duplicateMessages;
        this.counters.rawRowsInserted += insertedEvents;
        this.counters.rawRowsDuplicated += duplicateEvents;
        const messageIds = [...new Set(envelope.events.map((event) => event.messageId))].sort();
        this.counters.normalizeJobsOffered += 1;
        const created = await this.scheduler.enqueue({
          orgId: envelope.orgId,
          profileId: envelope.profileId,
          messageIds,
          runAt: this.now(),
          dedupeKey: normalizeDedupeKey(envelope.orgId, envelope.profileId, messageIds),
        });
        assertHealthyHeartbeats(group);
        if (created) this.counters.normalizeJobsCreated += 1;
        else this.counters.normalizeJobsAlreadyPresent += 1;
      } else {
        let context: MarketingStreamRuntimeContext;
        try {
          context = await this.contexts.load({
            orgId: envelope.orgId,
            profileId: envelope.profileId,
          });
        } catch (error) {
          if (error instanceof MarketingStreamConfigurationError) {
            const append = await this.store.append({
              orgId: envelope.orgId,
              profileId: envelope.profileId,
              events: envelope.events,
            });
            if (
              append.offeredMessages !== receivedEvents
              || append.insertedMessages + append.duplicateMessages !== receivedEvents
            ) {
              throw new MarketingStreamDeliveryError('deferred raw-ledger counts do not reconcile');
            }
          }
          throw error;
        }
        const result = await this.process(this.store, {
          orgId: envelope.orgId,
          profileId: envelope.profileId,
          events: envelope.events,
          policy: { ...context, now: this.now() },
        });
        assertHealthyHeartbeats(group);
        assertCompletedEnvelope(envelope, result);
        insertedEvents = result.append.insertedMessages;
        duplicateEvents = result.append.duplicateMessages;
        this.counters.rawRowsInserted += insertedEvents;
        this.counters.rawRowsDuplicated += duplicateEvents;
      }

      for (const delivery of group) await this.acknowledge(delivery);
      this.logger.info('Marketing Stream profile group retained and queued', {
        deliveries: group.length,
        receivedEvents,
        insertedEvents,
        duplicateEvents,
      });
    } catch (error) {
      for (const delivery of group) this.recordDeliveryFailure(delivery.message, error);
    } finally {
      await Promise.all(group.map((delivery) => delivery.heartbeat?.stop()));
      this.inFlight -= group.length;
    }
  }

  private async acknowledge(delivery: PreparedMarketingStreamDelivery): Promise<void> {
    const { message, heartbeat } = delivery;
    if (!message.receiptHandle) throw new MarketingStreamDeliveryError('SQS delivery has no receipt handle');
    try {
      heartbeat?.throwIfFailed();
      await this.queue.delete(this.queueUrl, message.receiptHandle);
      this.counters.acknowledged += 1;
      this.lastSuccessAt = this.now().toISOString();
    } catch (error) {
      this.recordDeliveryFailure(message, error);
    }
  }

  private recordDeliveryFailure(message: MarketingStreamQueueMessage, error: unknown): void {
    this.counters.failed += 1;
    if (
      this.queueConfiguration
      && message.approximateReceiveCount !== null
      && message.approximateReceiveCount >= this.queueConfiguration.maxReceiveCount
    ) this.counters.redriveEligible += 1;
    this.recordError(error);
    this.logger.error('Marketing Stream SQS delivery left for queue-managed redrive', {
      messageId: message.messageId,
      receiveCount: message.approximateReceiveCount,
      errorKind: errorKind(error),
    });
  }

  private async ensureQueueConfiguration(): Promise<void> {
    if (this.queueConfiguration !== null || !this.queue.configuration) return;
    this.queueConfiguration = await this.queue.configuration(this.queueUrl);
    assertQueueConfiguration(this.queueConfiguration);
    if (!this.queue.extendVisibility) {
      throw new MarketingStreamConfigurationError(
        'Marketing Stream SQS client must renew message visibility while processing',
      );
    }
    visibilityHeartbeatInterval(
      this.queueConfiguration.visibilityTimeoutSeconds,
      this.visibilityHeartbeatIntervalMs,
    );
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
      datasetId: record.datasetId,
    });
    return marketingStreamProviderEnvelope(record, scope, this.now());
  }
}

export function createMarketingStreamSqsConsumer(input: {
  handle: DbHandle;
  queueUrl: string;
  queue?: MarketingStreamQueueClient;
  scheduler?: MarketingStreamNormalizeScheduler;
  logger?: MarketingStreamConsumerLogger;
}): MarketingStreamSqsConsumer {
  return new MarketingStreamSqsConsumer({
    queueUrl: input.queueUrl,
    queue: input.queue,
    store: new DbMarketingStreamStore(input.handle),
    contexts: new DbMarketingStreamRuntimeContextLoader(input.handle),
    profiles: new DbMarketingStreamProfileScopeResolver(input.handle),
    scheduler: input.scheduler,
    logger: input.logger,
  });
}

type SupportedProviderDatasetId = AmazonMarketingStreamDatasetId;

export interface ParsedMarketingStreamProviderRecord {
  advertiserId: string;
  marketplaceId: string;
  /** Provider idempotency key for traffic/conversion; budget records do not carry one. */
  idempotencyId: string | null;
  /** Dataset-specific immutable ledger identity. */
  providerEventId: string;
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

interface PreparedMarketingStreamDelivery {
  message: MarketingStreamQueueMessage;
  envelope: MarketingStreamBatchEnvelopeValue;
  heartbeat: MarketingStreamVisibilityHeartbeat | null;
}

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
  const idempotencyId = datasetId === 'budget-usage'
    ? null
    : providerString(value['idempotency_id'], 'idempotency_id');
  const providerEventId = idempotencyId ?? budgetProviderEventId(value, {
    advertiserId,
    marketplaceId,
  });
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
    providerEventId,
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
    source: 'amazon_marketing_stream',
    providerRecord: record.rawProviderRecord,
    metrics: [record.normalizedMetric],
  };
  if (record.currencyCode !== null) rawPayload['currencyCode'] = record.currencyCode;
  const event = MarketingStreamLedgerEvent.parse({
    profileId: scope.profileId,
    messageId: providerMessageId(record),
    dataset: record.dataset,
    adProduct: record.adProduct,
    eventTime: record.eventTime,
    receivedAt: receivedAt.toISOString(),
    // Sponsored-ads performance restatements are incremental records with new
    // idempotency ids. Do not invent a replacement version that Amazon did not send.
    revision: 0,
    payloadHash: createHash('sha256').update(stableJson(record.rawProviderRecord)).digest('hex'),
    rawPayload,
    provider: {
      bindingId: scope.id,
      subscriptionId: scope.subscriptionId,
      datasetId: record.datasetId,
      advertiserId: record.advertiserId,
      marketplaceId: record.marketplaceId,
      eventId: record.providerEventId,
    },
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
      budgetObservedAt: providerInstant(
        value['usage_updated_timestamp'],
        'usage_updated_timestamp',
      ),
    };
  }
  const campaignId = providerString(value['campaign_id'], 'campaign_id');
  if (datasetId.endsWith('-traffic')) {
    return {
      campaignId,
      impressions: providerNumber(value['impressions'], 'impressions', true, true),
      clicks: providerNumber(value['clicks'], 'clicks', true, true),
      cost: providerNumber(value['cost'], 'cost', false, true),
    };
  }
  // Fourteen-day click attribution is the one conversion window shared by
  // current SP, SB and SD sponsored-ads Stream schemas. View attribution stays
  // in the raw record and is not silently mixed into this comparable measure.
  return {
    campaignId,
    purchases: providerNumber(value['attributed_conversions_14d'], 'attributed_conversions_14d', true, true),
    sales: providerNumber(value['attributed_sales_14d'], 'attributed_sales_14d', false, true),
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
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(parsed)) {
    throw new MarketingStreamDeliveryError(
      `provider ${field} must include an explicit UTC or numeric offset`,
    );
  }
  const date = new Date(parsed);
  if (!Number.isFinite(date.getTime())) {
    throw new MarketingStreamDeliveryError(`provider ${field} is not an ISO timestamp`);
  }
  return date.toISOString();
}

function providerNumber(
  value: unknown,
  field: string,
  integer = false,
  signed = false,
): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || (!signed && value < 0)
    || (integer && (!Number.isSafeInteger(value)))
  ) {
    throw new MarketingStreamDeliveryError(
      `provider ${field} must be a ${signed ? 'signed ' : 'non-negative'}${integer ? 'safe integer' : 'number'}`,
    );
  }
  return value;
}

function providerMessageId(record: ParsedMarketingStreamProviderRecord): string {
  return [
    record.datasetId,
    record.advertiserId,
    record.marketplaceId,
    record.providerEventId,
  ].join(':');
}

/**
 * Amazon's budget-usage schema has no `idempotency_id`. Its immutable
 * observation identity is therefore the provider routing identity, campaign
 * budget scope, product, observation timestamp, and a hash of the complete
 * canonical provider record. Exact SQS/SNS redelivery produces the same key;
 * a later observation (including a lower corrected usage value) remains a
 * distinct ledger event.
 */
function budgetProviderEventId(
  value: Record<string, unknown>,
  identity: { advertiserId: string; marketplaceId: string },
): string {
  const canonicalRecordHash = createHash('sha256').update(stableJson(value)).digest('hex');
  const immutableIdentity = {
    datasetId: 'budget-usage',
    advertiserId: identity.advertiserId,
    marketplaceId: identity.marketplaceId,
    budgetScopeType: providerString(value['budget_scope_type'], 'budget_scope_type'),
    budgetScopeId: providerString(value['budget_scope_id'], 'budget_scope_id'),
    advertisingProductType: providerString(
      value['advertising_product_type'],
      'advertising_product_type',
    ).toLowerCase(),
    observedAt: providerInstant(value['usage_updated_timestamp'], 'usage_updated_timestamp'),
    canonicalRecordHash,
  };
  return `budget:${createHash('sha256').update(stableJson(immutableIdentity)).digest('hex')}`;
}

function mergeDeliveryGroup(
  group: readonly PreparedMarketingStreamDelivery[],
): MarketingStreamBatchEnvelopeValue {
  const first = group[0];
  if (!first) throw new MarketingStreamDeliveryError('cannot merge an empty delivery group');
  return MarketingStreamBatchEnvelope.parse({
    schema: 'wizard-ads.marketing-stream-batch.v1',
    orgId: first.envelope.orgId,
    profileId: first.envelope.profileId,
    events: group.flatMap((delivery) => delivery.envelope.events),
  });
}

function normalizeDedupeKey(
  orgId: string,
  profileId: string,
  messageIds: readonly string[],
): string {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ orgId, profileId, messageIds: [...messageIds].sort() }))
    .digest('hex');
  return `marketing-stream:normalize:${fingerprint}`;
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

function parseRedrivePolicy(value: string | undefined): {
  maxReceiveCount: number;
  deadLetterTargetArn: string;
} {
  if (!value) return { maxReceiveCount: Number.NaN, deadLetterTargetArn: '' };
  try {
    const decoded = JSON.parse(value) as unknown;
    if (!isRecord(decoded)) throw new Error('not an object');
    return {
      maxReceiveCount: Number(decoded['maxReceiveCount']),
      deadLetterTargetArn: typeof decoded['deadLetterTargetArn'] === 'string'
        ? decoded['deadLetterTargetArn']
        : '',
    };
  } catch {
    throw new MarketingStreamConfigurationError('SQS redrive policy is invalid');
  }
}

function assertQueueConfiguration(configuration: MarketingStreamQueueConfiguration): void {
  if (
    !Number.isInteger(configuration.visibilityTimeoutSeconds)
    || configuration.visibilityTimeoutSeconds < 30
  ) {
    throw new MarketingStreamConfigurationError(
      'Marketing Stream SQS visibility timeout must be at least 30 seconds',
    );
  }
  if (!Number.isInteger(configuration.maxReceiveCount) || configuration.maxReceiveCount < 2) {
    throw new MarketingStreamConfigurationError(
      'Marketing Stream SQS redrive maxReceiveCount must be at least two',
    );
  }
  if (!configuration.deadLetterQueueConfigured) {
    throw new MarketingStreamConfigurationError('Marketing Stream SQS must have a dead-letter queue');
  }
}

function visibilityHeartbeatInterval(
  visibilityTimeoutSeconds: number,
  overrideMs: number | undefined,
): number {
  const timeoutMs = visibilityTimeoutSeconds * 1_000;
  const intervalMs = overrideMs ?? Math.floor(timeoutMs / 3);
  if (
    !Number.isInteger(intervalMs)
    || intervalMs < 1
    || intervalMs > Math.floor(timeoutMs / 2)
  ) {
    throw new MarketingStreamConfigurationError(
      'Marketing Stream visibility heartbeat must be a positive interval no greater than half the queue timeout',
    );
  }
  return intervalMs;
}

function assertHealthyHeartbeats(group: readonly PreparedMarketingStreamDelivery[]): void {
  for (const delivery of group) delivery.heartbeat?.throwIfFailed();
}

class MarketingStreamVisibilityHeartbeat {
  private readonly controller = new AbortController();
  private loop: Promise<void> | null = null;
  private failure: unknown = null;

  constructor(private readonly input: {
    renew: () => Promise<void>;
    intervalMs: number;
    delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    onFailure: (error: unknown) => void;
  }) {}

  async start(): Promise<void> {
    await this.renew();
    this.loop = this.run();
  }

  throwIfFailed(): void {
    if (this.failure !== null) throw this.failure;
  }

  async stop(): Promise<void> {
    this.controller.abort();
    await this.loop;
    this.loop = null;
  }

  private async run(): Promise<void> {
    while (!this.controller.signal.aborted) {
      try {
        await this.input.delay(this.input.intervalMs, this.controller.signal);
        if (this.controller.signal.aborted) return;
        await this.renew();
      } catch (error) {
        if (this.controller.signal.aborted && isAbortError(error)) return;
        this.fail(error);
        return;
      }
    }
  }

  private async renew(): Promise<void> {
    try {
      await this.input.renew();
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  private fail(error: unknown): void {
    if (this.failure !== null) return;
    this.failure = error;
    this.input.onFailure(error);
    this.controller.abort();
  }
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
