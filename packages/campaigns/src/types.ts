/**
 * The types a campaign plan is written in.
 *
 * These are **package-local on purpose**. `packages/shared` is the frozen
 * contract six packages build against; a plan shape that only this engine and
 * its exporter speak does not belong in it yet. Promotion to `shared` happens
 * with WP-14b, when the apply path needs the same shape, and under manager
 * sign-off.
 *
 * Three layers, and it is worth being precise about which is which:
 *
 *   `CampaignSpec`      what an operator (or a keyword workbook) asks for.
 *   `GeneratedCampaign` the reference model's flat campaign record. One per
 *                       campaign, with every default already resolved. This is
 *                       the shape the parity goldens pin.
 *   `CampaignPlan`      the public output: campaigns → ad group → keywords,
 *                       targets and negatives, with temporary ids assigned, so
 *                       the bulk rows are a projection of the plan rather than
 *                       a second construction of it.
 */
import type {
  BiddingStrategy,
  CampaignPurpose,
  CampaignType,
  EntityState,
  MatchType,
  NegativeLevel,
  NegativeMatchType,
  SiteRestriction,
  SpColumn,
  TargetingType,
} from './constants.js';

/** A SKU/ASIN field: a list, or one string with newline or comma separators. */
export type ProductList = string | readonly string[];

/** The naming grammar. `variableOrder` names the slots; blanks are dropped. */
export interface NamingSettings {
  variableOrder: readonly string[];
  delimiter: string;
  suffix: string;
  custom1Value: string;
  custom2Value: string;
}

/**
 * One campaign request.
 *
 * Every field is optional because the file-wide `defaults` block fills the
 * blanks, and because a keyword workbook supplies a very different subset than
 * a hand-written brief does.
 */
export interface CampaignSpec {
  campaignType?: string;
  campaignPurpose?: string;
  goal?: string;
  productName?: string;
  targetDescriptor?: string;
  sku?: ProductList;
  asin?: ProductList;
  keywords?: readonly string[] | string;
  targetAsins?: readonly string[];
  targetCategories?: readonly string[];
  keywordsPerCampaign?: number;
  transposeKeywords?: boolean;
  swapNameOrder?: boolean;
  skwIncludeKeywordInName?: boolean;
  matchType?: string;
  dailyBudget?: number;
  keywordBid?: number;
  biddingStrategy?: string;
  portfolioId?: string | number;
  negativeKeywords?: readonly string[];
  negativeTargetAsins?: readonly string[];
  negativeMatchType?: string;
  negativeLevel?: string;
  state?: string;
  childState?: string;
  startDate?: string;
  siteRestriction?: string;
  topOfSearchPlacement?: number | null;
  restOfSearchPlacement?: number | null;
  productPagesPlacement?: number | null;
  autoCloseMatchBid?: number | null;
  autoCloseMatchState?: string | null;
  autoLooseMatchBid?: number | null;
  autoLooseMatchState?: string | null;
  autoSubstitutesBid?: number | null;
  autoSubstitutesState?: string | null;
  autoComplementsBid?: number | null;
  autoComplementsState?: string | null;
}

/** The file-wide defaults block: the same fields, applied to every spec. */
export type CampaignDefaults = CampaignSpec & { vendorCentralMode?: boolean };

/** A whole build request. */
export interface CampaignBuildConfig {
  client: string;
  marketplace: string;
  naming: NamingSettings;
  defaults: CampaignDefaults;
  /** Vendor accounts advertise by ASIN; the SKU column must go out empty. */
  vendorCentralMode?: boolean;
  campaigns: readonly CampaignSpec[];
}

/**
 * A spec with every default merged in and every value coerced. The reference
 * calls this a "form", after the web app it was ported from.
 */
export interface ResolvedSpec {
  campaignType: string;
  campaignPurpose: string;
  goal: string;
  productName: string;
  targetDescriptor: string;
  sku: ProductList;
  asin: ProductList;
  keywordsRaw: string;
  targetMode: 'ASIN' | 'CATEGORY';
  keywordsPerCampaign: number;
  transposeKeywords: boolean;
  swapNameOrder: boolean;
  skwIncludeKeywordInName: boolean;
  matchType: string;
  dailyBudget: number;
  keywordBid: number;
  biddingStrategy: string;
  portfolioId: string;
  negativeKeywords: readonly string[];
  negativeTargetAsins: readonly string[];
  negativeMatchType: string;
  negativeLevel: string;
  state: string;
  childState: string;
  startDate: string;
  siteRestriction: string;
  topOfSearchPlacement: number | null;
  restOfSearchPlacement: number | null;
  productPagesPlacement: number | null;
  autoCloseMatchBid: number | null;
  autoCloseMatchState: EntityState | null;
  autoLooseMatchBid: number | null;
  autoLooseMatchState: EntityState | null;
  autoSubstitutesBid: number | null;
  autoSubstitutesState: EntityState | null;
  autoComplementsBid: number | null;
  autoComplementsState: EntityState | null;
}

