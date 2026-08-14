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

/** One modifier that lifts a base bid: a placement, dayparting, an audience, ... */
export interface ModifierComponent {
  /** A label such as 'top_of_search', 'dayparting', 'audience'. */
  name: string;
  /** Percentage uplift as Amazon stores it (0 to 900). */
  pct: number;
}

export interface MaxPotentialCpcRequest {
  baseBid: number;
  /**
   * Mutually-exclusive placement modifiers: a click is served at exactly one
   * placement, so only the largest can bind the max potential. Empty means no
   * placement uplift applies.
   */
  placementModifiers?: ModifierComponent[];
  /** Modifiers that stack on top of the placement: dayparting, audience, ... */
  otherModifiers?: ModifierComponent[];
}

export interface MaxPotentialCpc {
  /** base bid x combined multiplier: the most a single click can cost. */
  value: number;
  /** The product of every applied modifier's `1 + pct/100`. */
  multiplier: number;
  /** The modifiers that composed the multiplier, in application order. */
  components: ModifierComponent[];
}

/**
 * Compose the plottable max-potential CPC: the most a single click can cost.
 *
 * The corridor chart (`tools/recon/04-optimizer.md` §3) draws this as `Max CPC`,
 * with the placement and dayparting/audience modifiers nested underneath as its
 * components. A click lands on one placement, so the placement modifiers are
 * mutually exclusive and the maximum of them binds; the remaining modifiers
 * stack on top multiplicatively. Amazon stores every modifier as a percentage
 * uplift, so each contributes a `1 + pct/100` multiplier.
 *
 * Pure: a bid plus a modifier set in, the figure and its decomposition out, so
 * the chart plots it without recomputing anything.
 */
export function maxPotentialCpc(request: MaxPotentialCpcRequest): MaxPotentialCpc {
  const placements = request.placementModifiers ?? [];
  const others = request.otherModifiers ?? [];

  let topPlacement: ModifierComponent | null = null;
  for (const p of placements) {
    if (topPlacement === null || p.pct > topPlacement.pct) topPlacement = p;
  }

  const components: ModifierComponent[] = [];
  if (topPlacement !== null) components.push(topPlacement);
  for (const o of others) components.push(o);

  let multiplier = 1;
  for (const c of components) multiplier *= 1 + c.pct / 100;

  return { value: request.baseBid * multiplier, multiplier, components };
}
