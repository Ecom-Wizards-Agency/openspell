/**
 * White Box bidding: the vocabulary.
 *
 * Everything here is derived from the publicly published AdLabs formulas
 * (`AdLabs Help/articles/000..004`), never from tenant doctrine. Target ACOS,
 * change caps and ceilings arrive as inputs, because they are per-tenant
 * database values and this repository is public.
 */
import type { AdProduct, CvrSourceLevel, EntityRef, IsoDate, Uuid } from '@wizard-ads/shared';

/** Performance for one entity over the optimization window. */
export interface LevelMetrics {
  clicks: number;
  orders: number;
  sales: number;
  /** Spend. Optional: only the non-converting criterion needs it. */
  cost?: number;
}

/**
 * The data-confidence hierarchy, most specific first.
 *
 * `profile` is required because it is the last resort: an engine that can fall
 * all the way through to nothing has no basis for a proposal at all, and
 * saying so is better than inventing a benchmark.
 */
export interface ConfidenceLevels {
  keyword?: LevelMetrics;
  adGroup?: LevelMetrics;
  campaign?: LevelMetrics;
  profile: LevelMetrics;
}

/** Which level supplied the benchmark, and what it supplied. */
export interface ResolvedConfidence {
  level: CvrSourceLevel;
  metrics: LevelMetrics;
  /** Orders / clicks at that level. */
  cvr: number | null;
  /** Sales / orders at that level. */
  aov: number | null;
  /** Sales / clicks at that level. */
  rpc: number | null;
  /** Clicks / orders at that level: the average clicks-to-conversion. */
  clicksToConversion: number | null;
}

/** Ceiling inputs. Every one of these is optional except the target ACOS. */
export interface CeilingConfig {
  /** An operator-set maximum bid, if the tenant sets one. */
  manualMaxBid?: number | null;
  /** Campaign daily budget: a bid above it can never spend twice. */
  dailyBudget?: number | null;
  /**
   * Share of the daily budget a bid may reach. Defaults to 1.0, and to 0.5 for
   * Sponsored Display, whose budget is consumed differently.
   */
  budgetShareCeiling?: number | null;
  /**
   * Amazon's suggested bid for the target, when the sync supplies one. It is a
   * ceiling candidate: Amazon's own upper suggestion is a defensible cap on a
   * bid the formula would push higher. Absent → no suggested-bid ceiling is
   * considered, so today's behaviour is unchanged.
   */
  suggestedBid?: number | null;
}

/** Which ceiling bound a value, named so the UI can say it. */
export type CeilingName =
  | 'manual_max_bid'
  | 'max_affordable_cpc'
  | 'data_based_keyword'
  | 'data_based_ad_group'
  | 'data_based_campaign'
  | 'data_based_profile'
  | 'suggested_bid'
  | 'budget';

/**
 * Floor inputs — the mirror of `CeilingConfig`. Every one is optional; Amazon's
 * absolute minimum is always in play regardless, so a proposal is always
 * two-sided even when the tenant sets no floors.
 */
export interface FloorConfig {
  /** An operator-set minimum bid, if the tenant sets one. */
  manualMinBid?: number | null;
  /**
   * Amazon's suggested-bid LOW edge — the bottom of the auction corridor. A bid
   * below it is unlikely to clear the auction, so it is a defensible floor.
   */
  suggestedBidLow?: number | null;
  /**
   * A dynamic floor as a fraction of the affordable CPC (AdLabs' TIMES_CPC bid
   * floor, 0.2–1). Applied to the target's own affordable CPC, or the benchmark
   * level's when the target is too thin — the same hierarchy the ceiling uses.
   */
  dynamicFloorShare?: number | null;
}

/** Which floor bound a value, named so the UI can say it — mirrors `CeilingName`. */
export type FloorName =
  | 'amazon_min_bid'
  | 'manual_min_bid'
  | 'suggested_bid_low'
  | 'data_based_floor';

