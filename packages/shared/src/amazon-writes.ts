import { z } from 'zod';
import { BiddingStrategy, PlacementBidding } from './entities.js';
import { AmazonId, Uuid } from './primitives.js';

/** Mutation classes implemented by the first guarded worker gateway. */
export const AmazonWriteActionType = z.enum([
  'sp_keyword_bid',
  'sp_target_bid',
  'sp_campaign_placement',
]);
export type AmazonWriteActionType = z.infer<typeof AmazonWriteActionType>;

export const AmazonPlacementField = z.enum([
  'top_of_search',
  'product_pages',
  'rest_of_search',
]);
export type AmazonPlacementField = z.infer<typeof AmazonPlacementField>;

const numericAction = {
  applyRowId: Uuid,
  amazonEntityId: AmazonId,
  expectedValue: z.number().finite(),
  requestedValue: z.number().finite(),
  inverseValue: z.number().finite(),
};

export const SpKeywordBidWriteAction = z.object({
  ...numericAction,
  actionType: z.literal(AmazonWriteActionType.enum.sp_keyword_bid),
  field: z.literal('bid'),
});

export const SpTargetBidWriteAction = z.object({
  ...numericAction,
  actionType: z.literal(AmazonWriteActionType.enum.sp_target_bid),
  field: z.literal('bid'),
});

/**
 * Placement writes replace a campaign's complete dynamic-bidding object. The
 * approval therefore freezes the strategy and all three placement values, not
 * only the changed field, so execution cannot erase an unrelated modifier.
 */
export const SpCampaignPlacementWriteAction = z.object({
  ...numericAction,
  actionType: z.literal(AmazonWriteActionType.enum.sp_campaign_placement),
  field: AmazonPlacementField,
  campaignContext: z.object({
    strategy: BiddingStrategy,
    placementBidding: PlacementBidding,
  }),
});

export const AmazonWriteAction = z.discriminatedUnion('actionType', [
  SpKeywordBidWriteAction,
  SpTargetBidWriteAction,
  SpCampaignPlacementWriteAction,
]);
export type AmazonWriteAction = z.infer<typeof AmazonWriteAction>;

export const AmazonWriteApprovalMode = z.enum(['manual', 'bounded_live_test']);
export type AmazonWriteApprovalMode = z.infer<typeof AmazonWriteApprovalMode>;

export const AmazonWriteExecutionStatus = z.enum([
  'queued',
  'running',
  'awaiting_sync',
  'succeeded',
  'partial',
  'refused',
  'failed',
  'conflict',
]);
export type AmazonWriteExecutionStatus = z.infer<typeof AmazonWriteExecutionStatus>;

export const AmazonWriteRowStatus = z.enum([
  'pending',
  'retryable',
  'accepted',
  'failed',
  'refused',
  'ambiguous',
]);
export type AmazonWriteRowStatus = z.infer<typeof AmazonWriteRowStatus>;

export const AmazonWriteObservationStatus = z.enum([
  'pending',
  'observed',
  'conflict',
]);
export type AmazonWriteObservationStatus = z.infer<typeof AmazonWriteObservationStatus>;

const count = z.number().int().nonnegative();

/** Counts are snapshots and remain valid while an execution is in progress. */
export const AmazonWriteAccounting = z.object({
  requested: count,
  attempted: count,
  succeeded: count,
  failed: count,
  ambiguous: count,
  refused: count,
  resyncRequested: count,
  resynchronized: count,
}).superRefine((value, context) => {
  if (value.attempted + value.refused > value.requested) {
    context.addIssue({ code: 'custom', message: 'attempted plus refused cannot exceed requested' });
  }
  if (value.succeeded + value.failed + value.ambiguous > value.attempted) {
    context.addIssue({ code: 'custom', message: 'succeeded plus failed plus ambiguous cannot exceed attempted' });
  }
  if (value.resynchronized > value.succeeded) {
    context.addIssue({ code: 'custom', message: 'resynchronized cannot exceed provider successes' });
  }
});
export type AmazonWriteAccounting = z.infer<typeof AmazonWriteAccounting>;

/** Deliberately excludes raw provider bodies and request headers. */
export const AmazonWriteProviderEvidence = z.object({
  outcome: z.enum(['accepted', 'failed', 'retryable', 'ambiguous']),
  providerEntityId: AmazonId.nullable(),
  code: z.string().max(160).nullable(),
  message: z.string().max(512).nullable(),
});
export type AmazonWriteProviderEvidence = z.infer<typeof AmazonWriteProviderEvidence>;

/** Input to the service-role approval transaction used by the future web route. */
export const ApproveAmazonWriteExecution = z.object({
  orgId: Uuid,
  profileId: Uuid,
  applyBatchId: Uuid,
  approvedBy: Uuid,
  approvalMode: AmazonWriteApprovalMode,
  approvedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  previewSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expectedCount: z.number().int().positive(),
  idempotencyKey: z.string().regex(/^[a-f0-9]{64}$/),
  /** Stored for a bounded test; it never bypasses the synchronized-state gate. */
  inversePreapproved: z.boolean().default(false),
}).superRefine((value, context) => {
  if (value.approvalMode === 'manual' && value.inversePreapproved) {
    context.addIssue({
      code: 'custom',
      path: ['inversePreapproved'],
      message: 'manual writes require a fresh inverse approval',
    });
  }
});
export type ApproveAmazonWriteExecution = z.infer<typeof ApproveAmazonWriteExecution>;

/** Gitignored operator authorization file; values never belong in source. */
export const BoundedAmazonWriteAuthorization = z.object({
  schema: z.literal('openspell.amazon-write-authorization.v1'),
  expires_at: z.iso.datetime(),
  profiles: z.array(z.object({
    account_label: z.string().min(1),
    marketplace: z.string().min(2).max(32),
  })).min(1),
  allowed_tests: z.object({
    bid: z.object({
      enabled: z.boolean(),
      max_absolute_delta: z.number().positive(),
      require_immediate_inverse: z.boolean(),
    }),
    placement: z.object({
      enabled: z.boolean(),
      max_absolute_percentage_points: z.number().int().positive(),
      require_immediate_inverse: z.boolean(),
    }),
    cadence: z.object({
      enabled: z.boolean(),
      max_executions: z.number().int().nonnegative(),
      disable_after_test: z.boolean(),
      require_immediate_inverse: z.boolean(),
    }),
  }),
  constraints: z.object({
    max_concurrent_mutations: z.number().int().positive(),
    require_current_value_match: z.literal(true),
    require_amazon_acceptance: z.literal(true),
    require_sync_observation_before_inverse: z.literal(true),
    stop_on_conflict: z.literal(true),
  }),
});
export type BoundedAmazonWriteAuthorization = z.infer<typeof BoundedAmazonWriteAuthorization>;
