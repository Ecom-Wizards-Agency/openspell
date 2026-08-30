import { describe, expect, it } from 'vitest';
import {
  ApproveCampaignCreationPlan,
  CampaignCreationAccounting,
  CampaignCreationExecutionEvidence,
  CampaignCreationExecutionSnapshot,
  CampaignCreationJobPayload,
  CampaignCreationNode,
  CampaignCreationPlan,
  CampaignCreationProviderResult,
  CampaignCreationResourceObservation,
  JobPayload,
  orderCampaignCreationNodes,
  serializeCampaignCreationNodeFingerprint,
  serializeCampaignCreationPlanFingerprint,
  type CampaignCreationNode as CampaignCreationNodeType,
  type CampaignCreationPlan as CampaignCreationPlanType,
} from './index.js';

const ORG_ID = '00000000-0000-4000-8000-000000000001';
const PROFILE_ID = '00000000-0000-4000-8000-000000000002';
const PLAN_ID = '00000000-0000-4000-8000-000000000003';
const EXECUTION_ID = '00000000-0000-4000-8000-000000000004';
const ATTEMPT_ID = '00000000-0000-4000-8000-000000000005';
const CALL_ID = '00000000-0000-4000-8000-000000000006';
const GENERATION_ID = '00000000-0000-4000-8000-000000000007';
const PRODUCT_NODE_ID = '00000000-0000-4000-8000-000000000011';
const CAMPAIGN_NODE_ID = '00000000-0000-4000-8000-000000000012';
const AD_GROUP_NODE_ID = '00000000-0000-4000-8000-000000000013';
const AD_NODE_ID = '00000000-0000-4000-8000-000000000014';
const TARGET_NODE_ID = '00000000-0000-4000-8000-000000000015';
const sha = (character: string): string => character.repeat(64);

function spNodes(): CampaignCreationNodeType[] {
  return [
    CampaignCreationNode.parse({
      nodeId: PRODUCT_NODE_ID,
      kind: 'eligibility.require_product',
      adProduct: 'SP',
      apiDialect: 'sp_legacy_v3',
      dependsOn: [],
      fingerprint: sha('1'),
      effect: 'read_check',
      rollback: 'not_applicable',
      payload: { asin: 'B000000000', sku: 'SYNTHETIC-SKU' },
    }),
    CampaignCreationNode.parse({
      nodeId: CAMPAIGN_NODE_ID,
      kind: 'campaign.create',
      adProduct: 'SP',
      apiDialect: 'sp_legacy_v3',
      dependsOn: [PRODUCT_NODE_ID],
      fingerprint: sha('2'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        name: 'Synthetic campaign',
        state: 'paused',
        budget: { amount: 10, type: 'daily', currencyCode: 'USD' },
        startDate: '2026-08-31',
        endDate: null,
        portfolioId: null,
        settings: {
          product: 'SP',
          targetingType: 'manual',
          biddingStrategy: 'manual',
          placementBidding: { topOfSearch: 0, productPages: 0, restOfSearch: 0 },
        },
      },
    }),
    CampaignCreationNode.parse({
      nodeId: AD_GROUP_NODE_ID,
      kind: 'ad_group.create',
      adProduct: 'SP',
      apiDialect: 'sp_legacy_v3',
      dependsOn: [CAMPAIGN_NODE_ID],
      fingerprint: sha('3'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        campaign: { source: 'plan_node', kind: 'campaign', nodeId: CAMPAIGN_NODE_ID },
        name: 'Synthetic ad group',
        state: 'paused',
        defaultBid: 1.01,
      },
    }),
    CampaignCreationNode.parse({
      nodeId: AD_NODE_ID,
      kind: 'ad.create',
      adProduct: 'SP',
      apiDialect: 'sp_legacy_v3',
      dependsOn: [PRODUCT_NODE_ID, AD_GROUP_NODE_ID],
      fingerprint: sha('4'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        format: 'sp_product_ad',
        adGroup: { source: 'plan_node', kind: 'ad_group', nodeId: AD_GROUP_NODE_ID },
        product: { source: 'plan_node', kind: 'product', nodeId: PRODUCT_NODE_ID },
        state: 'paused',
      },
    }),
    CampaignCreationNode.parse({
      nodeId: TARGET_NODE_ID,
      kind: 'target.create',
      adProduct: 'SP',
      apiDialect: 'sp_legacy_v3',
      dependsOn: [AD_GROUP_NODE_ID],
      fingerprint: sha('5'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        targetType: 'keyword',
        parent: { source: 'plan_node', kind: 'ad_group', nodeId: AD_GROUP_NODE_ID },
        scope: 'ad_group',
        polarity: 'positive',
        text: 'synthetic keyword',
        matchType: 'exact',
        bid: 1.01,
        state: 'paused',
      },
    }),
  ];
}

