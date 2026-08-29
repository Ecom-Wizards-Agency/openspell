import { describe, expect, it, vi } from 'vitest';
import type {
  AmazonWriteProviderEvidence,
  AmazonWriteAction,
  BoundedAmazonWriteAuthorization,
  EntityRow,
} from '@wizard-ads/shared';
import type { AdsProfileContext, SpWriteClient } from './ads-api.js';
import { SpWriteAmbiguousError, SpWriteRetryableError } from './ads-api.js';
import {
  GuardedAmazonWriteRuntime,
  type AmazonWriteRuntimeStore,
} from './amazon-writes.js';

const NOW = new Date('2026-08-29T12:00:00.000Z');
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const PROFILE_ID = '22222222-2222-4222-8222-222222222222';
const EXECUTION_ID = '33333333-3333-4333-8333-333333333333';
const BATCH_ID = '44444444-4444-4444-8444-444444444444';

const profile: AdsProfileContext = {
  id: PROFILE_ID,
  orgId: ORG_ID,
  amazonProfileId: 'amazon-profile-1',
  region: 'NA',
  currencyCode: 'USD',
  timezone: 'UTC',
  accountName: 'Synthetic account',
  countryCode: 'US',
};

const authorization: BoundedAmazonWriteAuthorization = {
  schema: 'openspell.amazon-write-authorization.v1',
  expires_at: '2026-08-30T12:00:00.000Z',
  profiles: [{ account_label: 'Synthetic account', marketplace: 'US' }],
  allowed_tests: {
    bid: { enabled: true, max_absolute_delta: 0.01, require_immediate_inverse: true },
    placement: { enabled: true, max_absolute_percentage_points: 1, require_immediate_inverse: true },
    cadence: { enabled: false, max_executions: 0, disable_after_test: true, require_immediate_inverse: true },
  },
  constraints: {
    max_concurrent_mutations: 1,
    require_current_value_match: true,
    require_amazon_acceptance: true,
    require_sync_observation_before_inverse: true,
    stop_on_conflict: true,
  },
};

function bidAction(index = 1): AmazonWriteAction {
  return {
    actionType: 'sp_keyword_bid',
    applyRowId: `55555555-5555-4555-8555-55555555555${index}`,
    amazonEntityId: `keyword-${index}`,
    field: 'bid',
    expectedValue: 0.7,
    requestedValue: 0.71,
    inverseValue: 0.7,
  };
}

function prepared(actions: AmazonWriteAction[]) {
  return {
    executionId: EXECUTION_ID,
    applyBatchId: BATCH_ID,
    approvalMode: 'bounded_live_test' as const,
    inversePreapproved: true,
    expiresAt: new Date(authorization.expires_at),
    status: 'running' as const,
    requested: actions.length,
    rows: actions.map((action, index) => ({
      writeRowId: `66666666-6666-4666-8666-66666666666${index + 1}`,
      attemptNumber: 1,
      action,
    })),
    replayed: false,
  };
}

function accounting(input: Partial<{
  requested: number; attempted: number; succeeded: number; failed: number;
  ambiguous: number; refused: number; resyncRequested: number; resynchronized: number;
}> = {}) {
  return {
    requested: 1, attempted: 1, succeeded: 1, failed: 0,
    ambiguous: 0, refused: 0, resyncRequested: 1, resynchronized: 0,
    ...input,
  };
}

function fakeStore(overrides: Partial<AmazonWriteRuntimeStore> = {}): AmazonWriteRuntimeStore {
  return {
    prepare: vi.fn(async () => prepared([bidAction()])),
    refuse: vi.fn(async () => accounting({ attempted: 0, succeeded: 0, refused: 1, resyncRequested: 0 })),
    releaseForRetry: vi.fn(async () => {}),
    recordOutcomes: vi.fn(async (input: Parameters<AmazonWriteRuntimeStore['recordOutcomes']>[0]) => {
      const succeeded = input.outcomes.filter((row) => row.evidence.outcome === 'accepted').length;
      const ambiguous = input.outcomes.filter((row) => row.evidence.outcome === 'ambiguous').length;
      const failed = input.outcomes.length - succeeded - ambiguous;
      const status: 'partial' | 'awaiting_sync' | 'failed' = succeeded > 0 && failed > 0
        ? 'partial' : succeeded > 0 || ambiguous > 0 ? 'awaiting_sync' : 'failed';
      return {
        status,
        accounting: accounting({
          requested: input.outcomes.length,
          attempted: input.outcomes.length,
          succeeded,
          failed,
          ambiguous,
          resyncRequested: succeeded + ambiguous,
        }),
        retryable: 0,
        shouldObserve: succeeded + ambiguous > 0,
      };
    }),
    observationRows: vi.fn(async () => []),
    syncEntities: vi.fn(async (_profile, entities) => ({ listed: entities.length, upserted: entities.length })),
    resolveObservation: vi.fn(async () => []),
    recordObservations: vi.fn(async () => ({
      status: 'succeeded' as const, accounting: accounting({ resynchronized: 1 }),
      pending: 0, inverseReady: true,
    })),
    enqueueObservation: vi.fn(async () => true),
    ...overrides,
  };
}

