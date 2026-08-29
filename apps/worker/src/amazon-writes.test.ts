import { describe, expect, it, vi } from 'vitest';
import {
  BoundedAmazonWriteAuthorization,
  type AmazonWriteProviderEvidence,
  type AmazonWriteAction,
  type EntityRow,
} from '@wizard-ads/shared';
import type { AdsProfileContext, SpWriteClient, SpWriteObservationRequest } from './ads-api.js';
import { AdsApiRetryableError, SpWriteAmbiguousError, SpWriteRetryableError } from './ads-api.js';
import {
  boundedAmazonWriteAuthorizationFingerprint,
  GuardedAmazonWriteRuntime,
  classifyAmazonWriteObservations,
  type AmazonWriteRuntimeStore,
} from './amazon-writes.js';

const NOW = new Date('2026-08-29T12:00:00.000Z');
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const PROFILE_ID = '22222222-2222-4222-8222-222222222222';
const EXECUTION_ID = '33333333-3333-4333-8333-333333333333';
const BATCH_ID = '44444444-4444-4444-8444-444444444444';
const AUTHORIZATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONNECTION_ID = 'abababab-abab-4bab-8bab-abababababab';

const profile: AdsProfileContext = {
  id: PROFILE_ID,
  orgId: ORG_ID,
  connectionId: CONNECTION_ID,
  amazonProfileId: 'amazon-profile-1',
  region: 'NA',
  currencyCode: 'USD',
  timezone: 'UTC',
  accountName: 'Synthetic account',
  countryCode: 'US',
};

const authorization: BoundedAmazonWriteAuthorization = {
  schema: 'openspell.amazon-write-authorization.v1',
  authorization_id: AUTHORIZATION_ID,
  expires_at: '2026-08-30T12:00:00.000Z',
  profiles: [{
    org_id: ORG_ID,
    profile_id: PROFILE_ID,
    amazon_profile_id: 'amazon-profile-1',
    connection_id: CONNECTION_ID,
    region: 'NA',
    account_label: 'Synthetic account',
    marketplace: 'US',
    allowed_entities: [
      ...Array.from({ length: 100 }, (_unused, index) => ({
        action_type: 'sp_keyword_bid' as const,
        amazon_entity_id: `keyword-${index + 1}`,
        field: 'bid' as const,
      })),
      { action_type: 'sp_target_bid', amazon_entity_id: 'target-1', field: 'bid' },
      { action_type: 'sp_campaign_placement', amazon_entity_id: 'campaign-1', field: 'top_of_search' },
      { action_type: 'sp_campaign_placement', amazon_entity_id: 'campaign-1', field: 'product_pages' },
    ],
  }],
  allowed_tests: {
    bid: { enabled: true, max_absolute_delta: 0.01, require_immediate_inverse: true },
    placement: { enabled: true, max_absolute_percentage_points: 1, require_immediate_inverse: true },
    cadence: { enabled: false, max_executions: 0, disable_after_test: true, require_immediate_inverse: true },
  },
  constraints: {
    max_concurrent_mutations: 1,
    max_rows_per_execution: 100,
    max_total_executions: 2,
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
      writeRowId: `66666666-6666-4666-8666-666666666${String(index + 1).padStart(3, '6')}`,
      attemptNumber: 1,
      action,
    })),
    replayed: false,
    recoveryObservation: false,
    direction: 'forward' as const,
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
    markDispatched: vi.fn(async () => true),
    recheckCurrentState: vi.fn(async () => true),
    recordFreshness: vi.fn(async () => {}),
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
      pending: 0, inverseReady: true, retryApply: false,
      applyRequeued: false,
      observationRequeued: false,
      inverseExecutionId: null,
    })),
    enqueue: vi.fn(async () => true),
    ...overrides,
  };
}

function accepted(id: string): AmazonWriteProviderEvidence {
  return { outcome: 'accepted', providerEntityId: id, code: null, message: null };
}

function fakeProvider(overrides: Partial<SpWriteClient> = {}): SpWriteClient {
  return {
    updateSpKeywordBids: vi.fn(async (_profile: AdsProfileContext, items: Parameters<SpWriteClient['updateSpKeywordBids']>[1]) => ({ evidence: items.map((item) => accepted(item.keywordId)), apiCalls: 1 })),
    updateSpTargetBids: vi.fn(async (_profile: AdsProfileContext, items: Parameters<SpWriteClient['updateSpTargetBids']>[1]) => ({ evidence: items.map((item) => accepted(item.targetId)), apiCalls: 1 })),
    updateSpCampaignPlacements: vi.fn(async (_profile: AdsProfileContext, items: Parameters<SpWriteClient['updateSpCampaignPlacements']>[1]) => ({ evidence: items.map((item) => accepted(item.campaignId)), apiCalls: 1 })),
    observeSpWriteEntities: vi.fn(async (
      _profile: AdsProfileContext,
      request: SpWriteObservationRequest,
    ) => {
      const rows: EntityRow[] = [
        ...request.keywordIds.map((amazonId) => ({
          entityType: 'keyword' as const, profileId: PROFILE_ID, amazonId,
          adProduct: 'SP' as const, name: 'synthetic', state: 'enabled' as const,
          campaignId: 'campaign-1', adGroupId: 'group-1', keywordText: 'synthetic',
          matchType: 'exact' as const, bid: 0.7,
        })),
        ...request.targetIds.map((amazonId) => ({
          entityType: 'target' as const, profileId: PROFILE_ID, amazonId,
          adProduct: 'SP' as const, name: 'synthetic', state: 'enabled' as const,
          campaignId: 'campaign-1', adGroupId: 'group-1', expression: [],
          resolvedExpression: null, bid: 0.6,
        })),
        ...request.campaignIds.map((amazonId) => ({
          entityType: 'campaign' as const, profileId: PROFILE_ID, amazonId,
          adProduct: 'SP' as const, name: 'synthetic', state: 'enabled' as const,
          portfolioId: null, budgetAmount: 10, budgetType: 'daily' as const,
          targetingType: 'manual' as const, biddingStrategy: 'auto_for_sales' as const,
          placementBidding: { topOfSearch: 20, productPages: 5, restOfSearch: 0 },
          campaignWriteContext: {
            strategy: 'auto_for_sales' as const,
            placementBidding: [
              { placement: 'PLACEMENT_PRODUCT_PAGE' as const, percentage: 5 },
              { placement: 'PLACEMENT_REST_OF_SEARCH' as const, percentage: 0 },
              { placement: 'PLACEMENT_TOP' as const, percentage: 20 },
            ],
            shopperCohortBidding: null,
            offAmazonSettings: null,
          },
          startDate: null, endDate: null,
        })),
      ];
      return { rows, requested: rows.length, returned: rows.length, apiCalls: 1 };
    }),
    ...overrides,
  };
}

