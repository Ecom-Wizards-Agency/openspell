import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JobPayload } from '@wizard-ads/shared';
import postgres from 'postgres';
import { getTableName } from 'drizzle-orm';
import { getTableConfig, getViewConfig } from 'drizzle-orm/pg-core';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import {
  ApproveSpWritePlan,
  SpWriteAction,
  SpWriteAuthorizationReceipt,
  SpWriteBoundedAuthorization,
  SpWritePlan,
  SpWritePreDispatchDisposition,
  SpWritePredispatchObservation,
  SpWriteObservation,
  SpWriteProviderCallIntent,
  SpWriteProviderResult,
  deriveSpWriteExecutionSnapshot,
  serializeSpWriteActionFingerprint,
  serializeSpWriteBoundedAuthorizationFingerprint,
  serializeSpWritePlanFingerprint,
  serializeSpWritePreDispatchDispositionFingerprint,
  serializeSpWritePredispatchObservationFingerprint,
  serializeSpWriteObservationFingerprint,
  serializeSpWriteProviderCallIntentFingerprint,
  serializeSpWriteProviderRequestFingerprint,
  serializeSpWriteProviderResultFingerprint,
  spWritePlanBinding,
  verifySpWriteAuthorizationReceiptArtifacts,
  verifySpWriteExecutionEvidence,
  verifySpWriteInversePair,
} from '@wizard-ads/shared/sp-writes';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from './testing/harness.js';
import { asAnon, asServiceRole, asUser } from './testing/rls.js';
import * as dbSchema from './schema/index.js';
import type { TestDatabase, TestDatabaseOptions } from './testing/harness.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WP_187_MIGRATION = '20260901020000_sp_write_persistence_ledger.sql';
const available = await databaseAvailable();
const OWNER_USER_ID = '00000000-0000-4000-8000-000000009001';
const spWriteHasher = {
  algorithm: 'sha256' as const,
  digest: sha256,
};

/**
 * WP-187's canonical evidence suite remains pinned to the migration it proves.
 * Later delivery-protocol migrations have their own upgrade and behavior tests.
 */
