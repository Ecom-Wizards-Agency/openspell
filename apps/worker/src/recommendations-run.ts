/**
 * The production recommendations runner.
 *
 * White Box reason -> hard Postgres `recommendation_reason` mapping:
 *
 * | `proposeBid` reason       | database reason          |
 * | ------------------------- | ------------------------ |
 * | `high_acos`               | `high_acos`              |
 * | `high_spend_no_sales`     | `high_spend_no_sales`    |
 * | `low_acos`                | `low_acos`               |
 * | `low_visibility`          | `low_visibility`         |
 *
 * Only numeric `proposal` outcomes become `recommendations` rows. Suppressed
 * and declined outcomes, plus buildRecommendations' qualitative output, live
 * in the run-level audit payload. This is intentional: inventing an entity ref
 * for an account-wide note would turn narrative into an exportable fake action.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ClaimRef, DbHandle, QuerySql } from '@wizard-ads/db';
import type { RecommendationWorkerDatabase } from '@wizard-ads/db/recommendation-worker';
import {
  buildRecommendations,
  CATEGORY_UNKNOWN,
  classifyCampaignCategory,
  computePacing,
  adjustBidAwayFromMechanicalValue,
  proposeBid,
  resolveGoalLens,
  type LevelMetrics,
  type BidPreconditionNote,
  type OrganicRankSignal,
  type PacingCondition,
  type PacingResult,
  type RawEntity,
  type RawRadarRow,
  type RecommendationsResult,
  type StockSignal,
} from '@wizard-ads/core';
import {
  ScheduledOptimizationGroup,
  RecommendationsRunJob,
  TenantStrategy,
  OptimizationRunScheduleContext,
  normalizeOptimizationGroupSnapshot,
  optimizationWeekdaysFromIso,
  type AdProduct,
  type EntityRef,
  type Recommendation,
  type RecommendationReason,
  type OptimizationGroupSnapshot,
} from '@wizard-ads/shared';
import {
  changeCapsFor,
  optGroup,
  resolveStrategy,
  targetAcosFor,
  type StrategyDocument,
} from '@wizard-ads/strategy';
import { profileToday } from './profile-calendar.js';
import { RECOMMENDATION_CADENCE } from './recommendation-cadence.js';

export const DEFAULT_RECOMMENDATION_LOOKBACK_DAYS = RECOMMENDATION_CADENCE.lookbackDays;
export const RECOMMENDATIONS_ENGINE_VERSION = 'white-box-v1';
export const RECOMMENDATION_SCHEDULE_CADENCE = RECOMMENDATION_CADENCE.cadence;
export const RECOMMENDATION_SCHEDULE_DELAY = RECOMMENDATION_CADENCE.delay;
export const RECOMMENDATION_SCHEDULE_PRIORITY = RECOMMENDATION_CADENCE.priority;
export const RECOMMENDATION_SCOPE_VERSION = 1;
export const MAX_RECOMMENDATION_PREVIEW_CAMPAIGNS = 10_000;
export const MAX_RECOMMENDATION_PREVIEW_REQUEST_BYTES = 512 * 1024;

export type RecommendationPreviewErrorCode =
  | 'invalid_request'
  | 'stale_selection'
  | 'idempotency_conflict'
  | 'active_run_conflict'
  | 'safety_hold'
  | 'integrity_failure';

/** Fixed-code, operator-safe failure boundary for the optimizer HTTP adapter. */
export class RecommendationPreviewError extends Error {
  override readonly name: string = 'RecommendationPreviewError';

  constructor(
    readonly code: RecommendationPreviewErrorCode,
    readonly httpStatus: 400 | 409 | 413 | 422 | 500,
    message: string,
  ) {
    super(message);
  }
}

/** A retry cannot repair persisted run evidence that no longer closes exactly. */
export class RecommendationScopeIntegrityError extends RecommendationPreviewError {
  override readonly name: string = 'RecommendationScopeIntegrityError';

  constructor(message = 'Recommendation preview evidence failed its integrity check.') {
    super('integrity_failure', 500, message);
  }
}

/** The executing queue claim is not the immutable job linked to this run. */
export class RecommendationExecutionCustodyError extends RecommendationPreviewError {
  override readonly name: string = 'RecommendationExecutionCustodyError';

  constructor(message = 'Recommendation execution does not own the linked queue job.') {
    super('integrity_failure', 500, message);
  }
}

/** Exact-claim failure/readback did not prove whether the run transition committed. */
export class RecommendationExecutionSettlementAmbiguousError extends Error {
  override readonly name = 'RecommendationExecutionSettlementAmbiguousError';

  constructor() {
    super('Recommendation execution settlement requires attended reconciliation.');
  }
}

export type RecommendationPreviewSelection =
  | { mode: 'all' }
  | { mode: 'selected'; campaignIds: readonly string[] };

export interface EnqueueRecommendationPreviewBatchInput extends ProfileScope {
  actorId: string;
  clientRequestId: string;
  scope: RecommendationPreviewSelection;
  lookbackDays?: number;
  runAt?: Date;
}

export interface RecommendationPreviewAccepted {
  batchId: string;
  status: 'queued';
  scope: {
    mode: 'all' | 'selected';
    campaignCount: number;
    fingerprint: string;
  };
  childCount: number;
}

export interface RecommendationPreviewBatchScope extends ProfileScope {
  batchId: string;
}

export interface RecommendationPreviewBatchStatus {
  batchId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  campaignCount: number;
  proposalsCount: number;
  children: Array<{
    runId: string;
    groupName: string | null;
    status: 'queued' | 'running' | 'succeeded' | 'failed';
    campaignCount: number;
    proposalsCount: number;
  }>;
}

type BidReason = Extract<
  RecommendationReason,
  'high_acos' | 'high_spend_no_sales' | 'low_acos' | 'low_visibility'
>;

export const BID_REASON_TO_DATABASE: Readonly<Record<BidReason, BidReason>> = {
  high_acos: 'high_acos',
  high_spend_no_sales: 'high_spend_no_sales',
  low_acos: 'low_acos',
  low_visibility: 'low_visibility',
};

export function databaseReason(reason: RecommendationReason): BidReason {
  if (reason === 'flag' || reason === 'pacing') {
    throw new Error(`proposeBid returned non-bid reason ${reason}`);
  }
  return BID_REASON_TO_DATABASE[reason];
}

export interface DateWindow {
  start: string;
  end: string;
}

export interface ProfileScope {
  orgId: string;
  profileId: string;
}

export interface RunScope extends ProfileScope {
  runId: string;
}

export interface RecommendationProfile extends ProfileScope {
  timezone: string;
  goal: string | null;
  monthlyBudget: number | null;
}

export interface SuggestedBidCorridor {
  date: string;
  low: number | null;
  median: number | null;
  high: number | null;
  bid: number | null;
  cpc: number | null;
}

export interface PerformanceMetrics extends LevelMetrics {
  impressions: number;
}

export interface TargetPerformance {
  entityRef: EntityRef;
  campaignName: string;
  adGroupName: string | null;
  category: string;
  matchType: string | null;
  entityState: string | null;
  campaignState: string | null;
  adGroupState: string | null;
  currentBid: number | null;
  dailyBudget: number | null;
  stock: StockSignal;
  organicRank: OrganicRankSignal;
  metrics: PerformanceMetrics;
  corridor: SuggestedBidCorridor | null;
}

export interface CampaignPerformance {
  adProduct: AdProduct;
  campaignId: string;
  campaignName: string;
  state: string | null;
  dailyBudget: number | null;
  metrics: PerformanceMetrics;
}

export interface ProfilePerformanceRow extends LevelMetrics {
  date: string;
  impressions: number;
}

export interface RecommendationRunInputs {
  tenantStrategy: StrategyDocument | null;
  profileStrategy: StrategyDocument | null;
  targets: TargetPerformance[];
  campaigns: CampaignPerformance[];
  profileFacts: ProfilePerformanceRow[];
}

export interface RecommendationGroupRun {
  group: OptimizationGroupSnapshot;
  dueAt: string;
  scheduleContext: ReturnType<typeof OptimizationRunScheduleContext.parse> | null;
}

export interface GroupRecommendationSafety {
  mayPropose: boolean;
  exportedRecommendations: number;
  incompleteObservations: number;
  holdDecisions: number;
  revertDecisions: number;
  reason: string;
}

export interface StartRunResult {
  alreadySucceeded: boolean;
  proposalsCount: number;
  groupRun?: RecommendationGroupRun | null;
  strategySnapshot: TenantStrategy;
  strategyGoal: string;
}

export interface ProposalDiagnostics {
  targetsRead: number;
  targetsConsidered: number;
  proposed: number;
  suppressed: number;
  declined: number;
  blockedOutOfStock: number;
  skippedInactive: number;
  skippedMissingStrategy: number;
  corridorsAvailable: number;
  corridorsMissing: number;
  preconditionNotes: number;
  declinedReasons: Record<string, number>;
  /** Bounded examples for operator diagnosis; counts above remain complete. */
  examples: Array<{ entity: string; outcome: string; detail: string }>;
}

export interface RecommendationRunNarrative {
  window: DateWindow;
  qualitative: RecommendationsResult;
  pacing: PacingResult | null;
  diagnostics: ProposalDiagnostics;
  groupSafety: GroupRecommendationSafety | null;
}

/** Shared recommendation plus core-only notes persisted through audit_log. */
export type AnnotatedRecommendation = Recommendation & {
  preconditionNotes: BidPreconditionNote[];
};

export interface RunCompletion extends RunScope {
  lookbackDays: number;
  window: DateWindow;
  strategySnapshot: TenantStrategy;
  proposals: readonly AnnotatedRecommendation[];
  narrative: RecommendationRunNarrative;
}

export interface RecommendationRunStore {
  startRun(
    scope: RunScope,
    expectedGroupId: string | undefined,
    execution: RecommendationRunExecutionContext,
  ): Promise<StartRunResult>;
  loadProfile(
    scope: ProfileScope,
    execution: RecommendationRunExecutionContext,
  ): Promise<RecommendationProfile>;
  loadInputs(
    scope: RunScope,
    window: DateWindow,
    execution: RecommendationRunExecutionContext,
  ): Promise<RecommendationRunInputs>;
  loadGroupRecommendationSafety(
    scope: ProfileScope,
    groupId: string,
    execution: RecommendationRunExecutionContext,
  ): Promise<GroupRecommendationSafety>;
  succeedRun(
    completion: RunCompletion,
    execution: RecommendationRunExecutionContext,
  ): Promise<number>;
  failRun(
    scope: RunScope,
    error: string,
    execution: RecommendationRunExecutionContext,
  ): Promise<RecommendationRunFailureResult>;
}

export type RecommendationRunFailureResult =
  | Readonly<{ decision: 'failed' }>
  | Readonly<{ decision: 'already_succeeded'; proposalsCount: number }>;

export interface QueueRecommendationRunInput extends ProfileScope {
  lookbackDays?: number;
  groupId?: string;
  runAt?: Date;
  source: 'schedule' | 'web';
}

export interface QueuedRecommendationRun {
  runId: string;
  jobId: string;
}

export interface RecommendationScheduleStore {
  enqueueDueRecommendationRuns(now?: Date): Promise<number>;
  enqueueRecommendationRun(input: QueueRecommendationRunInput): Promise<QueuedRecommendationRun>;
  enqueueRecommendationPreviewBatch(
    input: EnqueueRecommendationPreviewBatchInput,
  ): Promise<RecommendationPreviewAccepted>;
  getRecommendationPreviewBatchStatus(
    scope: RecommendationPreviewBatchScope,
  ): Promise<RecommendationPreviewBatchStatus | null>;
}

export interface RecommendationRunResult {
  runId: string;
  proposals: number;
  window: DateWindow | null;
  alreadySucceeded: boolean;
}

export type RecommendationRunExecutionContext =
  | Readonly<{
      /** Compatibility-only custody before recommendation fencing activates. */
      jobId: string;
    }>
  | Readonly<{
      /** Exact opaque, non-expiring fenced custody for the narrow lane. */
      claim: ClaimRef;
    }>;

function executionJobId(execution: RecommendationRunExecutionContext): string {
  return 'claim' in execution ? execution.claim.jobId : execution.jobId;
}

export type RecommendationsRun = (
  payload: Omit<RecommendationsRunJob, 'lookbackDays'> & { lookbackDays?: number },
  execution: RecommendationRunExecutionContext,
) => Promise<RecommendationRunResult>;

export interface RecommendationsRunnerOptions {
  now?: () => Date;
}

/** Last complete profile-local window: today is never optimization evidence. */
export function recommendationWindow(
  timezone: string,
  lookbackDays: number = DEFAULT_RECOMMENDATION_LOOKBACK_DAYS,
  now = new Date(),
): DateWindow {
  if (!Number.isInteger(lookbackDays) || lookbackDays <= 0) {
    throw new Error('lookbackDays must be a positive integer');
  }
  const today = profileToday(timezone, now);
  const end = addDays(today, -1);
  return { start: addDays(end, -(lookbackDays - 1)), end };
}

export function createRecommendationsRunner(
  store: RecommendationRunStore,
  options: RecommendationsRunnerOptions = {},
): RecommendationsRun {
  const now = options.now ?? (() => new Date());
  return async (payload, execution) => runRecommendations(store, payload, execution, now());
}

