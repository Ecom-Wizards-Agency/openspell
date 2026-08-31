import { z } from 'zod';
import {
  BiddingStrategy,
  BudgetType,
  TargetingType,
} from './entities.js';
import {
  AdProduct,
  AmazonId,
  CurrencyCode,
  IsoDate,
  Uuid,
} from './primitives.js';

export const CampaignCreationSchemaVersion = z.literal('openspell.campaign-creation-plan.v1');
export type CampaignCreationSchemaVersion = z.infer<typeof CampaignCreationSchemaVersion>;

export const CampaignCreationSha256 = z.string().regex(/^[a-f0-9]{64}$/);
export type CampaignCreationSha256 = z.infer<typeof CampaignCreationSha256>;

const CampaignCreationUuid = Uuid.refine((value) => value === value.toLowerCase(), {
  message: 'campaign creation UUIDs must use lowercase canonical form',
});

function isRealCalendarDate(value: string): boolean {
  const [yearText, monthText, dayText] = value.split('-');
  if (yearText === undefined || monthText === undefined || dayText === undefined) return false;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysByMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= (daysByMonth[month - 1] ?? 0);
}

const CampaignCreationIsoDate = IsoDate.refine(isRealCalendarDate, {
  message: 'campaign creation date must be a real Gregorian calendar date',
});

export const CampaignCreationApiDialect = z.enum([
  'sp_legacy_v3',
  'sd_legacy',
  'unified_ads_v1',
]);
export type CampaignCreationApiDialect = z.infer<typeof CampaignCreationApiDialect>;

export const CampaignCreationResourceKind = z.enum([
  'product',
  'brand',
  'store',
  'asset',
  'campaign',
  'ad_group',
  'ad',
  'target',
  'creative',
]);
export type CampaignCreationResourceKind = z.infer<typeof CampaignCreationResourceKind>;

export const PlannedCampaignCreationResourceRef = z.object({
  source: z.literal('plan_node'),
  kind: CampaignCreationResourceKind,
  nodeId: CampaignCreationUuid,
}).strict();
export type PlannedCampaignCreationResourceRef = z.infer<
  typeof PlannedCampaignCreationResourceRef
>;

export const CampaignCreationResourceRef = PlannedCampaignCreationResourceRef;
export type CampaignCreationResourceRef = z.infer<typeof CampaignCreationResourceRef>;

function plannedResourceRef(kind: CampaignCreationResourceKind) {
  return PlannedCampaignCreationResourceRef.refine((reference) => reference.kind === kind, {
    message: `expected a planned ${kind} resource reference`,
  });
}

export const CampaignCreationNodeKind = z.enum([
  'eligibility.require_product',
  'eligibility.require_brand',
  'eligibility.require_store',
  'asset.require_existing',
  'campaign.create',
  'ad_group.create',
  'target.create',
  'ad.create',
  'creative.create',
]);
export type CampaignCreationNodeKind = z.infer<typeof CampaignCreationNodeKind>;

export const CampaignCreationEffect = z.enum(['read_check', 'irreversible_create']);
export type CampaignCreationEffect = z.infer<typeof CampaignCreationEffect>;

export const CampaignCreationRollback = z.enum(['not_applicable', 'none']);
export type CampaignCreationRollback = z.infer<typeof CampaignCreationRollback>;

const nodeBase = {
  nodeId: CampaignCreationUuid,
  adProduct: AdProduct,
  apiDialect: CampaignCreationApiDialect,
  dependsOn: z.array(CampaignCreationUuid),
  fingerprint: CampaignCreationSha256,
};

const requirementNodeBase = {
  ...nodeBase,
  dependsOn: z.tuple([]),
  effect: z.literal('read_check'),
  rollback: z.literal('not_applicable'),
};

const createNodeBase = {
  ...nodeBase,
  effect: z.literal('irreversible_create'),
  rollback: z.literal('none'),
};

export const CampaignCreationAssetPurpose = z.enum([
  'logo',
  'image',
  'video',
  'display_creative',
]);
export type CampaignCreationAssetPurpose = z.infer<typeof CampaignCreationAssetPurpose>;

const RequireProductNode = z.object({
  ...requirementNodeBase,
  kind: z.literal('eligibility.require_product'),
  payload: z.object({
    asin: AmazonId,
    sku: z.string().min(1).nullable(),
  }).strict(),
}).strict();

const RequireBrandNode = z.object({
  ...requirementNodeBase,
  kind: z.literal('eligibility.require_brand'),
  payload: z.object({
    brandId: AmazonId,
    brandEntityId: AmazonId.nullable(),
    brandName: z.string().trim().min(1).max(160),
  }).strict(),
}).strict();

const RequireStoreNode = z.object({
  ...requirementNodeBase,
  kind: z.literal('eligibility.require_store'),
  payload: z.object({
    storeId: AmazonId,
    pageIds: z.array(AmazonId),
  }).strict(),
}).strict();

const RequireAssetNode = z.object({
  ...requirementNodeBase,
  kind: z.literal('asset.require_existing'),
  payload: z.object({
    assetId: AmazonId,
    version: z.string().min(1),
    purpose: CampaignCreationAssetPurpose,
  }).strict(),
}).strict();

const CampaignCreationBudget = z.object({
  amount: z.number().finite().positive(),
  type: BudgetType,
  currencyCode: CurrencyCode,
}).strict();

const CampaignCreationPlacementBidding = z.object({
  topOfSearch: z.number().int().min(0).max(900),
  productPages: z.number().int().min(0).max(900),
  restOfSearch: z.number().int().min(0).max(900),
}).strict();

export const SponsoredBrandsCreationFormat = z.enum([
  'product_collection_manual',
  'product_collection_automatic',
  'store_spotlight',
  'product_video',
]);
export type SponsoredBrandsCreationFormat = z.infer<typeof SponsoredBrandsCreationFormat>;

const CampaignSettings = z.discriminatedUnion('product', [
  z.object({
    product: z.literal('SP'),
    targetingType: TargetingType,
    biddingStrategy: BiddingStrategy,
    placementBidding: CampaignCreationPlacementBidding,
  }).strict(),
  z.object({
    product: z.literal('SB'),
    targetingType: TargetingType,
    format: SponsoredBrandsCreationFormat,
    brand: plannedResourceRef('brand'),
  }).strict(),
  z.object({
    product: z.literal('SD'),
    tactic: z.enum(['contextual', 'audience']),
  }).strict(),
]);

const CreateCampaignNode = z.object({
  ...createNodeBase,
  kind: z.literal('campaign.create'),
  payload: z.object({
    name: z.string().min(1).max(256),
    state: z.literal('paused'),
    budget: CampaignCreationBudget,
    startDate: CampaignCreationIsoDate,
    endDate: CampaignCreationIsoDate.nullable(),
    portfolioId: AmazonId.nullable(),
    settings: CampaignSettings,
  }).strict(),
}).strict().superRefine((node, context) => {
  if (node.payload.settings.product === 'SP' && node.payload.budget.type !== 'daily') {
    context.addIssue({
      code: 'custom',
      path: ['payload', 'budget', 'type'],
      message: 'Sponsored Products campaign creation requires a daily budget',
    });
  }
});

const CreateAdGroupNode = z.object({
  ...createNodeBase,
  kind: z.literal('ad_group.create'),
  payload: z.object({
    campaign: plannedResourceRef('campaign'),
    name: z.string().min(1).max(256),
    state: z.literal('paused'),
    defaultBid: z.number().finite().nonnegative().nullable(),
  }).strict(),
}).strict();

const PositiveKeywordMatchType = z.enum(['exact', 'phrase', 'broad']);
const NegativeKeywordMatchType = z.enum(['negative_exact', 'negative_phrase']);
const ProductExpression = z.object({
  type: z.enum([
    'asin_same_as',
    'asin_expanded_from',
    'asin_brand_same_as',
    'asin_category_same_as',
  ]),
  value: z.string().trim().min(1),
}).strict();
const AutomaticExpression = z.object({
  type: z.enum([
    'close_match',
    'loose_match',
    'substitutes',
    'complements',
  ]),
  value: z.null(),
}).strict();
const CampaignCreationExpression = z.union([ProductExpression, AutomaticExpression]);

const KeywordTargetPayload = z.object({
  targetType: z.literal('keyword'),
  parent: PlannedCampaignCreationResourceRef.refine(
    (reference) => reference.kind === 'campaign' || reference.kind === 'ad_group',
    { message: 'keyword parent must be a campaign or ad group' },
  ),
  scope: z.enum(['campaign', 'ad_group']),
  polarity: z.enum(['positive', 'negative']),
  text: z.string().trim().min(1).max(512),
  matchType: z.union([PositiveKeywordMatchType, NegativeKeywordMatchType]),
  bid: z.number().finite().nonnegative().nullable(),
  state: z.literal('paused'),
}).strict().superRefine((value, context) => {
  if (value.parent.kind !== value.scope) {
    context.addIssue({ code: 'custom', path: ['parent'], message: 'target scope must match its parent resource' });
  }
  const negativeMatch = NegativeKeywordMatchType.safeParse(value.matchType).success;
  if ((value.polarity === 'negative') !== negativeMatch) {
    context.addIssue({ code: 'custom', path: ['matchType'], message: 'keyword polarity and match type disagree' });
  }
  if (value.polarity === 'negative' && value.bid !== null) {
    context.addIssue({ code: 'custom', path: ['bid'], message: 'negative keywords cannot carry a bid' });
  }
  if (value.polarity === 'positive' && value.scope !== 'ad_group') {
    context.addIssue({ code: 'custom', path: ['scope'], message: 'positive keywords require an ad-group parent' });
  }
});

const ExpressionTargetPayload = z.object({
  targetType: z.literal('expression'),
  parent: PlannedCampaignCreationResourceRef.refine(
    (reference) => reference.kind === 'campaign' || reference.kind === 'ad_group',
    { message: 'expression parent must be a campaign or ad group' },
  ),
  scope: z.enum(['campaign', 'ad_group']),
  polarity: z.enum(['positive', 'negative']),
  expression: z.array(CampaignCreationExpression).min(1),
  bid: z.number().finite().nonnegative().nullable(),
  state: z.literal('paused'),
}).strict().superRefine((value, context) => {
  if (value.parent.kind !== value.scope) {
    context.addIssue({ code: 'custom', path: ['parent'], message: 'target scope must match its parent resource' });
  }
  if (value.polarity === 'negative' && value.bid !== null) {
    context.addIssue({ code: 'custom', path: ['bid'], message: 'negative targets cannot carry a bid' });
  }
  if (value.polarity === 'negative'
    && value.expression.some((expression) => AutomaticExpression.safeParse(expression).success)) {
    context.addIssue({ code: 'custom', path: ['expression'], message: 'automatic targeting clauses cannot be negative' });
  }
  if (value.polarity === 'positive' && value.scope !== 'ad_group') {
    context.addIssue({ code: 'custom', path: ['scope'], message: 'positive targets require an ad-group parent' });
  }
});

const UnifiedSponsoredBrandsTargetBase = {
  parent: plannedResourceRef('ad_group'),
  polarity: z.enum(['positive', 'negative']),
  bid: z.number().finite().positive().nullable(),
  state: z.literal('paused'),
};

const UnifiedSponsoredBrandsKeywordTargetPayload = z.object({
  targetType: z.literal('sb_keyword'),
  ...UnifiedSponsoredBrandsTargetBase,
  text: z.string().trim().min(1).max(512),
  matchType: PositiveKeywordMatchType,
}).strict().superRefine((value, context) => {
  if (value.polarity === 'negative' && value.bid !== null) {
    context.addIssue({ code: 'custom', path: ['bid'], message: 'negative targets cannot carry a bid' });
  }
});

const UnifiedSponsoredBrandsProductTargetPayload = z.object({
  targetType: z.literal('sb_product'),
  ...UnifiedSponsoredBrandsTargetBase,
  asin: AmazonId,
}).strict().superRefine((value, context) => {
  if (value.polarity === 'negative' && value.bid !== null) {
    context.addIssue({ code: 'custom', path: ['bid'], message: 'negative targets cannot carry a bid' });
  }
});

const UnifiedSponsoredBrandsProductCategoryTargetPayload = z.object({
  targetType: z.literal('sb_product_category'),
  ...UnifiedSponsoredBrandsTargetBase,
  categoryId: AmazonId,
  brandId: AmazonId.nullable(),
  priceGreaterThan: z.number().finite().nonnegative().nullable(),
  priceLessThan: z.number().finite().nonnegative().nullable(),
  ratingGreaterThan: z.number().finite().min(0).max(5).nullable(),
  ratingLessThan: z.number().finite().min(0).max(5).nullable(),
}).strict().superRefine((value, context) => {
  if (value.polarity === 'negative' && value.bid !== null) {
    context.addIssue({ code: 'custom', path: ['bid'], message: 'negative targets cannot carry a bid' });
  }
  if (value.priceGreaterThan !== null && value.priceLessThan !== null
    && value.priceGreaterThan > value.priceLessThan) {
    context.addIssue({ code: 'custom', path: ['priceLessThan'], message: 'maximum price cannot be below minimum price' });
  }
  if (value.ratingGreaterThan !== null && value.ratingLessThan !== null
    && value.ratingGreaterThan > value.ratingLessThan) {
    context.addIssue({ code: 'custom', path: ['ratingLessThan'], message: 'maximum rating cannot be below minimum rating' });
  }
});

