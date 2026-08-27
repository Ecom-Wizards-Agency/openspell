/**
 * The White Box bid engine.
 *
 * Bid = RPC x Target ACOS, applied through four published criteria:
 *
 *   1. High ACOS          new bid = RPC x target ACOS (the exact bid that hits target)
 *   2. High spend, no sales  target CPA = target ACOS x AOV defines "high spend";
 *                            the bid anticipates the next conversion
 *   3. Low ACOS           step up, never past the max affordable CPC
 *   4. Low visibility     step up to buy the data an RPC needs
 *
 * Three properties are deliberate. Criteria 1 and 2 recalculate from data, so
 * running them twice in an hour yields the same answer; criteria 3 and 4 are
 * steps, so they compound and belong to one cycle. Every formula reads CPC and
 * RPC, never the current bid, because the bid is a status and the CPC is data.
 * And every proposal carries the numbers that produced it: a recommendation
 * nobody can audit is a black box with better manners.
 */
import type { CvrSourceLevel, Recommendation, RecommendationInputs, RecommendationReason } from '@wizard-ads/shared';
import { safeDiv } from '../num.js';
import { CATEGORY_RANK } from '../types.js';
import {
  applyCeilings,
  applyChangeCap,
  applyFloors,
  ceilToPrecision,
  ceilingCandidates,
  floorCandidates,
  floorToPrecision,
  roundBid,
} from './ceilings.js';
import { resolveConfidence } from './confidence.js';
import {
  DEFAULT_BID_SETTINGS,
  STEP_BY_PACING_CONDITION,
  type BidRequest,
  type BidPreconditionNote,
  type BidSettings,
  type PacingCondition,
  type ResolvedConfidence,
} from './types.js';

/** Why the engine declined, when it declined. */
export type NoProposalReason =
  | 'on_target'
  | 'no_clicks'
  | 'no_benchmark_data'
  | 'no_change'
  | 'below_minimum';

export type BidOutcome =
  | {
      kind: 'proposal';
      recommendation: Recommendation;
      notes: BidPreconditionNote[];
      confidence: ResolvedConfidence;
    }
  | {
      kind: 'suppressed';
      recommendation: Recommendation;
      suppressedReason: string;
      notes: BidPreconditionNote[];
      confidence: ResolvedConfidence;
    }
  | { kind: 'blocked'; blockedReason: 'out_of_stock'; note: string }
  | { kind: 'none'; reason: NoProposalReason };

function resolveSettings(request: BidRequest): BidSettings {
  const merged: BidSettings = { ...DEFAULT_BID_SETTINGS, ...(request.settings ?? {}) };
  const condition = stepCondition(request);
  if (condition && !request.settings?.lowAcosStepPct) {
    merged.lowAcosStepPct = STEP_BY_PACING_CONDITION[condition].lowAcos;
  }
  if (condition && !request.settings?.lowVisibilityStepPct) {
    merged.lowVisibilityStepPct = STEP_BY_PACING_CONDITION[condition].lowVisibility;
  }
  return merged;
}

/**
 * Step aggressiveness comes from the caller's pacing condition when given.
 * A goal is a weaker signal than an explicit condition, so it only maps the
 * two cases the guide itself describes: launch pushes hard, everything else
 * is on-target until the operator says otherwise.
 */
function stepCondition(request: BidRequest): PacingCondition | null {
  if (request.pacingCondition) return request.pacingCondition;
  if (request.goal === 'rank-launch') return 'launch';
  return null;
}

interface Formula {
  reason: RecommendationReason;
  value: number;
}

/**
 * Pick the criterion that applies. Order matters: the two reductions are
 * evaluated before the two increases, and low ACOS trumps low visibility
 * exactly as the reference article specifies for a keyword that is both.
 */