/**
 * One generated campaign, flat, every default resolved.
 *
 * Field for field the reference model's campaign dict, which is what makes the
 * parity goldens a real check rather than a comparison of two shapes we chose.
 * `startDate` here is the reference's `MM/DD/YYYY` intermediate, not the
 * `YYYYMMDD` a bulksheet cell holds.
 */
export interface GeneratedCampaign {
  campaignName: string;
  adGroupName: string;
  campaignType: CampaignType;
  campaignPurpose: CampaignPurpose;
  goal: string;
  targetingType: TargetingType;
  matchType: MatchType;
  targetDescriptor: string;
  keywords: readonly string[];
  asins: readonly string[];
  categories: readonly string[];
  sku: ProductList;
  asin: ProductList;
  dailyBudget: number;
  keywordBid: number;
  biddingStrategy: BiddingStrategy;
  negativeKeywords: readonly string[];
  negativeTargetAsins: readonly string[];
  negativeMatchType: NegativeMatchType;
  negativeLevel: NegativeLevel;
  portfolioId: string;
  state: EntityState;
  childState: EntityState;
  startDate: string;
  siteRestriction: SiteRestriction;
  topOfSearchPlacement: number | null;
  restOfSearchPlacement: number | null;
  productPagesPlacement: number | null;
  autoCloseMatchBid: number | null;
  autoCloseMatchState: EntityState | null;
  autoLooseMatchBid: number | null;
  autoLooseMatchState: EntityState | null;
  autoSubstitutesBid: number | null;
  autoSubstitutesState: EntityState | null;
  autoComplementsBid: number | null;
  autoComplementsState: EntityState | null;
}

// ---------------------------------------------------------------------------
// the plan

export const CAMPAIGN_PLAN_SCHEMA = 'wizard-ads.campaign-plan.v1' as const;

export interface PlannedPlacement {
  /** The Amazon label, e.g. `Placement Top`. */
  placement: string;
  /** A whole percent, 0..900. Only placements above zero reach the plan. */
  percentage: number;
}

export interface PlannedProductAd {
  sku: string;
  asin: string;
  state: EntityState;
}

export interface PlannedKeyword {
  text: string;
  /** Amazon's vocabulary (`exact`), not the model's (`EXACT`). */
  matchType: string;
  bid: number;
  state: EntityState;
}

export interface PlannedProductTarget {
  /** A full expression: `asin="B0.."`, `category="123"`, or `close-match`. */
  expression: string;
  bid: number;
  state: EntityState;
}

export interface PlannedNegativeKeyword {
  text: string;
  /** Amazon's vocabulary (`negativeExact`). */
  matchType: string;
  state: EntityState;
}

export interface PlannedNegativeProductTarget {
  expression: string;
  state: EntityState;
}

export interface PlannedAdGroup {
  /** Temporary id. Non-numeric: Amazon rejects a bare number on create. */
  id: string;
  name: string;
  state: EntityState;
  defaultBid: number;
  productAds: PlannedProductAd[];
  keywords: PlannedKeyword[];
  productTargets: PlannedProductTarget[];
  negativeKeywords: PlannedNegativeKeyword[];
  negativeProductTargets: PlannedNegativeProductTarget[];
}

export interface PlannedCampaign {
  id: string;
  name: string;
  campaignType: CampaignType;
  campaignPurpose: CampaignPurpose;
  goal: string;
  targetingType: TargetingType;
  matchType: MatchType;
  targetDescriptor: string;
  state: EntityState;
  dailyBudget: number;
  biddingStrategy: BiddingStrategy;
  /** The Amazon vocabulary value, e.g. `Dynamic bids - down only`. */
  biddingStrategyLabel: string;
  /** `YYYYMMDD`, as the bulksheet cell holds it. */
  startDate: string;
  portfolioId: string;
  /** `Amazon Business` or empty. Amazon's `Sites` column is opt-in. */
  sites: string;
  placements: PlannedPlacement[];
  adGroup: PlannedAdGroup;
  /** Campaign-level negatives. Ad-group-level ones live on the ad group. */
  negativeKeywords: PlannedNegativeKeyword[];
}

export interface CampaignPlan {
  schema: typeof CAMPAIGN_PLAN_SCHEMA;
  client: string;
  marketplace: string;
  /** The date the plan was generated for, `YYYY-MM-DD`. Passed in, never read from a clock. */
  today: string;
  sheetName: string;
  campaigns: PlannedCampaign[];
}

/** One bulk row: every Amazon column, present, in order. */
export type BulkRow = Record<SpColumn, string | number>;

/** A worksheet as both this package and openpyxl see it. */
export interface SheetModel {
  sheetName: string;
  header: readonly string[];
  rows: ReadonlyArray<ReadonlyArray<string | number>>;
}
