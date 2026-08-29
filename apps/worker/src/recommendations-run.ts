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
import { nextReviewAt, type DbHandle, type QuerySql } from '@wizard-ads/db';
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
  OptimizationGroup,
  RecommendationScheduleContext,
  type AdProduct,
  type EntityRef,
  type Recommendation,
  type RecommendationReason,
  type RecommendationScheduleContext as RecommendationScheduleContextValue,
  type RecommendationsRunJob,
  type TenantStrategy,
} from '@wizard-ads/shared';
import {
  changeCapsFor,
  optGroup,
  resolveStrategy,
  targetAcosFor,
  type StrategyDocument,
} from '@wizard-ads/strategy';
import { profileToday } from './bid-series.js';
import { DEFAULT_CADENCES } from './schedules.js';

export const DEFAULT_RECOMMENDATION_LOOKBACK_DAYS = DEFAULT_CADENCES.recommendations.lookbackDays;
export const RECOMMENDATIONS_ENGINE_VERSION = 'white-box-v1';
export const RECOMMENDATION_SCHEDULE_CADENCE = DEFAULT_CADENCES.recommendations.cadence;
export const RECOMMENDATION_SCHEDULE_DELAY = DEFAULT_CADENCES.recommendations.delay;
export const RECOMMENDATION_SCHEDULE_PRIORITY = DEFAULT_CADENCES.recommendations.priority;

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
  group: OptimizationGroup;
  dueAt: string;
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
  startRun(scope: RunScope, expectedGroupId?: string): Promise<StartRunResult>;
  loadProfile(scope: ProfileScope): Promise<RecommendationProfile>;
  loadInputs(
    scope: ProfileScope,
    window: DateWindow,
    groupId?: string,
  ): Promise<RecommendationRunInputs>;
  loadGroupRecommendationSafety(
    scope: ProfileScope,
    groupId: string,
  ): Promise<GroupRecommendationSafety>;
  succeedRun(completion: RunCompletion): Promise<number>;
  failRun(scope: RunScope, error: string): Promise<void>;
}

export interface QueueRecommendationRunInput extends ProfileScope {
  lookbackDays?: number;
  groupId?: string;
  runAt?: Date;
  source: 'web';
}

export interface QueuedRecommendationRun {
  runId: string;
  jobId: string;
}

export interface RecommendationScheduleStore {
  enqueueDueRecommendationRuns(now?: Date): Promise<number>;
  enqueueRecommendationRun(input: QueueRecommendationRunInput): Promise<QueuedRecommendationRun>;
}

export interface RecommendationRunResult {
  runId: string;
  proposals: number;
  window: DateWindow | null;
  alreadySucceeded: boolean;
}

export type RecommendationsRun = (
  payload: Omit<RecommendationsRunJob, 'lookbackDays'> & { lookbackDays?: number },
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
  return async (payload) => runRecommendations(store, payload, now());
}

