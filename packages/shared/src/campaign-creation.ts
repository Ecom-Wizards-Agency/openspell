import { z } from 'zod';
import {
  BiddingStrategy,
  BudgetType,
  TargetExpression,
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

export const ExistingCampaignCreationResourceRef = z.object({
  source: z.literal('existing'),
  kind: CampaignCreationResourceKind,
  amazonId: AmazonId,
}).strict();
export type ExistingCampaignCreationResourceRef = z.infer<
  typeof ExistingCampaignCreationResourceRef
>;

export const PlannedCampaignCreationResourceRef = z.object({
  source: z.literal('plan_node'),
  kind: CampaignCreationResourceKind,
  nodeId: CampaignCreationUuid,
}).strict();
export type PlannedCampaignCreationResourceRef = z.infer<
  typeof PlannedCampaignCreationResourceRef
>;

export const CampaignCreationResourceRef = z.discriminatedUnion('source', [
  ExistingCampaignCreationResourceRef,
  PlannedCampaignCreationResourceRef,
]);
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
  'brand_video',
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
    tactic: z.string().min(1).max(160),
  }).strict(),
]);

const CreateCampaignNode = z.object({
  ...createNodeBase,
  kind: z.literal('campaign.create'),
  payload: z.object({
    name: z.string().min(1).max(256),
    state: z.literal('paused'),
    budget: CampaignCreationBudget,
    startDate: IsoDate,
    endDate: IsoDate.nullable(),
    portfolioId: AmazonId.nullable(),
    settings: CampaignSettings,
  }).strict(),
}).strict();

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
const CampaignCreationExpression = TargetExpression.extend({
  type: z.enum([
    'asin_same_as',
    'asin_expanded_from',
    'asin_brand_same_as',
    'asin_category_same_as',
    'close_match',
    'loose_match',
    'substitutes',
    'complements',
  ]),
}).strict();

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
});

