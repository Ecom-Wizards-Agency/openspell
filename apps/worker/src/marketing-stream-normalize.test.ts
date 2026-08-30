import { describe, expect, it } from 'vitest';
import type {
  DbHandle,
  MarketingStreamProjectionBlock,
  MarketingStreamScope,
  MarketingStreamSnapshot,
} from '@wizard-ads/db';
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
      blocks: projectionBlocks(),
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
      blocks: projectionBlocks(),
      store: store(bad, replacements),
    });

    await expect(handler(job())).rejects.toThrow(/replay refused/);
    expect(replacements).toEqual([]);
  });

  it('retains a durable retry when tenant policy is not configured yet', async () => {
    const scheduled: { payload: MarketingStreamNormalizeJob; runAt: Date; key: string }[] = [];
    const handler = createMarketingStreamNormalizeHandler({
      handle: {} as DbHandle,
      queue: {
        enqueue: async (payload, runAt, key) => { scheduled.push({ payload, runAt, key }); return true; },
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
      blocks: projectionBlocks(),
      store: store(snapshot(), []),
    });

    await expect(handler(job())).resolves.toMatchObject({
      projectionDeferred: true,
      retryCreated: true,
      configurationRetryAttempt: 0,
      configurationRetryLimit: 24,
      alertRequired: false,
    });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.runAt.toISOString()).toBe('2026-08-01T11:30:00.000Z');
    expect(scheduled[0]?.payload.configurationRetryAttempt).toBe(1);
    expect(scheduled[0]?.key).toBe([
      'marketing-stream', 'configuration', ORG, PROFILE, '2026-08-01T11',
    ].join(':'));
  });

  it('consolidates missing-policy retries by profile/hour while accumulating scopes', async () => {
    const retained = projectionBlocks();
    const keys = new Set<string>();
    const offered: string[] = [];
    const handler = createMarketingStreamNormalizeHandler({
      handle: {} as DbHandle,
      queue: {
        enqueue: async (_payload, _runAt, key) => {
          offered.push(key);
          const created = !keys.has(key);
          keys.add(key);
          return created;
        },
      },
      now: () => new Date('2026-08-01T10:30:00.000Z'),
      contexts: { load: async () => { throw new MarketingStreamConfigurationError('policy absent'); } },
      resolveScopes: async (_handle, payload) => ({
        requestedMessages: 1,
        foundMessages: 1,
        scopes: [{
          adProduct: payload.messageIds[0] === 'message-one' ? 'SP' : 'SB',
          utcHour: payload.messageIds[0] === 'message-one'
            ? HOUR
            : '2026-08-01T11:00:00.000Z',
        }],
      }),
      blocks: retained,
      store: store(snapshot(), []),
    });

    await expect(handler(job())).resolves.toMatchObject({ retryCreated: true, blockedScopes: 1 });
    await expect(handler({ ...job(), messageIds: ['message-two'] })).resolves.toMatchObject({
      retryCreated: false,
      blockedScopes: 2,
    });
    expect(offered).toHaveLength(2);
    expect(new Set(offered)).toHaveLength(1);
    await expect(retained.read(job())).resolves.toMatchObject({
      scopes: [
        { adProduct: 'SB', utcHour: '2026-08-01T11:00:00.000Z' },
        { adProduct: 'SP', utcHour: HOUR },
      ],
    });
  });

  it('caps retries in an alerted durable block', async () => {
    let enqueued = 0;
    const handler = createMarketingStreamNormalizeHandler({
      handle: {} as DbHandle,
      queue: { enqueue: async () => { enqueued += 1; return true; } },
      now: () => new Date('2026-08-02T10:30:00.000Z'),
      contexts: { load: async () => { throw new MarketingStreamConfigurationError('policy absent'); } },
      resolveScopes: async () => ({
        requestedMessages: 1,
        foundMessages: 1,
        scopes: [{ adProduct: 'SP', utcHour: HOUR }],
      }),
      blocks: projectionBlocks(),
      store: store(snapshot(), []),
    });

    await expect(handler({ ...job(), configurationRetryAttempt: 24 })).resolves.toMatchObject({
      projectionDeferred: true,
      retryCreated: false,
      configurationRetryAttempt: 24,
      alertRequired: true,
    });
    expect(enqueued).toBe(0);
  });

  it('replays accumulated blocked scopes with a later event and clears the durable block', async () => {
    const blockedScope = { adProduct: 'SB' as const, utcHour: '2026-08-01T11:00:00.000Z' };
    const source = snapshot();
    source.scopes = [{ adProduct: 'SP', utcHour: HOUR }, blockedScope];
    source.events.push({
      ...source.events[0]!,
      id: '85858585-8585-4585-8585-858585858585',
      messageId: 'blocked-message',
      adProduct: 'SB',
      eventTime: blockedScope.utcHour,
      receivedAt: '2026-08-01T11:05:00.000Z',
    });
    source.sourceEventIds[`SB|${blockedScope.utcHour}`] = [source.events[1]!.id];
    const retained = projectionBlocks({ scopes: [blockedScope] });
    const replacements: string[][] = [];
    const scheduledPayloads: MarketingStreamNormalizeJob[] = [];
    const handler = createMarketingStreamNormalizeHandler({
      handle: {} as DbHandle,
      queue: {
        enqueue: async (payload) => { scheduledPayloads.push(payload); return true; },
      },
      now: () => new Date('2026-08-01T11:30:00.000Z'),
      contexts: { load: async () => ({
        profileTimeZone: 'UTC', currencyCode: 'USD',
        settlingWindowHours: 1, budgetCappedAtPercent: 90,
      }) },
      resolveScopes: async () => ({
        requestedMessages: 1,
        foundMessages: 1,
        scopes: [{ adProduct: 'SP', utcHour: HOUR }],
      }),
      blocks: retained,
      store: store(source, replacements),
    });

    await expect(handler(job())).resolves.toMatchObject({
      requestedScopes: 2,
      recoveredBlockedScopes: 1,
      blockedProjectionCleared: true,
      replacedScopes: 2,
    });
    await expect(retained.read(job())).resolves.toBeNull();
    expect(scheduledPayloads[0]?.messageIds).toEqual(['blocked-message', 'message-one']);
    expect(replacements[0]).toHaveLength(2);
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

function projectionBlocks(seed?: { scopes: MarketingStreamScope[] }) {
  let block: MarketingStreamProjectionBlock | null = seed ? {
    orgId: ORG,
    profileId: PROFILE,
    scopes: [...seed.scopes],
    firstBlockedAt: '2026-08-01T09:00:00.000Z',
    lastBlockedAt: '2026-08-01T09:00:00.000Z',
    retryCount: 0,
    alertState: 'pending',
    lastReason: 'policy absent',
    generation: 1,
  } : null;
  return {
    mark: async (input: {
      orgId: string;
      profileId: string;
      scopes: readonly MarketingStreamScope[];
      blockedAt: Date;
      retryAttempt: number;
      retryLimit: number;
      reason: string;
    }) => {
      const scopes = new Map((block?.scopes ?? []).map((scope) => [
        `${scope.adProduct}|${scope.utcHour}`,
        scope,
      ]));
      for (const scope of input.scopes) scopes.set(`${scope.adProduct}|${scope.utcHour}`, scope);
      block = {
        orgId: input.orgId,
        profileId: input.profileId,
        scopes: [...scopes.values()].sort((left, right) =>
          `${left.adProduct}|${left.utcHour}`.localeCompare(`${right.adProduct}|${right.utcHour}`)),
        firstBlockedAt: block?.firstBlockedAt ?? input.blockedAt.toISOString(),
        lastBlockedAt: input.blockedAt.toISOString(),
        retryCount: Math.max(block?.retryCount ?? 0, input.retryAttempt),
        alertState: Math.max(block?.retryCount ?? 0, input.retryAttempt) >= input.retryLimit
          ? 'alerted'
          : block?.alertState ?? 'pending',
        lastReason: input.reason,
        generation: (block?.generation ?? 0) + 1,
      };
      return block;
    },
    read: async (_input: { orgId: string; profileId: string }) => block,
    clear: async (input: { orgId: string; profileId: string; expectedGeneration: number }) => {
      const existed = block?.generation === input.expectedGeneration;
      if (!existed) return false;
      block = null;
      return existed;
    },
  };
}