function counts() {
  return {
    totalNodes: 5,
    readChecks: 1,
    irreversibleCreates: 4,
    byKind: {
      'eligibility.require_product': 1,
      'eligibility.require_brand': 0,
      'eligibility.require_store': 0,
      'asset.require_existing': 0,
      'campaign.create': 1,
      'ad_group.create': 1,
      'target.create': 1,
      'ad.create': 1,
      'creative.create': 0,
    },
  } as const;
}

function spPlan(): CampaignCreationPlanType {
  return CampaignCreationPlan.parse({
    schemaVersion: 'openspell.campaign-creation-plan.v1',
    id: PLAN_ID,
    orgId: ORG_ID,
    profileId: PROFILE_ID,
    marketplaceId: 'MARKETPLACE-1',
    adProduct: 'SP',
    apiDialect: 'sp_legacy_v3',
    generatedAt: '2026-08-30T00:00:00.000Z',
    frozenAt: '2026-08-30T00:01:00.000Z',
    expiresAt: '2026-08-30T01:01:00.000Z',
    nodes: spNodes(),
    counts: counts(),
    fingerprint: sha('a'),
    noRollbackAcknowledgement: {
      required: true,
      rollback: 'none',
      compensatingAction: 'separate_reviewed_pause_or_archive',
    },
  });
}