const UnifiedSponsoredBrandsThemeTargetPayload = z.object({
  targetType: z.literal('sb_theme'),
  ...UnifiedSponsoredBrandsTargetBase,
  matchType: z.enum([
    'keywords_related_to_your_brand',
    'keywords_related_to_your_landing_pages',
  ]),
}).strict().superRefine((value, context) => {
  if (value.polarity === 'negative' && value.bid !== null) {
    context.addIssue({ code: 'custom', path: ['bid'], message: 'negative targets cannot carry a bid' });
  }
});

const SponsoredDisplayTargetBase = {
  parent: plannedResourceRef('ad_group'),
  polarity: z.enum(['positive', 'negative']),
  bid: z.number().finite().positive().nullable(),
  state: z.literal('paused'),
};

function rejectNegativeTargetBid(
  value: { polarity: 'positive' | 'negative'; bid: number | null },
  context: z.RefinementCtx,
): void {
  if (value.polarity === 'negative' && value.bid !== null) {
    context.addIssue({ code: 'custom', path: ['bid'], message: 'negative targets cannot carry a bid' });
  }
}

const SponsoredDisplayProductTargetPayload = z.object({
  targetType: z.literal('sd_product'),
  ...SponsoredDisplayTargetBase,
  asin: AmazonId,
}).strict().superRefine(rejectNegativeTargetBid);

const SponsoredDisplayCategoryTargetPayload = z.object({
  targetType: z.literal('sd_category'),
  ...SponsoredDisplayTargetBase,
  categoryId: AmazonId,
}).strict().superRefine(rejectNegativeTargetBid);

const SponsoredDisplayAudienceTargetPayload = z.object({
  targetType: z.literal('sd_audience'),
  ...SponsoredDisplayTargetBase,
  audienceId: AmazonId,
}).strict().superRefine(rejectNegativeTargetBid);

const CreateTargetNode = z.object({
  ...createNodeBase,
  kind: z.literal('target.create'),
  payload: z.discriminatedUnion('targetType', [
    KeywordTargetPayload,
    ExpressionTargetPayload,
    UnifiedSponsoredBrandsKeywordTargetPayload,
    UnifiedSponsoredBrandsProductTargetPayload,
    UnifiedSponsoredBrandsProductCategoryTargetPayload,
    UnifiedSponsoredBrandsThemeTargetPayload,
    SponsoredDisplayProductTargetPayload,
    SponsoredDisplayCategoryTargetPayload,
    SponsoredDisplayAudienceTargetPayload,
  ]),
}).strict();

const StoreLandingPage = z.object({
  type: z.literal('store'),
  store: plannedResourceRef('store'),
  pageId: AmazonId.nullable(),
}).strict();

const GeneratedCollectionLandingPage = z.object({
  type: z.literal('asin_list'),
}).strict();

const SponsoredBrandsCollectionLandingPage = z.discriminatedUnion('type', [
  StoreLandingPage,
  GeneratedCollectionLandingPage,
]);

const StoreSpotlightCard = z.object({
  headline: z.string().trim().min(1).max(128),
  landingPage: StoreLandingPage,
  product: plannedResourceRef('product'),
}).strict();

const ProductDetailLandingPage = z.object({
  type: z.literal('detail_page'),
  product: plannedResourceRef('product'),
}).strict();

const SponsoredBrandsVideoLandingPage = z.discriminatedUnion('type', [
  ProductDetailLandingPage,
  StoreLandingPage,
]);

const sponsoredBrandsAdBase = {
  name: z.string().trim().min(1).max(256),
  adGroup: plannedResourceRef('ad_group'),
  state: z.literal('paused'),
};

const AdPayload = z.discriminatedUnion('format', [
  z.object({
    format: z.literal('sp_product_ad'),
    adGroup: plannedResourceRef('ad_group'),
    product: plannedResourceRef('product'),
    state: z.literal('paused'),
  }).strict(),
  z.object({
    format: z.literal('sb_product_collection_manual'),
    ...sponsoredBrandsAdBase,
    brand: plannedResourceRef('brand'),
    products: z.array(plannedResourceRef('product')).min(3).max(10),
    logoAsset: plannedResourceRef('asset').nullable(),
    title: z.string().trim().min(1).max(128).nullable(),
    landingPage: SponsoredBrandsCollectionLandingPage,
    state: z.literal('paused'),
  }).strict(),
  z.object({
    format: z.literal('sb_product_collection_automatic'),
    ...sponsoredBrandsAdBase,
    brand: plannedResourceRef('brand'),
    logoAsset: plannedResourceRef('asset').nullable(),
    // Deliberate local supported subset: pinned Amazon sources conflict between 100 and 1000.
    productExclusions: z.array(plannedResourceRef('product')).max(100),
  }).strict(),
  z.object({
    format: z.literal('sb_store_spotlight'),
    ...sponsoredBrandsAdBase,
    brand: plannedResourceRef('brand'),
    landingPage: StoreLandingPage,
    logoAsset: plannedResourceRef('asset'),
    headline: z.string().trim().min(1).max(128),
    cards: z.tuple([StoreSpotlightCard, StoreSpotlightCard, StoreSpotlightCard]),
  }).strict(),
  z.object({
    format: z.literal('sb_product_video'),
    ...sponsoredBrandsAdBase,
    brand: plannedResourceRef('brand').nullable(),
    logoAsset: plannedResourceRef('asset').nullable(),
    headline: z.string().trim().min(1).max(128).nullable(),
    enableCreativeAutoTranslation: z.boolean().nullable(),
    landingPage: SponsoredBrandsVideoLandingPage.nullable(),
    products: z.array(plannedResourceRef('product')).max(3),
    videoAsset: plannedResourceRef('asset'),
  }).strict(),
  z.object({
    format: z.literal('sd_product_ad'),
    adGroup: plannedResourceRef('ad_group'),
    product: plannedResourceRef('product'),
    state: z.literal('paused'),
  }).strict(),
]);

const CreateAdNode = z.object({
  ...createNodeBase,
  kind: z.literal('ad.create'),
  payload: AdPayload,
}).strict();

const CreateCreativeNode = z.object({
  ...createNodeBase,
  kind: z.literal('creative.create'),
  payload: z.object({
    format: z.literal('sd_custom'),
    ad: plannedResourceRef('ad'),
    assets: z.array(plannedResourceRef('asset')).min(1),
    headline: z.string().trim().min(1).max(128).nullable(),
    state: z.literal('paused'),
  }).strict(),
}).strict();

export const CampaignCreationNode = z.discriminatedUnion('kind', [
  RequireProductNode,
  RequireBrandNode,
  RequireStoreNode,
  RequireAssetNode,
  CreateCampaignNode,
  CreateAdGroupNode,
  CreateTargetNode,
  CreateAdNode,
  CreateCreativeNode,
]);
export type CampaignCreationNode = z.infer<typeof CampaignCreationNode>;

const count = z.number().int().nonnegative();

const CountsByKind = z.object({
  'eligibility.require_product': count,
  'eligibility.require_brand': count,
  'eligibility.require_store': count,
  'asset.require_existing': count,
  'campaign.create': count,
  'ad_group.create': count,
  'target.create': count,
  'ad.create': count,
  'creative.create': count,
}).strict();

export const CampaignCreationPlanCounts = z.object({
  totalNodes: count,
  readChecks: count,
  irreversibleCreates: count,
  byKind: CountsByKind,
}).strict().superRefine((value, context) => {
  const byKindTotal = Object.values(value.byKind).reduce((sum, current) => sum + current, 0);
  if (byKindTotal !== value.totalNodes) {
    context.addIssue({ code: 'custom', path: ['byKind'], message: 'node-kind counts must equal total nodes' });
  }
  if (value.readChecks + value.irreversibleCreates !== value.totalNodes) {
    context.addIssue({ code: 'custom', message: 'read checks plus irreversible creates must equal total nodes' });
  }
});
export type CampaignCreationPlanCounts = z.infer<typeof CampaignCreationPlanCounts>;

export const CampaignCreationNoRollbackAcknowledgement = z.object({
  required: z.literal(true),
  rollback: z.literal('none'),
  compensatingAction: z.literal('separate_reviewed_pause_or_archive'),
}).strict();
export type CampaignCreationNoRollbackAcknowledgement = z.infer<
  typeof CampaignCreationNoRollbackAcknowledgement
>;

function expectedDialectProduct(
  dialect: CampaignCreationApiDialect,
  product: AdProduct,
): boolean {
  if (dialect === 'sp_legacy_v3') return product === 'SP';
  if (dialect === 'sd_legacy') return product === 'SD';
  return product === 'SP' || product === 'SB';
}

function instantMillis(value: string): number {
  return Date.parse(value);
}

function producedResourceKind(node: CampaignCreationNode): CampaignCreationResourceKind {
  switch (node.kind) {
    case 'eligibility.require_product': return 'product';
    case 'eligibility.require_brand': return 'brand';
    case 'eligibility.require_store': return 'store';
    case 'asset.require_existing': return 'asset';
    case 'campaign.create': return 'campaign';
    case 'ad_group.create': return 'ad_group';
    case 'target.create': return 'target';
    case 'ad.create': return 'ad';
    case 'creative.create': return 'creative';
  }
}

function requirementIdentityKey(node: CampaignCreationNode): string | undefined {
  switch (node.kind) {
    case 'eligibility.require_product':
      return `product:${node.payload.asin}`;
    case 'eligibility.require_brand':
      return `brand:${node.payload.brandId}`;
    case 'eligibility.require_store':
      return `store:${node.payload.storeId}`;
    case 'asset.require_existing':
      return `asset:${node.payload.assetId}:${node.payload.version}`;
    default:
      return undefined;
  }
}

function expectedRequirementProviderEntityId(node: CampaignCreationNode): string | undefined {
  switch (node.kind) {
    case 'eligibility.require_product': return node.payload.asin;
    case 'eligibility.require_brand': return node.payload.brandId;
    case 'eligibility.require_store': return node.payload.storeId;
    case 'asset.require_existing': return node.payload.assetId;
    default: return undefined;
  }
}

function nodeReferences(node: CampaignCreationNode): CampaignCreationResourceRef[] {
  switch (node.kind) {
    case 'eligibility.require_product':
    case 'eligibility.require_brand':
    case 'eligibility.require_store':
    case 'asset.require_existing':
      return [];
    case 'campaign.create':
      return node.payload.settings.product === 'SB' ? [node.payload.settings.brand] : [];
    case 'ad_group.create':
      return [node.payload.campaign];
    case 'target.create':
      return [node.payload.parent];
    case 'creative.create':
      return [node.payload.ad, ...node.payload.assets];
    case 'ad.create': {
      const payload = node.payload;
      switch (payload.format) {
        case 'sp_product_ad':
        case 'sd_product_ad':
          return [payload.adGroup, payload.product];
        case 'sb_product_video':
          return [
            payload.adGroup,
            payload.videoAsset,
            ...payload.products,
            ...(payload.brand === null ? [] : [payload.brand]),
            ...(payload.logoAsset === null ? [] : [payload.logoAsset]),
            ...(payload.landingPage === null ? [] : payload.landingPage.type === 'store'
              ? [payload.landingPage.store]
              : [payload.landingPage.product]),
          ];
        case 'sb_product_collection_manual':
          return [
            payload.adGroup,
            payload.brand,
            ...payload.products,
            ...(payload.logoAsset === null ? [] : [payload.logoAsset]),
            ...(payload.landingPage.type === 'store'
              ? [payload.landingPage.store]
              : []),
          ];
        case 'sb_product_collection_automatic':
          return [
            payload.adGroup,
            payload.brand,
            ...(payload.logoAsset === null ? [] : [payload.logoAsset]),
            ...payload.productExclusions,
          ];
        case 'sb_store_spotlight':
          return [
            payload.adGroup,
            payload.brand,
            payload.landingPage.store,
            payload.logoAsset,
            ...payload.cards.flatMap((card) => [card.landingPage.store, card.product]),
          ];
      }
    }
  }
}

function referenceKey(reference: CampaignCreationResourceRef): string {
  return `${reference.source}:${reference.kind}:${reference.nodeId}`;
}

function referencedPlanNode(
  reference: CampaignCreationResourceRef,
  byId: ReadonlyMap<string, CampaignCreationNode>,
): CampaignCreationNode | undefined {
  return byId.get(reference.nodeId);
}

function campaignForParent(
  reference: CampaignCreationResourceRef,
  byId: ReadonlyMap<string, CampaignCreationNode>,
): CampaignCreationNode | undefined {
  const parent = referencedPlanNode(reference, byId);
  if (parent?.kind === 'campaign.create') return parent;
  if (parent?.kind !== 'ad_group.create') return undefined;
  return referencedPlanNode(parent.payload.campaign, byId);
}

