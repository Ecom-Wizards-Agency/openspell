import { describe, expect, it } from 'vitest';
import {
  ApproveAmazonWriteExecution,
  AmazonWriteAccounting,
  AmazonWriteAction,
  AmazonWriteProviderCallEvidence,
  BoundedAmazonWriteAuthorization,
  serializeAmazonWriteProviderCallFingerprint,
} from './amazon-writes.js';

const ROW_ID = '11111111-1111-4111-8111-111111111111';

describe('guarded Amazon write contracts', () => {
  it.each(['sp_keyword_bid', 'sp_target_bid'] as const)(
    'refuses fractional currency-minor units for %s',
    (actionType) => {
      expect(() => AmazonWriteAction.parse({
        actionType,
        applyRowId: ROW_ID,
        amazonEntityId: 'entity-1',
        field: 'bid',
        expectedValue: 0.901,
        requestedValue: 0.914,
        inverseValue: 0.901,
      })).toThrow(/currency-minor-unit/i);
    },
  );

  it('freezes the complete placement context beside the exact inverse', () => {
    const action = AmazonWriteAction.parse({
      actionType: 'sp_campaign_placement',
      applyRowId: ROW_ID,
      amazonEntityId: 'campaign-1',
      field: 'top_of_search',
      expectedValue: 20,
      requestedValue: 21,
      inverseValue: 20,
      campaignContext: {
        providerState: {
          strategy: 'auto_for_sales',
          placementBidding: [
            { placement: 'PLACEMENT_TOP', percentage: 20 },
            { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 5 },
            { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 0 },
          ],
          shopperCohortBidding: null,
          offAmazonSettings: null,
        },
      },
    });
    expect(action.actionType).toBe('sp_campaign_placement');
    if (action.actionType !== 'sp_campaign_placement') throw new Error('expected placement action');
    expect(action.campaignContext.providerState.placementBidding[1]?.percentage).toBe(5);
    expect(action.inverseValue).toBe(20);
  });

  it.each([-1, 20.5, 901])(
    'refuses unsupported placement percentage %s at the authoritative contract',
    (requestedValue) => {
      expect(() => AmazonWriteAction.parse({
        actionType: 'sp_campaign_placement',
        applyRowId: ROW_ID,
        amazonEntityId: 'campaign-1',
        field: 'top_of_search',
        expectedValue: 20,
        requestedValue,
        inverseValue: 20,
        campaignContext: {
          providerState: {
            strategy: 'auto_for_sales', placementBidding: [],
            shopperCohortBidding: null, offAmazonSettings: null,
          },
        },
      })).toThrow();
    },
  );

  it('rejects accounting that loses a requested row', () => {
    expect(() => AmazonWriteAccounting.parse({
      requested: 1,
      attempted: 1,
      succeeded: 1,
      failed: 0,
      ambiguous: 0,
      refused: 1,
      resyncRequested: 1,
      resynchronized: 0,
    })).toThrow(/attempted plus refused/i);
  });

  it('requires exact provider call outcome counts', () => {
    expect(() => AmazonWriteProviderCallEvidence.parse({
      outcome: 'accepted', requested: 2, accepted: 1, failed: 1,
      code: null, message: null,
    })).toThrow(/accept every row/i);
    expect(() => AmazonWriteProviderCallEvidence.parse({
      outcome: 'mixed', requested: 2, accepted: 2, failed: 0,
      code: null, message: null,
    })).toThrow(/accepted and failed/i);
    expect(() => AmazonWriteProviderCallEvidence.parse({
      outcome: 'throttled', requested: 1, accepted: 0, failed: 1,
      code: null, message: null,
    })).toThrow(/cannot classify rows/i);
  });

  it('binds a provider call fingerprint to exact, order-independent row membership', () => {
    const executionId = '22222222-2222-4222-8222-222222222222';
    const callId = '33333333-3333-4333-8333-333333333333';
    const actions = [
      AmazonWriteAction.parse({
        actionType: 'sp_campaign_placement',
        applyRowId: '44444444-4444-4444-8444-444444444444',
        amazonEntityId: 'campaign-1', field: 'top_of_search',
        expectedValue: 20, requestedValue: 21, inverseValue: 20,
        campaignContext: {
          providerState: {
            strategy: 'auto_for_sales', placementBidding: [],
            shopperCohortBidding: null, offAmazonSettings: null,
          },
        },
      }),
      AmazonWriteAction.parse({
        actionType: 'sp_campaign_placement',
        applyRowId: '55555555-5555-4555-8555-555555555555',
        amazonEntityId: 'campaign-1', field: 'product_pages',
        expectedValue: 5, requestedValue: 6, inverseValue: 5,
        campaignContext: {
          providerState: {
            strategy: 'auto_for_sales', placementBidding: [],
            shopperCohortBidding: null, offAmazonSettings: null,
          },
        },
      }),
    ];
    const canonical = serializeAmazonWriteProviderCallFingerprint({
      executionId, callId, providerOperation: 'sp_campaign_placement',
      requestedEntityIds: ['campaign-1'], actions,
    });
    expect(serializeAmazonWriteProviderCallFingerprint({
      executionId, callId, providerOperation: 'sp_campaign_placement',
      requestedEntityIds: ['campaign-1'], actions: [...actions].reverse(),
    })).toBe(canonical);
    expect(() => serializeAmazonWriteProviderCallFingerprint({
      executionId, callId, providerOperation: 'sp_campaign_placement',
      requestedEntityIds: ['campaign-1', 'campaign-1'], actions,
    })).toThrow(/repeats an Amazon entity identity/i);
    expect(() => serializeAmazonWriteProviderCallFingerprint({
      executionId, callId, providerOperation: 'sp_campaign_placement',
      requestedEntityIds: ['campaign-2'], actions,
    })).toThrow(/do not match/i);
  });

  it('parses the gitignored bounded authorization shape and requires fail-closed constraints', () => {
    const authorization = BoundedAmazonWriteAuthorization.parse({
      schema: 'openspell.amazon-write-authorization.v1',
      authorization_id: '99999999-9999-4999-8999-999999999999',
      expires_at: '2026-09-01T00:00:00.000Z',
      profiles: [{
        org_id: ROW_ID,
        profile_id: '22222222-2222-4222-8222-222222222222',
        amazon_profile_id: 'amazon-profile-1',
        connection_id: '33333333-3333-4333-8333-333333333333',
        region: 'NA',
        account_label: 'Synthetic account',
        marketplace: 'US',
        allowed_entities: [{ action_type: 'sp_keyword_bid', amazon_entity_id: 'keyword-1', field: 'bid' }],
      }],
      allowed_tests: {
        bid: { enabled: true, max_absolute_delta: 0.01, require_immediate_inverse: true },
        placement: { enabled: true, max_absolute_percentage_points: 1, require_immediate_inverse: true },
        cadence: { enabled: false, max_executions: 0, disable_after_test: true, require_immediate_inverse: true },
      },
      constraints: {
        max_concurrent_mutations: 1,
        max_rows_per_execution: 1,
        max_total_executions: 2,
        require_current_value_match: true,
        require_amazon_acceptance: true,
        require_sync_observation_before_inverse: true,
        stop_on_conflict: true,
      },
    });
    expect(authorization.allowed_tests.bid.max_absolute_delta).toBe(0.01);
    expect(() => BoundedAmazonWriteAuthorization.parse({
      ...authorization,
      constraints: { ...authorization.constraints, max_total_executions: 1 },
    })).toThrow(/two reserved execution slots/i);
    expect(() => BoundedAmazonWriteAuthorization.parse({
      ...authorization,
      constraints: { ...authorization.constraints, max_concurrent_mutations: 2 },
    })).toThrow();
    expect(() => BoundedAmazonWriteAuthorization.parse({
      ...authorization,
      constraints: { ...authorization.constraints, stop_on_conflict: false },
    })).toThrow();
    expect(() => BoundedAmazonWriteAuthorization.parse({
      ...authorization,
      allowed_tests: {
        ...authorization.allowed_tests,
        bid: { ...authorization.allowed_tests.bid, require_immediate_inverse: false },
      },
    })).toThrow(/immediate exact inverse/i);
    expect(() => BoundedAmazonWriteAuthorization.parse({
      ...authorization,
      unrecognized_safety_switch: true,
    })).toThrow(/unrecognized/i);
    expect(() => BoundedAmazonWriteAuthorization.parse({
      ...authorization,
      profiles: [{ ...authorization.profiles[0], assumed_profile_binding: true }],
    })).toThrow(/unrecognized/i);
    expect(() => BoundedAmazonWriteAuthorization.parse({
      ...authorization,
      allowed_tests: {
        ...authorization.allowed_tests,
        bid: { ...authorization.allowed_tests.bid, assumed_rounding: 'safe' },
      },
    })).toThrow(/unrecognized/i);
    expect(() => BoundedAmazonWriteAuthorization.parse({
      ...authorization,
      profiles: [authorization.profiles[0]!, authorization.profiles[0]!],
    })).toThrow(/repeats an internal profile/i);
    expect(() => BoundedAmazonWriteAuthorization.parse({
      ...authorization,
      profiles: [{
        ...authorization.profiles[0]!,
        allowed_entities: [
          authorization.profiles[0]!.allowed_entities[0]!,
          authorization.profiles[0]!.allowed_entities[0]!,
        ],
      }],
    })).toThrow(/repeats an exact entity field/i);
  });

  it('allows inverse preapproval only for a bounded live-test cycle', () => {
    const base = {
      orgId: ROW_ID,
      profileId: '22222222-2222-4222-8222-222222222222',
      applyBatchId: '33333333-3333-4333-8333-333333333333',
      expiresAt: '2026-08-29T13:00:00.000Z',
      previewSha256: 'a'.repeat(64),
      expectedCount: 1,
      authorizationId: '99999999-9999-4999-8999-999999999999',
      authorizationSha256: 'b'.repeat(64),
      authorizationSnapshot: {
        schema: 'openspell.amazon-write-authorization.v1' as const,
        authorization_id: '99999999-9999-4999-8999-999999999999',
        expires_at: '2026-08-29T13:00:00.000Z',
        profiles: [{
          org_id: ROW_ID,
          profile_id: '22222222-2222-4222-8222-222222222222',
          amazon_profile_id: 'amazon-profile-1',
          connection_id: '33333333-3333-4333-8333-333333333333',
          region: 'NA' as const,
          account_label: 'Synthetic account', marketplace: 'US',
          allowed_entities: [{
            action_type: 'sp_keyword_bid' as const,
            amazon_entity_id: 'keyword-1', field: 'bid' as const,
          }],
        }],
        allowed_tests: {
          bid: { enabled: true, max_absolute_delta: 0.01, require_immediate_inverse: true },
          placement: { enabled: false, max_absolute_percentage_points: 1, require_immediate_inverse: true },
          cadence: { enabled: false, max_executions: 0, disable_after_test: true, require_immediate_inverse: true },
        },
        constraints: {
          max_concurrent_mutations: 1 as const,
          max_rows_per_execution: 1,
          max_total_executions: 2,
          require_current_value_match: true as const,
          require_amazon_acceptance: true as const,
          require_sync_observation_before_inverse: true as const,
          stop_on_conflict: true as const,
        },
      },
      inversePreapproved: true,
    };
    expect(() => ApproveAmazonWriteExecution.parse({ ...base, approvalMode: 'manual' }))
      .toThrow(/fresh inverse approval/i);
    expect(ApproveAmazonWriteExecution.parse({ ...base, approvalMode: 'bounded_live_test' }))
      .toMatchObject({ inversePreapproved: true });
    expect(() => ApproveAmazonWriteExecution.parse({
      ...base,
      approvalMode: 'bounded_live_test',
      approvedBy: '44444444-4444-4444-8444-444444444444',
    })).toThrow();
  });
});
