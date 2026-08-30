import { describe, expect, it } from 'vitest';
import type {
  MarketingStreamBatchEnvelope,
  MarketingStreamLedgerEvent,
} from '@wizard-ads/shared';
import type { MarketingStreamStore } from './dayparting.js';
import {
  MarketingStreamConfigurationError,
  MarketingStreamSqsConsumer,
  marketingStreamProviderEnvelope,
  parseMarketingStreamProviderRecord,
  parseMarketingStreamSqsBody,
  resolveMarketingStreamProfileScope,
  type MarketingStreamQueueClient,
  type MarketingStreamQueueMessage,
} from './marketing-stream-sqs.js';

const ORG = '74747474-7474-4474-8474-747474747474';
const PROFILE = '75757575-7575-4575-8575-757575757575';
const QUEUE_URL = 'https://sqs.example.invalid/synthetic';
const US_MARKETPLACE = 'ATVPDKIKX0DER';

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
      { orgId: ORG, profileId: PROFILE },
      new Date('2026-08-01T17:05:00.000Z'),
    );
    expect(envelope.events).toHaveLength(1);
    expect(envelope.events[0]).toMatchObject({
      profileId: PROFILE,
      messageId: 'provider-event-one',
      dataset: 'traffic',
      adProduct: 'SP',
      eventTime: '2026-08-01T17:00:00.000Z',
      revision: 0,
      rawPayload: {
        providerRecord: provider,
        currencyCode: 'USD',
        metrics: [{ campaignId: 'campaign-one', impressions: 12, clicks: 3, cost: 4.25 }],
      },
    });
    expect(envelope.events[0]?.payloadHash).toMatch(/^[a-f0-9]{64}$/);
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
    expect(parseMarketingStreamProviderRecord(budgetRecord())).toMatchObject({
      dataset: 'budget_usage',
      adProduct: 'SB',
      eventTime: '2026-08-01T17:21:00.000Z',
      normalizedMetric: { campaignId: 'campaign-one', budgetUsagePercent: 85 },
    });
    expect(() => parseMarketingStreamProviderRecord({
      ...budgetRecord(), budget_scope_type: 'PORTFOLIO',
    })).toThrow(/not campaign scoped/);
    expect(() => parseMarketingStreamProviderRecord({
      ...trafficRecord(), dataset_id: 'sb-rich-media',
    })).toThrow(/not supported/);
  });

  it('resolves provider identity by advertiser and marketplace without guessing an org', () => {
    expect(resolveMarketingStreamProfileScope([
      { orgId: ORG, profileId: PROFILE, countryCode: 'US' },
      { orgId: '76767676-7676-4676-8676-767676767676', profileId: '77777777-7777-4777-8777-777777777777', countryCode: 'DE' },
    ], US_MARKETPLACE)).toEqual({ orgId: ORG, profileId: PROFILE });
    expect(() => resolveMarketingStreamProfileScope([], US_MARKETPLACE)).toThrow(/not bound/);
    expect(() => resolveMarketingStreamProfileScope([
      { orgId: ORG, profileId: PROFILE, countryCode: 'US' },
      { orgId: '76767676-7676-4676-8676-767676767676', profileId: '77777777-7777-4777-8777-777777777777', countryCode: 'US' },
    ], US_MARKETPLACE)).toThrow(/more than one/);
  });
});

describe('Marketing Stream SQS acknowledgement', () => {
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
          });
          return { orgId: ORG, profileId: PROFILE };
        },
      },
      contexts: { load: async () => { steps.push('context'); return policy(); } },
      process: async (_store, input) => {
        steps.push('process');
        expect(input.events).toHaveLength(1);
        expect(input.events[0]).toMatchObject({
          profileId: PROFILE,
          messageId: 'provider-event-one',
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
    idempotency_id: 'budget-event-one',
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
