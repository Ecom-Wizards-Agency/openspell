import { describe, expect, it } from 'vitest';
import type { DbHandle, MarketingStreamSnapshot } from '@wizard-ads/db';
import type { MarketingStreamNormalizeJob } from '@wizard-ads/shared';
import type { MarketingStreamStore } from './dayparting.js';
import { createMarketingStreamNormalizeHandler } from './marketing-stream-normalize.js';
import { MarketingStreamConfigurationError } from './marketing-stream-sqs.js';

const ORG = '81818181-8181-4181-8181-818181818181';
const PROFILE = '82828282-8282-4282-8282-828282828282';
const HOUR = '2026-08-01T10:00:00.000Z';

describe('Marketing Stream queued normalization', () => {
  it('replays a complete scope, reconciles counts, and schedules its aging transition', async () => {
    const replacements: string[][] = [];
    const scheduled: Date[] = [];
    const handler = createMarketingStreamNormalizeHandler({
      handle: {} as DbHandle,
      queue: {
        enqueue: async (_payload, runAt) => { scheduled.push(runAt); return true; },
      },
      now: () => new Date('2026-08-01T10:30:00.000Z'),
      contexts: { load: async () => ({
        profileTimeZone: 'UTC', currencyCode: 'USD',
        settlingWindowHours: 1, budgetCappedAtPercent: 90,
      }) },
      resolveScopes: async () => ({
        requestedMessages: 1,
        foundMessages: 1,
        scopes: [{ adProduct: 'SP', utcHour: HOUR }],
      }),
      store: store(snapshot(), replacements),
    });

    await expect(handler(job())).resolves.toMatchObject({
      requestedMessages: 1,
      foundMessages: 1,
      requestedScopes: 1,
      sourceRows: 1,
      refusedRows: 0,
      replacedScopes: 1,
      insertedFacts: 1,
      readBackFacts: 1,
      transitionScheduled: true,
      transitionCreated: true,
    });
    expect(replacements).toEqual([['settling']]);
    expect(scheduled.map((value) => value.toISOString())).toEqual(['2026-08-01T12:00:00.000Z']);
  });

  it('fails without replacing canonical facts when a signed correction is incomplete', async () => {
    const replacements: string[][] = [];
    const bad = snapshot();
    bad.events[0]!.rawPayload = {
      currencyCode: 'USD',
      metrics: [{ campaignId: 'campaign-one', impressions: -2, clicks: -1, cost: -1 }],
    };
    bad.events[0]!.provider = {
      bindingId: '83838383-8383-4383-8383-838383838383',
      subscriptionId: 'subscription-one',
      datasetId: 'sp-traffic',
      advertiserId: 'advertiser-one',
      marketplaceId: 'marketplace-one',
      eventId: 'event-one',
    };
    const handler = createMarketingStreamNormalizeHandler({
      handle: {} as DbHandle,
      queue: { enqueue: async () => true },
      now: () => new Date('2026-08-10T00:00:00.000Z'),
      contexts: { load: async () => ({
        profileTimeZone: 'UTC', currencyCode: 'USD',
        settlingWindowHours: 1, budgetCappedAtPercent: 90,
      }) },
      resolveScopes: async () => ({
        requestedMessages: 1,
        foundMessages: 1,
        scopes: [{ adProduct: 'SP', utcHour: HOUR }],
      }),
      store: store(bad, replacements),
    });

    await expect(handler(job())).rejects.toThrow(/replay refused/);
    expect(replacements).toEqual([]);
  });

  it('retains a durable retry when tenant policy is not configured yet', async () => {
    const scheduled: Date[] = [];
    const handler = createMarketingStreamNormalizeHandler({
      handle: {} as DbHandle,
      queue: {
        enqueue: async (_payload, runAt) => { scheduled.push(runAt); return true; },
      },
      now: () => new Date('2026-08-01T10:30:00.000Z'),
      contexts: {
        load: async () => { throw new MarketingStreamConfigurationError('policy absent'); },
      },
      resolveScopes: async () => ({
        requestedMessages: 1,
        foundMessages: 1,
        scopes: [{ adProduct: 'SP', utcHour: HOUR }],
      }),
      store: store(snapshot(), []),
    });

    await expect(handler(job())).resolves.toMatchObject({
      projectionDeferred: true,
      retryCreated: true,
    });
    expect(scheduled.map((value) => value.toISOString())).toEqual(['2026-08-01T11:30:00.000Z']);
  });
});

function job(): MarketingStreamNormalizeJob {
  return {
    type: 'marketing_stream.normalize',
    orgId: ORG,
    profileId: PROFILE,
    messageIds: ['message-one'],
  };
}
function snapshot(): MarketingStreamSnapshot {
  const eventId = '84848484-8484-4484-8484-848484848484';
  return {
    orgId: ORG,
    profileId: PROFILE,
    scopes: [{ adProduct: 'SP', utcHour: HOUR }],
    events: [{
      id: eventId,
      orgId: ORG,
      profileId: PROFILE,
      messageId: 'message-one',
      dataset: 'traffic',
      adProduct: 'SP',
      eventTime: HOUR,
      receivedAt: '2026-08-01T10:05:00.000Z',
      revision: 0,
      payloadHash: 'hash-one',
      rawPayload: {
        currencyCode: 'USD',
        metrics: [{ campaignId: 'campaign-one', impressions: 10, clicks: 1, cost: 1 }],
      },
    }],
    sourceEventIds: { [`SP|${HOUR}`]: [eventId] },
  };
}

function store(
  source: MarketingStreamSnapshot,
  replacements: string[][],
): MarketingStreamStore {
  return {
    append: async () => { throw new Error('normalize handler must not append'); },
    snapshot: async () => source,
    replace: async ({ scopes, facts }) => {
      replacements.push(facts.map((fact) => fact.settlingState));
      return {
        scopesReplaced: scopes.length,
        factsDeleted: 0,
        factsInserted: facts.length,
        factsReadBack: facts.length,
      };
    },
    persistProposal: async ({ proposal }) => ({ status: 'inserted', proposal }),
  };
}