const CreateTargetNode = z.object({
  ...createNodeBase,
  kind: z.literal('target.create'),
  payload: z.discriminatedUnion('targetType', [KeywordTargetPayload, ExpressionTargetPayload]),
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

const AdPayload = z.discriminatedUnion('format', [
  z.object({
    format: z.literal('sp_product_ad'),
    adGroup: plannedResourceRef('ad_group'),
    product: plannedResourceRef('product'),
    state: z.literal('paused'),
  }).strict(),
  z.object({
    format: z.literal('sb_product_collection_manual'),
    adGroup: plannedResourceRef('ad_group'),
    brand: plannedResourceRef('brand'),
    products: z.array(plannedResourceRef('product')).min(3).max(10),
    logoAsset: plannedResourceRef('asset').nullable(),
    title: z.string().trim().min(1).max(128).nullable(),
    landingPage: SponsoredBrandsCollectionLandingPage,
    state: z.literal('paused'),
  }).strict(),
  z.object({
    format: z.literal('sb_product_collection_automatic'),
    adGroup: plannedResourceRef('ad_group'),
    brand: plannedResourceRef('brand'),
    logoAsset: plannedResourceRef('asset').nullable(),
    productExclusions: z.array(plannedResourceRef('product')).max(100),
    state: z.literal('paused'),
  }).strict(),
  z.object({
    format: z.literal('sb_store_spotlight'),
    adGroup: plannedResourceRef('ad_group'),
    brand: plannedResourceRef('brand'),
    landingPage: StoreLandingPage,
    logoAsset: plannedResourceRef('asset'),
    headline: z.string().trim().min(1).max(128),
    cards: z.tuple([StoreSpotlightCard, StoreSpotlightCard, StoreSpotlightCard]),
    state: z.literal('paused'),
  }).strict(),
  z.object({
    format: z.literal('sb_product_video'),
    adGroup: plannedResourceRef('ad_group'),
    product: plannedResourceRef('product'),
    videoAsset: plannedResourceRef('asset'),
    state: z.literal('paused'),
  }).strict(),
  z.object({
    format: z.literal('sb_brand_video'),
    adGroup: plannedResourceRef('ad_group'),
    brand: plannedResourceRef('brand'),
    store: plannedResourceRef('store'),
    logoAsset: plannedResourceRef('asset'),
    videoAsset: plannedResourceRef('asset'),
    headline: z.string().trim().min(1).max(128),
    state: z.literal('paused'),
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
        case 'sb_product_video':
        case 'sd_product_ad':
          return [payload.adGroup, payload.product, ...(
            payload.format === 'sb_product_video' ? [payload.videoAsset] : []
          )];
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
        case 'sb_brand_video':
          return [
            payload.adGroup,
            payload.brand,
            payload.store,
            payload.logoAsset,
            payload.videoAsset,
          ];
      }
    }
  }
}

function referenceKey(reference: CampaignCreationResourceRef): string {
  return reference.source === 'existing'
    ? `${reference.source}:${reference.kind}:${reference.amazonId}`
    : `${reference.source}:${reference.kind}:${reference.nodeId}`;
}

function referencedPlanNode(
  reference: CampaignCreationResourceRef,
  byId: ReadonlyMap<string, CampaignCreationNode>,
): CampaignCreationNode | undefined {
  return reference.source === 'plan_node' ? byId.get(reference.nodeId) : undefined;
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
      if (reference.source !== 'plan_node') continue;
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
      if (reference.source !== 'plan_node') {
        context.addIssue({
          code: 'custom',
          path: ['nodes', index],
          message: `${expectedKind} use must reference its explicit plan preflight`,
        });
        return undefined;
      }
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
        case 'sb_product_video':
          requireCheckedResource(payload.product, 'product');
          requireCheckedResource(payload.videoAsset, 'asset', 'video');
          break;
        case 'sb_brand_video':
          requireCampaignBrand(payload.brand);
          requireCheckedResource(payload.store, 'store');
          requireCheckedResource(payload.logoAsset, 'asset', 'logo');
          requireCheckedResource(payload.videoAsset, 'asset', 'video');
          break;
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
      if (parentCampaign?.kind === 'campaign.create'
        && parentCampaign.payload.settings.product === 'SB'
        && parentCampaign.payload.settings.format === 'product_collection_automatic'
        && node.payload.targetType !== 'keyword') {
        context.addIssue({ code: 'custom', path: ['nodes', index, 'payload'], message: 'automatic Sponsored Brands collections support keyword targeting only' });
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
    requestIndex: z.number().int().nonnegative().nullable(),
    outcome: z.enum(['succeeded', 'failed', 'ambiguous']),
    providerEntityId: AmazonId.nullable(),
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
    if (value.outcome === 'failed' && value.providerEntityId !== null) {
      context.addIssue({ code: 'custom', path: ['providerEntityId'], message: 'a failed create cannot claim a provider resource' });
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

export const CampaignCreationResourceObservation = z.object({
  planId: CampaignCreationUuid,
  nodeId: CampaignCreationUuid,
  executionId: CampaignCreationUuid,
  nodeFingerprint: CampaignCreationSha256,
  providerEntityId: AmazonId.nullable(),
  observation: z.enum(['pending', 'observed', 'not_found', 'conflict']),
  amazonModerationStatus: CampaignCreationAmazonModerationStatus,
  deliveryStatus: CampaignCreationDeliveryStatus,
  observedAt: z.iso.datetime(),
  sourceSyncJobId: CampaignCreationUuid.nullable(),
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
});
export type CampaignCreationResourceObservation = z.infer<
  typeof CampaignCreationResourceObservation
>;

export const CampaignCreationExecutionStatus = z.enum([
  'queued',
  'running',
  'awaiting_observation',
  'succeeded',
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

export const CampaignCreationExecutionSnapshot = z.object({
  status: CampaignCreationExecutionStatus,
  accounting: CampaignCreationAccounting,
}).strict().superRefine((snapshot, context) => {
  const counts = snapshot.accounting;
  const noDispatchPending = counts.pendingDispatch === 0;
  const noObservationPending = counts.pendingObservation === 0;
  const noReadPending = counts.readChecksPending === 0;
  if (snapshot.status === 'queued'
    && (counts.attempted !== 0 || counts.pendingDispatch !== counts.operatorApproved
      || counts.succeeded !== 0 || counts.failed !== 0 || counts.ambiguous !== 0
      || counts.refusedAtExecution !== 0 || counts.blockedByDependency !== 0
      || counts.observed !== 0 || counts.pendingObservation !== 0
      || counts.observationNotFound !== 0 || counts.observationConflict !== 0
      || counts.readChecksPending !== counts.readChecksRequested
      || counts.readChecksPassed !== 0
      || counts.readChecksRefused !== 0 || counts.readChecksFailed !== 0)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'queued execution must have every approved create pending dispatch' });
  }
  if (snapshot.status === 'awaiting_observation'
    && (!noDispatchPending || !noReadPending || counts.pendingObservation === 0)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'awaiting observation requires dispatched creates, completed preflights, and pending observation work' });
  }
  if (snapshot.status === 'succeeded'
    && (!noDispatchPending || !noObservationPending || !noReadPending
      || counts.failed !== 0 || counts.refusedAtExecution !== 0
      || counts.blockedByDependency !== 0 || counts.observationConflict !== 0
      || counts.observationNotFound !== 0
      || counts.readChecksRefused !== 0 || counts.readChecksFailed !== 0
      || counts.observed !== counts.succeeded + counts.ambiguous)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'successful execution cannot hide incomplete, refused, failed, blocked, or conflicting work' });
  }
  if (snapshot.status === 'partial_failed'
    && (!noDispatchPending || !noObservationPending || !noReadPending
      || counts.observationConflict !== 0
      || counts.failed + counts.refusedAtExecution + counts.blockedByDependency
        + counts.observationNotFound + counts.readChecksRefused + counts.readChecksFailed === 0)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'partial failure must be terminal and contain a refused, failed, or blocked outcome' });
  }
  if (snapshot.status === 'ambiguous'
    && (!noDispatchPending || !noObservationPending || !noReadPending
      || counts.observationConflict === 0)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'terminal ambiguity requires a completed conflicting observation' });
  }
  if (snapshot.status === 'refused'
    && (!noDispatchPending || !noObservationPending || !noReadPending
      || counts.refusedAtExecution !== counts.operatorApproved
      || counts.attempted !== 0 || counts.blockedByDependency !== 0)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'refused execution requires every approved create to be refused before dispatch' });
  }
  if (snapshot.status === 'blocked'
    && (!noDispatchPending || !noObservationPending || !noReadPending
      || counts.blockedByDependency === 0 || counts.attempted !== 0
      || counts.refusedAtExecution !== 0)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'blocked execution requires a terminal preflight or dependency block before any create attempt' });
  }
  if (snapshot.status === 'running'
    && (counts.pendingDispatch + counts.readChecksPending === 0
      || counts.pendingObservation !== 0)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'running execution requires dispatch or preflight work and cannot hide observation-only work' });
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
}).strict();
export type CampaignCreationNonProviderDisposition = z.infer<
  typeof CampaignCreationNonProviderDisposition
