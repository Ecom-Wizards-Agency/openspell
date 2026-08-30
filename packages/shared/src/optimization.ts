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

export const OPTIMIZATION_WEEKDAYS = OptimizationWeekday.options;

export const OPTIMIZATION_WEEKDAY_ISO: Readonly<Record<OptimizationWeekday, number>> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

/** Canonical Monday-to-Sunday order makes schedule equality deterministic. */
export const OptimizationWeekdays = z.array(OptimizationWeekday).min(1).max(7).superRefine(
  (weekdays, context) => {
    const canonical = OPTIMIZATION_WEEKDAYS.filter((weekday) => weekdays.includes(weekday));
    if (canonical.length !== weekdays.length || canonical.some((weekday, index) => weekday !== weekdays[index])) {
      context.addIssue({
        code: 'custom',
        message: 'weekdays must be unique and ordered Monday through Sunday',
      });
    }
  },
);

export const OptimizationReviewSchedule = z.object({
  version: z.literal(2),
  weekdays: OptimizationWeekdays,
});
export type OptimizationReviewSchedule = z.infer<typeof OptimizationReviewSchedule>;

/** Values are tenant data. This contract intentionally supplies no numeric defaults. */
export const OptimizationGroupPolicy = z.object({
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
  prioritization: OptimizationPrioritization,
  enabled: z.boolean(),
});
export type OptimizationGroupPolicy = z.infer<typeof OptimizationGroupPolicy>;

/** Historical and public v1 contract retained unchanged for additive compatibility. */
export const OptimizationGroup = OptimizationGroupPolicy.extend({
  cadence: z.string().min(1),
});
export type OptimizationGroup = z.infer<typeof OptimizationGroup>;

/** Current mutable group contract. Interval cadence remains storage-only for rollback. */
export const ScheduledOptimizationGroup = OptimizationGroupPolicy.extend({
  version: z.literal(2),
  reviewSchedule: OptimizationReviewSchedule,
});
export type ScheduledOptimizationGroup = z.infer<typeof ScheduledOptimizationGroup>;

/** Historical snapshots written before weekday schedules existed remain decodable. */
export const LegacyOptimizationGroupSnapshot = OptimizationGroup;
export type LegacyOptimizationGroupSnapshot = z.infer<typeof LegacyOptimizationGroupSnapshot>;

export const OptimizationGroupSnapshot = z.union([
  ScheduledOptimizationGroup,
  LegacyOptimizationGroupSnapshot,
]);
export type OptimizationGroupSnapshot = z.infer<typeof OptimizationGroupSnapshot>;

export const OptimizationGroupSnapshotEnvelope = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), group: LegacyOptimizationGroupSnapshot }),
  z.object({ version: z.literal(2), group: ScheduledOptimizationGroup }),
]);
export type OptimizationGroupSnapshotEnvelope = z.infer<
  typeof OptimizationGroupSnapshotEnvelope
>;

/** One versioned decoder for database history; callers never guess from fields. */
export function normalizeOptimizationGroupSnapshot(input: unknown): OptimizationGroupSnapshotEnvelope {
  const current = ScheduledOptimizationGroup.safeParse(input);
  if (current.success) return { version: 2, group: current.data };
  return { version: 1, group: LegacyOptimizationGroupSnapshot.parse(input) };
}

export function optimizationWeekdaysFromIso(values: readonly number[]): OptimizationWeekday[] {
  const byIso = new Map(
    Object.entries(OPTIMIZATION_WEEKDAY_ISO).map(([weekday, iso]) => [iso, weekday as OptimizationWeekday]),
  );
  return OptimizationWeekdays.parse(values.map((value) => byIso.get(value)));
}

export function optimizationWeekdaysToIso(values: readonly OptimizationWeekday[]): number[] {
  return OptimizationWeekdays.parse(values).map((weekday) => OPTIMIZATION_WEEKDAY_ISO[weekday]);
}

export const CampaignOptimizationAssignment = z.object({
  profileId: Uuid,
  campaignId: AmazonId,
  groupId: Uuid,
  assignedAt: z.iso.datetime(),
  assignedBy: Uuid.nullable(),
});
export type CampaignOptimizationAssignment = z.infer<typeof CampaignOptimizationAssignment>;

export const OptimizationRunScheduleContext = z.object({
  version: z.literal(2),
  trigger: z.enum(['manual', 'scheduled']),
  profileTimezone: z.string().min(1),
  weekdays: OptimizationWeekdays,
  localHour: z.number().int().min(0).max(23),
  dueAt: z.iso.datetime(),
  evaluatedAt: z.iso.datetime(),
});
export type OptimizationRunScheduleContext = z.infer<typeof OptimizationRunScheduleContext>;

const OptimizationRunContextBase = z.object({
  runId: Uuid,
  profileId: Uuid,
  groupId: Uuid,
  groupRole: OptimizationGroupRole,
  dueAt: z.iso.datetime(),
  windowStart: IsoDate,
  windowEnd: IsoDate,
});

export const LegacyOptimizationRunContext = OptimizationRunContextBase.extend({
  groupSnapshot: LegacyOptimizationGroupSnapshot,
});

export const ScheduledOptimizationRunContext = OptimizationRunContextBase.extend({
  groupSnapshot: ScheduledOptimizationGroup,
  scheduleContext: OptimizationRunScheduleContext,
});

export const OptimizationRunContext = z.union([
  ScheduledOptimizationRunContext,
  LegacyOptimizationRunContext,
]);
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