function accepted(id: string): AmazonWriteProviderEvidence {
  return { outcome: 'accepted', providerEntityId: id, code: null, message: null };
}

function fakeProvider(overrides: Partial<SpWriteClient> = {}): SpWriteClient {
  return {
    updateSpKeywordBids: vi.fn(async (_profile: AdsProfileContext, items: Parameters<SpWriteClient['updateSpKeywordBids']>[1]) => items.map((item) => accepted(item.keywordId))),
    updateSpTargetBids: vi.fn(async (_profile: AdsProfileContext, items: Parameters<SpWriteClient['updateSpTargetBids']>[1]) => items.map((item) => accepted(item.targetId))),
    updateSpCampaignPlacements: vi.fn(async (_profile: AdsProfileContext, items: Parameters<SpWriteClient['updateSpCampaignPlacements']>[1]) => items.map((item) => accepted(item.campaignId))),
    observeSpWriteEntities: vi.fn(async () => ({ rows: [], requested: 0, returned: 0, apiCalls: 0 })),
    ...overrides,
  };
}

const job = { type: 'amazon.apply' as const, orgId: ORG_ID, profileId: PROFILE_ID, executionId: EXECUTION_ID };

describe('guarded Amazon write runtime', () => {
  it('records a refusal and makes zero provider calls when the deployment gate is closed', async () => {
    const store = fakeStore();
    const provider = fakeProvider();
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: false, authorization, provider, store, now: () => NOW,
    });
    const result = await runtime.apply(job, profile);
    expect(result).toMatchObject({ status: 'refused', refused: 1, amazonApiCalls: 0 });
    expect(store.prepare).not.toHaveBeenCalled();
    expect(provider.updateSpKeywordBids).not.toHaveBeenCalled();
  });

  it('preserves partial Amazon success with exact row accounting', async () => {
    const actions = [bidAction(1), bidAction(2)];
    const store = fakeStore({ prepare: vi.fn(async () => prepared(actions)) });
    const provider = fakeProvider({
      updateSpKeywordBids: vi.fn(async () => [
        accepted('keyword-1'),
        { outcome: 'failed' as const, providerEntityId: null, code: 'INVALID_ARGUMENT', message: 'synthetic rejection' },
      ]),
    });
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, authorization, provider, store, now: () => NOW,
    });
    const result = await runtime.apply(job, profile);
    expect(result).toMatchObject({
      attempted: 2, succeeded: 1, failed: 1, refused: 0,
      resyncRequested: 1, amazonApiCalls: 1, observationEnqueued: true,
    });
    const recorded = vi.mocked(store.recordOutcomes).mock.calls[0]?.[0];
    expect(recorded?.outcomes).toHaveLength(2);
    expect(recorded?.outcomes.map((row) => row.evidence.outcome)).toEqual(['accepted', 'failed']);
  });

  it('retries an explicit pre-mutation throttle without recording a false provider attempt', async () => {
    const store = fakeStore();
    const provider = fakeProvider({
      updateSpKeywordBids: vi.fn(async () => { throw new SpWriteRetryableError('throttled', 3); }),
    });
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, authorization, provider, store, now: () => NOW,
    });
    await expect(runtime.apply(job, profile)).rejects.toMatchObject({ retryAfterSeconds: 3 });
    expect(store.recordOutcomes).not.toHaveBeenCalled();
    expect(store.releaseForRetry).toHaveBeenCalledWith(job);
    expect(store.enqueueObservation).not.toHaveBeenCalled();
  });

  it('does not call Amazon again when a replay has no unresolved rows', async () => {
    const store = fakeStore({
      prepare: vi.fn(async () => ({ ...prepared([bidAction()]), rows: [], status: 'awaiting_sync' as const, replayed: true })),
    });
    const provider = fakeProvider();
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, authorization, provider, store, now: () => NOW,
    });
    await expect(runtime.apply(job, profile)).resolves.toMatchObject({ replayed: true, amazonApiCalls: 0 });
    expect(provider.updateSpKeywordBids).not.toHaveBeenCalled();
  });

  it('makes zero provider calls when the locked current-state check refuses the execution', async () => {
    const store = fakeStore({
      prepare: vi.fn(async () => ({
        ...prepared([bidAction()]), rows: [], status: 'refused' as const, replayed: false,
      })),
    });
    const provider = fakeProvider();
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, authorization, provider, store, now: () => NOW,
    });
    await expect(runtime.apply(job, profile)).resolves.toMatchObject({
      status: 'refused', replayed: false, amazonApiCalls: 0,
    });
    expect(provider.updateSpKeywordBids).not.toHaveBeenCalled();
  });

  it('observes an ambiguous mutation and refuses later groups instead of blindly continuing', async () => {
    const target: AmazonWriteAction = {
      actionType: 'sp_target_bid', applyRowId: '77777777-7777-4777-8777-777777777779',
      amazonEntityId: 'target-1', field: 'bid', expectedValue: 0.6,
      requestedValue: 0.61, inverseValue: 0.6,
    };
    const store = fakeStore({ prepare: vi.fn(async () => prepared([bidAction(), target])) });
    const provider = fakeProvider({
      updateSpKeywordBids: vi.fn(async () => {
        throw new SpWriteAmbiguousError('synthetic timeout after send');
      }),
    });
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, authorization, provider, store, now: () => NOW,
    });
    const result = await runtime.apply(job, profile);
    expect(result).toMatchObject({ amazonApiCalls: 1, observationEnqueued: true });
    expect(provider.updateSpTargetBids).not.toHaveBeenCalled();
    expect(store.refuse).toHaveBeenCalledWith(expect.objectContaining({
      reason: expect.stringMatching(/ambiguous/i),
    }));
    expect(store.enqueueObservation).toHaveBeenCalledTimes(1);
  });

  it('keeps provider calls within one Amazon HTTP batch and reports the exact call count', async () => {
    const actions = Array.from({ length: 101 }, (_unused, index): AmazonWriteAction => ({
      ...bidAction(),
      applyRowId: `55555555-5555-4555-8555-${String(index + 1).padStart(12, '0')}`,
      amazonEntityId: `keyword-${index + 1}`,
    }));
    const store = fakeStore({ prepare: vi.fn(async () => prepared(actions)) });
    const provider = fakeProvider();
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, authorization, provider, store, now: () => NOW,
    });
    const result = await runtime.apply(job, profile);
    expect(result).toMatchObject({ amazonApiCalls: 2, observationEnqueued: true });
    expect(provider.updateSpKeywordBids).toHaveBeenCalledTimes(2);
    expect(vi.mocked(provider.updateSpKeywordBids).mock.calls.map((call) => call[1].length))
      .toEqual([100, 1]);
  });

  it('coalesces two placement fields on one campaign into one provider mutation', async () => {
    const context = {
      strategy: 'auto_for_sales' as const,
      placementBidding: { topOfSearch: 20, productPages: 5, restOfSearch: 0 },
    };
    const actions: AmazonWriteAction[] = [
      {
        actionType: 'sp_campaign_placement', applyRowId: '77777777-7777-4777-8777-777777777771',
        amazonEntityId: 'campaign-1', field: 'top_of_search', expectedValue: 20,
        requestedValue: 21, inverseValue: 20, campaignContext: context,
      },
      {
        actionType: 'sp_campaign_placement', applyRowId: '77777777-7777-4777-8777-777777777772',
        amazonEntityId: 'campaign-1', field: 'product_pages', expectedValue: 5,
        requestedValue: 6, inverseValue: 5, campaignContext: context,
      },
    ];
    const store = fakeStore({ prepare: vi.fn(async () => prepared(actions)) });
    const provider = fakeProvider();
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, authorization, provider, store, now: () => NOW,
    });
    await runtime.apply(job, profile);
    expect(provider.updateSpCampaignPlacements).toHaveBeenCalledTimes(1);
    expect(vi.mocked(provider.updateSpCampaignPlacements).mock.calls[0]?.[1]).toEqual([{
      campaignId: 'campaign-1',
      strategy: 'AUTO_FOR_SALES',
      placementBidding: [
        { placement: 'PLACEMENT_TOP', percentage: 21 },
        { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 6 },
        { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 0 },
      ],
    }]);
    expect(vi.mocked(store.recordOutcomes).mock.calls[0]?.[0].outcomes).toHaveLength(2);
  });

  it('counts the targeted observation reads and exact mirror upserts', async () => {
    const action = bidAction();
    const store = fakeStore({
      observationRows: vi.fn(async () => [{
        writeRowId: '66666666-6666-4666-8666-666666666661', action,
      }]),
      resolveObservation: vi.fn(async () => [{
        writeRowId: '66666666-6666-4666-8666-666666666661',
        state: 'observed' as const, currentValue: 0.71,
      }]),
    });
    const provider = fakeProvider({
      observeSpWriteEntities: vi.fn(async () => ({
        requested: 1,
        returned: 1,
        apiCalls: 1,
        rows: [{
          entityType: 'keyword', profileId: PROFILE_ID, amazonId: 'keyword-1',
          adProduct: 'SP', name: 'synthetic', state: 'enabled', campaignId: 'campaign-1',
          adGroupId: 'group-1', keywordText: 'synthetic', matchType: 'exact', bid: 0.71,
        } satisfies EntityRow],
      })),
    });
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, authorization, provider, store, now: () => NOW,
    });
    const result = await runtime.observe({ ...job, type: 'amazon.observe', attempt: 0 }, profile);
    expect(result).toMatchObject({
      status: 'succeeded', targetedEntities: 1, returnedEntities: 1,
      upsertedEntities: 1, amazonApiCalls: 1, inverseReady: true,
    });
    expect(store.syncEntities).toHaveBeenCalledWith(profile, expect.arrayContaining([
      expect.objectContaining({ amazonId: 'keyword-1', bid: 0.71 }),
    ]));
  });
});