function nodeStage(node: CampaignCreationNode): number {
  if (node.effect === 'read_check') return 0;
  if (node.kind === 'campaign.create') return 1;
  if (node.kind === 'ad_group.create') return 2;
  if (node.kind === 'creative.create') return 5;
  if (node.adProduct === 'SB') return node.kind === 'target.create' ? 3 : 4;
  return node.kind === 'ad.create' ? 3 : 4;
}

/** Deterministic dependency order used before freezing and hashing a plan. */
export function orderCampaignCreationNodes(
  rawNodes: readonly CampaignCreationNode[],
): CampaignCreationNode[] {
  const nodes = rawNodes.map((rawNode) => {
    const node = CampaignCreationNode.parse(rawNode);
    const dependsOn = [...node.dependsOn];
    if (new Set(dependsOn).size !== dependsOn.length) {
      throw new Error(`campaign creation node ${node.nodeId} repeats a dependency`);
    }
    return { ...node, dependsOn: dependsOn.sort() } as CampaignCreationNode;
  });
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  if (byId.size !== nodes.length) throw new Error('campaign creation plan repeats a node ID');

  const indegree = new Map(nodes.map((node) => [node.nodeId, 0]));
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dependencyId of node.dependsOn) {
      if (!byId.has(dependencyId)) {
        throw new Error(`campaign creation node ${node.nodeId} has an unknown dependency`);
      }
      indegree.set(node.nodeId, (indegree.get(node.nodeId) ?? 0) + 1);
      children.set(dependencyId, [...(children.get(dependencyId) ?? []), node.nodeId]);
    }
  }

  const compare = (leftId: string, rightId: string): number => {
    const left = byId.get(leftId) as CampaignCreationNode;
    const right = byId.get(rightId) as CampaignCreationNode;
    const stageOrder = nodeStage(left) - nodeStage(right);
    if (stageOrder !== 0) return stageOrder;
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  };
  const ready = nodes.filter((node) => indegree.get(node.nodeId) === 0)
    .map((node) => node.nodeId).sort(compare);
  const ordered: CampaignCreationNode[] = [];
  while (ready.length > 0) {
    const nodeId = ready.shift() as string;
    ordered.push(byId.get(nodeId) as CampaignCreationNode);
    for (const childId of children.get(nodeId) ?? []) {
      const remaining = (indegree.get(childId) ?? 0) - 1;
      indegree.set(childId, remaining);
      if (remaining === 0) {
        ready.push(childId);
        ready.sort(compare);
      }
    }
  }
  if (ordered.length !== nodes.length) throw new Error('campaign creation plan contains a dependency cycle');
  return ordered;
}

export const CampaignCreationPlan = z.object({
  schemaVersion: CampaignCreationSchemaVersion,
  id: CampaignCreationUuid,
  orgId: CampaignCreationUuid,
  profileId: CampaignCreationUuid,
  marketplaceId: AmazonId,
  adProduct: AdProduct,
  apiDialect: CampaignCreationApiDialect,
  generatedAt: z.iso.datetime(),
  frozenAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  nodes: z.array(CampaignCreationNode).min(1),
  counts: CampaignCreationPlanCounts,
  fingerprint: CampaignCreationSha256,
  noRollbackAcknowledgement: CampaignCreationNoRollbackAcknowledgement,
}).strict().superRefine((plan, context) => {
  if (!expectedDialectProduct(plan.apiDialect, plan.adProduct)) {
    context.addIssue({ code: 'custom', path: ['apiDialect'], message: 'API dialect does not support this ad product' });
  }
  if (!(instantMillis(plan.generatedAt) <= instantMillis(plan.frozenAt)
    && instantMillis(plan.frozenAt) < instantMillis(plan.expiresAt))) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'plan timestamps must satisfy generated <= frozen < expires' });
  }

  const byId = new Map(plan.nodes.map((node) => [node.nodeId, node]));
  if (byId.size !== plan.nodes.length) {
    context.addIssue({ code: 'custom', path: ['nodes'], message: 'node IDs must be unique' });
    return;
  }

  const requirementOwners = new Map<string, string>();
  const automaticCollectionAdGroupOwners = new Map<string, string>();
  for (const [index, node] of plan.nodes.entries()) {
    const identity = requirementIdentityKey(node);
    if (identity === undefined) continue;
    const owner = requirementOwners.get(identity);
    if (owner !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['nodes', index, 'payload'],
        message: `provider resource is already checked by node ${owner}`,
      });
    } else {
      requirementOwners.set(identity, node.nodeId);
    }
  }

  for (const [index, node] of plan.nodes.entries()) {
    if (node.adProduct !== plan.adProduct || node.apiDialect !== plan.apiDialect) {
      context.addIssue({ code: 'custom', path: ['nodes', index], message: 'node scope differs from its plan' });
    }
    if (new Set(node.dependsOn).size !== node.dependsOn.length
      || JSON.stringify(node.dependsOn) !== JSON.stringify([...node.dependsOn].sort())) {
      context.addIssue({ code: 'custom', path: ['nodes', index, 'dependsOn'], message: 'dependencies must be unique and lexically sorted' });
    }
    if (node.kind === 'eligibility.require_brand' || node.kind === 'eligibility.require_store') {
      if (node.adProduct !== 'SB') {
        context.addIssue({ code: 'custom', path: ['nodes', index], message: 'brand and Store checks are Sponsored Brands only' });
      }
    }
    if (node.kind === 'asset.require_existing' && node.adProduct === 'SP') {
      context.addIssue({ code: 'custom', path: ['nodes', index], message: 'Sponsored Products creation does not use creative assets' });
    }
    if (node.kind === 'campaign.create' && node.payload.settings.product !== node.adProduct) {
      context.addIssue({ code: 'custom', path: ['nodes', index, 'payload', 'settings'], message: 'campaign settings differ from the node product' });
    }
    if (node.kind === 'campaign.create' && node.payload.settings.product === 'SB'
      && node.payload.settings.targetingType !== 'manual') {
      context.addIssue({ code: 'custom', path: ['nodes', index, 'payload', 'settings', 'targetingType'], message: 'Sponsored Brands creation uses manual keyword or product targeting' });
    }
    if (node.kind === 'campaign.create' && node.payload.endDate !== null
      && node.payload.endDate < node.payload.startDate) {
      context.addIssue({ code: 'custom', path: ['nodes', index, 'payload', 'endDate'], message: 'campaign end date cannot precede its start date' });
    }
    if (node.kind === 'ad.create') {
      const productForFormat = node.payload.format.startsWith('sp_')
        ? 'SP'
        : node.payload.format.startsWith('sb_') ? 'SB' : 'SD';
      if (productForFormat !== node.adProduct) {
        context.addIssue({ code: 'custom', path: ['nodes', index, 'payload', 'format'], message: 'ad format differs from the node product' });
      }
    }
    if (node.kind === 'creative.create' && node.adProduct !== 'SD') {
      context.addIssue({ code: 'custom', path: ['nodes', index], message: 'custom creative creation is Sponsored Display only' });
    }

    for (const dependencyId of node.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (dependency !== undefined && nodeStage(dependency) >= nodeStage(node)) {
        context.addIssue({
          code: 'custom',
          path: ['nodes', index, 'dependsOn'],
          message: 'dependencies must point to an earlier execution stage',
        });
      }
    }

    for (const reference of nodeReferences(node)) {
      const referenced = byId.get(reference.nodeId);
      if (!referenced) {
        context.addIssue({ code: 'custom', path: ['nodes', index], message: 'plan-node reference is missing' });
        continue;
      }
      if (!new Set<string>(node.dependsOn).has(reference.nodeId)) {
        context.addIssue({ code: 'custom', path: ['nodes', index, 'dependsOn'], message: 'every plan-node reference must be an explicit dependency' });
      }
      if (producedResourceKind(referenced) !== reference.kind) {
        context.addIssue({ code: 'custom', path: ['nodes', index], message: 'plan-node reference expects the wrong resource kind' });
      }
    }

    const requireCheckedResource = (
      reference: CampaignCreationResourceRef,
      expectedKind: CampaignCreationResourceKind,
      expectedAssetPurpose?: CampaignCreationAssetPurpose,
    ): CampaignCreationNode | undefined => {
      const requirement = byId.get(reference.nodeId);
      if (!requirement || producedResourceKind(requirement) !== expectedKind
        || requirement.effect !== 'read_check') {
        context.addIssue({
          code: 'custom',
          path: ['nodes', index],
          message: `${expectedKind} use does not resolve to the expected preflight`,
        });
        return requirement;
      }
      if (expectedAssetPurpose !== undefined
        && (requirement.kind !== 'asset.require_existing'
          || requirement.payload.purpose !== expectedAssetPurpose)) {
        context.addIssue({
          code: 'custom',
          path: ['nodes', index],
          message: `asset use requires the ${expectedAssetPurpose} purpose`,
        });
      }
      return requirement;
    };

    if (node.kind === 'campaign.create' && node.payload.settings.product === 'SB') {
      requireCheckedResource(node.payload.settings.brand, 'brand');
    }

    if (node.kind === 'ad.create') {
      const payload = node.payload;
      const parentCampaign = campaignForParent(payload.adGroup, byId);
      if (parentCampaign?.kind === 'campaign.create'
        && parentCampaign.payload.settings.product === 'SB') {
        const expectedFormat = `sb_${parentCampaign.payload.settings.format}`;
        if (payload.format !== expectedFormat) {
          context.addIssue({
            code: 'custom',
            path: ['nodes', index, 'payload', 'format'],
            message: 'Sponsored Brands ad format differs from its campaign format',
          });
        }
      }
      const requireCampaignBrand = (
        brand: CampaignCreationResourceRef,
      ): void => {
        requireCheckedResource(brand, 'brand');
        if (parentCampaign?.kind === 'campaign.create'
          && parentCampaign.payload.settings.product === 'SB'
          && referenceKey(parentCampaign.payload.settings.brand) !== referenceKey(brand)) {
          context.addIssue({
            code: 'custom',
            path: ['nodes', index, 'payload', 'brand'],
            message: 'Sponsored Brands creative brand differs from its campaign brand',
          });
        }
      };
      switch (payload.format) {
        case 'sp_product_ad':
        case 'sd_product_ad':
          requireCheckedResource(payload.product, 'product');
          break;
        case 'sb_product_video': {
          if (payload.brand !== null) requireCampaignBrand(payload.brand);
          if (payload.logoAsset !== null) {
            requireCheckedResource(payload.logoAsset, 'asset', 'logo');
          }
          const productKeys = payload.products.map(referenceKey);
          if (new Set(productKeys).size !== productKeys.length) {
            context.addIssue({ code: 'custom', path: ['nodes', index, 'payload', 'products'], message: 'video products must be unique' });
          }
          payload.products.forEach((product) => requireCheckedResource(product, 'product'));
          if (payload.landingPage?.type === 'detail_page') {
            requireCheckedResource(payload.landingPage.product, 'product');
          }
          if (payload.landingPage?.type === 'store') {
            const store = requireCheckedResource(payload.landingPage.store, 'store');
            if (payload.landingPage.pageId !== null && store?.kind === 'eligibility.require_store'
              && !store.payload.pageIds.includes(payload.landingPage.pageId)) {
              context.addIssue({ code: 'custom', path: ['nodes', index, 'payload', 'landingPage', 'pageId'], message: 'landing page is absent from the checked Store' });
            }
          }
          requireCheckedResource(payload.videoAsset, 'asset', 'video');
          break;
        }
        case 'sb_product_collection_manual': {
          requireCampaignBrand(payload.brand);
          const productKeys = payload.products.map(referenceKey);
          if (new Set(productKeys).size !== productKeys.length) {
            context.addIssue({ code: 'custom', path: ['nodes', index, 'payload', 'products'], message: 'collection products must be unique' });
          }
          payload.products.forEach((product) => requireCheckedResource(product, 'product'));
          if (payload.logoAsset !== null) {
            requireCheckedResource(payload.logoAsset, 'asset', 'logo');
          }
          if (payload.landingPage.type === 'store') {
            const store = requireCheckedResource(payload.landingPage.store, 'store');
            if (payload.landingPage.pageId !== null && store?.kind === 'eligibility.require_store'
              && !store.payload.pageIds.includes(payload.landingPage.pageId)) {
              context.addIssue({ code: 'custom', path: ['nodes', index, 'payload', 'landingPage', 'pageId'], message: 'landing page is absent from the checked Store' });
            }
          }
          break;
        }
        case 'sb_product_collection_automatic': {
          requireCampaignBrand(payload.brand);
          const adGroupKey = referenceKey(payload.adGroup);
          const existingAdNodeId = automaticCollectionAdGroupOwners.get(adGroupKey);
          if (existingAdNodeId !== undefined) {
            context.addIssue({
              code: 'custom',
              path: ['nodes', index, 'payload', 'adGroup'],
              message: `automatic Sponsored Brands collection ad group is already used by node ${existingAdNodeId}`,
            });
          } else {
            automaticCollectionAdGroupOwners.set(adGroupKey, node.nodeId);
          }
          if (payload.logoAsset !== null) {
            requireCheckedResource(payload.logoAsset, 'asset', 'logo');
          }
          const exclusionKeys = payload.productExclusions.map(referenceKey);
          if (new Set(exclusionKeys).size !== exclusionKeys.length) {
            context.addIssue({ code: 'custom', path: ['nodes', index, 'payload', 'productExclusions'], message: 'automatic-collection exclusions must be unique' });
          }
          payload.productExclusions.forEach((product) => requireCheckedResource(product, 'product'));
          break;
        }
        case 'sb_store_spotlight': {
          requireCampaignBrand(payload.brand);
          const store = requireCheckedResource(payload.landingPage.store, 'store');
          requireCheckedResource(payload.logoAsset, 'asset', 'logo');
          const pageIds = payload.cards.map((card) => card.landingPage.pageId);
          if (new Set(pageIds).size !== pageIds.length) {
            context.addIssue({ code: 'custom', path: ['nodes', index, 'payload', 'cards'], message: 'Store Spotlight pages must be unique' });
          }
          if (store?.kind === 'eligibility.require_store'
            && pageIds.some((pageId) => pageId === null || !store.payload.pageIds.includes(pageId))) {
            context.addIssue({ code: 'custom', path: ['nodes', index, 'payload', 'cards'], message: 'a Store Spotlight page is absent from the checked Store' });
          }
          const productKeys = payload.cards.map((card) => referenceKey(card.product));
          if (new Set(productKeys).size !== productKeys.length) {
            context.addIssue({ code: 'custom', path: ['nodes', index, 'payload', 'cards'], message: 'Store Spotlight products must be unique' });
          }
          payload.cards.forEach((card) => {
            requireCheckedResource(card.product, 'product');
            requireCheckedResource(card.landingPage.store, 'store');
            if (referenceKey(card.landingPage.store) !== referenceKey(payload.landingPage.store)) {
              context.addIssue({ code: 'custom', path: ['nodes', index, 'payload', 'cards'], message: 'Store Spotlight cards must use the checked campaign Store' });
            }
          });
          break;
        }
      }
    }

    if (node.kind === 'target.create') {
      const parentCampaign = campaignForParent(node.payload.parent, byId);
      const unifiedSponsoredBrandsTarget = node.payload.targetType.startsWith('sb_');
      const sponsoredDisplayTarget = node.payload.targetType.startsWith('sd_');
      if (node.adProduct === 'SB' && !unifiedSponsoredBrandsTarget) {
        context.addIssue({ code: 'custom', path: ['nodes', index, 'payload'], message: 'Unified Sponsored Brands targets require a typed SB targetDetails variant' });
      }
      if (node.adProduct !== 'SB' && unifiedSponsoredBrandsTarget) {
        context.addIssue({ code: 'custom', path: ['nodes', index, 'payload'], message: 'Unified Sponsored Brands targetDetails cannot be used by another ad product' });
      }
      if (node.adProduct === 'SD' && !sponsoredDisplayTarget) {
        context.addIssue({ code: 'custom', path: ['nodes', index, 'payload'], message: 'Sponsored Display targets require a typed SD target variant' });
      }
      if (node.adProduct !== 'SD' && sponsoredDisplayTarget) {
        context.addIssue({ code: 'custom', path: ['nodes', index, 'payload'], message: 'Sponsored Display target variants cannot be used by another ad product' });
      }
      if (node.adProduct === 'SP'
        && node.payload.targetType !== 'keyword'
        && node.payload.targetType !== 'expression') {
        context.addIssue({ code: 'custom', path: ['nodes', index, 'payload'], message: 'Sponsored Products targets require a keyword or SP expression variant' });
      }
      if (node.adProduct === 'SP' && node.payload.targetType === 'expression') {
        const hasAutomaticClause = node.payload.expression.some(
          (expression) => AutomaticExpression.safeParse(expression).success,
        );
        if (parentCampaign?.kind === 'campaign.create'
          && parentCampaign.payload.settings.product === 'SP'
          && parentCampaign.payload.settings.targetingType === 'manual'
          && hasAutomaticClause) {
          context.addIssue({ code: 'custom', path: ['nodes', index, 'payload', 'expression'], message: 'manual Sponsored Products campaigns cannot create automatic targeting clauses' });
        }
      }
      if (node.adProduct === 'SP'
        && parentCampaign?.kind === 'campaign.create'
        && parentCampaign.payload.settings.product === 'SP'
        && parentCampaign.payload.settings.targetingType === 'auto'
        && node.payload.polarity === 'positive') {
        const automaticOnly = node.payload.targetType === 'expression'
          && node.payload.expression.every(
            (expression) => AutomaticExpression.safeParse(expression).success,
          );
        if (!automaticOnly) {
          context.addIssue({ code: 'custom', path: ['nodes', index, 'payload'], message: 'automatic Sponsored Products campaigns cannot create positive manual targets' });
        }
      }
      if (parentCampaign?.kind === 'campaign.create'
        && parentCampaign.payload.settings.product === 'SB'
        && parentCampaign.payload.settings.format === 'product_collection_automatic'
        && node.payload.targetType !== 'sb_keyword') {
        context.addIssue({ code: 'custom', path: ['nodes', index, 'payload'], message: 'automatic Sponsored Brands collections support keyword targeting only' });
      }
      if (parentCampaign?.kind === 'campaign.create'
        && parentCampaign.payload.settings.product === 'SD') {
        const audienceTarget = node.payload.targetType === 'sd_audience';
        if ((parentCampaign.payload.settings.tactic === 'audience') !== audienceTarget) {
          context.addIssue({ code: 'custom', path: ['nodes', index, 'payload'], message: 'Sponsored Display target variant differs from the campaign tactic' });
        }
      }
    }

    if (node.kind === 'creative.create') {
      const assetKeys = node.payload.assets.map(referenceKey);
      if (new Set(assetKeys).size !== assetKeys.length) {
        context.addIssue({ code: 'custom', path: ['nodes', index, 'payload', 'assets'], message: 'custom creative assets must be unique' });
      }
      node.payload.assets.forEach((asset) => requireCheckedResource(asset, 'asset', 'display_creative'));
    }
  }

  try {
    const canonicalIds = orderCampaignCreationNodes(plan.nodes).map((node) => node.nodeId);
    if (JSON.stringify(canonicalIds) !== JSON.stringify(plan.nodes.map((node) => node.nodeId))) {
      context.addIssue({ code: 'custom', path: ['nodes'], message: 'nodes are not in deterministic dependency order' });
    }
  } catch (error) {
    context.addIssue({ code: 'custom', path: ['nodes'], message: error instanceof Error ? error.message : 'invalid dependency graph' });
  }

  const actualByKind = Object.fromEntries(
    CampaignCreationNodeKind.options.map((kind) => [
      kind,
      plan.nodes.filter((node) => node.kind === kind).length,
    ]),
  );
  const readChecks = plan.nodes.filter((node) => node.effect === 'read_check').length;
  const irreversibleCreates = plan.nodes.length - readChecks;
  if (plan.counts.totalNodes !== plan.nodes.length
    || plan.counts.readChecks !== readChecks
    || plan.counts.irreversibleCreates !== irreversibleCreates
    || JSON.stringify(plan.counts.byKind) !== JSON.stringify(actualByKind)) {
    context.addIssue({ code: 'custom', path: ['counts'], message: 'declared counts do not reconcile with plan nodes' });
  }
  if (plan.counts.byKind['campaign.create'] === 0) {
    context.addIssue({ code: 'custom', path: ['counts', 'byKind', 'campaign.create'], message: 'a creation plan must create at least one campaign' });
  }
});
export type CampaignCreationPlan = z.infer<typeof CampaignCreationPlan>;