export async function runRecommendations(
  store: RecommendationRunStore,
  payload: Omit<RecommendationsRunJob, 'lookbackDays'> & { lookbackDays?: number },
  execution: RecommendationRunExecutionContext,
  now = new Date(),
): Promise<RecommendationRunResult> {
  const scope: RunScope = {
    orgId: payload.orgId,
    profileId: payload.profileId,
    runId: payload.runId,
  };
  let started: StartRunResult;
  try {
    started = await store.startRun(scope, payload.groupId, execution);
  } catch (error) {
    if (error instanceof RecommendationExecutionCustodyError) throw error;
    const failure = await reconcileRunFailure(
      store, scope, errorMessage(error).slice(0, 4_000), execution,
    );
    if (failure.decision === 'already_succeeded') {
      return {
        runId: payload.runId,
        proposals: failure.proposalsCount,
        window: null,
        alreadySucceeded: true,
      };
    }
    throw error;
  }
  if (started.alreadySucceeded) {
    return {
      runId: payload.runId,
      proposals: started.proposalsCount,
      window: null,
      alreadySucceeded: true,
    };
  }

  let window: DateWindow | null = null;
  let successWriteAmbiguous = false;
  try {
    const lookbackDays = payload.lookbackDays ?? DEFAULT_RECOMMENDATION_LOOKBACK_DAYS;
    const profile = await store.loadProfile(scope, execution);
    window = recommendationWindow(profile.timezone, lookbackDays, now);
    const inputs = await store.loadInputs(scope, window, execution);
    const groupSafety = started.groupRun === null || started.groupRun === undefined
      ? null
      : await store.loadGroupRecommendationSafety(scope, started.groupRun.group.id, execution);
    const resolved = {
      value: started.strategySnapshot,
      goal: started.strategyGoal,
    };

    const pacing = computePacing(
      inputs.profileFacts.map((row) => ({ date: row.date, spend: row.cost ?? 0 })),
      window.end,
      profile.monthlyBudget,
      resolveGoalLens(resolved.goal),
      { pacing: resolved.value.pacing },
    );
    const rawEntities = rawEntitiesFrom(inputs);
    const qualitative = buildRecommendations(rawEntities, {
      goal: resolved.goal,
      pacing,
      rankRadar: rankRadarFrom(inputs),
    });
    const evaluated = bidProposals({
      scope,
      window,
      profile,
      inputs,
      strategy: resolved.value,
      resolvedGoal: resolved.goal,
      pacing,
      group: started.groupRun?.group ?? null,
    });
    const proposals = groupSafety?.mayPropose === false ? [] : evaluated.proposals;
    const diagnostics = groupSafety?.mayPropose === false
      ? suppressForGroupSafety(evaluated.diagnostics, evaluated.proposals.length, groupSafety.reason)
      : evaluated.diagnostics;
    const safeQualitative = groupSafety?.mayPropose === false
      ? { ...qualitative, notes: [...qualitative.notes, groupSafety.reason] }
      : qualitative;
    const narrative: RecommendationRunNarrative = {
      window,
      qualitative: safeQualitative,
      pacing,
      diagnostics,
      groupSafety,
    };
    let written: number;
    try {
      written = await store.succeedRun({
        ...scope,
        lookbackDays,
        window,
        strategySnapshot: resolved.value,
        proposals,
        narrative,
      }, execution);
    } catch (error) {
      // The database transaction may have committed even if its response was
      // lost. The exact-claim failure RPC is also the authoritative readback.
      successWriteAmbiguous = true;
      throw error;
    }
    if (written !== proposals.length) {
      throw new Error(`Composed ${proposals.length} recommendations, store wrote ${written}`);
    }
    return { runId: payload.runId, proposals: written, window, alreadySucceeded: false };
  } catch (error) {
    const failure = await reconcileRunFailure(
      store, scope, errorMessage(error).slice(0, 4_000), execution,
    );
    if (successWriteAmbiguous && failure.decision === 'already_succeeded') {
      return {
        runId: payload.runId,
        proposals: failure.proposalsCount,
        window,
        alreadySucceeded: true,
      };
    }
    throw error;
  }
}

async function reconcileRunFailure(
  store: RecommendationRunStore,
  scope: RunScope,
  error: string,
  execution: RecommendationRunExecutionContext,
): Promise<RecommendationRunFailureResult> {
  try {
    return await store.failRun(scope, error, execution);
  } catch (failure) {
    if (failure instanceof RecommendationExecutionCustodyError) throw failure;
    throw new RecommendationExecutionSettlementAmbiguousError();
  }
}

function suppressForGroupSafety(
  diagnostics: ProposalDiagnostics,
  proposals: number,
  reason: string,
): ProposalDiagnostics {
  return {
    ...diagnostics,
    proposed: 0,
    suppressed: diagnostics.suppressed + proposals,
    examples: [
      ...diagnostics.examples,
      { entity: 'optimization-group', outcome: 'held', detail: reason },
    ].slice(0, 20),
  };
}

interface BidProposalInput {
  scope: RunScope;
  window: DateWindow;
  profile: RecommendationProfile;
  inputs: RecommendationRunInputs;
  strategy: TenantStrategy;
  resolvedGoal: string;
  pacing: PacingResult | null;
  group: OptimizationGroupSnapshot | null;
}

function bidProposals(input: BidProposalInput): {
  proposals: AnnotatedRecommendation[];
  diagnostics: ProposalDiagnostics;
} {
  const { scope, window, inputs, strategy, resolvedGoal, pacing, group: runGroup } = input;
  const byAdGroup = aggregateBy(inputs.targets, (target) => target.entityRef.adGroupId ?? '');
  const byCampaign = aggregateBy(inputs.targets, (target) => target.entityRef.campaignId ?? '');
  const profileMetrics = profileLevelMetrics(inputs, window);
  const proposals: AnnotatedRecommendation[] = [];
  const diagnostics: ProposalDiagnostics = {
    targetsRead: inputs.targets.length,
    targetsConsidered: 0,
    proposed: 0,
    suppressed: 0,
    declined: 0,
    blockedOutOfStock: 0,
    skippedInactive: 0,
    skippedMissingStrategy: 0,
    corridorsAvailable: 0,
    corridorsMissing: 0,
    preconditionNotes: 0,
    declinedReasons: {},
    examples: [],
  };

  for (const target of inputs.targets) {
    const corridorAvailable = hasCorridor(target.corridor);
    if (corridorAvailable) diagnostics.corridorsAvailable += 1;
    else diagnostics.corridorsMissing += 1;

    if (
      target.entityState !== 'enabled' ||
      target.campaignState !== 'enabled' ||
      target.adGroupState !== 'enabled'
    ) {
      diagnostics.skippedInactive += 1;
      example(diagnostics, target, 'skipped', 'entity, ad group, or campaign is not enabled');
      continue;
    }

    const groupName = runGroup?.name ?? optGroupName(strategy, target.category);
    const targetAcos = runGroup?.targetAcos ?? (groupName === null ? null : targetAcosFor(strategy, groupName));
    const caps = runGroup === null
      ? (groupName === null ? null : changeCapsFor(strategy, groupName))
      : {
          maxIncrease: runGroup.bidIncreaseCap,
          maxDecrease: runGroup.bidDecreaseCap,
          maxPlacementIncrease: runGroup.placementIncreaseCap,
        };
    if (groupName === null || targetAcos === null || caps === null) {
      diagnostics.skippedMissingStrategy += 1;
      example(diagnostics, target, 'skipped', 'no matching/default opt group with target ACOS and bid caps');
      continue;
    }

    diagnostics.targetsConsidered += 1;
    const legacyGroup = runGroup === null ? optGroup(strategy, groupName) : null;
    const currentBid = target.currentBid ?? target.corridor?.bid ?? null;
    const cpc = safeDiv(target.metrics.cost ?? 0, target.metrics.clicks);
    const manualMaxBid = boundValue(
      runGroup === null ? legacyGroup?.bid_ceiling_unit : 'absolute',
      runGroup?.bidCeiling ?? legacyGroup?.bid_ceiling_value,
      target.corridor?.median ?? null,
      cpc,
    );
    const manualMinBid = boundValue(
      runGroup === null ? legacyGroup?.bid_floor_unit : 'absolute',
      runGroup?.bidFloor ?? legacyGroup?.bid_floor_value,
      target.corridor?.median ?? null,
      cpc,
    );
    const pacingCondition = toPacingCondition(pacing, resolvedGoal);
    const outcome = proposeBid({
      runId: scope.runId,
      profileId: scope.profileId,
      entityRef: target.entityRef,
      adProduct: target.entityRef.adProduct ?? 'SP',
      window,
      currentBid,
      metrics: target.metrics,
      levels: {
        keyword: target.metrics,
        adGroup: byAdGroup.get(target.entityRef.adGroupId ?? ''),
        campaign: byCampaign.get(target.entityRef.campaignId ?? ''),
        profile: profileMetrics,
      },
      targetAcos,
      caps,
      ceilings: {
        manualMaxBid,
        dailyBudget: target.dailyBudget,
        suggestedBid: target.corridor?.high ?? null,
      },
      floors: {
        manualMinBid,
        suggestedBidLow: target.corridor?.low ?? null,
      },
      category: target.category,
      goal: runGroup === null ? (legacyGroup?.goal_lens ?? resolvedGoal) : goalForGroupRole(runGroup.role),
      stock: target.stock,
      organicRank: target.organicRank,
      ...(pacingCondition === null ? {} : { pacingCondition }),
    });

    if (outcome.kind === 'proposal') {
      const recommendation = applyNonMechanicalBidAdjustment(
        outcome.recommendation,
        runGroup,
        strategy.bids.mechanical_bid_step,
        manualMinBid,
        manualMaxBid,
      );
      proposals.push({
        ...recommendation,
        reason: databaseReason(recommendation.reason),
        preconditionNotes: outcome.notes,
      });
      diagnostics.proposed += 1;
      diagnostics.preconditionNotes += outcome.notes.length;
      if (outcome.notes.length > 0) {
        example(diagnostics, target, 'proposed_with_note', outcome.notes.map((note) => note.message).join(' '));
      }
    } else if (outcome.kind === 'blocked') {
      diagnostics.blockedOutOfStock += 1;
      example(diagnostics, target, 'blocked', outcome.note);
    } else if (outcome.kind === 'suppressed') {
      diagnostics.suppressed += 1;
      diagnostics.preconditionNotes += outcome.notes.length;
      example(
        diagnostics,
        target,
        'suppressed',
        [outcome.suppressedReason, ...outcome.notes.map((note) => note.message)].join(' '),
      );
    } else {
      diagnostics.declined += 1;
      diagnostics.declinedReasons[outcome.reason] =
        (diagnostics.declinedReasons[outcome.reason] ?? 0) + 1;
      example(diagnostics, target, 'declined', outcome.reason);
    }
  }

  if (diagnostics.proposed !== proposals.length) {
    throw new Error(`Counted ${diagnostics.proposed} proposals but composed ${proposals.length}`);
  }
  return { proposals, diagnostics };
}

function rawEntitiesFrom(inputs: RecommendationRunInputs): RawEntity[] {
  const activeTargets = inputs.targets.filter(
    (target) =>
      target.entityState === 'enabled' &&
      target.campaignState === 'enabled' &&
      target.adGroupState === 'enabled',
  );
  const targetRows: RawEntity[] = activeTargets.map((target) => ({
    entity_type: target.entityRef.entityType,
    name: target.entityRef.name ?? target.entityRef.entityId,
    campaign_name: target.campaignName,
    campaign_id: target.entityRef.campaignId ?? null,
    category: target.category,
    match_type: target.matchType,
    impressions: target.metrics.impressions,
    clicks: target.metrics.clicks,
    spend: target.metrics.cost ?? 0,
    sales: target.metrics.sales,
    orders: target.metrics.orders,
    daily_budget: target.dailyBudget,
    budget_capped_days: 0,
  }));
  // Campaign rows come last because buildRecommendations' campaign rollup says
  // an explicit campaign grain wins over the target-derived aggregate.
  const campaignRows: RawEntity[] = inputs.campaigns
    .filter((campaign) => campaign.state === 'enabled')
    .map((campaign) => ({
      entity_type: 'campaign',
      name: campaign.campaignName,
      campaign_name: campaign.campaignName,
      campaign_id: campaign.campaignId,
      category: classifyCampaignCategory(campaign.campaignName),
      impressions: campaign.metrics.impressions,
      clicks: campaign.metrics.clicks,
      spend: campaign.metrics.cost ?? 0,
      sales: campaign.metrics.sales,
      orders: campaign.metrics.orders,
      daily_budget: campaign.dailyBudget,
      budget_capped_days: 0,
    }));
  return [...targetRows, ...campaignRows];
}

function rankRadarFrom(inputs: RecommendationRunInputs): RawRadarRow[] {
  const rows = new Map<string, RawRadarRow>();
  for (const target of inputs.targets) {
    if (target.entityRef.entityType !== 'keyword' || target.organicRank.status !== 'known') continue;
    const keyword = target.entityRef.name?.trim();
    if (!keyword) continue;
    rows.set(keyword.toLowerCase(), {
      keyword,
      rank_now: target.organicRank.currentRank,
      rank_prev: target.organicRank.previousRank,
      weeks_stable: 0,
    });
  }
  return [...rows.values()];
}

function aggregateBy(
  targets: readonly TargetPerformance[],
  keyOf: (target: TargetPerformance) => string,
): Map<string, LevelMetrics> {
  const out = new Map<string, LevelMetrics>();
  for (const target of targets) {
    const key = keyOf(target);
    if (!key) continue;
    const current = out.get(key) ?? { clicks: 0, orders: 0, sales: 0, cost: 0 };
    current.clicks += target.metrics.clicks;
    current.orders += target.metrics.orders;
    current.sales += target.metrics.sales;
    current.cost = (current.cost ?? 0) + (target.metrics.cost ?? 0);
    out.set(key, current);
  }
  return out;
}

function profileLevelMetrics(inputs: RecommendationRunInputs, window: DateWindow): LevelMetrics {
  const inWindow = inputs.profileFacts.filter((row) => row.date >= window.start && row.date <= window.end);
  if (inWindow.length > 0) {
    return inWindow.reduce<LevelMetrics>(
      (sum, row) => ({
        clicks: sum.clicks + row.clicks,
        orders: sum.orders + row.orders,
        sales: sum.sales + row.sales,
        cost: (sum.cost ?? 0) + (row.cost ?? 0),
      }),
      { clicks: 0, orders: 0, sales: 0, cost: 0 },
    );
  }
  return inputs.targets.reduce<LevelMetrics>(
    (sum, target) => ({
      clicks: sum.clicks + target.metrics.clicks,
      orders: sum.orders + target.metrics.orders,
      sales: sum.sales + target.metrics.sales,
      cost: (sum.cost ?? 0) + (target.metrics.cost ?? 0),
    }),
    { clicks: 0, orders: 0, sales: 0, cost: 0 },
  );
}

