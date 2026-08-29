/** Persistent optimization group and observation-loop contracts. */
import { z } from 'zod';
import { ApplyEntityType, ApplyValue } from './apply.js';
import { AmazonId, IsoDate, Uuid } from './primitives.js';

export const OptimizationGroupRole = z.enum(['rank', 'discovery', 'profit', 'shield']);
export type OptimizationGroupRole = z.infer<typeof OptimizationGroupRole>;

export const OptimizationPrioritization = z.enum([
  'efficiency_first',
  'growth_first',
  'balanced',
]);
export type OptimizationPrioritization = z.infer<typeof OptimizationPrioritization>;

export const OptimizationWeekday = z.enum([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]);
export type OptimizationWeekday = z.infer<typeof OptimizationWeekday>;

export const OptimizationReviewSchedule = z.object({
  weekdays: z.array(OptimizationWeekday).min(1).superRefine((weekdays, context) => {
    if (new Set(weekdays).size !== weekdays.length) {
      context.addIssue({ code: 'custom', message: 'review weekdays must be unique' });
    }
  }),
  /** Profile-local wall-clock time in 24-hour HH:mm form. */
  localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
}).transform((schedule) => ({
  ...schedule,
  weekdays: [...schedule.weekdays].sort(
    (left, right) => OptimizationWeekday.options.indexOf(left) - OptimizationWeekday.options.indexOf(right),
  ),
}));
export type OptimizationReviewSchedule = z.infer<typeof OptimizationReviewSchedule>;

export const OptimizationScheduleMigrationState = z.enum([
  'native',
  'legacy_supported',
  'needs_review',
]);
export type OptimizationScheduleMigrationState = z.infer<
  typeof OptimizationScheduleMigrationState
>;

export const RecommendationRunTrigger = z.enum(['manual', 'schedule']);
export type RecommendationRunTrigger = z.infer<typeof RecommendationRunTrigger>;

/** Immutable local-schedule evidence captured when a group preview is queued. */
export const RecommendationScheduleContext = z.object({
  trigger: RecommendationRunTrigger,
  profileTimezone: z.string().trim().min(1),
  reviewSchedule: OptimizationReviewSchedule.nullable(),
  scheduleEnabled: z.boolean(),
  queuedAt: z.iso.datetime(),
  scheduledFor: z.iso.datetime().nullable(),
}).superRefine((value, context) => {
  if (value.trigger === 'schedule' && value.scheduledFor === null) {
    context.addIssue({
      code: 'custom',
      path: ['scheduledFor'],
      message: 'scheduled previews require their claimed occurrence',
    });
  }
  if (value.trigger === 'schedule' && value.reviewSchedule === null) {
    context.addIssue({
      code: 'custom',
      path: ['reviewSchedule'],
      message: 'scheduled previews require a review schedule snapshot',
    });
  }
  if (value.trigger === 'schedule' && !value.scheduleEnabled) {
    context.addIssue({
      code: 'custom',
      path: ['scheduleEnabled'],
      message: 'scheduled previews require an enabled review schedule',
    });
  }
  if (value.trigger === 'manual' && value.scheduledFor !== null) {
    context.addIssue({
      code: 'custom',
      path: ['scheduledFor'],
      message: 'manual previews cannot claim a scheduled occurrence',
    });
  }
});
export type RecommendationScheduleContext = z.infer<typeof RecommendationScheduleContext>;

/** Values are tenant data. This contract intentionally supplies no numeric defaults. */
export const OptimizationGroup = z.object({
  id: Uuid,
  orgId: Uuid,
  profileId: Uuid,
  name: z.string().trim().min(1),
  role: OptimizationGroupRole,
  targetAcos: z.number().nonnegative(),
  bidFloor: z.number().nonnegative().nullable(),
  bidCeiling: z.number().nonnegative().nullable(),
  bidIncreaseCap: z.number().nonnegative(),
  bidDecreaseCap: z.number().nonnegative(),
  placementIncreaseCap: z.number().nonnegative(),
  placementDecreaseCap: z.number().nonnegative(),
  exclusions: z.array(z.string().min(1)),
  /** Rollback-only interval retained while weekday scheduling is adopted. */
  cadence: z.string().min(1),
  reviewSchedule: OptimizationReviewSchedule.nullable().default(null),
  scheduleMigrationState: OptimizationScheduleMigrationState.default('needs_review'),
  prioritization: OptimizationPrioritization,
  /** Scheduled preview eligibility only; manual group previews remain available. */
  enabled: z.boolean(),
});
export type OptimizationGroup = z.infer<typeof OptimizationGroup>;

export const CampaignOptimizationAssignment = z.object({
  profileId: Uuid,
  campaignId: AmazonId,
  groupId: Uuid,
  assignedAt: z.iso.datetime(),
  assignedBy: Uuid.nullable(),
});
export type CampaignOptimizationAssignment = z.infer<typeof CampaignOptimizationAssignment>;

export const OptimizationRunContext = z.object({
  runId: Uuid,
  profileId: Uuid,
  groupId: Uuid,
  groupRole: OptimizationGroupRole,
  groupSnapshot: OptimizationGroup,
  dueAt: z.iso.datetime(),
  windowStart: IsoDate,
  windowEnd: IsoDate,
});
export type OptimizationRunContext = z.infer<typeof OptimizationRunContext>;