/** Canonical node preimage. Hash with SHA-256 in a Node-capable boundary. */
export function serializeCampaignCreationNodeFingerprint(rawNode: CampaignCreationNode): string {
  const node = CampaignCreationNode.parse(rawNode);
  return JSON.stringify([
    'openspell.campaign-creation-node.v1',
    node.nodeId,
    node.kind,
    node.adProduct,
    node.apiDialect,
    [...node.dependsOn].sort(),
    node.effect,
    node.rollback,
    node.payload,
  ]);
}

/** Canonical plan preimage. Node semantics are transitively bound by their fingerprints. */
export function serializeCampaignCreationPlanFingerprint(rawPlan: CampaignCreationPlan): string {
  const plan = CampaignCreationPlan.parse(rawPlan);
  return JSON.stringify([
    plan.schemaVersion,
    plan.id,
    plan.orgId,
    plan.profileId,
    plan.marketplaceId,
    plan.adProduct,
    plan.apiDialect,
    plan.generatedAt,
    plan.frozenAt,
    plan.expiresAt,
    plan.nodes.map((node) => [node.nodeId, node.fingerprint]),
    plan.counts,
    plan.noRollbackAcknowledgement,
  ]);
}

/** Runtime-neutral SHA-256 boundary supplied by a capable caller. */
export type CampaignCreationSha256Hasher = {
  algorithm: 'sha256';
  digest: (preimage: string) => string;
};

/**
 * Recompute every stored digest before a persisted plan is approved or used.
 * Parsing proves shape and graph invariants; this separate trust-boundary check
 * proves that the immutable artifact still matches its canonical preimages.
 */
export function verifyCampaignCreationPlanFingerprints(
  rawPlan: CampaignCreationPlan,
  hashSha256: CampaignCreationSha256Hasher,
): CampaignCreationPlan {
  const plan = CampaignCreationPlan.parse(rawPlan);
  if (hashSha256.algorithm !== 'sha256') {
    throw new Error('campaign creation fingerprint verifier requires SHA-256');
  }
  for (const node of plan.nodes) {
    const actual = CampaignCreationSha256.parse(
      hashSha256.digest(serializeCampaignCreationNodeFingerprint(node)),
    );
    if (actual !== node.fingerprint) {
      throw new Error(`campaign creation node ${node.nodeId} fingerprint does not match`);
    }
  }
  const actualPlanFingerprint = CampaignCreationSha256.parse(
    hashSha256.digest(serializeCampaignCreationPlanFingerprint(plan)),
  );
  if (actualPlanFingerprint !== plan.fingerprint) {
    throw new Error('campaign creation plan fingerprint does not match');
  }
  return plan;
}

/** Exact approval ceremony input. Actor and approval time come from the authenticated DB session. */
export const ApproveCampaignCreationPlan = z.object({
  schemaVersion: CampaignCreationSchemaVersion,
  planId: CampaignCreationUuid,
  planFingerprint: CampaignCreationSha256,
  orgId: CampaignCreationUuid,
  profileId: CampaignCreationUuid,
  marketplaceId: AmazonId,
  adProduct: AdProduct,
  apiDialect: CampaignCreationApiDialect,
  expiresAt: z.iso.datetime(),
  expectedCounts: CampaignCreationPlanCounts,
  noRollbackAcknowledgement: CampaignCreationNoRollbackAcknowledgement,
}).strict().superRefine((approval, context) => {
  if (!expectedDialectProduct(approval.apiDialect, approval.adProduct)) {
    context.addIssue({ code: 'custom', path: ['apiDialect'], message: 'API dialect does not support this ad product' });
  }
  if (approval.expectedCounts.byKind['campaign.create'] === 0) {
    context.addIssue({ code: 'custom', path: ['expectedCounts'], message: 'approval must cover at least one campaign create' });
  }
});
export type ApproveCampaignCreationPlan = z.infer<typeof ApproveCampaignCreationPlan>;

export const CampaignCreationConfirmationVersion = z.literal(
  'openspell.campaign-creation.no-delete-rollback.v1',
);
export type CampaignCreationConfirmationVersion = z.infer<
  typeof CampaignCreationConfirmationVersion
>;

/**
 * Immutable authorization evidence issued by the authenticated persistence
 * boundary after it reloads and verifies the exact frozen plan. A queue job is
 * only a pointer to this receipt; it never grants authority by itself.
 */
