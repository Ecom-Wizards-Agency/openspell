/**
 * Bid ceilings and change caps.
 *
 * A ceiling is what a bid may never exceed; a cap is how far a bid may move in
 * one cycle. They are applied in that order, and the distinction is the whole
 * point of the "caps are ceilings, never steps" rule: when a bid sits far above
 * the max affordable CPC, the ceiling says where it belongs and the cap says it
 * gets there over several cycles instead of in one collapse. A proposal can
 * therefore be cap-clamped and still above its ceiling, and it reports both.
 */
import type { AdProduct } from '@wizard-ads/shared';
import type {
  CeilingConfig,
  CeilingName,
  ChangeCaps,
  FloorConfig,
  FloorName,
  ResolvedConfidence,
} from './types.js';

/** Sponsored Display consumes budget differently, so its bid ceiling is half. */
export const SD_BUDGET_SHARE_CEILING = 0.5;
export const DEFAULT_BUDGET_SHARE_CEILING = 1.0;

export function budgetShareCeilingFor(adProduct: AdProduct, override?: number | null): number {
  if (override !== null && override !== undefined) return override;
  return adProduct === 'SD' ? SD_BUDGET_SHARE_CEILING : DEFAULT_BUDGET_SHARE_CEILING;
}

export interface CeilingCandidate {
  name: CeilingName;
  value: number;
}

const DATA_BASED_NAME: Record<ResolvedConfidence['level'], CeilingName> = {
  keyword: 'data_based_keyword',
  ad_group: 'data_based_ad_group',
  campaign: 'data_based_campaign',
  profile: 'data_based_profile',
};

export interface CeilingInputs {
  targetAcos: number;
  /** The target's own RPC over the window, when it has one. */
  entityRpc: number | null;
  /** The benchmark level the confidence hierarchy resolved to. */
  confidence: ResolvedConfidence;
  adProduct: AdProduct;
  config?: CeilingConfig;
}

/**
 * Every ceiling that applies, cheapest first is NOT assumed: the caller takes
 * the minimum. Returned as a list so a UI can show what was considered and not
 * only what bound.
 */
export function ceilingCandidates(inputs: CeilingInputs): CeilingCandidate[] {
  const out: CeilingCandidate[] = [];
  const { config } = inputs;

  if (config?.manualMaxBid !== null && config?.manualMaxBid !== undefined) {
    out.push({ name: 'manual_max_bid', value: config.manualMaxBid });
  }
  // The data hierarchy applies to ceilings too. A target with revenue of its
  // own is ceilinged by its own max affordable CPC; only a low-data target
  // borrows the benchmark from the level above it. A zero RPC is real data but
  // a meaningless ceiling, since a keyword with no sales yet is exactly the
  // case the non-converting formula projects revenue for.
  if (inputs.entityRpc !== null && inputs.entityRpc > 0) {
    out.push({ name: 'max_affordable_cpc', value: inputs.entityRpc * inputs.targetAcos });
  } else if (inputs.confidence.rpc !== null && inputs.confidence.rpc > 0) {
    out.push({
      name: DATA_BASED_NAME[inputs.confidence.level] as CeilingName,
      value: inputs.confidence.rpc * inputs.targetAcos,
    });
  }
  if (config?.dailyBudget !== null && config?.dailyBudget !== undefined) {
    const share = budgetShareCeilingFor(inputs.adProduct, config.budgetShareCeiling);
    out.push({ name: 'budget', value: config.dailyBudget * share });
  }
  // Amazon's own suggested bid, when synced, is an upper suggestion the formula
  // should not blow past. Absent → no candidate, so behaviour is unchanged.
  if (config?.suggestedBid !== null && config?.suggestedBid !== undefined) {
    out.push({ name: 'suggested_bid', value: config.suggestedBid });
  }
  return out;
}

export interface CeilingOutcome {
  value: number;
  ceilingApplied: CeilingName | null;
}

/**
 * Clamp a value to the lowest applicable ceiling.
 *
 * Ties resolve to the first candidate in `ceilingCandidates` order, so the name
 * reported is stable rather than dependent on iteration luck.
 */
export function applyCeilings(value: number, candidates: CeilingCandidate[]): CeilingOutcome {
  let binding: CeilingCandidate | null = null;
  for (const candidate of candidates) {
    if (binding === null || candidate.value < binding.value) binding = candidate;
  }
  if (binding === null || value <= binding.value) return { value, ceilingApplied: null };
  return { value: binding.value, ceilingApplied: binding.name };
}

export interface FloorCandidate {
  name: FloorName;
  value: number;
}