const job = { type: 'amazon.apply' as const, orgId: ORG_ID, profileId: PROFILE_ID, executionId: EXECUTION_ID };

describe('guarded Amazon write runtime', () => {
  it('binds the authorization fingerprint to external advertiser identity', () => {
    const original = boundedAmazonWriteAuthorizationFingerprint(authorization);
    expect(boundedAmazonWriteAuthorizationFingerprint({
      ...authorization,
      profiles: authorization.profiles.map((allowed) => ({
        ...allowed, amazon_profile_id: 'rebound-amazon-profile',
      })),
    })).not.toBe(original);
    expect(boundedAmazonWriteAuthorizationFingerprint({
      ...authorization,
      profiles: authorization.profiles.map((allowed) => ({
        ...allowed, connection_id: '99999999-9999-4999-8999-999999999999',
      })),
    })).not.toBe(original);
  });

  it('keeps original provider state pending, then conflicts without automatically resending', () => {
    const action = bidAction();
    const providerKeyword = {
      entityType: 'keyword', profileId: PROFILE_ID, amazonId: 'keyword-1',
      adProduct: 'SP', name: 'synthetic', state: 'enabled', campaignId: 'campaign-1',
      adGroupId: 'group-1', keywordText: 'synthetic', matchType: 'exact', bid: 0.7,
    } satisfies EntityRow;
    const observedRows = [providerKeyword];
    const input = {
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      actions: [{ writeRowId: '66666666-6666-4666-8666-666666666661', action, rowStatus: 'dispatched' }],
      observedRows,
    };
    expect(classifyAmazonWriteObservations({ ...input, finalAttempt: false }))
      .toEqual([expect.objectContaining({ state: 'pending', currentValue: 0.7 })]);
    expect(classifyAmazonWriteObservations({ ...input, finalAttempt: true }))
      .toEqual([expect.objectContaining({ state: 'conflict', currentValue: 0.7 })]);
    expect(classifyAmazonWriteObservations({
      ...input,
      finalAttempt: false,
      observedRows: [{ ...providerKeyword, bid: 0.71 }],
    })).toEqual([expect.objectContaining({ state: 'observed', currentValue: 0.71 })]);
  });

  it('treats harmless shopper-cohort and audience-segment reordering as the same placement state', () => {
    const providerState = {
      strategy: 'auto_for_sales' as const,
      placementBidding: [
        { placement: 'PLACEMENT_TOP' as const, percentage: 20 },
        { placement: 'PLACEMENT_PRODUCT_PAGE' as const, percentage: 5 },
      ],
      shopperCohortBidding: [
        {
          shopperCohortType: 'BETA', percentage: 10,
          audienceSegments: [
            { audienceId: 'z', audienceSegmentType: 'TYPE_B' },
            { audienceId: 'a', audienceSegmentType: 'TYPE_A' },
          ],
        },
        { shopperCohortType: 'ALPHA', percentage: 15 },
      ],
      offAmazonSettings: null,
    };
    const action: AmazonWriteAction = {
      actionType: 'sp_campaign_placement',
      applyRowId: '77777777-7777-4777-8777-777777777771',
      amazonEntityId: 'campaign-1', field: 'top_of_search',
      expectedValue: 20, requestedValue: 21, inverseValue: 20,
      campaignContext: { providerState },
    };
    const observedContext = {
      ...providerState,
      placementBidding: [
        { placement: 'PLACEMENT_PRODUCT_PAGE' as const, percentage: 5 },
        { placement: 'PLACEMENT_TOP' as const, percentage: 21 },
      ],
      shopperCohortBidding: [
        { shopperCohortType: 'ALPHA', percentage: 15 },
        {
          shopperCohortType: 'BETA', percentage: 10,
          audienceSegments: [
            { audienceId: 'a', audienceSegmentType: 'TYPE_A' },
            { audienceId: 'z', audienceSegmentType: 'TYPE_B' },
          ],
        },
      ],
    };
    const rows: EntityRow[] = [{
      entityType: 'campaign', profileId: PROFILE_ID, amazonId: 'campaign-1',
      adProduct: 'SP', name: 'synthetic', state: 'enabled', portfolioId: null,
      budgetAmount: 10, budgetType: 'daily', targetingType: 'manual',
      biddingStrategy: 'auto_for_sales', placementBidding: {
        topOfSearch: 21, productPages: 5, restOfSearch: null,
      },
      campaignWriteContext: observedContext, startDate: null, endDate: null,
    }];

    expect(classifyAmazonWriteObservations({
      orgId: ORG_ID, profileId: PROFILE_ID,
      actions: [{ writeRowId: '66666666-6666-4666-8666-666666666661', action, rowStatus: 'accepted' }],
      observedRows: rows, finalAttempt: true,
    })).toEqual([expect.objectContaining({ state: 'observed', currentValue: 21 })]);
  });

  it('never resends a successful call whose result ledger failed and whose value was externally restored', async () => {
    const action = bidAction();
    const running = prepared([action]);
    const store = fakeStore({
      prepare: vi.fn()
        .mockResolvedValueOnce(running)
        .mockResolvedValueOnce({ ...running, status: 'conflict' as const, rows: [], replayed: true }),
      recordOutcomes: vi.fn(async () => {
        throw new Error('synthetic post-provider ledger outage');
      }),
      observationRows: vi.fn(async () => [{
        writeRowId: running.rows[0]!.writeRowId, action, rowStatus: 'dispatched',
      }]),
      resolveObservation: vi.fn(async (input) => classifyAmazonWriteObservations(input)),
      recordObservations: vi.fn(async (input) => {
        expect(input.observations).toEqual([expect.objectContaining({
          state: 'conflict', currentValue: 0.7,
        })]);
        return {
          status: 'conflict' as const,
          accounting: accounting({ succeeded: 0, ambiguous: 1, resynchronized: 0 }),
          pending: 0,
          inverseReady: false,
          retryApply: false,
          applyRequeued: false,
          observationRequeued: true,
          inverseExecutionId: null,
        };
      }),
    });
    const provider = fakeProvider();
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });

    await expect(runtime.apply(job, profile)).rejects.toThrow(/ledger outage/);
    expect(provider.updateSpKeywordBids).toHaveBeenCalledTimes(1);
    await expect(runtime.observe({
      ...job,
      type: 'amazon.observe',
      generation: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      attempt: 5,
    }, profile)).resolves.toMatchObject({ status: 'conflict', applyRequeued: false });
    await expect(runtime.apply(job, profile)).resolves.toMatchObject({
      status: 'conflict', amazonApiCalls: 0,
    });
    expect(provider.updateSpKeywordBids).toHaveBeenCalledTimes(1);
    expect(store.enqueue).not.toHaveBeenCalled();
  });

  it('durably defers and makes zero provider calls when the deployment gate is closed', async () => {
    const store = fakeStore();
    const provider = fakeProvider();
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: false, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });
    await expect(runtime.apply(job, profile)).rejects.toMatchObject({
      name: 'SpWriteRetryableError', apiCalls: 0,
    });
    expect(store.refuse).not.toHaveBeenCalled();
    expect(store.prepare).not.toHaveBeenCalled();
    expect(provider.updateSpKeywordBids).not.toHaveBeenCalled();
  });

  it('holds a reserved inverse while the kill switch is off and executes it once after re-enable', async () => {
    const inverseAction: AmazonWriteAction = {
      ...bidAction(), expectedValue: 0.71, requestedValue: 0.7, inverseValue: 0.71,
    };
    const store = fakeStore({
      prepare: vi.fn(async () => ({
        ...prepared([inverseAction]),
        direction: 'inverse' as const,
        inversePreapproved: false,
      })),
    });
    const provider = fakeProvider({
      observeSpWriteEntities: vi.fn(async () => ({
        requested: 1,
        returned: 1,
        identityComplete: true,
        apiCalls: 1,
        rows: [{
          entityType: 'keyword', profileId: PROFILE_ID, amazonId: 'keyword-1',
          adProduct: 'SP', name: 'synthetic', state: 'enabled', campaignId: 'campaign-1',
          adGroupId: 'group-1', keywordText: 'synthetic', matchType: 'exact', bid: 0.71,
        } satisfies EntityRow],
      })),
    });
    const disabled = new GuardedAmazonWriteRuntime({
      enabled: false, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });

    await expect(disabled.apply(job, profile)).rejects.toMatchObject({
      name: 'SpWriteRetryableError', apiCalls: 0,
    });
    expect(store.prepare).not.toHaveBeenCalled();
    expect(store.refuse).not.toHaveBeenCalled();
    expect(provider.updateSpKeywordBids).not.toHaveBeenCalled();

    const enabled = new GuardedAmazonWriteRuntime({
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });
    await expect(enabled.apply(job, profile)).resolves.toMatchObject({
      status: 'awaiting_sync', amazonApiCalls: 2,
    });
    expect(provider.updateSpKeywordBids).toHaveBeenCalledTimes(1);
    expect(store.refuse).not.toHaveBeenCalled();
  });

  it('defers an invalid one-way bounded mutation authorization before provider I/O', async () => {
    const store = fakeStore();
    const provider = fakeProvider();
    const unsafeAuthorization = {
      ...authorization,
      allowed_tests: {
        ...authorization.allowed_tests,
        bid: { ...authorization.allowed_tests.bid, require_immediate_inverse: false },
      },
    };
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true,
      loadAuthorization: async () => BoundedAmazonWriteAuthorization.parse(unsafeAuthorization),
      provider,
      store,
      now: () => NOW,
    });
    await expect(runtime.apply(job, profile)).rejects.toMatchObject({
      name: 'SpWriteRetryableError', apiCalls: 0,
    });
    expect(store.prepare).not.toHaveBeenCalled();
    expect(provider.observeSpWriteEntities).not.toHaveBeenCalled();
    expect(provider.updateSpKeywordBids).not.toHaveBeenCalled();
  });

  it('defers a live pre-dispatch lease instead of completing the only recovery job', async () => {
    const store = fakeStore({
      prepare: vi.fn(async () => ({
        ...prepared([bidAction()]),
        rows: [],
        status: 'running' as const,
        replayed: true,
        retryAfterSeconds: 300,
      })),
    });
    const provider = fakeProvider();
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });
    await expect(runtime.apply(job, profile)).rejects.toMatchObject({
      name: 'SpWriteRetryableError', retryAfterSeconds: 300, apiCalls: 0,
    });
    expect(provider.observeSpWriteEntities).not.toHaveBeenCalled();
    expect(provider.updateSpKeywordBids).not.toHaveBeenCalled();
  });

  it('compares bounded bid deltas in canonical cents', async () => {
    const action = { ...bidAction(), requestedValue: 0.72 };
    const store = fakeStore({ prepare: vi.fn(async () => prepared([action])) });
    const provider = fakeProvider();
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });
    await expect(runtime.apply(job, profile)).resolves.toMatchObject({
      status: 'refused', amazonApiCalls: 0,
    });
    expect(store.refuse).toHaveBeenCalledWith(expect.objectContaining({
      reason: expect.stringMatching(/exceeds/i),
    }));
    expect(provider.updateSpKeywordBids).not.toHaveBeenCalled();
  });

  it.each([
    ['keyword fractional-cent escape', {
      ...bidAction(), expectedValue: 0.901, requestedValue: 0.914, inverseValue: 0.901,
    }, authorization],
    ['target round-to-zero escape', {
      actionType: 'sp_target_bid' as const,
      applyRowId: '55555555-5555-4555-8555-555555555552',
      amazonEntityId: 'target-1', field: 'bid' as const,
      expectedValue: 0.601, requestedValue: 0.604, inverseValue: 0.601,
    }, {
      ...authorization,
      allowed_tests: {
        ...authorization.allowed_tests,
        bid: { ...authorization.allowed_tests.bid, max_absolute_delta: 0.001 },
      },
    }],
  ])('refuses %s before any provider read or mutation', async (_name, action, bounded) => {
    const store = fakeStore({ prepare: vi.fn(async () => prepared([action])) });
    const provider = fakeProvider();
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true,
      loadAuthorization: async () => bounded,
      provider,
      store,
      now: () => NOW,
    });
    await expect(runtime.apply(job, profile)).resolves.toMatchObject({
      status: 'refused', amazonApiCalls: 0,
    });
    expect(store.refuse).toHaveBeenCalledWith(expect.objectContaining({
      reason: expect.stringMatching(/minor units/i),
    }));
    expect(provider.observeSpWriteEntities).not.toHaveBeenCalled();
    expect(provider.updateSpKeywordBids).not.toHaveBeenCalled();
    expect(provider.updateSpTargetBids).not.toHaveBeenCalled();
  });

  it.each([
    ['forward', 4 * 60 * 60_000 - 1, /reversal runway/i],
    ['inverse', 2 * 60 * 60_000 - 1, /observation runway/i],
  ] as const)('refuses %s dispatch when normal expiry leaves no complete recovery runway', async (
    direction,
    remaining,
    reason,
  ) => {
    const expiresAt = new Date(NOW.getTime() + remaining);
    const bounded = { ...authorization, expires_at: expiresAt.toISOString() };
    const preparedExecution = {
      ...prepared([bidAction()]),
      direction,
      inversePreapproved: direction === 'forward',
      expiresAt,
    };
    const store = fakeStore({ prepare: vi.fn(async () => preparedExecution) });
    const provider = fakeProvider();
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true,
      loadAuthorization: async () => bounded,
      provider,
      store,
      now: () => NOW,
    });
    await expect(runtime.apply(job, profile)).resolves.toMatchObject({
      status: 'refused', amazonApiCalls: 0,
    });
    expect(store.refuse).toHaveBeenCalledWith(expect.objectContaining({
      reason: expect.stringMatching(reason),
    }));
    expect(provider.observeSpWriteEntities).not.toHaveBeenCalled();
    expect(provider.updateSpKeywordBids).not.toHaveBeenCalled();
  });

  it('refreshes exact provider IDs and refuses a stale mirror before any mutation call', async () => {
    const store = fakeStore({ recheckCurrentState: vi.fn(async () => false) });
    const provider = fakeProvider();
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true,
      loadAuthorization: async () => authorization,
      provider,
      store,
      now: () => NOW,
    });
    await expect(runtime.apply(job, profile)).resolves.toMatchObject({
      status: 'refused', amazonApiCalls: 1,
    });
    expect(provider.observeSpWriteEntities).toHaveBeenCalledTimes(1);
    expect(store.recordFreshness).toHaveBeenCalledTimes(1);
    expect(store.syncEntities).toHaveBeenCalledTimes(1);
    expect(store.recheckCurrentState).toHaveBeenCalledTimes(1);
    expect(store.markDispatched).not.toHaveBeenCalled();
    expect(provider.updateSpKeywordBids).not.toHaveBeenCalled();
  });

  it('refuses the in-memory targeted bid value even if a stale mirror recheck would pass', async () => {
    const store = fakeStore({ recheckCurrentState: vi.fn(async () => true) });
    const provider = fakeProvider({
      observeSpWriteEntities: vi.fn(async () => ({
        requested: 1,
        returned: 1,
        apiCalls: 1,
        rows: [{
          entityType: 'keyword', profileId: PROFILE_ID, amazonId: 'keyword-1',
          adProduct: 'SP', name: 'synthetic', state: 'enabled', campaignId: 'campaign-1',
          adGroupId: 'group-1', keywordText: 'synthetic', matchType: 'exact', bid: 0.72,
        } satisfies EntityRow],
      })),
    });
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });
    await expect(runtime.apply(job, profile)).resolves.toMatchObject({
      status: 'refused', amazonApiCalls: 1,
    });
    expect(store.recordFreshness).toHaveBeenCalledWith(expect.objectContaining({
      observations: [expect.objectContaining({ currentValue: 0.72, providerState: null })],
    }));
    expect(store.syncEntities).not.toHaveBeenCalled();
    expect(store.recheckCurrentState).not.toHaveBeenCalled();
    expect(provider.updateSpKeywordBids).not.toHaveBeenCalled();
  });

  it('refreshes each provider group immediately before dispatch and never clobbers a later change', async () => {
    const target: AmazonWriteAction = {
      actionType: 'sp_target_bid', applyRowId: '77777777-7777-4777-8777-777777777779',
      amazonEntityId: 'target-1', field: 'bid', expectedValue: 0.6,
      requestedValue: 0.61, inverseValue: 0.6,
    };
    const store = fakeStore({
      prepare: vi.fn(async () => prepared([bidAction(), target])),
      refuse: vi.fn(async () => accounting({
        requested: 2, attempted: 1, succeeded: 1, refused: 1, resyncRequested: 1,
      })),
    });
    const base = fakeProvider();
    const observe = vi.fn(async (
      _profile: AdsProfileContext,
      request: SpWriteObservationRequest,
    ) => {
      if (request.keywordIds.length > 0) {
        return base.observeSpWriteEntities(profile, request);
      }
      const row: EntityRow = {
        entityType: 'target', profileId: PROFILE_ID, amazonId: 'target-1',
        adProduct: 'SP', name: 'synthetic', state: 'enabled', campaignId: 'campaign-1',
        adGroupId: 'group-1', expression: [], resolvedExpression: null, bid: 0.62,
      };
      return { rows: [row], requested: 1, returned: 1, apiCalls: 1 };
    });
    const provider = fakeProvider({ observeSpWriteEntities: observe });
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });

    await expect(runtime.apply(job, profile)).resolves.toMatchObject({
      amazonApiCalls: 3, succeeded: 1, refused: 1, observationEnqueued: true,
    });
    expect(observe).toHaveBeenCalledTimes(2);
    expect(provider.updateSpKeywordBids).toHaveBeenCalledTimes(1);
    expect(provider.updateSpTargetBids).not.toHaveBeenCalled();
  });

  it('compares the complete targeted campaign placement context before mutation', async () => {
    const providerState = {
      strategy: 'auto_for_sales' as const,
      placementBidding: [
        { placement: 'PLACEMENT_PRODUCT_PAGE' as const, percentage: 5 },
        { placement: 'PLACEMENT_REST_OF_SEARCH' as const, percentage: 0 },
        { placement: 'PLACEMENT_TOP' as const, percentage: 20 },
      ],
      shopperCohortBidding: null,
      offAmazonSettings: null,
    };
    const action: AmazonWriteAction = {
      actionType: 'sp_campaign_placement',
      applyRowId: '77777777-7777-4777-8777-777777777779',
      amazonEntityId: 'campaign-1',
      field: 'top_of_search',
      expectedValue: 20,
      requestedValue: 21,
      inverseValue: 20,
      campaignContext: { providerState },
    };
    const store = fakeStore({
      prepare: vi.fn(async () => prepared([action])),
      recheckCurrentState: vi.fn(async () => true),
    });
    const provider = fakeProvider({
      observeSpWriteEntities: vi.fn(async () => ({
        requested: 1,
        returned: 1,
        apiCalls: 1,
        rows: [{
          entityType: 'campaign', profileId: PROFILE_ID, amazonId: 'campaign-1',
          adProduct: 'SP', name: 'synthetic', state: 'enabled', portfolioId: null,
          budgetAmount: 10, budgetType: 'daily', targetingType: 'manual',
          biddingStrategy: 'auto_for_sales',
          placementBidding: { topOfSearch: 20, productPages: 6, restOfSearch: 0 },
          campaignWriteContext: {
            ...providerState,
            placementBidding: providerState.placementBidding.map((placement) =>
              placement.placement === 'PLACEMENT_PRODUCT_PAGE'
                ? { ...placement, percentage: 6 }
                : placement),
          },
          startDate: null, endDate: null,
        } satisfies EntityRow],
      })),
    });
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });
    await expect(runtime.apply(job, profile)).resolves.toMatchObject({
      status: 'refused', amazonApiCalls: 1,
    });
    expect(store.recheckCurrentState).not.toHaveBeenCalled();
    expect(provider.updateSpCampaignPlacements).not.toHaveBeenCalled();
  });

  it('fails closed when the targeted freshness read returns a different entity identity', async () => {
    const store = fakeStore();
    const provider = fakeProvider({
      observeSpWriteEntities: vi.fn(async () => ({
        requested: 1,
        returned: 1,
        apiCalls: 1,
        rows: [{
          entityType: 'keyword', profileId: PROFILE_ID, amazonId: 'different-keyword',
          adProduct: 'SP', name: 'synthetic', state: 'enabled', campaignId: 'campaign-1',
          adGroupId: 'group-1', keywordText: 'synthetic', matchType: 'exact', bid: 0.7,
        } satisfies EntityRow],
      })),
    });
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });

    await expect(runtime.apply(job, profile)).resolves.toMatchObject({
      status: 'refused', amazonApiCalls: 1,
    });
    expect(store.refuse).toHaveBeenCalledWith(expect.objectContaining({
      reason: expect.stringMatching(/freshness values changed/i),
    }));
    expect(store.syncEntities).not.toHaveBeenCalled();
    expect(store.recheckCurrentState).not.toHaveBeenCalled();
    expect(store.markDispatched).not.toHaveBeenCalled();
    expect(provider.updateSpKeywordBids).not.toHaveBeenCalled();
    expect(provider.updateSpTargetBids).not.toHaveBeenCalled();
    expect(provider.updateSpCampaignPlacements).not.toHaveBeenCalled();
  });

  it.each([
    ['organization', { ...profile, orgId: '99999999-9999-4999-8999-999999999999' }],
    ['profile', { ...profile, id: '99999999-9999-4999-8999-999999999999' }],
    ['Amazon advertiser profile', { ...profile, amazonProfileId: 'rebound-amazon-profile' }],
    ['connection', { ...profile, connectionId: '99999999-9999-4999-8999-999999999999' }],
    ['region', { ...profile, region: 'EU' as const }],
  ])('refuses a matching label and marketplace when the immutable %s ID differs', async (_field, mismatchedProfile) => {
    const store = fakeStore();
    const provider = fakeProvider();
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });
    await expect(runtime.apply(job, mismatchedProfile)).rejects.toMatchObject({
      name: 'SpWriteRetryableError', apiCalls: 0,
    });
    expect(store.prepare).not.toHaveBeenCalled();
    expect(provider.updateSpKeywordBids).not.toHaveBeenCalled();
  });

  it('preserves partial Amazon success with exact row accounting', async () => {
    const actions = [bidAction(1), bidAction(2)];
    const store = fakeStore({ prepare: vi.fn(async () => prepared(actions)) });
    const provider = fakeProvider({
      updateSpKeywordBids: vi.fn(async () => ({ evidence: [
        accepted('keyword-1'),
        { outcome: 'failed' as const, providerEntityId: null, code: 'INVALID_ARGUMENT', message: 'synthetic rejection' },
      ], apiCalls: 1 })),
    });
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });
    const result = await runtime.apply(job, profile);
    expect(result).toMatchObject({
      attempted: 2, succeeded: 1, failed: 1, refused: 0,
      resyncRequested: 1, amazonApiCalls: 2, observationEnqueued: true,
    });
    const recorded = vi.mocked(store.recordOutcomes).mock.calls[0]?.[0];
    expect(recorded?.outcomes).toHaveLength(2);
    expect(recorded?.outcomes.map((row) => row.evidence.outcome)).toEqual(['accepted', 'failed']);
    const freshness = vi.mocked(store.recordFreshness).mock.calls[0]?.[0];
    const dispatch = vi.mocked(store.markDispatched).mock.calls[0]?.[0];
    expect(freshness?.callId).toBe(dispatch?.callId);
  });

  it('retries an explicit pre-mutation throttle without recording a false provider attempt', async () => {
    const store = fakeStore();
    const provider = fakeProvider({
      updateSpKeywordBids: vi.fn(async () => { throw new SpWriteRetryableError('throttled', 3); }),
    });
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });
    await expect(runtime.apply(job, profile)).rejects.toMatchObject({ retryAfterSeconds: 3 });
    expect(store.recordOutcomes).not.toHaveBeenCalled();
    expect(store.releaseForRetry).toHaveBeenCalledWith(expect.objectContaining({
      ...job,
      rowIds: ['66666666-6666-4666-8666-666666666661'],
    }));
    expect(store.enqueue).not.toHaveBeenCalled();
  });

  it('caps an oversized provider Retry-After inside the reserved reversal runway', async () => {
    const store = fakeStore();
    const provider = fakeProvider({
      updateSpKeywordBids: vi.fn(async () => {
        throw new SpWriteRetryableError('hostile throttle', 86_400, 1);
      }),
    });
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });
    await expect(runtime.apply(job, profile)).rejects.toMatchObject({
      retryAfterSeconds: 120, apiCalls: 2,
    });
    expect(store.releaseForRetry).toHaveBeenCalledTimes(1);
    expect(provider.updateSpKeywordBids).toHaveBeenCalledTimes(1);
  });

  it('preserves an earlier accepted group when a later group is throttled before mutation', async () => {
    const target: AmazonWriteAction = {
      actionType: 'sp_target_bid', applyRowId: '77777777-7777-4777-8777-777777777779',
      amazonEntityId: 'target-1', field: 'bid', expectedValue: 0.6,
      requestedValue: 0.61, inverseValue: 0.6,
    };
    const store = fakeStore({ prepare: vi.fn(async () => prepared([bidAction(), target])) });
    const provider = fakeProvider({
      updateSpTargetBids: vi.fn(async () => { throw new SpWriteRetryableError('throttled', 4); }),
    });
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });
    await expect(runtime.apply(job, profile)).rejects.toMatchObject({
      retryAfterSeconds: 4, apiCalls: 4,
    });
    expect(store.recordOutcomes).toHaveBeenCalledTimes(1);
    expect(vi.mocked(store.recordOutcomes).mock.calls[0]?.[0].outcomes).toEqual([
      expect.objectContaining({ evidence: expect.objectContaining({ outcome: 'accepted' }) }),
    ]);
    expect(store.releaseForRetry).toHaveBeenCalledWith(expect.objectContaining({
      rowIds: ['66666666-6666-4666-8666-666666666662'],
    }));
  });

  it('rechecks authorization between provider groups and defers the remainder after revocation', async () => {
    const target: AmazonWriteAction = {
      actionType: 'sp_target_bid', applyRowId: '77777777-7777-4777-8777-777777777779',
      amazonEntityId: 'target-1', field: 'bid', expectedValue: 0.6,
      requestedValue: 0.61, inverseValue: 0.6,
    };
    const store = fakeStore({
      prepare: vi.fn(async () => prepared([bidAction(), target])),
      refuse: vi.fn(async () => accounting({
        requested: 2, attempted: 1, succeeded: 1, refused: 1, resyncRequested: 1,
      })),
    });
    const provider = fakeProvider();
    const loadAuthorization = vi.fn()
      .mockResolvedValueOnce(authorization)
      .mockResolvedValueOnce(authorization)
      .mockResolvedValueOnce(authorization)
      .mockResolvedValueOnce(null);
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, loadAuthorization, provider, store, now: () => NOW,
    });
    await expect(runtime.apply(job, profile)).rejects.toMatchObject({
      name: 'SpWriteRetryableError', apiCalls: 2,
    });
    expect(provider.updateSpKeywordBids).toHaveBeenCalledTimes(1);
    expect(provider.updateSpTargetBids).not.toHaveBeenCalled();
    expect(loadAuthorization).toHaveBeenCalledTimes(4);
  });

  it('refuses the remainder when the same authorization UUID changes contents', async () => {
    const target: AmazonWriteAction = {
      actionType: 'sp_target_bid', applyRowId: '77777777-7777-4777-8777-777777777779',
      amazonEntityId: 'target-1', field: 'bid', expectedValue: 0.6,
      requestedValue: 0.61, inverseValue: 0.6,
    };
    const store = fakeStore({
      prepare: vi.fn(async () => prepared([bidAction(), target])),
      refuse: vi.fn(async () => accounting({
        requested: 2, attempted: 1, succeeded: 1, refused: 1, resyncRequested: 1,
      })),
    });
    const changed = {
      ...authorization,
      constraints: { ...authorization.constraints, max_rows_per_execution: 99 },
    };
    const loadAuthorization = vi.fn()
      .mockResolvedValueOnce(authorization)
      .mockResolvedValueOnce(authorization)
      .mockResolvedValueOnce(authorization)
      .mockResolvedValueOnce(changed);
    const provider = fakeProvider();
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, loadAuthorization, provider, store, now: () => NOW,
    });
    await expect(runtime.apply(job, profile)).resolves.toMatchObject({
      amazonApiCalls: 2, succeeded: 1, refused: 1, observationEnqueued: true,
    });
    expect(provider.updateSpTargetBids).not.toHaveBeenCalled();
  });

  it('never reclassifies a post-provider persistence failure or calls Amazon twice', async () => {
    const provider = fakeProvider();
    const initial = prepared([bidAction()]);
    const store = fakeStore({
      prepare: vi.fn()
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce({
          ...initial,
          rows: [],
          status: 'awaiting_sync' as const,
          replayed: true,
          recoveryObservation: true,
        }),
      recordOutcomes: vi.fn(async () => { throw new Error('synthetic ledger outage'); }),
    });
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });
    await expect(runtime.apply(job, profile)).rejects.toThrow(/ledger outage/i);
    await expect(runtime.apply(job, profile)).resolves.toMatchObject({
      status: 'awaiting_sync',
      replayed: true,
      recoveryObservation: true,
      amazonApiCalls: 0,
      observationEnqueued: true,
    });
    expect(provider.updateSpKeywordBids).toHaveBeenCalledTimes(1);
    expect(store.markDispatched).toHaveBeenCalledTimes(1);
    // markDispatched owns the observation job in the same database transaction;
    // runtime recovery must not create a second, generation-less job.
    expect(store.enqueue).not.toHaveBeenCalled();
    expect(store.refuse).not.toHaveBeenCalled();
    expect(store.releaseForRetry).not.toHaveBeenCalled();
  });

  it('reports an all-failed provider batch without requesting observation', async () => {
    const store = fakeStore();
    const provider = fakeProvider({
      updateSpKeywordBids: vi.fn(async () => ({
        evidence: [{ outcome: 'failed' as const, providerEntityId: null, code: 'INVALID_ARGUMENT', message: 'synthetic' }],
        apiCalls: 1,
      })),
    });
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });
    await expect(runtime.apply(job, profile)).resolves.toMatchObject({
      status: 'failed', attempted: 1, succeeded: 0, failed: 1,
      amazonApiCalls: 2, observationEnqueued: true,
    });
    expect(store.enqueue).not.toHaveBeenCalled();
  });

  it('treats a mismatched provider entity identity as ambiguous and observes it', async () => {
    const store = fakeStore({
      refuse: vi.fn(async () => accounting({
        attempted: 1, succeeded: 0, ambiguous: 1, refused: 0, resyncRequested: 1,
      })),
    });
    const provider = fakeProvider({
      updateSpKeywordBids: vi.fn(async () => ({
        evidence: [accepted('different-keyword')], apiCalls: 1,
      })),
    });
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });
    await expect(runtime.apply(job, profile)).resolves.toMatchObject({
      status: 'awaiting_sync', ambiguous: 1, amazonApiCalls: 2, observationEnqueued: true,
    });
    expect(vi.mocked(store.recordOutcomes).mock.calls[0]?.[0].outcomes[0]?.evidence)
      .toMatchObject({ outcome: 'ambiguous', providerEntityId: null });
  });

  it('records a mismatched provider result as ambiguous and never calls a later mutation group', async () => {
    const target: AmazonWriteAction = {
      actionType: 'sp_target_bid', applyRowId: '77777777-7777-4777-8777-777777777779',
      amazonEntityId: 'target-1', field: 'bid', expectedValue: 0.6,
      requestedValue: 0.61, inverseValue: 0.6,
    };
    const store = fakeStore({
      prepare: vi.fn(async () => prepared([bidAction(), target])),
      refuse: vi.fn(async () => accounting({
        requested: 2, attempted: 1, succeeded: 0, ambiguous: 1,
        refused: 1, resyncRequested: 1,
      })),
    });
    const provider = fakeProvider({
      updateSpKeywordBids: vi.fn(async () => ({
        evidence: [accepted('different-keyword')], apiCalls: 1,
      })),
    });
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });

    await expect(runtime.apply(job, profile)).resolves.toMatchObject({
      status: 'awaiting_sync', attempted: 1, ambiguous: 1, refused: 1,
      amazonApiCalls: 2, observationEnqueued: true,
    });
    expect(provider.updateSpKeywordBids).toHaveBeenCalledTimes(1);
    expect(provider.updateSpTargetBids).not.toHaveBeenCalled();
    expect(store.refuse).toHaveBeenCalledWith(expect.objectContaining({
      reason: expect.stringMatching(/ambiguous/i),
    }));
    expect(store.markDispatched).toHaveBeenCalledTimes(1);
  });

  it('does not call Amazon again when a replay has no unresolved rows', async () => {
    const store = fakeStore({
      prepare: vi.fn(async () => ({ ...prepared([bidAction()]), rows: [], status: 'awaiting_sync' as const, replayed: true })),
    });
    const provider = fakeProvider();
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
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
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
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
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });
    const result = await runtime.apply(job, profile);
    expect(result).toMatchObject({ amazonApiCalls: 2, observationEnqueued: true });
    expect(provider.updateSpTargetBids).not.toHaveBeenCalled();
    expect(store.refuse).toHaveBeenCalledWith(expect.objectContaining({
      reason: expect.stringMatching(/ambiguous/i),
    }));
    expect(store.markDispatched).toHaveBeenCalledTimes(1);
  });

  it('keeps provider calls within one Amazon HTTP batch and reports the exact call count', async () => {
    const actions = Array.from({ length: 100 }, (_unused, index): AmazonWriteAction => ({
      ...bidAction(),
      applyRowId: `55555555-5555-4555-8555-${String(index + 1).padStart(12, '0')}`,
      amazonEntityId: `keyword-${index + 1}`,
    }));
    const store = fakeStore({ prepare: vi.fn(async () => prepared(actions)) });
    const provider = fakeProvider();
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });
    const result = await runtime.apply(job, profile);
    expect(result).toMatchObject({ amazonApiCalls: 2, observationEnqueued: true });
    expect(provider.updateSpKeywordBids).toHaveBeenCalledTimes(1);
    expect(vi.mocked(provider.updateSpKeywordBids).mock.calls.map((call) => call[1].length))
      .toEqual([100]);
  });

  it('coalesces two placement fields on one campaign into one provider mutation', async () => {
    const context = { providerState: {
      strategy: 'auto_for_sales' as const,
      placementBidding: [
        { placement: 'PLACEMENT_PRODUCT_PAGE' as const, percentage: 5 },
        { placement: 'PLACEMENT_REST_OF_SEARCH' as const, percentage: 0 },
        { placement: 'PLACEMENT_TOP' as const, percentage: 20 },
      ],
      shopperCohortBidding: null,
      offAmazonSettings: null,
    } };
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
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });
    await runtime.apply(job, profile);
    expect(provider.updateSpCampaignPlacements).toHaveBeenCalledTimes(1);
    expect(vi.mocked(provider.updateSpCampaignPlacements).mock.calls[0]?.[1]).toEqual([{
      campaignId: 'campaign-1',
      strategy: 'AUTO_FOR_SALES',
      placementBidding: [
        { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 6 },
        { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 0 },
        { placement: 'PLACEMENT_TOP', percentage: 21 },
      ],
    }]);
    expect(vi.mocked(store.recordOutcomes).mock.calls[0]?.[0].outcomes).toHaveLength(2);
  });

  it('counts the targeted observation reads and exact mirror upserts', async () => {
    const action = bidAction();
    const store = fakeStore({
      observationRows: vi.fn(async () => [{
        writeRowId: '66666666-6666-4666-8666-666666666661', action, rowStatus: 'accepted',
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
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });
    const result = await runtime.observe({
      ...job,
      type: 'amazon.observe',
      generation: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      attempt: 0,
    }, profile);
    expect(result).toMatchObject({
      status: 'succeeded', targetedEntities: 1, returnedEntities: 1,
      upsertedEntities: 1, amazonApiCalls: 1, inverseReady: true,
    });
    expect(store.syncEntities).toHaveBeenCalledWith(profile, expect.arrayContaining([
      expect.objectContaining({ amazonId: 'keyword-1', bid: 0.71 }),
    ]), NOW);
  });

  it('does not let a stale observation generation read or advance redispatched rows', async () => {
    const action = bidAction();
    const firstGeneration = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const secondGeneration = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const store = fakeStore({
      observationRows: vi.fn(async (input) => input.generation === firstGeneration ? [] : [{
        writeRowId: '66666666-6666-4666-8666-666666666661', action, rowStatus: 'accepted',
      }]),
    });
    const provider = fakeProvider();
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });

    await expect(runtime.observe({
      ...job, type: 'amazon.observe', generation: firstGeneration, attempt: 0,
    }, profile)).resolves.toMatchObject({ status: 'settled', requested: 0, replayed: true });
    expect(provider.observeSpWriteEntities).not.toHaveBeenCalled();
    expect(store.recordObservations).not.toHaveBeenCalled();

    await runtime.observe({
      ...job, type: 'amazon.observe', generation: secondGeneration, attempt: 0,
    }, profile);
    expect(provider.observeSpWriteEntities).toHaveBeenCalledTimes(1);
    expect(store.observationRows).toHaveBeenNthCalledWith(1, expect.objectContaining({
      generation: firstGeneration,
    }));
    expect(store.observationRows).toHaveBeenNthCalledWith(2, expect.objectContaining({
      generation: secondGeneration,
    }));
  });

  it('turns an exact-entity omission across the observation horizon into a recoverable conflict', async () => {
    const action = bidAction();
    const row = {
      writeRowId: '66666666-6666-4666-8666-666666666661', action, rowStatus: 'accepted',
    };
    const store = fakeStore({
      observationRows: vi.fn(async () => [row]),
      resolveObservation: vi.fn(async (input) => classifyAmazonWriteObservations(input)),
      recordObservations: vi.fn(async (input) => {
        const terminal = input.attempt >= 5;
        expect(input.observations).toEqual([expect.objectContaining({
          writeRowId: row.writeRowId,
          state: terminal ? 'conflict' : 'pending',
          currentValue: null,
        })]);
        return {
          status: terminal ? 'conflict' as const : 'awaiting_sync' as const,
          accounting: accounting({ resynchronized: 0 }),
          pending: terminal ? 0 : 1,
          inverseReady: false,
          retryApply: false,
          applyRequeued: false,
          observationRequeued: input.attempt < 7,
          inverseExecutionId: null,
        };
      }),
    });
    const provider = fakeProvider({
      observeSpWriteEntities: vi.fn(async () => ({
        requested: 1, returned: 0, identityComplete: false, rows: [], apiCalls: 1,
      })),
    });
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });
    const generation = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

    for (let attempt = 0; attempt <= 7; attempt += 1) {
      const result = await runtime.observe({
        ...job, type: 'amazon.observe', generation, attempt,
      }, profile);
      expect(result).toMatchObject({
        status: attempt >= 5 ? 'conflict' : 'awaiting_sync',
        observationIdentityComplete: false,
        upsertedEntities: 0,
        inverseReady: false,
        requeued: attempt < 7,
      });
    }
    expect(store.recordObservations).toHaveBeenCalledTimes(8);
    expect(store.syncEntities).not.toHaveBeenCalled();
    expect(store.enqueue).not.toHaveBeenCalled();
    expect(provider.updateSpKeywordBids).not.toHaveBeenCalled();
    expect(provider.updateSpTargetBids).not.toHaveBeenCalled();
    expect(provider.updateSpCampaignPlacements).not.toHaveBeenCalled();
  });

  it('durably advances a transient observation failure and recovers in the same generation', async () => {
    const action = bidAction();
    const store = fakeStore({
      observationRows: vi.fn(async () => [{
        writeRowId: '66666666-6666-4666-8666-666666666661', action, rowStatus: 'accepted',
      }]),
      resolveObservation: vi.fn(async (input) => classifyAmazonWriteObservations(input)),
      recordObservations: vi.fn()
        .mockResolvedValueOnce({
          status: 'awaiting_sync' as const,
          accounting: accounting({ resynchronized: 0 }),
          pending: 1,
          inverseReady: false,
          retryApply: false,
          applyRequeued: false,
          observationRequeued: true,
          inverseExecutionId: null,
        })
        .mockResolvedValueOnce({
          status: 'succeeded' as const,
          accounting: accounting({ resynchronized: 1 }),
          pending: 0,
          inverseReady: true,
          retryApply: false,
          applyRequeued: false,
          observationRequeued: false,
          inverseExecutionId: '99999999-9999-4999-8999-999999999999',
        }),
    });
    const successful = vi.mocked(fakeProvider().observeSpWriteEntities).getMockImplementation();
    if (!successful) throw new Error('synthetic observation implementation is missing');
    const provider = fakeProvider({
      observeSpWriteEntities: vi.fn()
        .mockRejectedValueOnce(new AdsApiRetryableError('synthetic read throttle', 3))
        .mockImplementation(successful),
    });
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });
    const payload = {
      ...job, type: 'amazon.observe' as const,
      generation: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', attempt: 0,
    };

    await expect(runtime.observe(payload, profile)).resolves.toMatchObject({
      status: 'awaiting_sync', observationIdentityComplete: false,
      observationError: expect.stringMatching(/synthetic read throttle/i),
      requeued: true, inverseReady: false,
    });
    await expect(runtime.observe({ ...payload, attempt: 1 }, profile)).resolves.toMatchObject({
      status: 'succeeded', observationIdentityComplete: true,
      amazonApiCalls: 1, inverseReady: true,
    });
    expect(provider.observeSpWriteEntities).toHaveBeenCalledTimes(2);
    expect(store.recordObservations).toHaveBeenCalledTimes(2);
    expect(store.enqueue).not.toHaveBeenCalled();
  });

  it('queues one generation-bound long-tail reconciliation after a final conflict', async () => {
    const action = bidAction();
    const store = fakeStore({
      observationRows: vi.fn(async () => [{
        writeRowId: '66666666-6666-4666-8666-666666666661', action, rowStatus: 'accepted',
      }]),
      resolveObservation: vi.fn(async () => [{
        writeRowId: '66666666-6666-4666-8666-666666666661',
        state: 'conflict' as const,
        currentValue: 0.72,
      }]),
      recordObservations: vi.fn()
        .mockResolvedValueOnce({
          status: 'conflict' as const,
          accounting: accounting({ resynchronized: 0 }),
          pending: 0,
          inverseReady: false,
          retryApply: false,
          applyRequeued: false,
          observationRequeued: true,
          inverseExecutionId: null,
        })
        .mockResolvedValueOnce({
          status: 'succeeded' as const,
          accounting: accounting({ resynchronized: 1 }),
          pending: 0,
          inverseReady: true,
          retryApply: false,
          applyRequeued: false,
          observationRequeued: false,
          inverseExecutionId: '99999999-9999-4999-8999-999999999999',
        }),
    });
    const provider = fakeProvider();
    const runtime = new GuardedAmazonWriteRuntime({
      enabled: true, loadAuthorization: async () => authorization, provider, store, now: () => NOW,
    });
    const generation = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await expect(runtime.observe({
      ...job, type: 'amazon.observe', generation, attempt: 5,
    }, profile)).resolves.toMatchObject({ status: 'conflict', requeued: true });
    await expect(runtime.observe({
      ...job, type: 'amazon.observe', generation, attempt: 6,
    }, profile)).resolves.toMatchObject({ status: 'succeeded', inverseReady: true });
    expect(store.enqueue).not.toHaveBeenCalled();
  });
});