export const CampaignCreationAuthorizationReceipt = z.object({
  authorizationId: CampaignCreationUuid,
  executionId: CampaignCreationUuid,
  generation: CampaignCreationUuid,
  schemaVersion: CampaignCreationSchemaVersion,
  planId: CampaignCreationUuid,
  planFingerprint: CampaignCreationSha256,
  orgId: CampaignCreationUuid,
  profileId: CampaignCreationUuid,
  marketplaceId: AmazonId,
  adProduct: AdProduct,
  apiDialect: CampaignCreationApiDialect,
  expiresAt: z.iso.datetime(),
  expectedCounts: CampaignCreationPlanCounts,
  noRollbackAcknowledgement: CampaignCreationNoRollbackAcknowledgement,
  confirmationVersion: CampaignCreationConfirmationVersion,
  approvedBy: CampaignCreationUuid,
  approvedAt: z.iso.datetime(),
  gateSnapshotDigest: CampaignCreationSha256,
}).strict().superRefine((receipt, context) => {
  if (!expectedDialectProduct(receipt.apiDialect, receipt.adProduct)) {
    context.addIssue({ code: 'custom', path: ['apiDialect'], message: 'API dialect does not support this ad product' });
  }
  if (receipt.expectedCounts.byKind['campaign.create'] === 0) {
    context.addIssue({ code: 'custom', path: ['expectedCounts'], message: 'authorization must cover at least one campaign create' });
  }
  if (instantMillis(receipt.approvedAt) >= instantMillis(receipt.expiresAt)) {
    context.addIssue({ code: 'custom', path: ['approvedAt'], message: 'authorization must be issued before the plan expires' });
  }
});
export type CampaignCreationAuthorizationReceipt = z.infer<
  typeof CampaignCreationAuthorizationReceipt
>;

export const CampaignCreationProviderCallPosition = z.object({
  requestIndex: z.number().int().nonnegative(),
  nodeId: CampaignCreationUuid,
  nodeFingerprint: CampaignCreationSha256,
  requestDigest: CampaignCreationSha256,
}).strict();
export type CampaignCreationProviderCallPosition = z.infer<
  typeof CampaignCreationProviderCallPosition
>;

/**
 * Write-ahead evidence for an irreversible provider request. Persistence must
 * commit this intent before network I/O. Once a node appears in an intent, a
 * retry may observe or reconcile it but must never issue another create.
 */
export const CampaignCreationProviderCallIntent = z.object({
  planId: CampaignCreationUuid,
  planFingerprint: CampaignCreationSha256,
  executionId: CampaignCreationUuid,
  authorizationId: CampaignCreationUuid,
  generation: CampaignCreationUuid,
  attemptId: CampaignCreationUuid,
  providerCallId: CampaignCreationUuid,
  requestDigest: CampaignCreationSha256,
  positions: z.array(CampaignCreationProviderCallPosition).min(1),
  recordedAt: z.iso.datetime(),
}).strict().superRefine((intent, context) => {
  const indexes = intent.positions.map((position) => position.requestIndex);
  const canonicalIndexes = intent.positions.map((_, index) => index);
  if (JSON.stringify(indexes) !== JSON.stringify(canonicalIndexes)) {
    context.addIssue({ code: 'custom', path: ['positions'], message: 'provider call positions must be a complete ordered zero-based sequence' });
  }
  const nodeIds = intent.positions.map((position) => position.nodeId);
  if (new Set(nodeIds).size !== nodeIds.length) {
    context.addIssue({ code: 'custom', path: ['positions'], message: 'a provider call cannot repeat a plan node' });
  }
});
export type CampaignCreationProviderCallIntent = z.infer<
  typeof CampaignCreationProviderCallIntent
>;

export const CampaignCreationProviderResult = z.discriminatedUnion('effect', [
  z.object({
    effect: z.literal('read_check'),
    planId: CampaignCreationUuid,
    nodeId: CampaignCreationUuid,
    executionId: CampaignCreationUuid,
    attemptId: CampaignCreationUuid,
    providerCallId: CampaignCreationUuid,
    nodeFingerprint: CampaignCreationSha256,
    requestIndex: z.number().int().nonnegative().nullable(),
    outcome: z.enum(['passed', 'refused', 'failed']),
    providerEntityId: AmazonId.nullable(),
    providerEntityVersion: z.string().min(1).nullable(),
    providerCode: z.string().max(160).nullable(),
    sanitizedMessage: z.string().max(512).nullable(),
    providerRequestId: z.string().min(1).max(256).nullable(),
    responseDigest: CampaignCreationSha256.nullable(),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
  }).strict().superRefine((value, context) => {
    if (value.outcome === 'passed' && value.providerEntityId === null) {
      context.addIssue({ code: 'custom', path: ['providerEntityId'], message: 'a passed resource check must identify the provider resource' });
    }
    if (value.outcome !== 'passed' && value.providerEntityId !== null) {
      context.addIssue({ code: 'custom', path: ['providerEntityId'], message: 'a refused or failed check cannot claim a provider resource' });
    }
    if (value.outcome !== 'passed' && value.providerEntityVersion !== null) {
      context.addIssue({ code: 'custom', path: ['providerEntityVersion'], message: 'a refused or failed check cannot claim a provider resource version' });
    }
    if (instantMillis(value.completedAt) < instantMillis(value.startedAt)) {
      context.addIssue({ code: 'custom', path: ['completedAt'], message: 'provider result cannot complete before it starts' });
    }
  }),
  z.object({
    effect: z.literal('irreversible_create'),
    planId: CampaignCreationUuid,
    nodeId: CampaignCreationUuid,
    executionId: CampaignCreationUuid,
    attemptId: CampaignCreationUuid,
    providerCallId: CampaignCreationUuid,
    nodeFingerprint: CampaignCreationSha256,
    requestIndex: z.number().int().nonnegative(),
    requestDigest: CampaignCreationSha256,
    nodeRequestDigest: CampaignCreationSha256,
    outcome: z.enum(['succeeded', 'authoritative_rejected', 'ambiguous']),
    providerEntityId: AmazonId.nullable(),
    providerEntityVersion: z.null(),
    providerCode: z.string().max(160).nullable(),
    sanitizedMessage: z.string().max(512).nullable(),
    providerRequestId: z.string().min(1).max(256).nullable(),
    responseDigest: CampaignCreationSha256.nullable(),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
  }).strict().superRefine((value, context) => {
    if (value.outcome === 'succeeded' && value.providerEntityId === null) {
      context.addIssue({ code: 'custom', path: ['providerEntityId'], message: 'a successful create must identify the provider resource' });
    }
    if (value.outcome === 'authoritative_rejected' && value.providerEntityId !== null) {
      context.addIssue({ code: 'custom', path: ['providerEntityId'], message: 'an authoritatively rejected create cannot claim a provider resource' });
    }
    if (value.outcome === 'authoritative_rejected' && value.providerCode === null) {
      context.addIssue({ code: 'custom', path: ['providerCode'], message: 'an authoritative rejection requires the exact provider classification' });
    }
    if (value.outcome === 'ambiguous' && value.providerEntityId !== null) {
      context.addIssue({ code: 'custom', path: ['providerEntityId'], message: 'an ambiguous create cannot claim a correlated provider identity' });
    }
    if (value.outcome !== 'ambiguous' && value.responseDigest === null) {
      context.addIssue({ code: 'custom', path: ['responseDigest'], message: 'a conclusive create outcome requires sanitized response evidence' });
    }
    if (instantMillis(value.completedAt) < instantMillis(value.startedAt)) {
      context.addIssue({ code: 'custom', path: ['completedAt'], message: 'provider result cannot complete before it starts' });
    }
  }),
]);
export type CampaignCreationProviderResult = z.infer<typeof CampaignCreationProviderResult>;

export const CampaignCreationAmazonModerationStatus = z.enum([
  'not_applicable',
  'pending',
  'approved',
  'rejected',
]);
export type CampaignCreationAmazonModerationStatus = z.infer<
  typeof CampaignCreationAmazonModerationStatus
>;

export const CampaignCreationDeliveryStatus = z.enum([
  'unknown',
  'not_delivering',
  'delivering',
]);
export type CampaignCreationDeliveryStatus = z.infer<typeof CampaignCreationDeliveryStatus>;

export const CampaignCreationObservationBasis = z.enum([
  'provider_result_identity',
  'intent_reconciliation',
]);
export type CampaignCreationObservationBasis = z.infer<
  typeof CampaignCreationObservationBasis
>;

export const CampaignCreationResourceObservation = z.object({
  planId: CampaignCreationUuid,
  nodeId: CampaignCreationUuid,
  executionId: CampaignCreationUuid,
  authorizationId: CampaignCreationUuid,
  generation: CampaignCreationUuid,
  attemptId: CampaignCreationUuid,
  providerCallId: CampaignCreationUuid,
  nodeFingerprint: CampaignCreationSha256,
  requestDigest: CampaignCreationSha256,
  nodeRequestDigest: CampaignCreationSha256,
  basis: CampaignCreationObservationBasis,
  providerEntityId: AmazonId.nullable(),
  observation: z.enum(['pending', 'observed', 'not_found', 'conflict']),
  amazonModerationStatus: CampaignCreationAmazonModerationStatus,
  deliveryStatus: CampaignCreationDeliveryStatus,
  observedAt: z.iso.datetime(),
  sourceSyncJobId: CampaignCreationUuid,
}).strict().superRefine((value, context) => {
  if (value.observation === 'observed' && value.providerEntityId === null) {
    context.addIssue({ code: 'custom', path: ['providerEntityId'], message: 'an observed resource needs an Amazon identity' });
  }
  if (value.observation !== 'observed' && value.deliveryStatus === 'delivering') {
    context.addIssue({ code: 'custom', path: ['deliveryStatus'], message: 'an unobserved resource cannot be reported as delivering' });
  }
  if (value.amazonModerationStatus === 'rejected' && value.deliveryStatus === 'delivering') {
    context.addIssue({ code: 'custom', path: ['deliveryStatus'], message: 'a moderation-rejected resource cannot be reported as delivering' });
  }
  if (value.basis === 'intent_reconciliation' && (value.observation === 'observed'
    || value.providerEntityId !== null)) {
    context.addIssue({ code: 'custom', path: ['basis'], message: 'intent-only reconciliation cannot claim an exactly correlated provider identity' });
  }
});
export type CampaignCreationResourceObservation = z.infer<
  typeof CampaignCreationResourceObservation
>;

export const CampaignCreationExecutionStatus = z.enum([
  'queued',
  'running',
  'awaiting_observation',
  'succeeded',
  'failed',
  'partial_failed',
  'ambiguous',
  'refused',
  'blocked',
]);
export type CampaignCreationExecutionStatus = z.infer<typeof CampaignCreationExecutionStatus>;

export const CampaignCreationAccounting = z.object({
  operatorApproved: count,
  pendingDispatch: count,
  attempted: count,
  succeeded: count,
  failed: count,
  ambiguous: count,
  refusedAtExecution: count,
  blockedByDependency: count,
  observed: count,
  pendingObservation: count,
  observationNotFound: count,
  observationConflict: count,
  readChecksRequested: count,
  readChecksPending: count,
  readChecksPassed: count,
  readChecksRefused: count,
  readChecksFailed: count,
}).strict().superRefine((value, context) => {
  if (value.operatorApproved !== value.pendingDispatch + value.attempted
    + value.refusedAtExecution + value.blockedByDependency) {
    context.addIssue({ code: 'custom', message: 'operator-approved creates must reconcile to dispatch, attempt, refusal, or dependency block' });
  }
  if (value.attempted !== value.succeeded + value.failed + value.ambiguous) {
    context.addIssue({ code: 'custom', message: 'attempted creates must reconcile to provider outcomes' });
  }
  if (value.succeeded + value.ambiguous !== value.observed
    + value.pendingObservation + value.observationNotFound + value.observationConflict) {
    context.addIssue({ code: 'custom', message: 'observable provider outcomes must reconcile to observation state' });
  }
  if (value.readChecksRequested !== value.readChecksPending + value.readChecksPassed
    + value.readChecksRefused + value.readChecksFailed) {
    context.addIssue({ code: 'custom', message: 'read checks must reconcile to pending or terminal outcomes' });
  }
});
export type CampaignCreationAccounting = z.infer<typeof CampaignCreationAccounting>;

/**
 * Deterministic status projection for a closed accounting snapshot. Conflict
 * is the highest-severity terminal state; in-flight work always remains
 * nonterminal. Throws when the counters describe no coherent lifecycle state.
 */
export function deriveCampaignCreationExecutionStatus(
  rawAccounting: CampaignCreationAccounting,
): CampaignCreationExecutionStatus {
  const counts = CampaignCreationAccounting.parse(rawAccounting);
  const unresolvedObservation = counts.pendingObservation + counts.observationNotFound;
  const pendingWork = counts.pendingDispatch + counts.readChecksPending;
  const created = counts.succeeded + counts.ambiguous;
  const unsuccessful = counts.failed + counts.refusedAtExecution
    + counts.blockedByDependency + counts.readChecksRefused + counts.readChecksFailed;
  const terminal = pendingWork === 0 && unresolvedObservation === 0;

  const queued = counts.pendingDispatch === counts.operatorApproved
    && counts.attempted === 0
    && counts.refusedAtExecution === 0
    && counts.blockedByDependency === 0
    && counts.observed === 0
    && counts.observationConflict === 0
    && counts.readChecksPending === counts.readChecksRequested
    && counts.readChecksPassed === 0
    && counts.readChecksRefused === 0
    && counts.readChecksFailed === 0;
  if (queued) return 'queued';
  if (pendingWork > 0) return 'running';
  if (unresolvedObservation > 0) return 'awaiting_observation';
  if (terminal && counts.observationConflict > 0) return 'ambiguous';
  if (terminal && created > 0 && unsuccessful > 0) return 'partial_failed';
  if (terminal && created === 0 && counts.failed > 0) return 'failed';
  if (terminal && counts.attempted === 0
    && counts.refusedAtExecution > 0) return 'refused';
  if (terminal && counts.attempted === 0
    && counts.blockedByDependency > 0) return 'blocked';
  if (terminal && unsuccessful === 0
    && counts.observed === created) return 'succeeded';
  throw new Error('campaign creation accounting has no coherent execution status');
}