export interface FloorInputs {
  /** Amazon's absolute minimum for the ad product; always a candidate. */
  minBid: number;
  targetAcos: number;
  /** The target's own RPC over the window, when it has one. */
  entityRpc: number | null;
  /** The benchmark level the confidence hierarchy resolved to. */
  confidence: ResolvedConfidence;
  config?: FloorConfig;
}

/**
 * Every floor that applies. The mirror of `ceilingCandidates`: the caller takes
 * the MAXIMUM rather than the minimum. Amazon's absolute minimum is always
 * present, so the list is never empty and a proposal is always two-sided.
 */
export function floorCandidates(inputs: FloorInputs): FloorCandidate[] {
  const out: FloorCandidate[] = [{ name: 'amazon_min_bid', value: inputs.minBid }];
  const { config } = inputs;

  if (config?.manualMinBid !== null && config?.manualMinBid !== undefined) {
    out.push({ name: 'manual_min_bid', value: config.manualMinBid });
  }
  if (config?.suggestedBidLow !== null && config?.suggestedBidLow !== undefined) {
    out.push({ name: 'suggested_bid_low', value: config.suggestedBidLow });
  }
  // The dynamic floor uses the same affordable-CPC hierarchy the ceiling does:
  // the target's own RPC when it has one, else the benchmark level's. A zero RPC
  // is real data but a meaningless floor, so it is skipped like the ceiling's is.
  if (config?.dynamicFloorShare !== null && config?.dynamicFloorShare !== undefined) {
    let affordable: number | null = null;
    if (inputs.entityRpc !== null && inputs.entityRpc > 0) {
      affordable = inputs.entityRpc * inputs.targetAcos;
    } else if (inputs.confidence.rpc !== null && inputs.confidence.rpc > 0) {
      affordable = inputs.confidence.rpc * inputs.targetAcos;
    }
    if (affordable !== null) {
      out.push({ name: 'data_based_floor', value: config.dynamicFloorShare * affordable });
    }
  }
  return out;
}

export interface FloorOutcome {
  value: number;
  floorApplied: FloorName | null;
}

/**
 * Clamp a value UP to the highest applicable floor — the mirror of
 * `applyCeilings`. Ties resolve to the first candidate in `floorCandidates`
 * order, so the reported name is stable rather than dependent on iteration luck.
 */
export function applyFloors(value: number, candidates: FloorCandidate[]): FloorOutcome {
  let binding: FloorCandidate | null = null;
  for (const candidate of candidates) {
    if (binding === null || candidate.value > binding.value) binding = candidate;
  }
  if (binding === null || value >= binding.value) return { value, floorApplied: null };
  return { value: binding.value, floorApplied: binding.name };
}

export interface CapOutcome {
  value: number;
  capClamped: boolean;
}

/**
 * Clamp a proposed value to within the change caps around the current value.
 *
 * With no current value there is nothing to clamp against: the first proposal
 * on a bid that has never been set is not a "change".
 */
export function applyChangeCap(
  current: number | null | undefined,
  proposed: number,
  caps: Pick<ChangeCaps, 'maxIncrease' | 'maxDecrease'>,
): CapOutcome {
  if (current === null || current === undefined || current <= 0) {
    return { value: proposed, capClamped: false };
  }
  const upper = current * (1 + caps.maxIncrease);
  const lower = current * (1 - caps.maxDecrease);
  if (proposed > upper) return { value: upper, capClamped: true };
  if (proposed < lower) return { value: lower, capClamped: true };
  return { value: proposed, capClamped: false };
}

/**
 * Round to a fixed number of decimals the way a price is rounded.
 *
 * `toFixed` rounds the exact binary value half away from zero, which is what a
 * currency amount wants; the arithmetic `Math.round(v * 100) / 100` form is
 * avoided because it mis-rounds values like 1.005 that a bid formula produces
 * routinely.
 */
export function roundBid(value: number, precision: number): number {
  return Number(value.toFixed(precision));
}

/**
 * Round DOWN to a precision. Used for a value that a ceiling or a cap already
 * bound: ordinary rounding would push it back over the bound by a cent, which
 * is exactly the kind of quiet violation a guardrail exists to prevent.
 */
export function floorToPrecision(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.floor(Number((value * factor).toFixed(6))) / factor;
}

/**
 * Round UP to a precision. The mirror of `floorToPrecision`, for a value a FLOOR
 * just lifted: ordinary rounding could drop it a cent back under the floor, the
 * same quiet violation `floorToPrecision` prevents on the ceiling side.
 */
export function ceilToPrecision(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.ceil(Number((value * factor).toFixed(6))) / factor;
}
