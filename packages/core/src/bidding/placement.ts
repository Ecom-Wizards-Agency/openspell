/**
 * Placement adjustments.
 *
 * Placement Adjustment = (Target ACOS / Current ACOS) - 1, per placement,
 * computed separately from the bid and applied as a relative change to the
 * current modifier. Amazon stores a modifier as a percentage uplift, so the
 * relative change is applied to the multiplier it represents:
 *
 *   multiplier   = 1 + modifierPct / 100
 *   newMultiplier = multiplier x (1 + adjustment)
 *
 * That interpretation is what makes the formula work at a 0% modifier, where a
 * literal relative change to the percentage would be stuck at zero forever.
 *
 * The 30-day minimum is a hard gate rather than a warning: a placement
 * adjustment computed on a week of data is noise with a decimal point.
 */
import type { Placement, Recommendation, RecommendationInputs, Uuid, EntityRef, IsoDate } from '@wizard-ads/shared';
import { safeDiv } from '../num.js';
import type { ChangeCaps } from './types.js';

/** The guide's minimum window: at least 30 days, ideally 60. */
export const MIN_PLACEMENT_WINDOW_DAYS = 30;

export interface PlacementRequest {
  runId: Uuid;
  profileId: Uuid;
  entityRef: EntityRef;
  placement: Placement;
  window: { start: IsoDate; end: IsoDate; days: number };
  /** Current modifier as Amazon stores it: a percentage uplift, 0 to 900. */
  currentModifierPct: number;
  clicks: number;
  cost: number;
  sales: number;
  targetAcos: number;
  caps: Pick<ChangeCaps, 'maxPlacementIncrease' | 'maxPlacementDecrease'>;
  /** Amazon's ceiling on a placement modifier. */
  maxModifierPct?: number;
}

export type PlacementSkipReason = 'window_too_short' | 'no_sales' | 'no_clicks' | 'no_change';

export type PlacementOutcome =
  | { kind: 'proposal'; recommendation: Recommendation; adjustment: number }
  | { kind: 'none'; reason: PlacementSkipReason };

const DEFAULT_MAX_MODIFIER_PCT = 900;

export function proposePlacementAdjustment(request: PlacementRequest): PlacementOutcome {
  if (request.window.days < MIN_PLACEMENT_WINDOW_DAYS) {
    return { kind: 'none', reason: 'window_too_short' };
  }
  if (request.clicks <= 0) return { kind: 'none', reason: 'no_clicks' };
  const currentAcos = safeDiv(request.cost, request.sales);
  if (currentAcos === null || currentAcos === 0) return { kind: 'none', reason: 'no_sales' };

  const adjustment = request.targetAcos / currentAcos - 1;
  const multiplier = 1 + request.currentModifierPct / 100;
  let newMultiplier = multiplier * (1 + adjustment);

  const capUp = request.caps.maxPlacementIncrease;
  const capDown = request.caps.maxPlacementDecrease;
  let capClamped = false;
  if (capUp !== null && capUp !== undefined && newMultiplier > multiplier * (1 + capUp)) {
    newMultiplier = multiplier * (1 + capUp);
    capClamped = true;
  }
  if (capDown !== null && capDown !== undefined && newMultiplier < multiplier * (1 - capDown)) {
    newMultiplier = multiplier * (1 - capDown);
    capClamped = true;
  }

  const maxPct = request.maxModifierPct ?? DEFAULT_MAX_MODIFIER_PCT;
  let ceilingApplied: string | null = null;
  let proposedPct = (newMultiplier - 1) * 100;
  if (proposedPct > maxPct) {
    proposedPct = maxPct;
    ceilingApplied = 'amazon_max_modifier';
  }
  if (proposedPct < 0) {
    // Amazon cannot express a negative modifier; the base bid carries the cut.
    proposedPct = 0;
    ceilingApplied = 'modifier_floor';
  }
  proposedPct = Number(proposedPct.toFixed(2));

  if (proposedPct === Number(request.currentModifierPct.toFixed(2))) {
    return { kind: 'none', reason: 'no_change' };
  }

  const inputs: RecommendationInputs = {
    rpc: safeDiv(request.sales, request.clicks),
    clicks: request.clicks,
    // Placement data is campaign-grain, so it can never be a keyword claim.
    cvrSourceLevel: 'campaign',
    ceilingApplied,
    capClamped,
    window: { start: request.window.start, end: request.window.end },
  };

  const recommendation: Recommendation = {
    runId: request.runId,
    profileId: request.profileId,
    // The placement is over target when the adjustment is negative, under it
    // when positive; the reason names which, so the row reads on its own.
    reason: adjustment < 0 ? 'high_acos' : 'low_acos',
    entityRef: request.entityRef,
    field: `placement:${request.placement}`,
    currentValue: request.currentModifierPct,
    proposedValue: proposedPct,
    inputs,
    status: 'proposed',
  };

  return { kind: 'proposal', recommendation, adjustment };
}
