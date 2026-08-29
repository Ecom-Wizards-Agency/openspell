import { z } from 'zod';
import { CampaignWriteContext } from './entities.js';
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

function requireCurrencyMinorUnits(
  value: { expectedValue: number; requestedValue: number; inverseValue: number },
  context: z.RefinementCtx,
): void {
  for (const field of ['expectedValue', 'requestedValue', 'inverseValue'] as const) {
    const scaled = value[field] * 100;
    if (Math.abs(scaled - Math.round(scaled)) > 1e-8) {
      context.addIssue({
        code: 'custom',
        path: [field],
        message: 'Sponsored Products bids require exact currency-minor-unit precision',
      });
    }
  }
}

export const SpKeywordBidWriteAction = z.object({
  ...numericAction,
  actionType: z.literal(AmazonWriteActionType.enum.sp_keyword_bid),
  field: z.literal('bid'),
}).superRefine(requireCurrencyMinorUnits);

export const SpTargetBidWriteAction = z.object({
  ...numericAction,
  actionType: z.literal(AmazonWriteActionType.enum.sp_target_bid),
  field: z.literal('bid'),
}).superRefine(requireCurrencyMinorUnits);

/**
 * Placement writes replace a campaign's complete dynamic-bidding object. The
 * approval therefore freezes the strategy and all three placement values, not
 * only the changed field, so execution cannot erase an unrelated modifier.
 */
export const SpCampaignPlacementWriteAction = z.object({
  applyRowId: Uuid,
  amazonEntityId: AmazonId,
  expectedValue: z.number().int().min(0).max(900),
  requestedValue: z.number().int().min(0).max(900),
  inverseValue: z.number().int().min(0).max(900),
  actionType: z.literal(AmazonWriteActionType.enum.sp_campaign_placement),
  field: AmazonPlacementField,
  campaignContext: z.object({
    providerState: CampaignWriteContext,
  }).strict(),
});

export const AmazonWriteAction = z.discriminatedUnion('actionType', [
  SpKeywordBidWriteAction,
  SpTargetBidWriteAction,
  SpCampaignPlacementWriteAction,
]);
export type AmazonWriteAction = z.infer<typeof AmazonWriteAction>;

export const AmazonWriteApprovalMode = z.enum(['manual', 'bounded_live_test']);
export type AmazonWriteApprovalMode = z.infer<typeof AmazonWriteApprovalMode>;

export const AmazonWriteExecutionDirection = z.enum(['forward', 'inverse']);
export type AmazonWriteExecutionDirection = z.infer<typeof AmazonWriteExecutionDirection>;

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
  'dispatched',
  'retryable',
  'accepted',
  'failed',
  'refused',
  'ambiguous',
]);
export type AmazonWriteRowStatus = z.infer<typeof AmazonWriteRowStatus>;

