import type {
  IsoDate,
  OptimizationRunContext,
  RecommendationObservation,
} from '@wizard-ads/shared';

/**
 * The persisted identity and synchronization evidence supplied to the pure
 * evaluator. Decision fields are deliberately absent because this function
 * produces them.
 */
export type RecommendationObservationSeed = Pick<
  RecommendationObservation,
  | 'recommendationId'
  | 'priorRecommendationId'
  | 'groupId'
  | 'expectedValue'
  | 'synchronizedValue'
  | 'synchronizedAt'
  | 'observationWindowStart'
  | 'observationWindowEnd'
>;

/** One like-for-like unit present in both the pre- and post-change windows. */
export interface MatchedIncrementalVolumePair {
  /** Stable match key chosen by the caller, such as campaign + target + weekday. */
  matchKey: string;
  preIncrementalVolume: number;
  postIncrementalVolume: number;
}

/**
 * Tenant-supplied evidence gates. No doctrine values or defaults live in core.
 */
export interface RecommendationEvidencePolicy {
  synchronizationTolerance: number;
  minimumMatchedPairs: number;
  minimumCombinedIncrementalVolume: number;
  minimumAbsoluteLift: number;
  minimumRelativeLift: number;
}

export interface EvaluateRecommendationEvidenceRequest {
  context: OptimizationRunContext;
  seed: RecommendationObservationSeed;
  /** Exact value that existed before the exported recommendation. */
  preChangeValue: number;
  /** Latest day for which attribution and comparison evidence is settled. */
  settledThrough: IsoDate | null;
  matchedPairs: readonly MatchedIncrementalVolumePair[];
  policy: RecommendationEvidencePolicy;
}

export type RecommendationEvidenceClassification =
  | 'not_synchronized'
  | 'synchronization_conflict'
  | 'observation_incomplete'
  | 'evidence_insufficient'
  | 'supported_lift'
  | 'complete_no_lift';

/** Structured work shown alongside the persisted evidence note. */
export interface RecommendationEvidenceProvenance {
  classification: RecommendationEvidenceClassification;
  suppliedPairCount: number;
  evaluatedPairCount: number;
  /** @deprecated Prefer evaluatedPairCount; retained as a readable alias. */
  matchedPairCount: number;
  preIncrementalVolume: number | null;
  postIncrementalVolume: number | null;
  absoluteLift: number | null;
  relativeLift: number | null;
  policy: RecommendationEvidencePolicy;
}

export interface RecommendationEvidenceEvaluation {
  /** Immutable snapshot tying the decision back to its optimization group. */
  context: OptimizationRunContext;
  classification: RecommendationEvidenceClassification;
  observation: RecommendationObservation;
  provenance: RecommendationEvidenceProvenance;
  /** True only after a complete matched window has supported lift. */
  mayCompound: boolean;
  /** Populated only for a complete no-lift reversion proposal. */
  revertToValue: number | null;
}

function assertFiniteNonnegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a finite nonnegative number`);
  }
}

function assertRequest(request: EvaluateRecommendationEvidenceRequest): void {
  const { context, seed, policy } = request;
  if (context.groupId !== context.groupSnapshot.id) {
    throw new Error('run context groupId does not match its group snapshot');
  }
  if (context.profileId !== context.groupSnapshot.profileId) {
    throw new Error('run context profileId does not match its group snapshot');
  }
  if (context.groupRole !== context.groupSnapshot.role) {
    throw new Error('run context groupRole does not match its group snapshot');
  }
  if (seed.groupId !== context.groupId) {
    throw new Error('recommendation observation groupId does not match the run context');
  }
  if (seed.observationWindowEnd < seed.observationWindowStart) {
    throw new RangeError('observation window end must not precede its start');
  }
  if ((seed.synchronizedValue === null) !== (seed.synchronizedAt === null)) {
    throw new Error('synchronizedValue and synchronizedAt must be supplied together');
  }
  if (seed.priorRecommendationId === seed.recommendationId) {
    throw new Error('a recommendation cannot name itself as its prior recommendation');
  }
  if (
    seed.synchronizedAt !== null &&
    seed.synchronizedAt.slice(0, 10) > seed.observationWindowStart
  ) {
    throw new RangeError('observation window must not start before synchronization');
  }
  if (!Number.isFinite(seed.expectedValue) || !Number.isFinite(request.preChangeValue)) {
    throw new RangeError('recommendation values must be finite');
  }

  assertFiniteNonnegative(policy.synchronizationTolerance, 'synchronizationTolerance');
  if (!Number.isInteger(policy.minimumMatchedPairs) || policy.minimumMatchedPairs < 1) {
    throw new RangeError('minimumMatchedPairs must be a positive integer');
  }
  assertFiniteNonnegative(
    policy.minimumCombinedIncrementalVolume,
    'minimumCombinedIncrementalVolume',
  );
  assertFiniteNonnegative(policy.minimumAbsoluteLift, 'minimumAbsoluteLift');
  assertFiniteNonnegative(policy.minimumRelativeLift, 'minimumRelativeLift');

  const keys = new Set<string>();
  for (const pair of request.matchedPairs) {
    if (pair.matchKey.trim().length === 0) {
      throw new Error('matched pair keys must not be empty');
    }
    if (keys.has(pair.matchKey)) {
      throw new Error(`duplicate matched pair key: ${pair.matchKey}`);
    }
    keys.add(pair.matchKey);
    assertFiniteNonnegative(pair.preIncrementalVolume, 'preIncrementalVolume');
    assertFiniteNonnegative(pair.postIncrementalVolume, 'postIncrementalVolume');
  }
}

interface MatchedTotals {
  count: number;
  pre: number;
  post: number;
  absoluteLift: number;
  relativeLift: number | null;
}

function matchedTotals(pairs: readonly MatchedIncrementalVolumePair[]): MatchedTotals {
  let pre = 0;
  let post = 0;
  for (const pair of pairs) {
    pre += pair.preIncrementalVolume;
    post += pair.postIncrementalVolume;
  }
  const absoluteLift = post - pre;
  return {
    count: pairs.length,
    pre,
    post,
    absoluteLift,
    relativeLift: pre === 0 ? null : absoluteLift / pre,
  };
}

function renderNumber(value: number | null): string {
  if (value === null) return 'not_available';
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

function noteFor(
  classification: RecommendationEvidenceClassification,
  totals: MatchedTotals | null,
  request: EvaluateRecommendationEvidenceRequest,
): string {
  const { seed, policy } = request;
  if (classification === 'not_synchronized') {
    return (
      `not_synchronized: synchronized bid history has not recorded exported_value=${renderNumber(seed.expectedValue)}; ` +
      'hold and do not compound'
    );
  }
  if (classification === 'synchronization_conflict') {
    return (
      `synchronization_conflict: exported_value=${renderNumber(seed.expectedValue)}; ` +
      `synchronized_value=${renderNumber(seed.synchronizedValue)}; ` +
      `tolerance=${renderNumber(policy.synchronizationTolerance)}; ` +
      'hold for operator review'
    );
  }
  if (classification === 'observation_incomplete') {
    return (
      `observation_incomplete: settled_through=${request.settledThrough ?? 'not_available'}; ` +
      `required_through=${seed.observationWindowEnd}; hold and do not compound`
    );
  }

  const evidence =
    `matched_pairs=${totals?.count ?? 0}; ` +
    `pre=${renderNumber(totals?.pre ?? null)}; ` +
    `post=${renderNumber(totals?.post ?? null)}; ` +
    `absolute_lift=${renderNumber(totals?.absoluteLift ?? null)}; ` +
    `relative_lift=${renderNumber(totals?.relativeLift ?? null)}; ` +
    `minimum_pairs=${policy.minimumMatchedPairs}; ` +
    `minimum_combined_volume=${renderNumber(policy.minimumCombinedIncrementalVolume)}; ` +
    `minimum_absolute_lift=${renderNumber(policy.minimumAbsoluteLift)}; ` +
    `minimum_relative_lift=${renderNumber(policy.minimumRelativeLift)}`;

  if (classification === 'evidence_insufficient') {
    return `evidence_insufficient: ${evidence}; hold and do not compound`;
  }
  if (classification === 'supported_lift') {
    return `supported_lift: ${evidence}; a subsequent recommendation may be evaluated`;
  }
  return `complete_no_lift: ${evidence}; propose reverting to the pre-change value`;
}

function buildEvaluation(
  request: EvaluateRecommendationEvidenceRequest,
  classification: RecommendationEvidenceClassification,
  totals: MatchedTotals | null,
): RecommendationEvidenceEvaluation {
  const { context, seed, policy } = request;
  const complete = classification === 'supported_lift' || classification === 'complete_no_lift';
  const evidenceState: RecommendationObservation['evidenceState'] =
    classification === 'not_synchronized'
      ? 'awaiting_sync'
      : classification === 'synchronization_conflict'
        ? 'conflict'
        : classification === 'observation_incomplete'
          ? 'observing'
          : classification === 'evidence_insufficient'
            ? 'insufficient'
            : 'complete';
  const decision: RecommendationObservation['decision'] =
    classification === 'supported_lift'
      ? 'continue'
      : classification === 'complete_no_lift'
        ? 'revert'
        : 'hold';
  const exposeTotals =
    classification === 'evidence_insufficient' || classification === 'supported_lift' || complete;

  const observation: RecommendationObservation = {
    ...seed,
    evidenceState,
    decision,
    preIncrementalVolume: exposeTotals && totals !== null ? totals.pre : null,
    postIncrementalVolume: exposeTotals && totals !== null ? totals.post : null,
    evidenceNote: noteFor(classification, totals, request),
  };

  return {
    context,
    classification,
    observation,
    provenance: {
      classification,
      suppliedPairCount: request.matchedPairs.length,
      evaluatedPairCount: totals?.count ?? 0,
      matchedPairCount: totals?.count ?? 0,
      preIncrementalVolume: exposeTotals && totals !== null ? totals.pre : null,
      postIncrementalVolume: exposeTotals && totals !== null ? totals.post : null,
      absoluteLift: exposeTotals && totals !== null ? totals.absoluteLift : null,
      relativeLift: exposeTotals && totals !== null ? totals.relativeLift : null,
      policy: { ...policy },
    },
    mayCompound: classification === 'supported_lift',
    revertToValue: classification === 'complete_no_lift' ? request.preChangeValue : null,
  };
}

/**
 * Evaluate one exported recommendation against synchronized, settled, matched
 * evidence. The engine never compounds on absent or partial evidence.
 */
export function evaluateRecommendationEvidence(
  request: EvaluateRecommendationEvidenceRequest,
): RecommendationEvidenceEvaluation {
  assertRequest(request);
  const { seed, policy } = request;

  if (seed.synchronizedValue === null || seed.synchronizedAt === null) {
    return buildEvaluation(request, 'not_synchronized', null);
  }
  if (
    Math.abs(seed.synchronizedValue - seed.expectedValue) > policy.synchronizationTolerance
  ) {
    return buildEvaluation(request, 'synchronization_conflict', null);
  }
  if (
    request.settledThrough === null ||
    request.settledThrough < seed.observationWindowEnd
  ) {
    return buildEvaluation(request, 'observation_incomplete', null);
  }

  const totals = matchedTotals(request.matchedPairs);
  const combinedVolume = totals.pre + totals.post;
  if (
    totals.count < policy.minimumMatchedPairs ||
    combinedVolume < policy.minimumCombinedIncrementalVolume
  ) {
    return buildEvaluation(request, 'evidence_insufficient', totals);
  }

  const relativeLiftSupported =
    totals.pre === 0
      ? totals.post > 0
      : (totals.relativeLift ?? 0) >= policy.minimumRelativeLift;
  const liftSupported =
    totals.absoluteLift > 0 &&
    totals.absoluteLift >= policy.minimumAbsoluteLift &&
    relativeLiftSupported;

  return buildEvaluation(
    request,
    liftSupported ? 'supported_lift' : 'complete_no_lift',
    totals,
  );
}