function optGroupName(strategy: TenantStrategy, category: string): string | null {
  const wanted = category.trim().toLowerCase();
  const names = Object.keys(strategy.opt_groups);
  const categoryMatch = category === CATEGORY_UNKNOWN
    ? undefined
    : names.find((name) => name.trim().toLowerCase() === wanted);
  if (categoryMatch) return categoryMatch;
  return names.find((name) => ['default', '*', 'all'].includes(name.trim().toLowerCase())) ?? null;
}

function boundValue(
  unit: 'absolute' | 'pct_of_recommended' | 'times_cpc' | undefined,
  value: number | undefined,
  recommended: number | null,
  cpc: number | null,
): number | null {
  if (unit === undefined || value === undefined) return null;
  if (unit === 'absolute') return value;
  if (unit === 'pct_of_recommended') return recommended === null ? null : recommended * value;
  return cpc === null ? null : cpc * value;
}

function toPacingCondition(pacing: PacingResult | null, goal: string): PacingCondition | null {
  if (pacing?.status === 'underpace') return 'under_pacing';
  if (pacing?.status === 'warn' || pacing?.status === 'act') return 'on_target';
  if (goal === 'rank-launch') return 'launch';
  return null;
}

function goalForGroupRole(role: OptimizationGroupSnapshot['role']): string {
  if (role === 'rank') return 'rank-launch';
  if (role === 'shield') return 'defend';
  if (role === 'profit') return 'profit-maintain';
  return 'scale';
}

function applyNonMechanicalBidAdjustment(
  recommendation: Recommendation,
  group: OptimizationGroupSnapshot | null,
  mechanicalStep: number | undefined,
  hardFloor: number | null,
  hardCeiling: number | null,
): Recommendation {
  if (
    group === null ||
    mechanicalStep === undefined ||
    recommendation.field !== 'bid' ||
    typeof recommendation.currentValue !== 'number' ||
    typeof recommendation.proposedValue !== 'number' ||
    recommendation.currentValue === recommendation.proposedValue
  ) {
    return recommendation;
  }
  const direction = recommendation.proposedValue > recommendation.currentValue
    ? 'increase'
    : 'decrease';
  const adjusted = adjustBidAwayFromMechanicalValue({
    group,
    currentValue: recommendation.currentValue,
    requestedValue: recommendation.proposedValue,
    direction,
    hardFloor,
    hardCeiling,
    mechanicalStep,
  });
  return {
    ...recommendation,
    proposedValue: adjusted.provenance.finalValue,
    inputs: {
      ...recommendation.inputs,
      directionalAdjustment: adjusted.provenance,
    },
  };
}

function hasCorridor(corridor: SuggestedBidCorridor | null): boolean {
  return corridor !== null &&
    (corridor.low !== null || corridor.median !== null || corridor.high !== null);
}

function example(
  diagnostics: ProposalDiagnostics,
  target: TargetPerformance,
  outcome: string,
  detail: string,
): void {
  if (diagnostics.examples.length >= 50) return;
  diagnostics.examples.push({ entity: target.entityRef.entityId, outcome, detail });
}

