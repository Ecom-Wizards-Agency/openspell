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

export const CampaignCreationApiDialect = z.enum([
  'sp_legacy_v3',
  'sb_legacy_v4',
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
  nodeId: Uuid,
}).strict();
export type PlannedCampaignCreationResourceRef = z.infer<
  typeof PlannedCampaignCreationResourceRef
>;

export const CampaignCreationResourceRef = z.discriminatedUnion('source', [
  ExistingCampaignCreationResourceRef,
  PlannedCampaignCreationResourceRef,
]);
export type CampaignCreationResourceRef = z.infer<typeof CampaignCreationResourceRef>;

function resourceRef(kind: CampaignCreationResourceKind) {
  return CampaignCreationResourceRef.refine((reference) => reference.kind === kind, {
    message: `expected a ${kind} resource reference`,
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
  nodeId: Uuid,
  adProduct: AdProduct,
  apiDialect: CampaignCreationApiDialect,
  dependsOn: z.array(Uuid),
  fingerprint: CampaignCreationSha256,
};

const requirementNodeBase = {
  ...nodeBase,
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
  payload: z.object({ brandEntityId: AmazonId }).strict(),
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
    campaign: resourceRef('campaign'),
    name: z.string().min(1).max(256),
    state: z.literal('paused'),
    defaultBid: z.number().finite().nonnegative().nullable(),
  }).strict(),
}).strict();

const PositiveKeywordMatchType = z.enum(['exact', 'phrase', 'broad']);
const NegativeKeywordMatchType = z.enum(['negative_exact', 'negative_phrase']);

