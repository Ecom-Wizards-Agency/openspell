import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as adsApiRoot from '@wizard-ads/ads-api';
import { createSpWriteAdapter } from '@wizard-ads/ads-api/sp-write-adapter';
import {
  SpWriteAction,
  SpWritePlan,
  SpWriteProviderCallIntent,
  serializeSpWriteActionFingerprint,
  serializeSpWritePlanFingerprint,
  serializeSpWriteProviderCallIntentFingerprint,
  serializeSpWriteProviderRequestFingerprint,
  serializeSpWriteProviderResultFingerprint,
  type SpWritePlan as SpWritePlanType,
  type SpWriteProviderCallIntent as SpWriteProviderCallIntentType,
  type SpWriteSha256Hasher,
} from '@wizard-ads/shared/sp-writes';
import type { FetchLike } from './types.js';

const ZERO_SHA256 = '0'.repeat(64);
const ACTION_ID = '00000000-0000-4000-8000-000000000001';
const PLAN_ID = '00000000-0000-4000-8000-000000000002';
const ORG_ID = '00000000-0000-4000-8000-000000000003';
const PROFILE_ID = '00000000-0000-4000-8000-000000000004';
const CONNECTION_ID = '00000000-0000-4000-8000-000000000005';
const APPLY_BATCH_ID = '00000000-0000-4000-8000-000000000006';
const APPLY_ROW_ID = '00000000-0000-4000-8000-000000000007';
const INTENT_ID = '00000000-0000-4000-8000-000000000008';
const PROVIDER_CALL_ID = '00000000-0000-4000-8000-000000000009';
const APPROVAL_ID = '00000000-0000-4000-8000-000000000010';
const EXECUTION_ID = '00000000-0000-4000-8000-000000000011';
const GENERATION = '00000000-0000-4000-8000-000000000012';
const LEASE_ID = '00000000-0000-4000-8000-000000000013';
const RESULT_ID = '00000000-0000-4000-8000-000000000014';
const KEYWORD_ID = 'keyword-synthetic-one';

const sha256: SpWriteSha256Hasher = {
  algorithm: 'sha256',
  digest(preimage) {
    return createHash('sha256').update(preimage).digest('hex');
  },
};

function keywordPlan(): SpWritePlanType {
  const unsignedAction = SpWriteAction.parse({
    routeKey: 'sp.v3.keywords.update',
    actionId: ACTION_ID,
    entity: { keywordId: KEYWORD_ID },
    sources: [{ kind: 'apply_row', applyRowId: APPLY_ROW_ID, changeKey: 'keyword.bid' }],
    changes: {
      bid: {
        expected: { amount: '1', currencyCode: 'USD' },
        requested: { amount: '1.1', currencyCode: 'USD' },
      },
    },
    fingerprint: ZERO_SHA256,
  });
  const action = SpWriteAction.parse({
    ...unsignedAction,
    fingerprint: sha256.digest(serializeSpWriteActionFingerprint(unsignedAction)),
  });
  const unsignedPlan = SpWritePlan.parse({
    schemaVersion: 'openspell.sp-write-plan.v1',
    id: PLAN_ID,
    orgId: ORG_ID,
    profileId: PROFILE_ID,
    providerScope: {
      amazonProfileId: 'profile-synthetic-one',
      connectionId: CONNECTION_ID,
      region: 'NA',
      marketplaceId: 'ATVPDKIKX0DER',
      currencyCode: 'USD',
      apiDialect: 'sp_v3',
    },
    direction: 'forward',
    source: {
      kind: 'apply_batch',
      applyBatchId: APPLY_BATCH_ID,
      guardrailSnapshotFingerprint: '1'.repeat(64),
      provenanceSnapshotFingerprint: '2'.repeat(64),
    },
    generatedAt: '2026-08-31T12:00:00.000Z',
    frozenAt: '2026-08-31T12:00:01.000Z',
    expiresAt: '2026-08-31T13:00:00.000Z',
    actions: [action],
    counts: {
      logicalChanges: 1,
      providerRows: 1,
      uniqueEntities: 1,
      byRoute: {
        'sp.v3.campaigns.update': 0,
        'sp.v3.ad_groups.update': 0,
        'sp.v3.keywords.update': 1,
        'sp.v3.targets.update': 0,
        'sp.v3.product_ads.update': 0,
      },
    },
    fingerprint: ZERO_SHA256,
  });
  return SpWritePlan.parse({
    ...unsignedPlan,
    fingerprint: sha256.digest(serializeSpWritePlanFingerprint(unsignedPlan)),
  });
}