export const AmazonWriteObservationStatus = z.enum([
  'pending',
  'not_applied',
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

export const AmazonWriteProviderCallOutcome = z.enum([
  'accepted',
  'mixed',
  'throttled',
  'rejected',
  'ambiguous',
]);
export type AmazonWriteProviderCallOutcome = z.infer<typeof AmazonWriteProviderCallOutcome>;

export const AmazonWriteProviderCallEventType = z.enum(['dispatch', 'result']);
export type AmazonWriteProviderCallEventType = z.infer<typeof AmazonWriteProviderCallEventType>;

/** Sanitized completion evidence for one outbound Amazon mutation request. */
export const AmazonWriteProviderCallEvidence = z.object({
  outcome: AmazonWriteProviderCallOutcome,
  requested: z.number().int().positive().max(100),
  accepted: z.number().int().nonnegative().max(100),
  failed: z.number().int().nonnegative().max(100),
  code: z.string().max(160).nullable(),
  message: z.string().max(512).nullable(),
}).superRefine((value, context) => {
  if (value.accepted + value.failed > value.requested) {
    context.addIssue({ code: 'custom', message: 'provider completion exceeds requested rows' });
  }
  if (['accepted', 'mixed', 'rejected'].includes(value.outcome)
    && value.accepted + value.failed !== value.requested) {
    context.addIssue({ code: 'custom', message: 'deterministic provider completion must account for every row' });
  }
  if (value.outcome === 'accepted'
    && (value.accepted !== value.requested || value.failed !== 0)) {
    context.addIssue({ code: 'custom', message: 'accepted provider completion must accept every row' });
  }
  if (value.outcome === 'mixed' && (value.accepted === 0 || value.failed === 0)) {
    context.addIssue({ code: 'custom', message: 'mixed provider completion requires accepted and failed rows' });
  }
  if (value.outcome === 'rejected'
    && (value.accepted !== 0 || value.failed !== value.requested)) {
    context.addIssue({ code: 'custom', message: 'rejected provider completion must fail every row' });
  }
  if (value.outcome === 'throttled' && (value.accepted !== 0 || value.failed !== 0)) {
    context.addIssue({ code: 'custom', message: 'throttled provider completion cannot classify rows' });
  }
});
export type AmazonWriteProviderCallEvidence = z.infer<typeof AmazonWriteProviderCallEvidence>;

/**
 * Operator-supplied approval facts. The approval boundary derives the actor
 * and approval timestamp from the authenticated database session; accepting
 * either value from request JSON would permit service-role actor spoofing.
 */
export const ApproveAmazonWriteExecution = z.object({
  orgId: Uuid,
  profileId: Uuid,
  applyBatchId: Uuid,
  approvalMode: AmazonWriteApprovalMode,
  expiresAt: z.iso.datetime(),
  previewSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expectedCount: z.number().int().positive(),
  authorizationId: Uuid.nullable().default(null),
  authorizationSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  /** Stored for a bounded test; it never bypasses the synchronized-state gate. */
  inversePreapproved: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (value.approvalMode === 'manual' && value.inversePreapproved) {
    context.addIssue({
      code: 'custom',
      path: ['inversePreapproved'],
      message: 'manual writes require a fresh inverse approval',
    });
  }
  if (value.approvalMode === 'manual' && value.authorizationId !== null) {
    context.addIssue({ code: 'custom', path: ['authorizationId'], message: 'manual approval cannot use a bounded authorization' });
  }
  if (value.approvalMode === 'manual' && value.authorizationSha256 !== null) {
    context.addIssue({ code: 'custom', path: ['authorizationSha256'], message: 'manual approval cannot use a bounded authorization fingerprint' });
  }
  if (value.approvalMode === 'bounded_live_test' && value.authorizationId === null) {
    context.addIssue({ code: 'custom', path: ['authorizationId'], message: 'bounded live tests require an authorization ID' });
  }
  if (value.approvalMode === 'bounded_live_test' && value.authorizationSha256 === null) {
    context.addIssue({ code: 'custom', path: ['authorizationSha256'], message: 'bounded live tests require an authorization fingerprint' });
  }
});
export type ApproveAmazonWriteExecution = z.infer<typeof ApproveAmazonWriteExecution>;

export const AuthorizedAmazonWriteEntity = z.discriminatedUnion('action_type', [
  z.object({
    action_type: z.literal('sp_keyword_bid'),
    amazon_entity_id: AmazonId,
    field: z.literal('bid'),
  }).strict(),
  z.object({
    action_type: z.literal('sp_target_bid'),
    amazon_entity_id: AmazonId,
    field: z.literal('bid'),
  }).strict(),
  z.object({
    action_type: z.literal('sp_campaign_placement'),
    amazon_entity_id: AmazonId,
    field: AmazonPlacementField,
  }).strict(),
]);
export type AuthorizedAmazonWriteEntity = z.infer<typeof AuthorizedAmazonWriteEntity>;

/** Gitignored operator authorization file; values never belong in source. */
export const BoundedAmazonWriteAuthorization = z.object({
  schema: z.literal('openspell.amazon-write-authorization.v1'),
  authorization_id: Uuid,
  expires_at: z.iso.datetime(),
  profiles: z.array(z.object({
    org_id: Uuid,
    profile_id: Uuid,
    account_label: z.string().min(1),
    marketplace: z.string().min(2).max(32),
    allowed_entities: z.array(AuthorizedAmazonWriteEntity).min(1),
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
    max_rows_per_execution: z.number().int().positive().max(100),
    max_total_executions: z.number().int().positive().max(100),
    require_current_value_match: z.literal(true),
    require_amazon_acceptance: z.literal(true),
    require_sync_observation_before_inverse: z.literal(true),
    stop_on_conflict: z.literal(true),
  }),
}).superRefine((value, context) => {
  const requiresInverse = (value.allowed_tests.bid.enabled
      && value.allowed_tests.bid.require_immediate_inverse)
    || (value.allowed_tests.placement.enabled
      && value.allowed_tests.placement.require_immediate_inverse)
    || (value.allowed_tests.cadence.enabled
      && value.allowed_tests.cadence.require_immediate_inverse);
  if (requiresInverse && value.constraints.max_total_executions < 2) {
    context.addIssue({
      code: 'custom',
      path: ['constraints', 'max_total_executions'],
      message: 'immediate inverse requires at least two reserved execution slots',
    });
  }
});
export type BoundedAmazonWriteAuthorization = z.infer<typeof BoundedAmazonWriteAuthorization>;