const KeywordTargetPayload = z.object({
  targetType: z.literal('keyword'),
  parent: CampaignCreationResourceRef.refine(
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
  parent: CampaignCreationResourceRef.refine(
    (reference) => reference.kind === 'campaign' || reference.kind === 'ad_group',
    { message: 'expression parent must be a campaign or ad group' },
  ),
  scope: z.enum(['campaign', 'ad_group']),
  polarity: z.enum(['positive', 'negative']),
  expression: z.array(TargetExpression).min(1),
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
  store: resourceRef('store'),
  pageId: AmazonId.nullable(),
}).strict();

const ProductLandingPage = z.object({
  type: z.literal('product_detail'),
  products: z.array(resourceRef('product')).min(1),
}).strict();

const SponsoredBrandsLandingPage = z.discriminatedUnion('type', [
  StoreLandingPage,
  ProductLandingPage,
]);

const StoreSpotlightCard = z.object({
  pageId: AmazonId,
  headline: z.string().trim().min(1).max(128),
  imageAsset: resourceRef('asset'),
}).strict();

const AdPayload = z.discriminatedUnion('format', [
  z.object({
    format: z.literal('sp_product_ad'),
    adGroup: resourceRef('ad_group'),
    product: resourceRef('product'),
    state: z.literal('paused'),
  }).strict(),
  z.object({
    format: z.literal('sb_product_collection_manual'),
    adGroup: resourceRef('ad_group'),
    products: z.array(resourceRef('product')).min(3).max(10),
    logoAsset: resourceRef('asset'),
    headline: z.string().trim().min(1).max(128),
    landingPage: SponsoredBrandsLandingPage,
    state: z.literal('paused'),
  }).strict(),
  z.object({
    format: z.literal('sb_product_collection_automatic'),
    adGroup: resourceRef('ad_group'),
    logoAsset: resourceRef('asset'),
    headline: z.string().trim().min(1).max(128),
    landingPage: StoreLandingPage,
    state: z.literal('paused'),
  }).strict(),
  z.object({
    format: z.literal('sb_store_spotlight'),
    adGroup: resourceRef('ad_group'),
    store: resourceRef('store'),
    logoAsset: resourceRef('asset'),
    headline: z.string().trim().min(1).max(128),
    cards: z.tuple([StoreSpotlightCard, StoreSpotlightCard, StoreSpotlightCard]),
    state: z.literal('paused'),
  }).strict(),
  z.object({
    format: z.literal('sb_product_video'),
    adGroup: resourceRef('ad_group'),
    product: resourceRef('product'),
    videoAsset: resourceRef('asset'),
    state: z.literal('paused'),
  }).strict(),
  z.object({
    format: z.literal('sb_brand_video'),
    adGroup: resourceRef('ad_group'),
    brand: resourceRef('brand'),
    store: resourceRef('store'),
    logoAsset: resourceRef('asset'),
    videoAsset: resourceRef('asset'),
    headline: z.string().trim().min(1).max(128),
    state: z.literal('paused'),
  }).strict(),
  z.object({
    format: z.literal('sd_product_ad'),
    adGroup: resourceRef('ad_group'),
    product: resourceRef('product'),
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
    ad: resourceRef('ad'),
    assets: z.array(resourceRef('asset')).min(1),
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
  if (dialect === 'sb_legacy_v4') return product === 'SB';
  if (dialect === 'sd_legacy') return product === 'SD';
  return product === 'SP' || product === 'SB';
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

function nodeReferences(node: CampaignCreationNode): CampaignCreationResourceRef[] {
  switch (node.kind) {
    case 'eligibility.require_product':
    case 'eligibility.require_brand':
    case 'eligibility.require_store':
    case 'asset.require_existing':
    case 'campaign.create':
      return [];
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
            ...payload.products,
            payload.logoAsset,
            ...(payload.landingPage.type === 'store'
              ? [payload.landingPage.store]
              : payload.landingPage.products),
          ];
        case 'sb_product_collection_automatic':
          return [payload.adGroup, payload.logoAsset, payload.landingPage.store];
        case 'sb_store_spotlight':
          return [
            payload.adGroup,
            payload.store,
            payload.logoAsset,
            ...payload.cards.map((card) => card.imageAsset),
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
    return nodeStage(left) - nodeStage(right) || leftId.localeCompare(rightId);
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
  id: Uuid,
  orgId: Uuid,
  profileId: Uuid,
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
  if (!(plan.generatedAt <= plan.frozenAt && plan.frozenAt < plan.expiresAt)) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'plan timestamps must satisfy generated <= frozen < expires' });
  }

  const byId = new Map(plan.nodes.map((node) => [node.nodeId, node]));
  if (byId.size !== plan.nodes.length) {
    context.addIssue({ code: 'custom', path: ['nodes'], message: 'node IDs must be unique' });
    return;
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

    for (const reference of nodeReferences(node)) {
      if (reference.source !== 'plan_node') continue;
      const referenced = byId.get(reference.nodeId);
      if (!referenced) {
        context.addIssue({ code: 'custom', path: ['nodes', index], message: 'plan-node reference is missing' });
        continue;
      }
      if (!node.dependsOn.includes(reference.nodeId)) {
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
          requireCheckedResource(payload.brand, 'brand');
          requireCheckedResource(payload.store, 'store');
          requireCheckedResource(payload.logoAsset, 'asset', 'logo');
          requireCheckedResource(payload.videoAsset, 'asset', 'video');
          break;
        case 'sb_product_collection_manual': {
          const productKeys = payload.products.map(referenceKey);
          if (new Set(productKeys).size !== productKeys.length) {
            context.addIssue({ code: 'custom', path: ['nodes', index, 'payload', 'products'], message: 'collection products must be unique' });
          }
          payload.products.forEach((product) => requireCheckedResource(product, 'product'));
          requireCheckedResource(payload.logoAsset, 'asset', 'logo');
          if (payload.landingPage.type === 'store') {
            const store = requireCheckedResource(payload.landingPage.store, 'store');
            if (payload.landingPage.pageId !== null && store?.kind === 'eligibility.require_store'
              && !store.payload.pageIds.includes(payload.landingPage.pageId)) {
              context.addIssue({ code: 'custom', path: ['nodes', index, 'payload', 'landingPage', 'pageId'], message: 'landing page is absent from the checked Store' });
            }
          } else {
            const landingKeys = payload.landingPage.products.map(referenceKey);
            if (new Set(landingKeys).size !== landingKeys.length) {
              context.addIssue({ code: 'custom', path: ['nodes', index, 'payload', 'landingPage', 'products'], message: 'landing products must be unique' });
            }
            payload.landingPage.products.forEach((product) => requireCheckedResource(product, 'product'));
          }
          break;
        }
        case 'sb_product_collection_automatic': {
          requireCheckedResource(payload.logoAsset, 'asset', 'logo');
          const store = requireCheckedResource(payload.landingPage.store, 'store');
          if (payload.landingPage.pageId !== null && store?.kind === 'eligibility.require_store'
            && !store.payload.pageIds.includes(payload.landingPage.pageId)) {
            context.addIssue({ code: 'custom', path: ['nodes', index, 'payload', 'landingPage', 'pageId'], message: 'landing page is absent from the checked Store' });
          }
          break;
        }
        case 'sb_store_spotlight': {
          const store = requireCheckedResource(payload.store, 'store');
          requireCheckedResource(payload.logoAsset, 'asset', 'logo');
          const pageIds = payload.cards.map((card) => card.pageId);
          if (new Set(pageIds).size !== pageIds.length) {
            context.addIssue({ code: 'custom', path: ['nodes', index, 'payload', 'cards'], message: 'Store Spotlight pages must be unique' });
          }
          if (store?.kind === 'eligibility.require_store'
            && pageIds.some((pageId) => !store.payload.pageIds.includes(pageId))) {
            context.addIssue({ code: 'custom', path: ['nodes', index, 'payload', 'cards'], message: 'a Store Spotlight page is absent from the checked Store' });
          }
          payload.cards.forEach((card) => requireCheckedResource(card.imageAsset, 'asset', 'image'));
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
  planId: Uuid,
  planFingerprint: CampaignCreationSha256,
  orgId: Uuid,
  profileId: Uuid,
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
    planId: Uuid,
    nodeId: Uuid,
    executionId: Uuid,
    attemptId: Uuid,
    providerCallId: Uuid,
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
    if (value.completedAt < value.startedAt) {
      context.addIssue({ code: 'custom', path: ['completedAt'], message: 'provider result cannot complete before it starts' });
    }
  }),
  z.object({
    effect: z.literal('irreversible_create'),
    planId: Uuid,
    nodeId: Uuid,
    executionId: Uuid,
    attemptId: Uuid,
    providerCallId: Uuid,
    nodeFingerprint: CampaignCreationSha256,
    requestIndex: z.number().int().nonnegative().nullable(),
    outcome: z.enum(['succeeded', 'failed', 'ambiguous', 'refused']),
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
    if ((value.outcome === 'failed' || value.outcome === 'refused')
      && value.providerEntityId !== null) {
      context.addIssue({ code: 'custom', path: ['providerEntityId'], message: 'a failed or refused create cannot claim a provider resource' });
    }
    if (value.completedAt < value.startedAt) {
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
  planId: Uuid,
  nodeId: Uuid,
  executionId: Uuid,
  nodeFingerprint: CampaignCreationSha256,
  providerEntityId: AmazonId.nullable(),
  observation: z.enum(['pending', 'observed', 'not_found', 'conflict']),
  amazonModerationStatus: CampaignCreationAmazonModerationStatus,
  deliveryStatus: CampaignCreationDeliveryStatus,
  observedAt: z.iso.datetime(),
  sourceSyncJobId: Uuid.nullable(),
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
    + value.pendingObservation + value.observationConflict) {
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
    && (counts.attempted !== 0 || counts.pendingDispatch !== counts.operatorApproved)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'queued execution must have every approved create pending dispatch' });
  }
  if (snapshot.status === 'succeeded'
    && (!noDispatchPending || !noObservationPending || !noReadPending
      || counts.failed !== 0 || counts.refusedAtExecution !== 0
      || counts.blockedByDependency !== 0 || counts.observationConflict !== 0
      || counts.readChecksRefused !== 0 || counts.readChecksFailed !== 0
      || counts.observed !== counts.succeeded + counts.ambiguous)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'successful execution cannot hide incomplete, refused, failed, blocked, or conflicting work' });
  }
  if (snapshot.status === 'partial_failed'
    && (!noDispatchPending || !noObservationPending || !noReadPending
      || counts.observationConflict !== 0
      || counts.failed + counts.refusedAtExecution + counts.blockedByDependency
        + counts.readChecksRefused + counts.readChecksFailed === 0)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'partial failure must be terminal and contain a refused, failed, or blocked outcome' });
  }
  if (snapshot.status === 'ambiguous'
    && (!noDispatchPending || !noObservationPending || !noReadPending
      || counts.observationConflict === 0)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'terminal ambiguity requires a completed conflicting observation' });
  }
});
export type CampaignCreationExecutionSnapshot = z.infer<
  typeof CampaignCreationExecutionSnapshot
>;

/**
 * Future queue payloads. Deliberately not registered in JobPayload until the
 * worker executor and database enum land together, so current workers cannot
 * claim an unsupported creation job.
 */
export const CampaignCreationDispatchJob = z.object({
  type: z.literal('campaign_creation.dispatch'),
  orgId: Uuid,
  profileId: Uuid,
  planId: Uuid,
  executionId: Uuid,
}).strict();

export const CampaignCreationObserveJob = z.object({
  type: z.literal('campaign_creation.observe'),
  orgId: Uuid,
  profileId: Uuid,
  planId: Uuid,
  executionId: Uuid,
  generation: Uuid,
  attempt: z.number().int().nonnegative().max(7).default(0),
}).strict();

export const CampaignCreationJobPayload = z.discriminatedUnion('type', [
  CampaignCreationDispatchJob,
  CampaignCreationObserveJob,
]);
export type CampaignCreationJobPayload = z.infer<typeof CampaignCreationJobPayload>;
export type CampaignCreationDispatchJob = z.infer<typeof CampaignCreationDispatchJob>;
export type CampaignCreationObserveJob = z.infer<typeof CampaignCreationObserveJob>;