export const CampaignCreationExecutionSnapshot = z.object({
  status: CampaignCreationExecutionStatus,
  accounting: CampaignCreationAccounting,
}).strict().superRefine((snapshot, context) => {
  try {
    const expected = deriveCampaignCreationExecutionStatus(snapshot.accounting);
    if (snapshot.status !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: `execution status must be derived as ${expected}`,
      });
    }
  } catch (error) {
    context.addIssue({
      code: 'custom',
      path: ['status'],
      message: error instanceof Error ? error.message : 'invalid campaign creation status',
    });
  }
});
export type CampaignCreationExecutionSnapshot = z.infer<
  typeof CampaignCreationExecutionSnapshot
>;

export const CampaignCreationNonProviderDisposition = z.object({
  planId: CampaignCreationUuid,
  nodeId: CampaignCreationUuid,
  executionId: CampaignCreationUuid,
  nodeFingerprint: CampaignCreationSha256,
  outcome: z.enum(['pending_dispatch', 'refused_at_execution', 'blocked_by_dependency']),
  sanitizedReason: z.string().min(1).max(512).nullable(),
}).strict().superRefine((disposition, context) => {
  if (disposition.outcome !== 'pending_dispatch' && disposition.sanitizedReason === null) {
    context.addIssue({ code: 'custom', path: ['sanitizedReason'], message: 'terminal non-provider dispositions require a sanitized reason' });
  }
});
export type CampaignCreationNonProviderDisposition = z.infer<
  typeof CampaignCreationNonProviderDisposition
>;

/**
 * Complete current execution view. Irreversible call intents are append-only
 * and one-shot per create node. The bundle carries their conclusive results,
 * or preserves an open intent as ambiguity, plus one current observation per
 * observable or unresolved create and one disposition per undispatched node.
 */
