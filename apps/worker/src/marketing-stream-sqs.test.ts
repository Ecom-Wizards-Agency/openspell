import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  MarketingStreamBatchEnvelope,
  MarketingStreamLedgerEvent,
} from '@wizard-ads/shared';
import type { MarketingStreamSnapshot } from '@wizard-ads/db';
import type { MarketingStreamStore } from './dayparting.js';
import { normalizeMarketingStreamSnapshot } from './dayparting.js';
import {
  MarketingStreamConfigurationError,
  MarketingStreamSqsConsumer,
  marketingStreamProviderEnvelope,
  parseMarketingStreamProviderRecord,
  parseMarketingStreamSqsBody,
  type MarketingStreamQueueClient,
  type MarketingStreamQueueMessage,
} from './marketing-stream-sqs.js';

const ORG = '74747474-7474-4474-8474-747474747474';
const PROFILE = '75757575-7575-4575-8575-757575757575';
const QUEUE_URL = 'https://sqs.example.invalid/synthetic';
const US_MARKETPLACE = 'ATVPDKIKX0DER';

function binding(datasetId: 'sp-traffic' | 'budget-usage' = 'sp-traffic') {
  return {
    id: '78787878-7878-4878-8878-787878787878',
    orgId: ORG,
    profileId: PROFILE,
    subscriptionId: 'subscription-one',
    datasetId,
    advertiserId: 'provider-advertiser-one',
    marketplaceId: US_MARKETPLACE,
    active: true,
  };
}

function providerMessageId(): string {
  return ['sp-traffic', 'provider-advertiser-one', US_MARKETPLACE, 'provider-event-one'].join(':');
}

