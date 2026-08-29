import { describe, expect, it } from 'vitest';
import {
  ApproveAmazonWriteExecution,
  AmazonWriteAccounting,
  AmazonWriteAction,
  AmazonWriteProviderCallEvidence,
  BoundedAmazonWriteAuthorization,
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

  it('parses the gitignored bounded authorization shape and requires fail-closed constraints', () => {
    const authorization = BoundedAmazonWriteAuthorization.parse({
      schema: 'openspell.amazon-write-authorization.v1',
      authorization_id: '99999999-9999-4999-8999-999999999999',
      expires_at: '2026-09-01T00:00:00.000Z',
      profiles: [{
        org_id: ROW_ID,
        profile_id: '22222222-2222-4222-8222-222222222222',
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
      constraints: { ...authorization.constraints, stop_on_conflict: false },
    })).toThrow();
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