function intentFor(
  plan: SpWritePlanType,
  positions: SpWriteProviderCallIntentType['positions'],
): SpWriteProviderCallIntentType {
  const unsigned = SpWriteProviderCallIntent.parse({
    schemaVersion: 'openspell.sp-write-provider-call-intent.v1',
    intentId: INTENT_ID,
    providerCallId: PROVIDER_CALL_ID,
    planId: plan.id,
    planFingerprint: plan.fingerprint,
    approvalId: APPROVAL_ID,
    executionId: EXECUTION_ID,
    generation: GENERATION,
    routeKey: 'sp.v3.keywords.update',
    attemptNumber: 1,
    dispatchLeaseId: LEASE_ID,
    providerObservationFingerprint: '3'.repeat(64),
    requestFingerprint: ZERO_SHA256,
    recordedAt: '2026-08-31T12:00:02.000Z',
    positions,
    fingerprint: ZERO_SHA256,
  });
  const withRequest = SpWriteProviderCallIntent.parse({
    ...unsigned,
    requestFingerprint: sha256.digest(serializeSpWriteProviderRequestFingerprint(unsigned)),
  });
  return SpWriteProviderCallIntent.parse({
    ...withRequest,
    fingerprint: sha256.digest(serializeSpWriteProviderCallIntentFingerprint(withRequest)),
  });
}

type ProviderReply = Readonly<{ status: number; body: unknown }>;