function sbStoreSpotlightPlan(): CampaignCreationPlanType {
  const brandId = '00000000-0000-4000-8000-000000000020';
  const storeId = '00000000-0000-4000-8000-000000000021';
  const logoId = '00000000-0000-4000-8000-000000000022';
  const productIds = [
    '00000000-0000-4000-8000-000000000023',
    '00000000-0000-4000-8000-000000000024',
    '00000000-0000-4000-8000-000000000025',
  ];
  const campaignId = '00000000-0000-4000-8000-000000000026';
  const adGroupId = '00000000-0000-4000-8000-000000000027';
  const adId = '00000000-0000-4000-8000-000000000028';
  const pageIds = ['PAGE-1', 'PAGE-2', 'PAGE-3'];
  const nodes = orderCampaignCreationNodes([
    CampaignCreationNode.parse({
      nodeId: brandId,
      kind: 'eligibility.require_brand',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [],
      fingerprint: sha('1'),
      effect: 'read_check',
      rollback: 'not_applicable',
      payload: {
        brandId: 'BRAND-1',
        brandEntityId: 'BRAND-ENTITY-1',
        brandName: 'Synthetic brand',
      },
    }),
    CampaignCreationNode.parse({
      nodeId: storeId,
      kind: 'eligibility.require_store',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [],
      fingerprint: sha('2'),
      effect: 'read_check',
      rollback: 'not_applicable',
      payload: { storeId: 'STORE-1', pageIds },
    }),
    CampaignCreationNode.parse({
      nodeId: logoId,
      kind: 'asset.require_existing',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [],
      fingerprint: sha('3'),
      effect: 'read_check',
      rollback: 'not_applicable',
      payload: {
        assetId: 'ASSET-1',
        version: '1',
        purpose: 'logo',
      },
    }),
    ...productIds.map((nodeId, index) => CampaignCreationNode.parse({
      nodeId,
      kind: 'eligibility.require_product',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [],
      fingerprint: sha(String(index + 4)),
      effect: 'read_check',
      rollback: 'not_applicable',
      payload: { asin: `B00000000${index + 1}`, sku: null },
    })),
    CampaignCreationNode.parse({
      nodeId: campaignId,
      kind: 'campaign.create',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [brandId, storeId].sort(),
      fingerprint: sha('7'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        name: 'Synthetic Store campaign',
        state: 'paused',
        budget: { amount: 10, type: 'daily', currencyCode: 'USD' },
        startDate: '2026-08-31',
        endDate: null,
        portfolioId: null,
        settings: {
          product: 'SB',
          targetingType: 'manual',
          format: 'store_spotlight',
          brand: { source: 'plan_node', kind: 'brand', nodeId: brandId },
        },
      },
    }),
    CampaignCreationNode.parse({
      nodeId: adGroupId,
      kind: 'ad_group.create',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [campaignId],
      fingerprint: sha('8'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        campaign: { source: 'plan_node', kind: 'campaign', nodeId: campaignId },
        name: 'Synthetic Store ad group',
        state: 'paused',
        defaultBid: null,
      },
    }),
    CampaignCreationNode.parse({
      nodeId: adId,
      kind: 'ad.create',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [brandId, storeId, logoId, ...productIds, adGroupId].sort(),
      fingerprint: sha('9'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        format: 'sb_store_spotlight',
        adGroup: { source: 'plan_node', kind: 'ad_group', nodeId: adGroupId },
        brand: { source: 'plan_node', kind: 'brand', nodeId: brandId },
        landingPage: {
          type: 'store',
          store: { source: 'plan_node', kind: 'store', nodeId: storeId },
          pageId: null,
        },
        logoAsset: { source: 'plan_node', kind: 'asset', nodeId: logoId },
        headline: 'Synthetic headline',
        cards: productIds.map((productId, index) => ({
          headline: `Synthetic card ${index + 1}`,
          landingPage: {
            type: 'store',
            store: { source: 'plan_node', kind: 'store', nodeId: storeId },
            pageId: pageIds[index],
          },
          product: { source: 'plan_node', kind: 'product', nodeId: productId },
        })),
        state: 'paused',
      },
    }),
  ]);
  return CampaignCreationPlan.parse({
    schemaVersion: 'openspell.campaign-creation-plan.v1',
    id: '00000000-0000-4000-8000-000000000029',
    orgId: ORG_ID,
    profileId: PROFILE_ID,
    marketplaceId: 'MARKETPLACE-1',
    adProduct: 'SB',
    apiDialect: 'unified_ads_v1',
    generatedAt: '2026-08-30T00:00:00.000Z',
    frozenAt: '2026-08-30T00:01:00.000Z',
    expiresAt: '2026-08-30T01:01:00.000Z',
    nodes,
    counts: {
      totalNodes: 9,
      readChecks: 6,
      irreversibleCreates: 3,
      byKind: {
        'eligibility.require_product': 3,
        'eligibility.require_brand': 1,
        'eligibility.require_store': 1,
        'asset.require_existing': 1,
        'campaign.create': 1,
        'ad_group.create': 1,
        'target.create': 0,
        'ad.create': 1,
        'creative.create': 0,
      },
    },
    fingerprint: sha('b'),
    noRollbackAcknowledgement: {
      required: true,
      rollback: 'none',
      compensatingAction: 'separate_reviewed_pause_or_archive',
    },
  });
}

