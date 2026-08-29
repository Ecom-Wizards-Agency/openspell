/**
 * `EntityRow`: the shape of one row in the entity mirror, keyed
 * `(profileId, amazonId)`. One discriminated union covers every entity kind so
 * a sync diff, a grid row and an audit record all speak the same language.
 */
import { z } from 'zod';
import {
  AdProduct,
  AmazonId,
  EntityState,
  EntityType,
  MatchType,
  Uuid,
} from './primitives.js';

/** Fields every mirrored entity carries. */
const entityBase = {
  profileId: Uuid,
  amazonId: AmazonId,
  adProduct: AdProduct,
  name: z.string().nullable(),
  state: EntityState,
  /** When the last successful sync pass observed this row. */
  syncedAt: z.iso.datetime().optional(),
};

export const BudgetType = z.enum(['daily', 'lifetime']);
export type BudgetType = z.infer<typeof BudgetType>;

export const TargetingType = z.enum(['manual', 'auto']);
export type TargetingType = z.infer<typeof TargetingType>;

export const BiddingStrategy = z.enum([
  'legacy_for_sales',
  'auto_for_sales',
  'manual',
  'rule_based',
]);
export type BiddingStrategy = z.infer<typeof BiddingStrategy>;

/** Percent uplift per placement, as Amazon stores it (0-900). */
export const PlacementBidding = z.object({
  topOfSearch: z.number().nullable(),
  productPages: z.number().nullable(),
  restOfSearch: z.number().nullable(),
});
export type PlacementBidding = z.infer<typeof PlacementBidding>;

export const ProviderPlacement = z.enum([
  'PLACEMENT_TOP',
  'PLACEMENT_PRODUCT_PAGE',
  'PLACEMENT_REST_OF_SEARCH',
  'SITE_AMAZON_BUSINESS',
]);

const ProviderPlacementAdjustment = z.object({
  placement: ProviderPlacement,
  percentage: z.number().int().min(0).max(900),
}).strict();

const ProviderAudienceSegment = z.object({
  audienceId: z.string().min(1),
  audienceSegmentType: z.string().min(1),
}).strict();

const ProviderShopperCohortAdjustment = z.object({
  shopperCohortType: z.string().min(1),
  percentage: z.number().int().min(0).max(900),
  audienceSegments: z.array(ProviderAudienceSegment).optional(),
}).strict();

/**
 * Complete provider state required for a safe dynamic-bidding replacement.
 * A campaign without this exact context remains readable but placement writes
 * are refused: sending only our three visible placement numbers could erase a
 * shopper-cohort or off-Amazon setting that Amazon stores beside them.
 */
export const CampaignWriteContext = z.object({
  strategy: BiddingStrategy,
  placementBidding: z.array(ProviderPlacementAdjustment),
  shopperCohortBidding: z.array(ProviderShopperCohortAdjustment).nullable(),
  offAmazonSettings: z.object({
    offAmazonBudgetControlStrategy: z.string().min(1),
  }).strict().nullable(),
}).strict();
export type CampaignWriteContext = z.infer<typeof CampaignWriteContext>;

/** One clause of a product-targeting expression. */
export const TargetExpression = z.object({
  type: MatchType,
  value: z.string().nullable(),
});
export type TargetExpression = z.infer<typeof TargetExpression>;

export const PortfolioRow = z.object({
  ...entityBase,
  entityType: z.literal(EntityType.enum.portfolio),
  budgetAmount: z.number().nullable(),
  budgetPolicy: z.string().nullable(),
});

export const CampaignRow = z.object({
  ...entityBase,
  entityType: z.literal(EntityType.enum.campaign),
  portfolioId: AmazonId.nullable(),
  budgetAmount: z.number(),
  budgetType: BudgetType,
  targetingType: TargetingType.nullable(),
  biddingStrategy: BiddingStrategy.nullable(),
  placementBidding: PlacementBidding.nullable(),
  campaignWriteContext: CampaignWriteContext.nullable().optional(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
});

export const AdGroupRow = z.object({
  ...entityBase,
  entityType: z.literal(EntityType.enum.ad_group),
  campaignId: AmazonId,
  defaultBid: z.number().nullable(),
});

export const ProductAdRow = z.object({
  ...entityBase,
  entityType: z.literal(EntityType.enum.product_ad),
  campaignId: AmazonId,
  adGroupId: AmazonId,
  asin: z.string().nullable(),
  sku: z.string().nullable(),
});

export const KeywordRow = z.object({
  ...entityBase,
  entityType: z.literal(EntityType.enum.keyword),
  campaignId: AmazonId,
  adGroupId: AmazonId,
  keywordText: z.string(),
  matchType: MatchType,
  bid: z.number().nullable(),
});

export const TargetRow = z.object({
  ...entityBase,
  entityType: z.literal(EntityType.enum.target),
  campaignId: AmazonId,
  adGroupId: AmazonId,
  expression: z.array(TargetExpression),
  /** Amazon's resolved form, kept verbatim so the grid can show what it shows. */
  resolvedExpression: z.string().nullable(),
  bid: z.number().nullable(),
});

/** Negative keywords and negative product targets, campaign- or ad-group-scoped. */
export const NegativeRow = z.object({
  ...entityBase,
  entityType: z.literal(EntityType.enum.negative),
  campaignId: AmazonId,
  adGroupId: AmazonId.nullable(),
  scope: z.enum(['campaign', 'ad_group']),
  keywordText: z.string().nullable(),
  expression: z.array(TargetExpression).nullable(),
  matchType: MatchType,
});

export const EntityRow = z.discriminatedUnion('entityType', [
  PortfolioRow,
  CampaignRow,
  AdGroupRow,
  ProductAdRow,
  KeywordRow,
  TargetRow,
  NegativeRow,
]);
export type EntityRow = z.infer<typeof EntityRow>;

export type PortfolioRow = z.infer<typeof PortfolioRow>;
export type CampaignRow = z.infer<typeof CampaignRow>;
export type AdGroupRow = z.infer<typeof AdGroupRow>;
export type ProductAdRow = z.infer<typeof ProductAdRow>;
export type KeywordRow = z.infer<typeof KeywordRow>;
export type TargetRow = z.infer<typeof TargetRow>;
export type NegativeRow = z.infer<typeof NegativeRow>;