export const CampaignCreationExecutionEvidence = z.object({
  plan: CampaignCreationPlan,
  executionId: CampaignCreationUuid,
  providerCallIntents: z.array(CampaignCreationProviderCallIntent),
  providerResults: z.array(CampaignCreationProviderResult),
  nonProviderDispositions: z.array(CampaignCreationNonProviderDisposition),
  observations: z.array(CampaignCreationResourceObservation),
  snapshot: CampaignCreationExecutionSnapshot,
}).strict().superRefine((evidence, context) => {
  const nodesById = new Map(evidence.plan.nodes.map((node) => [node.nodeId, node]));
  const planPosition = new Map(evidence.plan.nodes.map((node, index) => [node.nodeId, index]));
  const providerCallIntentsById = new Map<string, CampaignCreationProviderCallIntent>();
  const intentPositionByNode = new Map<string, {
    intent: CampaignCreationProviderCallIntent;
    position: CampaignCreationProviderCallPosition;
  }>();
  const intentAttemptIds = new Set<string>();
  const intentAuthorizationIds = new Set<string>();
  const intentGenerations = new Set<string>();
  let previousIntentNodePosition = -1;
  for (const [intentIndex, intent] of evidence.providerCallIntents.entries()) {
    intentAuthorizationIds.add(intent.authorizationId);
    intentGenerations.add(intent.generation);
    if (intent.planId !== evidence.plan.id
      || intent.planFingerprint !== evidence.plan.fingerprint
      || intent.executionId !== evidence.executionId) {
      context.addIssue({ code: 'custom', path: ['providerCallIntents', intentIndex], message: 'provider call intent does not match the exact frozen plan and execution' });
    }
    if (instantMillis(intent.recordedAt) < instantMillis(evidence.plan.frozenAt)
      || instantMillis(intent.recordedAt) >= instantMillis(evidence.plan.expiresAt)) {
      context.addIssue({ code: 'custom', path: ['providerCallIntents', intentIndex, 'recordedAt'], message: 'provider call intent must be recorded while the frozen plan is valid' });
    }
    if (providerCallIntentsById.has(intent.providerCallId)) {
      context.addIssue({ code: 'custom', path: ['providerCallIntents', intentIndex, 'providerCallId'], message: 'provider call IDs must be unique' });
    } else {
      providerCallIntentsById.set(intent.providerCallId, intent);
    }
    if (intentAttemptIds.has(intent.attemptId)) {
      context.addIssue({ code: 'custom', path: ['providerCallIntents', intentIndex, 'attemptId'], message: 'irreversible provider attempt IDs must be unique' });
    }
    intentAttemptIds.add(intent.attemptId);
    const intentNodeKinds = new Set<string>();
    for (const [positionIndex, position] of intent.positions.entries()) {
      const node = nodesById.get(position.nodeId);
      if (node !== undefined) intentNodeKinds.add(node.kind);
      if (node === undefined || node.effect !== 'irreversible_create'
        || node.fingerprint !== position.nodeFingerprint) {
        context.addIssue({ code: 'custom', path: ['providerCallIntents', intentIndex, 'positions', positionIndex], message: 'provider call position does not match an exact irreversible-create node' });
      }
      const currentPosition = planPosition.get(position.nodeId);
      if (currentPosition !== undefined && currentPosition <= previousIntentNodePosition) {
        context.addIssue({ code: 'custom', path: ['providerCallIntents', intentIndex, 'positions', positionIndex], message: 'provider call intents must follow canonical plan-node order' });
      }
      if (currentPosition !== undefined) previousIntentNodePosition = currentPosition;
      if (intentPositionByNode.has(position.nodeId)) {
        context.addIssue({ code: 'custom', path: ['providerCallIntents', intentIndex, 'positions', positionIndex, 'nodeId'], message: 'an irreversible create node may have only one provider call intent' });
      } else {
        intentPositionByNode.set(position.nodeId, { intent, position });
      }
    }
    if (intentNodeKinds.size > 1) {
      context.addIssue({ code: 'custom', path: ['providerCallIntents', intentIndex, 'positions'], message: 'one provider call intent must contain one resource operation kind' });
    }
  }
  if (intentAuthorizationIds.size > 1 || intentGenerations.size > 1) {
    context.addIssue({ code: 'custom', path: ['providerCallIntents'], message: 'one execution cannot mix authorization receipts or claim generations' });
  }

  const resultsByNode = new Map<string, CampaignCreationProviderResult>();
  const providerPositions = new Set<string>();
  const readProviderCallIndexes = new Map<string, Array<number | null>>();
  const providerEntityOwners = new Map<string, string>();
  let previousResultPosition = -1;

  for (const [index, result] of evidence.providerResults.entries()) {
    const node = nodesById.get(result.nodeId);
    if (result.planId !== evidence.plan.id || result.executionId !== evidence.executionId
      || node === undefined || node.fingerprint !== result.nodeFingerprint
      || node.effect !== result.effect) {
      context.addIssue({ code: 'custom', path: ['providerResults', index], message: 'provider result does not match its exact plan node and execution' });
    }
    const currentPosition = planPosition.get(result.nodeId);
    if (currentPosition !== undefined && currentPosition <= previousResultPosition) {
      context.addIssue({ code: 'custom', path: ['providerResults', index], message: 'provider results must follow canonical plan-node order' });
    }
    if (currentPosition !== undefined) previousResultPosition = currentPosition;
    if (instantMillis(result.startedAt) < instantMillis(evidence.plan.frozenAt)) {
      context.addIssue({ code: 'custom', path: ['providerResults', index, 'startedAt'], message: 'provider work cannot begin before the plan is frozen' });
    }
    if (instantMillis(result.startedAt) >= instantMillis(evidence.plan.expiresAt)) {
      context.addIssue({ code: 'custom', path: ['providerResults', index, 'startedAt'], message: 'provider work cannot begin at or after the plan expires' });
    }
    if (result.effect === 'irreversible_create') {
      const intended = intentPositionByNode.get(result.nodeId);
      if (intended === undefined
        || intended.intent.providerCallId !== result.providerCallId
        || intended.intent.attemptId !== result.attemptId
        || intended.position.requestIndex !== result.requestIndex
        || intended.position.nodeFingerprint !== result.nodeFingerprint
        || intended.intent.requestDigest !== result.requestDigest
        || intended.position.requestDigest !== result.nodeRequestDigest) {
        context.addIssue({ code: 'custom', path: ['providerResults', index], message: 'irreversible create result lacks its exact write-ahead provider call intent' });
      } else if (instantMillis(result.startedAt) < instantMillis(intended.intent.recordedAt)) {
        context.addIssue({ code: 'custom', path: ['providerResults', index, 'startedAt'], message: 'provider create cannot begin before its call intent is recorded' });
      }
    } else if (providerCallIntentsById.has(result.providerCallId)) {
      context.addIssue({ code: 'custom', path: ['providerResults', index, 'providerCallId'], message: 'read checks cannot reuse an irreversible provider call ID' });
    }
    if (node?.effect === 'read_check' && result.effect === 'read_check'
      && result.outcome === 'passed'
      && result.providerEntityId !== expectedRequirementProviderEntityId(node)) {
      context.addIssue({ code: 'custom', path: ['providerResults', index, 'providerEntityId'], message: 'passed preflight identity differs from the exact planned provider resource' });
    }
    if (node?.effect === 'read_check' && result.effect === 'read_check'
      && result.outcome === 'passed'
      && result.providerEntityVersion !== (node.kind === 'asset.require_existing'
        ? node.payload.version
        : null)) {
      context.addIssue({ code: 'custom', path: ['providerResults', index, 'providerEntityVersion'], message: 'passed preflight version differs from the exact planned Asset version' });
    }
    if (resultsByNode.has(result.nodeId)) {
      context.addIssue({ code: 'custom', path: ['providerResults', index, 'nodeId'], message: 'execution evidence must contain one current provider result per node' });
    } else {
      resultsByNode.set(result.nodeId, result);
    }
    const providerPosition = `${result.providerCallId}:${result.requestIndex ?? 'single'}`;
    if (providerPositions.has(providerPosition)) {
      context.addIssue({ code: 'custom', path: ['providerResults', index], message: 'provider call positions must be unique' });
    }
    providerPositions.add(providerPosition);
    if (result.effect === 'read_check') {
      readProviderCallIndexes.set(result.providerCallId, [
        ...(readProviderCallIndexes.get(result.providerCallId) ?? []),
        result.requestIndex,
      ]);
    }
    if (node?.effect === 'irreversible_create' && result.effect === 'irreversible_create'
      && result.providerEntityId !== null) {
      const identity = `${producedResourceKind(node)}:${result.providerEntityId}`;
      const owner = providerEntityOwners.get(identity);
      if (owner !== undefined && owner !== result.nodeId) {
        context.addIssue({ code: 'custom', path: ['providerResults', index, 'providerEntityId'], message: `provider resource identity is already claimed by node ${owner}` });
      } else {
        providerEntityOwners.set(identity, result.nodeId);
      }
    }
  }

  for (const [providerCallId, indexes] of readProviderCallIndexes) {
    const sortedIndexes = indexes.filter((value): value is number => value !== null)
      .sort((left, right) => left - right);
    const canonicalIndexes = sortedIndexes.map((_, index) => index);
    if ((indexes.includes(null) && indexes.length !== 1)
      || (!indexes.includes(null)
        && JSON.stringify(sortedIndexes) !== JSON.stringify(canonicalIndexes))) {
      context.addIssue({ code: 'custom', path: ['providerResults'], message: `provider call ${providerCallId} result positions must be a complete zero-based sequence` });
    }
  }

  const dispositionsByNode = new Map<string, CampaignCreationNonProviderDisposition>();
  let previousDispositionPosition = -1;
  for (const [index, disposition] of evidence.nonProviderDispositions.entries()) {
    const node = nodesById.get(disposition.nodeId);
    if (disposition.planId !== evidence.plan.id
      || disposition.executionId !== evidence.executionId
      || node === undefined || node.effect !== 'irreversible_create'
      || node.fingerprint !== disposition.nodeFingerprint) {
      context.addIssue({ code: 'custom', path: ['nonProviderDispositions', index], message: 'disposition does not match an exact create node and execution' });
    }
    const currentPosition = planPosition.get(disposition.nodeId);
    if (currentPosition !== undefined && currentPosition <= previousDispositionPosition) {
      context.addIssue({ code: 'custom', path: ['nonProviderDispositions', index], message: 'dispositions must follow canonical plan-node order' });
    }
    if (currentPosition !== undefined) previousDispositionPosition = currentPosition;
    if (dispositionsByNode.has(disposition.nodeId) || resultsByNode.has(disposition.nodeId)
      || intentPositionByNode.has(disposition.nodeId)) {
      context.addIssue({ code: 'custom', path: ['nonProviderDispositions', index, 'nodeId'], message: 'create node is accounted more than once' });
    } else {
      dispositionsByNode.set(disposition.nodeId, disposition);
    }
  }

  const observationsByNode = new Map<string, CampaignCreationResourceObservation>();
  let previousObservationPosition = -1;
  for (const [index, observation] of evidence.observations.entries()) {
    const result = resultsByNode.get(observation.nodeId);
    const intended = intentPositionByNode.get(observation.nodeId);
    const node = nodesById.get(observation.nodeId);
    const observableResult = result?.effect === 'irreversible_create'
      && (result.outcome === 'succeeded' || result.outcome === 'ambiguous');
    const openIntent = result === undefined && intended !== undefined;
    const expectedFingerprint = result?.nodeFingerprint ?? intended?.position.nodeFingerprint;
    const exactIntentBinding = intended !== undefined
      && observation.authorizationId === intended.intent.authorizationId
      && observation.generation === intended.intent.generation
      && observation.attemptId === intended.intent.attemptId
      && observation.providerCallId === intended.intent.providerCallId
      && observation.requestDigest === intended.intent.requestDigest
      && observation.nodeRequestDigest === intended.position.requestDigest;
    const expectedBasis = result?.effect === 'irreversible_create'
      && result.outcome === 'succeeded'
      ? 'provider_result_identity'
      : 'intent_reconciliation';
    const exactObservedIdentity = observation.observation !== 'observed'
      || (result?.effect === 'irreversible_create'
        && result.outcome === 'succeeded'
        && observation.providerEntityId === result.providerEntityId);
    if (observation.planId !== evidence.plan.id
      || observation.executionId !== evidence.executionId
      || (!observableResult && !openIntent)
      || observation.nodeFingerprint !== expectedFingerprint
      || !exactIntentBinding
      || observation.basis !== expectedBasis
      || !exactObservedIdentity) {
      context.addIssue({ code: 'custom', path: ['observations', index], message: 'observation does not match an observable create result or unresolved call intent' });
    }
    const currentPosition = planPosition.get(observation.nodeId);
    if (currentPosition !== undefined && currentPosition <= previousObservationPosition) {
      context.addIssue({ code: 'custom', path: ['observations', index], message: 'observations must follow canonical plan-node order' });
    }
    if (currentPosition !== undefined) previousObservationPosition = currentPosition;
    if (result !== undefined
      && instantMillis(observation.observedAt) < instantMillis(result.completedAt)) {
      context.addIssue({ code: 'custom', path: ['observations', index, 'observedAt'], message: 'resource observation cannot predate its provider result' });
    }
    if (result === undefined && intended !== undefined
      && instantMillis(observation.observedAt) < instantMillis(intended.intent.recordedAt)) {
      context.addIssue({ code: 'custom', path: ['observations', index, 'observedAt'], message: 'resource observation cannot predate its provider call intent' });
    }
    if (observationsByNode.has(observation.nodeId)) {
      context.addIssue({ code: 'custom', path: ['observations', index, 'nodeId'], message: 'execution evidence must contain one current observation per node' });
    } else {
      observationsByNode.set(observation.nodeId, observation);
    }
    if (node?.effect === 'irreversible_create' && observation.providerEntityId !== null) {
      const identity = `${producedResourceKind(node)}:${observation.providerEntityId}`;
      const owner = providerEntityOwners.get(identity);
      if (owner !== undefined && owner !== observation.nodeId) {
        context.addIssue({ code: 'custom', path: ['observations', index, 'providerEntityId'], message: `provider resource identity is already claimed by node ${owner}` });
      } else {
        providerEntityOwners.set(identity, observation.nodeId);
      }
    }
  }

  const dependencyState = (dependencyId: string): {
    state: 'satisfied' | 'pending' | 'terminal_unsatisfied';
    completedAt?: string;
  } => {
    const result = resultsByNode.get(dependencyId);
    if (result?.effect === 'read_check') {
      return result.outcome === 'passed'
        ? { state: 'satisfied', completedAt: result.completedAt }
        : { state: 'terminal_unsatisfied' };
    }
    if (result?.effect === 'irreversible_create') {
      if (result.outcome === 'succeeded') {
        return { state: 'satisfied', completedAt: result.completedAt };
      }
      if (result.outcome === 'authoritative_rejected') return { state: 'terminal_unsatisfied' };
      const observation = observationsByNode.get(dependencyId);
      if (observation?.observation === 'conflict') {
        return { state: 'terminal_unsatisfied' };
      }
      return { state: 'pending' };
    }
    if (intentPositionByNode.has(dependencyId)) {
      const observation = observationsByNode.get(dependencyId);
      if (observation?.observation === 'conflict') {
        return { state: 'terminal_unsatisfied' };
      }
      return { state: 'pending' };
    }
    const disposition = dispositionsByNode.get(dependencyId);
    if (disposition?.outcome === 'pending_dispatch') return { state: 'pending' };
    if (disposition !== undefined) return { state: 'terminal_unsatisfied' };
    return { state: 'pending' };
  };

  for (const node of evidence.plan.nodes) {
    if (node.effect !== 'irreversible_create') continue;
    const dependencies = node.dependsOn.map(dependencyState);
    const result = resultsByNode.get(node.nodeId);
    const disposition = dispositionsByNode.get(node.nodeId);
    const intended = intentPositionByNode.get(node.nodeId);
    if (intended !== undefined) {
      if (dependencies.some((dependency) => dependency.state !== 'satisfied')) {
        context.addIssue({ code: 'custom', path: ['providerCallIntents'], message: `create node ${node.nodeId} was authorized for dispatch before all dependencies succeeded` });
      }
      if (node.dependsOn.some((dependencyId) => (
        intentPositionByNode.get(dependencyId)?.intent.providerCallId
          === intended.intent.providerCallId
      ))) {
        context.addIssue({ code: 'custom', path: ['providerCallIntents'], message: `create node ${node.nodeId} shares a provider call intent with its dependency` });
      }
      if (dependencies.some((dependency) => dependency.completedAt !== undefined
        && instantMillis(intended.intent.recordedAt) < instantMillis(dependency.completedAt))) {
        context.addIssue({ code: 'custom', path: ['providerCallIntents'], message: `create node ${node.nodeId} call intent predates a dependency completion` });
      }
    }
    if (result?.effect === 'irreversible_create') {
      if (dependencies.some((dependency) => dependency.state !== 'satisfied')) {
        context.addIssue({ code: 'custom', path: ['providerResults'], message: `create node ${node.nodeId} ran before all dependencies succeeded` });
      }
      if (node.dependsOn.some((dependencyId) => (
        resultsByNode.get(dependencyId)?.providerCallId === result.providerCallId
      ))) {
        context.addIssue({ code: 'custom', path: ['providerResults'], message: `create node ${node.nodeId} shares a provider call with its dependency` });
      }
      if (dependencies.some((dependency) => dependency.completedAt !== undefined
        && instantMillis(result.startedAt) < instantMillis(dependency.completedAt))) {
        context.addIssue({ code: 'custom', path: ['providerResults'], message: `create node ${node.nodeId} started before a dependency completed` });
      }
    }
    const hasTerminalDependency = dependencies.some(
      (dependency) => dependency.state === 'terminal_unsatisfied',
    );
    if (disposition?.outcome === 'blocked_by_dependency' && !hasTerminalDependency) {
      context.addIssue({ code: 'custom', path: ['nonProviderDispositions'], message: `create node ${node.nodeId} claims a dependency block without a terminal failed dependency` });
    }
    if ((disposition?.outcome === 'pending_dispatch'
      || disposition?.outcome === 'refused_at_execution') && hasTerminalDependency) {
      context.addIssue({ code: 'custom', path: ['nonProviderDispositions'], message: `create node ${node.nodeId} must be blocked by its terminal failed dependency` });
    }
  }

  for (const node of evidence.plan.nodes) {
    const result = resultsByNode.get(node.nodeId);
    const disposition = dispositionsByNode.get(node.nodeId);
    const intended = intentPositionByNode.get(node.nodeId);
    if (node.effect === 'irreversible_create' && result === undefined
      && disposition === undefined && intended === undefined) {
      context.addIssue({ code: 'custom', path: ['snapshot', 'accounting'], message: `create node ${node.nodeId} is absent from execution accounting` });
    }
    if (node.effect === 'read_check' && disposition !== undefined) {
      context.addIssue({ code: 'custom', path: ['nonProviderDispositions'], message: 'read checks cannot carry create dispositions' });
    }
  }

  const createResults = evidence.providerResults.filter(
    (result): result is Extract<CampaignCreationProviderResult, { effect: 'irreversible_create' }> => (
      result.effect === 'irreversible_create'
    ),
  );
  const readResults = evidence.providerResults.filter(
    (result): result is Extract<CampaignCreationProviderResult, { effect: 'read_check' }> => (
      result.effect === 'read_check'
    ),
  );
  const attemptedCreateNodes = intentPositionByNode.size;
  const unresolvedCallIntents = [...intentPositionByNode.keys()].filter(
    (nodeId) => !resultsByNode.has(nodeId),
  ).length;
  const missingCurrentObservations = evidence.plan.nodes.filter((node) => {
    const result = resultsByNode.get(node.nodeId);
    const observableResult = result?.effect === 'irreversible_create'
      && (result.outcome === 'succeeded' || result.outcome === 'ambiguous');
    const openIntent = node.effect === 'irreversible_create'
      && intentPositionByNode.has(node.nodeId) && result === undefined;
    return (observableResult || openIntent) && !observationsByNode.has(node.nodeId);
  }).length;
  const actualAccounting: CampaignCreationAccounting = {
    operatorApproved: evidence.plan.counts.irreversibleCreates,
    pendingDispatch: evidence.nonProviderDispositions.filter((item) => item.outcome === 'pending_dispatch').length,
    attempted: attemptedCreateNodes,
    succeeded: createResults.filter((result) => result.outcome === 'succeeded').length,
    failed: createResults.filter((result) => result.outcome === 'authoritative_rejected').length,
    ambiguous: createResults.filter((result) => result.outcome === 'ambiguous').length
      + unresolvedCallIntents,
    refusedAtExecution: evidence.nonProviderDispositions.filter((item) => item.outcome === 'refused_at_execution').length,
    blockedByDependency: evidence.nonProviderDispositions.filter((item) => item.outcome === 'blocked_by_dependency').length,
    observed: evidence.observations.filter((item) => item.observation === 'observed').length,
    pendingObservation: evidence.observations.filter((item) => item.observation === 'pending').length
      + missingCurrentObservations,
    observationNotFound: evidence.observations.filter((item) => item.observation === 'not_found').length,
    observationConflict: evidence.observations.filter((item) => item.observation === 'conflict').length,
    readChecksRequested: evidence.plan.counts.readChecks,
    readChecksPending: evidence.plan.counts.readChecks - readResults.length,
    readChecksPassed: readResults.filter((result) => result.outcome === 'passed').length,
    readChecksRefused: readResults.filter((result) => result.outcome === 'refused').length,
    readChecksFailed: readResults.filter((result) => result.outcome === 'failed').length,
  };
  if (JSON.stringify(actualAccounting) !== JSON.stringify(evidence.snapshot.accounting)) {
    context.addIssue({ code: 'custom', path: ['snapshot', 'accounting'], message: 'execution accounting differs from exact node evidence' });
  }
});
export type CampaignCreationExecutionEvidence = z.infer<
  typeof CampaignCreationExecutionEvidence
>;

/**
 * Future queue payloads. Deliberately not registered in JobPayload until the
 * worker executor and database enum land together, so current workers cannot
 * claim an unsupported creation job.
 */
export const CampaignCreationDispatchJob = z.object({
  type: z.literal('campaign_creation.dispatch'),
  orgId: CampaignCreationUuid,
  profileId: CampaignCreationUuid,
  planId: CampaignCreationUuid,
  planFingerprint: CampaignCreationSha256,
  executionId: CampaignCreationUuid,
  authorizationId: CampaignCreationUuid,
  generation: CampaignCreationUuid,
}).strict();

export const CampaignCreationObserveJob = z.object({
  type: z.literal('campaign_creation.observe'),
  orgId: CampaignCreationUuid,
  profileId: CampaignCreationUuid,
  planId: CampaignCreationUuid,
  planFingerprint: CampaignCreationSha256,
  executionId: CampaignCreationUuid,
  authorizationId: CampaignCreationUuid,
  generation: CampaignCreationUuid,
  attempt: z.number().int().nonnegative().max(7).default(0),
}).strict();

export const CampaignCreationJobPayload = z.discriminatedUnion('type', [
  CampaignCreationDispatchJob,
  CampaignCreationObserveJob,
]);
export type CampaignCreationJobPayload = z.infer<typeof CampaignCreationJobPayload>;
export type CampaignCreationDispatchJob = z.infer<typeof CampaignCreationDispatchJob>;
export type CampaignCreationObserveJob = z.infer<typeof CampaignCreationObserveJob>;