function selectFormula(
  request: BidRequest,
  settings: BidSettings,
  confidence: ResolvedConfidence,
  entityAcos: number | null,
  entityRpc: number | null,
): Formula | { none: NoProposalReason } {
  const { metrics, targetAcos } = request;
  const spend = metrics.cost ?? 0;

  // 2. High spend, non-converting. Checked first because a keyword with zero
  // sales has no ACOS to compare and would otherwise fall through everything.
  if (metrics.orders === 0) {
    const aov = confidence.aov;
    if (aov === null) return { none: 'no_benchmark_data' };
    const targetCpa = targetAcos * aov;
    if (spend > targetCpa && metrics.clicks > 0) {
      if (settings.nonConvertingModel === 'simple') {
        return { reason: 'high_spend_no_sales', value: (aov / metrics.clicks) * targetAcos };
      }
      const aCtc = confidence.clicksToConversion;
      if (aCtc === null) return { none: 'no_benchmark_data' };
      return { reason: 'high_spend_no_sales', value: targetAcos * (aov / (metrics.clicks + aCtc)) };
    }
    // Not over the CPA threshold yet: it may still be under-clicked.
    return lowVisibility(request, settings, confidence) ?? { none: 'on_target' };
  }

  if (entityAcos === null || entityRpc === null) return { none: 'no_clicks' };

  // 1. High ACOS, outside the grace range.
  if (entityAcos > targetAcos * (1 + settings.graceRange)) {
    return { reason: 'high_acos', value: entityRpc * targetAcos };
  }

  // 4/3. Low ACOS trumps low visibility when both apply.
  if (entityAcos <= targetAcos * (1 - settings.lowAcosBuffer)) {
    const current = request.currentBid;
    if (current === null || current <= 0) {
      // Nothing to step up from: the RPC ceiling is the honest starting point.
      return { reason: 'low_acos', value: entityRpc * targetAcos };
    }
    return { reason: 'low_acos', value: current * (1 + settings.lowAcosStepPct) };
  }

  const lowVis = lowVisibility(request, settings, confidence);
  if (lowVis) return lowVis;

  return { none: 'on_target' };
}

function lowVisibility(
  request: BidRequest,
  settings: BidSettings,
  confidence: ResolvedConfidence,
): Formula | null {
  const aCtc = confidence.clicksToConversion;
  if (aCtc === null) return null;
  const threshold = aCtc * (1 - settings.lowVisibilityClicksBand);
  if (request.metrics.clicks >= threshold) return null;
  const current = request.currentBid;
  if (current === null || current <= 0) return null;
  return { reason: 'low_visibility', value: current * (1 + settings.lowVisibilityStepPct) };
}

function isCut(reason: RecommendationReason): boolean {
  return reason === 'high_acos' || reason === 'high_spend_no_sales';
}

function stockDescription(asins: readonly string[]): string {
  return asins.length === 0 ? 'the advertised ASIN' : asins.join(', ');
}

function preconditionNotes(request: BidRequest): BidPreconditionNote[] {
  const notes: BidPreconditionNote[] = [];
  if (request.stock === undefined || request.stock.status === 'unknown') {
    const asins = request.stock?.asins ?? [];
    notes.push({
      code: 'stock_unknown',
      message:
        `stock unknown for ${stockDescription(asins)} -- no reliable inventory source was supplied; ` +
        'the stock gate failed open and this recommendation was still evaluated.',
    });
  }
  if (
    request.entityRef.entityType === 'keyword' &&
    (request.organicRank === undefined || request.organicRank.status === 'unknown')
  ) {
    notes.push({
      code: 'rank_unknown',
      message: 'Made without rank visibility: no organic-rank observation was supplied for this keyword.',
    });
  }
  return notes;
}

function improvingRankProtection(request: BidRequest): string | null {
  const rank = request.organicRank;
  if (rank?.status !== 'known' || rank.previousRank === null || rank.currentRank >= rank.previousRank) {
    return null;
  }
  return (
    `Organic rank is improving (${rank.previousRank} -> ${rank.currentRank}` +
    `${rank.asin ? ` for ${rank.asin}` : ''}) -- never cut a keyword while paid spend is buying position.`
  );
}