/**
 * Change caps. Ceilings on the step, never targets to aim at: a proposal that
 * lands exactly on a cap means the formula wanted more and was clamped, which
 * is why `capClamped` travels with every recommendation.
 */
export interface ChangeCaps {
  /** Maximum fractional increase over the current value, e.g. 0.25 for +25%. */
  maxIncrease: number;
  /** Maximum fractional decrease, e.g. 0.5 for -50%. */
  maxDecrease: number;
  /** Maximum fractional increase of a placement multiplier; null means uncapped. */
  maxPlacementIncrease?: number | null;
  /** Maximum fractional decrease of a placement multiplier; null means uncapped. */
  maxPlacementDecrease?: number | null;
}

/**
 * Step aggressiveness, from the guide's own table: gentle on target, harder
 * when under-pacing, hardest at launch.
 */
export type PacingCondition = 'on_target' | 'under_pacing' | 'launch';

export interface BidSettings {
  /** Grace range around target ACOS inside which nothing is touched. */
  graceRange: number;
  /** How far below target ACOS a keyword must be to justify an increase. */
  lowAcosBuffer: number;
  /** Step for a low-ACOS increase. */
  lowAcosStepPct: number;
  /** Step for a low-visibility increase. */
  lowVisibilityStepPct: number;
  /** Clicks below `(1 - band) x clicks-to-conversion` count as low visibility. */
  lowVisibilityClicksBand: number;
  /**
   * Which published non-converting formula to use.
   * `projected` is the complete guide's: `targetAcos x AOV / (clicks + aCTC)`.
   * `simple` is the earlier article's: `targetAcos x AOV / clicks`.
   */
  nonConvertingModel: 'projected' | 'simple';
  /** Amazon's floor. */
  minBid: number;
  /** Decimal places a bid is rounded to. */
  bidPrecision: number;
  /** Minimum orders at a level for it to count as sufficient data. */
  minOrdersForConfidence: number;
}

export const DEFAULT_BID_SETTINGS: BidSettings = {
  graceRange: 0.1,
  lowAcosBuffer: 0.2,
  lowAcosStepPct: 0.1,
  lowVisibilityStepPct: 0.05,
  lowVisibilityClicksBand: 0.1,
  nonConvertingModel: 'projected',
  minBid: 0.02,
  bidPrecision: 2,
  minOrdersForConfidence: 1,
};

/** The guide's step table, used when a pacing condition is supplied. */
export const STEP_BY_PACING_CONDITION: Record<PacingCondition, { lowAcos: number; lowVisibility: number }> = {
  on_target: { lowAcos: 0.1, lowVisibility: 0.1 },
  under_pacing: { lowAcos: 0.2, lowVisibility: 0.2 },
  launch: { lowAcos: 0.25, lowVisibility: 0.2 },
};

export interface BidRequest {
  runId: Uuid;
  profileId: Uuid;
  entityRef: EntityRef;
  adProduct: AdProduct;
  window: { start: IsoDate; end: IsoDate };
  /** The bid as it stands. A status, not data: never the basis of a formula. */
  currentBid: number | null;
  /** The target's own performance over the window. */
  metrics: LevelMetrics;
  /** The confidence hierarchy this target sits in. */
  levels: ConfidenceLevels;
  targetAcos: number;
  caps: ChangeCaps;
  ceilings?: CeilingConfig;
  floors?: FloorConfig;
  /** Strategy category; `Rank` is protected from ACOS-only cuts. */
  category?: string;
  /** Brand goal/stage, resolved through the same lens table the flags use. */
  goal?: string | null;
  /** Overrides the goal-derived step aggressiveness. */
  pacingCondition?: PacingCondition;
  /**
   * Set true for an opt group whose doctrine permits cutting on ACOS alone.
   * Defaults to false for `Rank`, which is the protection.
   */
  cutOnAcosAlone?: boolean;
  settings?: Partial<BidSettings>;
}