describe('Marketing Stream SQS envelope', () => {
  it('accepts raw delivery and the standard SNS notification wrapper', () => {
    const envelope = batchEnvelope();
    expect(parseMarketingStreamSqsBody(JSON.stringify(envelope))).toEqual({
      kind: 'envelope',
      envelope,
    });
    expect(parseMarketingStreamSqsBody(JSON.stringify({
      Type: 'Notification',
      Message: JSON.stringify(envelope),
    }))).toEqual({ kind: 'envelope', envelope });
  });

  it('rejects subscription confirmation and mixed-profile deliveries', () => {
    expect(() => parseMarketingStreamSqsBody(JSON.stringify({
      Type: 'SubscriptionConfirmation',
      Token: 'synthetic',
    }))).toThrow(/provisioning workflow/);
    expect(() => parseMarketingStreamSqsBody(JSON.stringify({
      ...batchEnvelope(),
      events: [{ ...ledgerEvent(), profileId: ORG }],
    }))).toThrow(/batch envelope/);
  });

  it('maps a provider-native SNS traffic record without losing the source fields', () => {
    const provider = trafficRecord();
    const parsed = parseMarketingStreamSqsBody(JSON.stringify({
      Type: 'Notification',
      Message: JSON.stringify(provider),
    }));
    expect(parsed).toMatchObject({
      kind: 'provider',
      record: {
        idempotencyId: 'provider-event-one',
        dataset: 'traffic',
        adProduct: 'SP',
        eventTime: '2026-08-01T17:00:00.000Z',
        normalizedMetric: {
          campaignId: 'campaign-one', impressions: 12, clicks: 3, cost: 4.25,
        },
      },
    });
    if (parsed.kind !== 'provider') throw new Error('expected provider record');
    const envelope = marketingStreamProviderEnvelope(
      parsed.record,
      binding(),
      new Date('2026-08-01T17:05:00.000Z'),
    );
    expect(envelope.events).toHaveLength(1);
    expect(envelope.events[0]).toMatchObject({
      profileId: PROFILE,
      messageId: providerMessageId(),
      dataset: 'traffic',
      adProduct: 'SP',
      eventTime: '2026-08-01T17:00:00.000Z',
      revision: 0,
      provider: {
        bindingId: '78787878-7878-4878-8878-787878787878',
        subscriptionId: 'subscription-one',
        datasetId: 'sp-traffic',
        eventId: 'provider-event-one',
      },
      rawPayload: {
        providerRecord: provider,
        currencyCode: 'USD',
        metrics: [{ campaignId: 'campaign-one', impressions: 12, clicks: 3, cost: 4.25 }],
      },
    });
    expect(envelope.events[0]?.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('requires offset-bearing provider timestamps and accepts signed corrections', () => {
    expect(parseMarketingStreamProviderRecord({
      ...trafficRecord(),
      time_window_start: '2026-08-01T10:00:00+02:30',
      impressions: -5,
      clicks: -1,
      cost: -0.5,
    })).toMatchObject({
      eventTime: '2026-08-01T07:30:00.000Z',
      normalizedMetric: { impressions: -5, clicks: -1, cost: -0.5 },
    });
    expect(parseMarketingStreamProviderRecord({
      ...trafficRecord(), time_window_start: '2026-08-01T10:00:00Z',
    }).eventTime).toBe('2026-08-01T10:00:00.000Z');
    expect(() => parseMarketingStreamProviderRecord({
      ...trafficRecord(), time_window_start: '2026-08-01T10:00:00',
    })).toThrow(/explicit UTC or numeric offset/);
  });

  it('uses comparable 14-day click attribution for SP, SB, and SD conversion records', () => {
    for (const product of ['sp', 'sb', 'sd'] as const) {
      expect(parseMarketingStreamProviderRecord(conversionRecord(product))).toMatchObject({
        datasetId: `${product}-conversion`,
        dataset: 'conversion',
        adProduct: product.toUpperCase(),
        normalizedMetric: { campaignId: 'campaign-one', purchases: 2, sales: 18.75 },
      });
    }
  });

  it('maps campaign budget usage and refuses portfolio or unsupported records', () => {
    const parsed = parseMarketingStreamProviderRecord(budgetRecord());
    expect(parsed).toMatchObject({
      idempotencyId: null,
      dataset: 'budget_usage',
      adProduct: 'SB',
      eventTime: '2026-08-01T17:21:00.000Z',
      normalizedMetric: { campaignId: 'campaign-one', budgetUsagePercent: 85 },
    });
    expect(parsed.providerEventId).toMatch(/^budget:[a-f0-9]{64}$/);
    expect(() => parseMarketingStreamProviderRecord({
      ...budgetRecord(), budget_scope_type: 'PORTFOLIO',
    })).toThrow(/not campaign scoped/);
    expect(() => parseMarketingStreamProviderRecord({
      ...trafficRecord(), dataset_id: 'sb-rich-media',
    })).toThrow(/not supported/);
  });

  it('deduplicates exact native budget redelivery but projects a later lower observation', () => {
    const first = parseMarketingStreamProviderRecord(budgetRecord());
    const duplicate = parseMarketingStreamProviderRecord({ ...budgetRecord() });
    const later = parseMarketingStreamProviderRecord({
      ...budgetRecord(),
      budget_usage_percentage: 71,
      usage_updated_timestamp: '2026-08-01T10:31:00-07:00',
    });
    expect(duplicate.providerEventId).toBe(first.providerEventId);
    expect(later.providerEventId).not.toBe(first.providerEventId);

    const firstEvent = marketingStreamProviderEnvelope(
      first,
      binding('budget-usage'),
      new Date('2026-08-01T17:22:00.000Z'),
    ).events[0]!;
    const laterEvent = marketingStreamProviderEnvelope(
      later,
      binding('budget-usage'),
      new Date('2026-08-01T17:32:00.000Z'),
    ).events[0]!;
    expect(marketingStreamProviderEnvelope(
      duplicate,
      binding('budget-usage'),
      new Date('2026-08-01T17:23:00.000Z'),
    ).events[0]?.messageId).toBe(firstEvent.messageId);

    const scope = { adProduct: 'SB' as const, utcHour: '2026-08-01T17:00:00.000Z' };
    const snapshot: MarketingStreamSnapshot = {
      orgId: ORG,
      profileId: PROFILE,
      scopes: [scope],
      events: [
        { ...firstEvent, id: 'event-row-one', orgId: ORG },
        { ...laterEvent, id: 'event-row-two', orgId: ORG },
      ],
      sourceEventIds: { 'SB|2026-08-01T17:00:00.000Z': ['event-row-one', 'event-row-two'] },
    };
    const normalized = normalizeMarketingStreamSnapshot(snapshot, {
      profileTimeZone: 'UTC',
      currencyCode: 'USD',
      settlingWindowHours: 4,
      budgetCappedAtPercent: 80,
      now: new Date('2026-08-01T18:00:00.000Z'),
    });
    expect(normalized.refusals).toEqual([]);
    expect(normalized.facts).toHaveLength(1);
    expect(normalized.facts[0]).toMatchObject({
      budgetUsagePercent: 71,
      budgetCapped: false,
      sourceEvents: 2,
    });
  });

});

describe('Marketing Stream SQS acknowledgement', () => {
  it('groups one poll by profile, extends visibility, and schedules one replay', async () => {
    const first = delivery(batchEnvelope([ledgerEvent({ messageId: 'group-one' })]));
    const second = {
      ...delivery(batchEnvelope([ledgerEvent({ messageId: 'group-two' })])),
      messageId: 'sqs-two',
      receiptHandle: 'receipt-two',
    };
    const appended: string[][] = [];
    const scheduled: string[][] = [];
    const extended: string[] = [];
    const deleted: string[] = [];
    const base = unusedStore();
    const consumer = new MarketingStreamSqsConsumer({
      queueUrl: QUEUE_URL,
      queue: {
        receive: async () => [first, second],
        delete: async (_url, receipt) => { deleted.push(receipt); },
        configuration: async () => ({
          visibilityTimeoutSeconds: 60,
          maxReceiveCount: 3,
          deadLetterQueueConfigured: true,
        }),
        extendVisibility: async (_url, receipt) => { extended.push(receipt); },
        destroy: () => {},
      },
      store: {
        ...base,
        append: async ({ events }) => {
          appended.push(events.map((event) => event.messageId));
          return {
            offeredMessages: events.length,
            insertedMessages: events.length,
            duplicateMessages: 0,
            revisedMessages: 0,
            affectedScopes: [{ adProduct: 'SP', utcHour: '2026-08-01T10:00:00.000Z' }],
          };
        },
      },
      contexts: { load: async () => { throw new Error('inline processor must not run'); } },
      scheduler: {
        enqueue: async ({ messageIds }) => { scheduled.push([...messageIds]); return true; },
      },
      logger: silentLogger(),
    });

    expect(await consumer.pollOnce()).toBe(2);
    expect(appended).toEqual([['group-one', 'group-two']]);
    expect(scheduled).toEqual([['group-one', 'group-two']]);
    expect(extended).toEqual(['receipt-one', 'receipt-two']);
    expect(deleted).toEqual(['receipt-one', 'receipt-two']);
    expect(consumer.status()).toMatchObject({
      acknowledged: 2,
      failed: 0,
      rawRowsInserted: 2,
      rawRowsDuplicated: 0,
      normalizeJobsOffered: 1,
      normalizeJobsCreated: 1,
      normalizeJobsAlreadyPresent: 0,
      visibilityHeartbeats: 2,
      visibilityHeartbeatFailures: 0,
    });
  });

  it('renews visibility throughout slow append, enqueue, and delete stages', async () => {
    let renewals = 0;
    const stages: string[] = [];
    const base = unusedStore();
    const consumer = new MarketingStreamSqsConsumer({
      queueUrl: QUEUE_URL,
      queue: {
        receive: async () => [delivery(batchEnvelope())],
        delete: async () => { stages.push('delete'); await delay(18); },
        configuration: async () => ({
          visibilityTimeoutSeconds: 30,
          maxReceiveCount: 3,
          deadLetterQueueConfigured: true,
        }),
        extendVisibility: async () => { renewals += 1; },
        destroy: () => {},
      },
      store: {
        ...base,
        append: async ({ events }) => {
          stages.push('append');
          await delay(18);
          return {
            offeredMessages: events.length,
            insertedMessages: events.length,
            duplicateMessages: 0,
            revisedMessages: 0,
            affectedScopes: [{ adProduct: 'SP', utcHour: '2026-08-01T10:00:00.000Z' }],
          };
        },
      },
      contexts: { load: async () => policy() },
      scheduler: {
        enqueue: async () => { stages.push('enqueue'); await delay(18); return true; },
      },
      visibilityHeartbeatIntervalMs: 5,
      logger: silentLogger(),
    });

    await consumer.pollOnce();
    expect(stages).toEqual(['append', 'enqueue', 'delete']);
    expect(renewals).toBeGreaterThanOrEqual(4);
    expect(consumer.status()).toMatchObject({
      acknowledged: 1,
      failed: 0,
      visibilityHeartbeatFailures: 0,
    });
  });

  it('fails safely without enqueue or delete when visibility renewal fails', async () => {
    let renewals = 0;
    let scheduled = 0;
    let deleted = 0;
    const base = unusedStore();
    const consumer = new MarketingStreamSqsConsumer({
      queueUrl: QUEUE_URL,
      queue: {
        receive: async () => [delivery(batchEnvelope())],
        delete: async () => { deleted += 1; },
        configuration: async () => ({
          visibilityTimeoutSeconds: 30,
          maxReceiveCount: 3,
          deadLetterQueueConfigured: true,
        }),
        extendVisibility: async () => {
          renewals += 1;
          if (renewals > 1) throw new Error('synthetic heartbeat failure');
        },
        destroy: () => {},
      },
      store: {
        ...base,
        append: async ({ events }) => {
          await delay(18);
          return {
            offeredMessages: events.length,
            insertedMessages: events.length,
            duplicateMessages: 0,
            revisedMessages: 0,
            affectedScopes: [{ adProduct: 'SP', utcHour: '2026-08-01T10:00:00.000Z' }],
          };
        },
      },
      contexts: { load: async () => policy() },
      scheduler: { enqueue: async () => { scheduled += 1; return true; } },
      visibilityHeartbeatIntervalMs: 5,
      logger: silentLogger(),
    });

    await consumer.pollOnce();
    expect(scheduled).toBe(0);
    expect(deleted).toBe(0);
    expect(consumer.status()).toMatchObject({
      acknowledged: 0,
      failed: 1,
      visibilityHeartbeatFailures: 1,
      lastErrorKind: 'Error',
    });
  });

  it('keeps profile-group failures isolated within the same poll', async () => {
    const otherProfile = '79797979-7979-4979-8979-797979797979';
    const good = delivery(batchEnvelope([ledgerEvent({ messageId: 'isolated-good' })]));
    const badEnvelope = {
      ...batchEnvelope([ledgerEvent({ profileId: otherProfile, messageId: 'isolated-bad' })]),
      profileId: otherProfile,
    };
    const bad = {
      ...delivery(badEnvelope), messageId: 'sqs-bad', receiptHandle: 'receipt-bad',
    };
    const deleted: string[] = [];
    const base = unusedStore();
    const consumer = new MarketingStreamSqsConsumer({
      queueUrl: QUEUE_URL,
      queue: {
        receive: async () => [good, bad],
        delete: async (_url, receipt) => { deleted.push(receipt); },
        destroy: () => {},
      },
      store: {
        ...base,
        append: async (input) => {
          if (input.profileId === otherProfile) throw new Error('synthetic profile failure');
          return {
            offeredMessages: input.events.length,
            insertedMessages: input.events.length,
            duplicateMessages: 0,
            revisedMessages: 0,
            affectedScopes: [{ adProduct: 'SP', utcHour: '2026-08-01T10:00:00.000Z' }],
          };
        },
      },
      contexts: { load: async () => policy() },
      scheduler: { enqueue: async () => true },
      logger: silentLogger(),
    });

    await consumer.pollOnce();
    expect(deleted).toEqual(['receipt-one']);
    expect(consumer.status()).toMatchObject({ acknowledged: 1, failed: 1 });
  });

  it('is idempotent across a crash-after-commit redelivery', async () => {
    let appendPass = 0;
    let schedulePass = 0;
    let deletePass = 0;
    const message = delivery(batchEnvelope([ledgerEvent({ messageId: 'crash-safe' })]));
    const base = unusedStore();
    const consumer = new MarketingStreamSqsConsumer({
      queueUrl: QUEUE_URL,
      queue: {
        receive: async () => [message],
        delete: async () => {
          deletePass += 1;
          if (deletePass === 1) throw new Error('synthetic crash boundary');
        },
        destroy: () => {},
      },
      store: {
        ...base,
        append: async ({ events }) => {
          appendPass += 1;
          return {
            offeredMessages: events.length,
            insertedMessages: appendPass === 1 ? 1 : 0,
            duplicateMessages: appendPass === 1 ? 0 : 1,
            revisedMessages: 0,
            affectedScopes: [{ adProduct: 'SP', utcHour: '2026-08-01T10:00:00.000Z' }],
          };
        },
      },
      contexts: { load: async () => policy() },
      scheduler: {
        enqueue: async () => { schedulePass += 1; return schedulePass === 1; },
      },
      logger: silentLogger(),
    });

    await consumer.pollOnce();
    await consumer.pollOnce();
    expect(consumer.status()).toMatchObject({
      acknowledged: 1,
      failed: 1,
      rawRowsInserted: 1,
      rawRowsDuplicated: 1,
      normalizeJobsCreated: 1,
      normalizeJobsAlreadyPresent: 1,
    });
  });

  it('resolves and counts one provider-native record before acknowledgement', async () => {
    const steps: string[] = [];
    const message: MarketingStreamQueueMessage = {
      messageId: 'sqs-provider-one',
      receiptHandle: 'receipt-provider-one',
      body: JSON.stringify({ Type: 'Notification', Message: JSON.stringify(trafficRecord()) }),
      approximateReceiveCount: 1,
    };
    const consumer = new MarketingStreamSqsConsumer({
      queueUrl: QUEUE_URL,
      queue: queueClient([message], steps),
      store: unusedStore(),
      profiles: {
        resolve: async (identity) => {
          steps.push('profile');
          expect(identity).toEqual({
            advertiserId: 'provider-advertiser-one',
            marketplaceId: US_MARKETPLACE,
            datasetId: 'sp-traffic',
          });
          return binding();
        },
      },
      contexts: { load: async () => { steps.push('context'); return policy(); } },
      process: async (_store, input) => {
        steps.push('process');
        expect(input.events).toHaveLength(1);
        expect(input.events[0]).toMatchObject({
          profileId: PROFILE,
          messageId: providerMessageId(),
          dataset: 'traffic',
          adProduct: 'SP',
        });
        return result(1);
      },
      now: () => new Date('2026-08-01T17:05:00.000Z'),
      logger: silentLogger(),
    });

    expect(await consumer.pollOnce()).toBe(1);
    expect(steps).toEqual(['receive', 'profile', 'context', 'process', 'delete']);
    expect(consumer.status()).toMatchObject({ acknowledged: 1, failed: 0 });
  });

  it('deletes only after all SP, SB and SD dataset events are counted and normalized', async () => {
    const steps: string[] = [];
    const envelope = batchEnvelope(allDatasetEvents());
    const queue = queueClient([delivery(envelope)], steps);
    const consumer = new MarketingStreamSqsConsumer({
      queueUrl: QUEUE_URL,
      queue,
      store: unusedStore(),
      contexts: {
        load: async () => {
          steps.push('context');
          return {
            profileTimeZone: 'America/New_York',
            currencyCode: 'USD',
            settlingWindowHours: 12,
            budgetCappedAtPercent: 88,
          };
        },
      },
      process: async (_store, input) => {
        steps.push('process');
        expect(input.events).toHaveLength(9);
        expect(new Set(input.events.map((event) => (event as MarketingStreamLedgerEvent).adProduct)))
          .toEqual(new Set(['SP', 'SB', 'SD']));
        expect(new Set(input.events.map((event) => (event as MarketingStreamLedgerEvent).dataset)))
          .toEqual(new Set(['traffic', 'conversion', 'budget_usage']));
        expect(input.policy).toMatchObject({
          profileTimeZone: 'America/New_York',
          currencyCode: 'USD',
          settlingWindowHours: 12,
          budgetCappedAtPercent: 88,
        });
        return result(9, { normalizedRows: 3 });
      },
      logger: silentLogger(),
    });

    expect(await consumer.pollOnce()).toBe(1);
    expect(steps).toEqual(['receive', 'context', 'process', 'delete']);
    expect(consumer.status()).toMatchObject({
      received: 1,
      acknowledged: 1,
      failed: 0,
      inFlight: 0,
    });
    expect(JSON.stringify(consumer.status())).not.toContain(QUEUE_URL);
  });

  it('leaves refused, malformed, or delete-failed deliveries for SQS redrive', async () => {
    const deliveries = [delivery(batchEnvelope()), {
      messageId: 'bad-json', receiptHandle: 'receipt-bad', body: '{', approximateReceiveCount: 1,
    }];
    const deleted: string[] = [];
    const queue: MarketingStreamQueueClient = {
      receive: async () => deliveries,
      delete: async (_url, receipt) => { deleted.push(receipt); throw new Error('synthetic delete outage'); },
      destroy: () => {},
    };
    const consumer = new MarketingStreamSqsConsumer({
      queueUrl: QUEUE_URL,
      queue,
      store: unusedStore(),
      contexts: { load: async () => policy() },
      process: async () => result(1, { refusedMessages: 1, normalizedRows: 0 }),
      logger: silentLogger(),
    });

    expect(await consumer.pollOnce()).toBe(2);
    // The refused delivery never reaches DeleteMessage. The malformed one
    // fails before policy/process, so neither can be acknowledged.
    expect(deleted).toEqual([]);
    expect(consumer.status()).toMatchObject({ received: 2, acknowledged: 0, failed: 2 });

    const deleteFailure = new MarketingStreamSqsConsumer({
      queueUrl: QUEUE_URL,
      queue: {
        receive: async () => [delivery(batchEnvelope())],
        delete: async (_url, receipt) => { deleted.push(receipt); throw new Error('synthetic delete outage'); },
        destroy: () => {},
      },
      store: unusedStore(),
      contexts: { load: async () => policy() },
      process: async () => result(1),
      logger: silentLogger(),
    });
    await deleteFailure.pollOnce();
    expect(deleted).toEqual(['receipt-one']);
    expect(deleteFailure.status()).toMatchObject({ acknowledged: 0, failed: 1 });
  });

  it('treats redelivery as safe when the counted processor reports a duplicate', async () => {
    let pass = 0;
    const queue = queueClient([delivery(batchEnvelope())]);
    const consumer = new MarketingStreamSqsConsumer({
      queueUrl: QUEUE_URL,
      queue,
      store: unusedStore(),
      contexts: { load: async () => policy() },
      process: async () => {
        pass += 1;
        return result(1, pass === 1 ? { duplicateMessages: 1 } : undefined);
      },
      logger: silentLogger(),
    });

    await consumer.pollOnce();
    expect(consumer.status().acknowledged).toBe(1);
  });

  it('retains valid raw evidence before deferring projection for missing policy', async () => {
    const appended: MarketingStreamLedgerEvent[][] = [];
    const deleted: string[] = [];
    const base = unusedStore();
    const store: MarketingStreamStore = {
      ...base,
      append: async (input) => {
        appended.push([...input.events]);
        return {
          offeredMessages: input.events.length,
          insertedMessages: input.events.length,
          duplicateMessages: 0,
          revisedMessages: 0,
          affectedScopes: [{ adProduct: 'SP', utcHour: '2026-08-01T10:00:00.000Z' }],
        };
      },
    };
    const consumer = new MarketingStreamSqsConsumer({
      queueUrl: QUEUE_URL,
      queue: {
        receive: async () => [delivery(batchEnvelope())],
        delete: async (_url, receipt) => { deleted.push(receipt); },
        destroy: () => {},
      },
      store,
      contexts: {
        load: async () => { throw new MarketingStreamConfigurationError('tenant policy absent'); },
      },
      logger: silentLogger(),
    });

    await consumer.pollOnce();

    expect(appended).toHaveLength(1);
    expect(appended[0]).toHaveLength(1);
    expect(deleted).toEqual([]);
    expect(consumer.status()).toMatchObject({ received: 1, acknowledged: 0, failed: 1 });
  });

  it('aborts a pending long poll and destroys the AWS boundary on stop', async () => {
    let destroyed = false;
    const queue: MarketingStreamQueueClient = {
      receive: async (_url, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }),
      delete: async () => {},
      destroy: () => { destroyed = true; },
    };
    const consumer = new MarketingStreamSqsConsumer({
      queueUrl: QUEUE_URL,
      queue,
      store: unusedStore(),
      contexts: { load: async () => policy() },
      logger: silentLogger(),
    });
    consumer.start();
    await consumer.stop();
    expect(destroyed).toBe(true);
    expect(consumer.status()).toMatchObject({ running: false, stopping: true, inFlight: 0 });
  });

  it('backs off a retryable provider receive failure without exposing queue details', async () => {
    let receives = 0;
    let secondReceiveStarted: (() => void) | undefined;
    const secondReceive = new Promise<void>((resolve) => { secondReceiveStarted = resolve; });
    const delays: number[] = [];
    const errors: Record<string, unknown>[] = [];
    const queue: MarketingStreamQueueClient = {
      receive: async (_url, signal) => {
        receives += 1;
        if (receives === 1) throw new Error('synthetic provider outage with private queue detail');
        secondReceiveStarted?.();
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      },
      delete: async () => {},
      destroy: () => {},
    };
    const consumer = new MarketingStreamSqsConsumer({
      queueUrl: QUEUE_URL,
      queue,
      store: unusedStore(),
      contexts: { load: async () => policy() },
      sleep: async (milliseconds) => { delays.push(milliseconds); },
      logger: { info: () => {}, error: (_message, details) => { errors.push(details ?? {}); } },
    });
    consumer.start();
    await secondReceive;
    await consumer.stop();

    expect(delays).toEqual([1_000]);
    expect(consumer.status()).toMatchObject({ providerFailures: 1, lastErrorKind: 'Error' });
    expect(JSON.stringify(errors)).not.toMatch(/private queue detail|sqs\.example/i);
  });

  it('fails closed on a queue without a DLQ and counts poison redrive eligibility', async () => {
    const badConfiguration = new MarketingStreamSqsConsumer({
      queueUrl: QUEUE_URL,
      queue: {
        receive: async () => [],
        delete: async () => {},
        configuration: async () => ({
          visibilityTimeoutSeconds: 60,
          maxReceiveCount: 3,
          deadLetterQueueConfigured: false,
        }),
        destroy: () => {},
      },
      store: unusedStore(),
      contexts: { load: async () => policy() },
      logger: silentLogger(),
    });
    await expect(badConfiguration.pollOnce()).rejects.toThrow(/dead-letter queue/);

    const poison = new MarketingStreamSqsConsumer({
      queueUrl: QUEUE_URL,
      queue: {
        receive: async () => [{
          messageId: 'poison', receiptHandle: 'poison-receipt', body: '{', approximateReceiveCount: 3,
        }],
        delete: async () => {},
        configuration: async () => ({
          visibilityTimeoutSeconds: 60,
          maxReceiveCount: 3,
          deadLetterQueueConfigured: true,
        }),
        extendVisibility: async () => {},
        destroy: () => {},
      },
      store: unusedStore(),
      contexts: { load: async () => policy() },
      logger: silentLogger(),
    });
    await poison.pollOnce();
    expect(poison.status()).toMatchObject({ failed: 1, redriveEligible: 1, acknowledged: 0 });
  });

  it('contains no Amazon Ads write client or mutation call in the Stream runtime', () => {
    const sources = ['marketing-stream-sqs.ts', 'marketing-stream-normalize.ts', 'dayparting.ts']
      .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
      .join('\n');
    expect(sources).not.toMatch(/from ['"]@wizard-ads\/ads-api/);
    expect(sources).not.toMatch(/\.(createCampaigns|updateCampaigns|updateTargets|updatePlacements)\s*\(/);
  });
});

function batchEnvelope(events: MarketingStreamLedgerEvent[] = [ledgerEvent()]): MarketingStreamBatchEnvelope {
  return {
    schema: 'wizard-ads.marketing-stream-batch.v1',
    orgId: ORG,
    profileId: PROFILE,
    events,
  };
}

function allDatasetEvents(): MarketingStreamLedgerEvent[] {
  const events: MarketingStreamLedgerEvent[] = [];
  for (const adProduct of ['SP', 'SB', 'SD'] as const) {
    for (const dataset of ['traffic', 'conversion', 'budget_usage'] as const) {
      events.push(ledgerEvent({
        messageId: `${adProduct.toLowerCase()}-${dataset}`,
        adProduct,
        dataset,
        rawPayload: { metrics: [{ campaignId: `campaign-${adProduct.toLowerCase()}` }] },
      }));
    }
  }
  return events;
}

function ledgerEvent(overrides: Partial<MarketingStreamLedgerEvent> = {}): MarketingStreamLedgerEvent {
  return {
    profileId: PROFILE,
    messageId: 'message-one',
    dataset: 'traffic',
    adProduct: 'SP',
    eventTime: '2026-08-01T10:00:00.000Z',
    receivedAt: '2026-08-01T10:05:00.000Z',
    revision: 0,
    payloadHash: 'synthetic-hash',
    rawPayload: { metrics: [{ campaignId: 'campaign-one' }] },
    ...overrides,
  };
}

function trafficRecord(): Record<string, unknown> {
  return {
    idempotency_id: 'provider-event-one',
    dataset_id: 'sp-traffic',
    marketplace_id: US_MARKETPLACE,
    currency: 'USD',
    advertiser_id: 'provider-advertiser-one',
    campaign_id: 'campaign-one',
    ad_group_id: 'ad-group-one',
    ad_id: 'ad-one',
    keyword_id: 'keyword-one',
    keyword_text: 'synthetic query',
    match_type: 'EXACT',
    placement: 'Top of Search on-Amazon',
    time_window_start: '2026-08-01T10:00:00-07:00',
    clicks: 3,
    impressions: 12,
    cost: 4.25,
  };
}

function conversionRecord(product: 'sp' | 'sb' | 'sd'): Record<string, unknown> {
  return {
    idempotency_id: `${product}-conversion-one`,
    dataset_id: `${product}-conversion`,
    marketplace_id: US_MARKETPLACE,
    currency: 'USD',
    advertiser_id: 'provider-advertiser-one',
    campaign_id: 'campaign-one',
    ad_group_id: 'ad-group-one',
    ad_id: 'ad-one',
    time_window_start: '2026-08-01T10:00:00-07:00',
    attributed_conversions_14d: 2,
    attributed_sales_14d: 18.75,
    view_attributed_conversions_14d: 5,
    view_attributed_sales_14d: 47.5,
  };
}

function budgetRecord(): Record<string, unknown> {
  return {
    dataset_id: 'budget-usage',
    marketplace_id: US_MARKETPLACE,
    advertiser_id: 'provider-advertiser-one',
    budget_scope_id: 'campaign-one',
    budget_scope_type: 'CAMPAIGN',
    advertising_product_type: 'sb',
    budget: 100,
    budget_usage_percentage: 85,
    usage_updated_timestamp: '2026-08-01T10:21:00-07:00',
  };
}

function delivery(envelope: MarketingStreamBatchEnvelope): MarketingStreamQueueMessage {
  return {
    messageId: 'sqs-message-one',
    receiptHandle: 'receipt-one',
    body: JSON.stringify(envelope),
    approximateReceiveCount: 1,
  };
}

function queueClient(messages: MarketingStreamQueueMessage[], steps: string[] = []): MarketingStreamQueueClient {
  return {
    receive: async () => { steps.push('receive'); return messages; },
    delete: async () => { steps.push('delete'); },
    destroy: () => {},
  };
}

function unusedStore(): MarketingStreamStore {
  const unused = async (): Promise<never> => { throw new Error('unused store method'); };
  return { append: unused, snapshot: unused, replace: unused, persistProposal: unused };
}

function policy() {
  return {
    profileTimeZone: 'UTC',
    currencyCode: 'USD',
    settlingWindowHours: 4,
    budgetCappedAtPercent: 90,
  };
}

function result(
  receivedMessages: number,
  overrides: Partial<{
    duplicateMessages: number;
    refusedMessages: number;
    normalizedRows: number;
  }> = {},
) {
  const duplicateMessages = overrides.duplicateMessages ?? 0;
  const refusedMessages = overrides.refusedMessages ?? 0;
  const normalizedRows = overrides.normalizedRows ?? 1;
  return {
    counts: {
      receivedMessages,
      duplicateMessages,
      revisedMessages: 0,
      refusedMessages,
      normalizedRows,
    },
    append: {
      offeredMessages: receivedMessages,
      insertedMessages: receivedMessages - duplicateMessages,
      duplicateMessages,
      revisedMessages: 0,
      affectedScopes: [],
    },
    projection: {
      scopesReplaced: normalizedRows === 0 ? 0 : 1,
      factsDeleted: 0,
      factsInserted: normalizedRows,
      factsReadBack: normalizedRows,
    },
    refusals: refusedMessages === 0 ? [] : [{ index: 0, messageId: 'message-one', scope: null, reason: 'synthetic' }],
  };
}

function silentLogger() {
  return { info: () => {}, error: () => {} };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