>;

/**
 * Complete current execution view. Raw call attempts remain append-only, while
 * this bundle carries one current provider result or non-provider disposition
 * per create node and one current observation per observable result.
 */
export const CampaignCreationExecutionEvidence = z.object({
  plan: CampaignCreationPlan,
  executionId: CampaignCreationUuid,
  providerResults: z.array(CampaignCreationProviderResult),
  nonProviderDispositions: z.array(CampaignCreationNonProviderDisposition),
  observations: z.array(CampaignCreationResourceObservation),
  snapshot: CampaignCreationExecutionSnapshot,
}).strict().superRefine((evidence, context) => {
  const nodesById = new Map(evidence.plan.nodes.map((node) => [node.nodeId, node]));
  const resultsByNode = new Map<string, CampaignCreationProviderResult>();
  const providerPositions = new Set<string>();

  for (const [index, result] of evidence.providerResults.entries()) {
    const node = nodesById.get(result.nodeId);
    if (result.planId !== evidence.plan.id || result.executionId !== evidence.executionId
      || node === undefined || node.fingerprint !== result.nodeFingerprint
      || node.effect !== result.effect) {
      context.addIssue({ code: 'custom', path: ['providerResults', index], message: 'provider result does not match its exact plan node and execution' });
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
  }

  const dispositionsByNode = new Map<string, CampaignCreationNonProviderDisposition>();
  for (const [index, disposition] of evidence.nonProviderDispositions.entries()) {
    const node = nodesById.get(disposition.nodeId);
    if (disposition.planId !== evidence.plan.id
      || disposition.executionId !== evidence.executionId
      || node === undefined || node.effect !== 'irreversible_create'
      || node.fingerprint !== disposition.nodeFingerprint) {
      context.addIssue({ code: 'custom', path: ['nonProviderDispositions', index], message: 'disposition does not match an exact create node and execution' });
    }
    if (dispositionsByNode.has(disposition.nodeId) || resultsByNode.has(disposition.nodeId)) {
      context.addIssue({ code: 'custom', path: ['nonProviderDispositions', index, 'nodeId'], message: 'create node is accounted more than once' });
    } else {
      dispositionsByNode.set(disposition.nodeId, disposition);
    }
  }

  const observationsByNode = new Map<string, CampaignCreationResourceObservation>();
  for (const [index, observation] of evidence.observations.entries()) {
    const result = resultsByNode.get(observation.nodeId);
    if (observation.planId !== evidence.plan.id
      || observation.executionId !== evidence.executionId
      || result?.effect !== 'irreversible_create'
      || (result.outcome !== 'succeeded' && result.outcome !== 'ambiguous')
      || observation.nodeFingerprint !== result.nodeFingerprint
      || (result.providerEntityId !== null && observation.providerEntityId !== null
        && observation.providerEntityId !== result.providerEntityId)) {
      context.addIssue({ code: 'custom', path: ['observations', index], message: 'observation does not match an observable create result' });
    }
    if (observationsByNode.has(observation.nodeId)) {
      context.addIssue({ code: 'custom', path: ['observations', index, 'nodeId'], message: 'execution evidence must contain one current observation per node' });
    } else {
      observationsByNode.set(observation.nodeId, observation);
    }
  }

  for (const node of evidence.plan.nodes) {
    const result = resultsByNode.get(node.nodeId);
    const disposition = dispositionsByNode.get(node.nodeId);
    if (node.effect === 'irreversible_create' && result === undefined && disposition === undefined) {
      context.addIssue({ code: 'custom', path: ['snapshot', 'accounting'], message: `create node ${node.nodeId} is absent from execution accounting` });
    }
    if (node.effect === 'read_check' && disposition !== undefined) {
      context.addIssue({ code: 'custom', path: ['nonProviderDispositions'], message: 'read checks cannot carry create dispositions' });
    }
    if (result?.effect === 'irreversible_create'
      && (result.outcome === 'succeeded' || result.outcome === 'ambiguous')
      && !observationsByNode.has(node.nodeId)) {
      context.addIssue({ code: 'custom', path: ['observations'], message: `observable node ${node.nodeId} has no current observation` });
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
  const actualAccounting: CampaignCreationAccounting = {
    operatorApproved: evidence.plan.counts.irreversibleCreates,
    pendingDispatch: evidence.nonProviderDispositions.filter((item) => item.outcome === 'pending_dispatch').length,
    attempted: createResults.length,
    succeeded: createResults.filter((result) => result.outcome === 'succeeded').length,
    failed: createResults.filter((result) => result.outcome === 'failed').length,
    ambiguous: createResults.filter((result) => result.outcome === 'ambiguous').length,
    refusedAtExecution: evidence.nonProviderDispositions.filter((item) => item.outcome === 'refused_at_execution').length,
    blockedByDependency: evidence.nonProviderDispositions.filter((item) => item.outcome === 'blocked_by_dependency').length,
    observed: evidence.observations.filter((item) => item.observation === 'observed').length,
    pendingObservation: evidence.observations.filter((item) => item.observation === 'pending').length,
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
  executionId: CampaignCreationUuid,
}).strict();

export const CampaignCreationObserveJob = z.object({
  type: z.literal('campaign_creation.observe'),
  orgId: CampaignCreationUuid,
  profileId: CampaignCreationUuid,
  planId: CampaignCreationUuid,
  executionId: CampaignCreationUuid,
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