/**
 * Propose a bid for one target.
 *
 * A `Rank` target is never proposed for an ACOS-driven cut: it comes back as
 * `suppressed`, carrying the same fully-populated recommendation, so the
 * operator can see what the formula wanted and decide. No tenant setting may
 * override that doctrine precondition.
 */
export function proposeBid(request: BidRequest): BidOutcome {
  if (request.stock?.status === 'out_of_stock') {
    return {
      kind: 'blocked',
      blockedReason: 'out_of_stock',
      note:
        `${stockDescription(request.stock.asins)} is out of stock` +
        `${request.stock.source ? ` per ${request.stock.source}` : ''}; bid optimization was blocked.`,
    };
  }

  const settings = resolveSettings(request);
  const confidence = resolveConfidence(request.levels, settings.minOrdersForConfidence);
  const entityRpc = safeDiv(request.metrics.sales, request.metrics.clicks);
  const entityAcos = safeDiv(request.metrics.cost ?? null, request.metrics.sales);

  const selected = selectFormula(request, settings, confidence, entityAcos, entityRpc);
  if ('none' in selected) return { kind: 'none', reason: selected.none };

  const candidates = ceilingCandidates({
    targetAcos: request.targetAcos,
    entityRpc,
    confidence,
    adProduct: request.adProduct,
    config: request.ceilings,
  });
  const ceiling = applyCeilings(selected.value, candidates);
  const capped = applyChangeCap(request.currentBid, ceiling.value, request.caps);
  // A bound value rounds down, so a cent of rounding can never carry a bid back
  // over the ceiling or the cap that just held it.
  const bound = ceiling.ceilingApplied !== null || capped.capClamped;
  const rounded = bound
    ? floorToPrecision(capped.value, settings.bidPrecision)
    : roundBid(capped.value, settings.bidPrecision);
  // The lower bound mirrors the ceiling: take the highest applicable floor
  // (Amazon's minimum is always one) and, when a floor lifts the value, round UP
  // so a cent of rounding cannot drop it back under the floor that just held it.
  const floors = floorCandidates({
    minBid: settings.minBid,
    targetAcos: request.targetAcos,
    entityRpc,
    confidence,
    config: request.floors,
  });
  const floored = applyFloors(rounded, floors);
  const proposed =
    floored.floorApplied !== null ? ceilToPrecision(floored.value, settings.bidPrecision) : floored.value;

  if (request.currentBid !== null && proposed === roundBid(request.currentBid, settings.bidPrecision)) {
    return { kind: 'none', reason: 'no_change' };
  }

  const inputs: RecommendationInputs = {
    rpc: entityRpc,
    clicks: request.metrics.clicks,
    cvrSourceLevel: confidence.level as CvrSourceLevel,
    ceilingApplied: ceiling.ceilingApplied,
    floorApplied: floored.floorApplied,
    capClamped: capped.capClamped,
    window: { start: request.window.start, end: request.window.end },
  };

  const recommendation: Recommendation = {
    runId: request.runId,
    profileId: request.profileId,
    reason: selected.reason,
    entityRef: request.entityRef,
    field: 'bid',
    currentValue: request.currentBid,
    proposedValue: proposed,
    inputs,
    status: 'proposed',
  };

  const notes = preconditionNotes(request);

  const protections: string[] = [];
  if (isCut(selected.reason) && request.category === CATEGORY_RANK) {
    protections.push(
      'Rank/SKW target: never cut on ACOS alone. A rank keyword is deliberately run at or above ' +
        'break-even to buy organic position, so the formula result is shown rather than proposed.',
    );
  }
  if (isCut(selected.reason)) {
    const rankProtection = improvingRankProtection(request);
    if (rankProtection) protections.push(rankProtection);
  }
  if (protections.length > 0) {
    return {
      kind: 'suppressed',
      recommendation,
      suppressedReason: protections.join(' '),
      notes,
      confidence,
    };
  }

  return { kind: 'proposal', recommendation, notes, confidence };
}
