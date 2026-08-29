/**
 * Always-on Amazon Marketing Stream SQS ingress.
 *
 * The queue carries `MarketingStreamBatchEnvelope`, either directly (raw SQS
 * delivery) or inside the standard SNS `Notification.Message` string. The
 * subscription/fanout boundary maps provider records into that shared
 * contract; this process validates tenant scope, loads the profile's timezone
 * and currency plus tenant-owned settling policy, then appends and normalizes
 * the complete envelope before deleting the SQS delivery.
 *
 * This module has no Amazon Ads write client. SQS DeleteMessage is an
 * acknowledgement of durable ingestion, not an advertising mutation.
 */
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import type { DbHandle } from '@wizard-ads/db';
import {
  MarketingStreamBatchEnvelope,
  type MarketingStreamBatchEnvelope as MarketingStreamBatchEnvelopeValue,
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
      const envelope = parseMarketingStreamSqsBody(message.body);
      const context = await this.contexts.load({
        orgId: envelope.orgId,
        profileId: envelope.profileId,
      });
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
    logger: input.logger,
  });
}

/** Accept raw SQS delivery or the normal SNS notification wrapper. */
export function parseMarketingStreamSqsBody(body: string): MarketingStreamBatchEnvelopeValue {
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
  if (!parsed.success) throw new MarketingStreamDeliveryError('SQS body is not a Marketing Stream batch envelope');
  return parsed.data;
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