function safeDiv(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function firstOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

function numberOrNull(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function optimizationGroupFromWire(row: OptimizationGroupWireRow): ScheduledOptimizationGroup {
  return ScheduledOptimizationGroup.parse({
    version: 2,
    id: row.id,
    orgId: row.org_id,
    profileId: row.profile_id,
    name: row.name,
    role: row.role,
    targetAcos: Number(row.target_acos),
    bidFloor: numberOrNull(row.bid_floor),
    bidCeiling: numberOrNull(row.bid_ceiling),
    bidIncreaseCap: Number(row.bid_increase_cap),
    bidDecreaseCap: Number(row.bid_decrease_cap),
    placementIncreaseCap: Number(row.placement_increase_cap),
    placementDecreaseCap: Number(row.placement_decrease_cap),
    exclusions: row.exclusions,
    reviewSchedule: {
      version: 2,
      weekdays: optimizationWeekdaysFromIso(row.review_weekdays),
    },
    prioritization: row.prioritization,
    enabled: row.enabled,
  });
}

function toTimestamp(value: Date | string | null, field: string): string {
  if (value === null) throw new Error(`${field} is required`);
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${field} is invalid`);
  return parsed.toISOString();
}

function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value ?? null);
  if (serialized === undefined) throw new Error('Value must be JSON-serializable');
  return serialized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function bytewiseSorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function canonicalFingerprint(domain: string, values: readonly string[]): string {
  const hash = createHash('sha256');
  hash.update(`${domain}\n`);
  for (const value of values) {
    hash.update(`${Buffer.byteLength(value, 'utf8')}:`);
    hash.update(value);
    hash.update('\n');
  }
  return hash.digest('hex');
}

function requestFingerprint(
  profileId: string,
  mode: RecommendationPreviewSelection['mode'],
  campaignIds: readonly string[],
): string {
  return canonicalFingerprint(
    'openspell.recommendation-preview.request.v1',
    [profileId.toLowerCase(), mode, ...bytewiseSorted(campaignIds)],
  );
}

export function batchScopeFingerprint(profileId: string, campaignIds: readonly string[]): string {
  return canonicalFingerprint(
    'openspell.recommendation-preview.batch-scope.v1',
    [profileId.toLowerCase(), ...bytewiseSorted(campaignIds)],
  );
}

export function runScopeFingerprint(
  profileId: string,
  groupId: string | null,
  campaignIds: readonly string[],
): string {
  return canonicalFingerprint(
    'openspell.recommendation-preview.run-scope.v1',
    [profileId.toLowerCase(), groupId?.toLowerCase() ?? 'unassigned', ...bytewiseSorted(campaignIds)],
  );
}

interface ValidatedPreviewRequest {
  mode: 'all' | 'selected';
  campaignIds: string[];
  fingerprint: string;
}

function validatePreviewRequest(
  input: EnqueueRecommendationPreviewBatchInput,
): ValidatedPreviewRequest {
  if (!UUID_PATTERN.test(input.orgId) || !UUID_PATTERN.test(input.profileId) ||
      !UUID_PATTERN.test(input.actorId) || !UUID_PATTERN.test(input.clientRequestId)) {
    throw new RecommendationPreviewError('invalid_request', 400, 'Preview request identity is invalid.');
  }
  const requestBytes = Buffer.byteLength(serializeJson(input.scope), 'utf8');
  if (requestBytes > MAX_RECOMMENDATION_PREVIEW_REQUEST_BYTES) {
    throw new RecommendationPreviewError('invalid_request', 413, 'Preview selection is too large.');
  }
  if (input.scope.mode === 'all') {
    if ('campaignIds' in input.scope) {
      throw new RecommendationPreviewError(
        'invalid_request',
        400,
        'All-campaign previews must not include campaign ids.',
      );
    }
    return {
      mode: 'all',
      campaignIds: [],
      fingerprint: requestFingerprint(input.profileId, 'all', []),
    };
  }
  if (input.scope.mode !== 'selected' || !Array.isArray(input.scope.campaignIds)) {
    throw new RecommendationPreviewError('invalid_request', 400, 'Preview selection mode is invalid.');
  }
  const campaignIds = [...input.scope.campaignIds];
  if (campaignIds.length === 0 || campaignIds.length > MAX_RECOMMENDATION_PREVIEW_CAMPAIGNS) {
    throw new RecommendationPreviewError(
      'invalid_request',
      400,
      `Select between 1 and ${MAX_RECOMMENDATION_PREVIEW_CAMPAIGNS} campaigns.`,
    );
  }
  if (campaignIds.some((id) => typeof id !== 'string' || id.trim() === '')) {
    throw new RecommendationPreviewError('invalid_request', 400, 'Campaign ids must be non-empty strings.');
  }
  if (new Set(campaignIds).size !== campaignIds.length) {
    throw new RecommendationPreviewError('invalid_request', 400, 'Campaign selection contains duplicates.');
  }
  return {
    mode: 'selected',
    campaignIds: bytewiseSorted(campaignIds),
    fingerprint: requestFingerprint(input.profileId, 'selected', campaignIds),
  };
}

interface EligibleCampaignRow {
  campaign_id: string;
  group_id: string | null;
}

interface ResolvedStrategySnapshot {
  strategy: TenantStrategy;
  goal: string;
}

function recommendationPreviewChildStatus(
  runStatus: string,
  jobStatus: string,
): 'queued' | 'running' | 'succeeded' | 'failed' {
  if (jobStatus === 'dead' || jobStatus === 'failed') return 'failed';
  if (jobStatus === 'queued') return 'queued';
  if (jobStatus === 'running') return 'running';
  if (jobStatus === 'succeeded') return runStatus === 'succeeded' ? 'succeeded' : 'failed';
  throw new RecommendationScopeIntegrityError();
}

interface TargetWireRow {
  target_id: string;
  target_kind: 'keyword' | 'target';
  ad_product: AdProduct;
  campaign_id: string;
  ad_group_id: string;
  entity_name: string;
  campaign_name: string;
  ad_group_name: string | null;
  match_type: string | null;
  entity_state: string | null;
  campaign_state: string | null;
  ad_group_state: string | null;
  current_bid: string | number | null;
  daily_budget: string | number | null;
  advertised_asins: string[];
  rank_now: string | number | null;
  rank_prev: string | number | null;
  rank_asin: string | null;
  rank_observed_on: string | null;
  impressions: string | number;
  clicks: string | number;
  cost: string | number;
  orders: string | number;
  sales: string | number;
  corridor_date: string | null;
  suggested_bid_low: string | number | null;
  suggested_bid_median: string | number | null;
  suggested_bid_high: string | number | null;
  corridor_bid: string | number | null;
  corridor_cpc: string | number | null;
}

interface CampaignWireRow {
  ad_product: AdProduct;
  campaign_id: string;
  campaign_name: string;
  state: string | null;
  daily_budget: string | number | null;
  impressions: string | number;
  clicks: string | number;
  cost: string | number;
  orders: string | number;
  sales: string | number;
}

interface ProfileFactWireRow {
  date: string;
  impressions: string | number;
  clicks: string | number;
  cost: string | number;
  orders: string | number;
  sales: string | number;
}

function recommendationInputsFromWire(
  scope: RunScope,
  targetRows: readonly TargetWireRow[],
  campaignRows: readonly CampaignWireRow[],
  profileRows: readonly ProfileFactWireRow[],
): RecommendationRunInputs {
  return {
    // Scoped execution consumes the resolved enqueue-time snapshot returned
    // by startRun. Live strategy documents are intentionally not queried.
    tenantStrategy: null,
    profileStrategy: null,
    targets: targetRows.map((row) => {
      const entityType = row.target_kind;
      const entityRef: EntityRef = {
        profileId: scope.profileId,
        entityType,
        entityId: row.target_id,
        adProduct: row.ad_product,
        campaignId: row.campaign_id,
        adGroupId: row.ad_group_id,
        name: row.entity_name,
      };
      return {
        entityRef,
        campaignName: row.campaign_name,
        adGroupName: row.ad_group_name,
        category: classifyCampaignCategory(row.campaign_name),
        matchType: row.match_type,
        entityState: row.entity_state,
        campaignState: row.campaign_state,
        adGroupState: row.ad_group_state,
        currentBid: numberOrNull(row.current_bid),
        dailyBudget: numberOrNull(row.daily_budget),
        stock: {
          status: 'unknown',
          asins: row.advertised_asins,
          reason: 'No validated inventory field is synced for this profile.',
        },
        organicRank: entityType !== 'keyword'
          ? { status: 'not_applicable' }
          : row.rank_now === null
            ? { status: 'unknown', reason: 'No matching Rank Radar observation was found.' }
            : {
                status: 'known',
                currentRank: Number(row.rank_now),
                previousRank: numberOrNull(row.rank_prev),
                ...(row.rank_asin === null ? {} : { asin: row.rank_asin }),
                ...(row.rank_observed_on === null ? {} : { observedOn: row.rank_observed_on }),
              },
        metrics: {
          impressions: Number(row.impressions),
          clicks: Number(row.clicks),
          cost: Number(row.cost),
          orders: Number(row.orders),
          sales: Number(row.sales),
        },
        corridor: row.corridor_date === null ? null : {
          date: row.corridor_date,
          low: numberOrNull(row.suggested_bid_low),
          median: numberOrNull(row.suggested_bid_median),
          high: numberOrNull(row.suggested_bid_high),
          bid: numberOrNull(row.corridor_bid),
          cpc: numberOrNull(row.corridor_cpc),
        },
      };
    }),
    campaigns: campaignRows.map((row) => ({
      adProduct: row.ad_product,
      campaignId: row.campaign_id,
      campaignName: row.campaign_name,
      state: row.state,
      dailyBudget: numberOrNull(row.daily_budget),
      metrics: {
        impressions: Number(row.impressions),
        clicks: Number(row.clicks),
        cost: Number(row.cost),
        orders: Number(row.orders),
        sales: Number(row.sales),
      },
    })),
    profileFacts: profileRows.map((row) => ({
      date: row.date,
      impressions: Number(row.impressions),
      clicks: Number(row.clicks),
      cost: Number(row.cost),
      orders: Number(row.orders),
      sales: Number(row.sales),
    })),
  };
}

interface OptimizationGroupWireRow {
  id: string;
  org_id: string;
  profile_id: string;
  name: string;
  role: ScheduledOptimizationGroup['role'];
  target_acos: string | number;
  bid_floor: string | number | null;
  bid_ceiling: string | number | null;
  bid_increase_cap: string | number;
  bid_decrease_cap: string | number;
  placement_increase_cap: string | number;
  placement_decrease_cap: string | number;
  exclusions: string[];
  review_weekdays: number[];
  prioritization: ScheduledOptimizationGroup['prioritization'];
  enabled: boolean;
  next_run_at: Date | string | null;
  profile_timezone: string;
  review_hour: string | number;
}

async function readResolvedStrategySnapshot(
  sql: QuerySql,
  scope: ProfileScope,
): Promise<ResolvedStrategySnapshot> {
  const [profiles, strategies] = await Promise.all([
    sql<{ goal_lens: string | null }[]>`
      select goal_lens
        from public.ad_profiles
       where org_id = ${scope.orgId} and id = ${scope.profileId}
    `,
    sql<{ profile_id: string | null; doc: StrategyDocument }[]>`
      select profile_id, doc
        from public.profile_strategy
       where org_id = ${scope.orgId}
         and (profile_id is null or profile_id = ${scope.profileId})
    `,
  ]);
  const profile = profiles[0];
  if (profile === undefined) {
    throw new RecommendationPreviewError('invalid_request', 400, 'Advertising profile was not found.');
  }
  const resolved = resolveStrategy({
    goal: profile.goal_lens,
    tenant: strategies.find((row) => row.profile_id === null)?.doc ?? null,
    profile: strategies.find((row) => row.profile_id === scope.profileId)?.doc ?? null,
  });
  return { strategy: resolved.value, goal: resolved.goal };
}

async function readProfileOptimizationGroups(
  sql: QuerySql,
  scope: ProfileScope,
): Promise<Map<string, { group: ScheduledOptimizationGroup; wire: OptimizationGroupWireRow }>> {
  const rows = await sql<OptimizationGroupWireRow[]>`
    select g.id, g.org_id, g.profile_id, g.name, g.role::text as role, g.target_acos,
           g.bid_floor, g.bid_ceiling, g.bid_increase_cap, g.bid_decrease_cap,
           g.placement_increase_cap, g.placement_decrease_cap, g.exclusions,
           g.review_weekdays, g.prioritization::text as prioritization,
           g.enabled, g.next_run_at, p.timezone as profile_timezone,
           coalesce(p.preferred_sync_hour, 4) as review_hour
      from public.optimization_groups g
      join public.ad_profiles p on p.org_id = g.org_id and p.id = g.profile_id
     where g.org_id = ${scope.orgId} and g.profile_id = ${scope.profileId}
     order by g.id
     for update of g
  `;
  return new Map(rows.map((wire) => [wire.id, { group: optimizationGroupFromWire(wire), wire }]));
}

async function readEligibleCampaigns(
  sql: QuerySql,
  scope: ProfileScope,
  selectedIds?: readonly string[],
): Promise<EligibleCampaignRow[]> {
  return sql<EligibleCampaignRow[]>`
    select campaign.amazon_id as campaign_id, assignment.group_id
      from public.campaigns campaign
      left join public.campaign_optimization_assignments assignment
        on assignment.org_id = campaign.org_id
       and assignment.profile_id = campaign.profile_id
       and assignment.campaign_id = campaign.amazon_id
      left join public.optimization_groups optimization_group
        on optimization_group.org_id = assignment.org_id
       and optimization_group.profile_id = assignment.profile_id
       and optimization_group.id = assignment.group_id
     where campaign.org_id = ${scope.orgId}
       and campaign.profile_id = ${scope.profileId}
       and campaign.ad_product = 'SP'
       and campaign.state = 'enabled'
       and campaign.deleted_at is null
       and (${selectedIds === undefined} or campaign.amazon_id = any (${selectedIds ?? []}::text[]))
       and (assignment.group_id is null or optimization_group.enabled)
     order by campaign.amazon_id collate "C"
  `;
}

interface InsertScopedRecommendationRunInput extends ProfileScope {
  batchId: string | null;
  campaignIds: readonly string[];
  group: ScheduledOptimizationGroup | null;
  strategy: ResolvedStrategySnapshot;
  lookbackDays: number;
  source: 'schedule' | 'web';
  runAfter: string;
  delay?: string;
  dueAt: string | null;
  scheduleContext: ReturnType<typeof OptimizationRunScheduleContext.parse> | null;
}

async function insertScopedRecommendationRun(
  sql: QuerySql,
  input: InsertScopedRecommendationRunInput,
): Promise<QueuedRecommendationRun> {
  const campaignIds = bytewiseSorted(input.campaignIds);
  if (campaignIds.length === 0 || campaignIds.length > MAX_RECOMMENDATION_PREVIEW_CAMPAIGNS ||
      new Set(campaignIds).size !== campaignIds.length) {
    throw new RecommendationScopeIntegrityError();
  }
  const runId = randomUUID();
  const jobId = randomUUID();
  const fingerprint = runScopeFingerprint(input.profileId, input.group?.id ?? null, campaignIds);
  const payload = {
    type: 'recommendations.run' as const,
    orgId: input.orgId,
    profileId: input.profileId,
    runId,
    lookbackDays: input.lookbackDays,
    ...(input.group === null ? {} : { groupId: input.group.id }),
  };
  RecommendationsRunJob.parse(payload);

  const jobs = await sql<{ id: string }[]>`
    insert into public.sync_jobs
      (id, org_id, profile_id, job_type, payload, priority, dedupe_key, run_after)
    values (${jobId}, ${input.orgId}, ${input.profileId}, 'recommendations.run',
            ${serializeJson(payload)}::text::jsonb,
            ${input.source === 'schedule' ? RECOMMENDATION_SCHEDULE_PRIORITY : 100},
            ${`recommendations.run:${runId}`},
            ${input.runAfter}::timestamptz + ${input.delay ?? '0 seconds'}::interval)
    returning id
  `;
  if (jobs.length !== 1 || jobs[0]?.id !== jobId) {
    throw new RecommendationScopeIntegrityError();
  }

  const runs = await sql<{ id: string }[]>`
    insert into public.recommendation_runs
      (id, org_id, profile_id, status, lookback_days, engine_version,
       strategy_snapshot, strategy_goal, group_id, group_role, group_snapshot,
       due_at, schedule_context, batch_id, scope_version, scope_count,
       scope_fingerprint, job_id, execution_lineage)
    values (${runId}, ${input.orgId}, ${input.profileId}, 'queued', ${input.lookbackDays},
            ${RECOMMENDATIONS_ENGINE_VERSION},
            ${serializeJson(input.strategy.strategy)}::text::jsonb, ${input.strategy.goal},
            ${input.group?.id ?? null},
            ${input.group?.role ?? null}::public.optimization_group_role,
            ${input.group === null ? null : serializeJson(input.group)}::text::jsonb,
            ${input.dueAt}::timestamptz,
            ${input.scheduleContext === null ? null : serializeJson(input.scheduleContext)}::text::jsonb,
            ${input.batchId}::uuid, ${RECOMMENDATION_SCOPE_VERSION}, ${campaignIds.length},
            ${fingerprint}, ${jobId}, 'queue')
    returning id
  `;
  if (runs.length !== 1 || runs[0]?.id !== runId) {
    throw new RecommendationScopeIntegrityError();
  }

  const inserted = await sql<{ campaign_id: string }[]>`
    insert into public.recommendation_run_campaigns
      (org_id, profile_id, batch_id, run_id, campaign_id)
    select ${input.orgId}, ${input.profileId}, ${input.batchId}::uuid, ${runId}, offered.campaign_id
      from unnest(${campaignIds}::text[]) as offered(campaign_id)
    returning campaign_id
  `;
  const readback = await sql<{ campaign_id: string }[]>`
    select campaign_id
      from public.recommendation_run_campaigns
     where org_id = ${input.orgId} and profile_id = ${input.profileId} and run_id = ${runId}
     order by campaign_id collate "C"
  `;
  const readIds = readback.map((row) => row.campaign_id);
  if (
    inserted.length !== campaignIds.length || readIds.length !== campaignIds.length ||
    new Set(readIds).size !== readIds.length ||
    runScopeFingerprint(input.profileId, input.group?.id ?? null, readIds) !== fingerprint
  ) {
    throw new RecommendationScopeIntegrityError();
  }
  return { runId, jobId };
}

/** Postgres implementation: storage representations never leave this class. */
export class PostgresRecommendationRunStore
implements RecommendationRunStore, RecommendationScheduleStore {
  constructor(readonly handle: DbHandle) {}

  async startRun(
    scope: RunScope,
    expectedGroupId: string | undefined,
    execution: RecommendationRunExecutionContext,
  ): Promise<StartRunResult> {
    const expectedJobId = executionJobId(execution);
    return this.handle.sql.begin(async (sql) => {
      const rows = await sql<{
        status: string;
        proposals_count: number;
        lookback_days: number;
        batch_id: string | null;
        group_id: string | null;
        group_role: string | null;
        group_snapshot: unknown;
        due_at: Date | string | null;
        schedule_context: unknown;
        strategy_snapshot: unknown;
        strategy_goal: string | null;
        scope_version: number | null;
        scope_count: number | null;
        scope_fingerprint: string | null;
        job_id: string | null;
      }[]>`
        select status::text as status, proposals_count, lookback_days, batch_id,
               group_id, group_role::text as group_role, group_snapshot, due_at, schedule_context,
               strategy_snapshot, strategy_goal, scope_version, scope_count,
               scope_fingerprint, job_id
          from public.recommendation_runs
         where id = ${scope.runId}
           and org_id = ${scope.orgId}
           and profile_id = ${scope.profileId}
         for update
      `;
      const run = rows[0];
      if (!run) throw new Error(`No scoped recommendation run ${scope.runId}`);
      if (run.job_id !== expectedJobId) {
        throw new RecommendationExecutionCustodyError();
      }
      if ((run.group_id ?? undefined) !== expectedGroupId) {
        throw new RecommendationScopeIntegrityError();
      }
      if (
        run.scope_version !== RECOMMENDATION_SCOPE_VERSION ||
        run.scope_count === null || run.scope_count <= 0 ||
        run.scope_fingerprint === null || run.job_id === null ||
        run.strategy_snapshot === null || run.strategy_goal === null
      ) {
        throw new RecommendationScopeIntegrityError();
      }
      let groupRun: RecommendationGroupRun | null;
      let strategySnapshot: TenantStrategy;
      try {
        groupRun = run.group_id === null
          ? null
          : (() => {
              const snapshot = normalizeOptimizationGroupSnapshot(run.group_snapshot);
              const scheduleContext = run.schedule_context === null
                ? null
                : OptimizationRunScheduleContext.parse(run.schedule_context);
              if (snapshot.version !== 2 || scheduleContext === null) {
                throw new RecommendationScopeIntegrityError();
              }
              return {
                group: snapshot.group,
                dueAt: toTimestamp(run.due_at, 'group run due_at'),
                scheduleContext,
              };
            })();
        if (
          groupRun !== null &&
          (
            groupRun.group.id !== run.group_id ||
            groupRun.group.role !== run.group_role ||
            groupRun.group.orgId !== scope.orgId ||
            groupRun.group.profileId !== scope.profileId
          )
        ) {
          throw new RecommendationScopeIntegrityError();
        }
        strategySnapshot = TenantStrategy.parse(run.strategy_snapshot);
      } catch (error) {
        if (error instanceof RecommendationScopeIntegrityError) throw error;
        throw new RecommendationScopeIntegrityError();
      }

      const [jobRows, scopeRows] = await Promise.all([
        sql<{ job_type: string; payload: unknown; status: string }[]>`
          select job_type::text as job_type, payload, status::text as status
            from public.sync_jobs
           where id = ${run.job_id}
             and org_id = ${scope.orgId}
             and profile_id = ${scope.profileId}
        `,
        sql<{ batch_id: string | null; campaign_id: string }[]>`
          select batch_id, campaign_id
            from public.recommendation_run_campaigns
           where org_id = ${scope.orgId}
             and profile_id = ${scope.profileId}
             and run_id = ${scope.runId}
           order by campaign_id collate "C"
        `,
      ]);
      const job = jobRows[0];
      const parsedJob = job === undefined ? null : RecommendationsRunJob.safeParse(job.payload);
      if (
        jobRows.length !== 1 || job?.job_type !== 'recommendations.run' || job.status !== 'running' ||
        parsedJob === null || !parsedJob.success ||
        parsedJob.data.orgId !== scope.orgId || parsedJob.data.profileId !== scope.profileId ||
        parsedJob.data.runId !== scope.runId || parsedJob.data.lookbackDays !== run.lookback_days ||
        (parsedJob.data.groupId ?? undefined) !== expectedGroupId
      ) {
        throw new RecommendationScopeIntegrityError();
      }
      const campaignIds = scopeRows.map((row) => row.campaign_id);
      const fingerprint = runScopeFingerprint(scope.profileId, run.group_id, campaignIds);
      if (
        scopeRows.length !== run.scope_count ||
        scopeRows.some((row) => row.batch_id !== run.batch_id) ||
        new Set(campaignIds).size !== campaignIds.length ||
        fingerprint !== run.scope_fingerprint
      ) {
        throw new RecommendationScopeIntegrityError();
      }
      if (run.status === 'succeeded') {
        return {
          alreadySucceeded: true,
          proposalsCount: Number(run.proposals_count),
          groupRun,
          strategySnapshot,
          strategyGoal: run.strategy_goal,
        };
      }
      const updated = await sql<{ id: string }[]>`
        update public.recommendation_runs
           set status = 'running', started_at = coalesce(started_at, now()),
               finished_at = null, error = null
         where id = ${scope.runId}
           and org_id = ${scope.orgId}
           and profile_id = ${scope.profileId}
        returning id
      `;
      if (updated.length !== 1) throw new Error(`Started 0 of 1 recommendation runs`);
      return {
        alreadySucceeded: false,
        proposalsCount: 0,
        groupRun,
        strategySnapshot,
        strategyGoal: run.strategy_goal,
      };
    });
  }

  async loadProfile(
    scope: ProfileScope,
    _execution: RecommendationRunExecutionContext,
  ): Promise<RecommendationProfile> {
    const rows = await this.handle.sql<{
      timezone: string;
      goal_lens: string | null;
      monthly_budget: string | number | null;
    }[]>`
      select timezone, goal_lens, monthly_budget
        from public.ad_profiles
       where org_id = ${scope.orgId} and id = ${scope.profileId}
    `;
    const row = rows[0];
    if (!row) throw new Error(`No scoped advertising profile ${scope.profileId}`);
    return {
      ...scope,
      timezone: row.timezone,
      goal: row.goal_lens,
      monthlyBudget: numberOrNull(row.monthly_budget),
    };
  }

  async loadInputs(
    scope: RunScope,
    window: DateWindow,
    _execution: RecommendationRunExecutionContext,
  ): Promise<RecommendationRunInputs> {
    const profileFactsFrom = firstOfMonth(window.end) < window.start
      ? firstOfMonth(window.end)
      : window.start;
    const [targetRows, campaignRows, profileRows] = await Promise.all([
      this.handle.sql<TargetWireRow[]>`
        with performance as (
          select f.target_id,
                 f.target_kind::text as target_kind,
                 min(f.ad_product::text) as ad_product,
                 f.campaign_id,
                 f.ad_group_id,
                 max(f.match_type::text) as fact_match_type,
                 sum(f.impressions)::bigint as impressions,
                 sum(f.clicks)::bigint as clicks,
                 sum(f.cost) as cost,
                 sum(f.purchases_7d)::bigint as orders,
                 sum(f.sales_7d) as sales
            from public.fact_sp_target_daily f
           where f.org_id = ${scope.orgId}
             and f.profile_id = ${scope.profileId}
             and f.date between ${window.start} and ${window.end}
             and exists (
               select 1 from public.recommendation_run_campaigns run_campaign
                where run_campaign.org_id = ${scope.orgId}
                  and run_campaign.profile_id = ${scope.profileId}
                  and run_campaign.run_id = ${scope.runId}
                  and run_campaign.campaign_id = f.campaign_id
             )
           group by f.target_id, f.target_kind, f.campaign_id, f.ad_group_id
        )
        select p.target_id,
               p.target_kind,
               p.ad_product::public.ad_product as ad_product,
               p.campaign_id,
               p.ad_group_id,
               coalesce(k.keyword_text, t.resolved_expression, k.name, t.name, p.target_id) as entity_name,
               coalesce(c.name, p.campaign_id) as campaign_name,
               a.name as ad_group_name,
               coalesce(k.match_type::text, p.fact_match_type) as match_type,
               case
                 when coalesce(k.deleted_at, t.deleted_at) is not null then 'deleted'
                 else coalesce(k.state::text, t.state::text)
               end as entity_state,
               case when c.deleted_at is not null then 'deleted' else c.state::text end as campaign_state,
               case when a.deleted_at is not null then 'deleted' else a.state::text end as ad_group_state,
               coalesce(k.bid, t.bid) as current_bid,
               c.budget_amount as daily_budget,
               coalesce(ads.advertised_asins, '{}'::text[]) as advertised_asins,
               radar.rank_now,
               radar.rank_prev,
               radar.rank_asin,
               radar.rank_observed_on::text as rank_observed_on,
               p.impressions,
               p.clicks,
               p.cost,
               p.orders,
               p.sales,
               corridor.date::text as corridor_date,
               corridor.suggested_bid_low,
               corridor.suggested_bid_median,
               corridor.suggested_bid_high,
               corridor.bid as corridor_bid,
               corridor.cpc as corridor_cpc
          from performance p
          left join public.campaigns c
            on c.org_id = ${scope.orgId}
           and c.profile_id = ${scope.profileId}
           and c.amazon_id = p.campaign_id
          left join public.ad_groups a
            on a.org_id = ${scope.orgId}
           and a.profile_id = ${scope.profileId}
           and a.amazon_id = p.ad_group_id
          left join public.keywords k
            on p.target_kind = 'keyword'
           and k.org_id = ${scope.orgId}
           and k.profile_id = ${scope.profileId}
           and k.amazon_id = p.target_id
          left join public.targets t
            on p.target_kind = 'target'
           and t.org_id = ${scope.orgId}
           and t.profile_id = ${scope.profileId}
           and t.amazon_id = p.target_id
          left join lateral (
            select array_agg(distinct pa.asin order by pa.asin)
                     filter (where pa.asin is not null) as advertised_asins
              from public.product_ads pa
             where pa.org_id = ${scope.orgId}
               and pa.profile_id = ${scope.profileId}
               and pa.campaign_id = p.campaign_id
               and pa.ad_group_id = p.ad_group_id
               and pa.deleted_at is null
               and pa.state = 'enabled'
          ) ads on true
          left join lateral (
            select candidate.rank_now,
                   candidate.rank_prev,
                   candidate.rank_asin,
                   candidate.rank_observed_on
              from (
                select current.organic_rank as rank_now,
                       previous.organic_rank as rank_prev,
                       current.asin as rank_asin,
                       current.observed_on as rank_observed_on,
                       current.id as rank_id
                  from public.rank_observations current
                  left join lateral (
                    select prior.organic_rank
                      from public.rank_observations prior
                     where prior.org_id = ${scope.orgId}
                       and prior.profile_id = ${scope.profileId}
                       and prior.source = current.source
                       and prior.asin = current.asin
                       and lower(prior.keyword) = lower(current.keyword)
                       and prior.organic_rank is not null
                       and prior.observed_on < current.observed_on
                     order by prior.observed_on desc, prior.id desc
                     limit 1
                  ) previous on true
                 where p.target_kind = 'keyword'
                   and current.org_id = ${scope.orgId}
                   and current.profile_id = ${scope.profileId}
                   and current.source = 'rank_radar'
                   and current.asin = any(coalesce(ads.advertised_asins, '{}'::text[]))
                   and lower(current.keyword) = lower(coalesce(k.keyword_text, k.name, p.target_id))
                   and current.organic_rank is not null
                   and current.observed_on <= ${window.end}::date
              ) candidate
             order by (candidate.rank_prev is not null and candidate.rank_now < candidate.rank_prev) desc,
                      candidate.rank_observed_on desc,
                      candidate.rank_id desc
             limit 1
          ) radar on true
          left join lateral (
            select b.date, b.suggested_bid_low, b.suggested_bid_median,
                   b.suggested_bid_high, b.bid, b.cpc
              from public.bid_series_daily b
             where b.org_id = ${scope.orgId}
               and b.profile_id = ${scope.profileId}
               and b.target_id = p.target_id
               and b.campaign_id = p.campaign_id
               and b.ad_group_id = p.ad_group_id
               and b.is_keyword = (p.target_kind = 'keyword')
             order by b.date desc
             limit 1
          ) corridor on true
         order by p.campaign_id, p.ad_group_id, p.target_id
      `,
      this.handle.sql<CampaignWireRow[]>`
        with campaign_facts as (
          select 'SP'::text as ad_product, f.campaign_id,
                 sum(f.impressions)::bigint as impressions,
                 sum(f.clicks)::bigint as clicks,
                 sum(f.cost) as cost,
                 sum(f.purchases_7d)::bigint as orders,
                 sum(f.sales_7d) as sales
            from public.fact_sp_target_daily f
           where f.org_id = ${scope.orgId}
             and f.profile_id = ${scope.profileId}
             and f.date between ${window.start} and ${window.end}
             and exists (
               select 1 from public.recommendation_run_campaigns run_campaign
                where run_campaign.org_id = ${scope.orgId}
                  and run_campaign.profile_id = ${scope.profileId}
                  and run_campaign.run_id = ${scope.runId}
                  and run_campaign.campaign_id = f.campaign_id
             )
           group by f.campaign_id
          union all
          select 'SB', f.campaign_id, sum(f.impressions)::bigint, sum(f.clicks)::bigint,
                 sum(f.cost), sum(f.purchases_7d)::bigint, sum(f.sales_7d)
            from public.fact_sb_daily f
           where f.org_id = ${scope.orgId}
             and f.profile_id = ${scope.profileId}
             and f.date between ${window.start} and ${window.end}
             and exists (
               select 1 from public.recommendation_run_campaigns run_campaign
                where run_campaign.org_id = ${scope.orgId}
                  and run_campaign.profile_id = ${scope.profileId}
                  and run_campaign.run_id = ${scope.runId}
                  and run_campaign.campaign_id = f.campaign_id
             )
           group by f.campaign_id
          union all
          select 'SD', f.campaign_id, sum(f.impressions)::bigint, sum(f.clicks)::bigint,
                 sum(f.cost), sum(f.purchases_7d)::bigint, sum(f.sales_7d)
            from public.fact_sd_daily f
           where f.org_id = ${scope.orgId}
             and f.profile_id = ${scope.profileId}
             and f.date between ${window.start} and ${window.end}
             and exists (
               select 1 from public.recommendation_run_campaigns run_campaign
                where run_campaign.org_id = ${scope.orgId}
                  and run_campaign.profile_id = ${scope.profileId}
                  and run_campaign.run_id = ${scope.runId}
                  and run_campaign.campaign_id = f.campaign_id
             )
           group by f.campaign_id
        )
        select f.ad_product::public.ad_product as ad_product,
               f.campaign_id,
               coalesce(c.name, f.campaign_id) as campaign_name,
               case when c.deleted_at is not null then 'deleted' else c.state::text end as state,
               c.budget_amount as daily_budget,
               f.impressions, f.clicks, f.cost, f.orders, f.sales
          from campaign_facts f
          left join public.campaigns c
            on c.org_id = ${scope.orgId}
           and c.profile_id = ${scope.profileId}
           and c.amazon_id = f.campaign_id
         order by f.ad_product, f.campaign_id
      `,
      this.handle.sql<ProfileFactWireRow[]>`
        select date::text as date, impressions, clicks, cost,
               purchases_7d as orders, sales_7d as sales
          from public.fact_profile_daily
         where org_id = ${scope.orgId}
           and profile_id = ${scope.profileId}
           and date between ${profileFactsFrom} and ${window.end}
         order by date
      `,
    ]);

    return recommendationInputsFromWire(scope, targetRows, campaignRows, profileRows);
  }

  async loadGroupRecommendationSafety(
    scope: ProfileScope,
    groupId: string,
    _execution: RecommendationRunExecutionContext,
  ): Promise<GroupRecommendationSafety> {
    return readGroupRecommendationSafety(this.handle.sql, scope, groupId);
  }

  async succeedRun(
    completion: RunCompletion,
    _execution: RecommendationRunExecutionContext,
  ): Promise<number> {
    return this.handle.sql.begin(async (sql) => {
      const runs = await sql<{ status: string; proposals_count: number }[]>`
        select status::text as status, proposals_count
          from public.recommendation_runs
         where id = ${completion.runId}
           and org_id = ${completion.orgId}
           and profile_id = ${completion.profileId}
         for update
      `;
      const run = runs[0];
      if (!run) throw new Error(`No scoped recommendation run ${completion.runId}`);
      if (run.status === 'succeeded') return Number(run.proposals_count);
      if (run.status !== 'running') {
        throw new Error(`Recommendation run ${completion.runId} is ${run.status}, not running`);
      }

      const wire = completion.proposals.map((proposal) => ({
        reason: proposal.reason,
        entity_type: proposal.entityRef.entityType,
        entity_id: proposal.entityRef.entityId,
        ad_product: proposal.entityRef.adProduct ?? null,
        campaign_id: proposal.entityRef.campaignId ?? null,
        ad_group_id: proposal.entityRef.adGroupId ?? null,
        entity_name: proposal.entityRef.name ?? null,
        field: proposal.field,
        current_value: proposal.currentValue,
        proposed_value: proposal.proposedValue,
        inputs: proposal.inputs,
      }));
      const inserted = wire.length === 0
        ? []
        : await sql<{ id: string }[]>`
            insert into public.recommendations
              (run_id, org_id, profile_id, reason, entity_type, entity_id, ad_product,
               campaign_id, ad_group_id, entity_name, field, current_value, proposed_value,
               inputs, status)
            select ${completion.runId}, ${completion.orgId}, ${completion.profileId},
                   offered.reason::public.recommendation_reason,
                   offered.entity_type::public.entity_type,
                   offered.entity_id,
                   offered.ad_product::public.ad_product,
                   offered.campaign_id,
                   offered.ad_group_id,
                   offered.entity_name,
                   offered.field,
                   offered.current_value,
                   offered.proposed_value,
                   offered.inputs,
                   'proposed'::public.recommendation_status
              from jsonb_to_recordset(${serializeJson(wire)}::text::jsonb) as offered(
                reason text,
                entity_type text,
                entity_id text,
                ad_product text,
                campaign_id text,
                ad_group_id text,
                entity_name text,
                field text,
                current_value jsonb,
                proposed_value jsonb,
                inputs jsonb
              )
            returning id
          `;
      if (inserted.length !== completion.proposals.length) {
        throw new Error(`Offered ${completion.proposals.length} recommendations, wrote ${inserted.length}`);
      }

      const annotated = completion.proposals
        .filter((proposal) => proposal.preconditionNotes.length > 0)
        .map((proposal) => ({
          entity_type: proposal.entityRef.entityType,
          entity_id: proposal.entityRef.entityId,
          field: proposal.field,
          note: proposal.preconditionNotes.map((entry) => entry.message).join(' '),
          codes: proposal.preconditionNotes.map((entry) => entry.code),
        }));
      const noteRows = annotated.length === 0
        ? []
        : await sql<{ id: number }[]>`
            insert into public.audit_log
              (org_id, actor_type, action, target_type, target_id, payload, source)
            select ${completion.orgId}, 'service', 'recommendation.preconditions.noted',
                   'recommendation', recommendation.id::text,
                   jsonb_build_object('note', offered.note, 'codes', offered.codes),
                   'worker'
              from jsonb_to_recordset(${serializeJson(annotated)}::text::jsonb) as offered(
                entity_type text,
                entity_id text,
                field text,
                note text,
                codes jsonb
              )
              join public.recommendations recommendation
                on recommendation.run_id = ${completion.runId}
               and recommendation.org_id = ${completion.orgId}
               and recommendation.profile_id = ${completion.profileId}
               and recommendation.entity_type::text = offered.entity_type
               and recommendation.entity_id = offered.entity_id
               and recommendation.field = offered.field
            returning id
          `;
      if (noteRows.length !== annotated.length) {
        throw new Error(`Offered ${annotated.length} recommendation precondition notes, wrote ${noteRows.length}`);
      }

      const updated = await sql<{ id: string }[]>`
        update public.recommendation_runs
           set status = 'succeeded',
               lookback_days = ${completion.lookbackDays},
               window_start = ${completion.window.start}::date,
               window_end = ${completion.window.end}::date,
               engine_version = ${RECOMMENDATIONS_ENGINE_VERSION},
               proposals_count = ${inserted.length},
               finished_at = now(),
               error = null
         where id = ${completion.runId}
           and org_id = ${completion.orgId}
           and profile_id = ${completion.profileId}
        returning id
      `;
      if (updated.length !== 1) throw new Error('Succeeded 0 of 1 recommendation runs');

      await sql`
        insert into public.audit_log
          (org_id, actor_type, action, target_type, target_id, payload, source)
        values (${completion.orgId}, 'service', 'recommendation.run.succeeded',
                'recommendation_run', ${completion.runId},
                ${serializeJson({
                  engineVersion: RECOMMENDATIONS_ENGINE_VERSION,
                  proposals: inserted.length,
                  narrative: completion.narrative,
                })}::text::jsonb,
                'worker')
      `;
      return inserted.length;
    });
  }

  async failRun(
    scope: RunScope,
    error: string,
    _execution: RecommendationRunExecutionContext,
  ): Promise<RecommendationRunFailureResult> {
    return this.handle.sql.begin(async (sql): Promise<RecommendationRunFailureResult> => {
      const updated = await sql<{ id: string }[]>`
        update public.recommendation_runs
           set status = 'failed', finished_at = now(), error = ${error}
         where id = ${scope.runId}
           and org_id = ${scope.orgId}
           and profile_id = ${scope.profileId}
           and status <> 'succeeded'
        returning id
      `;
      if (updated.length !== 1) {
        const [existing] = await sql<{ status: string; proposals_count: number }[]>`
          select status::text as status, proposals_count
            from public.recommendation_runs
           where id = ${scope.runId}
             and org_id = ${scope.orgId}
             and profile_id = ${scope.profileId}
        `;
        if (existing?.status === 'succeeded') {
          return { decision: 'already_succeeded', proposalsCount: existing.proposals_count };
        }
        throw new Error('Failed 0 of 1 recommendation runs');
      }
      await sql`
        insert into public.audit_log
          (org_id, actor_type, action, target_type, target_id, payload, source)
        values (${scope.orgId}, 'service', 'recommendation.run.failed',
                'recommendation_run', ${scope.runId},
                ${serializeJson({ error })}::text::jsonb, 'worker')
      `;
      return { decision: 'failed' };
    });
  }

  async enqueueRecommendationPreviewBatch(
    input: EnqueueRecommendationPreviewBatchInput,
  ): Promise<RecommendationPreviewAccepted> {
    const validated = validatePreviewRequest(input);
    const lookbackDays = input.lookbackDays ?? DEFAULT_RECOMMENDATION_LOOKBACK_DAYS;
    if (!Number.isInteger(lookbackDays) || lookbackDays <= 0) {
      throw new RecommendationPreviewError('invalid_request', 400, 'Lookback must be a positive integer.');
    }
    const runAt = input.runAt ?? new Date();
    if (Number.isNaN(runAt.getTime())) {
      throw new RecommendationPreviewError('invalid_request', 400, 'Preview run time is invalid.');
    }
    const requestedAt = runAt.toISOString();

    return this.handle.sql.begin(async (sql) => {
      const profiles = await sql<{ id: string }[]>`
        select id from public.ad_profiles
         where org_id = ${input.orgId} and id = ${input.profileId}
         for update
      `;
      if (profiles.length !== 1) {
        throw new RecommendationPreviewError('invalid_request', 400, 'Advertising profile was not found.');
      }

      const existing = await sql<{
        id: string;
        selection_mode: 'all' | 'selected';
        request_fingerprint: string;
        scope_count: number;
        scope_fingerprint: string;
        child_count: number;
      }[]>`
        select id, selection_mode, request_fingerprint, scope_count, scope_fingerprint, child_count
          from public.recommendation_preview_batches
         where org_id = ${input.orgId}
           and profile_id = ${input.profileId}
           and client_request_id = ${input.clientRequestId}
      `;
      if (existing.length > 0) {
        const batch = existing[0];
        if (existing.length !== 1 || batch === undefined ||
            batch.request_fingerprint !== validated.fingerprint) {
          throw new RecommendationPreviewError(
            'idempotency_conflict',
            409,
            'This preview request identity was already used for different input.',
          );
        }
        return {
          batchId: batch.id,
          status: 'queued' as const,
          scope: {
            mode: batch.selection_mode,
            campaignCount: Number(batch.scope_count),
            fingerprint: batch.scope_fingerprint,
          },
          childCount: Number(batch.child_count),
        };
      }

      const eligible = await readEligibleCampaigns(
        sql,
        input,
        validated.mode === 'selected' ? validated.campaignIds : undefined,
      );
      if (validated.mode === 'selected' && eligible.length !== validated.campaignIds.length) {
        throw new RecommendationPreviewError(
          'stale_selection',
          409,
          'Campaign selection is stale or no longer eligible. Refresh and select again.',
        );
      }
      if (eligible.length === 0) {
        throw new RecommendationPreviewError(
          'stale_selection',
          409,
          'No eligible campaigns are available for this preview.',
        );
      }
      if (eligible.length > MAX_RECOMMENDATION_PREVIEW_CAMPAIGNS) {
        throw new RecommendationPreviewError(
          'invalid_request',
          422,
          'The eligible campaign roster is too large for one preview.',
        );
      }
      const effectiveIds = bytewiseSorted(eligible.map((row) => row.campaign_id));
      if (new Set(effectiveIds).size !== effectiveIds.length) {
        throw new RecommendationScopeIntegrityError();
      }

      const groups = await readProfileOptimizationGroups(sql, input);
      const partitions = new Map<string | null, string[]>();
      for (const row of eligible) {
        if (row.group_id !== null) {
          const resolvedGroup = groups.get(row.group_id)?.group;
          if (resolvedGroup === undefined || !resolvedGroup.enabled) {
            throw new RecommendationPreviewError(
              'stale_selection',
              409,
              'Campaign selection is stale or no longer eligible. Refresh and select again.',
            );
          }
        }
        const current = partitions.get(row.group_id) ?? [];
        current.push(row.campaign_id);
        partitions.set(row.group_id, current);
      }

      const active = await sql<{ group_id: string | null }[]>`
        select run.group_id
          from public.recommendation_runs run
          left join public.sync_jobs job
            on job.org_id = run.org_id
           and job.profile_id = run.profile_id
           and job.id = run.job_id
         where run.org_id = ${input.orgId} and run.profile_id = ${input.profileId}
           and (
             (run.job_id is not null and job.status in ('queued', 'running'))
             or
             (run.job_id is null and run.status in ('queued', 'running'))
           )
      `;
      if (active.some((row) => partitions.has(row.group_id))) {
        throw new RecommendationPreviewError(
          'active_run_conflict',
          409,
          'One selected optimization scope already has a queued or running preview.',
        );
      }
      for (const groupId of partitions.keys()) {
        if (groupId === null) continue;
        const safety = await readGroupRecommendationSafety(sql, input, groupId);
        if (!safety.mayPropose) {
          throw new RecommendationPreviewError(
            'safety_hold',
            409,
            'One selected optimization group is held by its recommendation safety policy.',
          );
        }
      }

      let strategy: ResolvedStrategySnapshot;
      try {
        strategy = await readResolvedStrategySnapshot(sql, input);
      } catch (error) {
        if (error instanceof RecommendationPreviewError) throw error;
        throw new RecommendationPreviewError(
          'safety_hold',
          422,
          'The profile strategy cannot be resolved for a preview.',
        );
      }
      const batchId = randomUUID();
      const effectiveFingerprint = batchScopeFingerprint(input.profileId, effectiveIds);
      const orderedPartitions = [...partitions.entries()].sort(([left], [right]) => {
        if (left === null) return 1;
        if (right === null) return -1;
        return Buffer.compare(Buffer.from(left), Buffer.from(right));
      });
      const batches = await sql<{ id: string }[]>`
        insert into public.recommendation_preview_batches
          (id, org_id, profile_id, client_request_id, selection_mode,
           request_fingerprint, scope_count, scope_fingerprint, child_count, created_by)
        values (${batchId}, ${input.orgId}, ${input.profileId}, ${input.clientRequestId},
                ${validated.mode}, ${validated.fingerprint}, ${effectiveIds.length},
                ${effectiveFingerprint}, ${orderedPartitions.length}, ${input.actorId})
        returning id
      `;
      if (batches.length !== 1 || batches[0]?.id !== batchId) {
        throw new RecommendationScopeIntegrityError();
      }

      for (const [groupId, campaignIds] of orderedPartitions) {
        const groupContext = groupId === null ? null : groups.get(groupId);
        if (groupId !== null && groupContext === undefined) {
          throw new RecommendationScopeIntegrityError();
        }
        const group = groupContext?.group ?? null;
        const scheduleContext = group === null || groupContext == null
          ? null
          : OptimizationRunScheduleContext.parse({
              version: 2,
              trigger: 'manual',
              profileTimezone: groupContext.wire.profile_timezone,
              weekdays: group.reviewSchedule.weekdays,
              localHour: Number(groupContext.wire.review_hour),
              dueAt: requestedAt,
              evaluatedAt: requestedAt,
            });
        await insertScopedRecommendationRun(sql, {
          orgId: input.orgId,
          profileId: input.profileId,
          batchId,
          campaignIds,
          group,
          strategy,
          lookbackDays,
          source: 'web',
          runAfter: requestedAt,
          dueAt: group === null ? null : requestedAt,
          scheduleContext,
        });
      }

      const [closure] = await sql<{
        child_count: number;
        campaign_count: number;
        campaign_ids: string[];
        job_count: number;
      }[]>`
        select count(distinct run.id)::integer as child_count,
               count(run_campaign.campaign_id)::integer as campaign_count,
               coalesce(array_agg(run_campaign.campaign_id order by run_campaign.campaign_id collate "C"), '{}')::text[]
                 as campaign_ids,
               count(distinct job.id)::integer as job_count
          from public.recommendation_runs run
          join public.recommendation_run_campaigns run_campaign
            on run_campaign.org_id = run.org_id
           and run_campaign.profile_id = run.profile_id
           and run_campaign.run_id = run.id
          join public.sync_jobs job
            on job.org_id = run.org_id and job.profile_id = run.profile_id and job.id = run.job_id
         where run.org_id = ${input.orgId}
           and run.profile_id = ${input.profileId}
           and run.batch_id = ${batchId}
      `;
      if (
        closure === undefined || closure.child_count !== orderedPartitions.length ||
        closure.job_count !== orderedPartitions.length || closure.campaign_count !== effectiveIds.length ||
        batchScopeFingerprint(input.profileId, closure.campaign_ids) !== effectiveFingerprint
      ) {
        throw new RecommendationScopeIntegrityError();
      }
      return {
        batchId,
        status: 'queued' as const,
        scope: {
          mode: validated.mode,
          campaignCount: effectiveIds.length,
          fingerprint: effectiveFingerprint,
        },
        childCount: orderedPartitions.length,
      };
    });
  }

  async getRecommendationPreviewBatchStatus(
    scope: RecommendationPreviewBatchScope,
  ): Promise<RecommendationPreviewBatchStatus | null> {
    if (!UUID_PATTERN.test(scope.orgId) || !UUID_PATTERN.test(scope.profileId) ||
        !UUID_PATTERN.test(scope.batchId)) {
      throw new RecommendationPreviewError('invalid_request', 400, 'Preview status identity is invalid.');
    }
    const batches = await this.handle.sql<{
      id: string;
      scope_count: number;
      child_count: number;
    }[]>`
      select id, scope_count, child_count
        from public.recommendation_preview_batches
       where id = ${scope.batchId} and org_id = ${scope.orgId} and profile_id = ${scope.profileId}
    `;
    const batch = batches[0];
    if (batch === undefined) return null;
    const rows = await this.handle.sql<{
      run_id: string;
      run_status: string;
      proposals_count: number;
      scope_count: number | null;
      actual_scope_count: number;
      group_id: string | null;
      group_snapshot: unknown;
      job_status: string | null;
    }[]>`
      select run.id as run_id, run.status::text as run_status,
             run.proposals_count, run.scope_count, run.group_id, run.group_snapshot,
             job.status::text as job_status,
             (select count(*)::integer
                from public.recommendation_run_campaigns run_campaign
               where run_campaign.org_id = run.org_id
                 and run_campaign.profile_id = run.profile_id
                 and run_campaign.run_id = run.id) as actual_scope_count
        from public.recommendation_runs run
        left join public.sync_jobs job
          on job.org_id = run.org_id and job.profile_id = run.profile_id and job.id = run.job_id
       where run.org_id = ${scope.orgId}
         and run.profile_id = ${scope.profileId}
         and run.batch_id = ${scope.batchId}
       order by run.group_id nulls last, run.id
    `;
    if (
      rows.length !== Number(batch.child_count) ||
      rows.reduce((sum, row) => sum + Number(row.scope_count ?? 0), 0) !== Number(batch.scope_count) ||
      rows.some((row) => row.job_status === null || row.scope_count !== row.actual_scope_count)
    ) {
      throw new RecommendationScopeIntegrityError();
    }
    const children = rows.map((row) => {
      let groupName: string | null = null;
      if (row.group_id !== null) {
        try {
          const snapshot = normalizeOptimizationGroupSnapshot(row.group_snapshot);
          if (snapshot.group.id !== row.group_id) throw new Error('group mismatch');
          groupName = snapshot.group.name;
        } catch {
          throw new RecommendationScopeIntegrityError();
        }
      }
      const status = recommendationPreviewChildStatus(row.run_status, row.job_status!);
      return {
        runId: row.run_id,
        groupName,
        status,
        campaignCount: Number(row.scope_count),
        proposalsCount: Number(row.proposals_count),
      };
    });
    const hasFailedChild = children.some((child) => child.status === 'failed');
    const hasActiveChild = children.some((child) => child.status === 'running');
    const status = children.every((child) => child.status === 'queued')
      ? 'queued' as const
      : hasFailedChild
        ? 'failed' as const
        : hasActiveChild || children.some((child) => child.status === 'queued')
          ? 'running' as const
          : 'succeeded' as const;
    return {
      batchId: batch.id,
      status,
      campaignCount: Number(batch.scope_count),
      proposalsCount: children.reduce((sum, child) => sum + child.proposalsCount, 0),
      children,
    };
  }

  async enqueueRecommendationRun(input: QueueRecommendationRunInput): Promise<QueuedRecommendationRun> {
    const lookbackDays = input.lookbackDays ?? DEFAULT_RECOMMENDATION_LOOKBACK_DAYS;
    if (!Number.isInteger(lookbackDays) || lookbackDays <= 0) {
      throw new Error('lookbackDays must be a positive integer');
    }
    return this.handle.sql.begin(async (sql) => {
      const profiles = await sql<{ id: string }[]>`
        select id from public.ad_profiles
         where org_id = ${input.orgId} and id = ${input.profileId}
         for update
      `;
      if (profiles.length !== 1) throw new Error('Advertising profile not found');
      const groups = await readProfileOptimizationGroups(sql, input);
      const groupContext = input.groupId === undefined ? undefined : groups.get(input.groupId);
      const group = groupContext?.group ?? null;
      if (input.groupId !== undefined && groupContext === undefined) {
        throw new Error('Optimization group not found');
      }
      if (group !== null && !group.enabled) {
        throw new Error('Disabled optimization groups cannot be queued');
      }
      if (group === null && groups.size > 0) {
        throw new Error('Profile previews with optimization groups require a partitioned batch');
      }
      const active = await sql<{ id: string }[]>`
        select run.id
          from public.recommendation_runs run
          left join public.sync_jobs job
            on job.org_id = run.org_id
           and job.profile_id = run.profile_id
           and job.id = run.job_id
         where run.org_id = ${input.orgId}
           and run.profile_id = ${input.profileId}
           and run.group_id is not distinct from ${group?.id ?? null}::uuid
           and (
             (run.job_id is not null and job.status in ('queued', 'running'))
             or
             (run.job_id is null and run.status in ('queued', 'running'))
           )
         limit 1
      `;
      if (active.length > 0) {
        throw new Error('Optimization scope already has a queued or running preview');
      }
      if (group !== null) {
        const safety = await readGroupRecommendationSafety(sql, input, group.id);
        if (!safety.mayPropose) throw new Error(safety.reason);
      }
      const eligible = await readEligibleCampaigns(sql, input);
      const campaignIds = eligible
        .filter((row) => row.group_id === (group?.id ?? null))
        .map((row) => row.campaign_id);
      if (campaignIds.length === 0) {
        throw new Error('Optimization scope has no eligible campaigns');
      }
      if (campaignIds.length > MAX_RECOMMENDATION_PREVIEW_CAMPAIGNS) {
        throw new Error('Optimization scope exceeds the campaign limit');
      }
      const strategy = await readResolvedStrategySnapshot(sql, input);
      const dueAt = (input.runAt ?? new Date()).toISOString();
      const scheduleContext = group === null || groupContext === undefined
        ? null
        : OptimizationRunScheduleContext.parse({
            version: 2,
            trigger: input.source === 'schedule' ? 'scheduled' : 'manual',
            profileTimezone: groupContext.wire.profile_timezone,
            weekdays: group.reviewSchedule.weekdays,
            localHour: Number(groupContext.wire.review_hour),
            dueAt,
            evaluatedAt: dueAt,
          });
      return insertScopedRecommendationRun(sql, {
        orgId: input.orgId,
        profileId: input.profileId,
        batchId: null,
        campaignIds,
        group,
        strategy,
        lookbackDays,
        source: input.source,
        runAfter: dueAt,
        dueAt: group === null ? null : dueAt,
        scheduleContext,
      });
    });
  }

  async enqueueDueRecommendationRuns(now = new Date()): Promise<number> {
    const nowIso = now.toISOString();
    return this.handle.sql.begin(async (sql) => {
      // Manual enqueue, group persistence, and profile schedule edits all lock
      // profile before group. Claim profiles in a separate statement so tuple-
      // lock order does not depend on the join plan; contended profiles stay due
      // for the next pass.
      const claimedProfiles = await sql<{ profile_id: string }[]>`
        select profile.id as profile_id
          from public.ad_profiles profile
         where profile.sync_enabled
           and exists (
             select 1
               from public.optimization_groups candidate
              where candidate.org_id = profile.org_id
                and candidate.profile_id = profile.id
                and candidate.enabled
                and (
                  candidate.next_run_at is null
                  or candidate.next_run_at <= ${nowIso}::timestamptz
                )
                and not exists (
                  select 1
                    from public.recommendation_runs active
                    left join public.sync_jobs active_job
                      on active_job.org_id = active.org_id
                     and active_job.profile_id = active.profile_id
                     and active_job.id = active.job_id
                   where active.org_id = candidate.org_id
                     and active.profile_id = candidate.profile_id
                     and active.group_id = candidate.id
                     and (
                       (active.job_id is not null and active_job.status in ('queued', 'running'))
                       or
                       (active.job_id is null and active.status in ('queued', 'running'))
                     )
                )
           )
         order by profile.org_id, profile.id
         for update of profile skip locked
      `;
      const claimedProfileIds = claimedProfiles.map((row) => row.profile_id);
      const dueGroups = claimedProfileIds.length === 0
        ? []
        : await sql<OptimizationGroupWireRow[]>`
        select g.id, g.org_id, g.profile_id, g.name, g.role::text as role,
               g.target_acos, g.bid_floor, g.bid_ceiling,
               g.bid_increase_cap, g.bid_decrease_cap,
               g.placement_increase_cap, g.placement_decrease_cap,
               g.exclusions, g.review_weekdays,
               g.prioritization::text as prioritization, g.enabled, g.next_run_at,
               p.timezone as profile_timezone,
               coalesce(p.preferred_sync_hour, 4) as review_hour
          from public.optimization_groups g
          join public.ad_profiles p
            on p.org_id = g.org_id and p.id = g.profile_id
         where g.enabled
           and g.profile_id = any (${claimedProfileIds}::uuid[])
           and (g.next_run_at is null or g.next_run_at <= ${nowIso}::timestamptz)
           and not exists (
             select 1
               from public.recommendation_runs active
               left join public.sync_jobs active_job
                 on active_job.org_id = active.org_id
                and active_job.profile_id = active.profile_id
                and active_job.id = active.job_id
              where active.org_id = g.org_id
                and active.profile_id = g.profile_id
                and active.group_id = g.id
                and (
                  (active.job_id is not null and active_job.status in ('queued', 'running'))
                  or
                  (active.job_id is null and active.status in ('queued', 'running'))
                )
           )
         order by case g.role when 'rank' then 1 when 'profit' then 2
                              when 'discovery' then 3 else 4 end,
                  g.next_run_at nulls first, g.id
         for update of g skip locked
      `;
      let enqueued = 0;
      let heldGroups = 0;
      const strategyByProfile = new Map<string, ResolvedStrategySnapshot>();
      const eligibleByProfile = new Map<string, EligibleCampaignRow[]>();
      for (const row of dueGroups) {
        const group = optimizationGroupFromWire(row);
        const safety = await readGroupRecommendationSafety(sql, group, group.id);
        if (!safety.mayPropose) {
          const advanced = await advanceOptimizationSchedule(sql, group, nowIso);
          if (advanced.length !== 1) throw new Error('Advanced 0 of 1 held group schedules');
          heldGroups += 1;
          continue;
        }
        let eligible = eligibleByProfile.get(group.profileId);
        if (eligible === undefined) {
          eligible = await readEligibleCampaigns(sql, group);
          eligibleByProfile.set(group.profileId, eligible);
        }
        const campaignIds = eligible
          .filter((campaign) => campaign.group_id === group.id)
          .map((campaign) => campaign.campaign_id);
        if (campaignIds.length === 0) {
          const advanced = await advanceOptimizationSchedule(sql, group, nowIso);
          if (advanced.length !== 1) throw new Error('Advanced 0 of 1 empty group schedules');
          heldGroups += 1;
          continue;
        }
        if (campaignIds.length > MAX_RECOMMENDATION_PREVIEW_CAMPAIGNS) {
          throw new Error('Scheduled optimization scope exceeds the campaign limit');
        }
        let strategy = strategyByProfile.get(group.profileId);
        if (strategy === undefined) {
          strategy = await readResolvedStrategySnapshot(sql, group);
          strategyByProfile.set(group.profileId, strategy);
        }
        const dueAt = row.next_run_at === null ? nowIso : toTimestamp(row.next_run_at, 'next_run_at');
        const scheduleContext = OptimizationRunScheduleContext.parse({
          version: 2,
          trigger: 'scheduled',
          profileTimezone: row.profile_timezone,
          weekdays: group.reviewSchedule.weekdays,
          localHour: Number(row.review_hour),
          dueAt,
          evaluatedAt: nowIso,
        });
        await insertScopedRecommendationRun(sql, {
          orgId: group.orgId,
          profileId: group.profileId,
          batchId: null,
          campaignIds,
          group,
          strategy,
          lookbackDays: DEFAULT_RECOMMENDATION_LOOKBACK_DAYS,
          source: 'schedule',
          runAfter: nowIso,
          delay: RECOMMENDATION_SCHEDULE_DELAY,
          dueAt,
          scheduleContext,
        });
        const advanced = await advanceOptimizationSchedule(sql, group, nowIso);
        if (advanced.length !== 1) throw new Error('Advanced 0 of 1 group schedules');
        enqueued += 1;
      }

      // Migration compatibility: profiles without a single persisted group
      // keep their prior weekly run until the operator assigns them.
      const legacyDueProfiles = await sql<{ org_id: string; profile_id: string }[]>`
        select p.org_id, p.id as profile_id
          from public.ad_profiles p
         where p.sync_enabled
           and not exists (
             select 1 from public.optimization_groups g
              where g.org_id = p.org_id and g.profile_id = p.id
           )
           and not exists (
             select 1
               from public.recommendation_runs r
              where r.org_id = p.org_id
                and r.profile_id = p.id
                and r.created_at > ${nowIso}::timestamptz - ${RECOMMENDATION_SCHEDULE_CADENCE}::interval
                and r.engine_version = ${RECOMMENDATIONS_ENGINE_VERSION}
           )
         order by p.id
         for update of p skip locked
      `;
      let emptyLegacyProfiles = 0;
      for (const profile of legacyDueProfiles) {
        const profileScope = { orgId: profile.org_id, profileId: profile.profile_id };
        const campaignIds = (await readEligibleCampaigns(sql, profileScope))
          .filter((campaign) => campaign.group_id === null)
          .map((campaign) => campaign.campaign_id);
        if (campaignIds.length === 0) {
          emptyLegacyProfiles += 1;
          continue;
        }
        if (campaignIds.length > MAX_RECOMMENDATION_PREVIEW_CAMPAIGNS) {
          throw new Error('Scheduled optimization scope exceeds the campaign limit');
        }
        const strategy = await readResolvedStrategySnapshot(sql, profileScope);
        await insertScopedRecommendationRun(sql, {
          orgId: profile.org_id,
          profileId: profile.profile_id,
          batchId: null,
          campaignIds,
          group: null,
          strategy,
          lookbackDays: DEFAULT_RECOMMENDATION_LOOKBACK_DAYS,
          source: 'schedule',
          runAfter: nowIso,
          delay: RECOMMENDATION_SCHEDULE_DELAY,
          dueAt: null,
          scheduleContext: null,
        });
        enqueued += 1;
      }
      const offered = dueGroups.length - heldGroups + legacyDueProfiles.length - emptyLegacyProfiles;
      if (enqueued !== offered) {
        throw new Error(`Found ${offered} due recommendation scopes, enqueued ${enqueued}`);
      }
      return enqueued;
    });
  }
}

interface FencedRunCache {
  claim: ClaimRef;
  groupId: string | undefined;
  profile?: RecommendationProfile;
  groupSafety?: GroupRecommendationSafety | null;
}

/**
 * Claim-bound execution store for the recommendation-only database role.
 * Every method crosses only the narrow RPC facade and presents the same opaque
 * capability that the claimant received for this attempt.
 */
export class FencedRecommendationRunStore implements RecommendationRunStore {
  private readonly runs = new Map<string, FencedRunCache>();

  constructor(readonly database: RecommendationWorkerDatabase) {}

  async startRun(
    scope: RunScope,
    expectedGroupId: string | undefined,
    execution: RecommendationRunExecutionContext,
  ): Promise<StartRunResult> {
    const claim = requireFencedExecution(execution);
    this.runs.set(scope.runId, { claim, groupId: expectedGroupId });
    try {
      const wire = await this.database.start(claim, { ...scope, groupId: expectedGroupId });
      const parsed = parseFencedStart(scope, expectedGroupId, wire);
      this.runs.set(scope.runId, {
        claim,
        groupId: expectedGroupId,
        profile: parsed.profile,
      });
      return parsed.start;
    } catch (error) {
      throw fencedDatabaseError(error);
    }
  }

  async loadProfile(
    scope: ProfileScope,
    execution: RecommendationRunExecutionContext,
  ): Promise<RecommendationProfile> {
    const cached = this.cacheForProfile(scope, execution);
    if (cached.profile === undefined) throw new RecommendationExecutionCustodyError();
    return cached.profile;
  }

  async loadInputs(
    scope: RunScope,
    window: DateWindow,
    execution: RecommendationRunExecutionContext,
  ): Promise<RecommendationRunInputs> {
    const cached = this.cache(scope.runId, execution);
    try {
      const wire = await this.database.readInputs(
        cached.claim,
        { ...scope, groupId: cached.groupId },
        window,
      );
      const parsed = parseFencedInputs(scope, wire.inputs);
      cached.groupSafety = cached.groupId === undefined
        ? null
        : parseGroupSafety(wire.groupSafety);
      return parsed;
    } catch (error) {
      throw fencedDatabaseError(error);
    }
  }

  async loadGroupRecommendationSafety(
    scope: ProfileScope,
    groupId: string,
    execution: RecommendationRunExecutionContext,
  ): Promise<GroupRecommendationSafety> {
    const cached = this.cacheForProfile(scope, execution);
    if (cached.groupId !== groupId || cached.groupSafety === undefined || cached.groupSafety === null) {
      throw new RecommendationScopeIntegrityError();
    }
    return cached.groupSafety;
  }

  async succeedRun(
    completion: RunCompletion,
    execution: RecommendationRunExecutionContext,
  ): Promise<number> {
    const cached = this.cache(completion.runId, execution);
    try {
      const result = await this.database.succeed(
        cached.claim,
        {
          orgId: completion.orgId,
          profileId: completion.profileId,
          runId: completion.runId,
          groupId: cached.groupId,
        },
        completion,
      );
      if (result.proposalsCount !== completion.proposals.length) {
        throw new RecommendationScopeIntegrityError();
      }
      this.runs.delete(completion.runId);
      return result.proposalsCount;
    } catch (error) {
      throw fencedDatabaseError(error);
    }
  }

  async failRun(
    scope: RunScope,
    error: string,
    execution: RecommendationRunExecutionContext,
  ): Promise<RecommendationRunFailureResult> {
    const cached = this.cache(scope.runId, execution);
    try {
      const result = await this.database.fail(
        cached.claim,
        { ...scope, groupId: cached.groupId },
        error,
      );
      this.runs.delete(scope.runId);
      return result.decision === 'already_succeeded'
        ? { decision: 'already_succeeded', proposalsCount: result.proposalsCount }
        : { decision: 'failed' };
    } catch (failure) {
      throw fencedDatabaseError(failure);
    }
  }

  private cache(runId: string, execution: RecommendationRunExecutionContext): FencedRunCache {
    const claim = requireFencedExecution(execution);
    const cached = this.runs.get(runId);
    if (cached === undefined || !sameClaim(cached.claim, claim)) {
      throw new RecommendationExecutionCustodyError();
    }
    return cached;
  }

  private cacheForProfile(
    scope: ProfileScope,
    execution: RecommendationRunExecutionContext,
  ): FencedRunCache {
    const claim = requireFencedExecution(execution);
    const matches = [...this.runs.values()].filter((candidate) =>
      sameClaim(candidate.claim, claim) && candidate.profile?.profileId === scope.profileId
      && candidate.profile.orgId === scope.orgId,
    );
    if (matches.length !== 1) throw new RecommendationExecutionCustodyError();
    return matches[0]!;
  }
}

function requireFencedExecution(execution: RecommendationRunExecutionContext): ClaimRef {
  if (!('claim' in execution)) throw new RecommendationExecutionCustodyError();
  return execution.claim;
}

function sameClaim(left: ClaimRef, right: ClaimRef): boolean {
  return left.jobId === right.jobId && left.workerId === right.workerId && left.token === right.token;
}

function parseFencedStart(
  scope: RunScope,
  expectedGroupId: string | undefined,
  wire: { decision: 'started' | 'already_succeeded'; runData: unknown; profileData: unknown },
): { start: StartRunResult; profile: RecommendationProfile } {
  const run = record(wire.runData);
  const profile = record(wire.profileData);
  const strategySnapshot = TenantStrategy.parse(run['strategySnapshot']);
  const strategyGoal = requiredString(run['strategyGoal']);
  const groupId = nullableString(run['groupId']);
  if ((groupId ?? undefined) !== expectedGroupId) throw new RecommendationScopeIntegrityError();
  let groupRun: RecommendationGroupRun | null = null;
  if (groupId !== null) {
    const snapshot = normalizeOptimizationGroupSnapshot(run['groupSnapshot']);
    const scheduleContext = OptimizationRunScheduleContext.parse(run['scheduleContext']);
    if (
      snapshot.version !== 2 || snapshot.group.id !== groupId
      || snapshot.group.orgId !== scope.orgId || snapshot.group.profileId !== scope.profileId
      || snapshot.group.role !== requiredString(run['groupRole'])
    ) throw new RecommendationScopeIntegrityError();
    groupRun = {
      group: snapshot.group,
      dueAt: requiredString(run['dueAt']),
      scheduleContext,
    };
  }
  if (profile['orgId'] !== scope.orgId || profile['profileId'] !== scope.profileId) {
    throw new RecommendationScopeIntegrityError();
  }
  const proposalsCount = nonnegativeInteger(run['proposalsCount']);
  return {
    start: {
      alreadySucceeded: wire.decision === 'already_succeeded',
      proposalsCount,
      groupRun,
      strategySnapshot,
      strategyGoal,
    },
    profile: {
      orgId: scope.orgId,
      profileId: scope.profileId,
      timezone: requiredString(profile['timezone']),
      goal: nullableString(profile['goal']),
      monthlyBudget: numberOrNull(numericWire(profile['monthlyBudget'])),
    },
  };
}

function parseFencedInputs(scope: RunScope, value: unknown): RecommendationRunInputs {
  const input = record(value);
  const targets = array(input['targets']).map(parseTargetWire);
  const campaigns = array(input['campaigns']).map(parseCampaignWire);
  const profileFacts = array(input['profileFacts']).map(parseProfileFactWire);
  if (targets.length > 100_000 || campaigns.length > 10_000 || profileFacts.length > 400) {
    throw new RecommendationScopeIntegrityError();
  }
  return recommendationInputsFromWire(scope, targets, campaigns, profileFacts);
}

function parseTargetWire(value: unknown): TargetWireRow {
  const row = record(value);
  const targetKind = row['target_kind'];
  const adProduct = row['ad_product'];
  if ((targetKind !== 'keyword' && targetKind !== 'target')
      || (adProduct !== 'SP' && adProduct !== 'SB' && adProduct !== 'SD')) {
    throw new RecommendationScopeIntegrityError();
  }
  return {
    target_id: requiredString(row['target_id']),
    target_kind: targetKind,
    ad_product: adProduct,
    campaign_id: requiredString(row['campaign_id']),
    ad_group_id: requiredString(row['ad_group_id']),
    entity_name: requiredString(row['entity_name']),
    campaign_name: requiredString(row['campaign_name']),
    ad_group_name: nullableString(row['ad_group_name']),
    match_type: nullableString(row['match_type']),
    entity_state: nullableString(row['entity_state']),
    campaign_state: nullableString(row['campaign_state']),
    ad_group_state: nullableString(row['ad_group_state']),
    current_bid: numericWire(row['current_bid']),
    daily_budget: numericWire(row['daily_budget']),
    advertised_asins: array(row['advertised_asins']).map(requiredString),
    rank_now: numericWire(row['rank_now']),
    rank_prev: numericWire(row['rank_prev']),
    rank_asin: nullableString(row['rank_asin']),
    rank_observed_on: nullableString(row['rank_observed_on']),
    impressions: requiredNumericWire(row['impressions']),
    clicks: requiredNumericWire(row['clicks']),
    cost: requiredNumericWire(row['cost']),
    orders: requiredNumericWire(row['orders']),
    sales: requiredNumericWire(row['sales']),
    corridor_date: nullableString(row['corridor_date']),
    suggested_bid_low: numericWire(row['suggested_bid_low']),
    suggested_bid_median: numericWire(row['suggested_bid_median']),
    suggested_bid_high: numericWire(row['suggested_bid_high']),
    corridor_bid: numericWire(row['corridor_bid']),
    corridor_cpc: numericWire(row['corridor_cpc']),
  };
}

function parseCampaignWire(value: unknown): CampaignWireRow {
  const row = record(value);
  const adProduct = row['ad_product'];
  if (adProduct !== 'SP' && adProduct !== 'SB' && adProduct !== 'SD') {
    throw new RecommendationScopeIntegrityError();
  }
  return {
    ad_product: adProduct,
    campaign_id: requiredString(row['campaign_id']),
    campaign_name: requiredString(row['campaign_name']),
    state: nullableString(row['state']),
    daily_budget: numericWire(row['daily_budget']),
    impressions: requiredNumericWire(row['impressions']),
    clicks: requiredNumericWire(row['clicks']),
    cost: requiredNumericWire(row['cost']),
    orders: requiredNumericWire(row['orders']),
    sales: requiredNumericWire(row['sales']),
  };
}

function parseProfileFactWire(value: unknown): ProfileFactWireRow {
  const row = record(value);
  return {
    date: requiredString(row['date']),
    impressions: requiredNumericWire(row['impressions']),
    clicks: requiredNumericWire(row['clicks']),
    cost: requiredNumericWire(row['cost']),
    orders: requiredNumericWire(row['orders']),
    sales: requiredNumericWire(row['sales']),
  };
}

function parseGroupSafety(value: unknown): GroupRecommendationSafety {
  const row = record(value);
  if (typeof row['mayPropose'] !== 'boolean') throw new RecommendationScopeIntegrityError();
  return {
    mayPropose: row['mayPropose'],
    exportedRecommendations: nonnegativeInteger(row['exportedRecommendations']),
    incompleteObservations: nonnegativeInteger(row['incompleteObservations']),
    holdDecisions: nonnegativeInteger(row['holdDecisions']),
    revertDecisions: nonnegativeInteger(row['revertDecisions']),
    reason: requiredString(row['reason']),
  };
}

function fencedDatabaseError(error: unknown): unknown {
  if (error instanceof RecommendationPreviewError) return error;
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : null;
  if (code === '55000' || code === '42501') return new RecommendationExecutionCustodyError();
  if (code === '23514' || code === '22023' || code === '54000') {
    return new RecommendationScopeIntegrityError();
  }
  return error;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RecommendationScopeIntegrityError();
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new RecommendationScopeIntegrityError();
  return value;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new RecommendationScopeIntegrityError();
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return requiredString(value);
}

function numericWire(value: unknown): string | number | null {
  if (value === null) return null;
  return requiredNumericWire(value);
}

function requiredNumericWire(value: unknown): string | number {
  if ((typeof value !== 'number' || !Number.isFinite(value))
      && (typeof value !== 'string' || value.trim() === '' || !Number.isFinite(Number(value)))) {
    throw new RecommendationScopeIntegrityError();
  }
  return value as string | number;
}

function nonnegativeInteger(value: unknown): number {
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new RecommendationScopeIntegrityError();
  return parsed;
}

async function advanceOptimizationSchedule(
  sql: QuerySql,
  group: ScheduledOptimizationGroup,
  after: string,
): Promise<{ id: string }[]> {
  return sql<{ id: string }[]>`
    update public.optimization_groups optimization_group
       set next_run_at = app.next_optimization_review_at(
         optimization_group.review_weekdays,
         profile.timezone,
         coalesce(profile.preferred_sync_hour, 4)::smallint,
         ${after}::timestamptz
       )
      from public.ad_profiles profile
     where optimization_group.org_id = ${group.orgId}
       and optimization_group.profile_id = ${group.profileId}
       and optimization_group.id = ${group.id}
       and profile.org_id = optimization_group.org_id
       and profile.id = optimization_group.profile_id
    returning optimization_group.id
  `;
}

async function readGroupRecommendationSafety(
  sql: QuerySql,
  scope: ProfileScope,
  groupId: string,
): Promise<GroupRecommendationSafety> {
  const [row] = await sql<{
    exported_recommendations: number | string;
    incomplete_observations: number | string;
    hold_decisions: number | string;
    revert_decisions: number | string;
  }[]>`
    with exported as (
      select distinct recommendation.id
        from public.recommendations recommendation
        join public.recommendation_runs run
          on run.id = recommendation.run_id
         and run.org_id = ${scope.orgId}
         and run.profile_id = ${scope.profileId}
         and run.group_id = ${groupId}
        join public.apply_rows apply_row
          on apply_row.org_id = ${scope.orgId}
         and apply_row.profile_id = ${scope.profileId}
         and apply_row.recommendation_id = recommendation.id
        join public.apply_batches batch
          on batch.org_id = ${scope.orgId}
         and batch.profile_id = ${scope.profileId}
         and batch.id = apply_row.batch_id
         and batch.status in ('staged', 'applied')
       where recommendation.org_id = ${scope.orgId}
         and recommendation.profile_id = ${scope.profileId}
    ), evidence as (
      select exported.id, observation.evidence_state, observation.decision
        from exported
        left join lateral (
          select candidate.evidence_state::text as evidence_state,
                 candidate.decision::text as decision
            from public.recommendation_observations candidate
           where candidate.org_id = ${scope.orgId}
             and candidate.profile_id = ${scope.profileId}
             and candidate.group_id = ${groupId}
             and candidate.recommendation_id = exported.id
           order by candidate.observed_at desc, candidate.id desc
           limit 1
        ) observation on true
    )
    select count(*)::int as exported_recommendations,
           count(*) filter (
             where evidence_state is null or evidence_state <> 'complete'
           )::int as incomplete_observations,
           count(*) filter (where decision = 'hold')::int as hold_decisions,
           count(*) filter (where decision = 'revert')::int as revert_decisions
      from evidence
  `;
  const exportedRecommendations = Number(row?.exported_recommendations ?? 0);
  const incompleteObservations = Number(row?.incomplete_observations ?? 0);
  const holdDecisions = Number(row?.hold_decisions ?? 0);
  const revertDecisions = Number(row?.revert_decisions ?? 0);
  if (revertDecisions > 0) {
    return {
      mayPropose: false,
      exportedRecommendations,
      incompleteObservations,
      holdDecisions,
      revertDecisions,
      reason: `${revertDecisions} exported recommendation${revertDecisions === 1 ? ' requires' : 's require'} reversion review before another group preview`,
    };
  }
  if (incompleteObservations > 0 || holdDecisions > 0) {
    const blocked = Math.max(incompleteObservations, holdDecisions);
    return {
      mayPropose: false,
      exportedRecommendations,
      incompleteObservations,
      holdDecisions,
      revertDecisions,
      reason: `${blocked} exported recommendation${blocked === 1 ? ' is' : 's are'} awaiting complete synchronized evidence; hold and do not compound`,
    };
  }
  return {
    mayPropose: true,
    exportedRecommendations,
    incompleteObservations,
    holdDecisions,
    revertDecisions,
    reason: exportedRecommendations === 0
      ? 'No prior exported recommendation requires observation.'
      : 'Every active exported recommendation has complete continue evidence.',
  };
}
