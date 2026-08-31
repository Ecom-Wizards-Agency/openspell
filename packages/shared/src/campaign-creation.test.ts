/// <reference types="node" />

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ApproveCampaignCreationPlan,
  CampaignCreationAccounting,
  CampaignCreationAuthorizationReceipt,
  CampaignCreationExecutionEvidence,
  CampaignCreationExecutionSnapshot,
  CampaignCreationJobPayload,
  CampaignCreationNode,
  CampaignCreationPlan,
  CampaignCreationProviderResult,
  CampaignCreationResourceObservation,
  JobPayload,
  deriveCampaignCreationExecutionStatus,
  orderCampaignCreationNodes,
  serializeCampaignCreationNodeFingerprint,
  serializeCampaignCreationPlanFingerprint,
  verifyCampaignCreationJobArtifacts,
  verifyCampaignCreationObservationArtifacts,
  verifyCampaignCreationPlanFingerprints,
  verifyCampaignCreationProviderCallArtifacts,
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
const AUTHORIZATION_ID = '00000000-0000-4000-8000-000000000008';
const PRODUCT_NODE_ID = '00000000-0000-4000-8000-000000000011';
const CAMPAIGN_NODE_ID = '00000000-0000-4000-8000-000000000012';
const AD_GROUP_NODE_ID = '00000000-0000-4000-8000-000000000013';
const AD_NODE_ID = '00000000-0000-4000-8000-000000000014';
const TARGET_NODE_ID = '00000000-0000-4000-8000-000000000015';
const sha = (character: string): string => character.repeat(64);
const sha256 = {
  algorithm: 'sha256' as const,
  digest: (value: string): string => createHash('sha256').update(value).digest('hex'),
};

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