export const RecommendationEvidenceState = z.enum([
  'awaiting_sync',
  'observing',
  'complete',
  'insufficient',
  'conflict',
]);
export type RecommendationEvidenceState = z.infer<typeof RecommendationEvidenceState>;

export const RecommendationEvidenceDecision = z.enum(['hold', 'continue', 'revert']);
export type RecommendationEvidenceDecision = z.infer<typeof RecommendationEvidenceDecision>;

export const RecommendationObservation = z.object({
  id: Uuid.optional(),
  recommendationId: Uuid,
  priorRecommendationId: Uuid.nullable(),
  groupId: Uuid,
  expectedValue: z.number(),
  synchronizedValue: z.number().nullable(),
  synchronizedAt: z.iso.datetime().nullable(),
  observationWindowStart: IsoDate,
  observationWindowEnd: IsoDate,
  evidenceState: RecommendationEvidenceState,
  decision: RecommendationEvidenceDecision,
  preIncrementalVolume: z.number().nonnegative().nullable(),
  postIncrementalVolume: z.number().nonnegative().nullable(),
  evidenceNote: z.string().min(1),
});
export type RecommendationObservation = z.infer<typeof RecommendationObservation>;

export const DirectionalAdjustmentProvenance = z.object({
  requestedValue: z.number(),
  constrainedValue: z.number(),
  finalValue: z.number(),
  direction: z.enum(['increase', 'decrease']),
  adjustmentKind: z.enum(['none', 'one_cent', 'bounded_integer']),
  hardBoundPreventedAdjustment: z.boolean(),
});
export type DirectionalAdjustmentProvenance = z.infer<
  typeof DirectionalAdjustmentProvenance
>;

export const ReversionPreview = z.object({
  recommendationId: Uuid,
  originalValue: z.number(),
  proposedValue: z.number(),
  exportedValue: z.number().nullable(),
  synchronizedValue: z.number().nullable(),
  currentValue: z.number().nullable(),
  inverseValue: z.number(),
  conflict: z.boolean(),
  exportAllowed: z.boolean(),
  reason: z.string().min(1),
});
export type ReversionPreview = z.infer<typeof ReversionPreview>;

/** Exact evidence state for one exported old-to-new row. */
export const ReversionRowState = z.enum([
  'awaiting_sync',
  'ready',
  'conflict',
  'already_reverted',
  'unsupported',
  'ambiguous',
]);
export type ReversionRowState = z.infer<typeof ReversionRowState>;

/**
 * One immutable export row reconstructed against synchronized evidence and the
 * current entity mirror. Values stay scalar because the staged-apply bridge
 * can only validate scalar old-to-new changes.
 */
export const ReversionRowPreview = z.object({
  batchId: Uuid,
  rowId: Uuid,
  recommendationId: Uuid.nullable(),
  entityType: ApplyEntityType,
  entityId: AmazonId,
  entityName: z.string().nullable(),
  field: z.string().min(1),
  originalValue: ApplyValue,
  proposedValue: ApplyValue,
  exportedValue: ApplyValue,
  synchronizedValue: ApplyValue.nullable(),
  synchronizedAt: z.iso.datetime().nullable(),
  currentValue: ApplyValue.nullable(),
  currentSyncedAt: z.iso.datetime().nullable(),
  inverseValue: ApplyValue,
  state: ReversionRowState,
  conflict: z.boolean(),
  exportAllowed: z.boolean(),
  reason: z.string().min(1),
});
export type ReversionRowPreview = z.infer<typeof ReversionRowPreview>;

export const ReversionBatchPreview = z.object({
  batchId: Uuid,
  sourceBatchId: Uuid.nullable(),
  activeReversionBatchId: Uuid.nullable(),
  profileId: Uuid,
  tag: z.string().min(1),
  optGroup: z.string().min(1),
  lever: z.string().min(1),
  note: z.string(),
  lifecycleStatus: z.enum(['exported', 'applied_externally', 'reversion_exported', 'verified_reverted', 'abandoned']),
  exportedAt: z.iso.datetime(),
  appliedAt: z.iso.datetime().nullable(),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  exportedProposals: z.number().int().nonnegative(),
  reversibleRows: z.number().int().nonnegative(),
  unsupportedRows: z.number().int().nonnegative(),
  rows: z.array(ReversionRowPreview),
  readyRows: z.number().int().nonnegative(),
  blockedRows: z.number().int().nonnegative(),
  exportAllowed: z.boolean(),
  reason: z.string().min(1),
}).superRefine((batch, context) => {
  if (batch.exportedProposals !== batch.reversibleRows + batch.unsupportedRows) {
    context.addIssue({
      code: 'custom',
      path: ['exportedProposals'],
      message: 'exported proposals must equal reversible plus unsupported rows',
    });
  }
  if (batch.rows.length !== batch.reversibleRows) {
    context.addIssue({
      code: 'custom',
      path: ['rows'],
      message: 'reconstructed rows must equal reversible rows',
    });
  }
  if (batch.readyRows + batch.blockedRows !== batch.exportedProposals) {
    context.addIssue({
      code: 'custom',
      path: ['blockedRows'],
      message: 'ready plus blocked rows must equal exported proposals',
    });
  }
  if (batch.readyRows !== batch.rows.filter((row) => row.exportAllowed).length) {
    context.addIssue({
      code: 'custom',
      path: ['readyRows'],
      message: 'ready row count must equal exportable reconstructed rows',
    });
  }
});
export type ReversionBatchPreview = z.infer<typeof ReversionBatchPreview>;