export type VerifiedCampaignCreationJobArtifacts = {
  plan: CampaignCreationPlan;
  authorization: CampaignCreationAuthorizationReceipt;
  job: CampaignCreationJobPayload;
};

/**
 * Reload and join every persisted authority artifact at a queue claim. Shape
 * validation alone is insufficient because each artifact can be valid while
 * referring to a different plan, tenant, execution, receipt, or generation.
 */
export function verifyCampaignCreationJobArtifacts(
  rawPlan: unknown,
  rawAuthorization: unknown,
  rawJob: unknown,
  rawNow: unknown,
  hashSha256: CampaignCreationSha256Hasher,
): VerifiedCampaignCreationJobArtifacts {
  const plan = verifyCampaignCreationPlanFingerprints(
    CampaignCreationPlan.parse(rawPlan),
    hashSha256,
  );
  const authorization = CampaignCreationAuthorizationReceipt.parse(rawAuthorization);
  const job = CampaignCreationJobPayload.parse(rawJob);
  const now = z.iso.datetime().parse(rawNow);

  const receiptMatchesPlan = authorization.schemaVersion === plan.schemaVersion
    && authorization.planId === plan.id
    && authorization.planFingerprint === plan.fingerprint
    && authorization.orgId === plan.orgId
    && authorization.profileId === plan.profileId
    && authorization.marketplaceId === plan.marketplaceId
    && authorization.adProduct === plan.adProduct
    && authorization.apiDialect === plan.apiDialect
    && authorization.expiresAt === plan.expiresAt
    && JSON.stringify(authorization.expectedCounts) === JSON.stringify(plan.counts)
    && JSON.stringify(authorization.noRollbackAcknowledgement)
      === JSON.stringify(plan.noRollbackAcknowledgement);
  if (!receiptMatchesPlan) {
    throw new Error('campaign creation authorization receipt does not match the exact plan');
  }
  if (instantMillis(authorization.approvedAt) < instantMillis(plan.frozenAt)) {
    throw new Error('campaign creation authorization predates the frozen plan');
  }
  if (instantMillis(now) < instantMillis(authorization.approvedAt)) {
    throw new Error('campaign creation authority cannot be verified before approval');
  }

  const jobMatchesAuthority = job.orgId === plan.orgId
    && job.profileId === plan.profileId
    && job.planId === plan.id
    && job.planFingerprint === plan.fingerprint
    && job.executionId === authorization.executionId
    && job.authorizationId === authorization.authorizationId
    && job.generation === authorization.generation;
  if (!jobMatchesAuthority) {
    throw new Error('campaign creation job does not match its plan and authorization receipt');
  }
  if (job.type === 'campaign_creation.dispatch'
    && instantMillis(now) >= instantMillis(authorization.expiresAt)) {
    throw new Error('campaign creation dispatch authorization is expired');
  }
  return { plan, authorization, job };
}

function verifyCampaignCreationCurrentEvidence(
  rawCurrentEvidence: unknown,
  verified: VerifiedCampaignCreationJobArtifacts,
  now: string,
): CampaignCreationExecutionEvidence {
  const currentEvidence = CampaignCreationExecutionEvidence.parse(rawCurrentEvidence);
  if (currentEvidence.executionId !== verified.authorization.executionId
    || JSON.stringify(currentEvidence.plan) !== JSON.stringify(verified.plan)) {
    throw new Error('current execution evidence does not match the verified plan and execution');
  }
  if (currentEvidence.providerCallIntents.some((priorIntent) => (
    priorIntent.authorizationId !== verified.authorization.authorizationId
      || priorIntent.generation !== verified.authorization.generation
  )) || currentEvidence.observations.some((observation) => (
    observation.authorizationId !== verified.authorization.authorizationId
      || observation.generation !== verified.authorization.generation
  ))) {
    throw new Error('current execution evidence contains a different authorization or generation');
  }
  if (currentEvidence.providerCallIntents.some((priorIntent) => (
    instantMillis(priorIntent.recordedAt) < instantMillis(verified.authorization.approvedAt)
      || instantMillis(priorIntent.recordedAt) >= instantMillis(verified.authorization.expiresAt)
      || instantMillis(priorIntent.recordedAt) > instantMillis(now)
  ))) {
    throw new Error('current execution evidence contains an intent outside the authority window');
  }
  if (currentEvidence.providerResults.some((result) => (
    instantMillis(result.startedAt) < instantMillis(verified.authorization.approvedAt)
      || instantMillis(result.completedAt) > instantMillis(now)
  )) || currentEvidence.observations.some((observation) => (
    instantMillis(observation.observedAt) > instantMillis(now)
  ))) {
    throw new Error('current execution evidence contains work outside the verified execution time');
  }
  return currentEvidence;
}

export type VerifiedCampaignCreationProviderCallArtifacts =
  VerifiedCampaignCreationJobArtifacts & {
    job: CampaignCreationDispatchJob;
    currentEvidence: CampaignCreationExecutionEvidence;
    intent: CampaignCreationProviderCallIntent;
  };

/** Verify the exact write-ahead intent immediately before provider I/O. */
export function verifyCampaignCreationProviderCallArtifacts(
  rawPlan: unknown,
  rawAuthorization: unknown,
  rawJob: unknown,
  rawCurrentEvidence: unknown,
  rawIntent: unknown,
  rawNow: unknown,
  hashSha256: CampaignCreationSha256Hasher,
): VerifiedCampaignCreationProviderCallArtifacts {
  const verified = verifyCampaignCreationJobArtifacts(
    rawPlan,
    rawAuthorization,
    rawJob,
    rawNow,
    hashSha256,
  );
  if (verified.job.type !== 'campaign_creation.dispatch') {
    throw new Error('provider calls require a campaign creation dispatch job');
  }
  const now = z.iso.datetime().parse(rawNow);
  const currentEvidence = verifyCampaignCreationCurrentEvidence(
    rawCurrentEvidence,
    verified,
    now,
  );
  const intent = CampaignCreationProviderCallIntent.parse(rawIntent);
  const intentMatchesAuthority = intent.planId === verified.plan.id
    && intent.planFingerprint === verified.plan.fingerprint
    && intent.executionId === verified.authorization.executionId
    && intent.authorizationId === verified.authorization.authorizationId
    && intent.generation === verified.authorization.generation;
  if (!intentMatchesAuthority) {
    throw new Error('provider call intent does not match the verified dispatch authority');
  }
  if (instantMillis(intent.recordedAt) < instantMillis(verified.authorization.approvedAt)
    || instantMillis(intent.recordedAt) >= instantMillis(verified.authorization.expiresAt)
    || instantMillis(intent.recordedAt) > instantMillis(now)) {
    throw new Error('provider call intent was not recorded during the verified authority window');
  }
  const nodesById = new Map(verified.plan.nodes.map((node, index) => (
    [node.nodeId, { node, index }] as const
  )));
  const operationKinds = new Set<string>();
  const proposedNodeIds = new Set(intent.positions.map((position) => position.nodeId));
  const priorIntentNodeIds = new Set(currentEvidence.providerCallIntents.flatMap(
    (priorIntent) => priorIntent.positions.map((position) => position.nodeId),
  ));
  const resultsByNode = new Map(currentEvidence.providerResults.map((result) => (
    [result.nodeId, result] as const
  )));
  const dispositionsByNode = new Map(currentEvidence.nonProviderDispositions.map(
    (disposition) => [disposition.nodeId, disposition] as const,
  ));
  let previousPlanIndex = -1;
  for (const position of intent.positions) {
    const planned = nodesById.get(position.nodeId);
    if (planned === undefined || planned.node.effect !== 'irreversible_create'
      || planned.node.fingerprint !== position.nodeFingerprint) {
      throw new Error('provider call intent position does not match an exact create plan node');
    }
    if (planned.index <= previousPlanIndex) {
      throw new Error('provider call intent positions do not follow canonical plan order');
    }
    previousPlanIndex = planned.index;
    operationKinds.add(planned.node.kind);
    if (priorIntentNodeIds.has(position.nodeId) || resultsByNode.has(position.nodeId)
      || dispositionsByNode.get(position.nodeId)?.outcome !== 'pending_dispatch') {
      throw new Error('provider call intent position is not exclusively pending dispatch');
    }
    for (const dependencyId of planned.node.dependsOn) {
      if (proposedNodeIds.has(dependencyId)) {
        throw new Error('provider call intent cannot batch a node with its dependency');
      }
      const dependencyResult = resultsByNode.get(dependencyId);
      const passedRead = dependencyResult?.effect === 'read_check'
        && dependencyResult.outcome === 'passed';
      const confirmedCreate = dependencyResult?.effect === 'irreversible_create'
        && dependencyResult.outcome === 'succeeded';
      if (!passedRead && !confirmedCreate) {
        throw new Error('provider call intent has a dependency that is not satisfied');
      }
      const dependencyCompletedAt = dependencyResult.completedAt;
      if (dependencyCompletedAt === undefined
        || instantMillis(intent.recordedAt) < instantMillis(dependencyCompletedAt)) {
        throw new Error('provider call intent predates a dependency completion');
      }
    }
  }
  if (operationKinds.size !== 1) {
    throw new Error('provider call intent must contain exactly one resource operation kind');
  }
  return { ...verified, job: verified.job, currentEvidence, intent };
}

export type VerifiedCampaignCreationObservationArtifacts =
  VerifiedCampaignCreationJobArtifacts & {
    job: CampaignCreationObserveJob;
    currentEvidence: CampaignCreationExecutionEvidence;
    observation: CampaignCreationResourceObservation;
  };

/** Verify a current observation before it may replace the execution projection. */
export function verifyCampaignCreationObservationArtifacts(
  rawPlan: unknown,
  rawAuthorization: unknown,
  rawJob: unknown,
  rawCurrentEvidence: unknown,
  rawObservation: unknown,
  rawNow: unknown,
  hashSha256: CampaignCreationSha256Hasher,
): VerifiedCampaignCreationObservationArtifacts {
  const verified = verifyCampaignCreationJobArtifacts(
    rawPlan,
    rawAuthorization,
    rawJob,
    rawNow,
    hashSha256,
  );
  if (verified.job.type !== 'campaign_creation.observe') {
    throw new Error('resource observations require a campaign creation observe job');
  }
  const now = z.iso.datetime().parse(rawNow);
  const currentEvidence = verifyCampaignCreationCurrentEvidence(
    rawCurrentEvidence,
    verified,
    now,
  );
  const observation = CampaignCreationResourceObservation.parse(rawObservation);
  const intended = currentEvidence.providerCallIntents.flatMap((intent) => (
    intent.positions.map((position) => ({ intent, position }))
  )).find(({ position }) => position.nodeId === observation.nodeId);
  const result = currentEvidence.providerResults.find((candidate) => (
    candidate.nodeId === observation.nodeId
  ));
  const exactIntentBinding = intended !== undefined
    && observation.planId === verified.plan.id
    && observation.executionId === verified.authorization.executionId
    && observation.authorizationId === verified.authorization.authorizationId
    && observation.generation === verified.authorization.generation
    && observation.attemptId === intended.intent.attemptId
    && observation.providerCallId === intended.intent.providerCallId
    && observation.nodeFingerprint === intended.position.nodeFingerprint
    && observation.requestDigest === intended.intent.requestDigest
    && observation.nodeRequestDigest === intended.position.requestDigest;
  if (!exactIntentBinding || intended === undefined) {
    throw new Error('campaign creation observation does not match an exact authorized call intent');
  }
  const confirmedResult = result?.effect === 'irreversible_create'
    && result.outcome === 'succeeded';
  const unresolvedIntent = result === undefined
    || (result.effect === 'irreversible_create' && result.outcome === 'ambiguous');
  if ((observation.basis === 'provider_result_identity' && !confirmedResult)
    || (observation.basis === 'intent_reconciliation' && !unresolvedIntent)) {
    throw new Error('campaign creation observation basis does not match provider evidence');
  }
  if (observation.observation === 'observed'
    && (!confirmedResult || observation.providerEntityId !== result.providerEntityId)) {
    throw new Error('campaign creation observation identity is not exactly correlated');
  }
  const earliestObservation = confirmedResult ? result.completedAt : intended.intent.recordedAt;
  if (instantMillis(observation.observedAt) < instantMillis(earliestObservation)
    || instantMillis(observation.observedAt) > instantMillis(now)) {
    throw new Error('campaign creation observation falls outside its reconciliation window');
  }
  const priorObservation = currentEvidence.observations.find((candidate) => (
    candidate.nodeId === observation.nodeId
  ));
  if (priorObservation !== undefined
    && JSON.stringify(priorObservation) !== JSON.stringify(observation)
    && instantMillis(observation.observedAt) <= instantMillis(priorObservation.observedAt)) {
    throw new Error('campaign creation observation does not advance current evidence');
  }
  return { ...verified, job: verified.job, currentEvidence, observation };
}