function createWp187TestDatabase(
  label: string,
  options: Omit<TestDatabaseOptions, 'throughMigration'> = {},
): Promise<TestDatabase> {
  return createTestDatabase(label, {
    ...options,
    throughMigration: WP_187_MIGRATION,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function reservedResultId(intentId: string): string {
  const preimage = `openspell.sp-write-reserved-result-id.sql.v1\n${intentId.toLowerCase()}`;
  const bytes = createHash('sha256').update(preimage, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

function keywordPlan(
  orgId: string,
  profileId: string,
  connectionId: string,
  amazonProfileId: string,
  planId = uuid(10_001),
) {
  const actionBase = SpWriteAction.parse({
    actionId: uuid(10_002),
    routeKey: 'sp.v3.keywords.update',
    entity: { keywordId: 'kw-1' },
    changes: {
      bid: {
        expected: { amount: '0.9', currencyCode: 'USD' },
        requested: { amount: '0.95', currencyCode: 'USD' },
      },
    },
    sources: [{ kind: 'apply_row', applyRowId: uuid(10_003), changeKey: 'keyword.bid' }],
    fingerprint: '0'.repeat(64),
  });
  const action = SpWriteAction.parse({
    ...actionBase,
    fingerprint: sha256(serializeSpWriteActionFingerprint(actionBase)),
  });
  const planBase = SpWritePlan.parse({
    schemaVersion: 'openspell.sp-write-plan.v1',
    id: planId,
    orgId,
    profileId,
    providerScope: {
      amazonProfileId,
      connectionId,
      region: 'NA',
      marketplaceId: 'synthetic-marketplace',
      currencyCode: 'USD',
      apiDialect: 'sp_v3',
    },
    direction: 'forward',
    source: {
      kind: 'apply_batch',
      applyBatchId: uuid(10_004),
      guardrailSnapshotFingerprint: 'a'.repeat(64),
      provenanceSnapshotFingerprint: 'b'.repeat(64),
    },
    generatedAt: '2026-01-01T00:00:00.000Z',
    frozenAt: '2026-01-01T00:01:00.000Z',
    expiresAt: '2030-01-01T01:00:00.000Z',
    actions: [action],
    counts: {
      logicalChanges: 1,
      providerRows: 1,
      uniqueEntities: 1,
      byRoute: {
        'sp.v3.campaigns.update': 0,
        'sp.v3.ad_groups.update': 0,
        'sp.v3.keywords.update': 1,
        'sp.v3.targets.update': 0,
        'sp.v3.product_ads.update': 0,
      },
    },
    fingerprint: '0'.repeat(64),
  });
  const plan = SpWritePlan.parse({
    ...planBase,
    fingerprint: sha256(serializeSpWritePlanFingerprint(planBase)),
  });
  return {
    action,
    actionPreimage: serializeSpWriteActionFingerprint(action),
    plan,
    planPreimage: serializeSpWritePlanFingerprint(plan),
  };
}

function keywordStatePlan(
  orgId: string,
  profileId: string,
  connectionId: string,
  amazonProfileId: string,
  planId: string,
  seed: number,
) {
  const initial = keywordPlan(orgId, profileId, connectionId, amazonProfileId, planId);
  const actionBase = SpWriteAction.parse({
    ...initial.action,
    actionId: uuid(seed),
    changes: { state: { expected: 'enabled', requested: 'paused' } },
    sources: [{
      kind: 'apply_row',
      applyRowId: uuid(seed + 1),
      changeKey: 'keyword.state',
    }],
    fingerprint: '0'.repeat(64),
  });
  const action = SpWriteAction.parse({
    ...actionBase,
    fingerprint: sha256(serializeSpWriteActionFingerprint(actionBase)),
  });
  const planBase = SpWritePlan.parse({
    ...initial.plan,
    actions: [action],
    fingerprint: '0'.repeat(64),
  });
  const plan = SpWritePlan.parse({
    ...planBase,
    fingerprint: sha256(serializeSpWritePlanFingerprint(planBase)),
  });
  return {
    action,
    actionPreimage: serializeSpWriteActionFingerprint(action),
    plan,
    planPreimage: serializeSpWritePlanFingerprint(plan),
  };
}

function inverseKeywordStatePlan(
  forward: ReturnType<typeof keywordStatePlan>,
  planId: string,
  actionId: string,
  sourceExecutionId: string,
) {
  const source = forward.action;
  if (source.routeKey !== 'sp.v3.keywords.update'
    || source.changes.state === undefined) {
    throw new Error('inverse fixture requires a keyword state action');
  }
  const actionBase = SpWriteAction.parse({
    actionId,
    routeKey: source.routeKey,
    entity: source.entity,
    changes: {
      state: {
        expected: source.changes.state.requested,
        requested: source.changes.state.expected,
      },
    },
    sources: [{
      kind: 'inverse_action',
      sourceActionId: source.actionId,
      changeKey: 'keyword.state',
    }],
    fingerprint: '0'.repeat(64),
  });
  const action = SpWriteAction.parse({
    ...actionBase,
    fingerprint: sha256(serializeSpWriteActionFingerprint(actionBase)),
  });
  const planBase = SpWritePlan.parse({
    ...forward.plan,
    id: planId,
    direction: 'inverse',
    source: {
      kind: 'inverse_execution',
      sourceExecutionId,
      sourcePlanId: forward.plan.id,
      sourcePlanFingerprint: forward.plan.fingerprint,
    },
    generatedAt: '2026-01-01T00:02:00.000Z',
    frozenAt: '2026-01-01T00:03:00.000Z',
    actions: [action],
    fingerprint: '0'.repeat(64),
  });
  const plan = SpWritePlan.parse({
    ...planBase,
    fingerprint: sha256(serializeSpWritePlanFingerprint(planBase)),
  });
  return {
    action,
    actionPreimage: serializeSpWriteActionFingerprint(action),
    plan,
    planPreimage: serializeSpWritePlanFingerprint(plan),
    sourceExecutionId,
  };
}

function campaignPlacementPlan(
  orgId: string,
  profileId: string,
  connectionId: string,
  amazonProfileId: string,
  planId: string,
  seed: number,
) {
  const expected = {
    strategy: 'auto_for_sales' as const,
    placements: {
      topOfSearch: 20,
      productPages: 5,
      restOfSearch: 0,
      amazonBusiness: null,
    },
    shopperCohorts: [],
    offAmazonBudgetControlStrategy: null,
  };
  const requested = {
    ...expected,
    placements: { ...expected.placements, topOfSearch: 25 },
  };
  const actionBase = SpWriteAction.parse({
    actionId: uuid(seed),
    routeKey: 'sp.v3.campaigns.update',
    entity: { campaignId: 'campaign-placement-1' },
    changes: {
      placement: {
        expected,
        requested,
        approvedPlacementKeys: ['top_of_search'],
      },
    },
    sources: [{
      kind: 'apply_row',
      applyRowId: uuid(seed + 1),
      changeKey: 'campaign.placement.top_of_search',
    }],
    fingerprint: '0'.repeat(64),
  });
  const action = SpWriteAction.parse({
    ...actionBase,
    fingerprint: sha256(serializeSpWriteActionFingerprint(actionBase)),
  });
  const planBase = SpWritePlan.parse({
    schemaVersion: 'openspell.sp-write-plan.v1',
    id: planId,
    orgId,
    profileId,
    providerScope: {
      amazonProfileId,
      connectionId,
      region: 'NA',
      marketplaceId: 'synthetic-marketplace',
      currencyCode: 'USD',
      apiDialect: 'sp_v3',
    },
    direction: 'forward',
    source: {
      kind: 'apply_batch',
      applyBatchId: uuid(seed + 2),
      guardrailSnapshotFingerprint: 'c'.repeat(64),
      provenanceSnapshotFingerprint: 'd'.repeat(64),
    },
    generatedAt: '2026-01-01T00:00:00.000Z',
    frozenAt: '2026-01-01T00:01:00.000Z',
    expiresAt: '2030-01-01T01:00:00.000Z',
    actions: [action],
    counts: {
      logicalChanges: 1,
      providerRows: 1,
      uniqueEntities: 1,
      byRoute: {
        'sp.v3.campaigns.update': 1,
        'sp.v3.ad_groups.update': 0,
        'sp.v3.keywords.update': 0,
        'sp.v3.targets.update': 0,
        'sp.v3.product_ads.update': 0,
      },
    },
    fingerprint: '0'.repeat(64),
  });
  const plan = SpWritePlan.parse({
    ...planBase,
    fingerprint: sha256(serializeSpWritePlanFingerprint(planBase)),
  });
  return {
    action,
    actionPreimage: serializeSpWriteActionFingerprint(action),
    plan,
    planPreimage: serializeSpWritePlanFingerprint(plan),
  };
}

function inverseCampaignPlacementPlan(
  forward: ReturnType<typeof campaignPlacementPlan>,
  planId: string,
  actionId: string,
  sourceExecutionId: string,
) {
  const source = forward.action;
  if (source.routeKey !== 'sp.v3.campaigns.update'
    || source.changes.placement === undefined) {
    throw new Error('inverse fixture requires a campaign placement action');
  }
  const actionBase = SpWriteAction.parse({
    actionId,
    routeKey: source.routeKey,
    entity: source.entity,
    changes: {
      placement: {
        expected: source.changes.placement.requested,
        requested: source.changes.placement.expected,
        approvedPlacementKeys: source.changes.placement.approvedPlacementKeys,
      },
    },
    sources: [{
      kind: 'inverse_action',
      sourceActionId: source.actionId,
      changeKey: 'campaign.placement.top_of_search',
    }],
    fingerprint: '0'.repeat(64),
  });
  const action = SpWriteAction.parse({
    ...actionBase,
    fingerprint: sha256(serializeSpWriteActionFingerprint(actionBase)),
  });
  const planBase = SpWritePlan.parse({
    ...forward.plan,
    id: planId,
    direction: 'inverse',
    source: {
      kind: 'inverse_execution',
      sourceExecutionId,
      sourcePlanId: forward.plan.id,
      sourcePlanFingerprint: forward.plan.fingerprint,
    },
    generatedAt: '2026-01-01T00:02:00.000Z',
    frozenAt: '2026-01-01T00:03:00.000Z',
    actions: [action],
    fingerprint: '0'.repeat(64),
  });
  const plan = SpWritePlan.parse({
    ...planBase,
    fingerprint: sha256(serializeSpWritePlanFingerprint(planBase)),
  });
  return {
    action,
    actionPreimage: serializeSpWriteActionFingerprint(action),
    plan,
    planPreimage: serializeSpWritePlanFingerprint(plan),
    sourceExecutionId,
  };
}

function twoKeywordPlan(
  orgId: string,
  profileId: string,
  connectionId: string,
  amazonProfileId: string,
  planId: string,
  seed: number,
) {
  const first = keywordPlan(orgId, profileId, connectionId, amazonProfileId, planId);
  const secondBase = SpWriteAction.parse({
    ...first.action,
    actionId: uuid(seed),
    entity: { keywordId: 'kw-2' },
    sources: [{ kind: 'apply_row', applyRowId: uuid(seed + 1), changeKey: 'keyword.bid' }],
    fingerprint: '0'.repeat(64),
  });
  const second = SpWriteAction.parse({
    ...secondBase,
    fingerprint: sha256(serializeSpWriteActionFingerprint(secondBase)),
  });
  const planBase = SpWritePlan.parse({
    ...first.plan,
    actions: [first.action, second],
    counts: {
      logicalChanges: 2,
      providerRows: 2,
      uniqueEntities: 2,
      byRoute: {
        'sp.v3.campaigns.update': 0,
        'sp.v3.ad_groups.update': 0,
        'sp.v3.keywords.update': 2,
        'sp.v3.targets.update': 0,
        'sp.v3.product_ads.update': 0,
      },
    },
    fingerprint: '0'.repeat(64),
  });
  const plan = SpWritePlan.parse({
    ...planBase,
    fingerprint: sha256(serializeSpWritePlanFingerprint(planBase)),
  });
  return {
    plan,
    planPreimage: serializeSpWritePlanFingerprint(plan),
    actions: [first.action, second] as const,
    actionPreimages: [first.actionPreimage, serializeSpWriteActionFingerprint(second)] as const,
  };
}

function inverseKeywordPlan(
  forward: ReturnType<typeof keywordPlan>,
  planId: string,
  actionId: string,
  sourceExecutionId: string,
  exactSwap = true,
) {
  const source = forward.action;
  if (source.routeKey !== 'sp.v3.keywords.update' || source.changes.bid === undefined) {
    throw new Error('inverse fixture requires a keyword bid action');
  }
  const actionBase = SpWriteAction.parse({
    actionId,
    routeKey: source.routeKey,
    entity: source.entity,
    changes: {
      bid: {
        expected: source.changes.bid.requested,
        requested: exactSwap
          ? source.changes.bid.expected
          : { amount: '0.89', currencyCode: 'USD' },
      },
    },
    sources: [{
      kind: 'inverse_action',
      sourceActionId: source.actionId,
      changeKey: 'keyword.bid',
    }],
    fingerprint: '0'.repeat(64),
  });
  const action = SpWriteAction.parse({
    ...actionBase,
    fingerprint: sha256(serializeSpWriteActionFingerprint(actionBase)),
  });
  const planBase = SpWritePlan.parse({
    ...forward.plan,
    id: planId,
    direction: 'inverse',
    source: {
      kind: 'inverse_execution',
      sourceExecutionId,
      sourcePlanId: forward.plan.id,
      sourcePlanFingerprint: forward.plan.fingerprint,
    },
    generatedAt: '2026-01-01T00:02:00.000Z',
    frozenAt: '2026-01-01T00:03:00.000Z',
    actions: [action],
    fingerprint: '0'.repeat(64),
  });
  const plan = SpWritePlan.parse({
    ...planBase,
    fingerprint: sha256(serializeSpWritePlanFingerprint(planBase)),
  });
  return {
    action,
    actionPreimage: serializeSpWriteActionFingerprint(action),
    plan,
    planPreimage: serializeSpWritePlanFingerprint(plan),
    sourceExecutionId,
  };
}

function inverseTwoKeywordPlan(
  forward: ReturnType<typeof twoKeywordPlan>,
  planId: string,
  sourceExecutionId: string,
  seed: number,
) {
  const actions = forward.actions.map((source, index) => {
    if (source.routeKey !== 'sp.v3.keywords.update' || source.changes.bid === undefined) {
      throw new Error('two-action inverse fixture requires keyword bids');
    }
    const base = SpWriteAction.parse({
      actionId: uuid(seed + index),
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
      fingerprint: '0'.repeat(64),
    });
    return SpWriteAction.parse({
      ...base,
      fingerprint: sha256(serializeSpWriteActionFingerprint(base)),
    });
  });
  const planBase = SpWritePlan.parse({
    ...forward.plan,
    id: planId,
    direction: 'inverse',
    source: {
      kind: 'inverse_execution',
      sourceExecutionId,
      sourcePlanId: forward.plan.id,
      sourcePlanFingerprint: forward.plan.fingerprint,
    },
    generatedAt: '2026-01-01T00:02:00.000Z',
    frozenAt: '2026-01-01T00:03:00.000Z',
    actions,
    fingerprint: '0'.repeat(64),
  });
  const plan = SpWritePlan.parse({
    ...planBase,
    fingerprint: sha256(serializeSpWritePlanFingerprint(planBase)),
  });
  return {
    plan,
    planPreimage: serializeSpWritePlanFingerprint(plan),
    actions,
    actionPreimages: actions.map(serializeSpWriteActionFingerprint),
    sourceExecutionId,
  };
}

function boundedAuthorization(
  plan: ReturnType<typeof keywordPlan>['plan'],
  authorizationId = uuid(10_101),
) {
  const base = SpWriteBoundedAuthorization.parse({
    schemaVersion: 'openspell.sp-write-bounded-authorization.v1',
    authorizationId,
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2030-01-01T01:00:00.000Z',
    profiles: [{
      providerScope: plan.providerScope,
      allowedEntities: [{
        routeKey: 'sp.v3.keywords.update',
        amazonEntityId: 'kw-1',
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
    fingerprint: '0'.repeat(64),
  });
  return SpWriteBoundedAuthorization.parse({
    ...base,
    fingerprint: sha256(serializeSpWriteBoundedAuthorizationFingerprint(base)),
  });
}

function reservationArtifacts(
  proof: ReturnType<typeof keywordPlan>,
  receipt: ReturnType<typeof SpWriteAuthorizationReceipt.parse>,
  leaseId: string,
  observedAt: string,
  validUntil: string,
  seed: number,
  observedSide: 'expected' | 'requested' = 'expected',
) {
  const action = proof.action;
  if (action.routeKey !== 'sp.v3.keywords.update' || action.changes.bid === undefined) {
    throw new Error('reservation fixture requires a keyword bid action');
  }
  const observationBase = SpWritePredispatchObservation.parse({
    schemaVersion: 'openspell.sp-write-predispatch-observation.v1',
    observationId: uuid(seed),
    planId: proof.plan.id,
    planFingerprint: proof.plan.fingerprint,
    approvalId: receipt.approvalId,
    executionId: receipt.executionId,
    generation: receipt.generation,
    routeKey: action.routeKey,
    observedAt,
    validUntil,
    items: [{
      routeKey: action.routeKey,
      actionId: action.actionId,
      actionFingerprint: action.fingerprint,
      amazonEntityId: action.entity.keywordId,
      values: { bid: action.changes.bid![observedSide] },
    }],
    fingerprint: '0'.repeat(64),
  });
  const observation = SpWritePredispatchObservation.parse({
    ...observationBase,
    fingerprint: sha256(serializeSpWritePredispatchObservationFingerprint(observationBase)),
  });
  const intentBase = SpWriteProviderCallIntent.parse({
    schemaVersion: 'openspell.sp-write-provider-call-intent.v1',
    intentId: uuid(seed + 1),
    providerCallId: uuid(seed + 2),
    planId: proof.plan.id,
    planFingerprint: proof.plan.fingerprint,
    approvalId: receipt.approvalId,
    executionId: receipt.executionId,
    generation: receipt.generation,
    routeKey: action.routeKey,
    attemptNumber: 1,
    dispatchLeaseId: leaseId,
    providerObservationFingerprint: observation.fingerprint,
    requestFingerprint: '0'.repeat(64),
    recordedAt: observedAt,
    positions: [{
      requestIndex: 0,
      actionId: action.actionId,
      actionFingerprint: action.fingerprint,
      amazonEntityId: action.entity.keywordId,
      actionRequestFingerprint: 'd'.repeat(64),
    }],
    fingerprint: '0'.repeat(64),
  });
  const requestPreimage = serializeSpWriteProviderRequestFingerprint(intentBase);
  const withRequest = SpWriteProviderCallIntent.parse({
    ...intentBase,
    requestFingerprint: sha256(requestPreimage),
  });
  const intentPreimage = serializeSpWriteProviderCallIntentFingerprint(withRequest);
  const intent = SpWriteProviderCallIntent.parse({
    ...withRequest,
    fingerprint: sha256(intentPreimage),
  });
  return { observation, requestPreimage, intent, intentPreimage };
}

function mixedStaleReservationArtifacts(
  proof: ReturnType<typeof twoKeywordPlan>,
  receipt: ReturnType<typeof SpWriteAuthorizationReceipt.parse>,
  leaseId: string,
  observedAt: string,
  validUntil: string,
  seed: number,
  mode: 'stale' | 'unsupported' | 'stale_and_unsupported' = 'stale',
) {
  const items = proof.actions.map((action, index) => {
    if (action.routeKey !== 'sp.v3.keywords.update' || action.changes.bid === undefined
      || !('keywordId' in action.entity)) {
      throw new Error('mixed stale fixture requires keyword bid actions');
    }
    return {
      routeKey: action.routeKey,
      actionId: action.actionId,
      actionFingerprint: action.fingerprint,
      amazonEntityId: action.entity.keywordId,
      values: index === 0
        ? { bid: mode === 'stale_and_unsupported'
            ? action.changes.bid.requested
            : action.changes.bid.expected }
        : mode === 'stale'
          ? { bid: action.changes.bid.requested }
          : { state: 'enabled' as const },
    };
  });
  const observationBase = SpWritePredispatchObservation.parse({
    schemaVersion: 'openspell.sp-write-predispatch-observation.v1',
    observationId: uuid(seed),
    planId: proof.plan.id,
    planFingerprint: proof.plan.fingerprint,
    approvalId: receipt.approvalId,
    executionId: receipt.executionId,
    generation: receipt.generation,
    routeKey: 'sp.v3.keywords.update',
    observedAt,
    validUntil,
    items,
    fingerprint: '0'.repeat(64),
  });
  const observation = SpWritePredispatchObservation.parse({
    ...observationBase,
    fingerprint: sha256(serializeSpWritePredispatchObservationFingerprint(observationBase)),
  });
  const intentBase = SpWriteProviderCallIntent.parse({
    schemaVersion: 'openspell.sp-write-provider-call-intent.v1',
    intentId: uuid(seed + 1),
    providerCallId: uuid(seed + 2),
    planId: proof.plan.id,
    planFingerprint: proof.plan.fingerprint,
    approvalId: receipt.approvalId,
    executionId: receipt.executionId,
    generation: receipt.generation,
    routeKey: 'sp.v3.keywords.update',
    attemptNumber: 1,
    dispatchLeaseId: leaseId,
    providerObservationFingerprint: observation.fingerprint,
    requestFingerprint: '0'.repeat(64),
    recordedAt: observedAt,
    positions: proof.actions.map((action, requestIndex) => ({
      requestIndex,
      actionId: action.actionId,
      actionFingerprint: action.fingerprint,
      amazonEntityId: items[requestIndex]!.amazonEntityId,
      actionRequestFingerprint: sha256(`mixed-stale-request:${action.actionId}`),
    })),
    fingerprint: '0'.repeat(64),
  });
  const requestPreimage = serializeSpWriteProviderRequestFingerprint(intentBase);
  const requestBound = SpWriteProviderCallIntent.parse({
    ...intentBase,
    requestFingerprint: sha256(requestPreimage),
  });
  const intentPreimage = serializeSpWriteProviderCallIntentFingerprint(requestBound);
  const intent = SpWriteProviderCallIntent.parse({
    ...requestBound,
    fingerprint: sha256(intentPreimage),
  });
  return { observation, requestPreimage, intent, intentPreimage };
}

function multiActionReservationArtifacts(
  proof: ReturnType<typeof twoKeywordPlan>,
  receipt: ReturnType<typeof SpWriteAuthorizationReceipt.parse>,
  leaseId: string,
  observedAt: string,
  validUntil: string,
  seed: number,
) {
  const items = proof.actions.map((action) => {
    if (action.routeKey !== 'sp.v3.keywords.update' || action.changes.bid === undefined
      || !('keywordId' in action.entity)) {
      throw new Error('multi-action reservation fixture requires keyword bid actions');
    }
    return {
      routeKey: action.routeKey,
      actionId: action.actionId,
      actionFingerprint: action.fingerprint,
      amazonEntityId: action.entity.keywordId,
      values: { bid: action.changes.bid.expected },
    };
  });
  const observationBase = SpWritePredispatchObservation.parse({
    schemaVersion: 'openspell.sp-write-predispatch-observation.v1',
    observationId: uuid(seed),
    planId: proof.plan.id,
    planFingerprint: proof.plan.fingerprint,
    approvalId: receipt.approvalId,
    executionId: receipt.executionId,
    generation: receipt.generation,
    routeKey: 'sp.v3.keywords.update',
    observedAt,
    validUntil,
    items,
    fingerprint: '0'.repeat(64),
  });
  const observation = SpWritePredispatchObservation.parse({
    ...observationBase,
    fingerprint: sha256(serializeSpWritePredispatchObservationFingerprint(observationBase)),
  });
  const intentBase = SpWriteProviderCallIntent.parse({
    schemaVersion: 'openspell.sp-write-provider-call-intent.v1',
    intentId: uuid(seed + 1),
    providerCallId: uuid(seed + 2),
    planId: proof.plan.id,
    planFingerprint: proof.plan.fingerprint,
    approvalId: receipt.approvalId,
    executionId: receipt.executionId,
    generation: receipt.generation,
    routeKey: 'sp.v3.keywords.update',
    attemptNumber: 1,
    dispatchLeaseId: leaseId,
    providerObservationFingerprint: observation.fingerprint,
    requestFingerprint: '0'.repeat(64),
    recordedAt: observedAt,
    positions: proof.actions.map((action, requestIndex) => ({
      requestIndex,
      actionId: action.actionId,
      actionFingerprint: action.fingerprint,
      amazonEntityId: items[requestIndex]!.amazonEntityId,
      actionRequestFingerprint: sha256(`multi-action-request:${action.actionId}`),
    })),
    fingerprint: '0'.repeat(64),
  });
  const requestPreimage = serializeSpWriteProviderRequestFingerprint(intentBase);
  const requestBound = SpWriteProviderCallIntent.parse({
    ...intentBase,
    requestFingerprint: sha256(requestPreimage),
  });
  const intentPreimage = serializeSpWriteProviderCallIntentFingerprint(requestBound);
  const intent = SpWriteProviderCallIntent.parse({
    ...requestBound,
    fingerprint: sha256(intentPreimage),
  });
  return { observation, requestPreimage, intent, intentPreimage };
}

function acceptedProviderResult(
  intent: ReturnType<typeof SpWriteProviderCallIntent.parse>,
  resultId: string,
  completedAt: string,
) {
  const position = intent.positions[0]!;
  const base = SpWriteProviderResult.parse({
    schemaVersion: 'openspell.sp-write-provider-result.v1',
    resultId,
    intentId: intent.intentId,
    intentFingerprint: intent.fingerprint,
    providerCallId: intent.providerCallId,
    requestFingerprint: intent.requestFingerprint,
    completedAt,
    positions: [{
      requestIndex: position.requestIndex,
      actionId: position.actionId,
      actionFingerprint: position.actionFingerprint,
      actionRequestFingerprint: position.actionRequestFingerprint,
      outcome: 'accepted',
      providerEntityId: position.amazonEntityId,
      code: null,
      message: null,
    }],
    fingerprint: '0'.repeat(64),
  });
  return SpWriteProviderResult.parse({
    ...base,
    fingerprint: sha256(serializeSpWriteProviderResultFingerprint(base)),
  });
}

function ambiguousProviderResult(
  intent: ReturnType<typeof SpWriteProviderCallIntent.parse>,
  resultId: string,
  completedAt: string,
) {
  const position = intent.positions[0]!;
  const base = SpWriteProviderResult.parse({
    schemaVersion: 'openspell.sp-write-provider-result.v1',
    resultId,
    intentId: intent.intentId,
    intentFingerprint: intent.fingerprint,
    providerCallId: intent.providerCallId,
    requestFingerprint: intent.requestFingerprint,
    completedAt,
    positions: [{
      requestIndex: position.requestIndex,
      actionId: position.actionId,
      actionFingerprint: position.actionFingerprint,
      actionRequestFingerprint: position.actionRequestFingerprint,
      outcome: 'ambiguous',
      providerEntityId: null,
      code: 'attempt_deadline_elapsed',
      message: null,
    }],
    fingerprint: '0'.repeat(64),
  });
  return SpWriteProviderResult.parse({
    ...base,
    fingerprint: sha256(serializeSpWriteProviderResultFingerprint(base)),
  });
}

function providerResultWithOutcomes(
  intent: ReturnType<typeof SpWriteProviderCallIntent.parse>,
  resultId: string,
  completedAt: string,
  outcomes: readonly ('accepted' | 'authoritative_rejected' | 'ambiguous')[],
) {
  if (outcomes.length !== intent.positions.length) {
    throw new Error('provider-result fixture must close every intent position');
  }
  const base = SpWriteProviderResult.parse({
    schemaVersion: 'openspell.sp-write-provider-result.v1',
    resultId,
    intentId: intent.intentId,
    intentFingerprint: intent.fingerprint,
    providerCallId: intent.providerCallId,
    requestFingerprint: intent.requestFingerprint,
    completedAt,
    positions: intent.positions.map((position, index) => {
      const outcome = outcomes[index]!;
      return {
        requestIndex: position.requestIndex,
        actionId: position.actionId,
        actionFingerprint: position.actionFingerprint,
        actionRequestFingerprint: position.actionRequestFingerprint,
        outcome,
        providerEntityId: outcome === 'accepted' ? position.amazonEntityId : null,
        code: outcome === 'authoritative_rejected' ? 'synthetic_rejection'
          : outcome === 'ambiguous' ? 'attempt_deadline_elapsed' : null,
        message: null,
      };
    }),
    fingerprint: '0'.repeat(64),
  });
  return SpWriteProviderResult.parse({
    ...base,
    fingerprint: sha256(serializeSpWriteProviderResultFingerprint(base)),
  });
}

function actionObservation(
  plan: ReturnType<typeof SpWritePlan.parse>,
  action: ReturnType<typeof SpWriteAction.parse>,
  receipt: ReturnType<typeof SpWriteAuthorizationReceipt.parse>,
  intent: ReturnType<typeof SpWriteProviderCallIntent.parse>,
  sourceSyncJobId: string,
  observedAt: string,
  observationId: string,
  outcome: 'observed_requested' | 'observed_expected_after_ambiguous' | 'conflict',
) {
  if (action.routeKey !== 'sp.v3.keywords.update' || action.changes.bid === undefined
    || !('keywordId' in action.entity)) {
    throw new Error('action observation fixture requires a keyword bid action');
  }
  const side = outcome === 'observed_requested' ? 'requested' : 'expected';
  const base = SpWriteObservation.parse({
    schemaVersion: 'openspell.sp-write-observation.v1',
    observationId,
    planId: plan.id,
    planFingerprint: plan.fingerprint,
    approvalId: receipt.approvalId,
    executionId: receipt.executionId,
    generation: receipt.generation,
    intentId: intent.intentId,
    intentFingerprint: intent.fingerprint,
    providerCallId: intent.providerCallId,
    requestFingerprint: intent.requestFingerprint,
    actionId: action.actionId,
    actionFingerprint: action.fingerprint,
    routeKey: action.routeKey,
    sourceSyncJobId,
    observedAt,
    outcome,
    observed: {
      routeKey: action.routeKey,
      actionId: action.actionId,
      actionFingerprint: action.fingerprint,
      amazonEntityId: action.entity.keywordId,
      values: { bid: action.changes.bid[side] },
    },
    fingerprint: '0'.repeat(64),
  });
  return SpWriteObservation.parse({
    ...base,
    fingerprint: sha256(serializeSpWriteObservationFingerprint(base)),
  });
}

function requestedObservation(
  proof: ReturnType<typeof keywordPlan>,
  receipt: ReturnType<typeof SpWriteAuthorizationReceipt.parse>,
  intent: ReturnType<typeof SpWriteProviderCallIntent.parse>,
  sourceSyncJobId: string,
  observedAt: string,
  observationId: string,
) {
  const action = proof.action;
  if (action.routeKey !== 'sp.v3.keywords.update' || action.changes.bid === undefined) {
    throw new Error('observation fixture requires a keyword bid action');
  }
  const base = SpWriteObservation.parse({
    schemaVersion: 'openspell.sp-write-observation.v1',
    observationId,
    planId: proof.plan.id,
    planFingerprint: proof.plan.fingerprint,
    approvalId: receipt.approvalId,
    executionId: receipt.executionId,
    generation: receipt.generation,
    intentId: intent.intentId,
    intentFingerprint: intent.fingerprint,
    providerCallId: intent.providerCallId,
    requestFingerprint: intent.requestFingerprint,
    actionId: action.actionId,
    actionFingerprint: action.fingerprint,
    routeKey: action.routeKey,
    sourceSyncJobId,
    observedAt,
    outcome: 'observed_requested',
    observed: {
      routeKey: action.routeKey,
      actionId: action.actionId,
      actionFingerprint: action.fingerprint,
      amazonEntityId: action.entity.keywordId,
      values: { bid: action.changes.bid.requested },
    },
    fingerprint: '0'.repeat(64),
  });
  return SpWriteObservation.parse({
    ...base,
    fingerprint: sha256(serializeSpWriteObservationFingerprint(base)),
  });
}

function conflictObservation(
  plan: ReturnType<typeof SpWritePlan.parse>,
  action: ReturnType<typeof SpWriteAction.parse>,
  receipt: ReturnType<typeof SpWriteAuthorizationReceipt.parse>,
  intent: ReturnType<typeof SpWriteProviderCallIntent.parse>,
  sourceSyncJobId: string,
  observedAt: string,
  observationId: string,
) {
  if (action.routeKey !== 'sp.v3.keywords.update' || action.changes.bid === undefined
    || !('keywordId' in action.entity)) {
    throw new Error('conflict fixture requires a keyword bid action');
  }
  const base = SpWriteObservation.parse({
    schemaVersion: 'openspell.sp-write-observation.v1',
    observationId,
    planId: plan.id,
    planFingerprint: plan.fingerprint,
    approvalId: receipt.approvalId,
    executionId: receipt.executionId,
    generation: receipt.generation,
    intentId: intent.intentId,
    intentFingerprint: intent.fingerprint,
    providerCallId: intent.providerCallId,
    requestFingerprint: intent.requestFingerprint,
    actionId: action.actionId,
    actionFingerprint: action.fingerprint,
    routeKey: action.routeKey,
    sourceSyncJobId,
    observedAt,
    outcome: 'conflict',
    observed: {
      routeKey: action.routeKey,
      actionId: action.actionId,
      actionFingerprint: action.fingerprint,
      amazonEntityId: action.entity.keywordId,
      values: { bid: action.changes.bid.expected },
    },
    fingerprint: '0'.repeat(64),
  });
  return SpWriteObservation.parse({
    ...base,
    fingerprint: sha256(serializeSpWriteObservationFingerprint(base)),
  });
}

function missingObservation(
  plan: ReturnType<typeof SpWritePlan.parse>,
  action: ReturnType<typeof SpWriteAction.parse>,
  receipt: ReturnType<typeof SpWriteAuthorizationReceipt.parse>,
  intent: ReturnType<typeof SpWriteProviderCallIntent.parse>,
  sourceSyncJobId: string,
  observedAt: string,
  observationId: string,
) {
  const base = SpWriteObservation.parse({
    schemaVersion: 'openspell.sp-write-observation.v1',
    observationId,
    planId: plan.id,
    planFingerprint: plan.fingerprint,
    approvalId: receipt.approvalId,
    executionId: receipt.executionId,
    generation: receipt.generation,
    intentId: intent.intentId,
    intentFingerprint: intent.fingerprint,
    providerCallId: intent.providerCallId,
    requestFingerprint: intent.requestFingerprint,
    actionId: action.actionId,
    actionFingerprint: action.fingerprint,
    routeKey: action.routeKey,
    sourceSyncJobId,
    observedAt,
    outcome: 'missing',
    observed: null,
    fingerprint: '0'.repeat(64),
  });
  return SpWriteObservation.parse({
    ...base,
    fingerprint: sha256(serializeSpWriteObservationFingerprint(base)),
  });
}

interface SpTenant {
  orgId: string;
  profileId: string;
  connectionId: string;
  amazonProfileId: string;
  userId: string;
}

async function enableTestAuthority(database: TestDatabase, tenant: SpTenant, seed: number) {
  await database.sql.begin(async (sql) => {
    await sql`
      insert into public.sp_write_environment_gate_versions
        (version_id, enabled, max_unresolved_calls, created_by)
      values (${uuid(seed)}::uuid, true, 1, ${tenant.userId}::uuid)
    `;
    await sql`
      insert into public.sp_write_environment_gate_head (singleton, version_id)
      values (true, ${uuid(seed)}::uuid)
      on conflict (singleton) do update set version_id = excluded.version_id
    `;
    await sql`
      insert into public.sp_write_profile_grant_versions
        (grant_id, version_id, org_id, profile_id, enabled, amazon_profile_id,
         connection_id, region, marketplace_id, currency_code, api_dialect, created_by)
      values (
        ${uuid(seed + 1)}::uuid, ${uuid(seed + 2)}::uuid,
        ${tenant.orgId}::uuid, ${tenant.profileId}::uuid, true,
        ${tenant.amazonProfileId}, ${tenant.connectionId}::uuid,
        'NA', 'synthetic-marketplace', 'USD', 'sp_v3', ${tenant.userId}::uuid
      )
    `;
    await sql`
      insert into public.sp_write_profile_grant_heads
        (org_id, profile_id, grant_id, version_id)
      values (
        ${tenant.orgId}::uuid, ${tenant.profileId}::uuid,
        ${uuid(seed + 1)}::uuid, ${uuid(seed + 2)}::uuid
      )
      on conflict (org_id, profile_id) do update
        set grant_id = excluded.grant_id, version_id = excluded.version_id
    `;
  });
}

async function prepareManualExecution(
  database: TestDatabase,
  tenant: SpTenant,
  seed: number,
  acquireLease = true,
) {
  const proof = keywordPlan(
    tenant.orgId,
    tenant.profileId,
    tenant.connectionId,
    tenant.amazonProfileId,
    uuid(seed),
  );
  await asServiceRole(database, async (sql) => sql`
    select app.record_sp_write_plan(
      ${JSON.stringify(proof.plan)},
      ${proof.planPreimage},
      ${JSON.stringify([{
        artifactText: JSON.stringify(proof.action),
        fingerprintPreimage: proof.actionPreimage,
      }])}::jsonb
    )
  `);
  const request = ApproveSpWritePlan.parse({
    approvalRequestId: uuid(seed + 1),
    plan: spWritePlanBinding(proof.plan),
    approvalMode: 'manual',
    confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
    boundedAuthorization: null,
    preapprovedInversePlan: null,
  });
  const [approved] = await asUser(database, tenant.userId, async (sql) => sql<{ receipt: unknown }[]>`
    select app.approve_sp_write_cycle(
      ${proof.plan.id}::uuid,
      ${JSON.stringify(request)}
    ) as receipt
  `);
  const receipt = SpWriteAuthorizationReceipt.parse(approved?.receipt);
  await asServiceRole(database, async (sql) => sql`
    select app.start_sp_write_execution(${receipt.approvalId}::uuid, ${proof.plan.id}::uuid)
  `);
  let leaseId = uuid(seed + 2);
  if (acquireLease) {
    const [lease] = await asServiceRole(database, async (sql) => sql<{ lease_id: string }[]>`
      select lease_id::text
        from app.acquire_sp_write_dispatch_lease(
          ${receipt.executionId}::uuid,
          ${proof.plan.id}::uuid,
          ${receipt.generation}::uuid,
          'sp.v3.keywords.update',
          120
        )
    `);
    if (!lease) throw new Error('SP write test lease was not acquired');
    leaseId = lease.lease_id;
  }
  return { proof, receipt, leaseId };
}

async function reserveWinningManualCycle(
  database: TestDatabase,
  tenant: SpTenant,
  seed: number,
) {
  const cycle = await prepareManualExecution(database, tenant, seed);
  const [times] = await database.sql<{ observed_at: string; valid_until: string }[]>`
    select app.sp_write_instant(clock_timestamp()) as observed_at,
           app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
  `;
  if (!times) throw new Error('SP winning reservation timestamps were not derived');
  const artifacts = reservationArtifacts(
    cycle.proof,
    cycle.receipt,
    cycle.leaseId,
    times.observed_at,
    times.valid_until,
    seed + 10,
  );
  const [reservation] = await asServiceRole(database, async (sql) => sql<{
    decision: string;
    result_id: string;
  }[]>`
    select decision, result_id::text
      from app.reserve_sp_write_provider_call(
        ${cycle.receipt.executionId}::uuid,
        ${cycle.proof.plan.id}::uuid,
        ${cycle.receipt.generation}::uuid,
        ${cycle.leaseId}::uuid,
        ${JSON.stringify(artifacts.observation)},
        ${serializeSpWritePredispatchObservationFingerprint(artifacts.observation)},
        ${JSON.stringify(artifacts.intent)},
        ${artifacts.requestPreimage},
        ${artifacts.intentPreimage}
      )
  `);
  if (reservation?.decision !== 'won') {
    throw new Error(`SP winning reservation returned ${reservation?.decision ?? 'no row'}`);
  }
  return { ...cycle, artifacts, resultId: reservation.result_id };
}

async function appendResultAndReadWake(
  database: TestDatabase,
  cycle: Awaited<ReturnType<typeof reserveWinningManualCycle>>,
  outcomes: readonly ('accepted' | 'authoritative_rejected' | 'ambiguous')[],
  origin: 'provider_adapter' | 'recovery_synthesized' = 'provider_adapter',
) {
  const [time] = await database.sql<{ completed_at: string }[]>`
    select app.sp_write_instant(clock_timestamp()) as completed_at
  `;
  if (!time) throw new Error('SP result timestamp was not derived');
  const result = providerResultWithOutcomes(
    cycle.artifacts.intent,
    cycle.resultId,
    time.completed_at,
    outcomes,
  );
  const [appended] = await asServiceRole(database, async (sql) => sql<{ outcome: string }[]>`
    select app.append_sp_write_provider_result(
      ${JSON.stringify(result)},
      ${serializeSpWriteProviderResultFingerprint(result)},
      ${origin}::public.sp_write_result_origin
    ) as outcome
  `);
  expect(appended?.outcome).toBe('recorded');
  const [wake] = await database.sql<{ source_sync_job_id: string; observed_at: string }[]>`
    select source_sync_job_id::text,
           app.sp_write_instant(clock_timestamp()) as observed_at
      from public.sp_write_outbox
     where intent_id = ${cycle.artifacts.intent.intentId}::uuid
       and kind = 'observe_and_recover'
  `;
  if (!wake) throw new Error('SP observation wake was not recorded');
  return { result, wake };
}

async function prepareBoundedExecution(
  database: TestDatabase,
  tenant: SpTenant,
  seed: number,
) {
  const forward = keywordPlan(
    tenant.orgId,
    tenant.profileId,
    tenant.connectionId,
    tenant.amazonProfileId,
    uuid(seed),
  );
  const inverse = inverseKeywordPlan(
    forward,
    uuid(seed + 1),
    uuid(seed + 2),
    uuid(seed + 3),
  );
  const authorization = boundedAuthorization(forward.plan, uuid(seed + 4));
  for (const proof of [forward, inverse]) {
    await asServiceRole(database, async (sql) => sql`
      select app.record_sp_write_plan(
        ${JSON.stringify(proof.plan)},
        ${proof.planPreimage},
        ${JSON.stringify([{
          artifactText: JSON.stringify(proof.action),
          fingerprintPreimage: proof.actionPreimage,
        }])}::jsonb
      )
    `);
  }
  await asServiceRole(database, async (sql) => sql`
    select app.record_sp_write_bounded_authorization(
      ${JSON.stringify(authorization)},
      ${serializeSpWriteBoundedAuthorizationFingerprint(authorization)},
      ${JSON.stringify([{ orgId: tenant.orgId, profileId: tenant.profileId }])}::jsonb
    )
  `);
  const request = ApproveSpWritePlan.parse({
    approvalRequestId: uuid(seed + 5),
    plan: spWritePlanBinding(forward.plan),
    approvalMode: 'bounded_live_test',
    confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
    boundedAuthorization: {
      authorizationId: authorization.authorizationId,
      authorizationFingerprint: authorization.fingerprint,
      expiresAt: authorization.expiresAt,
    },
    preapprovedInversePlan: spWritePlanBinding(inverse.plan),
  });
  const [approved] = await asUser(database, tenant.userId, async (sql) => sql<{
    receipt: unknown;
  }[]>`
    select app.approve_sp_write_cycle(${forward.plan.id}::uuid, ${JSON.stringify(request)})
      as receipt
  `);
  const receipt = SpWriteAuthorizationReceipt.parse(approved?.receipt);
  await asServiceRole(database, async (sql) => sql`
    select app.start_sp_write_execution(${receipt.approvalId}::uuid, ${forward.plan.id}::uuid)
  `);
  const [lease] = await asServiceRole(database, async (sql) => sql<{ lease_id: string }[]>`
    select lease_id::text from app.acquire_sp_write_dispatch_lease(
      ${receipt.executionId}::uuid,
      ${forward.plan.id}::uuid,
      ${receipt.generation}::uuid,
      'sp.v3.keywords.update',
      120
    )
  `);
  if (!lease) throw new Error('SP bounded execution lease was not acquired');
  return { forward, inverse, authorization, request, receipt, leaseId: lease.lease_id };
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && [
      '.git', '.next', '.turbo', 'node_modules', 'coverage', 'dist',
    ].includes(entry.name)) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.(?:ts|tsx|js|mjs|cjs|json|sql|toml|ya?ml|md|sh|service)$/.test(entry.name)
      || /^Dockerfile(?:\.|$)/.test(entry.name)) files.push(path);
  }
  return files;
}

async function expectAccountingMatchesShared(
  database: TestDatabase,
  executionId: string,
  planId: string,
) {
  const [planRow] = await database.sql<{ artifact: unknown }[]>`
    select artifact from public.sp_write_plans where plan_id = ${planId}::uuid
  `;
  const [receiptRow] = await database.sql<{ artifact: unknown }[]>`
    select receipt.artifact
      from public.sp_write_cycle_plans child
      join public.sp_write_authorization_receipts receipt
        on receipt.approval_id = child.approval_id
     where child.execution_id = ${executionId}::uuid and child.plan_id = ${planId}::uuid
  `;
  if (!planRow || !receiptRow) throw new Error('SP accounting evidence header is missing');
  const predispatchObservations = await database.sql<{ artifact: unknown }[]>`
    select artifact from public.sp_write_predispatch_observations
     where execution_id = ${executionId}::uuid and plan_id = ${planId}::uuid
     order by observation_id
  `;
  const predispatchDispositions = await database.sql<{ artifact: unknown }[]>`
    select artifact from public.sp_write_predispatch_dispositions
     where execution_id = ${executionId}::uuid and plan_id = ${planId}::uuid
     order by action_id
  `;
  const providerCallIntents = await database.sql<{ artifact: unknown }[]>`
    select artifact from public.sp_write_provider_call_intents
     where execution_id = ${executionId}::uuid and plan_id = ${planId}::uuid
     order by intent_id
  `;
  const providerResults = await database.sql<{ artifact: unknown }[]>`
    select result.artifact
      from public.sp_write_provider_results result
      join public.sp_write_provider_call_intents intent on intent.intent_id = result.intent_id
     where intent.execution_id = ${executionId}::uuid and intent.plan_id = ${planId}::uuid
     order by result.result_id
  `;
  const observations = await database.sql<{ artifact: unknown }[]>`
    select artifact from public.sp_write_observations
     where execution_id = ${executionId}::uuid and plan_id = ${planId}::uuid
     order by action_id
  `;
  const core = {
    plan: SpWritePlan.parse(planRow.artifact),
    authorization: SpWriteAuthorizationReceipt.parse(receiptRow.artifact),
    predispatchObservations: predispatchObservations.map((row) =>
      SpWritePredispatchObservation.parse(row.artifact)),
    predispatchDispositions: predispatchDispositions.map((row) =>
      SpWritePreDispatchDisposition.parse(row.artifact)),
    providerCallIntents: providerCallIntents.map((row) =>
      SpWriteProviderCallIntent.parse(row.artifact)),
    providerResults: providerResults.map((row) => SpWriteProviderResult.parse(row.artifact)),
    observations: observations.map((row) => SpWriteObservation.parse(row.artifact)),
  };
  const shared = deriveSpWriteExecutionSnapshot(core);
  const [persisted] = await database.sql<{
    approved_rows: number;
    pending_dispatch: number;
    refused_before_dispatch: number;
    intent_committed: number;
    provider_accepted: number;
    provider_rejected: number;
    provider_ambiguous: number;
    observed_requested: number;
    observed_expected_after_ambiguous: number;
    observation_conflict: number;
    observation_missing: number;
    pending_observation: number;
    provider_calls_committed: number;
    provider_calls_completed: number;
    status: string;
  }[]>`
    select approved_rows, pending_dispatch, refused_before_dispatch, intent_committed,
           provider_accepted, provider_rejected, provider_ambiguous,
           observed_requested, observed_expected_after_ambiguous,
           observation_conflict, observation_missing, pending_observation,
           provider_calls_committed, provider_calls_completed, status
      from public.sp_write_execution_accounting
     where execution_id = ${executionId}::uuid and plan_id = ${planId}::uuid
  `;
  expect(persisted).toEqual({
    approved_rows: shared.accounting.approvedRows,
    pending_dispatch: shared.accounting.pendingDispatch,
    refused_before_dispatch: shared.accounting.refusedBeforeDispatch,
    intent_committed: shared.accounting.intentCommitted,
    provider_accepted: shared.accounting.providerAccepted,
    provider_rejected: shared.accounting.providerRejected,
    provider_ambiguous: shared.accounting.providerAmbiguous,
    observed_requested: shared.accounting.observedRequested,
    observed_expected_after_ambiguous: shared.accounting.observedExpectedAfterAmbiguous,
    observation_conflict: shared.accounting.observationConflict,
    observation_missing: shared.accounting.observationMissing,
    pending_observation: shared.accounting.pendingObservation,
    provider_calls_committed: shared.accounting.providerCallsCommitted,
    provider_calls_completed: shared.accounting.providerCallsCompleted,
    status: shared.status,
  });
  return shared;
}

function spWriteDrizzleConfigs() {
  const configs = [];
  for (const candidate of Object.values(dbSchema)) {
    try {
      const config = getTableConfig(candidate as PgTable);
      // This suite is pinned to WP-187. WP-214 proves its later evidence table separately.
      if (config.schema === undefined && config.name.startsWith('sp_write_')
        && config.name !== 'sp_write_preview_evidence') {
        configs.push(config);
      }
    } catch {
      // The schema namespace also exports enums and helpers, which are not tables.
    }
  }
  return configs.sort((left, right) => left.name.localeCompare(right.name));
}

describe('SP write persistence cryptographic identities', () => {
  it('locks the exact gate snapshot SHA-256 golden', () => {
    const preimage = [
      'openspell.sp-write-gate-snapshot.sql.v1',
      'environment=enabled',
      'environment_version=00000000-0000-4000-8000-000000000501',
      'profile_grant_id=00000000-0000-4000-8000-000000000502',
      'profile_grant_version=00000000-0000-4000-8000-000000000503',
      'checked_at=2026-08-31T08:04:59.123456Z',
    ].join('\n');

    expect(preimage.endsWith('\n')).toBe(false);
    expect(sha256(preimage)).toBe(
      '9f03db2ef367a2985d9b74619880da48d6a1dc73f114754acd1a1a296c8e52ce',
    );
  });

  it('locks the exact RFC 9562 UUIDv8 reserved-result golden', () => {
    const intentId = '00000000-0000-4000-8000-000000000901';
    expect(reservedResultId(intentId)).toBe('76e44ab2-7fdc-8b17-bac5-455f311d9af4');
  });
});

describe.skipIf(!available)('SP write persistence installation', () => {
  let database: TestDatabase;
  let tenant: SpTenant;

  beforeAll(async () => {
    database = await createWp187TestDatabase('sp_write_installation');
    const [seed] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture(
        'sp-write-proof',
        ${OWNER_USER_ID}::uuid,
        'owner'
      )
    `;
    const [profile] = await database.sql<{
      id: string;
      connection_id: string;
      amazon_profile_id: string;
    }[]>`
      select id, connection_id, amazon_profile_id
        from public.ad_profiles
       where org_id = ${seed?.seed_tenant_fixture ?? null}::uuid
    `;
    if (!seed || !profile) throw new Error('SP write test tenant was not seeded');
    tenant = {
      orgId: seed.seed_tenant_fixture,
      profileId: profile.id,
      connectionId: profile.connection_id,
      amazonProfileId: profile.amazon_profile_id,
      userId: OWNER_USER_ID,
    };
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('matches the Node gate digest and reserved-result UUID goldens in SQL', async () => {
    const [golden] = await database.sql<{ gate_preimage: string; gate_digest: string; result_id: string }[]>`
      select
        app.sp_write_gate_snapshot_preimage(
          '00000000-0000-4000-8000-000000000501'::uuid,
          '00000000-0000-4000-8000-000000000502'::uuid,
          '00000000-0000-4000-8000-000000000503'::uuid,
          '2026-08-31 08:04:59.123456+00'::timestamptz
        ) as gate_preimage,
        app.sp_write_sha256(app.sp_write_gate_snapshot_preimage(
          '00000000-0000-4000-8000-000000000501'::uuid,
          '00000000-0000-4000-8000-000000000502'::uuid,
          '00000000-0000-4000-8000-000000000503'::uuid,
          '2026-08-31 08:04:59.123456+00'::timestamptz
        )) as gate_digest,
        app.sp_write_reserved_result_id(
          '00000000-0000-4000-8000-000000000901'::uuid
        )::text as result_id
    `;
    const nodePreimage = [
      'openspell.sp-write-gate-snapshot.sql.v1',
      'environment=enabled',
      'environment_version=00000000-0000-4000-8000-000000000501',
      'profile_grant_id=00000000-0000-4000-8000-000000000502',
      'profile_grant_version=00000000-0000-4000-8000-000000000503',
      'checked_at=2026-08-31T08:04:59.123456Z',
    ].join('\n');

    expect(golden).toEqual({
      gate_preimage: nodePreimage,
      gate_digest: sha256(nodePreimage),
      result_id: reservedResultId('00000000-0000-4000-8000-000000000901'),
    });
  });

  it('installs default-off with no authority, execution, or wake', async () => {
    const empty = await createWp187TestDatabase('sp_write_empty', { applyFixture: false });
    try {
      const [counts] = await empty.sql<{
        environment_heads: string;
        profile_heads: string;
        bounded_authorizations: string;
        bounded_consumptions: string;
        execution_cycles: string;
        execution_requests: string;
        outbox_rows: string;
      }[]>`
        select
          (select count(*) from public.sp_write_environment_gate_head)::text as environment_heads,
          (select count(*) from public.sp_write_profile_grant_heads)::text as profile_heads,
          (select count(*) from public.sp_write_bounded_authorizations)::text as bounded_authorizations,
          (select count(*) from public.sp_write_bounded_authorization_consumptions)::text
            as bounded_consumptions,
          (select count(*) from public.sp_write_execution_cycles)::text as execution_cycles,
          (select count(*) from public.sp_write_execution_requests)::text as execution_requests,
          (select count(*) from public.sp_write_outbox)::text as outbox_rows
      `;

      expect(counts).toEqual({
        environment_heads: '0',
        profile_heads: '0',
        bounded_authorizations: '0',
        bounded_consumptions: '0',
        execution_cycles: '0',
        execution_requests: '0',
        outbox_rows: '0',
      });
    } finally {
      await empty.drop();
    }
  }, 60_000);

  it('does not add a current queue enum member', async () => {
    const labels = await database.sql<{ enumlabel: string }[]>`
      select e.enumlabel
        from pg_catalog.pg_enum e
        join pg_catalog.pg_type t on t.oid = e.enumtypid
       where t.typname = 'sync_job_type'
         and e.enumlabel like 'sp\\_write.%' escape '\\'
    `;
    expect(labels).toEqual([]);
  });

  it('installs exactly the inert ledger relations and enum domains', async () => {
    const relations = await database.sql<{ relname: string }[]>`
      select c.relname
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind = 'r'
         and c.relname like 'sp_write_%'
       order by c.relname
    `;
    expect(relations.map((row) => row.relname)).toEqual([
      'sp_write_action_resolutions',
      'sp_write_approval_requests',
      'sp_write_authorization_receipts',
      'sp_write_bounded_authorization_consumptions',
      'sp_write_bounded_authorization_entities',
      'sp_write_bounded_authorization_profiles',
      'sp_write_bounded_authorization_revocations',
      'sp_write_bounded_authorizations',
      'sp_write_cycle_plans',
      'sp_write_dispatch_leases',
      'sp_write_environment_gate_head',
      'sp_write_environment_gate_versions',
      'sp_write_execution_cycles',
      'sp_write_execution_requests',
      'sp_write_late_result_audits',
      'sp_write_observations',
      'sp_write_outbox',
      'sp_write_plan_actions',
      'sp_write_plans',
      'sp_write_predispatch_dispositions',
      'sp_write_predispatch_observation_items',
      'sp_write_predispatch_observations',
      'sp_write_profile_grant_heads',
      'sp_write_profile_grant_versions',
      'sp_write_provider_call_intents',
      'sp_write_provider_call_positions',
      'sp_write_provider_result_positions',
      'sp_write_provider_results',
    ]);

    const enumRows = await database.sql<{ typname: string; labels: string[] }[]>`
      select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as labels
        from pg_catalog.pg_type t
        join pg_catalog.pg_namespace n on n.oid = t.typnamespace
        join pg_catalog.pg_enum e on e.enumtypid = t.oid
       where n.nspname = 'public' and t.typname like 'sp_write_%'
       group by t.typname
       order by t.typname
    `;
    expect(Object.fromEntries(enumRows.map((row) => [row.typname, row.labels]))).toEqual({
      sp_write_action_resolution_kind: ['refusal', 'intent'],
      sp_write_approval_mode: ['manual', 'bounded_live_test'],
      sp_write_observation_outcome: [
        'observed_requested',
        'observed_expected_after_ambiguous',
        'missing',
        'conflict',
      ],
      sp_write_outbox_kind: ['dispatch', 'observe_and_recover'],
      sp_write_plan_direction: ['forward', 'inverse'],
      sp_write_provider_outcome: ['accepted', 'authoritative_rejected', 'ambiguous'],
      sp_write_refusal_reason: [
        'approval_expired',
        'authorization_revoked',
        'environment_gate_closed',
        'profile_gate_closed',
        'route_mismatch',
        'stale_expected_state',
        'unsupported_provider_state',
        'lease_unavailable',
        'duplicate_intent',
      ],
      sp_write_result_origin: ['provider_adapter', 'recovery_synthesized'],
      sp_write_route_key: [
        'sp.v3.campaigns.update',
        'sp.v3.ad_groups.update',
        'sp.v3.keywords.update',
        'sp.v3.targets.update',
        'sp.v3.product_ads.update',
      ],
    });
  });

  it('keeps the Drizzle table, column, FK, unique, and index mirror exact', async () => {
    const drizzle = spWriteDrizzleConfigs();
    expect(drizzle).toHaveLength(28);

    const sqlColumns = await database.sql<{
      table_name: string;
      column_name: string;
      sql_type: string;
      not_null: boolean;
      has_default: boolean;
    }[]>`
      select c.relname as table_name, a.attname as column_name,
             pg_catalog.format_type(a.atttypid, a.atttypmod) as sql_type,
             a.attnotnull as not_null, a.atthasdef as has_default
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        join pg_catalog.pg_attribute a on a.attrelid = c.oid
       where n.nspname = 'public' and c.relkind = 'r'
         and c.relname like 'sp_write_%' and a.attnum > 0 and not a.attisdropped
       order by c.relname, a.attnum
    `;
    const drizzleColumns = drizzle.flatMap((table) => table.columns.map((column) => ({
      table_name: table.name,
      column_name: column.name,
      sql_type: column.getSQLType(),
      not_null: column.notNull,
      has_default: column.hasDefault,
    })));
    expect(drizzleColumns).toEqual(sqlColumns);

    const sqlForeignKeys = await database.sql<{
      table_name: string;
      name: string;
      child_columns: string[];
      parent_table: string;
      parent_columns: string[];
      on_delete: string;
    }[]>`
      select child.relname as table_name, con.conname as name,
        array(
          select a.attname from pg_catalog.unnest(con.conkey) with ordinality key(attnum, ord)
          join pg_catalog.pg_attribute a
            on a.attrelid = con.conrelid and a.attnum = key.attnum
          order by key.ord
        ) as child_columns,
        parent.relname as parent_table,
        array(
          select a.attname from pg_catalog.unnest(con.confkey) with ordinality key(attnum, ord)
          join pg_catalog.pg_attribute a
            on a.attrelid = con.confrelid and a.attnum = key.attnum
          order by key.ord
        ) as parent_columns,
        case con.confdeltype
          when 'a' then 'no action'
          when 'r' then 'restrict'
          when 'c' then 'cascade'
          when 'n' then 'set null'
          when 'd' then 'set default'
        end as on_delete
        from pg_catalog.pg_constraint con
        join pg_catalog.pg_class child on child.oid = con.conrelid
        join pg_catalog.pg_namespace n on n.oid = child.relnamespace
        join pg_catalog.pg_class parent on parent.oid = con.confrelid
       where con.contype = 'f' and n.nspname = 'public'
         and child.relname like 'sp_write_%'
       order by child.relname, con.conname
    `;
    const drizzleForeignKeys = drizzle.flatMap((table) => table.foreignKeys.map((foreignKey) => {
      const reference = foreignKey.reference();
      return {
        table_name: table.name,
        name: foreignKey.getName(),
        child_columns: reference.columns.map((column) => column.name),
        parent_table: getTableName(reference.foreignTable),
        parent_columns: reference.foreignColumns.map((column) => column.name),
        on_delete: foreignKey.onDelete ?? 'no action',
      };
    })).sort((left, right) =>
      `${left.table_name}:${left.name}`.localeCompare(`${right.table_name}:${right.name}`));
    expect(drizzleForeignKeys).toEqual(sqlForeignKeys);

    const sqlUniques = await database.sql<{
      table_name: string;
      name: string;
      columns: string[];
    }[]>`
      select c.relname as table_name, con.conname as name,
        array(
          select a.attname from pg_catalog.unnest(con.conkey) with ordinality key(attnum, ord)
          join pg_catalog.pg_attribute a
            on a.attrelid = con.conrelid and a.attnum = key.attnum
          order by key.ord
        ) as columns
        from pg_catalog.pg_constraint con
        join pg_catalog.pg_class c on c.oid = con.conrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where con.contype = 'u' and n.nspname = 'public'
         and c.relname like 'sp_write_%'
       order by c.relname, con.conname
    `;
    const drizzleUniques = drizzle.flatMap((table) => table.uniqueConstraints.map((constraint) => ({
      table_name: table.name,
      name: constraint.getName(),
      columns: constraint.columns.map((column) => column.name),
    }))).sort((left, right) =>
      `${left.table_name}:${left.name}`.localeCompare(`${right.table_name}:${right.name}`));
    expect(drizzleUniques).toEqual(sqlUniques);

    const sqlIndexes = await database.sql<{
      table_name: string;
      name: string;
      columns: string[];
    }[]>`
      select c.relname as table_name, i.relname as name,
        array(
          select a.attname
            from pg_catalog.unnest(ix.indkey::smallint[]) with ordinality key(attnum, ord)
            join pg_catalog.pg_attribute a
              on a.attrelid = ix.indrelid and a.attnum = key.attnum
           order by key.ord
        ) as columns
        from pg_catalog.pg_index ix
        join pg_catalog.pg_class c on c.oid = ix.indrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        join pg_catalog.pg_class i on i.oid = ix.indexrelid
       where n.nspname = 'public' and c.relname like 'sp_write_%'
         and not ix.indisunique and not ix.indisprimary
       order by c.relname, i.relname
    `;
    const drizzleIndexes = drizzle.flatMap((table) => table.indexes.map((index) => ({
      table_name: table.name,
      name: index.config.name,
      columns: index.config.columns.map((column) => {
        if ('name' in column && typeof column.name === 'string') return column.name;
        throw new Error(`SP write Drizzle index ${index.config.name} is not a simple column index`);
      }),
    }))).sort((left, right) =>
      `${left.table_name}:${left.name}`.localeCompare(`${right.table_name}:${right.name}`));
    expect(drizzleIndexes).toEqual(sqlIndexes);

    const view = getViewConfig(dbSchema.spWriteExecutionAccounting);
    const drizzleViewColumns = (Object.values(view.selectedFields) as AnyPgColumn[]).map((field) => {
      return {
        column_name: field.name,
        sql_type: field.getSQLType(),
        not_null: field.notNull,
      };
    });
    const sqlViewColumns = await database.sql<{
      column_name: string;
      sql_type: string;
      not_null: boolean;
    }[]>`
      select a.attname as column_name,
             pg_catalog.format_type(a.atttypid, a.atttypmod) as sql_type,
             a.attnotnull as not_null
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        join pg_catalog.pg_attribute a on a.attrelid = c.oid
       where n.nspname = 'public' and c.relname = 'sp_write_execution_accounting'
         and c.relkind = 'v' and a.attnum > 0 and not a.attisdropped
       order by a.attnum
    `;
    expect(view.name).toBe('sp_write_execution_accounting');
    expect(drizzleViewColumns).toEqual(sqlViewColumns);
    const [security] = await database.sql<{ security_invoker: boolean }[]>`
      select coalesce(c.reloptions @> array['security_invoker=true'], false) as security_invoker
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'sp_write_execution_accounting'
    `;
    expect(security?.security_invoker).toBe(true);
  });

  it('uses composite tenant keys for every FK between tenant-bearing relations', async () => {
    const foreignKeys = await database.sql<{
      conname: string;
      child_table: string;
      parent_table: string;
      child_columns: string[];
      parent_columns: string[];
      child_has_tenant: boolean;
      parent_has_tenant: boolean;
    }[]>`
      select
        con.conname,
        child.relname as child_table,
        parent.relname as parent_table,
        array(
          select a.attname
            from pg_catalog.unnest(con.conkey) with ordinality key(attnum, ord)
            join pg_catalog.pg_attribute a
              on a.attrelid = con.conrelid and a.attnum = key.attnum
           order by key.ord
        ) as child_columns,
        array(
          select a.attname
            from pg_catalog.unnest(con.confkey) with ordinality key(attnum, ord)
            join pg_catalog.pg_attribute a
              on a.attrelid = con.confrelid and a.attnum = key.attnum
           order by key.ord
        ) as parent_columns,
        exists (
          select 1 from pg_catalog.pg_attribute a
           where a.attrelid = con.conrelid and a.attname = 'org_id' and a.attnum > 0
        ) and exists (
          select 1 from pg_catalog.pg_attribute a
           where a.attrelid = con.conrelid and a.attname = 'profile_id' and a.attnum > 0
        ) as child_has_tenant,
        exists (
          select 1 from pg_catalog.pg_attribute a
           where a.attrelid = con.confrelid and a.attname = 'org_id' and a.attnum > 0
        ) and exists (
          select 1 from pg_catalog.pg_attribute a
           where a.attrelid = con.confrelid and a.attname = 'profile_id' and a.attnum > 0
        ) as parent_has_tenant
        from pg_catalog.pg_constraint con
        join pg_catalog.pg_class child on child.oid = con.conrelid
        join pg_catalog.pg_namespace child_namespace on child_namespace.oid = child.relnamespace
        join pg_catalog.pg_class parent on parent.oid = con.confrelid
       where con.contype = 'f'
         and child_namespace.nspname = 'public'
         and child.relname like 'sp_write_%'
       order by child.relname, con.conname
    `;
    const scalarTenantPaths = foreignKeys.filter((foreignKey) =>
      foreignKey.child_has_tenant
      && foreignKey.parent_has_tenant
      && (!foreignKey.child_columns.includes('org_id')
        || !foreignKey.child_columns.includes('profile_id')
        || !foreignKey.parent_columns.includes('org_id')
        || !foreignKey.parent_columns.includes('profile_id')),
    );

    expect(scalarTenantPaths).toEqual([]);

    const byName = new Map(foreignKeys.map((foreignKey) => [foreignKey.conname, foreignKey]));
    const exactLifecycleEdges: Record<string, { child: string[]; parent: string[] }> = {
      sp_write_cycle_plans_receipt_fkey: {
        child: ['org_id', 'profile_id', 'execution_id', 'receipt_plan_id', 'approval_id', 'generation'],
        parent: ['org_id', 'profile_id', 'execution_id', 'plan_id', 'approval_id', 'generation'],
      },
      sp_write_execution_requests_cycle_plan_fkey: {
        child: ['org_id', 'profile_id', 'execution_id', 'plan_id', 'approval_id', 'generation'],
        parent: ['org_id', 'profile_id', 'execution_id', 'plan_id', 'approval_id', 'generation'],
      },
      sp_write_dispatch_leases_execution_fkey: {
        child: ['org_id', 'profile_id', 'execution_id', 'plan_id', 'approval_id', 'generation'],
        parent: ['org_id', 'profile_id', 'execution_id', 'plan_id', 'approval_id', 'generation'],
      },
      sp_write_predispatch_observations_cycle_plan_fkey: {
        child: ['org_id', 'profile_id', 'execution_id', 'plan_id', 'approval_id', 'generation'],
        parent: ['org_id', 'profile_id', 'execution_id', 'plan_id', 'approval_id', 'generation'],
      },
      sp_write_predispatch_observation_items_observation_fkey: {
        child: [
          'org_id', 'profile_id', 'execution_id', 'plan_id', 'approval_id', 'generation',
          'observation_id', 'route_key',
        ],
        parent: [
          'org_id', 'profile_id', 'execution_id', 'plan_id', 'approval_id', 'generation',
          'observation_id', 'route_key',
        ],
      },
      sp_write_provider_call_intents_lease_fkey: {
        child: [
          'org_id', 'profile_id', 'execution_id', 'plan_id', 'approval_id', 'generation',
          'route_key', 'dispatch_lease_id',
        ],
        parent: [
          'org_id', 'profile_id', 'execution_id', 'plan_id', 'approval_id', 'generation',
          'route_key', 'lease_id',
        ],
      },
      sp_write_provider_results_reserved_identity_fkey: {
        child: [
          'org_id', 'profile_id', 'intent_id', 'result_id', 'intent_fingerprint',
          'provider_call_id', 'request_fingerprint',
        ],
        parent: [
          'org_id', 'profile_id', 'intent_id', 'reserved_result_id', 'fingerprint',
          'provider_call_id', 'request_fingerprint',
        ],
      },
      sp_write_observations_source_job_fkey: {
        child: [
          'org_id', 'profile_id', 'execution_id', 'plan_id', 'approval_id', 'generation',
          'intent_id', 'provider_call_id', 'source_sync_job_id',
        ],
        parent: [
          'org_id', 'profile_id', 'execution_id', 'plan_id', 'approval_id', 'generation',
          'intent_id', 'provider_call_id', 'source_sync_job_id',
        ],
      },
      sp_write_observations_result_position_fkey: {
        child: ['org_id', 'profile_id', 'result_id', 'intent_id', 'action_id'],
        parent: ['org_id', 'profile_id', 'result_id', 'intent_id', 'action_id'],
      },
    };
    for (const [name, expectedEdge] of Object.entries(exactLifecycleEdges)) {
      expect(byName.get(name), name).toMatchObject({
        child_columns: expectedEdge.child,
        parent_columns: expectedEdge.parent,
      });
    }
  });

  it('locks the reservation precedence in the installed capability body', async () => {
    const [row] = await database.sql<{ definition: string }[]>`
      select pg_catalog.pg_get_functiondef(
        'app.reserve_sp_write_provider_call(uuid,uuid,uuid,uuid,text,text,text,text,text)'
          ::regprocedure
      ) as definition
    `;
    const definition = row?.definition ?? '';
    const markers = [
      "decision := 'already_intended';",
      "v_refusal := 'approval_expired';",
      "v_refusal := 'environment_gate_closed';",
      "v_refusal := 'profile_gate_closed';",
      "v_refusal := 'route_mismatch';",
      "v_refusal := 'authorization_revoked';",
      "v_refusal := 'lease_unavailable';",
      "decision := 'busy';",
      "v_refusal := 'duplicate_intent';",
      "v_refusal := 'unsupported_provider_state';",
      "v_refusal := 'stale_expected_state';",
    ];
    const positions = markers.map((marker) => definition.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    // One provider intent is necessarily single-route, while a plan may have
    // multiple route calls. The bounded busy predicate therefore keys only on
    // authorization identity; route-scoping here would permit a second call.
    const boundedCapacityStart = definition.indexOf(
      'v_receipt.bounded_authorization_id is not null and exists',
    );
    const manualCapacityStart = definition.indexOf(
      'v_receipt.bounded_authorization_id is null and exists',
      boundedCapacityStart,
    );
    const boundedCapacity = definition.slice(boundedCapacityStart, manualCapacityStart);
    expect(boundedCapacity).toContain(
      'receipt.bounded_authorization_id = v_receipt.bounded_authorization_id',
    );
    expect(boundedCapacity).not.toMatch(/route_key/);
  });

  it('installs the exact function signatures and application-role capability grants', async () => {
    const signatures = await database.sql<{ proname: string; args: string; result: string }[]>`
      select p.proname,
             pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
             pg_catalog.pg_get_function_result(p.oid) as result
        from pg_catalog.pg_proc p
       where p.pronamespace = 'app'::regnamespace
         and (p.proname like '%sp_write%')
       order by p.proname
    `;
    expect(signatures).toEqual([
      { proname: 'acquire_sp_write_dispatch_lease', args: 'p_execution_id uuid, p_plan_id uuid, p_generation uuid, p_route_key sp_write_route_key, p_lease_seconds integer', result: 'TABLE(lease_id uuid, acquired_at timestamp with time zone, expires_at timestamp with time zone)' },
      { proname: 'append_sp_write_observation', args: 'p_observation_text text, p_fingerprint_preimage text', result: 'uuid' },
      { proname: 'append_sp_write_provider_result', args: 'p_result_text text, p_fingerprint_preimage text, p_origin sp_write_result_origin', result: 'text' },
      { proname: 'approve_sp_write_cycle', args: 'p_plan_id uuid, p_approval_request_text text', result: 'jsonb' },
      { proname: 'guard_org_delete_against_unresolved_sp_write', args: '', result: 'trigger' },
      { proname: 'record_sp_write_bounded_authorization', args: 'p_authorization_text text, p_fingerprint_preimage text, p_profile_bindings jsonb', result: 'uuid' },
      { proname: 'record_sp_write_plan', args: 'p_plan_text text, p_plan_fingerprint_preimage text, p_action_proofs jsonb', result: 'uuid' },
      { proname: 'reject_sp_write_evidence_change', args: '', result: 'trigger' },
      { proname: 'reject_sp_write_evidence_truncate', args: '', result: 'trigger' },
      { proname: 'reserve_sp_write_provider_call', args: 'p_execution_id uuid, p_plan_id uuid, p_generation uuid, p_dispatch_lease_id uuid, p_predispatch_observation_text text, p_predispatch_observation_preimage text, p_intent_text text, p_request_fingerprint_preimage text, p_intent_preimage text', result: 'TABLE(decision text, refusal_reason text, checked_at timestamp with time zone, result_id uuid, intent_text text)' },
      { proname: 'sp_write_action_entity_id', args: 'p_action jsonb', result: 'text' },
      { proname: 'sp_write_action_within_bounded_authorization', args: 'p_authorization_id uuid, p_org_id uuid, p_profile_id uuid, p_action jsonb', result: 'boolean' },
      { proname: 'sp_write_canonical_text_array', args: 'p_values text[]', result: 'text[]' },
      { proname: 'sp_write_disposition_artifact', args: 'p_disposition_id uuid, p_plan_id uuid, p_plan_fingerprint text, p_approval_id uuid, p_execution_id uuid, p_generation uuid, p_action_id uuid, p_action_fingerprint text, p_recorded_at timestamp with time zone, p_reason sp_write_refusal_reason, p_provider_observation_fingerprint text', result: 'jsonb' },
      { proname: 'sp_write_enforce_cycle_plan_binding', args: '', result: 'trigger' },
      { proname: 'sp_write_exact_json_keys', args: 'p_value jsonb, p_keys text[]', result: 'boolean' },
      { proname: 'sp_write_gate_snapshot_preimage', args: 'p_environment_version uuid, p_profile_grant_id uuid, p_profile_grant_version uuid, p_checked_at timestamp with time zone', result: 'text' },
      { proname: 'sp_write_instant', args: 'p_value timestamp with time zone', result: 'text' },
      { proname: 'sp_write_inverse_pair_exact', args: 'p_forward_plan_id uuid, p_inverse_plan_id uuid', result: 'boolean' },
      { proname: 'sp_write_observed_action_for_side', args: 'p_action jsonb, p_side text', result: 'jsonb' },
      { proname: 'sp_write_plan_binding', args: 'p_plan jsonb', result: 'jsonb' },
      { proname: 'sp_write_reserved_result_id', args: 'p_intent_id uuid', result: 'uuid' },
      { proname: 'sp_write_sha256', args: 'p_preimage text', result: 'text' },
      { proname: 'sp_write_verified_artifact', args: 'p_artifact_text text, p_fingerprint_preimage text, p_domain text', result: 'jsonb' },
      { proname: 'sp_write_verified_bounded_authorization', args: 'p_artifact_text text, p_fingerprint_preimage text', result: 'jsonb' },
      { proname: 'start_sp_write_execution', args: 'p_approval_id uuid, p_plan_id uuid', result: 'uuid' },
    ]);

    const grants = await database.sql<{ proname: string; role_name: string; privilege_type: string }[]>`
      select p.proname, role.rolname as role_name, acl.privilege_type
        from pg_catalog.pg_proc p
        cross join lateral pg_catalog.aclexplode(
          coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
        ) acl
        join pg_catalog.pg_roles role on role.oid = acl.grantee
       where p.pronamespace = 'app'::regnamespace
         and (p.proname like '%sp_write%')
         and role.rolname in ('anon', 'authenticated', 'service_role')
       order by p.proname, role.rolname, acl.privilege_type
    `;
    expect(grants).toEqual([
      { proname: 'acquire_sp_write_dispatch_lease', role_name: 'service_role', privilege_type: 'EXECUTE' },
      { proname: 'append_sp_write_observation', role_name: 'service_role', privilege_type: 'EXECUTE' },
      { proname: 'append_sp_write_provider_result', role_name: 'service_role', privilege_type: 'EXECUTE' },
      { proname: 'approve_sp_write_cycle', role_name: 'authenticated', privilege_type: 'EXECUTE' },
      { proname: 'record_sp_write_bounded_authorization', role_name: 'service_role', privilege_type: 'EXECUTE' },
      { proname: 'record_sp_write_plan', role_name: 'service_role', privilege_type: 'EXECUTE' },
      { proname: 'reserve_sp_write_provider_call', role_name: 'service_role', privilege_type: 'EXECUTE' },
      { proname: 'start_sp_write_execution', role_name: 'service_role', privilege_type: 'EXECUTE' },
    ]);
  });

  it('grants only tenant reads and capability-only mutation', async () => {
    const tables = spWriteDrizzleConfigs().map((table) => table.name);
    const tenantTables = await database.sql<{ relname: string }[]>`
      select c.relname
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        join pg_catalog.pg_attribute org
          on org.attrelid = c.oid and org.attname = 'org_id' and org.attnum > 0
        join pg_catalog.pg_attribute profile
          on profile.attrelid = c.oid and profile.attname = 'profile_id' and profile.attnum > 0
       where n.nspname = 'public' and c.relkind = 'r'
         and c.relname like 'sp_write_%'
       order by c.relname
    `;
    const grants = await database.sql<{
      relname: string;
      role_name: string;
      privilege_type: string;
    }[]>`
      select c.relname, role.rolname as role_name, acl.privilege_type
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        cross join lateral pg_catalog.aclexplode(
          coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))
        ) acl
        join pg_catalog.pg_roles role on role.oid = acl.grantee
       where n.nspname = 'public'
         and (c.relname like 'sp_write_%')
         and c.relkind in ('r', 'v')
         and role.rolname in ('anon', 'authenticated', 'service_role')
       order by c.relname, role.rolname, acl.privilege_type
    `;
    const expected = [
      ...tables.map((relname) => ({ relname, role_name: 'service_role', privilege_type: 'SELECT' })),
      ...tenantTables
        .filter(({ relname }) => ![
          'sp_write_bounded_authorization_profiles',
          'sp_write_bounded_authorization_entities',
        ].includes(relname))
        .map(({ relname }) => ({ relname, role_name: 'authenticated', privilege_type: 'SELECT' })),
      { relname: 'sp_write_execution_accounting', role_name: 'authenticated', privilege_type: 'SELECT' },
      { relname: 'sp_write_execution_accounting', role_name: 'service_role', privilege_type: 'SELECT' },
    ].sort((left, right) =>
      `${left.relname}:${left.role_name}:${left.privilege_type}`
        .localeCompare(`${right.relname}:${right.role_name}:${right.privilege_type}`));
    expect(grants).toEqual(expected);
    expect(grants.some((grant) =>
      grant.role_name === 'anon' || grant.privilege_type !== 'SELECT')).toBe(false);
  });

  it('enforces the non-member, member, admin, and service approval matrix', async () => {
    await enableTestAuthority(database, tenant, 10_800);
    const analystId = uuid(10_801);
    const adminId = uuid(10_802);
    const nonMemberId = uuid(10_803);
    await database.sql`
      select public.auth_user_stub(${analystId}::uuid),
             public.auth_user_stub(${adminId}::uuid),
             public.auth_user_stub(${nonMemberId}::uuid)
    `;
    await database.sql`
      insert into public.org_members (org_id, user_id, role)
      values
        (${tenant.orgId}::uuid, ${analystId}::uuid, 'analyst'),
        (${tenant.orgId}::uuid, ${adminId}::uuid, 'admin')
    `;
    const proof = keywordPlan(
      tenant.orgId, tenant.profileId, tenant.connectionId, tenant.amazonProfileId, uuid(10_810),
    );
    await asServiceRole(database, async (sql) => sql`
      select app.record_sp_write_plan(
        ${JSON.stringify(proof.plan)}, ${proof.planPreimage},
        ${JSON.stringify([{
          artifactText: JSON.stringify(proof.action),
          fingerprintPreimage: proof.actionPreimage,
        }])}::jsonb
      )
    `);
    const request = ApproveSpWritePlan.parse({
      approvalRequestId: uuid(10_811),
      plan: spWritePlanBinding(proof.plan),
      approvalMode: 'manual',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
      boundedAuthorization: null,
      preapprovedInversePlan: null,
    });
    for (const actorId of [nonMemberId, analystId]) {
      await expect(asUser(database, actorId, async (sql) => sql`
        select app.approve_sp_write_cycle(${proof.plan.id}::uuid, ${JSON.stringify(request)})
      `)).rejects.toThrow(/requires owner or admin/i);
    }
    await expect(asServiceRole(database, async (sql) => sql`
      select app.approve_sp_write_cycle(${proof.plan.id}::uuid, ${JSON.stringify(request)})
    `)).rejects.toThrow(/permission denied/i);
    const [approved] = await asUser(database, adminId, async (sql) => sql<{ receipt: unknown }[]>`
      select app.approve_sp_write_cycle(${proof.plan.id}::uuid, ${JSON.stringify(request)})
        as receipt
    `);
    expect(SpWriteAuthorizationReceipt.parse(approved?.receipt).approvedBy).toBe(adminId);
  });

  it('denies direct API DML and privileged evidence mutation or truncate', async () => {
    const allTriggers = await database.sql<{ tgname: string }[]>`
      select t.tgname
        from pg_catalog.pg_trigger t
        join pg_catalog.pg_class c on c.oid = t.tgrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname like 'sp_write_%'
         and not t.tgisinternal
       order by t.tgname
    `;
    expect(allTriggers).toHaveLength(53);
    expect(allTriggers.map((trigger) => trigger.tgname))
      .toContain('sp_write_cycle_plans_exact_binding');
    const immutable = await database.sql<{ relname: string; triggers: string[] }[]>`
      select c.relname, array_agg(t.tgname order by t.tgname) as triggers
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        join pg_catalog.pg_trigger t on t.tgrelid = c.oid and not t.tgisinternal
       where n.nspname = 'public' and c.relname like 'sp_write_%'
         and (t.tgname like '%_immutable' or t.tgname like '%_no_truncate')
       group by c.relname
       order by c.relname
    `;
    expect(immutable).toHaveLength(26);
    for (const relation of immutable) {
      expect(relation.triggers).toEqual([
        `${relation.relname}_immutable`,
        `${relation.relname}_no_truncate`,
      ]);
    }

    const immutableProof = keywordPlan(
      tenant.orgId,
      tenant.profileId,
      tenant.connectionId,
      tenant.amazonProfileId,
      uuid(10_090),
    );
    await asServiceRole(database, async (sql) => sql`
      select app.record_sp_write_plan(
        ${JSON.stringify(immutableProof.plan)},
        ${immutableProof.planPreimage},
        ${JSON.stringify([{
          artifactText: JSON.stringify(immutableProof.action),
          fingerprintPreimage: immutableProof.actionPreimage,
        }])}::jsonb
      )
    `);
    const [plan] = await database.sql<{ plan_id: string }[]>`
      select plan_id::text from public.sp_write_plans
       where plan_id = ${immutableProof.plan.id}::uuid
    `;
    if (!plan) throw new Error('SP immutable plan fixture is missing');
    await expect(database.sql`
      update public.sp_write_plans set artifact_text = artifact_text
       where plan_id = ${plan.plan_id}::uuid
    `).rejects.toThrow(/immutable/i);
    await expect(database.sql`
      delete from public.sp_write_plans where plan_id = ${plan.plan_id}::uuid
    `).rejects.toThrow(/immutable/i);
    await expect(database.sql`truncate table public.sp_write_late_result_audits`)
      .rejects.toThrow(/must not be truncated/i);

    await asServiceRole(database, async (sql) => {
      await expect(sql`insert into public.sp_write_plans default values`)
        .rejects.toThrow(/permission denied/i);
      await expect(sql`update public.sp_write_plans set artifact_text = artifact_text`)
        .rejects.toThrow(/permission denied/i);
      await expect(sql`delete from public.sp_write_plans`)
        .rejects.toThrow(/permission denied/i);
      await expect(sql`truncate table public.sp_write_plans`)
        .rejects.toThrow(/permission denied/i);
    });
    await asUser(database, OWNER_USER_ID, async (sql) => {
      const visible = await sql<{ plan_id: string }[]>`
        select plan_id::text from public.sp_write_plans
      `;
      expect(visible.length).toBeGreaterThan(0);
      await expect(sql`insert into public.sp_write_plans default values`)
        .rejects.toThrow(/permission denied/i);
      await expect(sql`select app.record_sp_write_plan('', '', '[]'::jsonb)`)
        .rejects.toThrow(/permission denied/i);
    });
    await asAnon(database, async (sql) => {
      await expect(sql`select * from public.sp_write_plans`).rejects.toThrow(/permission denied/i);
    });
  });

  it('accepts exact artifact bytes and rejects artifact, preimage, or digest tampering', async () => {
    const domain = 'openspell.synthetic-proof.v1';
    const body = { schemaVersion: 'openspell.synthetic-proof.v1', value: 'synthetic' };
    const preimage = JSON.stringify([domain, body]);
    const fingerprint = sha256(preimage);
    const artifactText = JSON.stringify({ ...body, fingerprint });

    const [verified] = await database.sql<{ artifact: unknown }[]>`
      select app.sp_write_verified_artifact(
        ${artifactText}, ${preimage}, ${domain}
      ) as artifact
    `;
    expect(verified?.artifact).toEqual({ ...body, fingerprint });

    await expect(database.sql`
      select app.sp_write_verified_artifact(
        ${JSON.stringify({ ...body, value: 'tampered', fingerprint })},
        ${preimage},
        ${domain}
      )
    `).rejects.toThrow(/does not equal/i);
    await expect(database.sql`
      select app.sp_write_verified_artifact(
        ${artifactText},
        ${JSON.stringify([domain, { ...body, value: 'tampered' }])},
        ${domain}
      )
    `).rejects.toThrow(/does not equal|fingerprint mismatch/i);
    await expect(database.sql`
      select app.sp_write_verified_artifact(
        ${JSON.stringify({ ...body, fingerprint: 'f'.repeat(64) })},
        ${preimage},
        ${domain}
      )
    `).rejects.toThrow(/fingerprint mismatch/i);
  });

  it('records a byte-exact verified plan and closes all offered action counts atomically', async () => {
    const proof = keywordPlan(
      tenant.orgId,
      tenant.profileId,
      tenant.connectionId,
      tenant.amazonProfileId,
    );
    const actionProofs = JSON.stringify([{
      artifactText: JSON.stringify(proof.action),
      fingerprintPreimage: proof.actionPreimage,
    }]);

    const recorded = await asServiceRole(database, async (sql) => sql<{ plan_id: string }[]>`
      select app.record_sp_write_plan(
        ${JSON.stringify(proof.plan)},
        ${proof.planPreimage},
        ${actionProofs}::jsonb
      )::text as plan_id
    `);
    expect(recorded).toEqual([{ plan_id: proof.plan.id }]);

    const [stored] = await database.sql<{
      artifact_text: string;
      fingerprint_preimage: string;
      action_count: string;
    }[]>`
      select p.artifact_text, p.fingerprint_preimage,
             count(a.action_id)::text as action_count
        from public.sp_write_plans p
        join public.sp_write_plan_actions a
          on a.org_id = p.org_id and a.profile_id = p.profile_id and a.plan_id = p.plan_id
       where p.plan_id = ${proof.plan.id}::uuid
       group by p.plan_id
    `;
    expect(stored).toEqual({
      artifact_text: JSON.stringify(proof.plan),
      fingerprint_preimage: proof.planPreimage,
      action_count: '1',
    });

    const incomplete = keywordPlan(
      tenant.orgId,
      tenant.profileId,
      tenant.connectionId,
      tenant.amazonProfileId,
      uuid(10_011),
    );
    await expect(asServiceRole(database, async (sql) => sql`
      select app.record_sp_write_plan(
        ${JSON.stringify(incomplete.plan)},
        ${incomplete.planPreimage},
        '[]'::jsonb
      )
    `)).rejects.toThrow(/relational shape mismatch/i);
    const [rolledBack] = await database.sql<{ count: string }[]>`
      select count(*)::text as count
        from public.sp_write_plans
       where plan_id = ${incomplete.plan.id}::uuid
    `;
    expect(rolledBack?.count).toBe('0');
  });

  it('persists bounded authority with the frozen one-cycle concurrency literals', async () => {
    const planProof = keywordPlan(
      tenant.orgId,
      tenant.profileId,
      tenant.connectionId,
      tenant.amazonProfileId,
    );
    const authorization = boundedAuthorization(planProof.plan);
    const preimage = serializeSpWriteBoundedAuthorizationFingerprint(authorization);

    const recorded = await asServiceRole(database, async (sql) => sql<{ authorization_id: string }[]>`
      select app.record_sp_write_bounded_authorization(
        ${JSON.stringify(authorization)},
        ${preimage},
        ${JSON.stringify([{ orgId: tenant.orgId, profileId: tenant.profileId }])}::jsonb
      )::text as authorization_id
    `);
    expect(recorded).toEqual([{ authorization_id: authorization.authorizationId }]);

    const [stored] = await database.sql<{
      max_concurrent_mutations: number;
      max_cycles: number;
      max_executions: number;
      profile_count: string;
      entity_count: string;
    }[]>`
      select a.max_concurrent_mutations, a.max_cycles, a.max_executions,
             count(distinct p.profile_index)::text as profile_count,
             count(e.entity_index)::text as entity_count
        from public.sp_write_bounded_authorizations a
        join public.sp_write_bounded_authorization_profiles p
          on p.authorization_id = a.authorization_id
        join public.sp_write_bounded_authorization_entities e
          on e.authorization_id = p.authorization_id
         and e.profile_index = p.profile_index
       where a.authorization_id = ${authorization.authorizationId}::uuid
       group by a.authorization_id
    `;
    expect(stored).toEqual({
      max_concurrent_mutations: 1,
      max_cycles: 1,
      max_executions: 2,
      profile_count: '1',
      entity_count: '1',
    });
  });

  it('validates exact bounded scope and inverse semantics before approval evidence', async () => {
    await enableTestAuthority(database, tenant, 10_500);
    const recordPlan = async (proof: {
      plan: ReturnType<typeof SpWritePlan.parse>;
      planPreimage: string;
      action: ReturnType<typeof SpWriteAction.parse>;
      actionPreimage: string;
    }) => asServiceRole(database, async (sql) => sql`
      select app.record_sp_write_plan(
        ${JSON.stringify(proof.plan)}, ${proof.planPreimage},
        ${JSON.stringify([{
          artifactText: JSON.stringify(proof.action),
          fingerprintPreimage: proof.actionPreimage,
        }])}::jsonb
      )
    `);
    const recordAuthorization = async (
      authorization: ReturnType<typeof SpWriteBoundedAuthorization.parse>,
    ) => asServiceRole(database, async (sql) => sql`
      select app.record_sp_write_bounded_authorization(
        ${JSON.stringify(authorization)},
        ${serializeSpWriteBoundedAuthorizationFingerprint(authorization)},
        ${JSON.stringify([{ orgId: tenant.orgId, profileId: tenant.profileId }])}::jsonb
      )
    `);
    const boundedRequest = (
      requestId: string,
      forward: ReturnType<typeof keywordPlan>['plan'],
      inverse: ReturnType<typeof inverseKeywordPlan>['plan'],
      authorization: ReturnType<typeof SpWriteBoundedAuthorization.parse>,
    ) => ApproveSpWritePlan.parse({
      approvalRequestId: requestId,
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

    const validForward = keywordPlan(
      tenant.orgId, tenant.profileId, tenant.connectionId, tenant.amazonProfileId, uuid(10_510),
    );
    const validInverse = inverseKeywordPlan(
      validForward, uuid(10_511), uuid(10_512), uuid(10_513),
    );
    const validAuthorization = boundedAuthorization(validForward.plan, uuid(10_514));
    await recordPlan(validForward);
    await recordPlan(validInverse);
    await recordAuthorization(validAuthorization);
    expect(() => verifySpWriteInversePair(
      validForward.plan, validInverse.plan, spWriteHasher,
    )).not.toThrow();
    const [sqlInverse] = await database.sql<{ exact: boolean }[]>`
      select app.sp_write_inverse_pair_exact(
        ${validForward.plan.id}::uuid, ${validInverse.plan.id}::uuid
      ) as exact
    `;
    expect(sqlInverse?.exact).toBe(true);
    const validRequest = boundedRequest(
      uuid(10_515), validForward.plan, validInverse.plan, validAuthorization,
    );
    const [approved] = await asUser(database, tenant.userId, async (sql) => sql<{ receipt: unknown }[]>`
      select app.approve_sp_write_cycle(
        ${validForward.plan.id}::uuid,
        ${JSON.stringify(validRequest)}
      ) as receipt
    `);
    const receipt = SpWriteAuthorizationReceipt.parse(approved?.receipt);
    expect(() => verifySpWriteAuthorizationReceiptArtifacts(
      validForward.plan,
      validInverse.plan,
      validRequest,
      validAuthorization,
      receipt,
      receipt.approvedAt,
      spWriteHasher,
    )).not.toThrow();
    await expect(asServiceRole(database, async (sql) => sql`
      select app.start_sp_write_execution(
        ${receipt.approvalId}::uuid, ${validInverse.plan.id}::uuid
      )
    `)).rejects.toThrow(/inverse.*(?:not ready|not completely observed)|forward.*observ/i);
    await asServiceRole(database, async (sql) => sql`
      select app.start_sp_write_execution(${receipt.approvalId}::uuid, ${validForward.plan.id}::uuid)
    `);
    const [lease] = await asServiceRole(database, async (sql) => sql<{ lease_id: string }[]>`
      select lease_id::text from app.acquire_sp_write_dispatch_lease(
        ${receipt.executionId}::uuid, ${validForward.plan.id}::uuid,
        ${receipt.generation}::uuid, 'sp.v3.keywords.update', 120
      )
    `);
    const [times] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!lease || !times) throw new Error('SP bounded forward dispatch fixture is incomplete');
    const artifacts = reservationArtifacts(
      validForward, receipt, lease.lease_id, times.observed_at, times.valid_until, 10_540,
    );
    const [reservation] = await asServiceRole(database, async (sql) => sql<{
      decision: string;
      result_id: string;
    }[]>`
      select decision, result_id::text from app.reserve_sp_write_provider_call(
        ${receipt.executionId}::uuid, ${validForward.plan.id}::uuid,
        ${receipt.generation}::uuid, ${lease.lease_id}::uuid,
        ${JSON.stringify(artifacts.observation)},
        ${serializeSpWritePredispatchObservationFingerprint(artifacts.observation)},
        ${JSON.stringify(artifacts.intent)},
        ${artifacts.requestPreimage}, ${artifacts.intentPreimage}
      )
    `);
    expect(reservation?.decision).toBe('won');
    const [completed] = await database.sql<{ completed_at: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as completed_at
    `;
    if (!completed || !reservation?.result_id) throw new Error('SP bounded result time is missing');
    const result = acceptedProviderResult(
      artifacts.intent, reservation.result_id, completed.completed_at,
    );
    await asServiceRole(database, async (sql) => sql`
      select app.append_sp_write_provider_result(
        ${JSON.stringify(result)}, ${serializeSpWriteProviderResultFingerprint(result)},
        'provider_adapter'
      )
    `);
    const [wake] = await database.sql<{ source_sync_job_id: string; observed_at: string }[]>`
      select source_sync_job_id::text,
             app.sp_write_instant(clock_timestamp()) as observed_at
        from public.sp_write_outbox where intent_id = ${artifacts.intent.intentId}::uuid
    `;
    if (!wake) throw new Error('SP bounded observation wake is missing');
    const observation = requestedObservation(
      validForward, receipt, artifacts.intent, wake.source_sync_job_id,
      wake.observed_at, uuid(10_543),
    );
    await asServiceRole(database, async (sql) => sql`
      select app.append_sp_write_observation(
        ${JSON.stringify(observation)}, ${serializeSpWriteObservationFingerprint(observation)}
      )
    `);
    const [inverseStarted] = await asServiceRole(database, async (sql) => sql<{
      outbox_id: string;
    }[]>`
      select app.start_sp_write_execution(
        ${receipt.approvalId}::uuid, ${validInverse.plan.id}::uuid
      )::text as outbox_id
    `);
    expect(inverseStarted?.outbox_id).toMatch(/^[a-f0-9-]{36}$/);
    const [inverseWake] = await database.sql<{ requests: number; wakes: number }[]>`
      select
        (select count(*)::int from public.sp_write_execution_requests
          where execution_id = ${receipt.executionId}::uuid
            and plan_id = ${validInverse.plan.id}::uuid) as requests,
        (select count(*)::int from public.sp_write_outbox
          where execution_id = ${receipt.executionId}::uuid
            and plan_id = ${validInverse.plan.id}::uuid and kind = 'dispatch') as wakes
    `;
    expect(inverseWake).toEqual({ requests: 1, wakes: 1 });

    const secondForward = keywordPlan(
      tenant.orgId, tenant.profileId, tenant.connectionId, tenant.amazonProfileId, uuid(10_516),
    );
    const secondInverse = inverseKeywordPlan(
      secondForward, uuid(10_517), uuid(10_518), uuid(10_519),
    );
    const secondRequest = boundedRequest(
      uuid(10_526), secondForward.plan, secondInverse.plan, validAuthorization,
    );
    await recordPlan(secondForward);
    await recordPlan(secondInverse);
    await expect(asUser(database, tenant.userId, async (sql) => sql`
      select app.approve_sp_write_cycle(
        ${secondForward.plan.id}::uuid,
        ${JSON.stringify(secondRequest)}
      )
    `)).rejects.toThrow(/already consumed its cycle|maxCycles/i);
    const [secondCounts] = await database.sql<{
      requests: number;
      receipts: number;
      cycles: number;
    }[]>`
      select
        (select count(*)::int from public.sp_write_approval_requests
          where approval_request_id = ${secondRequest.approvalRequestId}::uuid) as requests,
        (select count(*)::int from public.sp_write_authorization_receipts
          where approval_request_id = ${secondRequest.approvalRequestId}::uuid) as receipts,
        (select count(*)::int from public.sp_write_execution_cycles
          where execution_id = ${secondInverse.sourceExecutionId}::uuid) as cycles
    `;
    expect(secondCounts).toEqual({ requests: 0, receipts: 0, cycles: 0 });

    const outsideForward = keywordPlan(
      tenant.orgId, tenant.profileId, tenant.connectionId, tenant.amazonProfileId, uuid(10_520),
    );
    const outsideInverse = inverseKeywordPlan(
      outsideForward, uuid(10_521), uuid(10_522), uuid(10_523),
    );
    const allowedBase = boundedAuthorization(outsideForward.plan, uuid(10_524));
    const outsideBase = SpWriteBoundedAuthorization.parse({
      ...allowedBase,
      profiles: [{
        ...allowedBase.profiles[0]!,
        allowedEntities: [{
          ...allowedBase.profiles[0]!.allowedEntities[0]!,
          amazonEntityId: 'a-different-keyword',
        }],
      }],
      fingerprint: '0'.repeat(64),
    });
    const outsideAuthorization = SpWriteBoundedAuthorization.parse({
      ...outsideBase,
      fingerprint: sha256(serializeSpWriteBoundedAuthorizationFingerprint(outsideBase)),
    });
    await recordPlan(outsideForward);
    await recordPlan(outsideInverse);
    await recordAuthorization(outsideAuthorization);
    const outsideRequest = boundedRequest(
      uuid(10_525), outsideForward.plan, outsideInverse.plan, outsideAuthorization,
    );
    await expect(asUser(database, tenant.userId, async (sql) => sql`
      select app.approve_sp_write_cycle(
        ${outsideForward.plan.id}::uuid,
        ${JSON.stringify(outsideRequest)}
      )
    `)).rejects.toThrow(/authorization.*(?:exact plans|permit every plan action)|outside bounded authorization/i);
    const [outsideCounts] = await database.sql<{
      requests: number;
      receipts: number;
      cycles: number;
    }[]>`
      select
        (select count(*)::int from public.sp_write_approval_requests
          where approval_request_id = ${outsideRequest.approvalRequestId}::uuid) as requests,
        (select count(*)::int from public.sp_write_authorization_receipts
          where approval_request_id = ${outsideRequest.approvalRequestId}::uuid) as receipts,
        (select count(*)::int from public.sp_write_execution_cycles
          where execution_id = ${outsideInverse.sourceExecutionId}::uuid) as cycles
    `;
    expect(outsideCounts).toEqual({ requests: 0, receipts: 0, cycles: 0 });

    const badForward = keywordPlan(
      tenant.orgId, tenant.profileId, tenant.connectionId, tenant.amazonProfileId, uuid(10_530),
    );
    const badInverse = inverseKeywordPlan(
      badForward, uuid(10_531), uuid(10_532), uuid(10_533), false,
    );
    const badAuthorization = boundedAuthorization(badForward.plan, uuid(10_534));
    const badRequest = boundedRequest(
      uuid(10_535), badForward.plan, badInverse.plan, badAuthorization,
    );
    expect(() => verifySpWriteInversePair(
      badForward.plan, badInverse.plan, spWriteHasher,
    )).toThrow(/exactly swap/i);
    await recordPlan(badForward);
    await recordPlan(badInverse);
    await recordAuthorization(badAuthorization);
    await expect(asUser(database, tenant.userId, async (sql) => sql`
      select app.approve_sp_write_cycle(
        ${badForward.plan.id}::uuid,
        ${JSON.stringify(badRequest)}
      )
    `)).rejects.toThrow(/inverse.*exact|binding mismatch/i);
    const [badCounts] = await database.sql<{
      requests: number;
      receipts: number;
      cycles: number;
    }[]>`
      select
        (select count(*)::int from public.sp_write_approval_requests
          where approval_request_id = ${badRequest.approvalRequestId}::uuid) as requests,
        (select count(*)::int from public.sp_write_authorization_receipts
          where approval_request_id = ${badRequest.approvalRequestId}::uuid) as receipts,
        (select count(*)::int from public.sp_write_execution_cycles
          where execution_id = ${badInverse.sourceExecutionId}::uuid) as cycles
    `;
    expect(badCounts).toEqual({ requests: 0, receipts: 0, cycles: 0 });
  });

  it('rejects disallowed change keys and over-limit money or placement deltas atomically', async () => {
    await enableTestAuthority(database, tenant, 10_600);
    const recordPlan = async (proof: {
      plan: ReturnType<typeof SpWritePlan.parse>;
      planPreimage: string;
      action: ReturnType<typeof SpWriteAction.parse>;
      actionPreimage: string;
    }) => asServiceRole(database, async (sql) => sql`
      select app.record_sp_write_plan(
        ${JSON.stringify(proof.plan)}, ${proof.planPreimage},
        ${JSON.stringify([{
          artifactText: JSON.stringify(proof.action),
          fingerprintPreimage: proof.actionPreimage,
        }])}::jsonb
      )
    `);
    const scopedAuthorization = (
      plan: ReturnType<typeof SpWritePlan.parse>,
      authorizationId: string,
      entity: {
        routeKey: string;
        amazonEntityId: string;
        allowedChangeKeys: string[];
        maxAbsoluteMoneyDelta: string | null;
        maxAbsolutePlacementDelta: number | null;
      },
    ) => {
      const initial = boundedAuthorization(plan, authorizationId);
      const base = SpWriteBoundedAuthorization.parse({
        ...initial,
        profiles: [{
          ...initial.profiles[0]!,
          allowedEntities: [entity],
        }],
        fingerprint: '0'.repeat(64),
      });
      return SpWriteBoundedAuthorization.parse({
        ...base,
        fingerprint: sha256(serializeSpWriteBoundedAuthorizationFingerprint(base)),
      });
    };

    const disallowedForward = keywordStatePlan(
      tenant.orgId, tenant.profileId, tenant.connectionId, tenant.amazonProfileId,
      uuid(10_610), 10_611,
    );
    const disallowedInverse = inverseKeywordStatePlan(
      disallowedForward, uuid(10_613), uuid(10_614), uuid(10_615),
    );
    const disallowedAuthorization = scopedAuthorization(
      disallowedForward.plan,
      uuid(10_616),
      {
        routeKey: 'sp.v3.keywords.update',
        amazonEntityId: 'kw-1',
        allowedChangeKeys: ['keyword.bid'],
        maxAbsoluteMoneyDelta: '0.1',
        maxAbsolutePlacementDelta: null,
      },
    );

    const moneyForward = keywordPlan(
      tenant.orgId, tenant.profileId, tenant.connectionId, tenant.amazonProfileId, uuid(10_620),
    );
    const moneyInverse = inverseKeywordPlan(
      moneyForward, uuid(10_621), uuid(10_622), uuid(10_623),
    );
    const moneyAuthorization = scopedAuthorization(
      moneyForward.plan,
      uuid(10_624),
      {
        routeKey: 'sp.v3.keywords.update',
        amazonEntityId: 'kw-1',
        allowedChangeKeys: ['keyword.bid'],
        maxAbsoluteMoneyDelta: '0.04',
        maxAbsolutePlacementDelta: null,
      },
    );

    const placementForward = campaignPlacementPlan(
      tenant.orgId, tenant.profileId, tenant.connectionId, tenant.amazonProfileId,
      uuid(10_630), 10_631,
    );
    const placementInverse = inverseCampaignPlacementPlan(
      placementForward, uuid(10_634), uuid(10_635), uuid(10_636),
    );
    const placementAuthorization = scopedAuthorization(
      placementForward.plan,
      uuid(10_637),
      {
        routeKey: 'sp.v3.campaigns.update',
        amazonEntityId: 'campaign-placement-1',
        allowedChangeKeys: ['campaign.placement.top_of_search'],
        maxAbsoluteMoneyDelta: null,
        maxAbsolutePlacementDelta: 4,
      },
    );

    const routeMismatchAuthorization = scopedAuthorization(
      moneyForward.plan,
      uuid(10_638),
      {
        routeKey: 'sp.v3.targets.update',
        amazonEntityId: 'kw-1',
        allowedChangeKeys: ['target.bid'],
        maxAbsoluteMoneyDelta: '0.1',
        maxAbsolutePlacementDelta: null,
      },
    );
    await asServiceRole(database, async (sql) => sql`
      select app.record_sp_write_bounded_authorization(
        ${JSON.stringify(routeMismatchAuthorization)},
        ${serializeSpWriteBoundedAuthorizationFingerprint(routeMismatchAuthorization)},
        ${JSON.stringify([{ orgId: tenant.orgId, profileId: tenant.profileId }])}::jsonb
      )
    `);
    const routeMismatchAction = {
      ...moneyForward.action,
      sources: moneyForward.action.sources.map((source) => ({
        ...source,
        changeKey: 'target.bid',
      })),
    };
    const [routeIsolation] = await database.sql<{
      matches_without_route: boolean;
      allowed: boolean;
    }[]>`
      select
        exists (
          select 1
            from public.sp_write_bounded_authorization_entities entity
           where entity.authorization_id = ${routeMismatchAuthorization.authorizationId}::uuid
             and entity.org_id = ${tenant.orgId}::uuid
             and entity.profile_id = ${tenant.profileId}::uuid
             and entity.amazon_entity_id = app.sp_write_action_entity_id(
               ${JSON.stringify(routeMismatchAction)}::jsonb
             )
             and 'target.bid' = any(entity.allowed_change_keys)
             and entity.max_absolute_money_delta::numeric >= 0.05
        ) as matches_without_route,
        app.sp_write_action_within_bounded_authorization(
          ${routeMismatchAuthorization.authorizationId}::uuid,
          ${tenant.orgId}::uuid,
          ${tenant.profileId}::uuid,
          ${JSON.stringify(routeMismatchAction)}::jsonb
        ) as allowed
    `;
    expect(routeIsolation).toEqual({ matches_without_route: true, allowed: false });

    const cases = [
      {
        label: 'disallowed change key',
        forward: disallowedForward,
        inverse: disallowedInverse,
        authorization: disallowedAuthorization,
        requestId: uuid(10_640),
      },
      {
        label: 'money delta above 0.04',
        forward: moneyForward,
        inverse: moneyInverse,
        authorization: moneyAuthorization,
        requestId: uuid(10_641),
      },
      {
        label: 'placement delta above 4',
        forward: placementForward,
        inverse: placementInverse,
        authorization: placementAuthorization,
        requestId: uuid(10_642),
      },
    ] as const;

    for (const testCase of cases) {
      await recordPlan(testCase.forward);
      await recordPlan(testCase.inverse);
      await asServiceRole(database, async (sql) => sql`
        select app.record_sp_write_bounded_authorization(
          ${JSON.stringify(testCase.authorization)},
          ${serializeSpWriteBoundedAuthorizationFingerprint(testCase.authorization)},
          ${JSON.stringify([{ orgId: tenant.orgId, profileId: tenant.profileId }])}::jsonb
        )
      `);
      const [sqlScope] = await database.sql<{ allowed: boolean }[]>`
        select app.sp_write_action_within_bounded_authorization(
          ${testCase.authorization.authorizationId}::uuid,
          ${tenant.orgId}::uuid,
          ${tenant.profileId}::uuid,
          ${JSON.stringify(testCase.forward.action)}::jsonb
        ) as allowed
      `;
      expect(sqlScope?.allowed, `${testCase.label}: SQL helper`).toBe(false);

      const request = ApproveSpWritePlan.parse({
        approvalRequestId: testCase.requestId,
        plan: spWritePlanBinding(testCase.forward.plan),
        approvalMode: 'bounded_live_test',
        confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
        boundedAuthorization: {
          authorizationId: testCase.authorization.authorizationId,
          authorizationFingerprint: testCase.authorization.fingerprint,
          expiresAt: testCase.authorization.expiresAt,
        },
        preapprovedInversePlan: spWritePlanBinding(testCase.inverse.plan),
      });
      await expect(asUser(database, tenant.userId, async (sql) => sql`
        select app.approve_sp_write_cycle(
          ${testCase.forward.plan.id}::uuid,
          ${JSON.stringify(request)}
        )
      `), testCase.label).rejects.toThrow(/permit every plan action|outside bounded authorization/i);
      const [closure] = await database.sql<{
        requests: number;
        receipts: number;
        cycles: number;
        cycle_plans: number;
        consumptions: number;
      }[]>`
        select
          (select count(*)::int from public.sp_write_approval_requests
            where approval_request_id = ${testCase.requestId}::uuid) as requests,
          (select count(*)::int from public.sp_write_authorization_receipts
            where approval_request_id = ${testCase.requestId}::uuid) as receipts,
          (select count(*)::int from public.sp_write_execution_cycles
            where execution_id = ${testCase.inverse.sourceExecutionId}::uuid) as cycles,
          (select count(*)::int from public.sp_write_cycle_plans
            where execution_id = ${testCase.inverse.sourceExecutionId}::uuid) as cycle_plans,
          (select count(*)::int from public.sp_write_bounded_authorization_consumptions
            where authorization_id = ${testCase.authorization.authorizationId}::uuid)
            as consumptions
      `;
      expect(closure, testCase.label).toEqual({
        requests: 0,
        receipts: 0,
        cycles: 0,
        cycle_plans: 0,
        consumptions: 0,
      });
    }
  });

  it('derives approval actor and DB time, then starts once and enforces lease bounds', async () => {
    const proof = keywordPlan(
      tenant.orgId,
      tenant.profileId,
      tenant.connectionId,
      tenant.amazonProfileId,
      uuid(10_201),
    );
    await asServiceRole(database, async (sql) => sql`
      select app.record_sp_write_plan(
        ${JSON.stringify(proof.plan)},
        ${proof.planPreimage},
        ${JSON.stringify([{
          artifactText: JSON.stringify(proof.action),
          fingerprintPreimage: proof.actionPreimage,
        }])}::jsonb
      )
    `);

    const environmentVersion = uuid(10_202);
    const grantId = uuid(10_203);
    const grantVersion = uuid(10_204);
    await database.sql.begin(async (sql) => {
      await sql`
        insert into public.sp_write_environment_gate_versions
          (version_id, enabled, max_unresolved_calls, created_by)
        values (${environmentVersion}::uuid, true, 1, ${OWNER_USER_ID}::uuid)
      `;
      await sql`
        insert into public.sp_write_environment_gate_head (singleton, version_id)
        values (true, ${environmentVersion}::uuid)
        on conflict (singleton) do update set version_id = excluded.version_id
      `;
      await sql`
        insert into public.sp_write_profile_grant_versions
          (grant_id, version_id, org_id, profile_id, enabled, amazon_profile_id,
           connection_id, region, marketplace_id, currency_code, api_dialect, created_by)
        values (
          ${grantId}::uuid, ${grantVersion}::uuid, ${tenant.orgId}::uuid,
          ${tenant.profileId}::uuid, true, ${tenant.amazonProfileId},
          ${tenant.connectionId}::uuid, 'NA', 'synthetic-marketplace', 'USD', 'sp_v3',
          ${OWNER_USER_ID}::uuid
        )
      `;
      await sql`
        insert into public.sp_write_profile_grant_heads
          (org_id, profile_id, grant_id, version_id)
        values (
          ${tenant.orgId}::uuid, ${tenant.profileId}::uuid,
          ${grantId}::uuid, ${grantVersion}::uuid
        )
        on conflict (org_id, profile_id) do update
          set grant_id = excluded.grant_id, version_id = excluded.version_id
      `;
    });

    const request = ApproveSpWritePlan.parse({
      approvalRequestId: uuid(10_205),
      plan: spWritePlanBinding(proof.plan),
      approvalMode: 'manual',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
      boundedAuthorization: null,
      preapprovedInversePlan: null,
    });
    const [approval] = await asUser(database, OWNER_USER_ID, async (sql) => sql<{ receipt: unknown }[]>`
      select app.approve_sp_write_cycle(
        ${proof.plan.id}::uuid,
        ${JSON.stringify(request)}
      ) as receipt
    `);
    const receipt = SpWriteAuthorizationReceipt.parse(approval?.receipt);
    expect(receipt.approvedBy).toBe(OWNER_USER_ID);
    expect(receipt.gateSnapshot).toMatchObject({
      environmentGateVersion: environmentVersion,
      profileGrantId: grantId,
      profileGrantVersion: grantVersion,
    });
    expect(receipt.gateSnapshot.gateSnapshotFingerprint).toBe(
      sha256([
        'openspell.sp-write-gate-snapshot.sql.v1',
        'environment=enabled',
        `environment_version=${environmentVersion}`,
        `profile_grant_id=${grantId}`,
        `profile_grant_version=${grantVersion}`,
        `checked_at=${receipt.gateSnapshot.checkedAt.replace('.000Z', '.000000Z')}`,
      ].join('\n')),
    );

    const [firstStart] = await asServiceRole(database, async (sql) => sql<{ outbox_id: string }[]>`
      select app.start_sp_write_execution(
        ${receipt.approvalId}::uuid,
        ${proof.plan.id}::uuid
      )::text as outbox_id
    `);
    const [secondStart] = await asServiceRole(database, async (sql) => sql<{ outbox_id: string }[]>`
      select app.start_sp_write_execution(
        ${receipt.approvalId}::uuid,
        ${proof.plan.id}::uuid
      )::text as outbox_id
    `);
    expect(secondStart).toEqual(firstStart);

    await expect(asServiceRole(database, async (sql) => sql`
      select * from app.acquire_sp_write_dispatch_lease(
        ${receipt.executionId}::uuid,
        ${proof.plan.id}::uuid,
        ${receipt.generation}::uuid,
        'sp.v3.keywords.update',
        69
      )
    `)).rejects.toThrow(/between 70 and 300/i);
    const lease = await asServiceRole(database, async (sql) => sql<{
      lease_id: string;
      acquired_at: string;
      expires_at: string;
    }[]>`
      select * from app.acquire_sp_write_dispatch_lease(
        ${receipt.executionId}::uuid,
        ${proof.plan.id}::uuid,
        ${receipt.generation}::uuid,
        'sp.v3.keywords.update',
        70
      )
    `);
    expect(lease).toHaveLength(1);
    expect(Date.parse(lease[0]!.expires_at) - Date.parse(lease[0]!.acquired_at)).toBe(70_000);
  });
});

describe.skipIf(!available)('SP write reservation concurrency', () => {
  let database: TestDatabase;
  let proof: ReturnType<typeof keywordPlan>;
  let receipt: ReturnType<typeof SpWriteAuthorizationReceipt.parse>;
  let leaseId: string;

  beforeAll(async () => {
    database = await createWp187TestDatabase('sp_write_reservation');
    const [seed] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('sp-race', ${uuid(20_001)}::uuid, 'owner')
    `;
    const [profile] = await database.sql<{
      id: string;
      connection_id: string;
      amazon_profile_id: string;
    }[]>`
      select id, connection_id, amazon_profile_id
        from public.ad_profiles
       where org_id = ${seed?.seed_tenant_fixture ?? null}::uuid
    `;
    if (!seed || !profile) throw new Error('SP reservation tenant was not seeded');
    proof = keywordPlan(
      seed.seed_tenant_fixture,
      profile.id,
      profile.connection_id,
      profile.amazon_profile_id,
      uuid(20_002),
    );
    await asServiceRole(database, async (sql) => sql`
      select app.record_sp_write_plan(
        ${JSON.stringify(proof.plan)},
        ${proof.planPreimage},
        ${JSON.stringify([{
          artifactText: JSON.stringify(proof.action),
          fingerprintPreimage: proof.actionPreimage,
        }])}::jsonb
      )
    `);

    await database.sql.begin(async (sql) => {
      await sql`
        insert into public.sp_write_environment_gate_versions
          (version_id, enabled, max_unresolved_calls, created_by)
        values (${uuid(20_003)}::uuid, true, 1, ${uuid(20_001)}::uuid)
      `;
      await sql`
        insert into public.sp_write_environment_gate_head (singleton, version_id)
        values (true, ${uuid(20_003)}::uuid)
        on conflict (singleton) do update set version_id = excluded.version_id
      `;
      await sql`
        insert into public.sp_write_profile_grant_versions
          (grant_id, version_id, org_id, profile_id, enabled, amazon_profile_id,
           connection_id, region, marketplace_id, currency_code, api_dialect, created_by)
        values (
          ${uuid(20_004)}::uuid, ${uuid(20_005)}::uuid,
          ${seed.seed_tenant_fixture}::uuid, ${profile.id}::uuid, true,
          ${profile.amazon_profile_id}, ${profile.connection_id}::uuid,
          'NA', 'synthetic-marketplace', 'USD', 'sp_v3', ${uuid(20_001)}::uuid
        )
      `;
      await sql`
        insert into public.sp_write_profile_grant_heads
          (org_id, profile_id, grant_id, version_id)
        values (
          ${seed.seed_tenant_fixture}::uuid, ${profile.id}::uuid,
          ${uuid(20_004)}::uuid, ${uuid(20_005)}::uuid
        )
        on conflict (org_id, profile_id) do update
          set grant_id = excluded.grant_id, version_id = excluded.version_id
      `;
    });

    const request = ApproveSpWritePlan.parse({
      approvalRequestId: uuid(20_006),
      plan: spWritePlanBinding(proof.plan),
      approvalMode: 'manual',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
      boundedAuthorization: null,
      preapprovedInversePlan: null,
    });
    const [approval] = await asUser(database, uuid(20_001), async (sql) => sql<{ receipt: unknown }[]>`
      select app.approve_sp_write_cycle(
        ${proof.plan.id}::uuid,
        ${JSON.stringify(request)}
      ) as receipt
    `);
    receipt = SpWriteAuthorizationReceipt.parse(approval?.receipt);
    await asServiceRole(database, async (sql) => sql`
      select app.start_sp_write_execution(${receipt.approvalId}::uuid, ${proof.plan.id}::uuid)
    `);
    const [lease] = await asServiceRole(database, async (sql) => sql<{ lease_id: string }[]>`
      select lease_id::text
        from app.acquire_sp_write_dispatch_lease(
          ${receipt.executionId}::uuid,
          ${proof.plan.id}::uuid,
          ${receipt.generation}::uuid,
          'sp.v3.keywords.update',
          120
        )
    `);
    if (!lease) throw new Error('SP reservation lease was not acquired');
    leaseId = lease.lease_id;
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('admits exactly one of 50 identical same-call reservations', async () => {
    const [times] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select
        app.sp_write_instant(clock_timestamp()) as observed_at,
        app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!times) throw new Error('SP reservation timestamps were not derived');
    const artifacts = reservationArtifacts(
      proof,
      receipt,
      leaseId,
      times.observed_at,
      times.valid_until,
      20_010,
    );
    const pool = postgres(database.connectionString, {
      max: 50,
      prepare: false,
      onnotice: () => {},
    });
    try {
      const attempts = await Promise.all(Array.from({ length: 50 }, async () => pool.begin(async (sql) => {
        await sql.unsafe('set local role service_role');
        return sql<{ decision: string; result_id: string | null; intent_text: string | null }[]>`
          select decision, result_id::text, intent_text
            from app.reserve_sp_write_provider_call(
              ${receipt.executionId}::uuid,
              ${proof.plan.id}::uuid,
              ${receipt.generation}::uuid,
              ${leaseId}::uuid,
              ${JSON.stringify(artifacts.observation)},
              ${serializeSpWritePredispatchObservationFingerprint(artifacts.observation)},
              ${JSON.stringify(artifacts.intent)},
              ${artifacts.requestPreimage},
              ${artifacts.intentPreimage}
            )
        `;
      })));
      const rows = attempts.flat();
      expect(rows.filter((row) => row.decision === 'won')).toHaveLength(1);
      expect(rows.filter((row) => row.decision === 'already_intended')).toHaveLength(49);
      expect(rows.filter((row) => row.result_id !== null)).toHaveLength(1);
      expect(rows.filter((row) => row.intent_text !== null)).toHaveLength(1);
    } finally {
      await pool.end({ timeout: 5 });
    }

    const [counts] = await database.sql<{
      intents: string;
      positions: string;
      resolutions: string;
      observation_wakes: string;
    }[]>`
      select
        (select count(*) from public.sp_write_provider_call_intents
          where plan_id = ${proof.plan.id}::uuid)::text as intents,
        (select count(*) from public.sp_write_provider_call_positions
          where plan_id = ${proof.plan.id}::uuid)::text as positions,
        (select count(*) from public.sp_write_action_resolutions
          where plan_id = ${proof.plan.id}::uuid)::text as resolutions,
        (select count(*) from public.sp_write_outbox
          where kind = 'observe_and_recover'
            and plan_id = ${proof.plan.id}::uuid)::text as observation_wakes
    `;
    expect(counts).toEqual({
      intents: '1',
      positions: '1',
      resolutions: '1',
      observation_wakes: '1',
    });
  }, 30_000);

  it('returns busy before stale-state evaluation and consumes no second-cycle evidence', async () => {
    const [open] = await database.sql<{ count: string }[]>`
      select count(*)::text as count
        from public.sp_write_provider_call_intents intent
        left join public.sp_write_provider_results result on result.intent_id = intent.intent_id
       where result.intent_id is null
    `;
    if (open?.count === '0') {
      const [times] = await database.sql<{ observed_at: string; valid_until: string }[]>`
        select app.sp_write_instant(clock_timestamp()) as observed_at,
               app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
      `;
      if (!times) throw new Error('SP busy fixture timestamps were not derived');
      const first = reservationArtifacts(
        proof, receipt, leaseId, times.observed_at, times.valid_until, 20_100,
      );
      const [decision] = await asServiceRole(database, async (sql) => sql<{ decision: string }[]>`
        select decision from app.reserve_sp_write_provider_call(
          ${receipt.executionId}::uuid, ${proof.plan.id}::uuid,
          ${receipt.generation}::uuid, ${leaseId}::uuid,
          ${JSON.stringify(first.observation)},
          ${serializeSpWritePredispatchObservationFingerprint(first.observation)},
          ${JSON.stringify(first.intent)}, ${first.requestPreimage}, ${first.intentPreimage}
        )
      `);
      expect(decision?.decision).toBe('won');
    }

    const second = await prepareManualExecution(database, {
      orgId: proof.plan.orgId,
      profileId: proof.plan.profileId,
      connectionId: proof.plan.providerScope.connectionId,
      amazonProfileId: proof.plan.providerScope.amazonProfileId,
      userId: uuid(20_001),
    }, 20_200);
    const [times] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!times) throw new Error('SP busy/stale timestamps were not derived');
    const stale = reservationArtifacts(
      second.proof,
      second.receipt,
      second.leaseId,
      times.observed_at,
      times.valid_until,
      20_210,
      'requested',
    );
    const [decision] = await asServiceRole(database, async (sql) => sql<{
      decision: string;
      refusal_reason: string | null;
    }[]>`
      select decision, refusal_reason
        from app.reserve_sp_write_provider_call(
          ${second.receipt.executionId}::uuid, ${second.proof.plan.id}::uuid,
          ${second.receipt.generation}::uuid, ${second.leaseId}::uuid,
          ${JSON.stringify(stale.observation)},
          ${serializeSpWritePredispatchObservationFingerprint(stale.observation)},
          ${JSON.stringify(stale.intent)}, ${stale.requestPreimage}, ${stale.intentPreimage}
        )
    `);
    expect(decision).toEqual({ decision: 'busy', refusal_reason: null });
    const [counts] = await database.sql<{ evidence: string }[]>`
      select (
        (select count(*) from public.sp_write_predispatch_observations
          where plan_id = ${second.proof.plan.id}::uuid)
        + (select count(*) from public.sp_write_predispatch_dispositions
          where plan_id = ${second.proof.plan.id}::uuid)
        + (select count(*) from public.sp_write_provider_call_intents
          where plan_id = ${second.proof.plan.id}::uuid)
        + (select count(*) from public.sp_write_action_resolutions
          where plan_id = ${second.proof.plan.id}::uuid)
      )::text as evidence
    `;
    expect(counts?.evidence).toBe('0');
  });

  it('accepts result and source-bound observation after gate revocation', async () => {
    const [storedIntent] = await database.sql<{
      artifact: unknown;
      reserved_result_id: string;
      source_sync_job_id: string;
      outbox_id: string;
    }[]>`
      select i.artifact, i.reserved_result_id::text,
             o.source_sync_job_id::text, o.outbox_id::text
        from public.sp_write_provider_call_intents i
        join public.sp_write_outbox o
          on o.org_id = i.org_id and o.profile_id = i.profile_id
         and o.intent_id = i.intent_id and o.kind = 'observe_and_recover'
       where i.plan_id = ${proof.plan.id}::uuid
    `;
    if (!storedIntent) throw new Error('SP winning intent was not recorded');
    expect(storedIntent.source_sync_job_id).not.toBe(storedIntent.outbox_id);
    const intent = SpWriteProviderCallIntent.parse(storedIntent.artifact);

    await database.sql`
      insert into public.sp_write_environment_gate_versions
        (version_id, enabled, max_unresolved_calls, created_by)
      values (${uuid(20_300)}::uuid, false, 1, ${uuid(20_001)}::uuid)
    `;
    await database.sql`
      update public.sp_write_environment_gate_head
         set version_id = ${uuid(20_300)}::uuid
       where singleton
    `;

    const [resultTime] = await database.sql<{ completed_at: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as completed_at
    `;
    if (!resultTime) throw new Error('SP result completion time was not derived');
    const result = acceptedProviderResult(
      intent,
      storedIntent.reserved_result_id,
      resultTime.completed_at,
    );
    const resultPreimage = serializeSpWriteProviderResultFingerprint(result);
    const [recorded] = await asServiceRole(database, async (sql) => sql<{ outcome: string }[]>`
      select app.append_sp_write_provider_result(
        ${JSON.stringify(result)}, ${resultPreimage}, 'provider_adapter'
      ) as outcome
    `);
    expect(recorded?.outcome).toBe('recorded');
    const [idempotent] = await asServiceRole(database, async (sql) => sql<{ outcome: string }[]>`
      select app.append_sp_write_provider_result(
        ${JSON.stringify(result)}, ${resultPreimage}, 'provider_adapter'
      ) as outcome
    `);
    expect(idempotent?.outcome).toBe('already_recorded');

    const [observationTime] = await database.sql<{ observed_at: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at
    `;
    if (!observationTime) throw new Error('SP observation time was not derived');
    const observation = requestedObservation(
      proof,
      receipt,
      intent,
      storedIntent.source_sync_job_id,
      observationTime.observed_at,
      uuid(20_301),
    );
    const [observationId] = await asServiceRole(database, async (sql) => sql<{ observation_id: string }[]>`
      select app.append_sp_write_observation(
        ${JSON.stringify(observation)},
        ${serializeSpWriteObservationFingerprint(observation)}
      )::text as observation_id
    `);
    expect(observationId?.observation_id).toBe(observation.observationId);

    const [accounting] = await database.sql<{
      approved_rows: number;
      intent_committed: number;
      provider_accepted: number;
      observed_requested: number;
      pending_observation: number;
      provider_calls_committed: number;
      provider_calls_completed: number;
      status: string;
    }[]>`
      select approved_rows, intent_committed, provider_accepted,
             observed_requested, pending_observation,
             provider_calls_committed, provider_calls_completed, status
        from public.sp_write_execution_accounting
       where execution_id = ${receipt.executionId}::uuid
         and plan_id = ${proof.plan.id}::uuid
    `;
    expect(accounting).toEqual({
      approved_rows: 1,
      intent_committed: 1,
      provider_accepted: 1,
      observed_requested: 1,
      pending_observation: 0,
      provider_calls_committed: 1,
      provider_calls_completed: 1,
      status: 'succeeded',
    });
    expect((await expectAccountingMatchesShared(
      database, receipt.executionId, proof.plan.id,
    )).status).toBe('succeeded');
  });
});

describe.skipIf(!available)('SP write global capacity', () => {
  let database: TestDatabase;
  let tenantA: SpTenant;
  let tenantB: SpTenant;

  beforeAll(async () => {
    database = await createWp187TestDatabase('sp_write_global_capacity');
    const seedTenant = async (slug: string, userId: string): Promise<SpTenant> => {
      const [seed] = await database.sql<{ seed_tenant_fixture: string }[]>`
        select app.seed_tenant_fixture(${slug}, ${userId}::uuid, 'owner')
      `;
      const [profile] = await database.sql<{
        id: string;
        connection_id: string;
        amazon_profile_id: string;
      }[]>`
        select id, connection_id, amazon_profile_id
          from public.ad_profiles
         where org_id = ${seed?.seed_tenant_fixture ?? null}::uuid
      `;
      if (!seed || !profile) throw new Error('SP capacity tenant was not seeded');
      return {
        orgId: seed.seed_tenant_fixture,
        profileId: profile.id,
        connectionId: profile.connection_id,
        amazonProfileId: profile.amazon_profile_id,
        userId,
      };
    };
    tenantA = await seedTenant('sp-capacity-a', uuid(25_001));
    tenantB = await seedTenant('sp-capacity-b', uuid(25_002));
    await enableTestAuthority(database, tenantA, 25_010);
    await database.sql.begin(async (sql) => {
      await sql`
        insert into public.sp_write_profile_grant_versions
          (grant_id, version_id, org_id, profile_id, enabled, amazon_profile_id,
           connection_id, region, marketplace_id, currency_code, api_dialect, created_by)
        values (
          ${uuid(25_013)}::uuid, ${uuid(25_014)}::uuid,
          ${tenantB.orgId}::uuid, ${tenantB.profileId}::uuid, true,
          ${tenantB.amazonProfileId}, ${tenantB.connectionId}::uuid,
          'NA', 'synthetic-marketplace', 'USD', 'sp_v3', ${tenantB.userId}::uuid
        )
      `;
      await sql`
        insert into public.sp_write_profile_grant_heads
          (org_id, profile_id, grant_id, version_id)
        values (
          ${tenantB.orgId}::uuid, ${tenantB.profileId}::uuid,
          ${uuid(25_013)}::uuid, ${uuid(25_014)}::uuid
        )
        on conflict (org_id, profile_id) do update
          set grant_id = excluded.grant_id, version_id = excluded.version_id
      `;
    });
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('admits one global winner, then preserves the accepted entity fence', async () => {
    const cycleA = await prepareManualExecution(database, tenantA, 25_100);
    const cycleB = await prepareManualExecution(database, tenantB, 25_200);
    const [times] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!times) throw new Error('SP capacity timestamps were not derived');
    const artifactsA = reservationArtifacts(
      cycleA.proof, cycleA.receipt, cycleA.leaseId,
      times.observed_at, times.valid_until, 25_300,
    );
    const artifactsB = reservationArtifacts(
      cycleB.proof, cycleB.receipt, cycleB.leaseId,
      times.observed_at, times.valid_until, 25_400,
    );
    const pool = postgres(database.connectionString, { max: 2, prepare: false, onnotice: () => {} });
    const reserve = async (
      cycle: Awaited<ReturnType<typeof prepareManualExecution>>,
      artifacts: ReturnType<typeof reservationArtifacts>,
    ) => pool.begin(async (sql) => {
      await sql.unsafe('set local role service_role');
      return sql<{ decision: string; result_id: string | null }[]>`
        select decision, result_id::text
          from app.reserve_sp_write_provider_call(
            ${cycle.receipt.executionId}::uuid, ${cycle.proof.plan.id}::uuid,
            ${cycle.receipt.generation}::uuid, ${cycle.leaseId}::uuid,
            ${JSON.stringify(artifacts.observation)},
            ${serializeSpWritePredispatchObservationFingerprint(artifacts.observation)},
            ${JSON.stringify(artifacts.intent)},
            ${artifacts.requestPreimage}, ${artifacts.intentPreimage}
          )
      `;
    });
    let winnerCycle: typeof cycleA;
    let winnerArtifacts: typeof artifactsA;
    try {
      const calls = await Promise.all([
        reserve(cycleA, artifactsA),
        reserve(cycleB, artifactsB),
      ]);
      const rows = calls.flat();
      expect(rows.filter((row) => row.decision === 'won')).toHaveLength(1);
      expect(rows.filter((row) => row.decision === 'busy')).toHaveLength(1);
      expect(rows.filter((row) => row.result_id !== null)).toHaveLength(1);
      if (calls[0]?.[0]?.decision === 'won') {
        winnerCycle = cycleA;
        winnerArtifacts = artifactsA;
      } else {
        winnerCycle = cycleB;
        winnerArtifacts = artifactsB;
      }
    } finally {
      await pool.end({ timeout: 5 });
    }
    const [count] = await database.sql<{ intents: string }[]>`
      select count(*)::text as intents
        from public.sp_write_provider_call_intents
       where plan_id in (${cycleA.proof.plan.id}::uuid, ${cycleB.proof.plan.id}::uuid)
    `;
    expect(count?.intents).toBe('1');

    const [completed] = await database.sql<{ completed_at: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as completed_at
    `;
    if (!completed) throw new Error('SP capacity result time was not derived');
    const providerResult = acceptedProviderResult(
      winnerArtifacts.intent,
      reservedResultId(winnerArtifacts.intent.intentId),
      completed.completed_at,
    );
    const [recorded] = await asServiceRole(database, async (sql) => sql<{ outcome: string }[]>`
      select app.append_sp_write_provider_result(
        ${JSON.stringify(providerResult)},
        ${serializeSpWriteProviderResultFingerprint(providerResult)},
        'provider_adapter'
      ) as outcome
    `);
    expect(recorded?.outcome).toBe('recorded');
    expect((await expectAccountingMatchesShared(
      database, winnerCycle.receipt.executionId, winnerCycle.proof.plan.id,
    )).status).toBe('awaiting_observation');

    const winnerTenant = winnerCycle.proof.plan.orgId === tenantA.orgId ? tenantA : tenantB;
    const nextCycle = await prepareManualExecution(database, winnerTenant, 25_500);
    const [nextTimes] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!nextTimes) throw new Error('SP entity-fence timestamps were not derived');
    const nextArtifacts = reservationArtifacts(
      nextCycle.proof, nextCycle.receipt, nextCycle.leaseId,
      nextTimes.observed_at, nextTimes.valid_until, 25_600,
    );
    const [entityBusy] = await asServiceRole(database, async (sql) => sql<{
      decision: string;
      refusal_reason: string | null;
      result_id: string | null;
    }[]>`
      select decision, refusal_reason, result_id::text
        from app.reserve_sp_write_provider_call(
          ${nextCycle.receipt.executionId}::uuid, ${nextCycle.proof.plan.id}::uuid,
          ${nextCycle.receipt.generation}::uuid, ${nextCycle.leaseId}::uuid,
          ${JSON.stringify(nextArtifacts.observation)},
          ${serializeSpWritePredispatchObservationFingerprint(nextArtifacts.observation)},
          ${JSON.stringify(nextArtifacts.intent)},
          ${nextArtifacts.requestPreimage}, ${nextArtifacts.intentPreimage}
        )
    `);
    expect(entityBusy).toEqual({ decision: 'busy', refusal_reason: null, result_id: null });
    const [entityFenceCounts] = await database.sql<{
      intents: number;
      resolutions: number;
      observations: number;
    }[]>`
      select
        (select count(*)::int from public.sp_write_provider_call_intents
          where plan_id = ${nextCycle.proof.plan.id}::uuid) as intents,
        (select count(*)::int from public.sp_write_action_resolutions
          where plan_id = ${nextCycle.proof.plan.id}::uuid) as resolutions,
        (select count(*)::int from public.sp_write_predispatch_observations
          where plan_id = ${nextCycle.proof.plan.id}::uuid) as observations
    `;
    expect(entityFenceCounts).toEqual({ intents: 0, resolutions: 0, observations: 0 });

    const [wake] = await database.sql<{ source_sync_job_id: string; observed_at: string }[]>`
      select source_sync_job_id::text,
             app.sp_write_instant(clock_timestamp()) as observed_at
        from public.sp_write_outbox
       where intent_id = ${winnerArtifacts.intent.intentId}::uuid
    `;
    if (!wake) throw new Error('SP entity-fence observation wake is missing');
    const terminalObservation = requestedObservation(
      winnerCycle.proof,
      winnerCycle.receipt,
      winnerArtifacts.intent,
      wake.source_sync_job_id,
      wake.observed_at,
      uuid(25_610),
    );
    await asServiceRole(database, async (sql) => sql`
      select app.append_sp_write_observation(
        ${JSON.stringify(terminalObservation)},
        ${serializeSpWriteObservationFingerprint(terminalObservation)}
      )
    `);
    const [afterObservation] = await asServiceRole(database, async (sql) => sql<{
      decision: string;
      refusal_reason: string | null;
      result_id: string | null;
    }[]>`
      select decision, refusal_reason, result_id::text
        from app.reserve_sp_write_provider_call(
          ${nextCycle.receipt.executionId}::uuid, ${nextCycle.proof.plan.id}::uuid,
          ${nextCycle.receipt.generation}::uuid, ${nextCycle.leaseId}::uuid,
          ${JSON.stringify(nextArtifacts.observation)},
          ${serializeSpWritePredispatchObservationFingerprint(nextArtifacts.observation)},
          ${JSON.stringify(nextArtifacts.intent)},
          ${nextArtifacts.requestPreimage}, ${nextArtifacts.intentPreimage}
        )
    `);
    expect(afterObservation).toEqual({
      decision: 'won',
      refusal_reason: null,
      result_id: reservedResultId(nextArtifacts.intent.intentId),
    });
    const [releasedCounts] = await database.sql<{
      intents: number;
      resolutions: number;
      observations: number;
    }[]>`
      select
        (select count(*)::int from public.sp_write_provider_call_intents
          where plan_id = ${nextCycle.proof.plan.id}::uuid) as intents,
        (select count(*)::int from public.sp_write_action_resolutions
          where plan_id = ${nextCycle.proof.plan.id}::uuid) as resolutions,
        (select count(*)::int from public.sp_write_predispatch_observations
          where plan_id = ${nextCycle.proof.plan.id}::uuid) as observations
    `;
    expect(releasedCounts).toEqual({ intents: 1, resolutions: 1, observations: 1 });
  });

  it('permits only one bounded cycle across two authorized profiles', async () => {
    const forwardA = keywordPlan(
      tenantA.orgId, tenantA.profileId, tenantA.connectionId, tenantA.amazonProfileId,
      uuid(25_700),
    );
    const inverseA = inverseKeywordPlan(
      forwardA, uuid(25_701), uuid(25_702), uuid(25_703),
    );
    const forwardB = keywordPlan(
      tenantB.orgId, tenantB.profileId, tenantB.connectionId, tenantB.amazonProfileId,
      uuid(25_710),
    );
    const inverseB = inverseKeywordPlan(
      forwardB, uuid(25_711), uuid(25_712), uuid(25_713),
    );
    for (const proof of [forwardA, inverseA, forwardB, inverseB]) {
      await asServiceRole(database, async (sql) => sql`
        select app.record_sp_write_plan(
          ${JSON.stringify(proof.plan)}, ${proof.planPreimage},
          ${JSON.stringify([{
            artifactText: JSON.stringify(proof.action),
            fingerprintPreimage: proof.actionPreimage,
          }])}::jsonb
        )
      `);
    }
    const seedAuthorization = boundedAuthorization(forwardA.plan, uuid(25_720));
    const authorizationBase = SpWriteBoundedAuthorization.parse({
      ...seedAuthorization,
      profiles: [forwardA.plan, forwardB.plan].map((plan) => ({
        providerScope: plan.providerScope,
        allowedEntities: [{
          routeKey: 'sp.v3.keywords.update',
          amazonEntityId: 'kw-1',
          allowedChangeKeys: ['keyword.bid'],
          maxAbsoluteMoneyDelta: '0.1',
          maxAbsolutePlacementDelta: null,
        }],
      })),
      fingerprint: '0'.repeat(64),
    });
    const authorization = SpWriteBoundedAuthorization.parse({
      ...authorizationBase,
      fingerprint: sha256(serializeSpWriteBoundedAuthorizationFingerprint(authorizationBase)),
    });
    await asServiceRole(database, async (sql) => sql`
      select app.record_sp_write_bounded_authorization(
        ${JSON.stringify(authorization)},
        ${serializeSpWriteBoundedAuthorizationFingerprint(authorization)},
        ${JSON.stringify([
          { orgId: tenantA.orgId, profileId: tenantA.profileId },
          { orgId: tenantB.orgId, profileId: tenantB.profileId },
        ])}::jsonb
      )
    `);
    const requestFor = (
      requestId: string,
      forward: ReturnType<typeof keywordPlan>,
      inverse: ReturnType<typeof inverseKeywordPlan>,
    ) => ApproveSpWritePlan.parse({
      approvalRequestId: requestId,
      plan: spWritePlanBinding(forward.plan),
      approvalMode: 'bounded_live_test',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
      boundedAuthorization: {
        authorizationId: authorization.authorizationId,
        authorizationFingerprint: authorization.fingerprint,
        expiresAt: authorization.expiresAt,
      },
      preapprovedInversePlan: spWritePlanBinding(inverse.plan),
    });
    const requestA = requestFor(uuid(25_721), forwardA, inverseA);
    const [approvedA] = await asUser(database, tenantA.userId, async (sql) => sql<{ receipt: unknown }[]>`
      select app.approve_sp_write_cycle(${forwardA.plan.id}::uuid, ${JSON.stringify(requestA)})
        as receipt
    `);
    expect(SpWriteAuthorizationReceipt.parse(approvedA?.receipt).executionId)
      .toBe(inverseA.sourceExecutionId);

    const requestB = requestFor(uuid(25_722), forwardB, inverseB);
    await expect(asUser(database, tenantB.userId, async (sql) => sql`
      select app.approve_sp_write_cycle(${forwardB.plan.id}::uuid, ${JSON.stringify(requestB)})
    `)).rejects.toThrow(/already consumed its cycle|maxCycles/i);
    const [blocked] = await database.sql<{ requests: number; receipts: number; cycles: number }[]>`
      select
        (select count(*)::int from public.sp_write_approval_requests
          where approval_request_id = ${requestB.approvalRequestId}::uuid) as requests,
        (select count(*)::int from public.sp_write_authorization_receipts
          where approval_request_id = ${requestB.approvalRequestId}::uuid) as receipts,
        (select count(*)::int from public.sp_write_execution_cycles
          where execution_id = ${inverseB.sourceExecutionId}::uuid) as cycles
    `;
    expect(blocked).toEqual({ requests: 0, receipts: 0, cycles: 0 });
  });

  it('serializes bounded single-use approval in both profile commit orders', async () => {
    const prepareRace = async (seed: number) => {
      const forwardA = keywordPlan(
        tenantA.orgId,
        tenantA.profileId,
        tenantA.connectionId,
        tenantA.amazonProfileId,
        uuid(seed),
      );
      const inverseA = inverseKeywordPlan(
        forwardA,
        uuid(seed + 1),
        uuid(seed + 2),
        uuid(seed + 3),
      );
      const forwardB = keywordPlan(
        tenantB.orgId,
        tenantB.profileId,
        tenantB.connectionId,
        tenantB.amazonProfileId,
        uuid(seed + 4),
      );
      const inverseB = inverseKeywordPlan(
        forwardB,
        uuid(seed + 5),
        uuid(seed + 6),
        uuid(seed + 7),
      );
      for (const proof of [forwardA, inverseA, forwardB, inverseB]) {
        await asServiceRole(database, async (sql) => sql`
          select app.record_sp_write_plan(
            ${JSON.stringify(proof.plan)},
            ${proof.planPreimage},
            ${JSON.stringify([{
              artifactText: JSON.stringify(proof.action),
              fingerprintPreimage: proof.actionPreimage,
            }])}::jsonb
          )
        `);
      }
      const initial = boundedAuthorization(forwardA.plan, uuid(seed + 8));
      const base = SpWriteBoundedAuthorization.parse({
        ...initial,
        profiles: [forwardA.plan, forwardB.plan].map((plan) => ({
          providerScope: plan.providerScope,
          allowedEntities: [{
            routeKey: 'sp.v3.keywords.update',
            amazonEntityId: 'kw-1',
            allowedChangeKeys: ['keyword.bid'],
            maxAbsoluteMoneyDelta: '0.1',
            maxAbsolutePlacementDelta: null,
          }],
        })),
        fingerprint: '0'.repeat(64),
      });
      const authorization = SpWriteBoundedAuthorization.parse({
        ...base,
        fingerprint: sha256(serializeSpWriteBoundedAuthorizationFingerprint(base)),
      });
      await asServiceRole(database, async (sql) => sql`
        select app.record_sp_write_bounded_authorization(
          ${JSON.stringify(authorization)},
          ${serializeSpWriteBoundedAuthorizationFingerprint(authorization)},
          ${JSON.stringify([
            { orgId: tenantA.orgId, profileId: tenantA.profileId },
            { orgId: tenantB.orgId, profileId: tenantB.profileId },
          ])}::jsonb
        )
      `);
      const request = (
        requestId: string,
        forward: ReturnType<typeof keywordPlan>,
        inverse: ReturnType<typeof inverseKeywordPlan>,
      ) => ApproveSpWritePlan.parse({
        approvalRequestId: requestId,
        plan: spWritePlanBinding(forward.plan),
        approvalMode: 'bounded_live_test',
        confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
        boundedAuthorization: {
          authorizationId: authorization.authorizationId,
          authorizationFingerprint: authorization.fingerprint,
          expiresAt: authorization.expiresAt,
        },
        preapprovedInversePlan: spWritePlanBinding(inverse.plan),
      });
      return {
        authorization,
        contenders: {
          A: {
            tenant: tenantA,
            forward: forwardA,
            inverse: inverseA,
            request: request(uuid(seed + 9), forwardA, inverseA),
          },
          B: {
            tenant: tenantB,
            forward: forwardB,
            inverse: inverseB,
            request: request(uuid(seed + 10), forwardB, inverseB),
          },
        },
      };
    };

    const runOrder = async (seed: number, winnerKey: 'A' | 'B') => {
      const race = await prepareRace(seed);
      const loserKey = winnerKey === 'A' ? 'B' : 'A';
      const winner = race.contenders[winnerKey];
      const loser = race.contenders[loserKey];
      const winnerPool = postgres(
        database.connectionString,
        { max: 1, prepare: false, onnotice: () => {} },
      );
      const loserPool = postgres(
        database.connectionString,
        { max: 1, prepare: false, onnotice: () => {} },
      );
      let approvedResolve!: (receipt: unknown) => void;
      let releaseResolve!: () => void;
      const approved = new Promise<unknown>((resolve) => { approvedResolve = resolve; });
      const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
      const winnerTransaction = winnerPool.begin(async (sql) => {
        await sql`select set_config(
          'request.jwt.claims',
          ${JSON.stringify({ sub: winner.tenant.userId, role: 'authenticated' })},
          true
        )`;
        await sql.unsafe('set local role authenticated');
        const [row] = await sql<{ receipt: unknown }[]>`
          select app.approve_sp_write_cycle(
            ${winner.forward.plan.id}::uuid,
            ${JSON.stringify(winner.request)}
          ) as receipt
        `;
        if (!row) throw new Error('SP bounded race winner produced no receipt');
        approvedResolve(row.receipt);
        await release;
      });
      const winnerReceipt = SpWriteAuthorizationReceipt.parse(await approved);

      let loserPidResolve!: (pid: number) => void;
      const loserPid = new Promise<number>((resolve) => { loserPidResolve = resolve; });
      const loserTransaction = loserPool.begin(async (sql) => {
        await sql`select set_config(
          'request.jwt.claims',
          ${JSON.stringify({ sub: loser.tenant.userId, role: 'authenticated' })},
          true
        )`;
        await sql.unsafe('set local role authenticated');
        const [backend] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
        if (!backend) throw new Error('SP bounded race loser PID is missing');
        loserPidResolve(backend.pid);
        return sql`
          select app.approve_sp_write_cycle(
            ${loser.forward.plan.id}::uuid,
            ${JSON.stringify(loser.request)}
          )
        `;
      });
      const loserOutcome = loserTransaction.then(
        () => ({ status: 'fulfilled' as const, error: null }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      const pid = await loserPid;
      let blocked = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [activity] = await database.sql<{
          state: string;
          wait_event_type: string | null;
          query: string;
        }[]>`
          select state, wait_event_type, query from pg_stat_activity where pid = ${pid}
        `;
        if (activity?.state === 'active'
          && activity.wait_event_type === 'Lock'
          && activity.query.includes('approve_sp_write_cycle')) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked, `${winnerKey}-first loser must wait on bounded authority`).toBe(true);
      releaseResolve();
      await winnerTransaction;
      const outcome = await loserOutcome;
      expect(outcome.status).toBe('rejected');
      expect(String(outcome.error)).toMatch(/already consumed its cycle|maxCycles/i);
      await Promise.all([
        winnerPool.end({ timeout: 5 }),
        loserPool.end({ timeout: 5 }),
      ]);

      const [closure] = await database.sql<{
        consumptions: number;
        consumption_execution_id: string;
        winner_requests: number;
        winner_receipts: number;
        winner_cycles: number;
        loser_requests: number;
        loser_receipts: number;
        loser_cycles: number;
      }[]>`
        select
          (select count(*)::int from public.sp_write_bounded_authorization_consumptions
            where authorization_id = ${race.authorization.authorizationId}::uuid)
            as consumptions,
          (select execution_id::text from public.sp_write_bounded_authorization_consumptions
            where authorization_id = ${race.authorization.authorizationId}::uuid)
            as consumption_execution_id,
          (select count(*)::int from public.sp_write_approval_requests
            where approval_request_id = ${winner.request.approvalRequestId}::uuid)
            as winner_requests,
          (select count(*)::int from public.sp_write_authorization_receipts
            where approval_request_id = ${winner.request.approvalRequestId}::uuid)
            as winner_receipts,
          (select count(*)::int from public.sp_write_execution_cycles
            where execution_id = ${winner.inverse.sourceExecutionId}::uuid)
            as winner_cycles,
          (select count(*)::int from public.sp_write_approval_requests
            where approval_request_id = ${loser.request.approvalRequestId}::uuid)
            as loser_requests,
          (select count(*)::int from public.sp_write_authorization_receipts
            where approval_request_id = ${loser.request.approvalRequestId}::uuid)
            as loser_receipts,
          (select count(*)::int from public.sp_write_execution_cycles
            where execution_id = ${loser.inverse.sourceExecutionId}::uuid)
            as loser_cycles
      `;
      expect(closure).toEqual({
        consumptions: 1,
        consumption_execution_id: winnerReceipt.executionId,
        winner_requests: 1,
        winner_receipts: 1,
        winner_cycles: 1,
        loser_requests: 0,
        loser_receipts: 0,
        loser_cycles: 0,
      });
    };

    await runOrder(25_800, 'A');
    await runOrder(25_900, 'B');
  }, 30_000);
});

describe.skipIf(!available)('SP write result recovery', () => {
  let database: TestDatabase;
  let tenant: SpTenant;

  beforeAll(async () => {
    database = await createWp187TestDatabase('sp_write_recovery');
    const userId = uuid(27_001);
    const [seed] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('sp-recovery', ${userId}::uuid, 'owner')
    `;
    const [profile] = await database.sql<{
      id: string;
      connection_id: string;
      amazon_profile_id: string;
    }[]>`
      select id, connection_id, amazon_profile_id
        from public.ad_profiles
       where org_id = ${seed?.seed_tenant_fixture ?? null}::uuid
    `;
    if (!seed || !profile) throw new Error('SP recovery tenant was not seeded');
    tenant = {
      orgId: seed.seed_tenant_fixture,
      profileId: profile.id,
      connectionId: profile.connection_id,
      amazonProfileId: profile.amazon_profile_id,
      userId,
    };
    await enableTestAuthority(database, tenant, 27_010);
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  async function reserveAndExpire(seed: number) {
    const cycle = await prepareManualExecution(database, tenant, seed);
    const [times] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!times) throw new Error('SP recovery reservation timestamps were not derived');
    const artifacts = reservationArtifacts(
      cycle.proof, cycle.receipt, cycle.leaseId,
      times.observed_at, times.valid_until, seed + 10,
    );
    const [reservation] = await asServiceRole(database, async (sql) => sql<{
      decision: string;
      result_id: string;
    }[]>`
      select decision, result_id::text
        from app.reserve_sp_write_provider_call(
          ${cycle.receipt.executionId}::uuid, ${cycle.proof.plan.id}::uuid,
          ${cycle.receipt.generation}::uuid, ${cycle.leaseId}::uuid,
          ${JSON.stringify(artifacts.observation)},
          ${serializeSpWritePredispatchObservationFingerprint(artifacts.observation)},
          ${JSON.stringify(artifacts.intent)},
          ${artifacts.requestPreimage}, ${artifacts.intentPreimage}
        )
    `);
    expect(reservation).toMatchObject({ decision: 'won' });
    const [earlyTime] = await database.sql<{ completed_at: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as completed_at
    `;
    if (!earlyTime || !reservation) throw new Error('SP recovery result identity was not derived');
    const earlyRecovery = ambiguousProviderResult(
      artifacts.intent, reservation.result_id, earlyTime.completed_at,
    );
    await expect(asServiceRole(database, async (sql) => sql`
      select app.append_sp_write_provider_result(
        ${JSON.stringify(earlyRecovery)},
        ${serializeSpWriteProviderResultFingerprint(earlyRecovery)},
        'recovery_synthesized'
      )
    `)).rejects.toThrow(/not yet eligible/i);
    const [earlyCount] = await database.sql<{ count: number }[]>`
      select count(*)::int as count from public.sp_write_provider_results
       where intent_id = ${artifacts.intent.intentId}::uuid
    `;
    expect(earlyCount?.count).toBe(0);

    // Test-only clock advancement in this disposable database. The invariants
    // remain checked; replica mode only bypasses append-only triggers while
    // aging already-valid rows into the recovery eligibility window.
    await database.sql.begin(async (sql) => {
      await sql.unsafe("set local session_replication_role = 'replica'");
      await sql`
        update public.sp_write_dispatch_leases
           set acquired_at = clock_timestamp() - interval '3 minutes',
               expires_at = clock_timestamp() - interval '1 minute'
         where lease_id = ${cycle.leaseId}::uuid
      `;
      await sql`
        with aged as (
          select clock_timestamp() - interval '2 minutes' as checked_at
        )
        update public.sp_write_provider_call_intents
           set recorded_at = aged.checked_at,
               checked_at = aged.checked_at,
               dispatch_start_deadline = aged.checked_at + interval '5 seconds',
               provider_attempt_deadline = aged.checked_at + interval '35 seconds'
          from aged
         where intent_id = ${artifacts.intent.intentId}::uuid
      `;
    });
    const [completed] = await database.sql<{ completed_at: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as completed_at
    `;
    if (!completed) throw new Error('SP eligible recovery time was not derived');
    return {
      ...cycle,
      artifacts,
      resultId: reservation.result_id,
      provider: acceptedProviderResult(
        artifacts.intent, reservation.result_id, completed.completed_at,
      ),
      recovery: ambiguousProviderResult(
        artifacts.intent, reservation.result_id, completed.completed_at,
      ),
    };
  }

  it('fences provider/recovery races and audits a verified late provider result', async () => {
    const raced = await reserveAndExpire(27_100);
    const pool = postgres(database.connectionString, { max: 2, prepare: false, onnotice: () => {} });
    const append = async (
      result: ReturnType<typeof SpWriteProviderResult.parse>,
      origin: 'provider_adapter' | 'recovery_synthesized',
    ) => pool.begin(async (sql) => {
      await sql.unsafe('set local role service_role');
      const [row] = await sql<{ outcome: string }[]>`
        select app.append_sp_write_provider_result(
          ${JSON.stringify(result)},
          ${serializeSpWriteProviderResultFingerprint(result)},
          ${origin}::public.sp_write_result_origin
        ) as outcome
      `;
      return row?.outcome ?? '';
    });
    let outcomes: string[];
    try {
      outcomes = await Promise.all([
        append(raced.provider, 'provider_adapter'),
        append(raced.recovery, 'recovery_synthesized'),
      ]);
    } finally {
      await pool.end({ timeout: 5 });
    }
    expect(outcomes).toContain('recorded');
    expect(outcomes.some((outcome) =>
      outcome === 'late_audited' || outcome === 'canonical_result_already_recorded')).toBe(true);
    const [raceClosure] = await database.sql<{
      results: number;
      positions: number;
      audits: number;
      origin: string;
    }[]>`
      select
        count(distinct result.result_id)::int as results,
        count(distinct position.action_id)::int as positions,
        count(distinct audit.audit_id)::int as audits,
        min(result.origin::text) as origin
      from public.sp_write_provider_results result
      join public.sp_write_provider_result_positions position
        on position.intent_id = result.intent_id and position.result_id = result.result_id
      left join public.sp_write_late_result_audits audit on audit.intent_id = result.intent_id
      where result.intent_id = ${raced.artifacts.intent.intentId}::uuid
    `;
    expect(raceClosure).toMatchObject({ results: 1, positions: 1 });
    expect(raceClosure?.audits).toBe(raceClosure?.origin === 'recovery_synthesized' ? 1 : 0);

    const [wake] = await database.sql<{ source_sync_job_id: string; observed_at: string }[]>`
      select source_sync_job_id::text,
             app.sp_write_instant(clock_timestamp()) as observed_at
        from public.sp_write_outbox
       where intent_id = ${raced.artifacts.intent.intentId}::uuid
    `;
    if (!wake) throw new Error('SP recovery observation wake is missing');
    const reconciled = requestedObservation(
      raced.proof,
      raced.receipt,
      raced.artifacts.intent,
      wake.source_sync_job_id,
      wake.observed_at,
      uuid(27_180),
    );
    await asServiceRole(database, async (sql) => sql`
      select app.append_sp_write_observation(
        ${JSON.stringify(reconciled)},
        ${serializeSpWriteObservationFingerprint(reconciled)}
      )
    `);
    expect(['succeeded', 'observed_after_ambiguous']).toContain(
      (await expectAccountingMatchesShared(
        database, raced.receipt.executionId, raced.proof.plan.id,
      )).status,
    );

    const late = await reserveAndExpire(27_200);
    const [recovered] = await asServiceRole(database, async (sql) => sql<{ outcome: string }[]>`
      select app.append_sp_write_provider_result(
        ${JSON.stringify(late.recovery)},
        ${serializeSpWriteProviderResultFingerprint(late.recovery)},
        'recovery_synthesized'
      ) as outcome
    `);
    expect(recovered?.outcome).toBe('recorded');
    const invalidLateBase = SpWriteProviderResult.parse({
      ...late.provider,
      positions: [{
        ...late.provider.positions[0]!,
        actionRequestFingerprint: 'e'.repeat(64),
      }],
      fingerprint: '0'.repeat(64),
    });
    const invalidLate = SpWriteProviderResult.parse({
      ...invalidLateBase,
      fingerprint: sha256(serializeSpWriteProviderResultFingerprint(invalidLateBase)),
    });
    await expect(asServiceRole(database, async (sql) => sql`
      select app.append_sp_write_provider_result(
        ${JSON.stringify(invalidLate)},
        ${serializeSpWriteProviderResultFingerprint(invalidLate)},
        'provider_adapter'
      )
    `)).rejects.toThrow(/position does not match its intent/i);
    const [invalidAudit] = await database.sql<{ count: number }[]>`
      select count(*)::int as count from public.sp_write_late_result_audits
       where intent_id = ${late.artifacts.intent.intentId}::uuid
    `;
    expect(invalidAudit?.count).toBe(0);
    const [audited] = await asServiceRole(database, async (sql) => sql<{ outcome: string }[]>`
      select app.append_sp_write_provider_result(
        ${JSON.stringify(late.provider)},
        ${serializeSpWriteProviderResultFingerprint(late.provider)},
        'provider_adapter'
      ) as outcome
    `);
    expect(audited?.outcome).toBe('late_audited');
    const [lateAudit] = await database.sql<{
      result_id: string;
      position_count: number;
      diagnostic_codes: string[];
      submitted_fingerprint: string;
    }[]>`
      select result_id::text, position_count, diagnostic_codes, submitted_fingerprint
        from public.sp_write_late_result_audits
       where intent_id = ${late.artifacts.intent.intentId}::uuid
    `;
    expect(lateAudit).toEqual({
      result_id: late.resultId,
      position_count: 1,
      diagnostic_codes: [],
      submitted_fingerprint: late.provider.fingerprint,
    });
    const [lateWake] = await database.sql<{ source_sync_job_id: string; observed_at: string }[]>`
      select source_sync_job_id::text,
             app.sp_write_instant(clock_timestamp()) as observed_at
        from public.sp_write_outbox
       where intent_id = ${late.artifacts.intent.intentId}::uuid
    `;
    if (!lateWake) throw new Error('SP late-result observation wake is missing');
    const lateObservation = actionObservation(
      late.proof.plan,
      late.proof.action,
      late.receipt,
      late.artifacts.intent,
      lateWake.source_sync_job_id,
      lateWake.observed_at,
      uuid(27_239),
      'observed_expected_after_ambiguous',
    );
    await asServiceRole(database, async (sql) => sql`
      select app.append_sp_write_observation(
        ${JSON.stringify(lateObservation)},
        ${serializeSpWriteObservationFingerprint(lateObservation)}
      )
    `);
  });

  it('requires both recovery deadlines and releases only global unresolved capacity', async () => {
    const primary = await reserveWinningManualCycle(database, tenant, 27_240);
    const [originalLease] = await database.sql<{
      acquired_at: string;
      expires_at: string;
    }[]>`
      select acquired_at::text, expires_at::text
        from public.sp_write_dispatch_leases
       where lease_id = ${primary.leaseId}::uuid
    `;
    if (!originalLease) throw new Error('SP independent recovery lease is missing');

    const secondUserId = uuid(27_250);
    const [secondSeed] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('sp-recovery-capacity', ${secondUserId}::uuid, 'owner')
    `;
    const [secondProfile] = await database.sql<{
      id: string;
      connection_id: string;
      amazon_profile_id: string;
    }[]>`
      select id, connection_id, amazon_profile_id
        from public.ad_profiles
       where org_id = ${secondSeed?.seed_tenant_fixture ?? null}::uuid
    `;
    if (!secondSeed || !secondProfile) throw new Error('SP recovery capacity tenant is missing');
    const secondTenant: SpTenant = {
      orgId: secondSeed.seed_tenant_fixture,
      profileId: secondProfile.id,
      connectionId: secondProfile.connection_id,
      amazonProfileId: secondProfile.amazon_profile_id,
      userId: secondUserId,
    };
    await enableTestAuthority(database, secondTenant, 27_260);
    const waiting = await prepareManualExecution(database, secondTenant, 27_270);
    const [waitingTimes] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!waitingTimes) throw new Error('SP recovery capacity timestamps were not derived');
    const waitingArtifacts = reservationArtifacts(
      waiting.proof,
      waiting.receipt,
      waiting.leaseId,
      waitingTimes.observed_at,
      waitingTimes.valid_until,
      27_280,
    );
    const reserveWaiting = () => asServiceRole(database, async (sql) => sql<{
      decision: string;
      result_id: string | null;
    }[]>`
      select decision, result_id::text
        from app.reserve_sp_write_provider_call(
          ${waiting.receipt.executionId}::uuid,
          ${waiting.proof.plan.id}::uuid,
          ${waiting.receipt.generation}::uuid,
          ${waiting.leaseId}::uuid,
          ${JSON.stringify(waitingArtifacts.observation)},
          ${serializeSpWritePredispatchObservationFingerprint(waitingArtifacts.observation)},
          ${JSON.stringify(waitingArtifacts.intent)},
          ${waitingArtifacts.requestPreimage},
          ${waitingArtifacts.intentPreimage}
        )
    `);
    expect(await reserveWaiting()).toEqual([{ decision: 'busy', result_id: null }]);

    const makeRecovery = async () => {
      const [time] = await database.sql<{ completed_at: string }[]>`
        select app.sp_write_instant(clock_timestamp()) as completed_at
      `;
      if (!time) throw new Error('SP independent recovery time is missing');
      return ambiguousProviderResult(
        primary.artifacts.intent,
        primary.resultId,
        time.completed_at,
      );
    };
    const appendRecovery = async () => {
      const recovery = await makeRecovery();
      return asServiceRole(database, async (sql) => sql<{ outcome: string }[]>`
        select app.append_sp_write_provider_result(
          ${JSON.stringify(recovery)},
          ${serializeSpWriteProviderResultFingerprint(recovery)},
          'recovery_synthesized'
        ) as outcome
      `);
    };
    await expect(appendRecovery()).rejects.toThrow(/not yet eligible/i);

    await database.sql.begin(async (sql) => {
      await sql.unsafe("set local session_replication_role = 'replica'");
      await sql`
        with aged as (select clock_timestamp() - interval '2 minutes' as checked_at)
        update public.sp_write_provider_call_intents
           set recorded_at = aged.checked_at,
               checked_at = aged.checked_at,
               dispatch_start_deadline = aged.checked_at + interval '5 seconds',
               provider_attempt_deadline = aged.checked_at + interval '35 seconds'
          from aged
         where intent_id = ${primary.artifacts.intent.intentId}::uuid
      `;
    });
    await expect(appendRecovery()).rejects.toThrow(/not yet eligible/i);

    await database.sql.begin(async (sql) => {
      await sql.unsafe("set local session_replication_role = 'replica'");
      await sql`
        with fresh as (select clock_timestamp() as checked_at)
        update public.sp_write_provider_call_intents
           set recorded_at = fresh.checked_at,
               checked_at = fresh.checked_at,
               dispatch_start_deadline = fresh.checked_at + interval '5 seconds',
               provider_attempt_deadline = fresh.checked_at + interval '35 seconds'
          from fresh
         where intent_id = ${primary.artifacts.intent.intentId}::uuid
      `;
      await sql`
        update public.sp_write_dispatch_leases
           set acquired_at = clock_timestamp() - interval '3 minutes',
               expires_at = clock_timestamp() - interval '1 minute'
         where lease_id = ${primary.leaseId}::uuid
      `;
    });
    await expect(appendRecovery()).rejects.toThrow(/not yet eligible/i);

    await database.sql.begin(async (sql) => {
      await sql.unsafe("set local session_replication_role = 'replica'");
      await sql`
        with aged as (select clock_timestamp() - interval '2 minutes' as checked_at)
        update public.sp_write_provider_call_intents
           set recorded_at = aged.checked_at,
               checked_at = aged.checked_at,
               dispatch_start_deadline = aged.checked_at + interval '5 seconds',
               provider_attempt_deadline = aged.checked_at + interval '35 seconds'
          from aged
         where intent_id = ${primary.artifacts.intent.intentId}::uuid
      `;
    });
    const [recovered] = await appendRecovery();
    expect(recovered?.outcome).toBe('recorded');
    const [storedRecovery] = await database.sql<{ origin: string; results: number }[]>`
      select min(origin::text) as origin, count(*)::int as results
        from public.sp_write_provider_results
       where intent_id = ${primary.artifacts.intent.intentId}::uuid
    `;
    expect(storedRecovery).toEqual({ origin: 'recovery_synthesized', results: 1 });

    const [waitingWinner] = await reserveWaiting();
    expect(waitingWinner?.decision).toBe('won');
    const waitingCycle = {
      ...waiting,
      artifacts: waitingArtifacts,
      resultId: waitingWinner!.result_id!,
    };
    const waitingResult = await appendResultAndReadWake(database, waitingCycle, ['accepted']);
    const waitingObservation = requestedObservation(
      waiting.proof,
      waiting.receipt,
      waitingArtifacts.intent,
      waitingResult.wake.source_sync_job_id,
      waitingResult.wake.observed_at,
      uuid(27_290),
    );
    await asServiceRole(database, async (sql) => sql`
      select app.append_sp_write_observation(
        ${JSON.stringify(waitingObservation)},
        ${serializeSpWriteObservationFingerprint(waitingObservation)}
      )
    `);

    const [primaryWake] = await database.sql<{ source_sync_job_id: string; observed_at: string }[]>`
      select source_sync_job_id::text,
             app.sp_write_instant(clock_timestamp()) as observed_at
        from public.sp_write_outbox
       where intent_id = ${primary.artifacts.intent.intentId}::uuid
    `;
    if (!primaryWake) throw new Error('SP recovered observation wake is missing');
    const primaryObservation = actionObservation(
      primary.proof.plan,
      primary.proof.action,
      primary.receipt,
      primary.artifacts.intent,
      primaryWake.source_sync_job_id,
      primaryWake.observed_at,
      uuid(27_291),
      'observed_expected_after_ambiguous',
    );
    await asServiceRole(database, async (sql) => sql`
      select app.append_sp_write_observation(
        ${JSON.stringify(primaryObservation)},
        ${serializeSpWriteObservationFingerprint(primaryObservation)}
      )
    `);
    expect((await expectAccountingMatchesShared(
      database,
      primary.receipt.executionId,
      primary.proof.plan.id,
    )).status).toBe('ambiguous');

    expect(originalLease.expires_at).not.toBe(originalLease.acquired_at);
  });

  it('audits only a fully verified late provider submission and stores sanitized diagnostics', async () => {
    const late = await reserveAndExpire(27_292);
    const [canonical] = await asServiceRole(database, async (sql) => sql<{ outcome: string }[]>`
      select app.append_sp_write_provider_result(
        ${JSON.stringify(late.recovery)},
        ${serializeSpWriteProviderResultFingerprint(late.recovery)},
        'recovery_synthesized'
      ) as outcome
    `);
    expect(canonical?.outcome).toBe('recorded');

    const rebind = (
      changes: Partial<ReturnType<typeof SpWriteProviderResult.parse>>,
      positionChanges: Partial<ReturnType<typeof SpWriteProviderResult.parse>['positions'][number]>
        = {},
    ) => {
      const base = SpWriteProviderResult.parse({
        ...late.provider,
        ...changes,
        positions: [{ ...late.provider.positions[0]!, ...positionChanges }],
        fingerprint: '0'.repeat(64),
      });
      return SpWriteProviderResult.parse({
        ...base,
        fingerprint: sha256(serializeSpWriteProviderResultFingerprint(base)),
      });
    };
    const invalidSubmissions = [
      rebind({ resultId: uuid(27_293) }),
      rebind({ intentFingerprint: 'e'.repeat(64) }),
      rebind({ providerCallId: uuid(27_294) }),
      rebind({ requestFingerprint: 'e'.repeat(64) }),
      rebind({}, { actionId: uuid(27_295) }),
      rebind({}, { actionRequestFingerprint: 'e'.repeat(64) }),
      rebind({}, { providerEntityId: 'a-different-keyword' }),
    ];
    for (const [index, submission] of invalidSubmissions.entries()) {
      await expect(asServiceRole(database, async (sql) => sql`
        select app.append_sp_write_provider_result(
          ${JSON.stringify(submission)},
          ${serializeSpWriteProviderResultFingerprint(submission)},
          'provider_adapter'
        )
      `), `invalid late submission ${index}`).rejects.toThrow();
      const [auditCount] = await database.sql<{ count: number }[]>`
        select count(*)::int as count from public.sp_write_late_result_audits
         where intent_id = ${late.artifacts.intent.intentId}::uuid
      `;
      expect(auditCount?.count, `invalid late submission ${index}`).toBe(0);
    }
    await expect(asServiceRole(database, async (sql) => sql`
      select app.append_sp_write_provider_result(
        ${JSON.stringify(late.provider)},
        ${`${serializeSpWriteProviderResultFingerprint(late.provider)}\n`},
        'provider_adapter'
      )
    `)).rejects.toThrow(/does not equal|fingerprint mismatch|invalid/i);

    const diagnosticLate = rebind({}, {
      outcome: 'authoritative_rejected',
      providerEntityId: null,
      code: 'synthetic_rejection',
      message: 'synthetic provider detail that must not enter the audit row',
    });
    const appendDiagnostic = () => asServiceRole(database, async (sql) => sql<{
      outcome: string;
    }[]>`
      select app.append_sp_write_provider_result(
        ${JSON.stringify(diagnosticLate)},
        ${serializeSpWriteProviderResultFingerprint(diagnosticLate)},
        'provider_adapter'
      ) as outcome
    `);
    expect(await appendDiagnostic()).toEqual([{ outcome: 'late_audited' }]);
    expect(await appendDiagnostic()).toEqual([{ outcome: 'late_audited' }]);
    const [audit] = await database.sql<{
      rows: number;
      result_id: string;
      submitted_fingerprint: string;
      position_count: number;
      diagnostic_codes: string[];
      has_message_column: boolean;
    }[]>`
      select
        (select count(*)::int from public.sp_write_late_result_audits
          where intent_id = ${late.artifacts.intent.intentId}::uuid) as rows,
        audit.result_id::text as result_id,
        audit.submitted_fingerprint,
        audit.position_count,
        audit.diagnostic_codes,
        exists (
          select 1 from information_schema.columns
           where table_schema = 'public'
             and table_name = 'sp_write_late_result_audits'
             and column_name in ('message', 'artifact', 'artifact_text')
        ) as has_message_column
      from public.sp_write_late_result_audits audit
      where audit.intent_id = ${late.artifacts.intent.intentId}::uuid
    `;
    expect(audit).toEqual({
      rows: 1,
      result_id: late.resultId,
      submitted_fingerprint: diagnosticLate.fingerprint,
      position_count: 1,
      diagnostic_codes: ['synthetic_rejection'],
      has_message_column: false,
    });
  });

  it('fails closed on a deterministic reserved-result UUID collision', async () => {
    const userId = uuid(27_300);
    const [seed] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('sp-result-collision', ${userId}::uuid, 'owner')
    `;
    const [profile] = await database.sql<{
      id: string;
      connection_id: string;
      amazon_profile_id: string;
    }[]>`
      select id, connection_id, amazon_profile_id
        from public.ad_profiles
       where org_id = ${seed?.seed_tenant_fixture ?? null}::uuid
    `;
    if (!seed || !profile) throw new Error('SP collision tenant was not seeded');
    const collisionTenant: SpTenant = {
      orgId: seed.seed_tenant_fixture,
      profileId: profile.id,
      connectionId: profile.connection_id,
      amazonProfileId: profile.amazon_profile_id,
      userId,
    };
    await enableTestAuthority(database, collisionTenant, 27_310);
    const firstCycle = await prepareManualExecution(database, collisionTenant, 27_320);
    const [firstTimes] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!firstTimes) throw new Error('SP collision first timestamps were not derived');
    const firstArtifacts = reservationArtifacts(
      firstCycle.proof, firstCycle.receipt, firstCycle.leaseId,
      firstTimes.observed_at, firstTimes.valid_until, 27_330,
    );
    const [first] = await asServiceRole(database, async (sql) => sql<{ decision: string }[]>`
      select decision from app.reserve_sp_write_provider_call(
        ${firstCycle.receipt.executionId}::uuid, ${firstCycle.proof.plan.id}::uuid,
        ${firstCycle.receipt.generation}::uuid, ${firstCycle.leaseId}::uuid,
        ${JSON.stringify(firstArtifacts.observation)},
        ${serializeSpWritePredispatchObservationFingerprint(firstArtifacts.observation)},
        ${JSON.stringify(firstArtifacts.intent)},
        ${firstArtifacts.requestPreimage}, ${firstArtifacts.intentPreimage}
      )
    `);
    expect(first?.decision).toBe('won');

    const secondCycle = await prepareManualExecution(database, collisionTenant, 27_340);
    const [secondTimes] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!secondTimes) throw new Error('SP collision second timestamps were not derived');
    const secondArtifacts = reservationArtifacts(
      secondCycle.proof, secondCycle.receipt, secondCycle.leaseId,
      secondTimes.observed_at, secondTimes.valid_until, 27_350,
    );
    const forcedCollision = reservedResultId(secondArtifacts.intent.intentId);
    await database.sql.begin(async (sql) => {
      await sql.unsafe("set local session_replication_role = 'replica'");
      await sql`
        update public.sp_write_provider_call_intents
           set reserved_result_id = ${forcedCollision}::uuid
         where intent_id = ${firstArtifacts.intent.intentId}::uuid
      `;
    });
    await expect(asServiceRole(database, async (sql) => sql`
      select * from app.reserve_sp_write_provider_call(
        ${secondCycle.receipt.executionId}::uuid, ${secondCycle.proof.plan.id}::uuid,
        ${secondCycle.receipt.generation}::uuid, ${secondCycle.leaseId}::uuid,
        ${JSON.stringify(secondArtifacts.observation)},
        ${serializeSpWritePredispatchObservationFingerprint(secondArtifacts.observation)},
        ${JSON.stringify(secondArtifacts.intent)},
        ${secondArtifacts.requestPreimage}, ${secondArtifacts.intentPreimage}
      )
    `)).rejects.toThrow(/reserved result UUID collision/i);
    const [closure] = await database.sql<{
      intents: number;
      observations: number;
      resolutions: number;
      wakes: number;
    }[]>`
      select
        (select count(*)::int from public.sp_write_provider_call_intents
          where plan_id = ${secondCycle.proof.plan.id}::uuid) as intents,
        (select count(*)::int from public.sp_write_predispatch_observations
          where plan_id = ${secondCycle.proof.plan.id}::uuid) as observations,
        (select count(*)::int from public.sp_write_action_resolutions
          where plan_id = ${secondCycle.proof.plan.id}::uuid) as resolutions,
        (select count(*)::int from public.sp_write_outbox
          where plan_id = ${secondCycle.proof.plan.id}::uuid
            and kind = 'observe_and_recover') as wakes
    `;
    expect(closure).toEqual({ intents: 0, observations: 0, resolutions: 0, wakes: 0 });
  });
});

describe.skipIf(!available)('SP write bounded stopOnConflict', () => {
  let database: TestDatabase;
  let tenant: SpTenant;

  beforeAll(async () => {
    database = await createWp187TestDatabase('sp_write_stop_on_conflict');
    const userId = uuid(28_001);
    const [seed] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('sp-stop-conflict', ${userId}::uuid, 'owner')
    `;
    const [profile] = await database.sql<{
      id: string;
      connection_id: string;
      amazon_profile_id: string;
    }[]>`
      select id, connection_id, amazon_profile_id
        from public.ad_profiles
       where org_id = ${seed?.seed_tenant_fixture ?? null}::uuid
    `;
    if (!seed || !profile) throw new Error('SP stopOnConflict tenant was not seeded');
    tenant = {
      orgId: seed.seed_tenant_fixture,
      profileId: profile.id,
      connectionId: profile.connection_id,
      amazonProfileId: profile.amazon_profile_id,
      userId,
    };
    await enableTestAuthority(database, tenant, 28_010);
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('never admits the next bounded call before a conflict stops the authorization', async () => {
    const forward = twoKeywordPlan(
      tenant.orgId, tenant.profileId, tenant.connectionId, tenant.amazonProfileId,
      uuid(28_100), 28_101,
    );
    const inverse = inverseTwoKeywordPlan(forward, uuid(28_110), uuid(28_111), 28_112);
    for (const proof of [forward, inverse]) {
      await asServiceRole(database, async (sql) => sql`
        select app.record_sp_write_plan(
          ${JSON.stringify(proof.plan)}, ${proof.planPreimage},
          ${JSON.stringify(proof.actions.map((action, index) => ({
            artifactText: JSON.stringify(action),
            fingerprintPreimage: proof.actionPreimages[index],
          })))}::jsonb
        )
      `);
    }
    const authorizationSeed = boundedAuthorization(forward.plan, uuid(28_120));
    const authorizationBase = SpWriteBoundedAuthorization.parse({
      ...authorizationSeed,
      profiles: [{
        ...authorizationSeed.profiles[0]!,
        allowedEntities: forward.actions.map((action) => ({
          routeKey: action.routeKey,
          amazonEntityId: 'keywordId' in action.entity ? action.entity.keywordId : '',
          allowedChangeKeys: ['keyword.bid'],
          maxAbsoluteMoneyDelta: '0.1',
          maxAbsolutePlacementDelta: null,
        })),
      }],
      constraints: {
        ...authorizationSeed.constraints,
        maxLogicalChangesPerPlan: 2,
        maxProviderRowsPerPlan: 2,
      },
      fingerprint: '0'.repeat(64),
    });
    const authorization = SpWriteBoundedAuthorization.parse({
      ...authorizationBase,
      fingerprint: sha256(serializeSpWriteBoundedAuthorizationFingerprint(authorizationBase)),
    });
    await asServiceRole(database, async (sql) => sql`
      select app.record_sp_write_bounded_authorization(
        ${JSON.stringify(authorization)},
        ${serializeSpWriteBoundedAuthorizationFingerprint(authorization)},
        ${JSON.stringify([{ orgId: tenant.orgId, profileId: tenant.profileId }])}::jsonb
      )
    `);
    const request = ApproveSpWritePlan.parse({
      approvalRequestId: uuid(28_121),
      plan: spWritePlanBinding(forward.plan),
      approvalMode: 'bounded_live_test',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
      boundedAuthorization: {
        authorizationId: authorization.authorizationId,
        authorizationFingerprint: authorization.fingerprint,
        expiresAt: authorization.expiresAt,
      },
      preapprovedInversePlan: spWritePlanBinding(inverse.plan),
    });
    const [approved] = await asUser(database, tenant.userId, async (sql) => sql<{ receipt: unknown }[]>`
      select app.approve_sp_write_cycle(${forward.plan.id}::uuid, ${JSON.stringify(request)})
        as receipt
    `);
    const receipt = SpWriteAuthorizationReceipt.parse(approved?.receipt);
    await asServiceRole(database, async (sql) => sql`
      select app.start_sp_write_execution(${receipt.approvalId}::uuid, ${forward.plan.id}::uuid)
    `);
    const [lease] = await asServiceRole(database, async (sql) => sql<{ lease_id: string }[]>`
      select lease_id::text from app.acquire_sp_write_dispatch_lease(
        ${receipt.executionId}::uuid, ${forward.plan.id}::uuid,
        ${receipt.generation}::uuid, 'sp.v3.keywords.update', 120
      )
    `);
    if (!lease) throw new Error('SP stopOnConflict lease was not acquired');
    const subset = (index: 0 | 1) => ({
      plan: forward.plan,
      planPreimage: forward.planPreimage,
      action: forward.actions[index],
      actionPreimage: forward.actionPreimages[index]!,
    });
    const [times] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!times) throw new Error('SP stopOnConflict timestamps were not derived');
    const firstArtifacts = reservationArtifacts(
      subset(0), receipt, lease.lease_id, times.observed_at, times.valid_until, 28_200,
    );
    const reserve = async (
      artifacts: ReturnType<typeof reservationArtifacts>,
      sql: TestDatabase['sql'],
    ) => sql<{ decision: string; refusal_reason: string | null; result_id: string | null }[]>`
      select decision, refusal_reason, result_id::text
        from app.reserve_sp_write_provider_call(
          ${receipt.executionId}::uuid, ${forward.plan.id}::uuid,
          ${receipt.generation}::uuid, ${lease.lease_id}::uuid,
          ${JSON.stringify(artifacts.observation)},
          ${serializeSpWritePredispatchObservationFingerprint(artifacts.observation)},
          ${JSON.stringify(artifacts.intent)},
          ${artifacts.requestPreimage}, ${artifacts.intentPreimage}
        )
    `;
    const [first] = await asServiceRole(database, async (sql) => reserve(firstArtifacts, sql));
    expect(first?.decision).toBe('won');
    const [completed] = await database.sql<{ completed_at: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as completed_at
    `;
    if (!completed || !first?.result_id) throw new Error('SP first bounded result is missing');
    const firstResult = acceptedProviderResult(
      firstArtifacts.intent, first.result_id, completed.completed_at,
    );
    await asServiceRole(database, async (sql) => sql`
      select app.append_sp_write_provider_result(
        ${JSON.stringify(firstResult)},
        ${serializeSpWriteProviderResultFingerprint(firstResult)},
        'provider_adapter'
      )
    `);
    const secondArtifacts = reservationArtifacts(
      subset(1), receipt, lease.lease_id, times.observed_at, times.valid_until, 28_210,
    );
    const [beforeConflict] = await asServiceRole(database, async (sql) =>
      reserve(secondArtifacts, sql));
    expect(beforeConflict).toEqual({ decision: 'busy', refusal_reason: null, result_id: null });
    const [beforeCounts] = await database.sql<{ intents: number; resolutions: number }[]>`
      select
        (select count(*)::int from public.sp_write_provider_call_intents
          where intent_id = ${secondArtifacts.intent.intentId}::uuid) as intents,
        (select count(*)::int from public.sp_write_action_resolutions
          where plan_id = ${forward.plan.id}::uuid
            and action_id = ${forward.actions[1].actionId}::uuid) as resolutions
    `;
    expect(beforeCounts).toEqual({ intents: 0, resolutions: 0 });

    const [wake] = await database.sql<{ source_sync_job_id: string; observed_at: string }[]>`
      select source_sync_job_id::text,
             app.sp_write_instant(clock_timestamp()) as observed_at
        from public.sp_write_outbox
       where intent_id = ${firstArtifacts.intent.intentId}::uuid
    `;
    if (!wake) throw new Error('SP stopOnConflict observation wake is missing');
    const conflict = conflictObservation(
      forward.plan,
      forward.actions[0],
      receipt,
      firstArtifacts.intent,
      wake.source_sync_job_id,
      wake.observed_at,
      uuid(28_220),
    );
    const pool = postgres(database.connectionString, { max: 2, prepare: false, onnotice: () => {} });
    let boundaryDecision: { decision: string; refusal_reason: string | null; result_id: string | null };
    try {
      const [reservationRows] = await Promise.all([
        pool.begin(async (sql) => {
          await sql.unsafe('set local role service_role');
          return reserve(secondArtifacts, sql as unknown as TestDatabase['sql']);
        }),
        pool.begin(async (sql) => {
          await sql.unsafe('set local role service_role');
          return sql`
            select app.append_sp_write_observation(
              ${JSON.stringify(conflict)},
              ${serializeSpWriteObservationFingerprint(conflict)}
            )
          `;
        }),
      ]);
      boundaryDecision = reservationRows[0]!;
    } finally {
      await pool.end({ timeout: 5 });
    }
    expect(boundaryDecision.decision).not.toBe('won');
    expect(boundaryDecision.result_id).toBeNull();
    if (boundaryDecision.decision === 'busy') {
      const [afterConflict] = await asServiceRole(database, async (sql) =>
        reserve(secondArtifacts, sql));
      expect(afterConflict).toEqual({
        decision: 'refused',
        refusal_reason: 'authorization_revoked',
        result_id: null,
      });
    } else {
      expect(boundaryDecision).toEqual({
        decision: 'refused',
        refusal_reason: 'authorization_revoked',
        result_id: null,
      });
    }
    const [closure] = await database.sql<{
      revocations: number;
      reason: string;
      second_intents: number;
      second_dispositions: number;
      second_resolutions: number;
    }[]>`
      select
        count(distinct revocation.authorization_id)::int as revocations,
        min(revocation.reason) as reason,
        (select count(*)::int from public.sp_write_provider_call_intents
          where intent_id = ${secondArtifacts.intent.intentId}::uuid) as second_intents,
        (select count(*)::int from public.sp_write_predispatch_dispositions
          where plan_id = ${forward.plan.id}::uuid
            and action_id = ${forward.actions[1].actionId}::uuid) as second_dispositions,
        (select count(*)::int from public.sp_write_action_resolutions
          where plan_id = ${forward.plan.id}::uuid
            and action_id = ${forward.actions[1].actionId}::uuid) as second_resolutions
      from public.sp_write_bounded_authorization_revocations revocation
      where revocation.authorization_id = ${authorization.authorizationId}::uuid
    `;
    expect(closure).toEqual({
      revocations: 1,
      reason: 'stopOnConflict: terminal observation was conflict or missing',
      second_intents: 0,
      second_dispositions: 1,
      second_resolutions: 1,
    });
    expect((await expectAccountingMatchesShared(
      database, receipt.executionId, forward.plan.id,
    )).status).toBe('conflict');
  });

  it('revokes the bounded authorization on an explicit missing observation', async () => {
    const forward = keywordPlan(
      tenant.orgId, tenant.profileId, tenant.connectionId, tenant.amazonProfileId, uuid(28_300),
    );
    const inverse = inverseKeywordPlan(
      forward, uuid(28_301), uuid(28_302), uuid(28_303),
    );
    for (const proof of [forward, inverse]) {
      await asServiceRole(database, async (sql) => sql`
        select app.record_sp_write_plan(
          ${JSON.stringify(proof.plan)}, ${proof.planPreimage},
          ${JSON.stringify([{
            artifactText: JSON.stringify(proof.action),
            fingerprintPreimage: proof.actionPreimage,
          }])}::jsonb
        )
      `);
    }
    const authorization = boundedAuthorization(forward.plan, uuid(28_304));
    await asServiceRole(database, async (sql) => sql`
      select app.record_sp_write_bounded_authorization(
        ${JSON.stringify(authorization)},
        ${serializeSpWriteBoundedAuthorizationFingerprint(authorization)},
        ${JSON.stringify([{ orgId: tenant.orgId, profileId: tenant.profileId }])}::jsonb
      )
    `);
    const request = ApproveSpWritePlan.parse({
      approvalRequestId: uuid(28_305),
      plan: spWritePlanBinding(forward.plan),
      approvalMode: 'bounded_live_test',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
      boundedAuthorization: {
        authorizationId: authorization.authorizationId,
        authorizationFingerprint: authorization.fingerprint,
        expiresAt: authorization.expiresAt,
      },
      preapprovedInversePlan: spWritePlanBinding(inverse.plan),
    });
    const [approved] = await asUser(database, tenant.userId, async (sql) => sql<{ receipt: unknown }[]>`
      select app.approve_sp_write_cycle(${forward.plan.id}::uuid, ${JSON.stringify(request)})
        as receipt
    `);
    const receipt = SpWriteAuthorizationReceipt.parse(approved?.receipt);
    await asServiceRole(database, async (sql) => sql`
      select app.start_sp_write_execution(${receipt.approvalId}::uuid, ${forward.plan.id}::uuid)
    `);
    const [lease] = await asServiceRole(database, async (sql) => sql<{ lease_id: string }[]>`
      select lease_id::text from app.acquire_sp_write_dispatch_lease(
        ${receipt.executionId}::uuid, ${forward.plan.id}::uuid,
        ${receipt.generation}::uuid, 'sp.v3.keywords.update', 120
      )
    `);
    const [times] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!lease || !times) throw new Error('SP missing-observation fixture is incomplete');
    const artifacts = reservationArtifacts(
      forward, receipt, lease.lease_id, times.observed_at, times.valid_until, 28_310,
    );
    const [reservation] = await asServiceRole(database, async (sql) => sql<{
      decision: string;
      result_id: string;
    }[]>`
      select decision, result_id::text from app.reserve_sp_write_provider_call(
        ${receipt.executionId}::uuid, ${forward.plan.id}::uuid,
        ${receipt.generation}::uuid, ${lease.lease_id}::uuid,
        ${JSON.stringify(artifacts.observation)},
        ${serializeSpWritePredispatchObservationFingerprint(artifacts.observation)},
        ${JSON.stringify(artifacts.intent)},
        ${artifacts.requestPreimage}, ${artifacts.intentPreimage}
      )
    `);
    const [completed] = await database.sql<{ completed_at: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as completed_at
    `;
    if (!completed || !reservation?.result_id) throw new Error('SP missing result is absent');
    const result = acceptedProviderResult(
      artifacts.intent, reservation.result_id, completed.completed_at,
    );
    await asServiceRole(database, async (sql) => sql`
      select app.append_sp_write_provider_result(
        ${JSON.stringify(result)}, ${serializeSpWriteProviderResultFingerprint(result)},
        'provider_adapter'
      )
    `);
    const [wake] = await database.sql<{ source_sync_job_id: string; observed_at: string }[]>`
      select source_sync_job_id::text,
             app.sp_write_instant(clock_timestamp()) as observed_at
        from public.sp_write_outbox where intent_id = ${artifacts.intent.intentId}::uuid
    `;
    if (!wake) throw new Error('SP missing observation wake is absent');
    const missing = missingObservation(
      forward.plan, forward.action, receipt, artifacts.intent,
      wake.source_sync_job_id, wake.observed_at, uuid(28_313),
    );
    await asServiceRole(database, async (sql) => sql`
      select app.append_sp_write_observation(
        ${JSON.stringify(missing)}, ${serializeSpWriteObservationFingerprint(missing)}
      )
    `);
    const [closure] = await database.sql<{
      revocations: number;
      reason: string;
      observations: number;
      missing_rows: number;
    }[]>`
      select
        count(distinct revocation.authorization_id)::int as revocations,
        min(revocation.reason) as reason,
        (select count(*)::int from public.sp_write_observations
          where intent_id = ${artifacts.intent.intentId}::uuid) as observations,
        (select count(*)::int from public.sp_write_observations
          where intent_id = ${artifacts.intent.intentId}::uuid
            and outcome = 'missing' and observed is null) as missing_rows
      from public.sp_write_bounded_authorization_revocations revocation
      where revocation.authorization_id = ${authorization.authorizationId}::uuid
    `;
    expect(closure).toEqual({
      revocations: 1,
      reason: 'stopOnConflict: terminal observation was conflict or missing',
      observations: 1,
      missing_rows: 1,
    });
    expect((await expectAccountingMatchesShared(
      database, receipt.executionId, forward.plan.id,
    )).status).toBe('conflict');
  });
});

describe.skipIf(!available)('SP write terminal reservation boundaries', () => {
  let database: TestDatabase;
  let tenant: SpTenant;

  beforeAll(async () => {
    database = await createWp187TestDatabase('sp_write_refusals');
    const userId = uuid(30_001);
    const [seed] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('sp-refusal', ${userId}::uuid, 'owner')
    `;
    const [profile] = await database.sql<{
      id: string;
      connection_id: string;
      amazon_profile_id: string;
    }[]>`
      select id, connection_id, amazon_profile_id
        from public.ad_profiles
       where org_id = ${seed?.seed_tenant_fixture ?? null}::uuid
    `;
    if (!seed || !profile) throw new Error('SP refusal tenant was not seeded');
    tenant = {
      orgId: seed.seed_tenant_fixture,
      profileId: profile.id,
      connectionId: profile.connection_id,
      amazonProfileId: profile.amazon_profile_id,
      userId,
    };
    await enableTestAuthority(database, tenant, 30_002);
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  async function prepareTwoActionCycle(seed: number) {
    const proof = twoKeywordPlan(
      tenant.orgId,
      tenant.profileId,
      tenant.connectionId,
      tenant.amazonProfileId,
      uuid(seed),
      seed + 1,
    );
    await asServiceRole(database, async (sql) => sql`
      select app.record_sp_write_plan(
        ${JSON.stringify(proof.plan)},
        ${proof.planPreimage},
        ${JSON.stringify(proof.actions.map((action, index) => ({
          artifactText: JSON.stringify(action),
          fingerprintPreimage: proof.actionPreimages[index],
        })))}::jsonb
      )
    `);
    const request = ApproveSpWritePlan.parse({
      approvalRequestId: uuid(seed + 3),
      plan: spWritePlanBinding(proof.plan),
      approvalMode: 'manual',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
      boundedAuthorization: null,
      preapprovedInversePlan: null,
    });
    const [approved] = await asUser(database, tenant.userId, async (sql) => sql<{ receipt: unknown }[]>`
      select app.approve_sp_write_cycle(
        ${proof.plan.id}::uuid,
        ${JSON.stringify(request)}
      ) as receipt
    `);
    const receipt = SpWriteAuthorizationReceipt.parse(approved?.receipt);
    await asServiceRole(database, async (sql) => sql`
      select app.start_sp_write_execution(${receipt.approvalId}::uuid, ${proof.plan.id}::uuid)
    `);
    const [lease] = await asServiceRole(database, async (sql) => sql<{ lease_id: string }[]>`
      select lease_id::text
        from app.acquire_sp_write_dispatch_lease(
          ${receipt.executionId}::uuid, ${proof.plan.id}::uuid,
          ${receipt.generation}::uuid, 'sp.v3.keywords.update', 120
        )
    `);
    if (!lease) throw new Error('SP two-action lease was not acquired');
    return { proof, receipt, leaseId: lease.lease_id };
  }

  it('canonically refuses a missing lease with exact one-action closure', async () => {
    const cycle = await prepareManualExecution(database, tenant, 30_010, false);
    expect((await expectAccountingMatchesShared(
      database, cycle.receipt.executionId, cycle.proof.plan.id,
    )).status).toBe('queued');
    const [times] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!times) throw new Error('SP refusal timestamps were not derived');
    const artifacts = reservationArtifacts(
      cycle.proof,
      cycle.receipt,
      cycle.leaseId,
      times.observed_at,
      times.valid_until,
      30_100,
    );
    const [decision] = await asServiceRole(database, async (sql) => sql<{
      decision: string;
      refusal_reason: string;
      result_id: string | null;
      intent_text: string | null;
    }[]>`
      select decision, refusal_reason, result_id::text, intent_text
        from app.reserve_sp_write_provider_call(
          ${cycle.receipt.executionId}::uuid,
          ${cycle.proof.plan.id}::uuid,
          ${cycle.receipt.generation}::uuid,
          ${cycle.leaseId}::uuid,
          ${JSON.stringify(artifacts.observation)},
          ${serializeSpWritePredispatchObservationFingerprint(artifacts.observation)},
          ${JSON.stringify(artifacts.intent)},
          ${artifacts.requestPreimage},
          ${artifacts.intentPreimage}
        )
    `);
    expect(decision).toEqual({
      decision: 'refused',
      refusal_reason: 'lease_unavailable',
      result_id: null,
      intent_text: null,
    });

    const [stored] = await database.sql<{
      artifact_text: string;
      fingerprint_preimage: string;
      fingerprint: string;
      dispositions: string;
      resolutions: string;
      intents: string;
    }[]>`
      select min(d.artifact_text) as artifact_text,
             min(d.fingerprint_preimage) as fingerprint_preimage,
             min(d.fingerprint) as fingerprint,
             count(distinct d.disposition_id)::text as dispositions,
             count(distinct r.action_id)::text as resolutions,
             (select count(*) from public.sp_write_provider_call_intents i
               where i.plan_id = ${cycle.proof.plan.id}::uuid)::text as intents
        from public.sp_write_predispatch_dispositions d
        join public.sp_write_action_resolutions r
          on r.org_id = d.org_id and r.profile_id = d.profile_id
         and r.execution_id = d.execution_id and r.plan_id = d.plan_id
         and r.action_id = d.action_id and r.disposition_id = d.disposition_id
       where d.plan_id = ${cycle.proof.plan.id}::uuid
    `;
    const disposition = SpWritePreDispatchDisposition.parse(JSON.parse(stored!.artifact_text));
    expect(stored).toMatchObject({ dispositions: '1', resolutions: '1', intents: '0' });
    expect(stored?.fingerprint_preimage).toBe(
      serializeSpWritePreDispatchDispositionFingerprint(disposition),
    );
    expect(stored?.fingerprint).toBe(sha256(stored!.fingerprint_preimage));
    expect((await expectAccountingMatchesShared(
      database, cycle.receipt.executionId, cycle.proof.plan.id,
    )).status).toBe('refused');
  });

  it('stores stale-state observation, item, disposition, and resolution atomically', async () => {
    const cycle = await prepareManualExecution(database, tenant, 30_200);
    const [times] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!times) throw new Error('SP stale-state timestamps were not derived');
    const artifacts = reservationArtifacts(
      cycle.proof,
      cycle.receipt,
      cycle.leaseId,
      times.observed_at,
      times.valid_until,
      30_210,
      'requested',
    );
    const [decision] = await asServiceRole(database, async (sql) => sql<{
      decision: string;
      refusal_reason: string;
    }[]>`
      select decision, refusal_reason
        from app.reserve_sp_write_provider_call(
          ${cycle.receipt.executionId}::uuid,
          ${cycle.proof.plan.id}::uuid,
          ${cycle.receipt.generation}::uuid,
          ${cycle.leaseId}::uuid,
          ${JSON.stringify(artifacts.observation)},
          ${serializeSpWritePredispatchObservationFingerprint(artifacts.observation)},
          ${JSON.stringify(artifacts.intent)},
          ${artifacts.requestPreimage},
          ${artifacts.intentPreimage}
        )
    `);
    expect(decision).toEqual({ decision: 'refused', refusal_reason: 'stale_expected_state' });
    const [counts] = await database.sql<{
      observations: string;
      items: string;
      dispositions: string;
      resolutions: string;
    }[]>`
      select
        (select count(*) from public.sp_write_predispatch_observations
          where plan_id = ${cycle.proof.plan.id}::uuid)::text as observations,
        (select count(*) from public.sp_write_predispatch_observation_items
          where plan_id = ${cycle.proof.plan.id}::uuid)::text as items,
        (select count(*) from public.sp_write_predispatch_dispositions
          where plan_id = ${cycle.proof.plan.id}::uuid)::text as dispositions,
        (select count(*) from public.sp_write_action_resolutions
          where plan_id = ${cycle.proof.plan.id}::uuid)::text as resolutions
    `;
    expect(counts).toEqual({ observations: '1', items: '1', dispositions: '1', resolutions: '1' });
  });

  it('refuses only the stale action in a mixed-current two-action batch', async () => {
    const proof = twoKeywordPlan(
      tenant.orgId,
      tenant.profileId,
      tenant.connectionId,
      tenant.amazonProfileId,
      uuid(30_400),
      30_401,
    );
    await asServiceRole(database, async (sql) => sql`
      select app.record_sp_write_plan(
        ${JSON.stringify(proof.plan)},
        ${proof.planPreimage},
        ${JSON.stringify(proof.actions.map((action, index) => ({
          artifactText: JSON.stringify(action),
          fingerprintPreimage: proof.actionPreimages[index],
        })))}::jsonb
      )
    `);
    const request = ApproveSpWritePlan.parse({
      approvalRequestId: uuid(30_403),
      plan: spWritePlanBinding(proof.plan),
      approvalMode: 'manual',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
      boundedAuthorization: null,
      preapprovedInversePlan: null,
    });
    const [approved] = await asUser(database, tenant.userId, async (sql) => sql<{ receipt: unknown }[]>`
      select app.approve_sp_write_cycle(
        ${proof.plan.id}::uuid,
        ${JSON.stringify(request)}
      ) as receipt
    `);
    const receipt = SpWriteAuthorizationReceipt.parse(approved?.receipt);
    await asServiceRole(database, async (sql) => sql`
      select app.start_sp_write_execution(${receipt.approvalId}::uuid, ${proof.plan.id}::uuid)
    `);
    const [lease] = await asServiceRole(database, async (sql) => sql<{ lease_id: string }[]>`
      select lease_id::text
        from app.acquire_sp_write_dispatch_lease(
          ${receipt.executionId}::uuid, ${proof.plan.id}::uuid,
          ${receipt.generation}::uuid, 'sp.v3.keywords.update', 120
        )
    `);
    if (!lease) throw new Error('SP mixed-stale lease was not acquired');
    const [times] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!times) throw new Error('SP mixed-stale timestamps were not derived');
    const artifacts = mixedStaleReservationArtifacts(
      proof, receipt, lease.lease_id, times.observed_at, times.valid_until, 30_410,
    );
    const [decision] = await asServiceRole(database, async (sql) => sql<{
      decision: string;
      refusal_reason: string;
    }[]>`
      select decision, refusal_reason
        from app.reserve_sp_write_provider_call(
          ${receipt.executionId}::uuid, ${proof.plan.id}::uuid,
          ${receipt.generation}::uuid, ${lease.lease_id}::uuid,
          ${JSON.stringify(artifacts.observation)},
          ${serializeSpWritePredispatchObservationFingerprint(artifacts.observation)},
          ${JSON.stringify(artifacts.intent)},
          ${artifacts.requestPreimage}, ${artifacts.intentPreimage}
        )
    `);
    expect(decision).toEqual({ decision: 'refused', refusal_reason: 'stale_expected_state' });

    const dispositions = await database.sql<{ action_id: string; artifact_text: string }[]>`
      select action_id::text, artifact_text
        from public.sp_write_predispatch_dispositions
       where plan_id = ${proof.plan.id}::uuid
       order by action_id
    `;
    const resolutions = await database.sql<{ action_id: string; resolution_kind: string }[]>`
      select action_id::text, resolution_kind::text
        from public.sp_write_action_resolutions
       where plan_id = ${proof.plan.id}::uuid
       order by action_id
    `;
    expect(dispositions.map((row) => row.action_id)).toEqual([proof.actions[1].actionId]);
    expect(resolutions).toEqual([{
      action_id: proof.actions[1].actionId,
      resolution_kind: 'refusal',
    }]);

    const evidenceCore = {
      plan: proof.plan,
      authorization: receipt,
      predispatchObservations: [artifacts.observation],
      predispatchDispositions: dispositions.map((row) =>
        SpWritePreDispatchDisposition.parse(JSON.parse(row.artifact_text))),
      providerCallIntents: [],
      providerResults: [],
      observations: [],
    };
    const evidence = {
      ...evidenceCore,
      snapshot: deriveSpWriteExecutionSnapshot(evidenceCore),
    };
    expect(evidence.snapshot.accounting).toMatchObject({
      approvedRows: 2,
      refusedBeforeDispatch: 1,
      pendingDispatch: 1,
    });
    expect(() => verifySpWriteExecutionEvidence(evidence, spWriteHasher)).not.toThrow();
    expect((await expectAccountingMatchesShared(
      database, receipt.executionId, proof.plan.id,
    )).status).toBe('running');
  });

  it('classifies stale and incomplete-context actions independently', async () => {
    const cycle = await prepareTwoActionCycle(30_500);
    const [times] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!times) throw new Error('SP unsupported-context timestamps were not derived');
    const artifacts = mixedStaleReservationArtifacts(
      cycle.proof,
      cycle.receipt,
      cycle.leaseId,
      times.observed_at,
      times.valid_until,
      30_510,
      'stale_and_unsupported',
    );
    const [decision] = await asServiceRole(database, async (sql) => sql<{
      decision: string;
      refusal_reason: string;
    }[]>`
      select decision, refusal_reason
        from app.reserve_sp_write_provider_call(
          ${cycle.receipt.executionId}::uuid, ${cycle.proof.plan.id}::uuid,
          ${cycle.receipt.generation}::uuid, ${cycle.leaseId}::uuid,
          ${JSON.stringify(artifacts.observation)},
          ${serializeSpWritePredispatchObservationFingerprint(artifacts.observation)},
          ${JSON.stringify(artifacts.intent)},
          ${artifacts.requestPreimage}, ${artifacts.intentPreimage}
        )
    `);
    expect(decision).toEqual({ decision: 'refused', refusal_reason: 'unsupported_provider_state' });
    const dispositions = await database.sql<{
      action_id: string;
      reason: string;
      provider_observation_fingerprint: string | null;
    }[]>`
      select action_id::text, reason::text, provider_observation_fingerprint
       from public.sp_write_predispatch_dispositions
       where plan_id = ${cycle.proof.plan.id}::uuid
       order by action_id
    `;
    const resolutions = await database.sql<{ action_id: string; resolution_kind: string }[]>`
      select action_id::text, resolution_kind::text
        from public.sp_write_action_resolutions
       where plan_id = ${cycle.proof.plan.id}::uuid
       order by action_id
    `;
    expect(dispositions).toEqual([
      {
        action_id: cycle.proof.actions[0].actionId,
        reason: 'stale_expected_state',
        provider_observation_fingerprint: artifacts.observation.fingerprint,
      },
      {
        action_id: cycle.proof.actions[1].actionId,
        reason: 'unsupported_provider_state',
        provider_observation_fingerprint: null,
      },
    ]);
    expect(resolutions).toEqual(cycle.proof.actions.map((action) => ({
      action_id: action.actionId,
      resolution_kind: 'refusal',
    })));
    const [counts] = await database.sql<{ observations: number; items: number }[]>`
      select
        (select count(*)::int from public.sp_write_predispatch_observations
          where plan_id = ${cycle.proof.plan.id}::uuid) as observations,
        (select count(*)::int from public.sp_write_predispatch_observation_items
          where plan_id = ${cycle.proof.plan.id}::uuid) as items
    `;
    expect(counts).toEqual({ observations: 1, items: 2 });
  });

  it('rejects tenant, scope, route, generation, count, position, and result tampering atomically', async () => {
    const cycle = await prepareManualExecution(database, tenant, 30_600);
    const [times] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!times) throw new Error('SP tamper timestamps were not derived');
    const artifacts = reservationArtifacts(
      cycle.proof, cycle.receipt, cycle.leaseId,
      times.observed_at, times.valid_until, 30_610,
    );
    const rebindIntent = (
      changes: Partial<ReturnType<typeof SpWriteProviderCallIntent.parse>>,
    ) => {
      const base = SpWriteProviderCallIntent.parse({
        ...artifacts.intent,
        ...changes,
        requestFingerprint: '0'.repeat(64),
        fingerprint: '0'.repeat(64),
      });
      const requestPreimage = serializeSpWriteProviderRequestFingerprint(base);
      const requestBound = SpWriteProviderCallIntent.parse({
        ...base,
        requestFingerprint: sha256(requestPreimage),
      });
      const intentPreimage = serializeSpWriteProviderCallIntentFingerprint(requestBound);
      return {
        intent: SpWriteProviderCallIntent.parse({
          ...requestBound,
          fingerprint: sha256(intentPreimage),
        }),
        requestPreimage,
        intentPreimage,
      };
    };
    const route = rebindIntent({ routeKey: 'sp.v3.campaigns.update' });
    const scope = rebindIntent({ planId: uuid(30_690) });
    const position = rebindIntent({
      positions: [{
        ...artifacts.intent.positions[0]!,
        amazonEntityId: 'a-different-keyword',
      }],
    });
    const emptyPositionsWithoutFingerprint = {
      ...artifacts.intent,
      positions: [],
      requestFingerprint: '',
    };
    const countRequestPreimage = JSON.stringify([
      'openspell.sp-write-provider-request.v1',
      emptyPositionsWithoutFingerprint.planId,
      emptyPositionsWithoutFingerprint.planFingerprint,
      emptyPositionsWithoutFingerprint.approvalId,
      emptyPositionsWithoutFingerprint.executionId,
      emptyPositionsWithoutFingerprint.generation,
      emptyPositionsWithoutFingerprint.providerCallId,
      emptyPositionsWithoutFingerprint.routeKey,
      emptyPositionsWithoutFingerprint.providerObservationFingerprint,
      [],
    ]);
    const countIntentWithoutFingerprint = {
      ...emptyPositionsWithoutFingerprint,
      requestFingerprint: sha256(countRequestPreimage),
    };
    const { fingerprint: _ignoredCountFingerprint, ...countIntentPreimageValue } =
      countIntentWithoutFingerprint;
    const countIntentPreimage = JSON.stringify([
      'openspell.sp-write-provider-call-intent.v1',
      countIntentPreimageValue,
    ]);
    const countIntent = {
      ...countIntentWithoutFingerprint,
      fingerprint: sha256(countIntentPreimage),
    };
    const cases = [
      {
        label: 'tenant',
        executionId: uuid(30_691),
        generation: cycle.receipt.generation,
        intent: artifacts.intent,
        requestPreimage: artifacts.requestPreimage,
        intentPreimage: artifacts.intentPreimage,
      },
      {
        label: 'scope',
        executionId: cycle.receipt.executionId,
        generation: cycle.receipt.generation,
        ...scope,
      },
      {
        label: 'route',
        executionId: cycle.receipt.executionId,
        generation: cycle.receipt.generation,
        ...route,
      },
      {
        label: 'generation',
        executionId: cycle.receipt.executionId,
        generation: uuid(30_692),
        intent: artifacts.intent,
        requestPreimage: artifacts.requestPreimage,
        intentPreimage: artifacts.intentPreimage,
      },
      {
        label: 'count',
        executionId: cycle.receipt.executionId,
        generation: cycle.receipt.generation,
        intent: countIntent,
        requestPreimage: countRequestPreimage,
        intentPreimage: countIntentPreimage,
      },
      {
        label: 'position',
        executionId: cycle.receipt.executionId,
        generation: cycle.receipt.generation,
        ...position,
      },
    ];
    for (const tamper of cases) {
      await expect(asServiceRole(database, async (sql) => sql`
        select * from app.reserve_sp_write_provider_call(
          ${tamper.executionId}::uuid, ${cycle.proof.plan.id}::uuid,
          ${tamper.generation}::uuid, ${cycle.leaseId}::uuid,
          ${JSON.stringify(artifacts.observation)},
          ${serializeSpWritePredispatchObservationFingerprint(artifacts.observation)},
          ${JSON.stringify(tamper.intent)},
          ${tamper.requestPreimage}, ${tamper.intentPreimage}
        )
      `), tamper.label).rejects.toThrow();
      const [closure] = await database.sql<{
        intents: number;
        observations: number;
        resolutions: number;
        wakes: number;
      }[]>`
        select
          (select count(*)::int from public.sp_write_provider_call_intents
            where plan_id = ${cycle.proof.plan.id}::uuid) as intents,
          (select count(*)::int from public.sp_write_predispatch_observations
            where plan_id = ${cycle.proof.plan.id}::uuid) as observations,
          (select count(*)::int from public.sp_write_action_resolutions
            where plan_id = ${cycle.proof.plan.id}::uuid) as resolutions,
          (select count(*)::int from public.sp_write_outbox
            where plan_id = ${cycle.proof.plan.id}::uuid
              and kind = 'observe_and_recover') as wakes
      `;
      expect(closure, tamper.label).toEqual({
        intents: 0,
        observations: 0,
        resolutions: 0,
        wakes: 0,
      });
    }

    const [completed] = await database.sql<{ completed_at: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as completed_at
    `;
    if (!completed) throw new Error('SP tampered result time was not derived');
    const orphanResult = acceptedProviderResult(
      artifacts.intent,
      reservedResultId(artifacts.intent.intentId),
      completed.completed_at,
    );
    await expect(asServiceRole(database, async (sql) => sql`
      select app.append_sp_write_provider_result(
        ${JSON.stringify(orphanResult)},
        ${serializeSpWriteProviderResultFingerprint(orphanResult)},
        'provider_adapter'
      )
    `)).rejects.toThrow();
    const [resultClosure] = await database.sql<{ results: number; audits: number }[]>`
      select
        (select count(*)::int from public.sp_write_provider_results
          where intent_id = ${artifacts.intent.intentId}::uuid) as results,
        (select count(*)::int from public.sp_write_late_result_audits
          where intent_id = ${artifacts.intent.intentId}::uuid) as audits
    `;
    expect(resultClosure).toEqual({ results: 0, audits: 0 });
  });

  it('rejects future observation time without persisting stale-state evidence', async () => {
    const cycle = await prepareManualExecution(database, tenant, 30_300);
    const [times] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp() + interval '10 seconds') as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '70 seconds') as valid_until
    `;
    if (!times) throw new Error('SP future timestamps were not derived');
    const artifacts = reservationArtifacts(
      cycle.proof,
      cycle.receipt,
      cycle.leaseId,
      times.observed_at,
      times.valid_until,
      30_310,
      'requested',
    );
    await expect(asServiceRole(database, async (sql) => sql`
      select * from app.reserve_sp_write_provider_call(
        ${cycle.receipt.executionId}::uuid,
        ${cycle.proof.plan.id}::uuid,
        ${cycle.receipt.generation}::uuid,
        ${cycle.leaseId}::uuid,
        ${JSON.stringify(artifacts.observation)},
        ${serializeSpWritePredispatchObservationFingerprint(artifacts.observation)},
        ${JSON.stringify(artifacts.intent)},
        ${artifacts.requestPreimage},
        ${artifacts.intentPreimage}
      )
    `)).rejects.toThrow(/observation or intent is stale/i);
    const [counts] = await database.sql<{ evidence: string }[]>`
      select (
        (select count(*) from public.sp_write_predispatch_observations
          where plan_id = ${cycle.proof.plan.id}::uuid)
        + (select count(*) from public.sp_write_predispatch_dispositions
          where plan_id = ${cycle.proof.plan.id}::uuid)
        + (select count(*) from public.sp_write_action_resolutions
          where plan_id = ${cycle.proof.plan.id}::uuid)
      )::text as evidence
    `;
    expect(counts?.evidence).toBe('0');
  });
});

describe.skipIf(!available)('SP write authority races and crash cuts', () => {
  let database: TestDatabase;
  let tenant: SpTenant;

  beforeAll(async () => {
    database = await createWp187TestDatabase('sp_write_race_crash_matrix');
    const userId = uuid(33_001);
    const [seed] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('sp-race-crash', ${userId}::uuid, 'owner')
    `;
    const [profile] = await database.sql<{
      id: string;
      connection_id: string;
      amazon_profile_id: string;
    }[]>`
      select id, connection_id, amazon_profile_id
        from public.ad_profiles
       where org_id = ${seed?.seed_tenant_fixture ?? null}::uuid
    `;
    if (!seed || !profile) throw new Error('SP race/crash tenant was not seeded');
    tenant = {
      orgId: seed.seed_tenant_fixture,
      profileId: profile.id,
      connectionId: profile.connection_id,
      amazonProfileId: profile.amazon_profile_id,
      userId,
    };
    await enableTestAuthority(database, tenant, 33_010);
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  async function prepareReservation(seed: number) {
    const cycle = await prepareManualExecution(database, tenant, seed);
    const [times] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!times) throw new Error('SP authority-race timestamps were not derived');
    const artifacts = reservationArtifacts(
      cycle.proof,
      cycle.receipt,
      cycle.leaseId,
      times.observed_at,
      times.valid_until,
      seed + 10,
    );
    return { ...cycle, artifacts };
  }

  async function assertNoReservationEvidence(planId: string) {
    const [counts] = await database.sql<{
      predispatch: number;
      dispositions: number;
      intents: number;
      positions: number;
      resolutions: number;
      wakes: number;
    }[]>`
      select
        (select count(*)::int from public.sp_write_predispatch_observations
          where plan_id = ${planId}::uuid) as predispatch,
        (select count(*)::int from public.sp_write_predispatch_dispositions
          where plan_id = ${planId}::uuid) as dispositions,
        (select count(*)::int from public.sp_write_provider_call_intents
          where plan_id = ${planId}::uuid) as intents,
        (select count(*)::int from public.sp_write_provider_call_positions
          where plan_id = ${planId}::uuid) as positions,
        (select count(*)::int from public.sp_write_action_resolutions
          where plan_id = ${planId}::uuid) as resolutions,
        (select count(*)::int from public.sp_write_outbox
          where plan_id = ${planId}::uuid and kind = 'observe_and_recover') as wakes
    `;
    expect(counts).toEqual({
      predispatch: 0,
      dispositions: 0,
      intents: 0,
      positions: 0,
      resolutions: 0,
      wakes: 0,
    });
  }

  async function assertReservationWaitsOnLock(pid: number, label: string) {
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [activity] = await database.sql<{
        state: string;
        wait_event_type: string | null;
        query: string;
      }[]>`
        select state, wait_event_type, query
          from pg_catalog.pg_stat_activity
         where pid = ${pid}
      `;
      if (activity?.state === 'active'
        && activity.wait_event_type === 'Lock'
        && activity.query.includes('reserve_sp_write_provider_call')) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(blocked, `${label} reservation must wait on the authority lock`).toBe(true);
  }

  it('serializes environment then grant expected-version switches without stale admission', async () => {
    const cycle = await prepareReservation(33_100);
    const disabledEnvironment = uuid(33_120);
    const disabledGrant = uuid(33_121);
    const disabledGrantVersion = uuid(33_122);
    await database.sql.begin(async (sql) => {
      await sql`
        insert into public.sp_write_environment_gate_versions
          (version_id, enabled, max_unresolved_calls, created_by)
        values (${disabledEnvironment}::uuid, false, 1, ${tenant.userId}::uuid)
      `;
      await sql`
        insert into public.sp_write_profile_grant_versions
          (grant_id, version_id, org_id, profile_id, enabled, amazon_profile_id,
           connection_id, region, marketplace_id, currency_code, api_dialect, created_by)
        values (
          ${disabledGrant}::uuid, ${disabledGrantVersion}::uuid,
          ${tenant.orgId}::uuid, ${tenant.profileId}::uuid, false,
          ${tenant.amazonProfileId}, ${tenant.connectionId}::uuid,
          'NA', 'synthetic-marketplace', 'USD', 'sp_v3', ${tenant.userId}::uuid
        )
      `;
    });

    const pool = postgres(database.connectionString, { max: 2, prepare: false, onnotice: () => {} });
    let lockedResolve!: () => void;
    let switchResolve!: () => void;
    const locked = new Promise<void>((resolve) => { lockedResolve = resolve; });
    const switchNow = new Promise<void>((resolve) => { switchResolve = resolve; });
    const switcher = pool.begin(async (sql) => {
      await sql`select 1 from public.sp_write_environment_gate_head where singleton for update`;
      await sql`
        select 1 from public.sp_write_profile_grant_heads
         where org_id = ${tenant.orgId}::uuid and profile_id = ${tenant.profileId}::uuid
         for update
      `;
      lockedResolve();
      await switchNow;
      await sql`
        update public.sp_write_environment_gate_head
           set version_id = ${disabledEnvironment}::uuid
         where singleton
      `;
      await sql`
        update public.sp_write_profile_grant_heads
           set grant_id = ${disabledGrant}::uuid, version_id = ${disabledGrantVersion}::uuid
         where org_id = ${tenant.orgId}::uuid and profile_id = ${tenant.profileId}::uuid
      `;
    });
    await locked;
    let reservationPidResolve!: (pid: number) => void;
    const reservationPid = new Promise<number>((resolve) => {
      reservationPidResolve = resolve;
    });
    const reservation = pool.begin(async (sql) => {
      await sql.unsafe('set local role service_role');
      const [backend] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      if (!backend) throw new Error('SP environment-race reservation PID is missing');
      reservationPidResolve(backend.pid);
      return sql<{ decision: string; refusal_reason: string }[]>`
        select decision, refusal_reason
          from app.reserve_sp_write_provider_call(
            ${cycle.receipt.executionId}::uuid,
            ${cycle.proof.plan.id}::uuid,
            ${cycle.receipt.generation}::uuid,
            ${cycle.leaseId}::uuid,
            ${JSON.stringify(cycle.artifacts.observation)},
            ${serializeSpWritePredispatchObservationFingerprint(cycle.artifacts.observation)},
            ${JSON.stringify(cycle.artifacts.intent)},
            ${cycle.artifacts.requestPreimage},
            ${cycle.artifacts.intentPreimage}
        )
      `;
    });
    await assertReservationWaitsOnLock(
      await reservationPid,
      'environment/profile expected-version switch',
    );
    switchResolve();
    const [, decision] = await Promise.all([switcher, reservation]);
    await pool.end({ timeout: 5 });
    expect(decision).toEqual([{
      decision: 'refused',
      refusal_reason: 'environment_gate_closed',
    }]);
    const [closure] = await database.sql<{ intents: number; refusals: number }[]>`
      select
        (select count(*)::int from public.sp_write_provider_call_intents
          where plan_id = ${cycle.proof.plan.id}::uuid) as intents,
        (select count(*)::int from public.sp_write_predispatch_dispositions
          where plan_id = ${cycle.proof.plan.id}::uuid
            and reason = 'environment_gate_closed') as refusals
    `;
    expect(closure).toEqual({ intents: 0, refusals: 1 });
    await database.sql.begin(async (sql) => {
      await sql`
        update public.sp_write_environment_gate_head
           set version_id = ${cycle.receipt.gateSnapshot.environmentGateVersion}::uuid
         where singleton
      `;
      await sql`
        update public.sp_write_profile_grant_heads
           set grant_id = ${cycle.receipt.gateSnapshot.profileGrantId}::uuid,
               version_id = ${cycle.receipt.gateSnapshot.profileGrantVersion}::uuid
         where org_id = ${tenant.orgId}::uuid and profile_id = ${tenant.profileId}::uuid
      `;
    });

    const grantCycle = await prepareReservation(33_200);
    const grantPool = postgres(
      database.connectionString,
      { max: 2, prepare: false, onnotice: () => {} },
    );
    let grantLockedResolve!: () => void;
    let grantSwitchResolve!: () => void;
    const grantLocked = new Promise<void>((resolve) => { grantLockedResolve = resolve; });
    const grantSwitch = new Promise<void>((resolve) => { grantSwitchResolve = resolve; });
    const grantSwitcher = grantPool.begin(async (sql) => {
      await sql`
        select 1 from public.sp_write_profile_grant_heads
         where org_id = ${tenant.orgId}::uuid and profile_id = ${tenant.profileId}::uuid
         for update
      `;
      grantLockedResolve();
      await grantSwitch;
      await sql`
        update public.sp_write_profile_grant_heads
           set grant_id = ${disabledGrant}::uuid, version_id = ${disabledGrantVersion}::uuid
         where org_id = ${tenant.orgId}::uuid and profile_id = ${tenant.profileId}::uuid
      `;
    });
    await grantLocked;
    let grantReservationPidResolve!: (pid: number) => void;
    const grantReservationPid = new Promise<number>((resolve) => {
      grantReservationPidResolve = resolve;
    });
    const grantReservation = grantPool.begin(async (sql) => {
      await sql.unsafe('set local role service_role');
      const [backend] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      if (!backend) throw new Error('SP grant-race reservation PID is missing');
      grantReservationPidResolve(backend.pid);
      return sql<{ decision: string; refusal_reason: string }[]>`
        select decision, refusal_reason
          from app.reserve_sp_write_provider_call(
            ${grantCycle.receipt.executionId}::uuid,
            ${grantCycle.proof.plan.id}::uuid,
            ${grantCycle.receipt.generation}::uuid,
            ${grantCycle.leaseId}::uuid,
            ${JSON.stringify(grantCycle.artifacts.observation)},
            ${serializeSpWritePredispatchObservationFingerprint(grantCycle.artifacts.observation)},
            ${JSON.stringify(grantCycle.artifacts.intent)},
            ${grantCycle.artifacts.requestPreimage},
            ${grantCycle.artifacts.intentPreimage}
        )
      `;
    });
    await assertReservationWaitsOnLock(await grantReservationPid, 'profile grant switch');
    grantSwitchResolve();
    const [, grantDecision] = await Promise.all([grantSwitcher, grantReservation]);
    await grantPool.end({ timeout: 5 });
    expect(grantDecision).toEqual([{
      decision: 'refused',
      refusal_reason: 'profile_gate_closed',
    }]);
    await database.sql`
      update public.sp_write_profile_grant_heads
           set grant_id = ${grantCycle.receipt.gateSnapshot.profileGrantId}::uuid,
               version_id = ${grantCycle.receipt.gateSnapshot.profileGrantVersion}::uuid
       where org_id = ${tenant.orgId}::uuid and profile_id = ${tenant.profileId}::uuid
    `;
  });

  it('serializes route and bounded revocation changes before reservation authority', async () => {
    const routeCycle = await prepareReservation(33_300);
    const pool = postgres(database.connectionString, { max: 2, prepare: false, onnotice: () => {} });
    let lockedResolve!: () => void;
    let mutateResolve!: () => void;
    const locked = new Promise<void>((resolve) => { lockedResolve = resolve; });
    const mutate = new Promise<void>((resolve) => { mutateResolve = resolve; });
    const updater = pool.begin(async (sql) => {
      await sql`
        select 1 from public.ad_profiles
         where org_id = ${tenant.orgId}::uuid and id = ${tenant.profileId}::uuid
         for update
      `;
      lockedResolve();
      await mutate;
      await sql`
        update public.ads_connections set status = 'revoked'
         where org_id = ${tenant.orgId}::uuid and id = ${tenant.connectionId}::uuid
      `;
    });
    await locked;
    let routeReservationPidResolve!: (pid: number) => void;
    const routeReservationPid = new Promise<number>((resolve) => {
      routeReservationPidResolve = resolve;
    });
    const reservation = pool.begin(async (sql) => {
      await sql.unsafe('set local role service_role');
      const [backend] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      if (!backend) throw new Error('SP route-race reservation PID is missing');
      routeReservationPidResolve(backend.pid);
      return sql<{ decision: string; refusal_reason: string }[]>`
        select decision, refusal_reason
          from app.reserve_sp_write_provider_call(
            ${routeCycle.receipt.executionId}::uuid,
            ${routeCycle.proof.plan.id}::uuid,
            ${routeCycle.receipt.generation}::uuid,
            ${routeCycle.leaseId}::uuid,
            ${JSON.stringify(routeCycle.artifacts.observation)},
            ${serializeSpWritePredispatchObservationFingerprint(routeCycle.artifacts.observation)},
            ${JSON.stringify(routeCycle.artifacts.intent)},
            ${routeCycle.artifacts.requestPreimage},
            ${routeCycle.artifacts.intentPreimage}
        )
      `;
    });
    await assertReservationWaitsOnLock(await routeReservationPid, 'provider route change');
    mutateResolve();
    const [, routeDecision] = await Promise.all([updater, reservation]);
    await pool.end({ timeout: 5 });
    expect(routeDecision).toEqual([{ decision: 'refused', refusal_reason: 'route_mismatch' }]);
    await database.sql`
      update public.ads_connections set status = 'active'
       where org_id = ${tenant.orgId}::uuid and id = ${tenant.connectionId}::uuid
    `;

    const forward = keywordPlan(
      tenant.orgId,
      tenant.profileId,
      tenant.connectionId,
      tenant.amazonProfileId,
      uuid(33_400),
    );
    const inverse = inverseKeywordPlan(
      forward,
      uuid(33_401),
      uuid(33_402),
      uuid(33_403),
    );
    const authorization = boundedAuthorization(forward.plan, uuid(33_404));
    for (const proof of [forward, inverse]) {
      await asServiceRole(database, async (sql) => sql`
        select app.record_sp_write_plan(
          ${JSON.stringify(proof.plan)},
          ${proof.planPreimage},
          ${JSON.stringify([{
            artifactText: JSON.stringify(proof.action),
            fingerprintPreimage: proof.actionPreimage,
          }])}::jsonb
        )
      `);
    }
    await asServiceRole(database, async (sql) => sql`
      select app.record_sp_write_bounded_authorization(
        ${JSON.stringify(authorization)},
        ${serializeSpWriteBoundedAuthorizationFingerprint(authorization)},
        ${JSON.stringify([{ orgId: tenant.orgId, profileId: tenant.profileId }])}::jsonb
      )
    `);
    const request = ApproveSpWritePlan.parse({
      approvalRequestId: uuid(33_405),
      plan: spWritePlanBinding(forward.plan),
      approvalMode: 'bounded_live_test',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
      boundedAuthorization: {
        authorizationId: authorization.authorizationId,
        authorizationFingerprint: authorization.fingerprint,
        expiresAt: authorization.expiresAt,
      },
      preapprovedInversePlan: spWritePlanBinding(inverse.plan),
    });
    const [approved] = await asUser(database, tenant.userId, async (sql) => sql<{
      receipt: unknown;
    }[]>`
      select app.approve_sp_write_cycle(${forward.plan.id}::uuid, ${JSON.stringify(request)})
        as receipt
    `);
    const receipt = SpWriteAuthorizationReceipt.parse(approved?.receipt);
    await asServiceRole(database, async (sql) => sql`
      select app.start_sp_write_execution(${receipt.approvalId}::uuid, ${forward.plan.id}::uuid)
    `);
    const [lease] = await asServiceRole(database, async (sql) => sql<{ lease_id: string }[]>`
      select lease_id::text from app.acquire_sp_write_dispatch_lease(
        ${receipt.executionId}::uuid,
        ${forward.plan.id}::uuid,
        ${receipt.generation}::uuid,
        'sp.v3.keywords.update',
        120
      )
    `);
    const [times] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!lease || !times) throw new Error('SP bounded revocation race fixture is incomplete');
    const artifacts = reservationArtifacts(
      forward,
      receipt,
      lease.lease_id,
      times.observed_at,
      times.valid_until,
      33_410,
    );
    const authPool = postgres(
      database.connectionString,
      { max: 2, prepare: false, onnotice: () => {} },
    );
    let authLockedResolve!: () => void;
    let revokeResolve!: () => void;
    const authLocked = new Promise<void>((resolve) => { authLockedResolve = resolve; });
    const revoke = new Promise<void>((resolve) => { revokeResolve = resolve; });
    const revoker = authPool.begin(async (sql) => {
      await sql`
        select 1 from public.sp_write_bounded_authorizations
         where authorization_id = ${authorization.authorizationId}::uuid
         for update
      `;
      authLockedResolve();
      await revoke;
      await sql`
        insert into public.sp_write_bounded_authorization_revocations
          (authorization_id, reason)
        values (${authorization.authorizationId}::uuid, 'synthetic concurrent revocation')
      `;
    });
    await authLocked;
    let boundedReservationPidResolve!: (pid: number) => void;
    const boundedReservationPid = new Promise<number>((resolve) => {
      boundedReservationPidResolve = resolve;
    });
    const boundedReservation = authPool.begin(async (sql) => {
      await sql.unsafe('set local role service_role');
      const [backend] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      if (!backend) throw new Error('SP bounded-revocation reservation PID is missing');
      boundedReservationPidResolve(backend.pid);
      return sql<{ decision: string; refusal_reason: string }[]>`
        select decision, refusal_reason
          from app.reserve_sp_write_provider_call(
            ${receipt.executionId}::uuid,
            ${forward.plan.id}::uuid,
            ${receipt.generation}::uuid,
            ${lease.lease_id}::uuid,
            ${JSON.stringify(artifacts.observation)},
            ${serializeSpWritePredispatchObservationFingerprint(artifacts.observation)},
            ${JSON.stringify(artifacts.intent)},
            ${artifacts.requestPreimage},
            ${artifacts.intentPreimage}
        )
      `;
    });
    await assertReservationWaitsOnLock(
      await boundedReservationPid,
      'bounded authorization revocation',
    );
    revokeResolve();
    const [, boundedDecision] = await Promise.all([revoker, boundedReservation]);
    await authPool.end({ timeout: 5 });
    expect(boundedDecision).toEqual([{
      decision: 'refused',
      refusal_reason: 'authorization_revoked',
    }]);
  });

  it('barrier-orders stale and exact generation authority in both commit orders', async () => {
    const runOrder = async (seed: number, order: 'stale_first' | 'valid_first') => {
      const cycle = await prepareReservation(seed);
      const staleReceipt = SpWriteAuthorizationReceipt.parse({
        ...cycle.receipt,
        generation: uuid(seed + 20),
      });
      const staleArtifacts = reservationArtifacts(
        cycle.proof,
        staleReceipt,
        cycle.leaseId,
        cycle.artifacts.observation.observedAt,
        cycle.artifacts.observation.validUntil,
        seed + 21,
      );
      const validPool = postgres(
        database.connectionString,
        { max: 1, prepare: false, onnotice: () => {} },
      );
      const stalePool = postgres(
        database.connectionString,
        { max: 1, prepare: false, onnotice: () => {} },
      );
      let validReadyResolve!: () => void;
      let staleReadyResolve!: () => void;
      let validStartResolve!: () => void;
      let staleStartResolve!: () => void;
      let validInsertedResolve!: (rows: { decision: string; result_id: string }[]) => void;
      let validCommitResolve!: () => void;
      const validReady = new Promise<void>((resolve) => { validReadyResolve = resolve; });
      const staleReady = new Promise<void>((resolve) => { staleReadyResolve = resolve; });
      const validStart = new Promise<void>((resolve) => { validStartResolve = resolve; });
      const staleStart = new Promise<void>((resolve) => { staleStartResolve = resolve; });
      const validInserted = new Promise<{ decision: string; result_id: string }[]>((resolve) => {
        validInsertedResolve = resolve;
      });
      const validCommit = new Promise<void>((resolve) => { validCommitResolve = resolve; });
      const validTransaction = validPool.begin(async (sql) => {
        await sql.unsafe('set local role service_role');
        validReadyResolve();
        await validStart;
        const rows = await sql<{ decision: string; result_id: string }[]>`
          select decision, result_id::text
            from app.reserve_sp_write_provider_call(
              ${cycle.receipt.executionId}::uuid,
              ${cycle.proof.plan.id}::uuid,
              ${cycle.receipt.generation}::uuid,
              ${cycle.leaseId}::uuid,
              ${JSON.stringify(cycle.artifacts.observation)},
              ${serializeSpWritePredispatchObservationFingerprint(cycle.artifacts.observation)},
              ${JSON.stringify(cycle.artifacts.intent)},
              ${cycle.artifacts.requestPreimage},
              ${cycle.artifacts.intentPreimage}
            )
        `;
        validInsertedResolve([...rows]);
        await validCommit;
        return rows;
      });
      const staleTransaction = stalePool.begin(async (sql) => {
        await sql.unsafe('set local role service_role');
        staleReadyResolve();
        await staleStart;
        return sql`
          select * from app.reserve_sp_write_provider_call(
            ${cycle.receipt.executionId}::uuid,
            ${cycle.proof.plan.id}::uuid,
            ${staleReceipt.generation}::uuid,
            ${cycle.leaseId}::uuid,
            ${JSON.stringify(staleArtifacts.observation)},
            ${serializeSpWritePredispatchObservationFingerprint(staleArtifacts.observation)},
            ${JSON.stringify(staleArtifacts.intent)},
            ${staleArtifacts.requestPreimage},
            ${staleArtifacts.intentPreimage}
          )
        `;
      });
      const staleOutcome = staleTransaction.then(
        () => ({ status: 'fulfilled' as const, error: null }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      await Promise.all([validReady, staleReady]);

      let validRows: { decision: string; result_id: string }[];
      if (order === 'stale_first') {
        // A stale generation fails before the authority lock. Keep the valid
        // reservation behind its barrier until that fail-closed path finishes.
        staleStartResolve();
        const failed = await staleOutcome;
        expect(failed.status).toBe('rejected');
        expect(String(failed.error)).toMatch(/generation|child ledger|identity/i);
        validStartResolve();
        validRows = await validInserted;
        validCommitResolve();
        await validTransaction;
      } else {
        // Hold the valid intent uncommitted while the already-open stale
        // transaction attempts the same authority. It must reject without
        // waiting for, observing, or modifying the winner's evidence.
        validStartResolve();
        validRows = await validInserted;
        staleStartResolve();
        const failed = await staleOutcome;
        expect(failed.status).toBe('rejected');
        expect(String(failed.error)).toMatch(/generation|child ledger|identity/i);
        validCommitResolve();
        await validTransaction;
      }
      await Promise.all([
        validPool.end({ timeout: 5 }),
        stalePool.end({ timeout: 5 }),
      ]);
      expect(validRows).toEqual([{
        decision: 'won',
        result_id: reservedResultId(cycle.artifacts.intent.intentId),
      }]);
      const [closure] = await database.sql<{
        intents: number;
        positions: number;
        predispatch: number;
        stale_predispatch: number;
        dispositions: number;
        resolutions: number;
        wakes: number;
        stored_intent_id: string;
        stored_generation: string;
      }[]>`
        select
          (select count(*)::int from public.sp_write_provider_call_intents
            where plan_id = ${cycle.proof.plan.id}::uuid) as intents,
          (select count(*)::int from public.sp_write_provider_call_positions
            where plan_id = ${cycle.proof.plan.id}::uuid) as positions,
          (select count(*)::int from public.sp_write_predispatch_observations
            where plan_id = ${cycle.proof.plan.id}::uuid) as predispatch,
          (select count(*)::int from public.sp_write_predispatch_observations
            where observation_id = ${staleArtifacts.observation.observationId}::uuid)
            as stale_predispatch,
          (select count(*)::int from public.sp_write_predispatch_dispositions
            where plan_id = ${cycle.proof.plan.id}::uuid) as dispositions,
          (select count(*)::int from public.sp_write_action_resolutions
            where plan_id = ${cycle.proof.plan.id}::uuid) as resolutions,
          (select count(*)::int from public.sp_write_outbox
            where plan_id = ${cycle.proof.plan.id}::uuid and kind = 'observe_and_recover') as wakes,
          (select intent_id::text from public.sp_write_provider_call_intents
            where plan_id = ${cycle.proof.plan.id}::uuid) as stored_intent_id,
          (select generation::text from public.sp_write_provider_call_intents
            where plan_id = ${cycle.proof.plan.id}::uuid) as stored_generation
      `;
      expect(closure).toEqual({
        intents: 1,
        positions: 1,
        predispatch: 1,
        stale_predispatch: 0,
        dispositions: 0,
        resolutions: 1,
        wakes: 1,
        stored_intent_id: cycle.artifacts.intent.intentId,
        stored_generation: cycle.receipt.generation,
      });

      const won = { ...cycle, resultId: validRows[0]!.result_id };
      const appended = await appendResultAndReadWake(database, won, ['accepted']);
      const observation = actionObservation(
        won.proof.plan,
        won.proof.action,
        won.receipt,
        won.artifacts.intent,
        appended.wake.source_sync_job_id,
        appended.wake.observed_at,
        uuid(seed + 30),
        'observed_requested',
      );
      await asServiceRole(database, async (sql) => sql`
        select app.append_sp_write_observation(
          ${JSON.stringify(observation)},
          ${serializeSpWriteObservationFingerprint(observation)}
        )
      `);
    };

    await runOrder(33_800, 'stale_first');
    await runOrder(33_900, 'valid_first');
  }, 30_000);

  it('closes a committed bounded intent after every mutable authority is withdrawn', async () => {
    const bounded = await prepareBoundedExecution(database, tenant, 33_540);
    const [times] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!times) throw new Error('SP post-intent closure timestamps were not derived');
    const artifacts = reservationArtifacts(
      bounded.forward,
      bounded.receipt,
      bounded.leaseId,
      times.observed_at,
      times.valid_until,
      33_550,
    );
    const [reservation] = await asServiceRole(database, async (sql) => sql<{
      decision: string;
      result_id: string;
    }[]>`
      select decision, result_id::text from app.reserve_sp_write_provider_call(
        ${bounded.receipt.executionId}::uuid,
        ${bounded.forward.plan.id}::uuid,
        ${bounded.receipt.generation}::uuid,
        ${bounded.leaseId}::uuid,
        ${JSON.stringify(artifacts.observation)},
        ${serializeSpWritePredispatchObservationFingerprint(artifacts.observation)},
        ${JSON.stringify(artifacts.intent)},
        ${artifacts.requestPreimage},
        ${artifacts.intentPreimage}
      )
    `);
    expect(reservation?.decision).toBe('won');

    const disabledEnvironment = uuid(33_560);
    const disabledGrant = uuid(33_561);
    const disabledGrantVersion = uuid(33_562);
    await database.sql.begin(async (sql) => {
      await sql`
        insert into public.sp_write_environment_gate_versions
          (version_id, enabled, max_unresolved_calls, created_by)
        values (${disabledEnvironment}::uuid, false, 1, ${tenant.userId}::uuid)
      `;
      await sql`
        update public.sp_write_environment_gate_head
           set version_id = ${disabledEnvironment}::uuid
         where singleton
      `;
      await sql`
        insert into public.sp_write_profile_grant_versions
          (grant_id, version_id, org_id, profile_id, enabled, amazon_profile_id,
           connection_id, region, marketplace_id, currency_code, api_dialect, created_by)
        values (
          ${disabledGrant}::uuid, ${disabledGrantVersion}::uuid,
          ${tenant.orgId}::uuid, ${tenant.profileId}::uuid, false,
          ${tenant.amazonProfileId}, ${tenant.connectionId}::uuid,
          'NA', 'synthetic-marketplace', 'USD', 'sp_v3', ${tenant.userId}::uuid
        )
      `;
      await sql`
        update public.sp_write_profile_grant_heads
           set grant_id = ${disabledGrant}::uuid, version_id = ${disabledGrantVersion}::uuid
         where org_id = ${tenant.orgId}::uuid and profile_id = ${tenant.profileId}::uuid
      `;
      await sql`
        update public.ads_connections set status = 'revoked'
         where org_id = ${tenant.orgId}::uuid and id = ${tenant.connectionId}::uuid
      `;
      await sql`
        insert into public.sp_write_bounded_authorization_revocations
          (authorization_id, reason)
        values (${bounded.authorization.authorizationId}::uuid, 'synthetic post-intent revocation')
      `;
      await sql.unsafe("set local session_replication_role = 'replica'");
      await sql`
        update public.sp_write_dispatch_leases
           set acquired_at = clock_timestamp() - interval '3 minutes',
               expires_at = clock_timestamp() - interval '1 minute'
         where lease_id = ${bounded.leaseId}::uuid
      `;
    });

    const [completed] = await database.sql<{ completed_at: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as completed_at
    `;
    if (!completed || !reservation) throw new Error('SP post-intent result fixture is incomplete');
    const result = acceptedProviderResult(
      artifacts.intent,
      reservation.result_id,
      completed.completed_at,
    );
    expect(await asServiceRole(database, async (sql) => sql<{ outcome: string }[]>`
      select app.append_sp_write_provider_result(
        ${JSON.stringify(result)},
        ${serializeSpWriteProviderResultFingerprint(result)},
        'provider_adapter'
      ) as outcome
    `)).toEqual([{ outcome: 'recorded' }]);
    const [wake] = await database.sql<{ source_sync_job_id: string; observed_at: string }[]>`
      select source_sync_job_id::text,
             app.sp_write_instant(clock_timestamp()) as observed_at
        from public.sp_write_outbox
       where intent_id = ${artifacts.intent.intentId}::uuid
    `;
    if (!wake) throw new Error('SP post-intent observation wake is missing');
    const observation = requestedObservation(
      bounded.forward,
      bounded.receipt,
      artifacts.intent,
      wake.source_sync_job_id,
      wake.observed_at,
      uuid(33_563),
    );
    await asServiceRole(database, async (sql) => sql`
      select app.append_sp_write_observation(
        ${JSON.stringify(observation)},
        ${serializeSpWriteObservationFingerprint(observation)}
      )
    `);
    expect((await expectAccountingMatchesShared(
      database,
      bounded.receipt.executionId,
      bounded.forward.plan.id,
    )).status).toBe('succeeded');

    await database.sql.begin(async (sql) => {
      await sql`
        update public.sp_write_environment_gate_head
           set version_id = ${bounded.receipt.gateSnapshot.environmentGateVersion}::uuid
         where singleton
      `;
      await sql`
        update public.sp_write_profile_grant_heads
           set grant_id = ${bounded.receipt.gateSnapshot.profileGrantId}::uuid,
               version_id = ${bounded.receipt.gateSnapshot.profileGrantVersion}::uuid
         where org_id = ${tenant.orgId}::uuid and profile_id = ${tenant.profileId}::uuid
      `;
      await sql`
        update public.ads_connections set status = 'active'
         where org_id = ${tenant.orgId}::uuid and id = ${tenant.connectionId}::uuid
      `;
    });
  });

  it('rolls back every row when the backend dies before or after intent insertion', async () => {
    const waitForQuery = async (pid: number, fragment: string) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [activity] = await database.sql<{ query: string; state: string }[]>`
          select query, state from pg_stat_activity where pid = ${pid}
        `;
        if (activity?.state === 'active' && activity.query.includes(fragment)) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`SP fault-injection query did not reach ${fragment}`);
    };
    const before = await prepareReservation(33_600);
    const blockerPool = postgres(
      database.connectionString,
      { max: 1, prepare: false, onnotice: () => {} },
    );
    const beforePool = postgres(
      database.connectionString,
      { max: 1, prepare: false, onnotice: () => {} },
    );
    let blockerReadyResolve!: () => void;
    let blockerReleaseResolve!: () => void;
    const blockerReady = new Promise<void>((resolve) => { blockerReadyResolve = resolve; });
    const blockerRelease = new Promise<void>((resolve) => { blockerReleaseResolve = resolve; });
    const blocker = blockerPool.begin(async (sql) => {
      await sql`select 1 from public.sp_write_environment_gate_head where singleton for update`;
      blockerReadyResolve();
      await blockerRelease;
    });
    await blockerReady;
    let beforePidResolve!: (pid: number) => void;
    const beforePid = new Promise<number>((resolve) => { beforePidResolve = resolve; });
    const beforeCrash = beforePool.begin(async (sql) => {
      await sql.unsafe('set local role service_role');
      const [backend] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      if (!backend) throw new Error('SP before-intent backend PID is missing');
      beforePidResolve(backend.pid);
      return sql`
        select * from app.reserve_sp_write_provider_call(
          ${before.receipt.executionId}::uuid,
          ${before.proof.plan.id}::uuid,
          ${before.receipt.generation}::uuid,
          ${before.leaseId}::uuid,
          ${JSON.stringify(before.artifacts.observation)},
          ${serializeSpWritePredispatchObservationFingerprint(before.artifacts.observation)},
          ${JSON.stringify(before.artifacts.intent)},
          ${before.artifacts.requestPreimage},
          ${before.artifacts.intentPreimage}
        )
      `;
    });
    const beforeCrashOutcome = beforeCrash.then(
      () => ({ status: 'fulfilled' as const, error: null }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    const killedBefore = await beforePid;
    await waitForQuery(killedBefore, 'reserve_sp_write_provider_call');
    const [terminatedBefore] = await database.sql<{ terminated: boolean }[]>`
      select pg_cancel_backend(${killedBefore}) as terminated
    `;
    expect(terminatedBefore?.terminated).toBe(true);
    blockerReleaseResolve();
    await blocker;
    const beforeOutcome = await beforeCrashOutcome;
    expect(beforeOutcome.status).toBe('rejected');
    expect(beforeOutcome.error).toBeInstanceOf(Error);
    await Promise.all([
      blockerPool.end({ timeout: 5 }),
      beforePool.end({ timeout: 5 }),
    ]);
    await assertNoReservationEvidence(before.proof.plan.id);

    const after = await prepareReservation(33_700);
    const afterPool = postgres(
      database.connectionString,
      { max: 1, prepare: false, onnotice: () => {} },
    );
    let insertedResolve!: (pid: number) => void;
    const inserted = new Promise<number>((resolve) => { insertedResolve = resolve; });
    const afterCrash = afterPool.begin(async (sql) => {
      await sql.unsafe('set local role service_role');
      const [backend] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      if (!backend) throw new Error('SP after-intent backend PID is missing');
      const [reservation] = await sql<{ decision: string }[]>`
        select decision from app.reserve_sp_write_provider_call(
          ${after.receipt.executionId}::uuid,
          ${after.proof.plan.id}::uuid,
          ${after.receipt.generation}::uuid,
          ${after.leaseId}::uuid,
          ${JSON.stringify(after.artifacts.observation)},
          ${serializeSpWritePredispatchObservationFingerprint(after.artifacts.observation)},
          ${JSON.stringify(after.artifacts.intent)},
          ${after.artifacts.requestPreimage},
          ${after.artifacts.intentPreimage}
        )
      `;
      expect(reservation?.decision).toBe('won');
      insertedResolve(backend.pid);
      await sql`select pg_sleep(30)`;
    });
    const afterCrashOutcome = afterCrash.then(
      () => ({ status: 'fulfilled' as const, error: null }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    const killedAfter = await inserted;
    await waitForQuery(killedAfter, 'pg_sleep');
    const [terminatedAfter] = await database.sql<{ terminated: boolean }[]>`
      select pg_cancel_backend(${killedAfter}) as terminated
    `;
    expect(terminatedAfter?.terminated).toBe(true);
    const afterOutcome = await afterCrashOutcome;
    expect(afterOutcome.status).toBe('rejected');
    expect(afterOutcome.error).toBeInstanceOf(Error);
    await afterPool.end({ timeout: 5 });
    await assertNoReservationEvidence(after.proof.plan.id);
  }, 20_000);
});

describe.skipIf(!available)('SP write organisation purge safety', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createWp187TestDatabase('sp_write_org_purge_safety');
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  async function seedTenant(label: string, seed: number) {
    const userId = uuid(seed);
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture(${label}, ${userId}::uuid, 'owner')
    `;
    const [profile] = await database.sql<{
      id: string;
      connection_id: string;
      amazon_profile_id: string;
    }[]>`
      select id, connection_id, amazon_profile_id
        from public.ad_profiles
       where org_id = ${org?.seed_tenant_fixture ?? null}::uuid
    `;
    if (!org || !profile) throw new Error(`SP purge tenant ${label} was not seeded`);
    const tenant: SpTenant = {
      orgId: org.seed_tenant_fixture,
      profileId: profile.id,
      connectionId: profile.connection_id,
      amazonProfileId: profile.amazon_profile_id,
      userId,
    };
    await enableTestAuthority(database, tenant, seed + 10);
    return tenant;
  }

  async function prepareReservation(tenant: SpTenant, seed: number) {
    const cycle = await prepareManualExecution(database, tenant, seed);
    const [times] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!times) throw new Error('SP purge reservation timestamps were not derived');
    const artifacts = reservationArtifacts(
      cycle.proof,
      cycle.receipt,
      cycle.leaseId,
      times.observed_at,
      times.valid_until,
      seed + 10,
    );
    return { ...cycle, artifacts };
  }

  async function appendAcceptedResult(
    cycle: Awaited<ReturnType<typeof prepareReservation>>,
    resultId: string,
  ) {
    const [time] = await database.sql<{ completed_at: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as completed_at
    `;
    if (!time) throw new Error('SP purge result time is missing');
    const result = acceptedProviderResult(cycle.artifacts.intent, resultId, time.completed_at);
    await asServiceRole(database, async (sql) => sql`
      select app.append_sp_write_provider_result(
        ${JSON.stringify(result)},
        ${serializeSpWriteProviderResultFingerprint(result)},
        'provider_adapter'
      )
    `);
  }

  async function waitForQuery(pid: number, fragment: string) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [activity] = await database.sql<{ query: string; state: string }[]>`
        select query, state from pg_stat_activity where pid = ${pid}
      `;
      if (activity?.state === 'active' && activity.query.includes(fragment)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`SP purge race query did not reach ${fragment}`);
  }

  it('blocks unresolved purge, preserves evidence, then permits purge after a durable result', async () => {
    const tenant = await seedTenant('sp-purge-unresolved', 34_001);
    const cycle = await prepareReservation(tenant, 34_100);
    const [reservation] = await asServiceRole(database, async (sql) => sql<{
      decision: string;
      result_id: string;
    }[]>`
      select decision, result_id::text from app.reserve_sp_write_provider_call(
        ${cycle.receipt.executionId}::uuid,
        ${cycle.proof.plan.id}::uuid,
        ${cycle.receipt.generation}::uuid,
        ${cycle.leaseId}::uuid,
        ${JSON.stringify(cycle.artifacts.observation)},
        ${serializeSpWritePredispatchObservationFingerprint(cycle.artifacts.observation)},
        ${JSON.stringify(cycle.artifacts.intent)},
        ${cycle.artifacts.requestPreimage},
        ${cycle.artifacts.intentPreimage}
      )
    `);
    expect(reservation?.decision).toBe('won');
    await expect(database.sql`delete from public.orgs where id = ${tenant.orgId}::uuid`)
      .rejects.toThrow(/unresolved SP write provider call intent/i);
    const [preserved] = await database.sql<{
      orgs: number;
      intents: number;
      positions: number;
      resolutions: number;
      wakes: number;
    }[]>`
      select
        (select count(*)::int from public.orgs where id = ${tenant.orgId}::uuid) as orgs,
        (select count(*)::int from public.sp_write_provider_call_intents
          where intent_id = ${cycle.artifacts.intent.intentId}::uuid) as intents,
        (select count(*)::int from public.sp_write_provider_call_positions
          where intent_id = ${cycle.artifacts.intent.intentId}::uuid) as positions,
        (select count(*)::int from public.sp_write_action_resolutions
          where intent_id = ${cycle.artifacts.intent.intentId}::uuid) as resolutions,
        (select count(*)::int from public.sp_write_outbox
          where intent_id = ${cycle.artifacts.intent.intentId}::uuid) as wakes
    `;
    expect(preserved).toEqual({ orgs: 1, intents: 1, positions: 1, resolutions: 1, wakes: 1 });

    await appendAcceptedResult(cycle, reservation!.result_id);
    const deleted = await database.sql<{ id: string }[]>`
      delete from public.orgs where id = ${tenant.orgId}::uuid returning id::text
    `;
    expect(deleted).toEqual([{ id: tenant.orgId }]);
    const [purged] = await database.sql<{ orgs: number; tenant_evidence: number }[]>`
      select
        (select count(*)::int from public.orgs where id = ${tenant.orgId}::uuid) as orgs,
        (
          (select count(*) from public.sp_write_plans where org_id = ${tenant.orgId}::uuid)
          + (select count(*) from public.sp_write_provider_call_intents
              where org_id = ${tenant.orgId}::uuid)
          + (select count(*) from public.sp_write_provider_results
              where org_id = ${tenant.orgId}::uuid)
        )::int as tenant_evidence
    `;
    expect(purged).toEqual({ orgs: 0, tenant_evidence: 0 });
  });

  it('serializes reservation-first and delete-first races without cascading a committed intent', async () => {
    const reservationFirstTenant = await seedTenant('sp-purge-reservation-first', 34_201);
    const reservationFirst = await prepareReservation(reservationFirstTenant, 34_300);
    const reservePool = postgres(
      database.connectionString,
      { max: 1, prepare: false, onnotice: () => {} },
    );
    const deletePool = postgres(
      database.connectionString,
      { max: 1, prepare: false, onnotice: () => {} },
    );
    let reservedResolve!: (value: { pid: number; resultId: string }) => void;
    let reserveReleaseResolve!: () => void;
    const reserved = new Promise<{ pid: number; resultId: string }>((resolve) => {
      reservedResolve = resolve;
    });
    const reserveRelease = new Promise<void>((resolve) => { reserveReleaseResolve = resolve; });
    const heldReservation = reservePool.begin(async (sql) => {
      await sql.unsafe('set local role service_role');
      const [backend] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      const [row] = await sql<{ decision: string; result_id: string }[]>`
        select decision, result_id::text from app.reserve_sp_write_provider_call(
          ${reservationFirst.receipt.executionId}::uuid,
          ${reservationFirst.proof.plan.id}::uuid,
          ${reservationFirst.receipt.generation}::uuid,
          ${reservationFirst.leaseId}::uuid,
          ${JSON.stringify(reservationFirst.artifacts.observation)},
          ${serializeSpWritePredispatchObservationFingerprint(
            reservationFirst.artifacts.observation,
          )},
          ${JSON.stringify(reservationFirst.artifacts.intent)},
          ${reservationFirst.artifacts.requestPreimage},
          ${reservationFirst.artifacts.intentPreimage}
        )
      `;
      if (!backend || row?.decision !== 'won') {
        throw new Error('SP reservation-first transaction did not win');
      }
      reservedResolve({ pid: backend.pid, resultId: row.result_id });
      await reserveRelease;
    });
    const reservationState = await reserved;
    let deletePidResolve!: (pid: number) => void;
    const deletePid = new Promise<number>((resolve) => { deletePidResolve = resolve; });
    const blockedDelete = deletePool.begin(async (sql) => {
      const [backend] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      if (!backend) throw new Error('SP reservation-first delete PID is missing');
      deletePidResolve(backend.pid);
      return sql`delete from public.orgs where id = ${reservationFirstTenant.orgId}::uuid`;
    });
    const deletingPid = await deletePid;
    await waitForQuery(deletingPid, 'delete from public.orgs');
    reserveReleaseResolve();
    await heldReservation;
    await expect(blockedDelete).rejects.toThrow(/unresolved SP write provider call intent/i);
    await Promise.all([
      reservePool.end({ timeout: 5 }),
      deletePool.end({ timeout: 5 }),
    ]);
    const [reservationFirstClosure] = await database.sql<{ orgs: number; intents: number }[]>`
      select
        (select count(*)::int from public.orgs
          where id = ${reservationFirstTenant.orgId}::uuid) as orgs,
        (select count(*)::int from public.sp_write_provider_call_intents
          where intent_id = ${reservationFirst.artifacts.intent.intentId}::uuid) as intents
    `;
    expect(reservationFirstClosure).toEqual({ orgs: 1, intents: 1 });
    await appendAcceptedResult(reservationFirst, reservationState.resultId);
    await database.sql`delete from public.orgs where id = ${reservationFirstTenant.orgId}::uuid`;

    const deleteFirstTenant = await seedTenant('sp-purge-delete-first', 34_401);
    const deleteFirst = await prepareReservation(deleteFirstTenant, 34_500);
    const heldDeletePool = postgres(
      database.connectionString,
      { max: 1, prepare: false, onnotice: () => {} },
    );
    const blockedReservePool = postgres(
      database.connectionString,
      { max: 1, prepare: false, onnotice: () => {} },
    );
    let deletedResolve!: () => void;
    let deleteReleaseResolve!: () => void;
    const deleted = new Promise<void>((resolve) => { deletedResolve = resolve; });
    const deleteRelease = new Promise<void>((resolve) => { deleteReleaseResolve = resolve; });
    const heldDelete = heldDeletePool.begin(async (sql) => {
      await sql`delete from public.orgs where id = ${deleteFirstTenant.orgId}::uuid`;
      deletedResolve();
      await deleteRelease;
    });
    await deleted;
    let reservePidResolve!: (pid: number) => void;
    const reservePid = new Promise<number>((resolve) => { reservePidResolve = resolve; });
    const blockedReserve = blockedReservePool.begin(async (sql) => {
      await sql.unsafe('set local role service_role');
      const [backend] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      if (!backend) throw new Error('SP delete-first reserve PID is missing');
      reservePidResolve(backend.pid);
      return sql`
        select * from app.reserve_sp_write_provider_call(
          ${deleteFirst.receipt.executionId}::uuid,
          ${deleteFirst.proof.plan.id}::uuid,
          ${deleteFirst.receipt.generation}::uuid,
          ${deleteFirst.leaseId}::uuid,
          ${JSON.stringify(deleteFirst.artifacts.observation)},
          ${serializeSpWritePredispatchObservationFingerprint(deleteFirst.artifacts.observation)},
          ${JSON.stringify(deleteFirst.artifacts.intent)},
          ${deleteFirst.artifacts.requestPreimage},
          ${deleteFirst.artifacts.intentPreimage}
        )
      `;
    });
    const blockedPid = await reservePid;
    await waitForQuery(blockedPid, 'reserve_sp_write_provider_call');
    deleteReleaseResolve();
    await heldDelete;
    await expect(blockedReserve).rejects.toThrow();
    await Promise.all([
      heldDeletePool.end({ timeout: 5 }),
      blockedReservePool.end({ timeout: 5 }),
    ]);
    const [deleteFirstClosure] = await database.sql<{ orgs: number; intents: number }[]>`
      select
        (select count(*)::int from public.orgs
          where id = ${deleteFirstTenant.orgId}::uuid) as orgs,
        (select count(*)::int from public.sp_write_provider_call_intents
          where intent_id = ${deleteFirst.artifacts.intent.intentId}::uuid) as intents
    `;
    expect(deleteFirstClosure).toEqual({ orgs: 0, intents: 0 });
  }, 20_000);

  it('preserves global bounded consumption across the first tenant purge', async () => {
    const tenantA = await seedTenant('sp-purge-bounded-a', 34_601);
    const tenantB = await seedTenant('sp-purge-bounded-b', 34_701);
    const forwardA = keywordPlan(
      tenantA.orgId,
      tenantA.profileId,
      tenantA.connectionId,
      tenantA.amazonProfileId,
      uuid(34_800),
    );
    const inverseA = inverseKeywordPlan(
      forwardA,
      uuid(34_801),
      uuid(34_802),
      uuid(34_803),
    );
    const forwardB = keywordPlan(
      tenantB.orgId,
      tenantB.profileId,
      tenantB.connectionId,
      tenantB.amazonProfileId,
      uuid(34_804),
    );
    const inverseB = inverseKeywordPlan(
      forwardB,
      uuid(34_805),
      uuid(34_806),
      uuid(34_807),
    );
    const single = boundedAuthorization(forwardA.plan, uuid(34_808));
    const authorizationBase = SpWriteBoundedAuthorization.parse({
      ...single,
      profiles: [
        single.profiles[0],
        {
          providerScope: forwardB.plan.providerScope,
          allowedEntities: [{
            routeKey: 'sp.v3.keywords.update',
            amazonEntityId: 'kw-1',
            allowedChangeKeys: ['keyword.bid'],
            maxAbsoluteMoneyDelta: '0.1',
            maxAbsolutePlacementDelta: null,
          }],
        },
      ],
      fingerprint: '0'.repeat(64),
    });
    const authorization = SpWriteBoundedAuthorization.parse({
      ...authorizationBase,
      fingerprint: sha256(serializeSpWriteBoundedAuthorizationFingerprint(authorizationBase)),
    });
    for (const proof of [forwardA, inverseA, forwardB, inverseB]) {
      await asServiceRole(database, async (sql) => sql`
        select app.record_sp_write_plan(
          ${JSON.stringify(proof.plan)},
          ${proof.planPreimage},
          ${JSON.stringify([{
            artifactText: JSON.stringify(proof.action),
            fingerprintPreimage: proof.actionPreimage,
          }])}::jsonb
        )
      `);
    }
    await asServiceRole(database, async (sql) => sql`
      select app.record_sp_write_bounded_authorization(
        ${JSON.stringify(authorization)},
        ${serializeSpWriteBoundedAuthorizationFingerprint(authorization)},
        ${JSON.stringify([
          { orgId: tenantA.orgId, profileId: tenantA.profileId },
          { orgId: tenantB.orgId, profileId: tenantB.profileId },
        ])}::jsonb
      )
    `);
    const requestA = ApproveSpWritePlan.parse({
      approvalRequestId: uuid(34_809),
      plan: spWritePlanBinding(forwardA.plan),
      approvalMode: 'bounded_live_test',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
      boundedAuthorization: {
        authorizationId: authorization.authorizationId,
        authorizationFingerprint: authorization.fingerprint,
        expiresAt: authorization.expiresAt,
      },
      preapprovedInversePlan: spWritePlanBinding(inverseA.plan),
    });
    const [approvedA] = await asUser(database, tenantA.userId, async (sql) => sql<{
      receipt: unknown;
    }[]>`
      select app.approve_sp_write_cycle(${forwardA.plan.id}::uuid, ${JSON.stringify(requestA)})
        as receipt
    `);
    const receiptA = SpWriteAuthorizationReceipt.parse(approvedA?.receipt);
    const [beforePurge] = await database.sql<{
      consumptions: number;
      execution_id: string;
      cycles: number;
    }[]>`
      select
        (select count(*)::int from public.sp_write_bounded_authorization_consumptions
          where authorization_id = ${authorization.authorizationId}::uuid) as consumptions,
        consumption.execution_id::text as execution_id,
        (select count(*)::int from public.sp_write_execution_cycles
          where execution_id = ${receiptA.executionId}::uuid) as cycles
      from public.sp_write_bounded_authorization_consumptions consumption
      where consumption.authorization_id = ${authorization.authorizationId}::uuid
    `;
    expect(beforePurge).toEqual({
      consumptions: 1,
      execution_id: receiptA.executionId,
      cycles: 1,
    });
    await database.sql`delete from public.orgs where id = ${tenantA.orgId}::uuid`;
    const [afterPurge] = await database.sql<{
      consumptions: number;
      execution_id: string;
      cycles: number;
      orgs: number;
    }[]>`
      select
        (select count(*)::int from public.sp_write_bounded_authorization_consumptions
          where authorization_id = ${authorization.authorizationId}::uuid) as consumptions,
        consumption.execution_id::text as execution_id,
        (select count(*)::int from public.sp_write_execution_cycles
          where execution_id = ${receiptA.executionId}::uuid) as cycles,
        (select count(*)::int from public.orgs where id = ${tenantA.orgId}::uuid) as orgs
      from public.sp_write_bounded_authorization_consumptions consumption
      where consumption.authorization_id = ${authorization.authorizationId}::uuid
    `;
    expect(afterPurge).toEqual({
      consumptions: 1,
      execution_id: receiptA.executionId,
      cycles: 0,
      orgs: 0,
    });

    const requestB = ApproveSpWritePlan.parse({
      approvalRequestId: uuid(34_810),
      plan: spWritePlanBinding(forwardB.plan),
      approvalMode: 'bounded_live_test',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
      boundedAuthorization: {
        authorizationId: authorization.authorizationId,
        authorizationFingerprint: authorization.fingerprint,
        expiresAt: authorization.expiresAt,
      },
      preapprovedInversePlan: spWritePlanBinding(inverseB.plan),
    });
    await expect(asUser(database, tenantB.userId, async (sql) => sql`
      select app.approve_sp_write_cycle(${forwardB.plan.id}::uuid, ${JSON.stringify(requestB)})
    `)).rejects.toThrow(/already consumed its cycle|maxCycles/i);
    const [blocked] = await database.sql<{
      requests: number;
      receipts: number;
      cycles: number;
      consumptions: number;
    }[]>`
      select
        (select count(*)::int from public.sp_write_approval_requests
          where approval_request_id = ${requestB.approvalRequestId}::uuid) as requests,
        (select count(*)::int from public.sp_write_authorization_receipts
          where approval_request_id = ${requestB.approvalRequestId}::uuid) as receipts,
        (select count(*)::int from public.sp_write_execution_cycles
          where execution_id = ${inverseB.sourceExecutionId}::uuid) as cycles,
        (select count(*)::int from public.sp_write_bounded_authorization_consumptions
          where authorization_id = ${authorization.authorizationId}::uuid) as consumptions
    `;
    expect(blocked).toEqual({ requests: 0, receipts: 0, cycles: 0, consumptions: 1 });
  });
});

describe.skipIf(!available)('SP write accounting branch matrix', () => {
  let database: TestDatabase;
  let tenant: SpTenant;

  beforeAll(async () => {
    database = await createWp187TestDatabase('sp_write_accounting_matrix');
    const userId = uuid(32_001);
    const [seed] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('sp-accounting', ${userId}::uuid, 'owner')
    `;
    const [profile] = await database.sql<{
      id: string;
      connection_id: string;
      amazon_profile_id: string;
    }[]>`
      select id, connection_id, amazon_profile_id
        from public.ad_profiles
       where org_id = ${seed?.seed_tenant_fixture ?? null}::uuid
    `;
    if (!seed || !profile) throw new Error('SP accounting tenant was not seeded');
    tenant = {
      orgId: seed.seed_tenant_fixture,
      profileId: profile.id,
      connectionId: profile.connection_id,
      amazonProfileId: profile.amazon_profile_id,
      userId,
    };
    await enableTestAuthority(database, tenant, 32_010);
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  async function expectAccounting(
    executionId: string,
    planId: string,
    status: string,
    accounting: {
      approvedRows: number;
      pendingDispatch: number;
      refusedBeforeDispatch: number;
      intentCommitted: number;
      providerAccepted: number;
      providerRejected: number;
      providerAmbiguous: number;
      observedRequested: number;
      observedExpectedAfterAmbiguous: number;
      observationConflict: number;
      observationMissing: number;
      pendingObservation: number;
      providerCallsCommitted: number;
      providerCallsCompleted: number;
    },
  ) {
    const shared = await expectAccountingMatchesShared(database, executionId, planId);
    expect(shared.status).toBe(status);
    expect(shared.accounting).toEqual(accounting);
  }

  async function prepareTwoActionExecution(seed: number) {
    const proof = twoKeywordPlan(
      tenant.orgId,
      tenant.profileId,
      tenant.connectionId,
      tenant.amazonProfileId,
      uuid(seed),
      seed + 1,
    );
    await asServiceRole(database, async (sql) => sql`
      select app.record_sp_write_plan(
        ${JSON.stringify(proof.plan)},
        ${proof.planPreimage},
        ${JSON.stringify(proof.actions.map((action, index) => ({
          artifactText: JSON.stringify(action),
          fingerprintPreimage: proof.actionPreimages[index],
        })))}::jsonb
      )
    `);
    const request = ApproveSpWritePlan.parse({
      approvalRequestId: uuid(seed + 3),
      plan: spWritePlanBinding(proof.plan),
      approvalMode: 'manual',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
      boundedAuthorization: null,
      preapprovedInversePlan: null,
    });
    const [approved] = await asUser(database, tenant.userId, async (sql) => sql<{
      receipt: unknown;
    }[]>`
      select app.approve_sp_write_cycle(
        ${proof.plan.id}::uuid,
        ${JSON.stringify(request)}
      ) as receipt
    `);
    const receipt = SpWriteAuthorizationReceipt.parse(approved?.receipt);
    await asServiceRole(database, async (sql) => sql`
      select app.start_sp_write_execution(${receipt.approvalId}::uuid, ${proof.plan.id}::uuid)
    `);
    const [lease] = await asServiceRole(database, async (sql) => sql<{ lease_id: string }[]>`
      select lease_id::text
        from app.acquire_sp_write_dispatch_lease(
          ${receipt.executionId}::uuid,
          ${proof.plan.id}::uuid,
          ${receipt.generation}::uuid,
          'sp.v3.keywords.update',
          120
        )
    `);
    if (!lease) throw new Error('SP accounting two-action lease was not acquired');
    return { proof, receipt, leaseId: lease.lease_id };
  }

  it('matches every deterministic status and counter branch to the shared derivation', async () => {
    const zero = {
      refusedBeforeDispatch: 0,
      providerAccepted: 0,
      providerRejected: 0,
      providerAmbiguous: 0,
      observedRequested: 0,
      observedExpectedAfterAmbiguous: 0,
      observationConflict: 0,
      observationMissing: 0,
      providerCallsCompleted: 0,
    };

    const accepted = await prepareManualExecution(database, tenant, 32_100);
    await expectAccounting(
      accepted.receipt.executionId,
      accepted.proof.plan.id,
      'queued',
      {
        approvedRows: 1,
        pendingDispatch: 1,
        intentCommitted: 0,
        pendingObservation: 0,
        providerCallsCommitted: 0,
        ...zero,
      },
    );
    const [acceptedTimes] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!acceptedTimes) throw new Error('SP accounting accepted timestamps were not derived');
    const acceptedArtifacts = reservationArtifacts(
      accepted.proof,
      accepted.receipt,
      accepted.leaseId,
      acceptedTimes.observed_at,
      acceptedTimes.valid_until,
      32_110,
    );
    const [acceptedReservation] = await asServiceRole(database, async (sql) => sql<{
      decision: string;
      result_id: string;
    }[]>`
      select decision, result_id::text
        from app.reserve_sp_write_provider_call(
          ${accepted.receipt.executionId}::uuid,
          ${accepted.proof.plan.id}::uuid,
          ${accepted.receipt.generation}::uuid,
          ${accepted.leaseId}::uuid,
          ${JSON.stringify(acceptedArtifacts.observation)},
          ${serializeSpWritePredispatchObservationFingerprint(acceptedArtifacts.observation)},
          ${JSON.stringify(acceptedArtifacts.intent)},
          ${acceptedArtifacts.requestPreimage},
          ${acceptedArtifacts.intentPreimage}
        )
    `);
    expect(acceptedReservation?.decision).toBe('won');
    await expectAccounting(
      accepted.receipt.executionId,
      accepted.proof.plan.id,
      'awaiting_observation',
      {
        approvedRows: 1,
        pendingDispatch: 0,
        refusedBeforeDispatch: 0,
        intentCommitted: 1,
        providerAccepted: 0,
        providerRejected: 0,
        providerAmbiguous: 1,
        observedRequested: 0,
        observedExpectedAfterAmbiguous: 0,
        observationConflict: 0,
        observationMissing: 0,
        pendingObservation: 1,
        providerCallsCommitted: 1,
        providerCallsCompleted: 0,
      },
    );
    const acceptedCycle = {
      ...accepted,
      artifacts: acceptedArtifacts,
      resultId: acceptedReservation!.result_id,
    };
    const acceptedResult = await appendResultAndReadWake(database, acceptedCycle, ['accepted']);
    await expectAccounting(
      accepted.receipt.executionId,
      accepted.proof.plan.id,
      'awaiting_observation',
      {
        approvedRows: 1,
        pendingDispatch: 0,
        refusedBeforeDispatch: 0,
        intentCommitted: 1,
        providerAccepted: 1,
        providerRejected: 0,
        providerAmbiguous: 0,
        observedRequested: 0,
        observedExpectedAfterAmbiguous: 0,
        observationConflict: 0,
        observationMissing: 0,
        pendingObservation: 1,
        providerCallsCommitted: 1,
        providerCallsCompleted: 1,
      },
    );
    const acceptedObservation = actionObservation(
      accepted.proof.plan,
      accepted.proof.action,
      accepted.receipt,
      acceptedArtifacts.intent,
      acceptedResult.wake.source_sync_job_id,
      acceptedResult.wake.observed_at,
      uuid(32_113),
      'observed_requested',
    );
    await asServiceRole(database, async (sql) => sql`
      select app.append_sp_write_observation(
        ${JSON.stringify(acceptedObservation)},
        ${serializeSpWriteObservationFingerprint(acceptedObservation)}
      )
    `);
    await expectAccounting(
      accepted.receipt.executionId,
      accepted.proof.plan.id,
      'succeeded',
      {
        approvedRows: 1,
        pendingDispatch: 0,
        refusedBeforeDispatch: 0,
        intentCommitted: 1,
        providerAccepted: 1,
        providerRejected: 0,
        providerAmbiguous: 0,
        observedRequested: 1,
        observedExpectedAfterAmbiguous: 0,
        observationConflict: 0,
        observationMissing: 0,
        pendingObservation: 0,
        providerCallsCommitted: 1,
        providerCallsCompleted: 1,
      },
    );

    const refused = await prepareManualExecution(database, tenant, 32_200);
    const [refusedTimes] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!refusedTimes) throw new Error('SP accounting refusal timestamps were not derived');
    const refusedArtifacts = reservationArtifacts(
      refused.proof,
      refused.receipt,
      refused.leaseId,
      refusedTimes.observed_at,
      refusedTimes.valid_until,
      32_210,
      'requested',
    );
    const [refusedDecision] = await asServiceRole(database, async (sql) => sql<{
      decision: string;
    }[]>`
      select decision
        from app.reserve_sp_write_provider_call(
          ${refused.receipt.executionId}::uuid,
          ${refused.proof.plan.id}::uuid,
          ${refused.receipt.generation}::uuid,
          ${refused.leaseId}::uuid,
          ${JSON.stringify(refusedArtifacts.observation)},
          ${serializeSpWritePredispatchObservationFingerprint(refusedArtifacts.observation)},
          ${JSON.stringify(refusedArtifacts.intent)},
          ${refusedArtifacts.requestPreimage},
          ${refusedArtifacts.intentPreimage}
        )
    `);
    expect(refusedDecision?.decision).toBe('refused');
    await expectAccounting(
      refused.receipt.executionId,
      refused.proof.plan.id,
      'refused',
      {
        approvedRows: 1,
        pendingDispatch: 0,
        refusedBeforeDispatch: 1,
        intentCommitted: 0,
        providerAccepted: 0,
        providerRejected: 0,
        providerAmbiguous: 0,
        observedRequested: 0,
        observedExpectedAfterAmbiguous: 0,
        observationConflict: 0,
        observationMissing: 0,
        pendingObservation: 0,
        providerCallsCommitted: 0,
        providerCallsCompleted: 0,
      },
    );

    const rejected = await reserveWinningManualCycle(database, tenant, 32_300);
    await appendResultAndReadWake(database, rejected, ['authoritative_rejected']);
    await expectAccounting(
      rejected.receipt.executionId,
      rejected.proof.plan.id,
      'failed',
      {
        approvedRows: 1,
        pendingDispatch: 0,
        refusedBeforeDispatch: 0,
        intentCommitted: 1,
        providerAccepted: 0,
        providerRejected: 1,
        providerAmbiguous: 0,
        observedRequested: 0,
        observedExpectedAfterAmbiguous: 0,
        observationConflict: 0,
        observationMissing: 0,
        pendingObservation: 0,
        providerCallsCommitted: 1,
        providerCallsCompleted: 1,
      },
    );

    const ambiguous = await reserveWinningManualCycle(database, tenant, 32_400);
    const ambiguousResult = await appendResultAndReadWake(database, ambiguous, ['ambiguous']);
    const expectedObservation = actionObservation(
      ambiguous.proof.plan,
      ambiguous.proof.action,
      ambiguous.receipt,
      ambiguous.artifacts.intent,
      ambiguousResult.wake.source_sync_job_id,
      ambiguousResult.wake.observed_at,
      uuid(32_413),
      'observed_expected_after_ambiguous',
    );
    await asServiceRole(database, async (sql) => sql`
      select app.append_sp_write_observation(
        ${JSON.stringify(expectedObservation)},
        ${serializeSpWriteObservationFingerprint(expectedObservation)}
      )
    `);
    await expectAccounting(
      ambiguous.receipt.executionId,
      ambiguous.proof.plan.id,
      'ambiguous',
      {
        approvedRows: 1,
        pendingDispatch: 0,
        refusedBeforeDispatch: 0,
        intentCommitted: 1,
        providerAccepted: 0,
        providerRejected: 0,
        providerAmbiguous: 1,
        observedRequested: 0,
        observedExpectedAfterAmbiguous: 1,
        observationConflict: 0,
        observationMissing: 0,
        pendingObservation: 0,
        providerCallsCommitted: 1,
        providerCallsCompleted: 1,
      },
    );

    const reconciled = await reserveWinningManualCycle(database, tenant, 32_500);
    const reconciledResult = await appendResultAndReadWake(database, reconciled, ['ambiguous']);
    const reconciledObservation = actionObservation(
      reconciled.proof.plan,
      reconciled.proof.action,
      reconciled.receipt,
      reconciled.artifacts.intent,
      reconciledResult.wake.source_sync_job_id,
      reconciledResult.wake.observed_at,
      uuid(32_513),
      'observed_requested',
    );
    await asServiceRole(database, async (sql) => sql`
      select app.append_sp_write_observation(
        ${JSON.stringify(reconciledObservation)},
        ${serializeSpWriteObservationFingerprint(reconciledObservation)}
      )
    `);
    await expectAccounting(
      reconciled.receipt.executionId,
      reconciled.proof.plan.id,
      'observed_after_ambiguous',
      {
        approvedRows: 1,
        pendingDispatch: 0,
        refusedBeforeDispatch: 0,
        intentCommitted: 1,
        providerAccepted: 0,
        providerRejected: 0,
        providerAmbiguous: 1,
        observedRequested: 1,
        observedExpectedAfterAmbiguous: 0,
        observationConflict: 0,
        observationMissing: 0,
        pendingObservation: 0,
        providerCallsCommitted: 1,
        providerCallsCompleted: 1,
      },
    );

    const running = await prepareTwoActionExecution(32_600);
    const [runningTimes] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!runningTimes) throw new Error('SP accounting running timestamps were not derived');
    const runningArtifacts = mixedStaleReservationArtifacts(
      running.proof,
      running.receipt,
      running.leaseId,
      runningTimes.observed_at,
      runningTimes.valid_until,
      32_610,
    );
    await asServiceRole(database, async (sql) => sql`
      select * from app.reserve_sp_write_provider_call(
        ${running.receipt.executionId}::uuid,
        ${running.proof.plan.id}::uuid,
        ${running.receipt.generation}::uuid,
        ${running.leaseId}::uuid,
        ${JSON.stringify(runningArtifacts.observation)},
        ${serializeSpWritePredispatchObservationFingerprint(runningArtifacts.observation)},
        ${JSON.stringify(runningArtifacts.intent)},
        ${runningArtifacts.requestPreimage},
        ${runningArtifacts.intentPreimage}
      )
    `);
    await expectAccounting(
      running.receipt.executionId,
      running.proof.plan.id,
      'running',
      {
        approvedRows: 2,
        pendingDispatch: 1,
        refusedBeforeDispatch: 1,
        intentCommitted: 0,
        providerAccepted: 0,
        providerRejected: 0,
        providerAmbiguous: 0,
        observedRequested: 0,
        observedExpectedAfterAmbiguous: 0,
        observationConflict: 0,
        observationMissing: 0,
        pendingObservation: 0,
        providerCallsCommitted: 0,
        providerCallsCompleted: 0,
      },
    );

    const partial = await prepareTwoActionExecution(32_700);
    const [partialTimes] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!partialTimes) throw new Error('SP accounting partial timestamps were not derived');
    const partialArtifacts = multiActionReservationArtifacts(
      partial.proof,
      partial.receipt,
      partial.leaseId,
      partialTimes.observed_at,
      partialTimes.valid_until,
      32_710,
    );
    const [partialReservation] = await asServiceRole(database, async (sql) => sql<{
      decision: string;
      result_id: string;
    }[]>`
      select decision, result_id::text
        from app.reserve_sp_write_provider_call(
          ${partial.receipt.executionId}::uuid,
          ${partial.proof.plan.id}::uuid,
          ${partial.receipt.generation}::uuid,
          ${partial.leaseId}::uuid,
          ${JSON.stringify(partialArtifacts.observation)},
          ${serializeSpWritePredispatchObservationFingerprint(partialArtifacts.observation)},
          ${JSON.stringify(partialArtifacts.intent)},
          ${partialArtifacts.requestPreimage},
          ${partialArtifacts.intentPreimage}
        )
    `);
    expect(partialReservation?.decision).toBe('won');
    const [partialTime] = await database.sql<{ completed_at: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as completed_at
    `;
    if (!partialTime || !partialReservation) {
      throw new Error('SP accounting partial result fixture is incomplete');
    }
    const partialResult = providerResultWithOutcomes(
      partialArtifacts.intent,
      partialReservation.result_id,
      partialTime.completed_at,
      ['accepted', 'authoritative_rejected'],
    );
    await asServiceRole(database, async (sql) => sql`
      select app.append_sp_write_provider_result(
        ${JSON.stringify(partialResult)},
        ${serializeSpWriteProviderResultFingerprint(partialResult)},
        'provider_adapter'
      )
    `);
    const [partialWake] = await database.sql<{ source_sync_job_id: string; observed_at: string }[]>`
      select source_sync_job_id::text,
             app.sp_write_instant(clock_timestamp()) as observed_at
        from public.sp_write_outbox
       where intent_id = ${partialArtifacts.intent.intentId}::uuid
    `;
    if (!partialWake) throw new Error('SP accounting partial wake is missing');
    const partialObservation = actionObservation(
      partial.proof.plan,
      partial.proof.actions[0],
      partial.receipt,
      partialArtifacts.intent,
      partialWake.source_sync_job_id,
      partialWake.observed_at,
      uuid(32_713),
      'observed_requested',
    );
    await asServiceRole(database, async (sql) => sql`
      select app.append_sp_write_observation(
        ${JSON.stringify(partialObservation)},
        ${serializeSpWriteObservationFingerprint(partialObservation)}
      )
    `);
    await expectAccounting(
      partial.receipt.executionId,
      partial.proof.plan.id,
      'partial',
      {
        approvedRows: 2,
        pendingDispatch: 0,
        refusedBeforeDispatch: 0,
        intentCommitted: 2,
        providerAccepted: 1,
        providerRejected: 1,
        providerAmbiguous: 0,
        observedRequested: 1,
        observedExpectedAfterAmbiguous: 0,
        observationConflict: 0,
        observationMissing: 0,
        pendingObservation: 0,
        providerCallsCommitted: 1,
        providerCallsCompleted: 1,
      },
    );

    const conflicted = await reserveWinningManualCycle(database, tenant, 32_800);
    const conflictResult = await appendResultAndReadWake(database, conflicted, ['accepted']);
    const conflict = actionObservation(
      conflicted.proof.plan,
      conflicted.proof.action,
      conflicted.receipt,
      conflicted.artifacts.intent,
      conflictResult.wake.source_sync_job_id,
      conflictResult.wake.observed_at,
      uuid(32_813),
      'conflict',
    );
    await asServiceRole(database, async (sql) => sql`
      select app.append_sp_write_observation(
        ${JSON.stringify(conflict)},
        ${serializeSpWriteObservationFingerprint(conflict)}
      )
    `);
    await expectAccounting(
      conflicted.receipt.executionId,
      conflicted.proof.plan.id,
      'conflict',
      {
        approvedRows: 1,
        pendingDispatch: 0,
        refusedBeforeDispatch: 0,
        intentCommitted: 1,
        providerAccepted: 1,
        providerRejected: 0,
        providerAmbiguous: 0,
        observedRequested: 0,
        observedExpectedAfterAmbiguous: 0,
        observationConflict: 1,
        observationMissing: 0,
        pendingObservation: 0,
        providerCallsCommitted: 1,
        providerCallsCompleted: 1,
      },
    );
  });
});

describe.skipIf(!available)('SP write byte and preimage roundtrip matrix', () => {
  let database: TestDatabase;
  let tenant: SpTenant;

  beforeAll(async () => {
    database = await createWp187TestDatabase('sp_write_roundtrip_matrix');
    const userId = uuid(31_001);
    const [seed] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('sp-roundtrip', ${userId}::uuid, 'owner')
    `;
    const [profile] = await database.sql<{
      id: string;
      connection_id: string;
      amazon_profile_id: string;
    }[]>`
      select id, connection_id, amazon_profile_id
        from public.ad_profiles
       where org_id = ${seed?.seed_tenant_fixture ?? null}::uuid
    `;
    if (!seed || !profile) throw new Error('SP roundtrip tenant was not seeded');
    tenant = {
      orgId: seed.seed_tenant_fixture,
      profileId: profile.id,
      connectionId: profile.connection_id,
      amazonProfileId: profile.amazon_profile_id,
      userId,
    };
    await enableTestAuthority(database, tenant, 31_010);
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('round-trips every artifact byte column and every canonical preimage column', async () => {
    const artifactColumns = await database.sql<{ table_name: string; columns: string[] }[]>`
      select table_name,
             array_agg(column_name order by column_name)::text[] as columns
        from information_schema.columns
       where table_schema = 'public'
         and table_name like 'sp_write_%'
         and column_name in (
           'artifact_text', 'fingerprint_preimage', 'gate_snapshot_preimage',
           'request_fingerprint_preimage', 'intent_fingerprint_preimage'
         )
       group by table_name
       order by table_name
    `;
    expect(artifactColumns).toEqual([
      { table_name: 'sp_write_approval_requests', columns: ['artifact_text'] },
      {
        table_name: 'sp_write_authorization_receipts',
        columns: ['artifact_text', 'gate_snapshot_preimage'],
      },
      {
        table_name: 'sp_write_bounded_authorizations',
        columns: ['artifact_text', 'fingerprint_preimage'],
      },
      {
        table_name: 'sp_write_observations',
        columns: ['artifact_text', 'fingerprint_preimage'],
      },
      {
        table_name: 'sp_write_plan_actions',
        columns: ['artifact_text', 'fingerprint_preimage'],
      },
      {
        table_name: 'sp_write_plans',
        columns: ['artifact_text', 'fingerprint_preimage'],
      },
      {
        table_name: 'sp_write_predispatch_dispositions',
        columns: ['artifact_text', 'fingerprint_preimage'],
      },
      {
        table_name: 'sp_write_predispatch_observations',
        columns: ['artifact_text', 'fingerprint_preimage'],
      },
      {
        table_name: 'sp_write_provider_call_intents',
        columns: [
          'artifact_text', 'intent_fingerprint_preimage', 'request_fingerprint_preimage',
        ],
      },
      {
        table_name: 'sp_write_provider_results',
        columns: ['artifact_text', 'fingerprint_preimage'],
      },
    ]);

    const boundedProof = keywordPlan(
      tenant.orgId,
      tenant.profileId,
      tenant.connectionId,
      tenant.amazonProfileId,
      uuid(31_100),
    );
    const authorization = boundedAuthorization(boundedProof.plan, uuid(31_101));
    const authorizationPreimage = serializeSpWriteBoundedAuthorizationFingerprint(authorization);
    await asServiceRole(database, async (sql) => sql`
      select app.record_sp_write_bounded_authorization(
        ${JSON.stringify(authorization)},
        ${authorizationPreimage},
        ${JSON.stringify([{ orgId: tenant.orgId, profileId: tenant.profileId }])}::jsonb
      )
    `);

    const won = await reserveWinningManualCycle(database, tenant, 31_200);
    const { result, wake } = await appendResultAndReadWake(database, won, ['accepted']);
    const observation = requestedObservation(
      won.proof,
      won.receipt,
      won.artifacts.intent,
      wake.source_sync_job_id,
      wake.observed_at,
      uuid(31_220),
    );
    await asServiceRole(database, async (sql) => sql`
      select app.append_sp_write_observation(
        ${JSON.stringify(observation)},
        ${serializeSpWriteObservationFingerprint(observation)}
      )
    `);

    const refused = await prepareManualExecution(database, tenant, 31_300);
    const [refusalTimes] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!refusalTimes) throw new Error('SP roundtrip refusal timestamps were not derived');
    const refusalArtifacts = reservationArtifacts(
      refused.proof,
      refused.receipt,
      refused.leaseId,
      refusalTimes.observed_at,
      refusalTimes.valid_until,
      31_310,
      'requested',
    );
    const [refusal] = await asServiceRole(database, async (sql) => sql<{
      decision: string;
      refusal_reason: string;
    }[]>`
      select decision, refusal_reason
        from app.reserve_sp_write_provider_call(
          ${refused.receipt.executionId}::uuid,
          ${refused.proof.plan.id}::uuid,
          ${refused.receipt.generation}::uuid,
          ${refused.leaseId}::uuid,
          ${JSON.stringify(refusalArtifacts.observation)},
          ${serializeSpWritePredispatchObservationFingerprint(refusalArtifacts.observation)},
          ${JSON.stringify(refusalArtifacts.intent)},
          ${refusalArtifacts.requestPreimage},
          ${refusalArtifacts.intentPreimage}
        )
    `);
    expect(refusal).toEqual({ decision: 'refused', refusal_reason: 'stale_expected_state' });

    const request = ApproveSpWritePlan.parse({
      approvalRequestId: uuid(31_201),
      plan: spWritePlanBinding(won.proof.plan),
      approvalMode: 'manual',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
      boundedAuthorization: null,
      preapprovedInversePlan: null,
    });
    const [stored] = await database.sql<{
      authorization_text: string;
      authorization_preimage: string;
      plan_text: string;
      plan_preimage: string;
      action_text: string;
      action_preimage: string;
      request_text: string;
      receipt_text: string;
      receipt_gate_preimage: string;
      expected_gate_preimage: string;
      receipt_gate_fingerprint: string;
      predispatch_text: string;
      predispatch_preimage: string;
      intent_text: string;
      request_preimage: string;
      intent_preimage: string;
      result_text: string;
      result_preimage: string;
      observation_text: string;
      observation_preimage: string;
      disposition_text: string;
      disposition_preimage: string;
    }[]>`
      select
        bounded.artifact_text as authorization_text,
        bounded.fingerprint_preimage as authorization_preimage,
        plan.artifact_text as plan_text,
        plan.fingerprint_preimage as plan_preimage,
        action.artifact_text as action_text,
        action.fingerprint_preimage as action_preimage,
        request.artifact_text as request_text,
        receipt.artifact_text as receipt_text,
        receipt.gate_snapshot_preimage as receipt_gate_preimage,
        app.sp_write_gate_snapshot_preimage(
          receipt.environment_gate_version,
          receipt.profile_grant_id,
          receipt.profile_grant_version,
          receipt.approved_at
        ) as expected_gate_preimage,
        receipt.gate_snapshot_fingerprint as receipt_gate_fingerprint,
        predispatch.artifact_text as predispatch_text,
        predispatch.fingerprint_preimage as predispatch_preimage,
        intent.artifact_text as intent_text,
        intent.request_fingerprint_preimage as request_preimage,
        intent.intent_fingerprint_preimage as intent_preimage,
        result.artifact_text as result_text,
        result.fingerprint_preimage as result_preimage,
        observed.artifact_text as observation_text,
        observed.fingerprint_preimage as observation_preimage,
        disposition.artifact_text as disposition_text,
        disposition.fingerprint_preimage as disposition_preimage
      from public.sp_write_bounded_authorizations bounded
      cross join public.sp_write_plans plan
      join public.sp_write_plan_actions action on action.plan_id = plan.plan_id
      join public.sp_write_approval_requests request on request.plan_id = plan.plan_id
      join public.sp_write_authorization_receipts receipt on receipt.plan_id = plan.plan_id
      join public.sp_write_predispatch_observations predispatch
        on predispatch.plan_id = plan.plan_id
      join public.sp_write_provider_call_intents intent on intent.plan_id = plan.plan_id
      join public.sp_write_provider_results result on result.intent_id = intent.intent_id
      join public.sp_write_observations observed on observed.intent_id = intent.intent_id
      cross join public.sp_write_predispatch_dispositions disposition
      where bounded.authorization_id = ${authorization.authorizationId}::uuid
        and plan.plan_id = ${won.proof.plan.id}::uuid
        and disposition.plan_id = ${refused.proof.plan.id}::uuid
    `;
    if (!stored) throw new Error('SP byte roundtrip rows are incomplete');
    const disposition = SpWritePreDispatchDisposition.parse(JSON.parse(stored.disposition_text));
    expect(SpWriteAuthorizationReceipt.parse(JSON.parse(stored.receipt_text)))
      .toEqual(won.receipt);
    const { receipt_text: _receiptText, ...storedWithoutReceiptText } = stored;
    expect(storedWithoutReceiptText).toEqual({
      authorization_text: JSON.stringify(authorization),
      authorization_preimage: authorizationPreimage,
      plan_text: JSON.stringify(won.proof.plan),
      plan_preimage: won.proof.planPreimage,
      action_text: JSON.stringify(won.proof.action),
      action_preimage: won.proof.actionPreimage,
      request_text: JSON.stringify(request),
      receipt_gate_preimage: stored.expected_gate_preimage,
      expected_gate_preimage: stored.expected_gate_preimage,
      receipt_gate_fingerprint: sha256(stored.expected_gate_preimage),
      predispatch_text: JSON.stringify(won.artifacts.observation),
      predispatch_preimage: serializeSpWritePredispatchObservationFingerprint(
        won.artifacts.observation,
      ),
      intent_text: JSON.stringify(won.artifacts.intent),
      request_preimage: won.artifacts.requestPreimage,
      intent_preimage: won.artifacts.intentPreimage,
      result_text: JSON.stringify(result),
      result_preimage: serializeSpWriteProviderResultFingerprint(result),
      observation_text: JSON.stringify(observation),
      observation_preimage: serializeSpWriteObservationFingerprint(observation),
      disposition_text: JSON.stringify(disposition),
      disposition_preimage: serializeSpWritePreDispatchDispositionFingerprint(disposition),
    });
  });
});

describe('SP write runtime blast radius', () => {
  it('does not register the future dispatch or observation jobs in JobPayload', () => {
    const common = {
      orgId: '00000000-0000-4000-8000-000000000001',
      profileId: '00000000-0000-4000-8000-000000000002',
      planId: '00000000-0000-4000-8000-000000000003',
      planFingerprint: 'a'.repeat(64),
      executionId: '00000000-0000-4000-8000-000000000004',
      approvalId: '00000000-0000-4000-8000-000000000005',
      generation: '00000000-0000-4000-8000-000000000006',
    };

    expect(JobPayload.safeParse({ ...common, type: 'sp_write.dispatch' }).success).toBe(false);
    expect(JobPayload.safeParse({
      ...common,
      type: 'sp_write.observe',
      providerCallId: '00000000-0000-4000-8000-000000000007',
      attempt: 0,
    }).success).toBe(false);
  });

  it('adds no runtime, queue, deployment, hosted, Time Machine, or ApplyRow activation path', async () => {
    const runtimeRoots = ['apps/worker', 'apps/web', 'apps/mcp', 'apps/analyst'];
    const forbidden = [
      '@wizard-ads/shared/sp-writes',
      '@wizard-ads/ads-api/sp-write-adapter',
      'createSpWriteAdapter',
      'sp_write.dispatch',
      'sp_write.observe',
      'reserve_sp_write_provider_call',
      'append_sp_write_provider_result',
      'append_sp_write_observation',
    ];
    const hits: string[] = [];

    const scannedRuntimeFiles: string[] = [];
    for (const root of runtimeRoots) {
      const files = await sourceFiles(`${REPO_ROOT}${root}`);
      expect(files.length, `${root} runtime scan must be non-vacuous`).toBeGreaterThan(0);
      scannedRuntimeFiles.push(...files);
      for (const path of files) {
        const source = await readFile(path, 'utf8');
        for (const token of forbidden) {
          if (source.includes(token)) hits.push(`${path.slice(REPO_ROOT.length)}: ${token}`);
        }
      }
    }

    const activationRoots = ['.github', 'docs/deploy'];
    const activationTokens = [
      'sp_write.dispatch',
      'sp_write.observe',
      'reserve_sp_write_provider_call',
      'append_sp_write_provider_result',
      'append_sp_write_observation',
      'createSpWriteAdapter',
      'sp_write_',
      'SP_WRITE',
      'sp-write-adapter',
    ];
    const scannedActivationFiles: string[] = [];
    for (const root of activationRoots) {
      const files = await sourceFiles(`${REPO_ROOT}${root}`);
      expect(files.length, `${root} activation scan must be non-vacuous`).toBeGreaterThan(0);
      scannedActivationFiles.push(...files);
      for (const path of files) {
        const source = await readFile(path, 'utf8');
        for (const token of activationTokens) {
          if (source.includes(token)) hits.push(`${path.slice(REPO_ROOT.length)}: ${token}`);
        }
      }
    }

    const scanActivationFiles = async (files: readonly string[], label: string) => {
      expect(files.length, `${label} scan must be non-vacuous`).toBeGreaterThan(0);
      for (const path of files) {
        const source = await readFile(path, 'utf8');
        expect(source.length, `${path.slice(REPO_ROOT.length)} must not be empty`).toBeGreaterThan(0);
        for (const token of activationTokens) {
          if (source.includes(token)) hits.push(`${path.slice(REPO_ROOT.length)}: ${token}`);
        }
      }
    };

    const supabaseConfig = `${REPO_ROOT}supabase/config.toml`;
    await scanActivationFiles([supabaseConfig], 'supabase/config.toml');

    const functionEntries = await readdir(
      `${REPO_ROOT}supabase/functions`,
      { withFileTypes: true },
    );
    const functionFiles = await sourceFiles(`${REPO_ROOT}supabase/functions`);
    expect(
      functionEntries.length,
      'supabase/functions must exist with a sentinel or deployable functions',
    ).toBeGreaterThan(0);
    if (functionFiles.length > 0) {
      await scanActivationFiles(functionFiles, 'supabase/functions');
    } else {
      expect(functionEntries.map((entry) => entry.name)).toContain('.gitkeep');
    }

    const seedDirectoryFiles = await sourceFiles(`${REPO_ROOT}supabase/seed`);
    await scanActivationFiles(seedDirectoryFiles, 'supabase/seed');

    const rootEntries = await readdir(REPO_ROOT, { withFileTypes: true });
    const rootConfigNames = rootEntries
      .filter((entry) => entry.isFile() && /^(?:package\.json|turbo\.json|pnpm-workspace\.yaml|eslint\.config\.[cm]?js|tsconfig[^/]*\.json)$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    expect(rootConfigNames).toContain('package.json');
    expect(rootConfigNames).toContain('turbo.json');
    await scanActivationFiles(
      rootConfigNames.map((name) => `${REPO_ROOT}${name}`),
      'root package/build config',
    );

    const repositoryTextFiles = await sourceFiles(REPO_ROOT);
    const appPackageManifests = repositoryTextFiles.filter((path) =>
      /^\/?apps\/[^/]+\/package\.json$/.test(path.slice(REPO_ROOT.length)));
    const relativeAppPackageManifests = appPackageManifests
      .map((path) => path.slice(REPO_ROOT.length).replace(/^\/+/, ''));
    expect(relativeAppPackageManifests).toEqual(expect.arrayContaining([
      'apps/analyst/package.json',
      'apps/mcp/package.json',
      'apps/web/package.json',
      'apps/worker/package.json',
    ]));
    await scanActivationFiles(appPackageManifests, 'app package manifests');

    const deploymentCandidates = repositoryTextFiles.filter((path) => {
      const relative = path.slice(REPO_ROOT.length);
      const name = relative.split('/').at(-1) ?? '';
      return relative.startsWith('docs/deploy/')
        || /^Dockerfile(?:\.|$)/.test(name)
        || /(?:^|[-_.])compose(?:[-_.]|$)/i.test(name)
        || /(?:^|\/)deploy(?:ment)?(?:\/|[-_.])/i.test(relative)
        || /(?:^|\/)(?:vercel(?:\.[^/]+)?\.json|fly(?:\.[^/]+)?\.toml)$/i.test(relative)
        || /\.(?:service|sh)$/.test(name);
    });
    const relativeDeploymentCandidates = deploymentCandidates
      .map((path) => path.slice(REPO_ROOT.length).replace(/^\/+/, ''));
    expect(relativeDeploymentCandidates).toEqual(expect.arrayContaining([
      'apps/web/vercel.json',
      'apps/worker/fly.toml',
    ]));
    const nestedProviderConfigs = relativeDeploymentCandidates.filter((path) =>
      /(?:^|\/)(?:vercel(?:\.[^/]+)?\.json|fly(?:\.[^/]+)?\.toml)$/i.test(path));
    expect(nestedProviderConfigs.length, 'nested Vercel/Fly scan must be non-vacuous')
      .toBeGreaterThanOrEqual(2);
    await scanActivationFiles(deploymentCandidates, 'Docker/compose/systemd/deploy candidates');

    const spWriteSourceMigrationSuffixes = [
      '/20260901020000_sp_write_persistence_ledger.sql',
      '/20260901030000_sp_write_outbox_delivery.sql',
      '/20260905000000_sp_write_preview_evidence.sql',
      '/20260905010000_sp_write_preview_approval.sql',
    ];
    const migrationFiles = await sourceFiles(`${REPO_ROOT}supabase/migrations`);
    const spWriteSourceMigrations = migrationFiles.filter((path) =>
      spWriteSourceMigrationSuffixes.some((suffix) => path.endsWith(suffix)));
    expect(spWriteSourceMigrations.map((path) => `/${path.split('/').at(-1)}`).sort())
      .toEqual([...spWriteSourceMigrationSuffixes].sort());
    const otherMigrations = migrationFiles.filter((path) =>
      !spWriteSourceMigrations.includes(path));
    expect(otherMigrations.length, 'other-migration activation scan must be non-vacuous')
      .toBeGreaterThan(0);
    for (const path of otherMigrations) {
      const source = await readFile(path, 'utf8');
      for (const token of ['sp_write_']) {
        if (source.includes(token)) hits.push(`${path.slice(REPO_ROOT.length)}: ${token}`);
      }
    }
    const supabaseEntries = await readdir(`${REPO_ROOT}supabase`);
    if (supabaseEntries.includes('seed.sql')) {
      const seedPath = `${REPO_ROOT}supabase/seed.sql`;
      await scanActivationFiles([seedPath], 'supabase/seed.sql');
    }

    const fixturePath = `${REPO_ROOT}supabase/tests/tenant-fixture.sql`;
    const fixtureSource = await readFile(fixturePath, 'utf8');
    expect(fixtureSource).toContain('sp_write_');
    for (const token of [
      'sp_write_environment_gate_head',
      'reserve_sp_write_provider_call',
      'append_sp_write_provider_result',
      'append_sp_write_observation',
    ]) {
      if (fixtureSource.includes(token)) hits.push(`supabase/tests/tenant-fixture.sql: ${token}`);
    }
    for (const path of [...scannedRuntimeFiles, ...scannedActivationFiles]) {
      if (/\/(?:e2e|tests?)\//.test(path)
        || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
        || path.endsWith('/global-setup.ts')) continue;
      const source = await readFile(path, 'utf8');
      if (source.includes('tenant-fixture.sql')) {
        hits.push(`${path.slice(REPO_ROOT.length)}: test fixture referenced by runtime/deploy`);
      }
    }

    const adsApiPackage = JSON.parse(
      await readFile(`${REPO_ROOT}packages/ads-api/package.json`, 'utf8'),
    ) as { exports?: Record<string, string> };
    expect(adsApiPackage.exports?.['./sp-write-adapter'])
      .toBe('./src/sp-write-adapter.ts');
    const adapterSource = await readFile(
      `${REPO_ROOT}packages/ads-api/src/sp-write-adapter.ts`,
      'utf8',
    );
    expect(adapterSource).toContain('export function createSpWriteAdapter');
    const adsApiRoot = await readFile(`${REPO_ROOT}packages/ads-api/src/index.ts`, 'utf8');
    expect(adsApiRoot).not.toContain('sp-write-adapter');
    expect(adsApiRoot).not.toContain('createSpWriteAdapter');

    const webFiles = await sourceFiles(`${REPO_ROOT}apps/web`);
    for (const path of webFiles) {
      const source = await readFile(path, 'utf8');
      const namesTimeMachine = /time.?machine/i.test(source);
      const namesSpWrite = /sp_write\.|sp-write-adapter|reserve_sp_write_provider_call/.test(source);
      if (namesTimeMachine && namesSpWrite) {
        hits.push(`${path.slice(REPO_ROOT.length)}: Time Machine/SP write coupling`);
      }
    }

    const sharedContract = await readFile(`${REPO_ROOT}packages/shared/src/sp-writes.ts`, 'utf8');
    expect(sharedContract).not.toMatch(/from ['"].*apply(?:\.js)?['"]/);
    expect(sharedContract).not.toMatch(/\bApplyRow(?:Wire)?\b/);

    expect(hits).toEqual([]);
  });
});
