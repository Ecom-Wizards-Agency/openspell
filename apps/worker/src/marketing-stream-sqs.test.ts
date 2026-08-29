import { describe, expect, it } from 'vitest';
import type {
  MarketingStreamBatchEnvelope,
  MarketingStreamLedgerEvent,
} from '@wizard-ads/shared';
import type { MarketingStreamStore } from './dayparting.js';
import {
  MarketingStreamSqsConsumer,
  parseMarketingStreamSqsBody,
  type MarketingStreamQueueClient,
  type MarketingStreamQueueMessage,
} from './marketing-stream-sqs.js';

const ORG = '74747474-7474-4474-8474-747474747474';
const PROFILE = '75757575-7575-4575-8575-757575757575';
const QUEUE_URL = 'https://sqs.example.invalid/synthetic';

describe('Marketing Stream SQS envelope', () => {
  it('accepts raw delivery and the standard SNS notification wrapper', () => {
    const envelope = batchEnvelope();
    expect(parseMarketingStreamSqsBody(JSON.stringify(envelope))).toEqual(envelope);
    expect(parseMarketingStreamSqsBody(JSON.stringify({
      Type: 'Notification',
      Message: JSON.stringify(envelope),
    }))).toEqual(envelope);
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
});

describe('Marketing Stream SQS acknowledgement', () => {
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
