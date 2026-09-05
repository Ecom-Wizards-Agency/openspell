/// <reference types="node" />

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as sharedRoot from '@wizard-ads/shared';
import { SpWritePlan as ExportedSpWritePlan } from '@wizard-ads/shared/sp-writes';
import { JobPayload } from './jobs.js';
import {
  ApproveSpWritePlan,
  SpCanonicalDecimal,
  SpCompleteCampaignBiddingState,
  SpWriteAction,
  SpWriteAuthorizationReceipt,
  SpWriteBoundedAuthorization,
  SpWriteExecutionEvidence,
  SpWriteFutureJobPayload,
  SpWriteObservation,
  SpWritePlan,
  SpWritePreDispatchDisposition,
  SpWritePredispatchObservation,
  SpWriteProviderCallIntent,
  SpWriteProviderResult,
  deriveSpWriteExecutionSnapshot,
  orderSpWriteActions,
  serializeSpWriteActionFingerprint,
  serializeSpWriteBoundedAuthorizationFingerprint,
  serializeSpWriteObservationFingerprint,
  serializeSpWritePlanFingerprint,
  serializeSpWritePreDispatchDispositionFingerprint,
  serializeSpWritePredispatchObservationFingerprint,
  serializeSpWriteProviderCallIntentFingerprint,
  serializeSpWriteProviderRequestFingerprint,
  serializeSpWriteProviderResultFingerprint,
  spWritePlanBinding,
  verifySpWriteApprovalArtifacts,
  verifySpWriteAuthorizationReceiptArtifacts,
  verifySpWriteDispatchArtifacts,
  verifySpWriteExecutionEvidence,
  verifySpWriteInversePair,
  verifySpWriteJobArtifacts,
  verifySpWriteObservationArtifacts,
  verifySpWritePlanFingerprints,
  verifySpWriteProviderResultArtifacts,
  type SpWriteAction as SpWriteActionType,
  type SpWriteAuthorizationReceipt as SpWriteAuthorizationReceiptType,
  type SpWriteBoundedAuthorization as SpWriteBoundedAuthorizationType,
  type SpWriteExecutionEvidence as SpWriteExecutionEvidenceType,
  type SpWriteObservation as SpWriteObservationType,
  type SpWritePlan as SpWritePlanType,
  type SpWritePredispatchObservation as SpWritePredispatchObservationType,
  type SpWriteProviderCallIntent as SpWriteProviderCallIntentType,
  type SpWriteProviderResult as SpWriteProviderResultType,
  type SpWriteRouteCounts,
} from './sp-writes.js';

const sha256 = {
  algorithm: 'sha256' as const,
  digest: (value: string): string => createHash('sha256').update(value).digest('hex'),
};
const sha = (character: string): string => character.repeat(64);
const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

const ORG_ID = uuid(1);
const PROFILE_ID = uuid(2);
const CONNECTION_ID = uuid(3);
const PLAN_ID = uuid(4);
const APPROVAL_ID = uuid(5);
const APPROVAL_REQUEST_ID = uuid(6);
const EXECUTION_ID = uuid(7);
const GENERATION_ID = uuid(8);
const ACTOR_ID = uuid(9);
const LEASE_ID = uuid(10);
const CALL_ID = uuid(11);
const INTENT_ID = uuid(12);
const PROVIDER_OBSERVATION_ID = uuid(13);
const RESULT_ID = uuid(14);
const OBSERVATION_ID = uuid(15);
const SYNC_JOB_ID = uuid(16);

const scope = {
  amazonProfileId: 'amazon-profile-synthetic',
  connectionId: CONNECTION_ID,
  region: 'NA' as const,
  marketplaceId: 'MARKETPLACE-SYNTHETIC',
  currencyCode: 'USD',
  apiDialect: 'sp_v3' as const,
};

const expectedBidding = SpCompleteCampaignBiddingState.parse({
  strategy: 'auto_for_sales',
  placements: {
    topOfSearch: 20,
    productPages: 5,
    restOfSearch: 0,
    amazonBusiness: null,
  },
  shopperCohorts: [{
    shopperCohortType: 'synthetic_cohort',
    percentage: 10,
    audienceSegments: [{
      audienceId: 'audience-synthetic',
      audienceSegmentType: 'synthetic_segment',
    }],
  }],
  offAmazonBudgetControlStrategy: 'LIMIT_SYNTHETIC_OFF_AMAZON',
});

const requestedBidding = SpCompleteCampaignBiddingState.parse({
  ...expectedBidding,
  placements: {
    ...expectedBidding.placements,
    topOfSearch: 21,
    productPages: 6,
  },
});

function withActionFingerprint(rawAction: unknown): SpWriteActionType {
  const action = SpWriteAction.parse(rawAction);
  return SpWriteAction.parse({
    ...action,
    fingerprint: sha256.digest(serializeSpWriteActionFingerprint(action)),
  });
}

function routeCounts(actions: readonly SpWriteActionType[]): SpWriteRouteCounts {
  const counts: SpWriteRouteCounts = {
    'sp.v3.campaigns.update': 0,
    'sp.v3.ad_groups.update': 0,
    'sp.v3.keywords.update': 0,
    'sp.v3.targets.update': 0,
    'sp.v3.product_ads.update': 0,
  };
  for (const action of actions) counts[action.routeKey] += 1;
  return counts;
}

function actionEntityId(action: SpWriteActionType): string {
  switch (action.routeKey) {
    case 'sp.v3.campaigns.update': return action.entity.campaignId;
    case 'sp.v3.ad_groups.update': return action.entity.adGroupId;
    case 'sp.v3.keywords.update': return action.entity.keywordId;
    case 'sp.v3.targets.update': return action.entity.targetId;
    case 'sp.v3.product_ads.update': return action.entity.productAdId;
  }
}

function fingerprintedPlan(
  rawActions: readonly unknown[],
  overrides: Partial<SpWritePlanType> = {},
): SpWritePlanType {
  const actions = orderSpWriteActions(rawActions.map(withActionFingerprint));
  const sourceCount = actions.reduce((sum, action) => sum + action.sources.length, 0);
  const plan = SpWritePlan.parse({
    schemaVersion: 'openspell.sp-write-plan.v1',
    id: PLAN_ID,
    orgId: ORG_ID,
    profileId: PROFILE_ID,
    providerScope: scope,
    direction: 'forward',
    source: {
      kind: 'apply_batch',
      applyBatchId: uuid(20),
      guardrailSnapshotFingerprint: sha('a'),
      provenanceSnapshotFingerprint: sha('b'),
    },
    generatedAt: '2026-08-31T08:00:00.000Z',
    frozenAt: '2026-08-31T08:01:00.000Z',
    expiresAt: '2026-08-31T10:00:00.000Z',
    actions,
    counts: {
      logicalChanges: sourceCount,
      providerRows: actions.length,
      uniqueEntities: new Set(actions.map((action) =>
        `${action.routeKey}:${actionEntityId(action)}`)).size,
      byRoute: routeCounts(actions),
    },
    fingerprint: sha('0'),
    ...overrides,
  });
  return SpWritePlan.parse({
    ...plan,
    fingerprint: sha256.digest(serializeSpWritePlanFingerprint(plan)),
  });
}