function completedSpExecutionEvidence() {
  const plan = spPlan();
  const providerResults = plan.nodes.map((node, index) => ({
    effect: node.effect,
    planId: plan.id,
    nodeId: node.nodeId,
    executionId: EXECUTION_ID,
    attemptId: `00000000-0000-4000-8000-${String(index + 101).padStart(12, '0')}`,
    providerCallId: CALL_ID,
    nodeFingerprint: node.fingerprint,
    requestIndex: index,
    outcome: node.effect === 'read_check' ? 'passed' : 'succeeded',
    providerEntityId: `ENTITY-${index + 1}`,
    providerCode: null,
    sanitizedMessage: null,
    providerRequestId: 'REQUEST-1',
    responseDigest: sha(String((index + 1) % 10)),
    startedAt: '2026-08-30T00:02:00.000Z',
    completedAt: '2026-08-30T00:02:01.000Z',
  }));
  const observations = plan.nodes
    .filter((node) => node.effect === 'irreversible_create')
    .map((node, index) => ({
      planId: plan.id,
      nodeId: node.nodeId,
      executionId: EXECUTION_ID,
      nodeFingerprint: node.fingerprint,
      providerEntityId: `ENTITY-${index + 2}`,
      observation: 'observed',
      amazonModerationStatus: 'not_applicable',
      deliveryStatus: 'not_delivering',
      observedAt: '2026-08-30T00:03:00.000Z',
      sourceSyncJobId: GENERATION_ID,
    }));
  return {
    plan,
    executionId: EXECUTION_ID,
    providerResults,
    nonProviderDispositions: [],
    observations,
    snapshot: {
      status: 'succeeded',
      accounting: {
        operatorApproved: 4,
        pendingDispatch: 0,
        attempted: 4,
        succeeded: 4,
        failed: 0,
        ambiguous: 0,
        refusedAtExecution: 0,
        blockedByDependency: 0,
        observed: 4,
        pendingObservation: 0,
        observationNotFound: 0,
        observationConflict: 0,
        readChecksRequested: 1,
        readChecksPending: 0,
        readChecksPassed: 1,
        readChecksRefused: 0,
        readChecksFailed: 0,
      },
    },
  };
}