function fingerprintedSpPlan(): CampaignCreationPlanType {
  const base = spPlan();
  const nodes = base.nodes.map((node) => ({
    ...node,
    fingerprint: sha256.digest(serializeCampaignCreationNodeFingerprint(node)),
  })) as CampaignCreationNodeType[];
  const withNodeFingerprints = CampaignCreationPlan.parse({
    ...base,
    nodes,
    fingerprint: sha('0'),
  });
  return CampaignCreationPlan.parse({
    ...withNodeFingerprints,
    fingerprint: sha256.digest(serializeCampaignCreationPlanFingerprint(withNodeFingerprints)),
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
        name: 'Synthetic Store ad',
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

function sbProductVideoPlan(): CampaignCreationPlanType {
  const brandNodeId = '00000000-0000-4000-8000-000000000070';
  const videoAssetNodeId = '00000000-0000-4000-8000-000000000071';
  const campaignNodeId = '00000000-0000-4000-8000-000000000072';
  const adGroupNodeId = '00000000-0000-4000-8000-000000000073';
  const adNodeId = '00000000-0000-4000-8000-000000000074';
  const nodes = orderCampaignCreationNodes([
    CampaignCreationNode.parse({
      nodeId: brandNodeId,
      kind: 'eligibility.require_brand',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [],
      fingerprint: sha('1'),
      effect: 'read_check',
      rollback: 'not_applicable',
      payload: {
        brandId: 'BRAND-VIDEO-1',
        brandEntityId: 'BRAND-ENTITY-VIDEO-1',
        brandName: 'Synthetic video brand',
      },
    }),
    CampaignCreationNode.parse({
      nodeId: videoAssetNodeId,
      kind: 'asset.require_existing',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [],
      fingerprint: sha('2'),
      effect: 'read_check',
      rollback: 'not_applicable',
      payload: { assetId: 'VIDEO-ASSET-1', version: '7', purpose: 'video' },
    }),
    CampaignCreationNode.parse({
      nodeId: campaignNodeId,
      kind: 'campaign.create',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [brandNodeId],
      fingerprint: sha('3'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        name: 'Synthetic video campaign',
        state: 'paused',
        budget: { amount: 10, type: 'daily', currencyCode: 'USD' },
        startDate: '2026-08-31',
        endDate: null,
        portfolioId: null,
        settings: {
          product: 'SB',
          targetingType: 'manual',
          format: 'product_video',
          brand: { source: 'plan_node', kind: 'brand', nodeId: brandNodeId },
        },
      },
    }),
    CampaignCreationNode.parse({
      nodeId: adGroupNodeId,
      kind: 'ad_group.create',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [campaignNodeId],
      fingerprint: sha('4'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        campaign: { source: 'plan_node', kind: 'campaign', nodeId: campaignNodeId },
        name: 'Synthetic video ad group',
        state: 'paused',
        defaultBid: null,
      },
    }),
    CampaignCreationNode.parse({
      nodeId: adNodeId,
      kind: 'ad.create',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [videoAssetNodeId, adGroupNodeId].sort(),
      fingerprint: sha('5'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        format: 'sb_product_video',
        name: 'Synthetic product video ad',
        adGroup: { source: 'plan_node', kind: 'ad_group', nodeId: adGroupNodeId },
        brand: null,
        logoAsset: null,
        headline: null,
        enableCreativeAutoTranslation: null,
        landingPage: null,
        products: [],
        videoAsset: { source: 'plan_node', kind: 'asset', nodeId: videoAssetNodeId },
        state: 'paused',
      },
    }),
  ]);
  return CampaignCreationPlan.parse({
    schemaVersion: 'openspell.campaign-creation-plan.v1',
    id: '00000000-0000-4000-8000-000000000075',
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
      totalNodes: 5,
      readChecks: 2,
      irreversibleCreates: 3,
      byKind: {
        'eligibility.require_product': 0,
        'eligibility.require_brand': 1,
        'eligibility.require_store': 0,
        'asset.require_existing': 1,
        'campaign.create': 1,
        'ad_group.create': 1,
        'target.create': 0,
        'ad.create': 1,
        'creative.create': 0,
      },
    },
    fingerprint: sha('c'),
    noRollbackAcknowledgement: {
      required: true,
      rollback: 'none',
      compensatingAction: 'separate_reviewed_pause_or_archive',
    },
  });
}

function completedSpExecutionEvidence(plan: CampaignCreationPlanType = spPlan()) {
  const providerResults = plan.nodes.map((node, index) => ({
    effect: node.effect,
    planId: plan.id,
    nodeId: node.nodeId,
    executionId: EXECUTION_ID,
    attemptId: `00000000-0000-4000-8000-${String(index + 101).padStart(12, '0')}`,
    providerCallId: `00000000-0000-4000-8000-${String(index + 201).padStart(12, '0')}`,
    nodeFingerprint: node.fingerprint,
    requestIndex: node.effect === 'read_check' ? null : 0,
    ...(node.effect === 'irreversible_create' ? {
      requestDigest: sha(String((index + 6) % 10)),
      nodeRequestDigest: sha(String((index + 7) % 10)),
    } : {}),
    outcome: node.effect === 'read_check' ? 'passed' : 'succeeded',
    providerEntityId: node.kind === 'eligibility.require_product' ? node.payload.asin
      : node.kind === 'eligibility.require_brand' ? node.payload.brandId
        : node.kind === 'eligibility.require_store' ? node.payload.storeId
          : node.kind === 'asset.require_existing' ? node.payload.assetId
            : `ENTITY-${index + 1}`,
    providerEntityVersion: node.kind === 'asset.require_existing' ? node.payload.version : null,
    providerCode: null,
    sanitizedMessage: null,
    providerRequestId: 'REQUEST-1',
    responseDigest: sha(String((index + 1) % 10)),
    startedAt: `2026-08-30T00:02:${String(index * 2).padStart(2, '0')}.000Z`,
    completedAt: `2026-08-30T00:02:${String(index * 2 + 1).padStart(2, '0')}.000Z`,
  }));
  const providerCallIntents = plan.nodes
    .map((node, index) => ({ node, index, result: providerResults[index] }))
    .filter(({ node }) => node.effect === 'irreversible_create')
    .map(({ node, index, result }) => ({
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      executionId: EXECUTION_ID,
      authorizationId: AUTHORIZATION_ID,
      generation: GENERATION_ID,
      attemptId: result?.attemptId,
      providerCallId: result?.providerCallId,
      requestDigest: result?.requestDigest,
      positions: [{
        requestIndex: 0,
        nodeId: node.nodeId,
        nodeFingerprint: node.fingerprint,
        requestDigest: result?.nodeRequestDigest,
      }],
      recordedAt: `2026-08-30T00:02:${String(index * 2 - 1).padStart(2, '0')}.500Z`,
    }));
  const observations = plan.nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.effect === 'irreversible_create')
    .map(({ node, index }) => ({
      providerResult: providerResults.find((result) => result.nodeId === node.nodeId),
      providerIntent: providerCallIntents.find((intent) => (
        intent.positions.some((position) => position.nodeId === node.nodeId)
      )),
      index,
      node,
    }))
    .map(({ node, index, providerIntent, providerResult }) => ({
      planId: plan.id,
      nodeId: node.nodeId,
      executionId: EXECUTION_ID,
      authorizationId: providerIntent?.authorizationId,
      generation: providerIntent?.generation,
      attemptId: providerIntent?.attemptId,
      providerCallId: providerIntent?.providerCallId,
      nodeFingerprint: node.fingerprint,
      requestDigest: providerIntent?.requestDigest,
      nodeRequestDigest: providerIntent?.positions[0]?.requestDigest,
      basis: 'provider_result_identity',
      providerEntityId: providerResult?.providerEntityId,
      observation: 'observed',
      amazonModerationStatus: 'not_applicable',
      deliveryStatus: 'not_delivering',
      observedAt: `2026-08-30T00:02:${String(index * 2 + 1).padStart(2, '0')}.250Z`,
      sourceSyncJobId: GENERATION_ID,
    }));
  return {
    plan,
    executionId: EXECUTION_ID,
    providerCallIntents,
    providerResults,
    nonProviderDispositions: [],
    observations,
    snapshot: {
      status: 'succeeded',
      accounting: {
        operatorApproved: plan.counts.irreversibleCreates,
        pendingDispatch: 0,
        attempted: plan.counts.irreversibleCreates,
        succeeded: plan.counts.irreversibleCreates,
        failed: 0,
        ambiguous: 0,
        refusedAtExecution: 0,
        blockedByDependency: 0,
        observed: plan.counts.irreversibleCreates,
        pendingObservation: 0,
        observationNotFound: 0,
        observationConflict: 0,
        readChecksRequested: plan.counts.readChecks,
        readChecksPending: 0,
        readChecksPassed: plan.counts.readChecks,
        readChecksRefused: 0,
        readChecksFailed: 0,
      },
    },
  };
}

function failedCampaignExecutionEvidence() {
  const completed = completedSpExecutionEvidence();
  const campaignResult = completed.providerResults.find(
    (result) => result.nodeId === CAMPAIGN_NODE_ID,
  );
  if (campaignResult === undefined) throw new Error('synthetic campaign result missing');
  const providerResults = [
    completed.providerResults[0],
    {
      ...campaignResult,
      outcome: 'authoritative_rejected',
      providerEntityId: null,
      providerCode: 'SYNTHETIC_FAILURE',
    },
  ];
  const providerCallIntents = completed.providerCallIntents.filter((intent) => (
    intent.positions.some((position) => position.nodeId === CAMPAIGN_NODE_ID)
  ));
  const nonProviderDispositions = completed.plan.nodes
    .filter((node) => node.effect === 'irreversible_create' && node.nodeId !== CAMPAIGN_NODE_ID)
    .map((node) => ({
      planId: completed.plan.id,
      nodeId: node.nodeId,
      executionId: completed.executionId,
      nodeFingerprint: node.fingerprint,
      outcome: 'blocked_by_dependency',
      sanitizedReason: 'A required predecessor failed.',
    }));
  return {
    ...completed,
    providerCallIntents,
    providerResults,
    nonProviderDispositions,
    observations: [],
    snapshot: {
      status: 'failed',
      accounting: {
        operatorApproved: 4,
        pendingDispatch: 0,
        attempted: 1,
        succeeded: 0,
        failed: 1,
        ambiguous: 0,
        refusedAtExecution: 0,
        blockedByDependency: 3,
        observed: 0,
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

  it('recomputes every stored fingerprint before a persisted plan is trusted', () => {
    expect(sha256.digest('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const plan = fingerprintedSpPlan();
    expect(verifyCampaignCreationPlanFingerprints(plan, sha256)).toEqual(plan);

    const changedNodes = plan.nodes.map((node) => node.kind === 'campaign.create'
      ? {
          ...node,
          payload: { ...node.payload, name: 'Tampered synthetic campaign' },
        }
      : node);
    const tamperedNodePlan = CampaignCreationPlan.parse({ ...plan, nodes: changedNodes });
    expect(() => verifyCampaignCreationPlanFingerprints(tamperedNodePlan, sha256))
      .toThrow(/node .* fingerprint does not match/);

    const tamperedEnvelope = CampaignCreationPlan.parse({ ...plan, orgId: GENERATION_ID });
    expect(() => verifyCampaignCreationPlanFingerprints(tamperedEnvelope, sha256))
      .toThrow('campaign creation plan fingerprint does not match');
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

    const positiveCampaignKeyword = {
      ...target,
      dependsOn: [CAMPAIGN_NODE_ID],
      payload: {
        ...target.payload,
        parent: { source: 'plan_node', kind: 'campaign', nodeId: CAMPAIGN_NODE_ID },
        scope: 'campaign',
      },
    } as const;
    expect(CampaignCreationNode.safeParse(positiveCampaignKeyword).success).toBe(false);

    expect(CampaignCreationNode.safeParse({
      ...positiveCampaignKeyword,
      payload: {
        ...positiveCampaignKeyword.payload,
        polarity: 'negative',
        matchType: 'negative_exact',
        bid: null,
      },
    }).success).toBe(true);

    expect(CampaignCreationNode.safeParse({
      ...positiveCampaignKeyword,
      payload: {
        targetType: 'expression',
        parent: { source: 'plan_node', kind: 'campaign', nodeId: CAMPAIGN_NODE_ID },
        scope: 'campaign',
        polarity: 'positive',
        expression: [{ type: 'asin_same_as', value: 'B000000009' }],
        bid: 1.01,
        state: 'paused',
      },
    }).success).toBe(false);
    expect(CampaignCreationNode.safeParse({
      ...positiveCampaignKeyword,
      payload: {
        targetType: 'expression',
        parent: { source: 'plan_node', kind: 'campaign', nodeId: CAMPAIGN_NODE_ID },
        scope: 'campaign',
        polarity: 'negative',
        expression: [{ type: 'asin_same_as', value: 'B000000009' }],
        bid: null,
        state: 'paused',
      },
    }).success).toBe(true);
  });

  it('requires daily Sponsored Products budgets in legacy and unified dialects', () => {
    const campaign = spNodes()[1];
    if (campaign?.kind !== 'campaign.create') throw new Error('synthetic campaign missing');

    for (const apiDialect of ['sp_legacy_v3', 'unified_ads_v1'] as const) {
      expect(CampaignCreationNode.safeParse({
        ...campaign,
        apiDialect,
        payload: {
          ...campaign.payload,
          budget: { ...campaign.payload.budget, type: 'lifetime' },
        },
      }).success).toBe(false);
      expect(CampaignCreationNode.safeParse({
        ...campaign,
        apiDialect,
        payload: {
          ...campaign.payload,
          budget: { ...campaign.payload.budget, type: 'daily' },
        },
      }).success).toBe(true);
    }
  });

  it('rejects positive manual targets in automatic Sponsored Products campaigns', () => {
    const plan = spPlan();
    const automaticNodes = plan.nodes.map((node) => {
      if (node.kind !== 'campaign.create' || node.payload.settings.product !== 'SP') return node;
      return CampaignCreationNode.parse({
        ...node,
        payload: {
          ...node.payload,
          settings: { ...node.payload.settings, targetingType: 'auto' },
        },
      });
    });
    expect(CampaignCreationPlan.safeParse({ ...plan, nodes: automaticNodes }).success).toBe(false);

    const negativeNodes = automaticNodes.map((node) => node.kind === 'target.create'
      ? CampaignCreationNode.parse({
          ...node,
          payload: {
            targetType: 'keyword',
            parent: { source: 'plan_node', kind: 'ad_group', nodeId: AD_GROUP_NODE_ID },
            scope: 'ad_group',
            polarity: 'negative',
            text: 'synthetic negative keyword',
            matchType: 'negative_exact',
            bid: null,
            state: 'paused',
          },
        })
      : node);
    expect(CampaignCreationPlan.safeParse({ ...plan, nodes: negativeNodes }).success).toBe(true);

    const automaticExpressionNodes = automaticNodes.map((node) => node.kind === 'target.create'
      ? CampaignCreationNode.parse({
          ...node,
          payload: {
            targetType: 'expression',
            parent: { source: 'plan_node', kind: 'ad_group', nodeId: AD_GROUP_NODE_ID },
            scope: 'ad_group',
            polarity: 'positive',
            expression: [{ type: 'close_match', value: null }],
            bid: 1.01,
            state: 'paused',
          },
        })
      : node);
    expect(CampaignCreationPlan.safeParse({ ...plan, nodes: automaticExpressionNodes }).success)
      .toBe(true);

    expect(CampaignCreationPlan.safeParse({
      ...plan,
      nodes: automaticNodes.filter((node) => node.kind !== 'target.create'),
      counts: {
        ...plan.counts,
        totalNodes: plan.counts.totalNodes - 1,
        irreversibleCreates: plan.counts.irreversibleCreates - 1,
        byKind: { ...plan.counts.byKind, 'target.create': 0 },
      },
    }).success).toBe(true);
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
        name: 'Synthetic manual collection ad',
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
        name: 'Synthetic automatic collection ad',
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

  it('allows only one automatic Sponsored Brands collection ad per ad group', () => {
    const spotlight = sbStoreSpotlightPlan();
    const automaticNodes = spotlight.nodes.map((node) => {
      if (node.kind === 'campaign.create' && node.payload.settings.product === 'SB') {
        return CampaignCreationNode.parse({
          ...node,
          payload: {
            ...node.payload,
            settings: { ...node.payload.settings, format: 'product_collection_automatic' },
          },
        });
      }
      if (node.kind === 'ad.create' && node.payload.format === 'sb_store_spotlight') {
        return CampaignCreationNode.parse({
          ...node,
          payload: {
            format: 'sb_product_collection_automatic',
            name: 'Synthetic automatic collection ad',
            adGroup: node.payload.adGroup,
            brand: node.payload.brand,
            logoAsset: node.payload.logoAsset,
            productExclusions: [],
            state: 'paused',
          },
        });
      }
      return node;
    });
    const automaticPlan = CampaignCreationPlan.parse({
      ...spotlight,
      nodes: orderCampaignCreationNodes(automaticNodes),
    });
    const automaticAd = automaticPlan.nodes.find((node) => node.kind === 'ad.create');
    if (automaticAd?.kind !== 'ad.create'
      || automaticAd.payload.format !== 'sb_product_collection_automatic') {
      throw new Error('synthetic automatic collection ad missing');
    }
    const duplicateAd = CampaignCreationNode.parse({
      ...automaticAd,
      nodeId: '00000000-0000-4000-8000-000000000030',
      fingerprint: sha('d'),
      payload: { ...automaticAd.payload, name: 'Second synthetic automatic collection ad' },
    });
    expect(CampaignCreationPlan.safeParse({
      ...automaticPlan,
      nodes: orderCampaignCreationNodes([...automaticPlan.nodes, duplicateAd]),
      counts: {
        ...automaticPlan.counts,
        totalNodes: automaticPlan.counts.totalNodes + 1,
        irreversibleCreates: automaticPlan.counts.irreversibleCreates + 1,
        byKind: {
          ...automaticPlan.counts.byKind,
          'ad.create': automaticPlan.counts.byKind['ad.create'] + 1,
        },
      },
    }).success).toBe(false);
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
    expect(CampaignCreationNode.safeParse({
      ...target,
      payload: {
        targetType: 'expression',
        parent: { source: 'plan_node', kind: 'ad_group', nodeId: AD_GROUP_NODE_ID },
        scope: 'ad_group',
        polarity: 'negative',
        expression: [{ type: 'close_match', value: null }],
        bid: null,
        state: 'paused',
      },
    }).success).toBe(false);
    expect(CampaignCreationNode.safeParse({
      ...target,
      payload: {
        targetType: 'expression',
        parent: { source: 'plan_node', kind: 'ad_group', nodeId: AD_GROUP_NODE_ID },
        scope: 'ad_group',
        polarity: 'positive',
        expression: [{ type: 'asin_same_as', value: null }],
        bid: 1.01,
        state: 'paused',
      },
    }).success).toBe(false);
  });

  it('models Unified SB targetDetails variants and rejects legacy target payloads', () => {
    const plan = sbStoreSpotlightPlan();
    const adGroup = plan.nodes.find((node) => node.kind === 'ad_group.create');
    if (adGroup === undefined) throw new Error('synthetic SB ad group missing');
    const target = CampaignCreationNode.parse({
      nodeId: '00000000-0000-4000-8000-000000000032',
      kind: 'target.create',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [adGroup.nodeId],
      fingerprint: sha('c'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        targetType: 'sb_theme',
        parent: { source: 'plan_node', kind: 'ad_group', nodeId: adGroup.nodeId },
        polarity: 'positive',
        matchType: 'keywords_related_to_your_landing_pages',
        bid: 1.01,
        state: 'paused',
      },
    });
    const withTheme = {
      ...plan,
      nodes: orderCampaignCreationNodes([...plan.nodes, target]),
      counts: {
        ...plan.counts,
        totalNodes: plan.counts.totalNodes + 1,
        irreversibleCreates: plan.counts.irreversibleCreates + 1,
        byKind: { ...plan.counts.byKind, 'target.create': 1 },
      },
    };
    expect(CampaignCreationPlan.safeParse(withTheme).success).toBe(true);

    for (const payload of [
      {
        targetType: 'sb_keyword',
        parent: { source: 'plan_node', kind: 'ad_group', nodeId: adGroup.nodeId },
        polarity: 'negative',
        text: 'synthetic keyword',
        matchType: 'exact',
        bid: null,
        state: 'paused',
      },
      {
        targetType: 'sb_product',
        parent: { source: 'plan_node', kind: 'ad_group', nodeId: adGroup.nodeId },
        polarity: 'positive',
        asin: 'B000000009',
        bid: 1.01,
        state: 'paused',
      },
      {
        targetType: 'sb_product_category',
        parent: { source: 'plan_node', kind: 'ad_group', nodeId: adGroup.nodeId },
        polarity: 'positive',
        categoryId: 'CATEGORY-1',
        brandId: null,
        priceGreaterThan: null,
        priceLessThan: 50,
        ratingGreaterThan: 4,
        ratingLessThan: null,
        bid: 1.01,
        state: 'paused',
      },
    ] as const) {
      expect(CampaignCreationNode.safeParse({ ...target, payload }).success).toBe(true);
    }

    const legacyKeyword = CampaignCreationNode.parse({
      ...target,
      payload: {
        targetType: 'keyword',
        parent: { source: 'plan_node', kind: 'ad_group', nodeId: adGroup.nodeId },
        scope: 'ad_group',
        polarity: 'positive',
        text: 'synthetic keyword',
        matchType: 'exact',
        bid: 1.01,
        state: 'paused',
      },
    });
    expect(CampaignCreationPlan.safeParse({
      ...withTheme,
      nodes: orderCampaignCreationNodes([...plan.nodes, legacyKeyword]),
    }).success).toBe(false);
  });

  it('keeps Sponsored Display tactic and target semantics closed', () => {
    const nodes = spNodes().map((node) => {
      const common = { ...node, adProduct: 'SD', apiDialect: 'sd_legacy' } as const;
      if (node.kind === 'campaign.create') {
        return CampaignCreationNode.parse({
          ...common,
          payload: { ...node.payload, settings: { product: 'SD', tactic: 'contextual' } },
        });
      }
      if (node.kind === 'ad.create') {
        return CampaignCreationNode.parse({
          ...common,
          payload: { ...node.payload, format: 'sd_product_ad' },
        });
      }
      if (node.kind === 'target.create') {
        return CampaignCreationNode.parse({
          ...common,
          payload: {
            targetType: 'sd_product',
            parent: { source: 'plan_node', kind: 'ad_group', nodeId: AD_GROUP_NODE_ID },
            polarity: 'positive',
            asin: 'B000000009',
            bid: 1.01,
            state: 'paused',
          },
        });
      }
      return CampaignCreationNode.parse(common);
    });
    const plan = CampaignCreationPlan.parse({
      ...spPlan(),
      adProduct: 'SD',
      apiDialect: 'sd_legacy',
      nodes,
    });
    const mismatchedTactic = plan.nodes.map((node) => node.kind === 'campaign.create'
      ? {
          ...node,
          payload: { ...node.payload, settings: { product: 'SD', tactic: 'audience' } },
        }
      : node);
    expect(CampaignCreationPlan.safeParse({ ...plan, nodes: mismatchedTactic }).success)
      .toBe(false);
  });

  it('uses one named Unified SB product-video shape and preserves Asset ID/version', () => {
    const plan = sbProductVideoPlan();
    expect(plan.counts.byKind['asset.require_existing']).toBe(1);
    expect(CampaignCreationPlan.safeParse({
      ...plan,
      nodes: plan.nodes.map((node) => node.kind === 'asset.require_existing'
        ? { ...node, payload: { ...node.payload, purpose: 'image' } }
        : node),
    }).success).toBe(false);

    const ref = (kind: 'ad_group' | 'brand' | 'product' | 'store' | 'asset', suffix: number) => ({
      source: 'plan_node' as const,
      kind,
      nodeId: `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`,
    });
    const video = {
      nodeId: '00000000-0000-4000-8000-000000000060',
      kind: 'ad.create',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [],
      fingerprint: sha('6'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        format: 'sb_product_video',
        name: 'Synthetic video ad',
        adGroup: ref('ad_group', 61),
        brand: null,
        logoAsset: null,
        headline: null,
        enableCreativeAutoTranslation: null,
        landingPage: null,
        products: [],
        videoAsset: ref('asset', 62),
        state: 'paused',
      },
    } as const;
    expect(CampaignCreationNode.safeParse(video).success).toBe(true);
    expect(CampaignCreationNode.safeParse({
      ...video,
      payload: { ...video.payload, name: undefined },
    }).success).toBe(false);
    expect(CampaignCreationNode.safeParse({
      ...video,
      payload: { ...video.payload, format: 'sb_brand_video' },
    }).success).toBe(false);

    const asset = CampaignCreationNode.parse({
      nodeId: '00000000-0000-4000-8000-000000000062',
      kind: 'asset.require_existing',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [],
      fingerprint: sha('7'),
      effect: 'read_check',
      rollback: 'not_applicable',
      payload: { assetId: 'VIDEO-ASSET-1', version: '7', purpose: 'video' },
    });
    if (asset.kind !== 'asset.require_existing') throw new Error('synthetic video asset missing');
    const changedAsset = CampaignCreationNode.parse({
      ...asset,
      payload: { ...asset.payload, version: '8' },
    });
    expect(serializeCampaignCreationNodeFingerprint(changedAsset))
      .not.toBe(serializeCampaignCreationNodeFingerprint(asset));
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
    const campaign = spNodes()[1];
    if (campaign?.kind !== 'campaign.create') throw new Error('synthetic campaign missing');
    expect(CampaignCreationNode.safeParse({
      ...campaign,
      payload: { ...campaign.payload, startDate: '2026-99-99' },
    }).success).toBe(false);
    expect(CampaignCreationNode.safeParse({
      ...campaign,
      payload: { ...campaign.payload, startDate: '2026-02-29' },
    }).success).toBe(false);
    expect(CampaignCreationNode.safeParse({
      ...campaign,
      adProduct: 'SD',
      apiDialect: 'sd_legacy',
      payload: {
        ...campaign.payload,
        settings: { product: 'SD', tactic: 'invented-provider-tactic' },
      },
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
    expect(CampaignCreationAuthorizationReceipt.parse({
      authorizationId: AUTHORIZATION_ID,
      executionId: EXECUTION_ID,
      generation: GENERATION_ID,
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
      confirmationVersion: 'openspell.campaign-creation.no-delete-rollback.v1',
      approvedBy: '00000000-0000-4000-8000-000000000009',
      approvedAt: '2026-08-30T00:01:30.000Z',
      gateSnapshotDigest: sha('d'),
    }).authorizationId).toBe(AUTHORIZATION_ID);
    expect(CampaignCreationAuthorizationReceipt.safeParse({
      authorizationId: AUTHORIZATION_ID,
      executionId: EXECUTION_ID,
      generation: GENERATION_ID,
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
      confirmationVersion: 'openspell.campaign-creation.no-delete-rollback.v1',
      approvedBy: '00000000-0000-4000-8000-000000000009',
      approvedAt: plan.expiresAt,
      gateSnapshotDigest: sha('d'),
    }).success).toBe(false);
    expect(ApproveCampaignCreationPlan.safeParse({
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      orgId: plan.orgId,
      profileId: plan.profileId,
    }).success).toBe(false);
  });

  it('joins the exact frozen plan, receipt, job, generation, and call intent at runtime', () => {
    const plan = fingerprintedSpPlan();
    const authorization = {
      authorizationId: AUTHORIZATION_ID,
      executionId: EXECUTION_ID,
      generation: GENERATION_ID,
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
      confirmationVersion: 'openspell.campaign-creation.no-delete-rollback.v1',
      approvedBy: '00000000-0000-4000-8000-000000000009',
      approvedAt: '2026-08-30T00:01:15.000Z',
      gateSnapshotDigest: sha('d'),
    } as const;
    const job = {
      type: 'campaign_creation.dispatch',
      orgId: plan.orgId,
      profileId: plan.profileId,
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      executionId: EXECUTION_ID,
      authorizationId: AUTHORIZATION_ID,
      generation: GENERATION_ID,
    } as const;
    const node = plan.nodes.find((candidate) => candidate.effect === 'irreversible_create');
    if (node === undefined) throw new Error('synthetic create node missing');
    const intent = {
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      executionId: EXECUTION_ID,
      authorizationId: AUTHORIZATION_ID,
      generation: GENERATION_ID,
      attemptId: ATTEMPT_ID,
      providerCallId: CALL_ID,
      requestDigest: sha('e'),
      positions: [{
        requestIndex: 0,
        nodeId: node.nodeId,
        nodeFingerprint: node.fingerprint,
        requestDigest: sha('f'),
      }],
      recordedAt: '2026-08-30T00:02:01.500Z',
    } as const;
    const completed = completedSpExecutionEvidence(plan);
    const currentEvidence = {
      ...completed,
      providerCallIntents: [],
      providerResults: completed.providerResults.filter((result) => result.effect === 'read_check'),
      nonProviderDispositions: plan.nodes
        .filter((candidate) => candidate.effect === 'irreversible_create')
        .map((candidate) => ({
          planId: plan.id,
          nodeId: candidate.nodeId,
          executionId: EXECUTION_ID,
          nodeFingerprint: candidate.fingerprint,
          outcome: 'pending_dispatch' as const,
          sanitizedReason: null,
        })),
      observations: [],
      snapshot: {
        status: 'running' as const,
        accounting: {
          operatorApproved: plan.counts.irreversibleCreates,
          pendingDispatch: plan.counts.irreversibleCreates,
          attempted: 0,
          succeeded: 0,
          failed: 0,
          ambiguous: 0,
          refusedAtExecution: 0,
          blockedByDependency: 0,
          observed: 0,
          pendingObservation: 0,
          observationNotFound: 0,
          observationConflict: 0,
          readChecksRequested: plan.counts.readChecks,
          readChecksPending: 0,
          readChecksPassed: plan.counts.readChecks,
          readChecksRefused: 0,
          readChecksFailed: 0,
        },
      },
    };

    expect(verifyCampaignCreationJobArtifacts(
      plan,
      authorization,
      job,
      '2026-08-30T00:03:00.000Z',
      sha256,
    ).authorization.authorizationId).toBe(AUTHORIZATION_ID);
    expect(verifyCampaignCreationProviderCallArtifacts(
      plan,
      authorization,
      job,
      currentEvidence,
      intent,
      '2026-08-30T00:03:00.000Z',
      sha256,
    ).intent.providerCallId).toBe(CALL_ID);

    expect(() => verifyCampaignCreationJobArtifacts(
      plan,
      { ...authorization, planId: GENERATION_ID },
      job,
      '2026-08-30T00:02:00.000Z',
      sha256,
    )).toThrow(/receipt does not match/);
    expect(() => verifyCampaignCreationJobArtifacts(
      plan,
      authorization,
      { ...job, authorizationId: GENERATION_ID },
      '2026-08-30T00:02:00.000Z',
      sha256,
    )).toThrow(/job does not match/);
    expect(() => verifyCampaignCreationJobArtifacts(
      plan,
      authorization,
      { ...job, generation: AUTHORIZATION_ID },
      '2026-08-30T00:02:00.000Z',
      sha256,
    )).toThrow(/job does not match/);
    expect(() => verifyCampaignCreationProviderCallArtifacts(
      plan,
      authorization,
      job,
      currentEvidence,
      { ...intent, generation: AUTHORIZATION_ID },
      '2026-08-30T00:03:00.000Z',
      sha256,
    )).toThrow(/intent does not match/);
    expect(() => verifyCampaignCreationProviderCallArtifacts(
      plan,
      authorization,
      job,
      currentEvidence,
      {
        ...intent,
        positions: [{ ...intent.positions[0], nodeFingerprint: sha('0') }],
      },
      '2026-08-30T00:03:00.000Z',
      sha256,
    )).toThrow(/position does not match/);
    expect(() => verifyCampaignCreationProviderCallArtifacts(
      plan,
      authorization,
      job,
      completed,
      {
        ...intent,
        attemptId: '00000000-0000-4000-8000-000000000090',
        providerCallId: '00000000-0000-4000-8000-000000000091',
        recordedAt: '2026-08-30T00:02:10.000Z',
      },
      '2026-08-30T00:03:00.000Z',
      sha256,
    )).toThrow(/not exclusively pending/);
    expect(() => verifyCampaignCreationProviderCallArtifacts(
      plan,
      { ...authorization, approvedAt: '2026-08-30T00:02:02.000Z' },
      job,
      completed,
      { ...intent, recordedAt: '2026-08-30T00:02:03.000Z' },
      '2026-08-30T00:03:00.000Z',
      sha256,
    )).toThrow(/outside the authority window/);
    const adGroupNode = plan.nodes.find((candidate) => candidate.nodeId === AD_GROUP_NODE_ID);
    if (adGroupNode === undefined) throw new Error('synthetic ad-group node missing');
    const pendingCampaignObservation = completed.observations.find(
      (observation) => observation.nodeId === CAMPAIGN_NODE_ID,
    );
    if (pendingCampaignObservation === undefined) {
      throw new Error('synthetic campaign observation missing');
    }
    const pendingNodeIds = new Set([AD_GROUP_NODE_ID, AD_NODE_ID, TARGET_NODE_ID]);
    const successfulCampaignAwaitingObservation = {
      ...completed,
      providerCallIntents: completed.providerCallIntents.filter((providerIntent) => (
        providerIntent.positions.some((position) => position.nodeId === CAMPAIGN_NODE_ID)
      )),
      providerResults: completed.providerResults.filter((result) => (
        result.nodeId === PRODUCT_NODE_ID || result.nodeId === CAMPAIGN_NODE_ID
      )),
      nonProviderDispositions: plan.nodes
        .filter((candidate) => pendingNodeIds.has(candidate.nodeId))
        .map((candidate) => ({
          planId: plan.id,
          nodeId: candidate.nodeId,
          executionId: EXECUTION_ID,
          nodeFingerprint: candidate.fingerprint,
          outcome: 'pending_dispatch' as const,
          sanitizedReason: null,
        })),
      observations: [{
        ...pendingCampaignObservation,
        observation: 'pending' as const,
        deliveryStatus: 'unknown' as const,
      }],
      snapshot: {
        status: 'running' as const,
        accounting: {
          operatorApproved: 4,
          pendingDispatch: 3,
          attempted: 1,
          succeeded: 1,
          failed: 0,
          ambiguous: 0,
          refusedAtExecution: 0,
          blockedByDependency: 0,
          observed: 0,
          pendingObservation: 1,
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
    expect(CampaignCreationExecutionEvidence.parse(
      successfulCampaignAwaitingObservation,
    ).snapshot.status).toBe('running');
    expect(() => verifyCampaignCreationProviderCallArtifacts(
      plan,
      authorization,
      job,
      successfulCampaignAwaitingObservation,
      {
        ...intent,
        positions: [{
          requestIndex: 0,
          nodeId: adGroupNode.nodeId,
          nodeFingerprint: adGroupNode.fingerprint,
          requestDigest: sha('7'),
        }],
        recordedAt: '2026-08-30T00:02:03.500Z',
      },
      '2026-08-30T00:03:00.000Z',
      sha256,
    )).toThrow(/dependency that is not satisfied/);
    expect(() => verifyCampaignCreationProviderCallArtifacts(
      plan,
      authorization,
      job,
      currentEvidence,
      {
        ...intent,
        positions: [{
          requestIndex: 0,
          nodeId: adGroupNode.nodeId,
          nodeFingerprint: adGroupNode.fingerprint,
          requestDigest: sha('7'),
        }],
      },
      '2026-08-30T00:03:00.000Z',
      sha256,
    )).toThrow(/dependency that is not satisfied/);
    expect(() => verifyCampaignCreationJobArtifacts(
      plan,
      authorization,
      job,
      plan.expiresAt,
      sha256,
    )).toThrow(/expired/);
    const observeJob = { ...job, type: 'campaign_creation.observe', attempt: 1 } as const;
    expect(verifyCampaignCreationJobArtifacts(
      plan,
      { ...authorization },
      observeJob,
      '2026-08-31T00:00:00.000Z',
      sha256,
    ).job.type).toBe('campaign_creation.observe');
    const campaignObservation = completed.observations.find((candidate) => (
      candidate.nodeId === CAMPAIGN_NODE_ID
    ));
    if (campaignObservation === undefined) {
      throw new Error('synthetic campaign observation missing');
    }
    const advancedObservation = {
      ...campaignObservation,
      observedAt: '2026-08-30T00:04:00.000Z',
      sourceSyncJobId: '00000000-0000-4000-8000-000000000093',
    };
    expect(verifyCampaignCreationObservationArtifacts(
      plan,
      authorization,
      observeJob,
      completed,
      advancedObservation,
      '2026-08-31T00:00:00.000Z',
      sha256,
    ).observation.providerEntityId).toBe(campaignObservation.providerEntityId);
    expect(() => verifyCampaignCreationObservationArtifacts(
      plan,
      authorization,
      observeJob,
      completed,
      { ...advancedObservation, providerEntityId: 'UNRELATED-CAMPAIGN' },
      '2026-08-31T00:00:00.000Z',
      sha256,
    )).toThrow(/not exactly correlated/);
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
      requestDigest: sha('c'),
      nodeRequestDigest: sha('d'),
      providerEntityVersion: null,
      providerCode: null,
      sanitizedMessage: null,
      providerRequestId: null,
      responseDigest: sha('e'),
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
    expect(CampaignCreationProviderResult.safeParse({
      ...common,
      effect: 'irreversible_create',
      outcome: 'ambiguous',
      providerEntityId: 'UNCORRELATED-ENTITY',
      responseDigest: null,
    }).success).toBe(false);

    const observation = {
      planId: PLAN_ID,
      nodeId: CAMPAIGN_NODE_ID,
      executionId: EXECUTION_ID,
      authorizationId: AUTHORIZATION_ID,
      generation: GENERATION_ID,
      attemptId: ATTEMPT_ID,
      providerCallId: CALL_ID,
      nodeFingerprint: sha('a'),
      requestDigest: sha('c'),
      nodeRequestDigest: sha('d'),
      basis: 'provider_result_identity',
      providerEntityId: null,
      observation: 'pending',
      amazonModerationStatus: 'not_applicable',
      deliveryStatus: 'unknown',
      observedAt: '2026-08-30T00:03:00.000Z',
      sourceSyncJobId: GENERATION_ID,
    } as const;
    expect(CampaignCreationResourceObservation.safeParse({
      ...observation,
      observation: 'observed',
    }).success).toBe(false);
    expect(CampaignCreationResourceObservation.safeParse({
      ...observation,
      deliveryStatus: 'delivering',
    }).success).toBe(false);
    expect(CampaignCreationResourceObservation.safeParse({
      ...observation,
      basis: 'intent_reconciliation',
      observation: 'observed',
      providerEntityId: 'UNRELATED-CAMPAIGN',
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
    expect(deriveCampaignCreationExecutionStatus(valid)).toBe('awaiting_observation');
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

    const queued = {
      operatorApproved: 4,
      pendingDispatch: 4,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      ambiguous: 0,
      refusedAtExecution: 0,
      blockedByDependency: 0,
      observed: 0,
      pendingObservation: 0,
      observationNotFound: 0,
      observationConflict: 0,
      readChecksRequested: 1,
      readChecksPending: 1,
      readChecksPassed: 0,
      readChecksRefused: 0,
      readChecksFailed: 0,
    };
    expect(deriveCampaignCreationExecutionStatus(queued)).toBe('queued');
    expect(CampaignCreationExecutionSnapshot.safeParse({
      status: 'running',
      accounting: queued,
    }).success).toBe(false);

    const mixedConflict = {
      ...queued,
      pendingDispatch: 0,
      attempted: 2,
      succeeded: 1,
      failed: 1,
      blockedByDependency: 2,
      observationConflict: 1,
      readChecksPending: 0,
      readChecksPassed: 1,
    };
    expect(deriveCampaignCreationExecutionStatus(mixedConflict)).toBe('ambiguous');
    expect(CampaignCreationExecutionSnapshot.safeParse({
      status: 'partial_failed',
      accounting: mixedConflict,
    }).success).toBe(false);

    const terminalBase = {
      ...queued,
      pendingDispatch: 0,
      readChecksPending: 0,
      readChecksPassed: 1,
    };
    expect(deriveCampaignCreationExecutionStatus({
      ...terminalBase,
      refusedAtExecution: 1,
      blockedByDependency: 3,
    })).toBe('refused');
    expect(deriveCampaignCreationExecutionStatus({
      ...terminalBase,
      blockedByDependency: 4,
    })).toBe('blocked');
    expect(deriveCampaignCreationExecutionStatus({
      ...terminalBase,
      attempted: 1,
      failed: 1,
      blockedByDependency: 3,
    })).toBe('failed');
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
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      observations: evidence.observations.map((observation, index) => index === 0
        ? { ...observation, providerCallId: CALL_ID }
        : observation),
    }).success).toBe(false);

    const notFound = {
      ...evidence,
      observations: evidence.observations.map((observation) => observation.nodeId === TARGET_NODE_ID
        ? {
            ...observation,
            providerEntityId: null,
            observation: 'not_found',
            deliveryStatus: 'unknown',
          }
        : observation),
      snapshot: {
        status: 'awaiting_observation',
        accounting: {
          ...evidence.snapshot.accounting,
          observed: 3,
          observationNotFound: 1,
        },
      },
    };
    expect(CampaignCreationExecutionEvidence.parse(notFound).snapshot.accounting.observationNotFound)
      .toBe(1);
    expect(CampaignCreationExecutionEvidence.parse(notFound).snapshot.status)
      .toBe('awaiting_observation');

    expect(CampaignCreationExecutionEvidence.safeParse({
      ...notFound,
      observations: evidence.observations.map((observation) => (
        observation.nodeId === CAMPAIGN_NODE_ID
          ? {
              ...observation,
              providerEntityId: null,
              observation: 'not_found',
              deliveryStatus: 'unknown',
            }
          : observation
      )),
    }).success).toBe(false);
  });

  it('requires write-ahead intent and keeps an unresolved create quarantined', () => {
    const evidence = completedSpExecutionEvidence();
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerCallIntents: evidence.providerCallIntents.filter((intent) => (
        !intent.positions.some((position) => position.nodeId === TARGET_NODE_ID)
      )),
    }).success).toBe(false);
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerCallIntents: evidence.providerCallIntents.map((intent, index) => index === 1
        ? { ...intent, authorizationId: '00000000-0000-4000-8000-000000000092' }
        : intent),
    }).success).toBe(false);
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerResults: evidence.providerResults.map((result) => (
        result.nodeId === TARGET_NODE_ID && result.effect === 'irreversible_create'
          ? { ...result, requestDigest: sha('9') }
          : result
      )),
    }).success).toBe(false);

    const firstIntent = evidence.providerCallIntents[0];
    if (firstIntent === undefined) throw new Error('synthetic provider intent missing');
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerCallIntents: [
        ...evidence.providerCallIntents,
        {
          ...firstIntent,
          attemptId: '00000000-0000-4000-8000-000000000090',
          providerCallId: '00000000-0000-4000-8000-000000000091',
        },
      ],
    }).success).toBe(false);

    const unresolved = {
      ...evidence,
      providerResults: evidence.providerResults.filter((result) => (
        result.nodeId !== TARGET_NODE_ID
      )),
      observations: evidence.observations.map((observation) => (
        observation.nodeId === TARGET_NODE_ID
          ? {
              ...observation,
              providerEntityId: null,
              basis: 'intent_reconciliation' as const,
              observation: 'not_found' as const,
              deliveryStatus: 'unknown' as const,
            }
          : observation
      )),
      snapshot: {
        status: 'awaiting_observation' as const,
        accounting: {
          ...evidence.snapshot.accounting,
          succeeded: 3,
          ambiguous: 1,
          observed: 3,
          observationNotFound: 1,
        },
      },
    };
    expect(CampaignCreationExecutionEvidence.parse(unresolved).snapshot.status)
      .toBe('awaiting_observation');
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...unresolved,
      snapshot: { ...unresolved.snapshot, status: 'partial_failed' },
    }).success).toBe(false);

    const crashAfterIntent = {
      ...unresolved,
      observations: unresolved.observations.filter((observation) => (
        observation.nodeId !== TARGET_NODE_ID
      )),
      snapshot: {
        status: 'awaiting_observation' as const,
        accounting: {
          ...unresolved.snapshot.accounting,
          pendingObservation: 1,
          observationNotFound: 0,
        },
      },
    };
    expect(CampaignCreationExecutionEvidence.parse(crashAfterIntent).snapshot.accounting
      .pendingObservation).toBe(1);

    const successAwaitingFirstObservation = {
      ...evidence,
      observations: evidence.observations.filter((observation) => (
        observation.nodeId !== TARGET_NODE_ID
      )),
      snapshot: {
        status: 'awaiting_observation' as const,
        accounting: {
          ...evidence.snapshot.accounting,
          observed: 3,
          pendingObservation: 1,
        },
      },
    };
    expect(CampaignCreationExecutionEvidence.parse(successAwaitingFirstObservation).snapshot.status)
      .toBe('awaiting_observation');

    const campaignResult = evidence.providerResults.find(
      (result) => result.nodeId === CAMPAIGN_NODE_ID,
    );
    if (campaignResult === undefined) throw new Error('synthetic campaign result missing');
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerCallIntents: evidence.providerCallIntents.map((intent) => (
        intent.positions.some((position) => position.nodeId === CAMPAIGN_NODE_ID)
          ? { ...intent, recordedAt: campaignResult.completedAt }
          : intent
      )),
    }).success).toBe(false);
  });

  it('represents staged running work while a created dependency awaits observation', () => {
    const evidence = completedSpExecutionEvidence();
    const campaignObservation = evidence.observations.find(
      (observation) => observation.nodeId === CAMPAIGN_NODE_ID,
    );
    if (campaignObservation === undefined) throw new Error('synthetic campaign observation missing');
    const pendingNodeIds = new Set([AD_GROUP_NODE_ID, AD_NODE_ID, TARGET_NODE_ID]);
    const staged = {
      ...evidence,
      providerCallIntents: evidence.providerCallIntents.filter((intent) => (
        intent.positions.some((position) => position.nodeId === CAMPAIGN_NODE_ID)
      )),
      providerResults: evidence.providerResults.filter(
        (result) => result.nodeId === PRODUCT_NODE_ID || result.nodeId === CAMPAIGN_NODE_ID,
      ),
      nonProviderDispositions: evidence.plan.nodes
        .filter((node) => pendingNodeIds.has(node.nodeId))
        .map((node) => ({
          planId: evidence.plan.id,
          nodeId: node.nodeId,
          executionId: evidence.executionId,
          nodeFingerprint: node.fingerprint,
          outcome: 'pending_dispatch' as const,
          sanitizedReason: null,
        })),
      observations: [{
        ...campaignObservation,
        observation: 'pending' as const,
        deliveryStatus: 'unknown' as const,
      }],
      snapshot: {
        status: 'running' as const,
        accounting: {
          operatorApproved: 4,
          pendingDispatch: 3,
          attempted: 1,
          succeeded: 1,
          failed: 0,
          ambiguous: 0,
          refusedAtExecution: 0,
          blockedByDependency: 0,
          observed: 0,
          pendingObservation: 1,
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
    expect(CampaignCreationExecutionEvidence.parse(staged).snapshot.status).toBe('running');
    expect(CampaignCreationExecutionSnapshot.safeParse({
      ...staged.snapshot,
      accounting: {
        ...staged.snapshot.accounting,
        pendingDispatch: 0,
        blockedByDependency: 3,
      },
    }).success).toBe(false);
  });

  it('enforces preflight identity, provider-identity uniqueness, and canonical evidence order', () => {
    const evidence = completedSpExecutionEvidence();
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerResults: evidence.providerResults.map((result, index) => index === 0
        ? { ...result, providerEntityId: 'B999999999' }
        : result),
    }).success).toBe(false);
    const sbEvidence = completedSpExecutionEvidence(sbProductVideoPlan());
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...sbEvidence,
      providerResults: sbEvidence.providerResults.map((result) => result.effect === 'read_check'
        && result.providerEntityVersion !== null
        ? { ...result, providerEntityVersion: 'wrong-version' }
        : result),
    }).success).toBe(false);
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerResults: [...evidence.providerResults].reverse(),
    }).success).toBe(false);
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerResults: evidence.providerResults.map((result) => (
        result.nodeId === AD_NODE_ID
          ? { ...result, providerCallId: CALL_ID, requestIndex: 0 }
          : result.nodeId === TARGET_NODE_ID
            ? { ...result, providerCallId: CALL_ID, requestIndex: 2 }
            : result
      )),
    }).success).toBe(false);

    const plan = spPlan();
    const secondTarget = CampaignCreationNode.parse({
      ...plan.nodes.find((node) => node.nodeId === TARGET_NODE_ID),
      nodeId: '00000000-0000-4000-8000-000000000016',
      fingerprint: sha('6'),
    });
    const twoTargetPlan = CampaignCreationPlan.parse({
      ...plan,
      nodes: orderCampaignCreationNodes([...plan.nodes, secondTarget]),
      counts: {
        ...plan.counts,
        totalNodes: 6,
        irreversibleCreates: 5,
        byKind: { ...plan.counts.byKind, 'target.create': 2 },
      },
    });
    const duplicateIdentity = completedSpExecutionEvidence(twoTargetPlan);
    const targetNodeIds = new Set([TARGET_NODE_ID, secondTarget.nodeId]);
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...duplicateIdentity,
      providerResults: duplicateIdentity.providerResults.map((result) => targetNodeIds.has(result.nodeId)
        ? { ...result, providerEntityId: 'TARGET-SAME' }
        : result),
      observations: duplicateIdentity.observations.map((observation) => targetNodeIds.has(observation.nodeId)
        ? { ...observation, providerEntityId: 'TARGET-SAME' }
        : observation),
    }).success).toBe(false);

    const targetIntents = duplicateIdentity.providerCallIntents.filter((intent) => (
      intent.positions.some((position) => targetNodeIds.has(position.nodeId))
    ));
    const firstTargetIntent = targetIntents[0];
    if (firstTargetIntent === undefined || targetIntents.length !== 2) {
      throw new Error('synthetic target call intents missing');
    }
    const batchedRequestDigest = sha('8');
    const batchedPositions = targetIntents.map((intent, requestIndex) => {
      const position = intent.positions[0];
      if (position === undefined) throw new Error('synthetic target call position missing');
      return { ...position, requestIndex };
    });
    const batchedIntent = {
      ...firstTargetIntent,
      requestDigest: batchedRequestDigest,
      positions: batchedPositions,
    };
    const batchedEvidence = {
      ...duplicateIdentity,
      providerCallIntents: [
        ...duplicateIdentity.providerCallIntents.filter((intent) => (
          !intent.positions.some((position) => targetNodeIds.has(position.nodeId))
        )),
        batchedIntent,
      ],
      providerResults: duplicateIdentity.providerResults.map((result) => {
        const requestIndex = batchedPositions.findIndex(
          (position) => position.nodeId === result.nodeId,
        );
        if (requestIndex < 0 || result.effect !== 'irreversible_create') return result;
        const position = batchedPositions[requestIndex];
        if (position === undefined) throw new Error('synthetic batched position missing');
        return {
          ...result,
          attemptId: batchedIntent.attemptId,
          providerCallId: batchedIntent.providerCallId,
          requestIndex,
          requestDigest: batchedRequestDigest,
          nodeRequestDigest: position.requestDigest,
        };
      }),
      observations: duplicateIdentity.observations.map((observation) => {
        const position = batchedPositions.find((candidate) => (
          candidate.nodeId === observation.nodeId
        ));
        if (position === undefined) return observation;
        return {
          ...observation,
          attemptId: batchedIntent.attemptId,
          providerCallId: batchedIntent.providerCallId,
          requestDigest: batchedRequestDigest,
          nodeRequestDigest: position.requestDigest,
        };
      }),
    };
    expect(CampaignCreationExecutionEvidence.parse(batchedEvidence).providerCallIntents.at(-1)
      ?.positions).toHaveLength(2);
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...batchedEvidence,
      providerCallIntents: batchedEvidence.providerCallIntents.map((intent) => (
        intent.providerCallId === batchedIntent.providerCallId
          ? { ...intent, positions: [...intent.positions].reverse() }
          : intent
      )),
    }).success).toBe(false);
  });

  it('enforces execution dependencies and provider/observation chronology', () => {
    const evidence = completedSpExecutionEvidence();
    const campaignResult = evidence.providerResults.find(
      (result) => result.nodeId === CAMPAIGN_NODE_ID,
    );
    if (campaignResult === undefined) throw new Error('synthetic campaign result missing');
    const afterExpiryResults = evidence.providerResults.map((result, index) => ({
      ...result,
      startedAt: `2026-08-30T02:00:${String(index * 2).padStart(2, '0')}.000Z`,
      completedAt: `2026-08-30T02:00:${String(index * 2 + 1).padStart(2, '0')}.000Z`,
    }));
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerResults: afterExpiryResults,
      observations: evidence.observations.map((observation) => ({
        ...observation,
        observedAt: '2026-08-30T02:01:00.000Z',
      })),
    }).success).toBe(false);
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerResults: evidence.providerResults.map((result) => result.nodeId === TARGET_NODE_ID
        ? {
            ...result,
            startedAt: evidence.plan.expiresAt,
            completedAt: '2026-08-30T01:01:01.000Z',
          }
        : result),
      observations: evidence.observations.map((observation) => (
        observation.nodeId === TARGET_NODE_ID
          ? { ...observation, observedAt: '2026-08-30T01:01:02.000Z' }
          : observation
      )),
    }).success).toBe(false);
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerResults: evidence.providerResults.map((result) => result.nodeId === AD_GROUP_NODE_ID
        ? { ...result, startedAt: campaignResult.startedAt }
        : result),
    }).success).toBe(false);
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      observations: evidence.observations.map((observation, index) => index === 0
        ? { ...observation, observedAt: campaignResult.startedAt }
        : observation),
    }).success).toBe(false);

    const failed = failedCampaignExecutionEvidence();
    expect(CampaignCreationExecutionEvidence.parse(failed).snapshot.status).toBe('failed');
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...failed,
      snapshot: { ...failed.snapshot, status: 'partial_failed' },
    }).success).toBe(false);

    const adGroupResult = evidence.providerResults.find(
      (result) => result.nodeId === AD_GROUP_NODE_ID,
    );
    const adGroupObservation = evidence.observations.find(
      (observation) => observation.nodeId === AD_GROUP_NODE_ID,
    );
    if (adGroupResult === undefined || adGroupObservation === undefined) {
      throw new Error('synthetic ad-group evidence missing');
    }
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...failed,
      providerResults: [...failed.providerResults, adGroupResult],
      nonProviderDispositions: failed.nonProviderDispositions.filter(
        (disposition) => disposition.nodeId !== AD_GROUP_NODE_ID,
      ),
      observations: [adGroupObservation],
    }).success).toBe(false);

    const campaignDisposition = {
      planId: failed.plan.id,
      nodeId: CAMPAIGN_NODE_ID,
      executionId: failed.executionId,
      nodeFingerprint: campaignResult.nodeFingerprint,
      outcome: 'blocked_by_dependency',
      sanitizedReason: 'No dependency actually failed.',
    } as const;
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...failed,
      providerResults: failed.providerResults.slice(0, 1),
      nonProviderDispositions: [campaignDisposition, ...failed.nonProviderDispositions],
    }).success).toBe(false);
  });

  it('reserves future creation jobs without making them claimable by current workers', () => {
    const dispatch = {
      type: 'campaign_creation.dispatch',
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      planId: PLAN_ID,
      planFingerprint: sha('a'),
      executionId: EXECUTION_ID,
      authorizationId: AUTHORIZATION_ID,
      generation: GENERATION_ID,
    } as const;
    expect(CampaignCreationJobPayload.parse(dispatch)).toEqual(dispatch);
    expect(JobPayload.safeParse(dispatch).success).toBe(false);
    expect(CampaignCreationJobPayload.safeParse({
      type: 'campaign_creation.observe',
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      planId: PLAN_ID,
      planFingerprint: sha('a'),
      executionId: EXECUTION_ID,
      authorizationId: AUTHORIZATION_ID,
      generation: GENERATION_ID,
      attempt: 8,
    }).success).toBe(false);
  });
});