function fullForwardPlan(): SpWritePlanType {
  return fingerprintedPlan([
    {
      actionId: uuid(101),
      routeKey: 'sp.v3.campaigns.update',
      entity: { campaignId: 'campaign-synthetic' },
      changes: {
        budget: {
          expected: { amount: '10', currencyCode: 'USD' },
          requested: { amount: '11', currencyCode: 'USD' },
        },
        state: { expected: 'enabled', requested: 'paused' },
        placement: {
          expected: expectedBidding,
          requested: requestedBidding,
          approvedPlacementKeys: ['top_of_search', 'product_pages'],
        },
      },
      sources: [
        { kind: 'apply_row', applyRowId: uuid(201), changeKey: 'campaign.budget' },
        { kind: 'apply_row', applyRowId: uuid(204), changeKey: 'campaign.placement.product_pages' },
        { kind: 'apply_row', applyRowId: uuid(203), changeKey: 'campaign.placement.top_of_search' },
        { kind: 'apply_row', applyRowId: uuid(202), changeKey: 'campaign.state' },
      ],
      fingerprint: sha('0'),
    },
    {
      actionId: uuid(102),
      routeKey: 'sp.v3.ad_groups.update',
      entity: { adGroupId: 'ad-group-synthetic' },
      changes: {
        defaultBid: {
          expected: { amount: '1', currencyCode: 'USD' },
          requested: { amount: '1.1', currencyCode: 'USD' },
        },
        state: { expected: 'enabled', requested: 'paused' },
      },
      sources: [
        { kind: 'apply_row', applyRowId: uuid(205), changeKey: 'ad_group.default_bid' },
        { kind: 'apply_row', applyRowId: uuid(206), changeKey: 'ad_group.state' },
      ],
      fingerprint: sha('0'),
    },
    {
      actionId: uuid(103),
      routeKey: 'sp.v3.keywords.update',
      entity: { keywordId: 'keyword-synthetic' },
      changes: {
        bid: {
          expected: { amount: '0.9', currencyCode: 'USD' },
          requested: { amount: '0.95', currencyCode: 'USD' },
        },
        state: { expected: 'enabled', requested: 'paused' },
      },
      sources: [
        { kind: 'apply_row', applyRowId: uuid(207), changeKey: 'keyword.bid' },
        { kind: 'apply_row', applyRowId: uuid(208), changeKey: 'keyword.state' },
      ],
      fingerprint: sha('0'),
    },
    {
      actionId: uuid(104),
      routeKey: 'sp.v3.targets.update',
      entity: { targetId: 'target-synthetic' },
      changes: {
        bid: {
          expected: { amount: '1.2', currencyCode: 'USD' },
          requested: { amount: '1.25', currencyCode: 'USD' },
        },
        state: { expected: 'enabled', requested: 'paused' },
      },
      sources: [
        { kind: 'apply_row', applyRowId: uuid(209), changeKey: 'target.bid' },
        { kind: 'apply_row', applyRowId: uuid(210), changeKey: 'target.state' },
      ],
      fingerprint: sha('0'),
    },
    {
      actionId: uuid(105),
      routeKey: 'sp.v3.product_ads.update',
      entity: { productAdId: 'product-ad-synthetic' },
      changes: { state: { expected: 'enabled', requested: 'paused' } },
      sources: [{ kind: 'apply_row', applyRowId: uuid(211), changeKey: 'product_ad.state' }],
      fingerprint: sha('0'),
    },
  ]);
}

function keywordPlan(): SpWritePlanType {
  return fingerprintedPlan([{
    actionId: uuid(301),
    routeKey: 'sp.v3.keywords.update',
    entity: { keywordId: 'keyword-one' },
    changes: {
      bid: {
        expected: { amount: '0.9', currencyCode: 'USD' },
        requested: { amount: '0.95', currencyCode: 'USD' },
      },
    },
    sources: [{ kind: 'apply_row', applyRowId: uuid(302), changeKey: 'keyword.bid' }],
    fingerprint: sha('0'),
  }]);
}

function inverseKeywordPlan(forward: SpWritePlanType): SpWritePlanType {
  const source = forward.actions[0]!;
  if (source.routeKey !== 'sp.v3.keywords.update' || source.changes.bid === undefined) {
    throw new Error('expected keyword bid source');
  }
  return fingerprintedPlan([{
    actionId: uuid(303),
    routeKey: source.routeKey,
    entity: source.entity,
    changes: {
      bid: {
        expected: source.changes.bid.requested,
        requested: source.changes.bid.expected,
      },
    },
    sources: [{
      kind: 'inverse_action',
      sourceActionId: source.actionId,
      changeKey: 'keyword.bid',
    }],
    fingerprint: sha('0'),
  }], {
    id: uuid(304),
    direction: 'inverse',
    source: {
      kind: 'inverse_execution',
      sourceExecutionId: EXECUTION_ID,
      sourcePlanId: forward.id,
      sourcePlanFingerprint: forward.fingerprint,
    },
    generatedAt: '2026-08-31T08:02:00.000Z',
    frozenAt: '2026-08-31T08:03:00.000Z',
  });
}

function boundedAuthorization(plan: SpWritePlanType): SpWriteBoundedAuthorizationType {
  const action = plan.actions[0]!;
  const base = SpWriteBoundedAuthorization.parse({
    schemaVersion: 'openspell.sp-write-bounded-authorization.v1',
    authorizationId: uuid(401),
    issuedAt: '2026-08-31T07:00:00.000Z',
    expiresAt: '2026-08-31T10:00:00.000Z',
    profiles: [{
      providerScope: plan.providerScope,
      allowedEntities: [{
        routeKey: action.routeKey,
        amazonEntityId: actionEntityId(action),
        allowedChangeKeys: ['keyword.bid'],
        maxAbsoluteMoneyDelta: '0.1',
        maxAbsolutePlacementDelta: null,
      }],
    }],
    constraints: {
      maxLogicalChangesPerPlan: 1,
      maxProviderRowsPerPlan: 1,
      maxConcurrentMutations: 1,
      maxCycles: 1,
      maxExecutions: 2,
      requireCurrentValueMatch: true,
      requireForwardObservationBeforeInverse: true,
      stopOnConflict: true,
      disableAfterCycle: true,
    },
    fingerprint: sha('0'),
  });
  return SpWriteBoundedAuthorization.parse({
    ...base,
    fingerprint: sha256.digest(serializeSpWriteBoundedAuthorizationFingerprint(base)),
  });
}

function manualReceipt(plan: SpWritePlanType): SpWriteAuthorizationReceiptType {
  return SpWriteAuthorizationReceipt.parse({
    schemaVersion: 'openspell.sp-write-authorization-receipt.v1',
    approvalId: APPROVAL_ID,
    approvalRequestId: APPROVAL_REQUEST_ID,
    executionId: EXECUTION_ID,
    generation: GENERATION_ID,
    approvalMode: 'manual',
    plan: spWritePlanBinding(plan),
    preapprovedInversePlan: null,
    boundedAuthorization: null,
    approvedBy: ACTOR_ID,
    approvedAt: '2026-08-31T08:05:00.000Z',
    expiresAt: '2026-08-31T09:55:00.000Z',
    confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
    gateSnapshot: {
      environmentGate: 'enabled',
      environmentGateVersion: uuid(501),
      profileGrantId: uuid(502),
      profileGrantVersion: uuid(503),
      gateSnapshotFingerprint: sha('c'),
      checkedAt: '2026-08-31T08:04:59.000Z',
    },
  });
}

