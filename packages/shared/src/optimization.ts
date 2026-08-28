/** Persistent optimization group and observation-loop contracts. */
import { z } from 'zod';
import { AmazonId, IsoDate, Uuid } from './primitives.js';

export const OptimizationGroupRole = z.enum(['rank', 'discovery', 'profit', 'shield']);
export type OptimizationGroupRole = z.infer<typeof OptimizationGroupRole>;

export const OptimizationPrioritization = z.enum([
  'efficiency_first',
  'growth_first',
  'balanced',
]);
export type OptimizationPrioritization = z.infer<typeof OptimizationPrioritization>;

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
  cadence: z.string().min(1),
  prioritization: OptimizationPrioritization,
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