describe('campaign creation plan', () => {
  it('round-trips a deterministic paused Sponsored Products dependency graph', () => {
    const plan = spPlan();
    expect(CampaignCreationPlan.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(plan.nodes.map((node) => node.nodeId)).toEqual([
      PRODUCT_NODE_ID,
      CAMPAIGN_NODE_ID,
      AD_GROUP_NODE_ID,
      AD_NODE_ID,
      TARGET_NODE_ID,
    ]);
    expect(orderCampaignCreationNodes([...plan.nodes].reverse()).map((node) => node.nodeId))
      .toEqual(plan.nodes.map((node) => node.nodeId));
    expect(plan.nodes.filter((node) => node.effect === 'irreversible_create')
      .every((node) => node.rollback === 'none' && node.payload.state === 'paused')).toBe(true);
  });

  it('binds canonical node semantics and the complete approval envelope', () => {
    const plan = spPlan();
    const campaign = plan.nodes[1] as CampaignCreationNodeType;
    const nodePreimage = serializeCampaignCreationNodeFingerprint(campaign);
    const changedCampaign = CampaignCreationNode.parse({
      ...campaign,
      payload: { ...campaign.payload, name: 'Changed synthetic campaign' },
    });
    expect(serializeCampaignCreationNodeFingerprint(changedCampaign)).not.toBe(nodePreimage);

    const originalPreimage = serializeCampaignCreationPlanFingerprint(plan);
    expect(serializeCampaignCreationPlanFingerprint({ ...plan, orgId: GENERATION_ID }))
      .not.toBe(originalPreimage);
    expect(serializeCampaignCreationPlanFingerprint({
      ...plan,
      nodes: plan.nodes.map((node) => node.nodeId === CAMPAIGN_NODE_ID
        ? { ...node, fingerprint: sha('b') }
        : node),
    })).not.toBe(originalPreimage);
  });

  it('rejects count drift, non-canonical order, cycles, missing dependencies, and scope drift', () => {
    const plan = spPlan();
    expect(CampaignCreationPlan.safeParse({
      ...plan,
      counts: { ...plan.counts, irreversibleCreates: 3 },
    }).success).toBe(false);
    expect(CampaignCreationPlan.safeParse({
      ...plan,
      nodes: [plan.nodes[0], plan.nodes[1], plan.nodes[2], plan.nodes[4], plan.nodes[3]],
    }).success).toBe(false);

    const cyclic = plan.nodes.map((node) => node.nodeId === CAMPAIGN_NODE_ID
      ? { ...node, dependsOn: [AD_GROUP_NODE_ID] }
      : node);
    expect(CampaignCreationPlan.safeParse({ ...plan, nodes: cyclic }).success).toBe(false);

    const missingReferenceDependency = plan.nodes.map((node) => node.nodeId === AD_GROUP_NODE_ID
      ? { ...node, dependsOn: [] }
      : node);
    expect(CampaignCreationPlan.safeParse({ ...plan, nodes: missingReferenceDependency }).success)
      .toBe(false);
    expect(CampaignCreationPlan.safeParse({
      ...plan,
      adProduct: 'SB',
    }).success).toBe(false);
  });

  it('rejects enabled creates and mismatched keyword polarity', () => {
    const campaign = spNodes()[1] as CampaignCreationNodeType;
    expect(CampaignCreationNode.safeParse({
      ...campaign,
      payload: { ...campaign.payload, state: 'enabled' },
    }).success).toBe(false);

    const target = spNodes()[4] as CampaignCreationNodeType;
    expect(CampaignCreationNode.safeParse({
      ...target,
      payload: { ...target.payload, polarity: 'negative', matchType: 'exact', bid: null },
    }).success).toBe(false);
  });

  it('models current Unified SB manual and automatic collections without invented fields', () => {
    const ref = (kind: 'ad_group' | 'brand' | 'product' | 'asset', suffix: number) => ({
      source: 'plan_node' as const,
      kind,
      nodeId: `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`,
    });
    const manual = {
      nodeId: '00000000-0000-4000-8000-000000000040',
      kind: 'ad.create',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [],
      fingerprint: sha('4'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        format: 'sb_product_collection_manual',
        adGroup: ref('ad_group', 41),
        brand: ref('brand', 42),
        products: [ref('product', 43), ref('product', 44), ref('product', 45)],
        logoAsset: null,
        title: null,
        landingPage: { type: 'asin_list' },
        state: 'paused',
      },
    } as const;
    expect(CampaignCreationNode.safeParse(manual).success).toBe(true);

    const automatic = {
      ...manual,
      nodeId: '00000000-0000-4000-8000-000000000046',
      payload: {
        format: 'sb_product_collection_automatic',
        adGroup: ref('ad_group', 41),
        brand: ref('brand', 42),
        logoAsset: null,
        productExclusions: [],
        state: 'paused',
      },
    } as const;
    expect(CampaignCreationNode.safeParse(automatic).success).toBe(true);
    expect(CampaignCreationNode.safeParse({
      ...automatic,
      payload: { ...automatic.payload, headline: 'Amazon generates this field' },
    }).success).toBe(false);
    expect(CampaignCreationNode.safeParse({
      ...automatic,
      payload: {
        ...automatic.payload,
        productExclusions: Array.from({ length: 101 }, (_, index) => ref('product', 1000 + index)),
      },
    }).success).toBe(false);
    expect(CampaignCreationNode.safeParse({ ...manual, apiDialect: 'sb_legacy_v4' }).success)
      .toBe(false);

    const spotlight = sbStoreSpotlightPlan();
    const automaticTargeting = spotlight.nodes.map((node) => node.kind === 'campaign.create'
      ? {
          ...node,
          payload: {
            ...node.payload,
            settings: { ...node.payload.settings, targetingType: 'auto' },
          },
        }
      : node);
    expect(CampaignCreationPlan.safeParse({ ...spotlight, nodes: automaticTargeting }).success)
      .toBe(false);
  });

  it('requires planned, preflighted parents and strictly forward-stage dependencies', () => {
    const adGroup = spNodes()[2];
    if (adGroup?.kind !== 'ad_group.create') throw new Error('synthetic ad group missing');
    expect(CampaignCreationNode.safeParse({
      ...adGroup,
      payload: {
        ...adGroup.payload,
        campaign: { source: 'existing', kind: 'campaign', amazonId: 'CAMPAIGN-1' },
      },
    }).success).toBe(false);

    const readCheck = spNodes()[0];
    expect(CampaignCreationNode.safeParse({
      ...readCheck,
      dependsOn: [CAMPAIGN_NODE_ID],
    }).success).toBe(false);

    const plan = spPlan();
    const backwards = plan.nodes.map((node) => node.nodeId === AD_NODE_ID
      ? { ...node, dependsOn: [PRODUCT_NODE_ID, AD_GROUP_NODE_ID, TARGET_NODE_ID].sort() }
      : node);
    expect(CampaignCreationPlan.safeParse({
      ...plan,
      nodes: orderCampaignCreationNodes(backwards as CampaignCreationNodeType[]),
    }).success).toBe(false);
  });

  it('rejects duplicate provider preflights and unsupported expression semantics', () => {
    const plan = spPlan();
    const duplicateProduct = CampaignCreationNode.parse({
      ...plan.nodes[0],
      nodeId: '00000000-0000-4000-8000-000000000010',
      fingerprint: sha('9'),
    });
    const duplicateNodes = orderCampaignCreationNodes([duplicateProduct, ...plan.nodes]);
    expect(CampaignCreationPlan.safeParse({
      ...plan,
      nodes: duplicateNodes,
      counts: {
        ...plan.counts,
        totalNodes: 6,
        readChecks: 2,
        byKind: { ...plan.counts.byKind, 'eligibility.require_product': 2 },
      },
    }).success).toBe(false);

    const spotlight = sbStoreSpotlightPlan();
    for (const kind of ['eligibility.require_store', 'asset.require_existing'] as const) {
      const original = spotlight.nodes.find((node) => node.kind === kind);
      if (original === undefined) throw new Error(`synthetic ${kind} preflight missing`);
      const duplicate = CampaignCreationNode.parse({
        ...original,
        nodeId: kind === 'eligibility.require_store'
          ? '00000000-0000-4000-8000-000000000030'
          : '00000000-0000-4000-8000-000000000031',
        fingerprint: sha(kind === 'eligibility.require_store' ? '8' : '9'),
      });
      expect(CampaignCreationPlan.safeParse({
        ...spotlight,
        nodes: orderCampaignCreationNodes([...spotlight.nodes, duplicate]),
        counts: {
          ...spotlight.counts,
          totalNodes: spotlight.counts.totalNodes + 1,
          readChecks: spotlight.counts.readChecks + 1,
          byKind: {
            ...spotlight.counts.byKind,
            [kind]: spotlight.counts.byKind[kind] + 1,
          },
        },
      }).success).toBe(false);
    }

    const target = spNodes()[4];
    expect(CampaignCreationNode.safeParse({
      ...target,
      payload: {
        targetType: 'expression',
        parent: { source: 'plan_node', kind: 'ad_group', nodeId: AD_GROUP_NODE_ID },
        scope: 'ad_group',
        polarity: 'positive',
        expression: [{ type: 'negative_exact', value: 'synthetic' }],
        bid: 1.01,
        state: 'paused',
      },
    }).success).toBe(false);
  });

  it('uses chronological instants and lowercase canonical UUIDs', () => {
    const plan = spPlan();
    expect(CampaignCreationPlan.safeParse({
      ...plan,
      generatedAt: '2026-08-30T00:00:00.001Z',
      frozenAt: '2026-08-30T00:00:00Z',
    }).success).toBe(false);
    expect(CampaignCreationNode.safeParse({
      ...spNodes()[0],
      nodeId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    }).success).toBe(false);
  });

  it('binds Store Spotlight to three checked pages and purpose-correct Asset IDs', () => {
    const plan = sbStoreSpotlightPlan();
    expect(plan.counts.irreversibleCreates).toBe(3);
    const adIndex = plan.nodes.findIndex((node) => node.kind === 'ad.create');
    const logoIndex = plan.nodes.findIndex((node) => node.kind === 'asset.require_existing'
      && node.payload.purpose === 'logo');
    const wrongLogo = plan.nodes.map((node, index) => index === logoIndex
      ? { ...node, payload: { ...node.payload, purpose: 'image' } }
      : node);
    expect(CampaignCreationPlan.safeParse({ ...plan, nodes: wrongLogo }).success).toBe(false);

    const ad = plan.nodes[adIndex];
    if (ad?.kind !== 'ad.create') {
      throw new Error('synthetic Store Spotlight ad missing');
    }
    const spotlight = ad.payload;
    if (spotlight.format !== 'sb_store_spotlight') {
      throw new Error('synthetic Store Spotlight format missing');
    }
    const wrongPage = plan.nodes.map((node, index) => index === adIndex
      ? {
          ...ad,
          payload: {
            ...spotlight,
            cards: spotlight.cards.map((card, cardIndex) => cardIndex === 0
              ? {
                  ...card,
                  landingPage: { ...card.landingPage, pageId: 'UNCHECKED-PAGE' },
                }
              : card),
          },
        }
      : node);
    expect(CampaignCreationPlan.safeParse({ ...plan, nodes: wrongPage }).success).toBe(false);
  });
});

describe('campaign creation approval and evidence', () => {
  it('binds approval to the exact tenant, plan, product, counts, expiry, and no-rollback facts', () => {
    const plan = spPlan();
    expect(ApproveCampaignCreationPlan.parse({
      schemaVersion: plan.schemaVersion,
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      orgId: plan.orgId,
      profileId: plan.profileId,
      marketplaceId: plan.marketplaceId,
      adProduct: plan.adProduct,
      apiDialect: plan.apiDialect,
      expiresAt: plan.expiresAt,
      expectedCounts: plan.counts,
      noRollbackAcknowledgement: plan.noRollbackAcknowledgement,
    }).expectedCounts.irreversibleCreates).toBe(4);
    expect(ApproveCampaignCreationPlan.safeParse({
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      orgId: plan.orgId,
      profileId: plan.profileId,
    }).success).toBe(false);
  });

  it('requires provider identity for passed checks, successful creates, and observations', () => {
    const common = {
      planId: PLAN_ID,
      nodeId: CAMPAIGN_NODE_ID,
      executionId: EXECUTION_ID,
      attemptId: ATTEMPT_ID,
      providerCallId: CALL_ID,
      nodeFingerprint: sha('a'),
      requestIndex: 0,
      providerCode: null,
      sanitizedMessage: null,
      providerRequestId: null,
      responseDigest: null,
      startedAt: '2026-08-30T00:02:00.000Z',
      completedAt: '2026-08-30T00:02:01.000Z',
    };
    expect(CampaignCreationProviderResult.safeParse({
      ...common,
      effect: 'irreversible_create',
      outcome: 'succeeded',
      providerEntityId: null,
    }).success).toBe(false);
    expect(CampaignCreationProviderResult.parse({
      ...common,
      effect: 'irreversible_create',
      outcome: 'succeeded',
      providerEntityId: 'CAMPAIGN-1',
    }).providerEntityId).toBe('CAMPAIGN-1');
    expect(CampaignCreationProviderResult.safeParse({
      ...common,
      effect: 'irreversible_create',
      outcome: 'succeeded',
      providerEntityId: 'CAMPAIGN-1',
      startedAt: '2026-08-30T00:02:00.001Z',
      completedAt: '2026-08-30T00:02:00Z',
    }).success).toBe(false);
    expect(CampaignCreationProviderResult.safeParse({
      ...common,
      effect: 'irreversible_create',
      outcome: 'refused',
      providerEntityId: null,
    }).success).toBe(false);

    const observation = {
      planId: PLAN_ID,
      nodeId: CAMPAIGN_NODE_ID,
      executionId: EXECUTION_ID,
      nodeFingerprint: sha('a'),
      providerEntityId: null,
      observation: 'pending',
      amazonModerationStatus: 'not_applicable',
      deliveryStatus: 'unknown',
      observedAt: '2026-08-30T00:03:00.000Z',
      sourceSyncJobId: null,
    } as const;
    expect(CampaignCreationResourceObservation.safeParse({
      ...observation,
      observation: 'observed',
    }).success).toBe(false);
    expect(CampaignCreationResourceObservation.safeParse({
      ...observation,
      deliveryStatus: 'delivering',
    }).success).toBe(false);
  });

  it('keeps operator, provider, observation, and read-check counts closed', () => {
    const valid = {
      operatorApproved: 4,
      pendingDispatch: 0,
      attempted: 3,
      succeeded: 2,
      failed: 0,
      ambiguous: 1,
      refusedAtExecution: 0,
      blockedByDependency: 1,
      observed: 2,
      pendingObservation: 1,
      observationNotFound: 0,
      observationConflict: 0,
      readChecksRequested: 1,
      readChecksPending: 0,
      readChecksPassed: 1,
      readChecksRefused: 0,
      readChecksFailed: 0,
    };
    expect(CampaignCreationAccounting.parse(valid).blockedByDependency).toBe(1);
    expect(CampaignCreationAccounting.safeParse({ ...valid, observed: 3 }).success).toBe(false);
    expect(CampaignCreationAccounting.safeParse({ ...valid, blockedByDependency: 0 }).success)
      .toBe(false);
    expect(CampaignCreationExecutionSnapshot.safeParse({
      status: 'succeeded',
      accounting: valid,
    }).success).toBe(false);
    expect(CampaignCreationExecutionSnapshot.safeParse({
      status: 'partial_failed',
      accounting: { ...valid, pendingObservation: 0, observationConflict: 1 },
    }).success).toBe(false);
    expect(CampaignCreationExecutionSnapshot.safeParse({
      status: 'blocked',
      accounting: {
        ...valid,
        attempted: 4,
        succeeded: 4,
        ambiguous: 0,
        blockedByDependency: 0,
        observed: 4,
        pendingObservation: 0,
      },
    }).success).toBe(false);
    expect(CampaignCreationExecutionSnapshot.safeParse({
      status: 'refused',
      accounting: {
        ...valid,
        attempted: 4,
        succeeded: 4,
        ambiguous: 0,
        blockedByDependency: 0,
        observed: 4,
        pendingObservation: 0,
      },
    }).success).toBe(false);
    expect(CampaignCreationExecutionSnapshot.safeParse({
      status: 'awaiting_observation',
      accounting: { ...valid, pendingDispatch: 1, blockedByDependency: 0 },
    }).success).toBe(false);
    expect(CampaignCreationExecutionSnapshot.safeParse({
      status: 'running',
      accounting: valid,
    }).success).toBe(false);
  });

  it('reconciles every exact node, provider position, disposition, and observation', () => {
    const evidence = completedSpExecutionEvidence();
    expect(CampaignCreationExecutionEvidence.parse(evidence).snapshot.status).toBe('succeeded');

    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerResults: evidence.providerResults.slice(0, -1),
    }).success).toBe(false);
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerResults: [...evidence.providerResults, evidence.providerResults[0]],
    }).success).toBe(false);
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      observations: [...evidence.observations, evidence.observations[0]],
    }).success).toBe(false);
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerResults: evidence.providerResults.map((result, index) => index === 1
        ? { ...result, nodeFingerprint: sha('f') }
        : result),
    }).success).toBe(false);

    const notFound = {
      ...evidence,
      observations: evidence.observations.map((observation, index) => index === 0
        ? {
            ...observation,
            providerEntityId: null,
            observation: 'not_found',
            deliveryStatus: 'unknown',
          }
        : observation),
      snapshot: {
        status: 'partial_failed',
        accounting: {
          ...evidence.snapshot.accounting,
          observed: 3,
          observationNotFound: 1,
        },
      },
    };
    expect(CampaignCreationExecutionEvidence.parse(notFound).snapshot.accounting.observationNotFound)
      .toBe(1);
  });

  it('reserves future creation jobs without making them claimable by current workers', () => {
    const dispatch = {
      type: 'campaign_creation.dispatch',
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      planId: PLAN_ID,
      executionId: EXECUTION_ID,
    } as const;
    expect(CampaignCreationJobPayload.parse(dispatch)).toEqual(dispatch);
    expect(JobPayload.safeParse(dispatch).success).toBe(false);
    expect(CampaignCreationJobPayload.safeParse({
      type: 'campaign_creation.observe',
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      planId: PLAN_ID,
      executionId: EXECUTION_ID,
      generation: GENERATION_ID,
      attempt: 8,
    }).success).toBe(false);
  });
});