function boundedReceipt(
  forward: SpWritePlanType,
  inverse: SpWritePlanType,
  authorization: SpWriteBoundedAuthorizationType,
): SpWriteAuthorizationReceiptType {
  return SpWriteAuthorizationReceipt.parse({
    ...manualReceipt(forward),
    approvalMode: 'bounded_live_test',
    preapprovedInversePlan: spWritePlanBinding(inverse),
    boundedAuthorization: {
      authorizationId: authorization.authorizationId,
      authorizationFingerprint: authorization.fingerprint,
      expiresAt: authorization.expiresAt,
    },
  });
}

function dispatchJob(plan: SpWritePlanType) {
  return {
    type: 'sp_write.dispatch' as const,
    orgId: plan.orgId,
    profileId: plan.profileId,
    planId: plan.id,
    planFingerprint: plan.fingerprint,
    executionId: EXECUTION_ID,
    approvalId: APPROVAL_ID,
    generation: GENERATION_ID,
  };
}

function observeJob(plan: SpWritePlanType) {
  return {
    ...dispatchJob(plan),
    type: 'sp_write.observe' as const,
    providerCallId: CALL_ID,
    attempt: 0,
  };
}

function expectedKeywordObservation(plan: SpWritePlanType, side: 'expected' | 'requested') {
  const action = plan.actions[0]!;
  if (action.routeKey !== 'sp.v3.keywords.update' || action.changes.bid === undefined) {
    throw new Error('expected keyword bid action');
  }
  return {
    routeKey: action.routeKey,
    actionId: action.actionId,
    actionFingerprint: action.fingerprint,
    amazonEntityId: action.entity.keywordId,
    values: { bid: action.changes.bid[side] },
  } as const;
}

function predispatchObservation(plan: SpWritePlanType): SpWritePredispatchObservationType {
  const base = SpWritePredispatchObservation.parse({
    schemaVersion: 'openspell.sp-write-predispatch-observation.v1',
    observationId: PROVIDER_OBSERVATION_ID,
    planId: plan.id,
    planFingerprint: plan.fingerprint,
    approvalId: APPROVAL_ID,
    executionId: EXECUTION_ID,
    generation: GENERATION_ID,
    routeKey: 'sp.v3.keywords.update',
    observedAt: '2026-08-31T08:10:00.000Z',
    validUntil: '2026-08-31T08:12:00.000Z',
    items: [expectedKeywordObservation(plan, 'expected')],
    fingerprint: sha('0'),
  });
  return SpWritePredispatchObservation.parse({
    ...base,
    fingerprint: sha256.digest(serializeSpWritePredispatchObservationFingerprint(base)),
  });
}

function providerIntent(
  plan: SpWritePlanType,
  providerObservation: SpWritePredispatchObservationType,
): SpWriteProviderCallIntentType {
  const action = plan.actions[0]!;
  const base = SpWriteProviderCallIntent.parse({
    schemaVersion: 'openspell.sp-write-provider-call-intent.v1',
    intentId: INTENT_ID,
    providerCallId: CALL_ID,
    planId: plan.id,
    planFingerprint: plan.fingerprint,
    approvalId: APPROVAL_ID,
    executionId: EXECUTION_ID,
    generation: GENERATION_ID,
    routeKey: action.routeKey,
    attemptNumber: 1,
    dispatchLeaseId: LEASE_ID,
    providerObservationFingerprint: providerObservation.fingerprint,
    requestFingerprint: sha('0'),
    recordedAt: '2026-08-31T08:10:30.000Z',
    positions: [{
      requestIndex: 0,
      actionId: action.actionId,
      actionFingerprint: action.fingerprint,
      amazonEntityId: actionEntityId(action),
      actionRequestFingerprint: sha('d'),
    }],
    fingerprint: sha('0'),
  });
  const requestFingerprint = sha256.digest(serializeSpWriteProviderRequestFingerprint(base));
  const withRequest = SpWriteProviderCallIntent.parse({ ...base, requestFingerprint });
  return SpWriteProviderCallIntent.parse({
    ...withRequest,
    fingerprint: sha256.digest(serializeSpWriteProviderCallIntentFingerprint(withRequest)),
  });
}

function providerResult(
  intent: SpWriteProviderCallIntentType,
  outcome: 'accepted' | 'authoritative_rejected' | 'ambiguous' = 'accepted',
): SpWriteProviderResultType {
  const position = intent.positions[0]!;
  const base = SpWriteProviderResult.parse({
    schemaVersion: 'openspell.sp-write-provider-result.v1',
    resultId: RESULT_ID,
    intentId: intent.intentId,
    intentFingerprint: intent.fingerprint,
    providerCallId: intent.providerCallId,
    requestFingerprint: intent.requestFingerprint,
    completedAt: '2026-08-31T08:11:00.000Z',
    positions: [{
      requestIndex: 0,
      actionId: position.actionId,
      actionFingerprint: position.actionFingerprint,
      actionRequestFingerprint: position.actionRequestFingerprint,
      outcome,
      providerEntityId: outcome === 'accepted' ? position.amazonEntityId : null,
      code: outcome === 'authoritative_rejected' ? 'synthetic_rejection' : null,
      message: null,
    }],
    fingerprint: sha('0'),
  });
  return SpWriteProviderResult.parse({
    ...base,
    fingerprint: sha256.digest(serializeSpWriteProviderResultFingerprint(base)),
  });
}

function postWriteObservation(
  plan: SpWritePlanType,
  intent: SpWriteProviderCallIntentType,
  outcome: 'observed_requested' | 'observed_expected_after_ambiguous' | 'missing' | 'conflict',
): SpWriteObservationType {
  const observed = outcome === 'missing'
    ? null
    : expectedKeywordObservation(
      plan,
      outcome === 'observed_expected_after_ambiguous' ? 'expected' : 'requested',
    );
  const base = SpWriteObservation.parse({
    schemaVersion: 'openspell.sp-write-observation.v1',
    observationId: OBSERVATION_ID,
    planId: plan.id,
    planFingerprint: plan.fingerprint,
    approvalId: APPROVAL_ID,
    executionId: EXECUTION_ID,
    generation: GENERATION_ID,
    intentId: intent.intentId,
    intentFingerprint: intent.fingerprint,
    providerCallId: intent.providerCallId,
    requestFingerprint: intent.requestFingerprint,
    actionId: intent.positions[0]!.actionId,
    actionFingerprint: intent.positions[0]!.actionFingerprint,
    routeKey: intent.routeKey,
    sourceSyncJobId: SYNC_JOB_ID,
    observedAt: '2026-08-31T08:15:00.000Z',
    outcome,
    observed,
    fingerprint: sha('0'),
  });
  return SpWriteObservation.parse({
    ...base,
    fingerprint: sha256.digest(serializeSpWriteObservationFingerprint(base)),
  });
}