function fakeFetch(replies: readonly ProviderReply[]): {
  fetch: FetchLike;
  mutationRequests: RequestInit[];
  listRequests: RequestInit[];
  requestedUrls: string[];
} {
  const mutationRequests: RequestInit[] = [];
  const listRequests: RequestInit[] = [];
  const requestedUrls: string[] = [];
  let replyIndex = 0;
  const fetch: FetchLike = async (input, init = {}) => {
    requestedUrls.push(input);
    if (input === 'https://api.amazon.com/auth/o2/token') {
      return new Response(JSON.stringify({
        access_token: ['synthetic', 'access', 'value'].join('-'),
        expires_in: 3_600,
        token_type: 'bearer',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (input.endsWith('/sp/keywords/list')) {
      listRequests.push(init);
      return new Response(JSON.stringify({
        keywords: [{ keywordId: KEYWORD_ID, bid: 1, state: 'ENABLED' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (input.endsWith('/sp/keywords')) {
      mutationRequests.push(init);
      const reply = replies[replyIndex] ?? replies.at(-1);
      replyIndex += 1;
      if (reply === undefined) throw new Error('no synthetic reply');
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected synthetic path ${new URL(input).pathname}`);
  };
  return { fetch, mutationRequests, listRequests, requestedUrls };
}

function adapterWith(fetch: FetchLike) {
  return createSpWriteAdapter({
    credentials: {
      clientId: ['synthetic', 'client'].join('-'),
      clientSecret: ['synthetic', 'secret'].join('-'),
      refreshToken: ['synthetic', 'refresh'].join('-'),
    },
    region: 'NA',
    fetch,
    retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 },
  }, {
    hasher: sha256,
    now: () => Date.parse('2026-08-31T12:00:03.000Z'),
  });
}

describe('explicit package boundary', () => {
  it('resolves the adapter subpath without adding it to the root namespace', () => {
    expect(typeof createSpWriteAdapter).toBe('function');
    expect('createSpWriteAdapter' in adsApiRoot).toBe(false);
  });
});

describe('SP write adapter', () => {
  it('prepares, observes, and closes one indexed 207 with one mutation request', async () => {
    const provider = fakeFetch([{ status: 207, body: {
      keywords: { error: [], success: [{ index: 0, keywordId: KEYWORD_ID }] },
    } }]);
    const adapter = adapterWith(provider.fetch);
    const plan = keywordPlan();
    const calls = adapter.preparePlan(plan);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.routeKey).toBe('sp.v3.keywords.update');

    const observed = await adapter.observeCurrent({ plan, call: calls[0]! });
    expect(observed).toMatchObject([{ values: { bid: { amount: '1', currencyCode: 'USD' } } }]);
    expect(JSON.parse(String(provider.listRequests[0]?.body))).toEqual({
      maxResults: 100,
      keywordIdFilter: { include: [KEYWORD_ID] },
    });

    const intent = intentFor(plan, [...calls[0]!.positions]);
    const result = await adapter.executeOneAttempt({ plan, intent, resultId: RESULT_ID });
    expect(provider.mutationRequests).toHaveLength(1);
    expect(JSON.parse(String(provider.mutationRequests[0]?.body))).toEqual({
      keywords: [{ keywordId: KEYWORD_ID, bid: 1.1 }],
    });
    expect(result.positions).toEqual([{
      requestIndex: 0,
      actionId: ACTION_ID,
      actionFingerprint: plan.actions[0]!.fingerprint,
      actionRequestFingerprint: intent.positions[0]!.actionRequestFingerprint,
      outcome: 'accepted',
      providerEntityId: KEYWORD_ID,
      code: null,
      message: null,
    }]);
    expect(result.fingerprint).toBe(
      sha256.digest(serializeSpWriteProviderResultFingerprint(result)),
    );
  });

  it('does not consume a queued success after a 429', async () => {
    const provider = fakeFetch([
      { status: 429, body: { message: 'synthetic throttle' } },
      { status: 207, body: {
        keywords: { error: [], success: [{ index: 0, keywordId: KEYWORD_ID }] },
      } },
    ]);
    const adapter = adapterWith(provider.fetch);
    const plan = keywordPlan();
    const call = adapter.preparePlan(plan)[0]!;
    const result = await adapter.executeOneAttempt({
      plan,
      intent: intentFor(plan, [...call.positions]),
      resultId: RESULT_ID,
    });

    expect(provider.mutationRequests).toHaveLength(1);
    expect(result.positions.map((position) => position.outcome)).toEqual(['ambiguous']);
  });

  it.each([400, 401, 403, 409, 425, 429, 500, 503, 200])(
    'does not retry or classify an unproven %i response',
    async (status) => {
      const provider = fakeFetch([
        { status, body: { message: 'synthetic unproven status' } },
        { status: 207, body: {
          keywords: { error: [], success: [{ index: 0, keywordId: KEYWORD_ID }] },
        } },
      ]);
      const adapter = adapterWith(provider.fetch);
      const plan = keywordPlan();
      const call = adapter.preparePlan(plan)[0]!;
      const result = await adapter.executeOneAttempt({
        plan,
        intent: intentFor(plan, [...call.positions]),
        resultId: RESULT_ID,
      });

      expect(provider.mutationRequests).toHaveLength(1);
      expect(result.positions.map((position) => position.outcome)).toEqual(['ambiguous']);
    },
  );

  it('refuses a forged intent before resolving a token or issuing a mutation', async () => {
    const provider = fakeFetch([{ status: 207, body: {
      keywords: { error: [], success: [{ index: 0, keywordId: KEYWORD_ID }] },
    } }]);
    const adapter = adapterWith(provider.fetch);
    const plan = keywordPlan();
    const call = adapter.preparePlan(plan)[0]!;
    const validIntent = intentFor(plan, [...call.positions]);
    const forgedIntent = { ...validIntent, fingerprint: '4'.repeat(64) };

    await expect(adapter.executeOneAttempt({
      plan,
      intent: forgedIntent,
      resultId: RESULT_ID,
    })).rejects.toThrow('SP write adapter refused: invalid_intent');
    expect(provider.requestedUrls).toEqual([]);
    expect(provider.mutationRequests).toHaveLength(0);
  });

  it('closes a valid intent as ambiguous when already aborted, without provider I/O', async () => {
    const provider = fakeFetch([{ status: 207, body: {
      keywords: { error: [], success: [{ index: 0, keywordId: KEYWORD_ID }] },
    } }]);
    const adapter = adapterWith(provider.fetch);
    const plan = keywordPlan();
    const call = adapter.preparePlan(plan)[0]!;
    const controller = new AbortController();
    controller.abort(new DOMException('synthetic cancellation', 'AbortError'));

    const result = await adapter.executeOneAttempt({
      plan,
      intent: intentFor(plan, [...call.positions]),
      resultId: RESULT_ID,
    }, { signal: controller.signal });

    expect(provider.requestedUrls).toEqual([]);
    expect(result.positions.map((position) => position.outcome)).toEqual(['ambiguous']);
  });

  it('cancels a cold LWA fetch and never issues a late mutation', async () => {
    const controller = new AbortController();
    const marker = ['synthetic', 'cancel', 'reason'].join('-');
    const requestedUrls: string[] = [];
    const capture: { signal?: AbortSignal } = {};
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetch: FetchLike = async (input, init = {}) => {
      requestedUrls.push(input);
      if (input !== 'https://api.amazon.com/auth/o2/token') {
        throw new Error('mutation must not be reached');
      }
      if (init.signal !== undefined && init.signal !== null) capture.signal = init.signal;
      markStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        capture.signal?.addEventListener('abort', () => reject(capture.signal?.reason), { once: true });
      });
    };
    const adapter = adapterWith(fetch);
    const plan = keywordPlan();
    const call = adapter.preparePlan(plan)[0]!;
    const pending = adapter.executeOneAttempt({
      plan,
      intent: intentFor(plan, [...call.positions]),
      resultId: RESULT_ID,
    }, { signal: controller.signal });

    await started;
    controller.abort(new DOMException(marker, 'AbortError'));
    const result = await pending;

    expect(capture.signal?.aborted).toBe(true);
    expect(requestedUrls).toEqual(['https://api.amazon.com/auth/o2/token']);
    expect(result.positions.map((position) => position.outcome)).toEqual(['ambiguous']);
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it('bounds forced token refresh after an observation 401 with the next attempt deadline', async () => {
    const requestedUrls: string[] = [];
    const capture: { signal?: AbortSignal } = {};
    let tokenRequests = 0;
    const fetch: FetchLike = async (input, init = {}) => {
      requestedUrls.push(input);
      if (input === 'https://api.amazon.com/auth/o2/token') {
        tokenRequests += 1;
        if (tokenRequests === 1) {
          return new Response(JSON.stringify({
            access_token: ['synthetic', 'cached', 'token'].join('-'),
            expires_in: 3_600,
            token_type: 'bearer',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (init.signal !== undefined && init.signal !== null) capture.signal = init.signal;
        return new Promise<Response>((_resolve, reject) => {
          capture.signal?.addEventListener('abort', () => reject(capture.signal?.reason), { once: true });
        });
      }
      if (input.endsWith('/sp/keywords/list')) {
        return new Response(JSON.stringify({ message: 'expired' }), { status: 401 });
      }
      throw new Error('no later provider request is allowed');
    };
    const adapter = adapterWith(fetch);
    const plan = keywordPlan();
    const call = adapter.preparePlan(plan)[0]!;

    await expect(adapter.observeCurrent({ plan, call }, { timeoutMs: 20 }))
      .rejects.toThrow('SP write adapter refused: observation_failed');

    expect(capture.signal?.aborted).toBe(true);
    expect(requestedUrls).toEqual([
      'https://api.amazon.com/auth/o2/token',
      'https://advertising-api.amazon.com/sp/keywords/list',
      'https://api.amazon.com/auth/o2/token',
    ]);
  });

  it('turns malformed provider content into closed evidence without leaking it', async () => {
    const marker = ['synthetic', 'private', 'marker'].join('-');
    const provider = fakeFetch([{ status: 207, body: {
      keywords: { error: [], success: [{ index: 4, keywordId: KEYWORD_ID, marker }] },
    } }]);
    const adapter = adapterWith(provider.fetch);
    const plan = keywordPlan();
    const call = adapter.preparePlan(plan)[0]!;
    const result = await adapter.executeOneAttempt({
      plan,
      intent: intentFor(plan, [...call.positions]),
      resultId: RESULT_ID,
    });

    expect(result.positions.map((position) => position.outcome)).toEqual(['ambiguous']);
    expect(JSON.stringify(result)).not.toContain(marker);
  });
});