export async function runRecommendations(
  store: RecommendationRunStore,
  payload: Omit<RecommendationsRunJob, 'lookbackDays'> & { lookbackDays?: number },
  now = new Date(),
): Promise<RecommendationRunResult> {
  const scope: RunScope = {
    orgId: payload.orgId,
    profileId: payload.profileId,
    runId: payload.runId,
  };
  const started = await store.startRun(scope, payload.groupId);
  if (started.alreadySucceeded) {
    return {
      runId: payload.runId,
      proposals: started.proposalsCount,
      window: null,
      alreadySucceeded: true,
    };
  }

  try {
    const lookbackDays = payload.lookbackDays ?? DEFAULT_RECOMMENDATION_LOOKBACK_DAYS;
    const profile = await store.loadProfile(scope);
    const window = recommendationWindow(profile.timezone, lookbackDays, now);
    const inputs = await store.loadInputs(scope, window, started.groupRun?.group.id);
    const groupSafety = started.groupRun === null || started.groupRun === undefined
      ? null
      : await store.loadGroupRecommendationSafety(scope, started.groupRun.group.id);
    const resolved = resolveStrategy({
      goal: profile.goal,
      tenant: inputs.tenantStrategy,
      profile: inputs.profileStrategy,
    });

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
    const written = await store.succeedRun({
      ...scope,
      lookbackDays,
      window,
      strategySnapshot: resolved.value,
      proposals,
      narrative,
    });
    if (written !== proposals.length) {
      throw new Error(`Composed ${proposals.length} recommendations, store wrote ${written}`);
    }
    return { runId: payload.runId, proposals: written, window, alreadySucceeded: false };
  } catch (error) {
    await store.failRun(scope, errorMessage(error).slice(0, 4_000));
    throw error;
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
  group: OptimizationGroup | null;
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

function goalForGroupRole(role: OptimizationGroup['role']): string {
  if (role === 'rank') return 'rank-launch';
  if (role === 'shield') return 'defend';
  if (role === 'profit') return 'profit-maintain';
  return 'scale';
}

function applyNonMechanicalBidAdjustment(
  recommendation: Recommendation,
  group: OptimizationGroup | null,
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

function optimizationGroupFromWire(row: OptimizationGroupWireRow): OptimizationGroup {
  return OptimizationGroup.parse({
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
    cadence: row.cadence,
    reviewSchedule: {
      weekdays: row.review_weekdays,
      localTime: row.review_local_time.slice(0, 5),
    },
    scheduleMigrationState: row.schedule_migration_state,
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

interface OptimizationGroupWireRow {
  id: string;
  org_id: string;
  profile_id: string;
  name: string;
  role: OptimizationGroup['role'];
  target_acos: string | number;
  bid_floor: string | number | null;
  bid_ceiling: string | number | null;
  bid_increase_cap: string | number;
  bid_decrease_cap: string | number;
  placement_increase_cap: string | number;
  placement_decrease_cap: string | number;
  exclusions: string[];
  cadence: string;
  review_weekdays: NonNullable<OptimizationGroup['reviewSchedule']>['weekdays'];
  review_local_time: string;
  schedule_migration_state: OptimizationGroup['scheduleMigrationState'];
  prioritization: OptimizationGroup['prioritization'];
  enabled: boolean;
  next_run_at: Date | string | null;
  next_review_at: Date | string | null;
  profile_timezone: string;
}

/** Postgres implementation: storage representations never leave this class. */
export class PostgresRecommendationRunStore
implements RecommendationRunStore, RecommendationScheduleStore {
  constructor(readonly handle: DbHandle) {}

  async startRun(scope: RunScope, expectedGroupId?: string): Promise<StartRunResult> {
    return this.handle.sql.begin(async (sql) => {
      const rows = await sql<{
        status: string;
        proposals_count: number;
        group_id: string | null;
        group_snapshot: unknown;
        due_at: Date | string | null;
      }[]>`
        select status::text as status, proposals_count,
               group_id, group_snapshot, due_at
          from public.recommendation_runs
         where id = ${scope.runId}
           and org_id = ${scope.orgId}
           and profile_id = ${scope.profileId}
         for update
      `;
      const run = rows[0];
      if (!run) throw new Error(`No scoped recommendation run ${scope.runId}`);
      if ((run.group_id ?? undefined) !== expectedGroupId) {
        throw new Error('recommendation job group does not match its stored run context');
      }
      const groupRun = run.group_id === null
        ? null
        : {
            group: OptimizationGroup.parse(run.group_snapshot),
            dueAt: toTimestamp(run.due_at, 'group run due_at'),
          };
      if (groupRun !== null && groupRun.group.id !== run.group_id) {
        throw new Error('recommendation run group snapshot does not match group_id');
      }
      if (run.status === 'succeeded') {
        return { alreadySucceeded: true, proposalsCount: Number(run.proposals_count), groupRun };
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
      return { alreadySucceeded: false, proposalsCount: 0, groupRun };
    });
  }

  async loadProfile(scope: ProfileScope): Promise<RecommendationProfile> {
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
    scope: ProfileScope,
    window: DateWindow,
    groupId?: string,
  ): Promise<RecommendationRunInputs> {
    const profileFactsFrom = firstOfMonth(window.end) < window.start
      ? firstOfMonth(window.end)
      : window.start;
    const [strategyRows, targetRows, campaignRows, profileRows] = await Promise.all([
      this.handle.sql<{ profile_id: string | null; doc: StrategyDocument }[]>`
        select profile_id, doc
          from public.profile_strategy
         where org_id = ${scope.orgId}
           and (profile_id is null or profile_id = ${scope.profileId})
      `,
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
             and (
               ${groupId ?? null}::uuid is null or exists (
                 select 1 from public.campaign_optimization_assignments assignment
                  where assignment.org_id = ${scope.orgId}
                    and assignment.profile_id = ${scope.profileId}
                    and assignment.group_id = ${groupId ?? null}::uuid
                    and assignment.campaign_id = f.campaign_id
               )
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
             and (
               ${groupId ?? null}::uuid is null or exists (
                 select 1 from public.campaign_optimization_assignments assignment
                  where assignment.org_id = ${scope.orgId}
                    and assignment.profile_id = ${scope.profileId}
                    and assignment.group_id = ${groupId ?? null}::uuid
                    and assignment.campaign_id = f.campaign_id
               )
             )
           group by f.campaign_id
          union all
          select 'SB', f.campaign_id, sum(f.impressions)::bigint, sum(f.clicks)::bigint,
                 sum(f.cost), sum(f.purchases_7d)::bigint, sum(f.sales_7d)
            from public.fact_sb_daily f
           where f.org_id = ${scope.orgId}
             and f.profile_id = ${scope.profileId}
             and f.date between ${window.start} and ${window.end}
             and (
               ${groupId ?? null}::uuid is null or exists (
                 select 1 from public.campaign_optimization_assignments assignment
                  where assignment.org_id = ${scope.orgId}
                    and assignment.profile_id = ${scope.profileId}
                    and assignment.group_id = ${groupId ?? null}::uuid
                    and assignment.campaign_id = f.campaign_id
               )
             )
           group by f.campaign_id
          union all
          select 'SD', f.campaign_id, sum(f.impressions)::bigint, sum(f.clicks)::bigint,
                 sum(f.cost), sum(f.purchases_7d)::bigint, sum(f.sales_7d)
            from public.fact_sd_daily f
           where f.org_id = ${scope.orgId}
             and f.profile_id = ${scope.profileId}
             and f.date between ${window.start} and ${window.end}
             and (
               ${groupId ?? null}::uuid is null or exists (
                 select 1 from public.campaign_optimization_assignments assignment
                  where assignment.org_id = ${scope.orgId}
                    and assignment.profile_id = ${scope.profileId}
                    and assignment.group_id = ${groupId ?? null}::uuid
                    and assignment.campaign_id = f.campaign_id
               )
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

    const tenantStrategy = strategyRows.find((row) => row.profile_id === null)?.doc ?? null;
    const profileStrategy = strategyRows.find((row) => row.profile_id === scope.profileId)?.doc ?? null;
    return {
      tenantStrategy,
      profileStrategy,
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

  async loadGroupRecommendationSafety(
    scope: ProfileScope,
    groupId: string,
  ): Promise<GroupRecommendationSafety> {
    return readGroupRecommendationSafety(this.handle.sql, scope, groupId);
  }

  async succeedRun(completion: RunCompletion): Promise<number> {
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
               strategy_snapshot = ${serializeJson(completion.strategySnapshot)}::text::jsonb,
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

  async failRun(scope: RunScope, error: string): Promise<void> {
    await this.handle.sql.begin(async (sql) => {
      const updated = await sql<{ id: string }[]>`
        update public.recommendation_runs
           set status = 'failed', finished_at = now(), error = ${error}
         where id = ${scope.runId}
           and org_id = ${scope.orgId}
           and profile_id = ${scope.profileId}
           and status <> 'succeeded'
        returning id
      `;
      if (updated.length !== 1) throw new Error('Failed 0 of 1 recommendation runs');
      await sql`
        insert into public.audit_log
          (org_id, actor_type, action, target_type, target_id, payload, source)
        values (${scope.orgId}, 'service', 'recommendation.run.failed',
                'recommendation_run', ${scope.runId},
                ${serializeJson({ error })}::text::jsonb, 'worker')
      `;
    });
  }

  async enqueueRecommendationRun(input: QueueRecommendationRunInput): Promise<QueuedRecommendationRun> {
    const lookbackDays = input.lookbackDays ?? DEFAULT_RECOMMENDATION_LOOKBACK_DAYS;
    if (!Number.isInteger(lookbackDays) || lookbackDays <= 0) {
      throw new Error('lookbackDays must be a positive integer');
    }
    return this.handle.sql.begin(async (sql) => {
      const profiles = await sql<{ id: string; timezone: string }[]>`
        select id, timezone from public.ad_profiles
         where org_id = ${input.orgId} and id = ${input.profileId}
         for update
      `;
      if (profiles.length !== 1) throw new Error('Advertising profile not found');
      const profile = profiles[0]!;
      const groupRows = input.groupId === undefined
        ? []
        : await sql<OptimizationGroupWireRow[]>`
            select id, org_id, profile_id, name, role::text as role, target_acos,
                   bid_floor, bid_ceiling, bid_increase_cap, bid_decrease_cap,
                   placement_increase_cap, placement_decrease_cap, exclusions,
                   cadence::text as cadence, review_weekdays,
                   review_local_time::text, schedule_migration_state,
                   prioritization::text as prioritization,
                   enabled, next_run_at, next_review_at,
                   ${profile.timezone}::text as profile_timezone
              from public.optimization_groups
             where org_id = ${input.orgId}
               and profile_id = ${input.profileId}
               and id = ${input.groupId}
             for update
          `;
      const group = groupRows[0] === undefined ? null : optimizationGroupFromWire(groupRows[0]);
      if (input.groupId !== undefined && group === null) {
        throw new Error('Optimization group not found');
      }
      if (group !== null) {
        const active = await sql<{ id: string }[]>`
          select id
            from public.recommendation_runs
           where org_id = ${input.orgId}
             and profile_id = ${input.profileId}
             and group_id = ${group.id}
             and status in ('queued', 'running')
           limit 1
        `;
        if (active.length > 0) {
          throw new Error('Optimization group already has a queued or running preview');
        }
        const safety = await readGroupRecommendationSafety(sql, input, group.id);
        if (!safety.mayPropose) throw new Error(safety.reason);
      }
      const dueAt = (input.runAt ?? new Date()).toISOString();
      const scheduleContext = RecommendationScheduleContext.parse({
        trigger: 'manual',
        profileTimezone: profile.timezone,
        reviewSchedule: group?.reviewSchedule ?? null,
        scheduleEnabled: group?.enabled ?? false,
        queuedAt: new Date().toISOString(),
        scheduledFor: null,
      });
      const runs = await sql<{ id: string }[]>`
        insert into public.recommendation_runs
          (org_id, profile_id, status, lookback_days, engine_version,
           group_id, group_role, group_snapshot, due_at, run_trigger,
           schedule_context)
        values (${input.orgId}, ${input.profileId}, 'queued', ${lookbackDays},
                ${RECOMMENDATIONS_ENGINE_VERSION}, ${group?.id ?? null},
                ${group?.role ?? null}::public.optimization_group_role,
                ${group === null ? null : serializeJson(group)}::text::jsonb,
                ${group === null ? null : dueAt}::timestamptz,
                'manual', ${serializeJson(scheduleContext)}::text::jsonb)
        returning id
      `;
      const runId = runs[0]?.id;
      if (!runId) throw new Error('Minted 0 of 1 recommendation runs');
      const payload = {
        type: 'recommendations.run' as const,
        orgId: input.orgId,
        profileId: input.profileId,
        runId,
        lookbackDays,
        ...(group === null ? {} : { groupId: group.id }),
      };
      const jobs = await sql<{ id: string }[]>`
        insert into public.sync_jobs
          (org_id, profile_id, job_type, payload, priority, dedupe_key, run_after)
        values (${input.orgId}, ${input.profileId}, 'recommendations.run',
                ${serializeJson(payload)}::text::jsonb,
                100,
                ${`recommendations.run:${runId}`},
                ${(input.runAt ?? new Date()).toISOString()}::timestamptz)
        returning id
      `;
      const jobId = jobs[0]?.id;
      if (!jobId) throw new Error('Enqueued 0 of 1 recommendation jobs');
      return { runId, jobId };
    });
  }

  async enqueueDueRecommendationRuns(now = new Date()): Promise<number> {
    const nowIso = now.toISOString();
    return this.handle.sql.begin(async (sql) => {
      const dueGroups = await sql<OptimizationGroupWireRow[]>`
        select g.id, g.org_id, g.profile_id, g.name, g.role::text as role,
               g.target_acos, g.bid_floor, g.bid_ceiling,
               g.bid_increase_cap, g.bid_decrease_cap,
               g.placement_increase_cap, g.placement_decrease_cap,
               g.exclusions, g.cadence::text as cadence,
               g.review_weekdays, g.review_local_time::text,
               g.schedule_migration_state,
               g.prioritization::text as prioritization, g.enabled,
               g.next_run_at, g.next_review_at, p.timezone as profile_timezone
          from public.optimization_groups g
          join public.ad_profiles p
            on p.org_id = g.org_id and p.id = g.profile_id
         where p.sync_enabled
           and g.enabled
           and g.schedule_migration_state <> 'needs_review'
           and (g.next_review_at is null or g.next_review_at <= ${nowIso}::timestamptz)
           and not exists (
             select 1 from public.recommendation_runs r
              where r.org_id = g.org_id
                and r.profile_id = g.profile_id
                and r.group_id = g.id
                and r.status in ('queued', 'running')
           )
         order by case g.role when 'rank' then 1 when 'profit' then 2
                              when 'discovery' then 3 else 4 end,
                  g.next_review_at nulls first, g.id
         for update of g skip locked
      `;
      let enqueued = 0;
      let handled = 0;
      for (const row of dueGroups) {
        const group = optimizationGroupFromWire(row);
        if (group.reviewSchedule === null) {
          throw new Error('Due optimization group has no review schedule');
        }
        const dueAt = row.next_review_at === null
          ? nowIso
          : toTimestamp(row.next_review_at, 'next_review_at');
        const followingReview = nextReviewAt({
          after: now,
          schedule: group.reviewSchedule,
          timeZone: row.profile_timezone,
        }).toISOString();
        const safety = await readGroupRecommendationSafety(sql, group, group.id);
        if (!safety.mayPropose) {
          const advanced = await sql<{ id: string }[]>`
            update public.optimization_groups
               set next_review_at = ${followingReview}::timestamptz
             where org_id = ${group.orgId}
               and profile_id = ${group.profileId}
               and id = ${group.id}
            returning id
          `;
          if (advanced.length !== 1) throw new Error('Advanced 0 of 1 held group schedules');
          handled += 1;
          continue;
        }
        const scheduleContext: RecommendationScheduleContextValue = RecommendationScheduleContext.parse({
          trigger: 'schedule',
          profileTimezone: row.profile_timezone,
          reviewSchedule: group.reviewSchedule,
          scheduleEnabled: group.enabled,
          queuedAt: nowIso,
          scheduledFor: dueAt,
        });
        const runs = await sql<{ id: string }[]>`
          insert into public.recommendation_runs
            (org_id, profile_id, status, lookback_days, engine_version,
             group_id, group_role, group_snapshot, due_at, run_trigger,
             schedule_context)
          values (${group.orgId}, ${group.profileId}, 'queued',
                  ${DEFAULT_RECOMMENDATION_LOOKBACK_DAYS}, ${RECOMMENDATIONS_ENGINE_VERSION},
                  ${group.id}, ${group.role}::public.optimization_group_role,
                  ${serializeJson(group)}::text::jsonb, ${dueAt}::timestamptz,
                  'schedule', ${serializeJson(scheduleContext)}::text::jsonb)
          on conflict (group_id, due_at) where run_trigger = 'schedule' do nothing
          returning id
        `;
        const runId = runs[0]?.id;
        if (!runId) {
          const advanced = await sql<{ id: string }[]>`
            update public.optimization_groups
               set next_review_at = ${followingReview}::timestamptz
             where org_id = ${group.orgId}
               and profile_id = ${group.profileId}
               and id = ${group.id}
            returning id
          `;
          if (advanced.length !== 1) throw new Error('Advanced 0 of 1 replayed group schedules');
          handled += 1;
          continue;
        }
        const payload = {
          type: 'recommendations.run' as const,
          orgId: group.orgId,
          profileId: group.profileId,
          runId,
          lookbackDays: DEFAULT_RECOMMENDATION_LOOKBACK_DAYS,
          groupId: group.id,
        };
        const jobs = await sql<{ id: string }[]>`
          insert into public.sync_jobs
            (org_id, profile_id, job_type, payload, priority, dedupe_key, run_after)
          values (${group.orgId}, ${group.profileId}, 'recommendations.run',
                  ${serializeJson(payload)}::text::jsonb,
                  ${RECOMMENDATION_SCHEDULE_PRIORITY},
                  ${`recommendations.run:${runId}`},
                  ${nowIso}::timestamptz + ${RECOMMENDATION_SCHEDULE_DELAY}::interval)
          returning id
        `;
        if (jobs.length !== 1) throw new Error('Enqueued 0 of 1 group recommendation jobs');
        const advanced = await sql<{ id: string }[]>`
          update public.optimization_groups
             set next_review_at = ${followingReview}::timestamptz
           where org_id = ${group.orgId}
             and profile_id = ${group.profileId}
             and id = ${group.id}
          returning id
        `;
        if (advanced.length !== 1) throw new Error('Advanced 0 of 1 group schedules');
        enqueued += 1;
        handled += 1;
      }
      if (handled !== dueGroups.length) {
        throw new Error(`Claimed ${dueGroups.length} due group occurrences, handled ${handled}`);
      }
      return enqueued;
    });
  }
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