function executionEvidence(
  plan: SpWritePlanType,
  authorization: SpWriteAuthorizationReceiptType,
  parts: Partial<Omit<SpWriteExecutionEvidenceType, 'plan' | 'authorization' | 'snapshot'>> = {},
): SpWriteExecutionEvidenceType {
  const base = {
    plan,
    authorization,
    predispatchObservations: [],
    predispatchDispositions: [],
    providerCallIntents: [],
    providerResults: [],
    observations: [],
    ...parts,
  };
  return SpWriteExecutionEvidence.parse({
    ...base,
    snapshot: deriveSpWriteExecutionSnapshot(base),
  });
}

describe('guarded Sponsored Products write contracts', () => {
  it('preserves historical v1 forward, inverse and mixed-route fingerprint bytes', () => {
    const forward = keywordPlan();
    expect([forward.fingerprint, inverseKeywordPlan(forward).fingerprint, fullForwardPlan().fingerprint])
      .toMatchInlineSnapshot(`
        [
          "2609bfe841c35accf4c7410b257a777ebb2589e7c0745f1dc5781a1c86bc56bb",
          "acbf9b122b56e42daef3c1bbf81aef255bb92c0ce22c1536ee616a92dfbab0ba",
          "a027131af3f0bd8baa52b2dbb7fc891afb0ac0c6ff9ce1c206a68dc22b942e8c",
        ]
      `);
  });
  it('exposes write contracts only through the explicit package subpath', () => {
    expect(ExportedSpWritePlan).toBe(SpWritePlan);
    expect('SpWritePlan' in sharedRoot).toBe(false);
  });

  it('binds v2 keyword sequences and inverses while retaining the v1 ordering rule', () => {
    const base = keywordPlan();
    const second = withActionFingerprint({ ...base.actions[0], actionId: uuid(305),
      entity: { keywordId: 'keyword-two' },
      sources: [{ kind: 'apply_row', applyRowId: uuid(306), changeKey: 'keyword.bid' }] });
    const actions = [second, base.actions[0]!];
    const forward = fingerprintedPlan(actions, { schemaVersion: 'openspell.sp-write-plan.v2', actions });
    expect(verifySpWritePlanFingerprints(forward, sha256).actions).toEqual(actions);
    expect(SpWritePlan.safeParse({ ...forward, schemaVersion: 'openspell.sp-write-plan.v1' }).success).toBe(false);
    expect(SpWritePlan.safeParse({ ...fullForwardPlan(), schemaVersion: 'openspell.sp-write-plan.v2' }).success).toBe(false);

    const inverseActions = actions.map((action, index) => {
      if (action.routeKey !== 'sp.v3.keywords.update' || !action.changes.bid) throw new Error('keyword fixture required');
      return withActionFingerprint({ ...action, actionId: uuid(310 + index),
        sources: [{ kind: 'inverse_action', sourceActionId: action.actionId, changeKey: 'keyword.bid' }],
        changes: { bid: { expected: action.changes.bid.requested, requested: action.changes.bid.expected } } });
    });
    const inverse = fingerprintedPlan(inverseActions, { ...inverseKeywordPlan(base),
      schemaVersion: forward.schemaVersion, actions: inverseActions, counts: forward.counts,
      source: { kind: 'inverse_execution', sourceExecutionId: EXECUTION_ID,
        sourcePlanId: forward.id, sourcePlanFingerprint: forward.fingerprint } });
    expect(verifySpWriteInversePair(forward, inverse, sha256)).toEqual({ forward, inverse });
    const reordered = fingerprintedPlan(inverseActions, { ...inverse, actions: [...inverseActions].reverse() });
    expect(() => verifySpWriteInversePair(forward, reordered, sha256)).toThrow('source sequence');
    const downgraded = fingerprintedPlan(inverseActions, { ...inverse,
      schemaVersion: 'openspell.sp-write-plan.v1', actions: orderSpWriteActions(inverseActions) });
    expect(() => verifySpWriteInversePair(forward, downgraded, sha256)).toThrow('scope or counts');
  });

  it('retains database microseconds but compares v2 validity at millisecond resolution', () => {
    const old = keywordPlan();
    const precise = { ...old, generatedAt: old.generatedAt.replace('.000Z', '.000001Z') };
    expect(SpWritePlan.safeParse(precise).success).toBe(true);
    expect(SpWritePlan.safeParse({ ...precise, schemaVersion: 'openspell.sp-write-plan.v2' }).success).toBe(true);
    const excessive = { ...old, generatedAt: old.generatedAt.replace('.000Z', '.0000001Z') };
    expect(SpWritePlan.safeParse(excessive).success).toBe(true);
    expect(SpWritePlan.safeParse({ ...excessive, schemaVersion: 'openspell.sp-write-plan.v2' }).success).toBe(false);
    expect(SpWritePlan.safeParse({ ...old, schemaVersion: 'openspell.sp-write-plan.v2' }).success).toBe(true);
    expect(SpWritePlan.safeParse({ ...old, schemaVersion: 'openspell.sp-write-plan.v2',
      generatedAt: old.frozenAt.replace('.000Z', '.000000Z'), frozenAt: old.frozenAt.replace('.000Z', '.000000Z'),
      expiresAt: old.frozenAt.replace('.000Z', '.000001Z') }).success).toBe(false);
  });

  it('uses canonical exact decimals instead of JavaScript numbers or fixed minor units', () => {
    for (const value of ['0', '1', '1.25', '999999999999.123456']) {
      expect(SpCanonicalDecimal.parse(value)).toBe(value);
    }
    for (const value of [1.25, '01', '1.0', '1.250', '1e2', '-1', '.5', '0.1234567']) {
      expect(SpCanonicalDecimal.safeParse(value).success).toBe(false);
    }
  });

  it('freezes every reversible SP route with exact logical and provider counts', () => {
    const plan = fullForwardPlan();
    expect(verifySpWritePlanFingerprints(plan, sha256)).toEqual(plan);
    expect(plan.counts).toEqual({
      logicalChanges: 11,
      providerRows: 5,
      uniqueEntities: 5,
      byRoute: {
        'sp.v3.campaigns.update': 1,
        'sp.v3.ad_groups.update': 1,
        'sp.v3.keywords.update': 1,
        'sp.v3.targets.update': 1,
        'sp.v3.product_ads.update': 1,
      },
    });
    expect(plan.actions.map((action) => action.routeKey)).toEqual([
      'sp.v3.ad_groups.update',
      'sp.v3.campaigns.update',
      'sp.v3.keywords.update',
      'sp.v3.product_ads.update',
      'sp.v3.targets.update',
    ]);
  });

  it('groups placement changes into one provider row and preserves complete sibling state', () => {
    const campaign = fullForwardPlan().actions.find(
      (action) => action.routeKey === 'sp.v3.campaigns.update',
    );
    expect(campaign?.sources).toHaveLength(4);
    if (campaign?.routeKey !== 'sp.v3.campaigns.update') throw new Error('campaign action missing');
    expect(campaign.changes.placement?.approvedPlacementKeys).toEqual([
      'top_of_search',
      'product_pages',
    ]);
    expect(campaign.changes.placement?.requested.shopperCohorts)
      .toEqual(campaign.changes.placement?.expected.shopperCohorts);

    expect(SpWriteAction.safeParse({
      ...campaign,
      changes: {
        ...campaign.changes,
        placement: {
          ...campaign.changes.placement,
          requested: {
            ...campaign.changes.placement?.requested,
            offAmazonBudgetControlStrategy: 'CHANGED_WITHOUT_APPROVAL',
          },
        },
      },
    }).success).toBe(false);
    expect(SpWriteAction.safeParse({
      ...campaign,
      changes: {
        ...campaign.changes,
        placement: {
          ...campaign.changes.placement,
          approvedPlacementKeys: ['top_of_search'],
        },
      },
    }).success).toBe(false);
  });

  it('rejects noncanonical action order, duplicate route/entity rows, source loss, and currency drift', () => {
    const plan = fullForwardPlan();
    expect(SpWritePlan.safeParse({ ...plan, actions: [...plan.actions].reverse() }).success)
      .toBe(false);
    expect(SpWritePlan.safeParse({
      ...plan,
      actions: orderSpWriteActions([...plan.actions, plan.actions[0]!]),
      counts: { ...plan.counts, providerRows: 6 },
    }).success).toBe(false);
    const keywordIndex = plan.actions.findIndex((action) => action.routeKey === 'sp.v3.keywords.update');
    const missingSource = plan.actions.map((action, index) => index === keywordIndex
      ? SpWriteAction.parse({ ...action, sources: action.sources.slice(0, 1) })
      : action);
    expect(SpWritePlan.safeParse({ ...plan, actions: missingSource }).success).toBe(false);
    const wrongCurrency = plan.actions.map((action) => action.routeKey === 'sp.v3.keywords.update'
      ? SpWriteAction.parse({
        ...action,
        changes: {
          ...action.changes,
          bid: {
            expected: { amount: '0.9', currencyCode: 'EUR' },
            requested: { amount: '0.95', currencyCode: 'EUR' },
          },
        },
      })
      : action);
    expect(SpWritePlan.safeParse({ ...plan, actions: wrongCurrency }).success).toBe(false);
  });

  it('binds every approval field into action and plan fingerprints', () => {
    const plan = keywordPlan();
    expect(() => verifySpWritePlanFingerprints({
      ...plan,
      providerScope: { ...plan.providerScope, marketplaceId: 'OTHER' },
    }, sha256)).toThrow(/fingerprint/i);
    const changedAction = SpWriteAction.parse({
      ...plan.actions[0]!,
      changes: {
        bid: {
          expected: { amount: '0.9', currencyCode: 'USD' },
          requested: { amount: '0.96', currencyCode: 'USD' },
        },
      },
    });
    expect(() => verifySpWritePlanFingerprints({ ...plan, actions: [changedAction] }, sha256))
      .toThrow(/action fingerprint/i);
  });

  it('requires a separately frozen exact inverse with one-to-one action provenance', () => {
    const forward = keywordPlan();
    const inverse = inverseKeywordPlan(forward);
    expect(verifySpWriteInversePair(forward, inverse, sha256)).toEqual({ forward, inverse });
    const action = inverse.actions[0]!;
    if (action.routeKey !== 'sp.v3.keywords.update' || action.changes.bid === undefined) {
      throw new Error('expected inverse keyword');
    }
    const notSwapped = fingerprintedPlan([{
      ...action,
      changes: {
        bid: {
          expected: action.changes.bid.expected,
          requested: { amount: '0.89', currencyCode: 'USD' },
        },
      },
      fingerprint: sha('0'),
    }], {
      id: inverse.id,
      direction: inverse.direction,
      source: inverse.source,
      generatedAt: inverse.generatedAt,
      frozenAt: inverse.frozenAt,
    });
    expect(() => verifySpWriteInversePair(forward, notSwapped, sha256)).toThrow(/exactly swap/i);
  });

  it('keeps manual approval separate from bounded exact-inverse approval', () => {
    const forward = keywordPlan();
    const inverse = inverseKeywordPlan(forward);
    const authorization = boundedAuthorization(forward);
    const manual = ApproveSpWritePlan.parse({
      approvalRequestId: APPROVAL_REQUEST_ID,
      plan: spWritePlanBinding(forward),
      approvalMode: 'manual',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
      boundedAuthorization: null,
      preapprovedInversePlan: null,
    });
    expect(verifySpWriteApprovalArtifacts(
      forward,
      null,
      manual,
      null,
      '2026-08-31T08:05:00.000Z',
      sha256,
    ).inverse).toBeNull();
    expect(() => verifySpWriteApprovalArtifacts(
      forward,
      inverse,
      manual,
      authorization,
      '2026-08-31T08:05:00.000Z',
      sha256,
    )).toThrow(/manual/i);

    const bounded = ApproveSpWritePlan.parse({
      ...manual,
      approvalMode: 'bounded_live_test',
      boundedAuthorization: {
        authorizationId: authorization.authorizationId,
        authorizationFingerprint: authorization.fingerprint,
        expiresAt: authorization.expiresAt,
      },
      preapprovedInversePlan: spWritePlanBinding(inverse),
    });
    expect(verifySpWriteApprovalArtifacts(
      forward,
      inverse,
      bounded,
      authorization,
      '2026-08-31T08:05:00.000Z',
      sha256,
    )).toMatchObject({ plan: forward, inverse, boundedAuthorization: authorization });
  });

  it('enforces exact bounded scope, entity, change, delta, expiry, and fail-closed constraints', () => {
    const forward = keywordPlan();
    const inverse = inverseKeywordPlan(forward);
    const authorization = boundedAuthorization(forward);
    const request = ApproveSpWritePlan.parse({
      approvalRequestId: APPROVAL_REQUEST_ID,
      plan: spWritePlanBinding(forward),
      approvalMode: 'bounded_live_test',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
      boundedAuthorization: {
        authorizationId: authorization.authorizationId,
        authorizationFingerprint: authorization.fingerprint,
        expiresAt: authorization.expiresAt,
      },
      preapprovedInversePlan: spWritePlanBinding(inverse),
    });
    const tooSmallBase = SpWriteBoundedAuthorization.parse({
      ...authorization,
      profiles: [{
        ...authorization.profiles[0]!,
        allowedEntities: [{
          ...authorization.profiles[0]!.allowedEntities[0]!,
          maxAbsoluteMoneyDelta: '0.01',
        }],
      }],
      fingerprint: sha('0'),
    });
    const tooSmall = SpWriteBoundedAuthorization.parse({
      ...tooSmallBase,
      fingerprint: sha256.digest(serializeSpWriteBoundedAuthorizationFingerprint(tooSmallBase)),
    });
    const smallRequest = ApproveSpWritePlan.parse({
      ...request,
      boundedAuthorization: {
        authorizationId: tooSmall.authorizationId,
        authorizationFingerprint: tooSmall.fingerprint,
        expiresAt: tooSmall.expiresAt,
      },
    });
    expect(() => verifySpWriteApprovalArtifacts(
      forward,
      inverse,
      smallRequest,
      tooSmall,
      '2026-08-31T08:05:00.000Z',
      sha256,
    )).toThrow(/delta/i);
    expect(SpWriteBoundedAuthorization.safeParse({
      ...authorization,
      constraints: { ...authorization.constraints, maxConcurrentMutations: 2 },
    }).success).toBe(false);
    expect(() => verifySpWriteApprovalArtifacts(
      forward,
      inverse,
      request,
      authorization,
      '2026-08-31T10:00:00.000Z',
      sha256,
    )).toThrow(/expired/i);
  });

  it('does not accept actor, approval time, gate, generation, or lease from approval JSON', () => {
    const plan = keywordPlan();
    const request = {
      approvalRequestId: APPROVAL_REQUEST_ID,
      plan: spWritePlanBinding(plan),
      approvalMode: 'manual',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
      boundedAuthorization: null,
      preapprovedInversePlan: null,
    };
    for (const extra of [
      { approvedBy: ACTOR_ID },
      { approvedAt: '2026-08-31T08:05:00.000Z' },
      { generation: GENERATION_ID },
      { dispatchLeaseId: LEASE_ID },
      { environmentGate: 'enabled' },
    ]) {
      expect(ApproveSpWritePlan.safeParse({ ...request, ...extra }).success).toBe(false);
    }
  });

  it('makes receipt authority DB-issued, time-bounded, and mode-consistent', () => {
    const plan = keywordPlan();
    const receipt = manualReceipt(plan);
    expect(receipt.approvedBy).toBe(ACTOR_ID);
    expect(SpWriteAuthorizationReceipt.safeParse({
      ...receipt,
      approvalMode: 'bounded_live_test',
    }).success).toBe(false);
    expect(SpWriteAuthorizationReceipt.safeParse({
      ...receipt,
      expiresAt: '2026-08-31T10:01:00.000Z',
    }).success).toBe(false);
  });

  it('binds a DB-issued receipt to the exact approval request and bounded artifacts', () => {
    const forward = keywordPlan();
    const inverse = inverseKeywordPlan(forward);
    const authorization = boundedAuthorization(forward);
    const request = ApproveSpWritePlan.parse({
      approvalRequestId: APPROVAL_REQUEST_ID,
      plan: spWritePlanBinding(forward),
      approvalMode: 'bounded_live_test',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
      boundedAuthorization: {
        authorizationId: authorization.authorizationId,
        authorizationFingerprint: authorization.fingerprint,
        expiresAt: authorization.expiresAt,
      },
      preapprovedInversePlan: spWritePlanBinding(inverse),
    });
    const receipt = boundedReceipt(forward, inverse, authorization);

    expect(verifySpWriteAuthorizationReceiptArtifacts(
      forward,
      inverse,
      request,
      authorization,
      receipt,
      '2026-08-31T08:06:00.000Z',
      sha256,
    )).toMatchObject({ plan: forward, inverse, request, boundedAuthorization: authorization, receipt });
    expect(() => verifySpWriteAuthorizationReceiptArtifacts(
      forward,
      inverse,
      request,
      authorization,
      { ...receipt, approvalRequestId: uuid(998) },
      '2026-08-31T08:06:00.000Z',
      sha256,
    )).toThrow(/does not match/i);
  });

  it('reserves future job shapes without making current workers able to claim them', () => {
    const plan = keywordPlan();
    const dispatch = dispatchJob(plan);
    const observe = observeJob(plan);
    expect(SpWriteFutureJobPayload.parse(dispatch)).toEqual(dispatch);
    expect(SpWriteFutureJobPayload.parse(observe)).toEqual(observe);
    expect(JobPayload.safeParse(dispatch).success).toBe(false);
    expect(JobPayload.safeParse(observe).success).toBe(false);
  });

  it('joins plan, receipt, job, generation, and expiry before dispatch work', () => {
    const plan = keywordPlan();
    const receipt = manualReceipt(plan);
    const job = dispatchJob(plan);
    expect(verifySpWriteJobArtifacts(
      plan,
      receipt,
      job,
      '2026-08-31T08:10:00.000Z',
      sha256,
    )).toMatchObject({ plan, authorization: receipt, job });
    expect(() => verifySpWriteJobArtifacts(
      plan,
      receipt,
      { ...job, generation: uuid(999) },
      '2026-08-31T08:10:00.000Z',
      sha256,
    )).toThrow(/do not match/i);
    expect(() => verifySpWriteJobArtifacts(
      plan,
      receipt,
      job,
      '2026-08-31T09:55:00.000Z',
      sha256,
    )).toThrow(/expired/i);
    expect(verifySpWriteJobArtifacts(
      plan,
      receipt,
      observeJob(plan),
      '2026-08-31T10:01:00.000Z',
      sha256,
    ).job.type).toBe('sp_write.observe');
  });

  it('requires a fresh direct observation that exactly reproduces planned expected state', () => {
    const plan = keywordPlan();
    const receipt = manualReceipt(plan);
    const providerObservation = predispatchObservation(plan);
    const intent = providerIntent(plan, providerObservation);
    const evidence = executionEvidence(plan, receipt);
    expect(verifySpWriteDispatchArtifacts(
      plan,
      receipt,
      dispatchJob(plan),
      evidence,
      null,
      providerObservation,
      intent,
      '2026-08-31T08:11:00.000Z',
      sha256,
    ).intent).toEqual(intent);

    const staleBase = SpWritePredispatchObservation.parse({
      ...providerObservation,
      items: [expectedKeywordObservation(plan, 'requested')],
      fingerprint: sha('0'),
    });
    const stale = SpWritePredispatchObservation.parse({
      ...staleBase,
      fingerprint: sha256.digest(serializeSpWritePredispatchObservationFingerprint(staleBase)),
    });
    const staleIntent = providerIntent(plan, stale);
    expect(() => verifySpWriteDispatchArtifacts(
      plan,
      receipt,
      dispatchJob(plan),
      evidence,
      null,
      stale,
      staleIntent,
      '2026-08-31T08:11:00.000Z',
      sha256,
    )).toThrow(/expected plan values/i);
    expect(() => verifySpWriteDispatchArtifacts(
      plan,
      receipt,
      dispatchJob(plan),
      evidence,
      null,
      providerObservation,
      intent,
      '2026-08-31T08:13:00.000Z',
      sha256,
    )).toThrow(/stale/i);
    expect(SpWritePredispatchObservation.safeParse({
      ...providerObservation,
      validUntil: '2026-08-31T08:13:00.000Z',
    }).success).toBe(false);
  });

  it('dispatches an exact inverse only after the source execution is fully observed', () => {
    const forward = keywordPlan();
    const inverse = inverseKeywordPlan(forward);
    const authorization = boundedAuthorization(forward);
    const receipt = boundedReceipt(forward, inverse, authorization);
    const forwardProviderObservation = predispatchObservation(forward);
    const forwardIntent = providerIntent(forward, forwardProviderObservation);
    const forwardResult = providerResult(forwardIntent);
    const forwardObservation = postWriteObservation(
      forward,
      forwardIntent,
      'observed_requested',
    );
    const sourceEvidence = executionEvidence(forward, receipt, {
      predispatchObservations: [forwardProviderObservation],
      providerCallIntents: [forwardIntent],
      providerResults: [forwardResult],
      observations: [forwardObservation],
    });
    const inverseProviderObservation = predispatchObservation(inverse);
    const inverseIntent = providerIntent(inverse, inverseProviderObservation);

    expect(sourceEvidence.snapshot.status).toBe('succeeded');
    expect(verifySpWriteDispatchArtifacts(
      inverse,
      receipt,
      dispatchJob(inverse),
      executionEvidence(inverse, receipt),
      sourceEvidence,
      inverseProviderObservation,
      inverseIntent,
      '2026-08-31T08:11:00.000Z',
      sha256,
    ).sourceExecutionEvidence).toEqual(sourceEvidence);

    const unobservedSource = executionEvidence(forward, receipt, {
      predispatchObservations: [forwardProviderObservation],
      providerCallIntents: [forwardIntent],
      providerResults: [forwardResult],
    });
    expect(() => verifySpWriteDispatchArtifacts(
      inverse,
      receipt,
      dispatchJob(inverse),
      executionEvidence(inverse, receipt),
      unobservedSource,
      inverseProviderObservation,
      inverseIntent,
      '2026-08-31T08:11:00.000Z',
      sha256,
    )).toThrow(/not completely observed/i);
  });

  it('binds one-route zero-based positions and prevents any redispatch after intent', () => {
    const plan = keywordPlan();
    const receipt = manualReceipt(plan);
    const providerObservation = predispatchObservation(plan);
    const intent = providerIntent(plan, providerObservation);
    expect(SpWriteProviderCallIntent.safeParse({
      ...intent,
      positions: [{ ...intent.positions[0]!, requestIndex: 1 }],
    }).success).toBe(false);
    const committed = executionEvidence(plan, receipt, {
      predispatchObservations: [providerObservation],
      providerCallIntents: [intent],
    });
    expect(committed.snapshot).toMatchObject({
      status: 'awaiting_observation',
      accounting: { providerAmbiguous: 1, pendingObservation: 1 },
    });
    expect(() => verifySpWriteDispatchArtifacts(
      plan,
      receipt,
      dispatchJob(plan),
      committed,
      null,
      providerObservation,
      intent,
      '2026-08-31T08:11:00.000Z',
      sha256,
    )).toThrow(/already has/i);
  });

  it('requires provider results to account for every exact intent position', () => {
    const plan = keywordPlan();
    const receipt = manualReceipt(plan);
    const providerObservation = predispatchObservation(plan);
    const intent = providerIntent(plan, providerObservation);
    const committed = executionEvidence(plan, receipt, {
      predispatchObservations: [providerObservation],
      providerCallIntents: [intent],
    });
    const result = providerResult(intent);
    expect(verifySpWriteProviderResultArtifacts(
      plan,
      receipt,
      committed,
      result,
      '2026-08-31T08:12:00.000Z',
      sha256,
    ).result).toEqual(result);
    expect(SpWriteProviderResult.safeParse({ ...result, positions: [] }).success).toBe(false);
    expect(SpWriteProviderResult.safeParse({
      ...result,
      positions: [{ ...result.positions[0]!, providerEntityId: 'different-entity' }],
    }).success).toBe(true);
    const wrongEntityBase = SpWriteProviderResult.parse({
      ...result,
      positions: [{ ...result.positions[0]!, providerEntityId: 'different-entity' }],
      fingerprint: sha('0'),
    });
    const wrongEntity = SpWriteProviderResult.parse({
      ...wrongEntityBase,
      fingerprint: sha256.digest(serializeSpWriteProviderResultFingerprint(wrongEntityBase)),
    });
    expect(() => verifySpWriteProviderResultArtifacts(
      plan,
      receipt,
      committed,
      wrongEntity,
      '2026-08-31T08:12:00.000Z',
      sha256,
    )).toThrow(/open intent/i);
  });

  it('does not call provider acceptance success before fresh synchronized observation', () => {
    const plan = keywordPlan();
    const receipt = manualReceipt(plan);
    const providerObservation = predispatchObservation(plan);
    const intent = providerIntent(plan, providerObservation);
    const result = providerResult(intent, 'accepted');
    const accepted = executionEvidence(plan, receipt, {
      predispatchObservations: [providerObservation],
      providerCallIntents: [intent],
      providerResults: [result],
    });
    expect(accepted.snapshot.status).toBe('awaiting_observation');
    expect(accepted.snapshot.accounting).toMatchObject({
      providerAccepted: 1,
      observedRequested: 0,
      pendingObservation: 1,
    });
    const observation = postWriteObservation(plan, intent, 'observed_requested');
    const openIntentEvidence = executionEvidence(plan, receipt, {
      predispatchObservations: [providerObservation],
      providerCallIntents: [intent],
    });
    expect(() => verifySpWriteObservationArtifacts(
      plan,
      receipt,
      observeJob(plan),
      openIntentEvidence,
      observation,
      '2026-08-31T08:16:00.000Z',
      sha256,
    )).toThrow(/open observation/i);
    expect(SpWriteExecutionEvidence.safeParse({
      ...openIntentEvidence,
      observations: [observation],
      snapshot: deriveSpWriteExecutionSnapshot({
        ...openIntentEvidence,
        observations: [observation],
      }),
    }).success).toBe(false);
    expect(verifySpWriteObservationArtifacts(
      plan,
      receipt,
      observeJob(plan),
      accepted,
      observation,
      '2026-08-31T08:16:00.000Z',
      sha256,
    ).observation).toEqual(observation);
    expect(verifySpWriteObservationArtifacts(
      plan,
      receipt,
      observeJob(plan),
      accepted,
      observation,
      '2026-08-31T10:01:00.000Z',
      sha256,
    ).observation).toEqual(observation);
    const causalStaleBase = SpWriteObservation.parse({
      ...observation,
      observedAt: '2026-08-31T08:10:45.000Z',
      fingerprint: sha('0'),
    });
    const causalStale = SpWriteObservation.parse({
      ...causalStaleBase,
      fingerprint: sha256.digest(serializeSpWriteObservationFingerprint(causalStaleBase)),
    });
    expect(() => verifySpWriteObservationArtifacts(
      plan,
      receipt,
      observeJob(plan),
      accepted,
      causalStale,
      '2026-08-31T08:16:00.000Z',
      sha256,
    )).toThrow(/open observation/i);
    const completed = executionEvidence(plan, receipt, {
      predispatchObservations: [providerObservation],
      providerCallIntents: [intent],
      providerResults: [result],
      observations: [observation],
    });
    expect(completed.snapshot.status).toBe('succeeded');
    expect(completed.snapshot.accounting.observedRequested).toBe(1);
  });

  it('keeps ambiguous delivery distinct even when the requested state is later observed', () => {
    const plan = keywordPlan();
    const receipt = manualReceipt(plan);
    const providerObservation = predispatchObservation(plan);
    const intent = providerIntent(plan, providerObservation);
    const result = providerResult(intent, 'ambiguous');
    const awaiting = executionEvidence(plan, receipt, {
      predispatchObservations: [providerObservation],
      providerCallIntents: [intent],
      providerResults: [result],
    });
    const observation = postWriteObservation(plan, intent, 'observed_requested');
    const completed = executionEvidence(plan, receipt, {
      ...awaiting,
      observations: [observation],
    });
    expect(completed.snapshot.status).toBe('observed_after_ambiguous');
    expect(completed.snapshot.accounting).toMatchObject({
      providerAccepted: 0,
      providerAmbiguous: 1,
      observedRequested: 1,
    });
  });

  it('treats expected state after ambiguity as unresolved and never as retry authority', () => {
    const plan = keywordPlan();
    const receipt = manualReceipt(plan);
    const providerObservation = predispatchObservation(plan);
    const intent = providerIntent(plan, providerObservation);
    const result = providerResult(intent, 'ambiguous');
    const awaiting = executionEvidence(plan, receipt, {
      predispatchObservations: [providerObservation],
      providerCallIntents: [intent],
      providerResults: [result],
    });
    const observation = postWriteObservation(
      plan,
      intent,
      'observed_expected_after_ambiguous',
    );
    expect(verifySpWriteObservationArtifacts(
      plan,
      receipt,
      observeJob(plan),
      awaiting,
      observation,
      '2026-08-31T08:16:00.000Z',
      sha256,
    ).observation.outcome).toBe('observed_expected_after_ambiguous');
    const unresolved = executionEvidence(plan, receipt, {
      ...awaiting,
      observations: [observation],
    });
    expect(unresolved.snapshot.status).toBe('ambiguous');
    expect(() => verifySpWriteDispatchArtifacts(
      plan,
      receipt,
      dispatchJob(plan),
      unresolved,
      null,
      providerObservation,
      intent,
      '2026-08-31T08:11:00.000Z',
      sha256,
    )).toThrow(/already has/i);
  });

  it('rejects caller-selected accounting, status, mixed receipts, and tampered evidence hashes', () => {
    const plan = keywordPlan();
    const receipt = manualReceipt(plan);
    const queued = executionEvidence(plan, receipt);
    expect(SpWriteExecutionEvidence.safeParse({
      ...queued,
      snapshot: { ...queued.snapshot, status: 'succeeded' },
    }).success).toBe(false);
    expect(SpWriteExecutionEvidence.safeParse({
      ...queued,
      snapshot: {
        ...queued.snapshot,
        accounting: { ...queued.snapshot.accounting, pendingDispatch: 0 },
      },
    }).success).toBe(false);
    expect(() => verifySpWriteExecutionEvidence({
      ...queued,
      plan: { ...plan, fingerprint: sha('f') },
    }, sha256)).toThrow(/fingerprint|does not bind/i);
    expect(() => verifySpWriteJobArtifacts(
      plan,
      { ...receipt, executionId: uuid(998) },
      dispatchJob(plan),
      '2026-08-31T08:10:00.000Z',
      sha256,
    )).toThrow(/do not match/i);
  });

  it('rejects observations attached to rejected, wrong-call, or conflicting action evidence', () => {
    const plan = keywordPlan();
    const receipt = manualReceipt(plan);
    const providerObservation = predispatchObservation(plan);
    const intent = providerIntent(plan, providerObservation);
    const rejected = providerResult(intent, 'authoritative_rejected');
    const evidence = executionEvidence(plan, receipt, {
      predispatchObservations: [providerObservation],
      providerCallIntents: [intent],
      providerResults: [rejected],
    });
    const observation = postWriteObservation(plan, intent, 'observed_requested');
    expect(() => verifySpWriteObservationArtifacts(
      plan,
      receipt,
      observeJob(plan),
      evidence,
      observation,
      '2026-08-31T08:16:00.000Z',
      sha256,
    )).toThrow(/open observation/i);
    expect(() => verifySpWriteObservationArtifacts(
      plan,
      receipt,
      { ...observeJob(plan), providerCallId: uuid(997) },
      evidence,
      observation,
      '2026-08-31T08:16:00.000Z',
      sha256,
    )).toThrow(/open observation/i);
    const wrongCallBase = SpWriteObservation.parse({
      ...observation,
      providerCallId: uuid(997),
      fingerprint: sha('0'),
    });
    const wrongCall = SpWriteObservation.parse({
      ...wrongCallBase,
      fingerprint: sha256.digest(serializeSpWriteObservationFingerprint(wrongCallBase)),
    });
    const acceptedEvidence = executionEvidence(plan, receipt, {
      predispatchObservations: [providerObservation],
      providerCallIntents: [intent],
      providerResults: [providerResult(intent, 'accepted')],
    });
    expect(() => verifySpWriteObservationArtifacts(
      plan,
      receipt,
      observeJob(plan),
      acceptedEvidence,
      wrongCall,
      '2026-08-31T08:16:00.000Z',
      sha256,
    )).toThrow(/open observation/i);
  });

  it('requires stale-state refusal evidence to identify and cover every changed value', () => {
    const plan = keywordPlan();
    const receipt = manualReceipt(plan);
    const providerObservation = predispatchObservation(plan);
    const malformedObservationBase = SpWritePredispatchObservation.parse({
      ...providerObservation,
      items: [{ ...providerObservation.items[0]!, values: { state: 'paused' } }],
      fingerprint: sha('0'),
    });
    const malformedObservation = SpWritePredispatchObservation.parse({
      ...malformedObservationBase,
      fingerprint: sha256.digest(
        serializeSpWritePredispatchObservationFingerprint(malformedObservationBase),
      ),
    });
    const action = plan.actions[0]!;
    const dispositionBase = SpWritePreDispatchDisposition.parse({
      schemaVersion: 'openspell.sp-write-predispatch-disposition.v1',
      dispositionId: uuid(701),
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      approvalId: receipt.approvalId,
      executionId: receipt.executionId,
      generation: receipt.generation,
      actionId: action.actionId,
      actionFingerprint: action.fingerprint,
      recordedAt: '2026-08-31T08:11:00.000Z',
      outcome: 'refused_before_dispatch',
      reason: 'stale_expected_state',
      providerObservationFingerprint: malformedObservation.fingerprint,
      fingerprint: sha('0'),
    });
    const disposition = SpWritePreDispatchDisposition.parse({
      ...dispositionBase,
      fingerprint: sha256.digest(
        serializeSpWritePreDispatchDispositionFingerprint(dispositionBase),
      ),
    });
    expect(SpWriteExecutionEvidence.safeParse({
      ...executionEvidence(plan, receipt),
      predispatchObservations: [malformedObservation],
      predispatchDispositions: [disposition],
      snapshot: deriveSpWriteExecutionSnapshot({
        ...executionEvidence(plan, receipt),
        predispatchObservations: [malformedObservation],
        predispatchDispositions: [disposition],
      }),
    }).success).toBe(false);
  });
});
