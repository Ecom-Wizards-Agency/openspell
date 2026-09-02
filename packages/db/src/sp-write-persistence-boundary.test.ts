import { createHash } from 'node:crypto';
import {
  SpWriteAction,
  SpWriteBoundedAuthorization,
  SpWriteObservation,
  SpWritePlan,
  SpWritePredispatchObservation,
  SpWriteProviderCallIntent,
  SpWriteProviderResult,
  serializeSpWriteActionFingerprint,
  serializeSpWriteBoundedAuthorizationFingerprint,
  serializeSpWriteObservationFingerprint,
  serializeSpWritePlanFingerprint,
  serializeSpWritePredispatchObservationFingerprint,
  serializeSpWriteProviderCallIntentFingerprint,
  serializeSpWriteProviderRequestFingerprint,
  serializeSpWriteProviderResultFingerprint,
} from '@wizard-ads/shared/sp-writes';
import { describe, expect, it } from 'vitest';
import {
  SpWritePersistenceError,
  createSpWriteOutboxLedger,
  createSpWriteRuntimeLedger,
  createSpWriteStagingLedger,
} from './sp-write-persistence.js';
import type {
  SpWriteDispatchOutboxClaim,
  SpWriteReservationOutcome,
} from './sp-write-persistence.js';

interface SqlCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

type SqlReply = readonly unknown[] | Error | Record<string, unknown>;

function scriptedHandle(...replies: SqlReply[]) {
  const calls: SqlCall[] = [];
  const pending = [...replies];
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    const reply = pending.shift();
    if (reply instanceof Error) throw reply;
    if (reply === undefined) throw new Error('unexpected SQL call in facade test');
    return reply;
  };
  const sql = Object.assign(tag, {
    array: (values: readonly unknown[]) => values,
    begin: async () => {
      throw new Error('scripted facade SQL did not expect a transaction');
    },
  });
  return {
    calls,
    handle: { sql } as never,
    remaining: () => pending.length,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

function keywordPlan(seed = 1) {
  const actionBase = SpWriteAction.parse({
    actionId: uuid(seed + 1),
    routeKey: 'sp.v3.keywords.update',
    entity: { keywordId: `synthetic-keyword-${seed}` },
    changes: {
      bid: {
        expected: { amount: '0.9', currencyCode: 'USD' },
        requested: { amount: '0.95', currencyCode: 'USD' },
      },
    },
    sources: [{
      kind: 'apply_row',
      applyRowId: uuid(seed + 2),
      changeKey: 'keyword.bid',
    }],
    fingerprint: '0'.repeat(64),
  });
  const action = SpWriteAction.parse({
    ...actionBase,
    fingerprint: sha256(serializeSpWriteActionFingerprint(actionBase)),
  });
  const planBase = SpWritePlan.parse({
    schemaVersion: 'openspell.sp-write-plan.v1',
    id: uuid(seed),
    orgId: uuid(seed + 3),
    profileId: uuid(seed + 4),
    providerScope: {
      amazonProfileId: `synthetic-profile-${seed}`,
      connectionId: uuid(seed + 5),
      region: 'NA',
      marketplaceId: 'synthetic-marketplace',
      currencyCode: 'USD',
      apiDialect: 'sp_v3',
    },
    direction: 'forward',
    source: {
      kind: 'apply_batch',
      applyBatchId: uuid(seed + 6),
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
  return { action, plan };
}

function boundedAuthorization(
  plans: readonly ReturnType<typeof keywordPlan>[],
  authorizationId = uuid(501),
) {
  const base = SpWriteBoundedAuthorization.parse({
    schemaVersion: 'openspell.sp-write-bounded-authorization.v1',
    authorizationId,
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2030-01-01T01:00:00.000Z',
    profiles: plans.map(({ plan, action }) => {
      if (action.routeKey !== 'sp.v3.keywords.update' || !('keywordId' in action.entity)) {
        throw new Error('bounded facade fixture requires a keyword action');
      }
      return {
        providerScope: plan.providerScope,
        allowedEntities: [{
          routeKey: action.routeKey,
          amazonEntityId: action.entity.keywordId,
          allowedChangeKeys: ['keyword.bid'],
          maxAbsoluteMoneyDelta: '0.1',
          maxAbsolutePlacementDelta: null,
        }],
      };
    }),
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

function providerResult(seed = 801) {
  const base = SpWriteProviderResult.parse({
    schemaVersion: 'openspell.sp-write-provider-result.v1',
    resultId: uuid(seed),
    intentId: uuid(seed + 1),
    intentFingerprint: 'c'.repeat(64),
    providerCallId: uuid(seed + 2),
    requestFingerprint: 'd'.repeat(64),
    completedAt: '2026-01-01T00:03:00.000Z',
    positions: [{
      requestIndex: 0,
      actionId: uuid(seed + 3),
      actionFingerprint: 'e'.repeat(64),
      actionRequestFingerprint: 'f'.repeat(64),
      outcome: 'ambiguous',
      providerEntityId: null,
      code: 'SYNTHETIC',
      message: 'Synthetic bounded diagnostic.',
    }],
    fingerprint: '0'.repeat(64),
  });
  return SpWriteProviderResult.parse({
    ...base,
    fingerprint: sha256(serializeSpWriteProviderResultFingerprint(base)),
  });
}

function finalObservation(seed = 901) {
  const proof = keywordPlan(seed);
  const artifacts = reservationArtifacts(proof);
  const action = proof.action;
  const base = SpWriteObservation.parse({
    schemaVersion: 'openspell.sp-write-observation.v1',
    observationId: uuid(seed + 20),
    planId: proof.plan.id,
    planFingerprint: proof.plan.fingerprint,
    approvalId: artifacts.intent.approvalId,
    executionId: artifacts.intent.executionId,
    generation: artifacts.intent.generation,
    intentId: artifacts.intent.intentId,
    intentFingerprint: artifacts.intent.fingerprint,
    providerCallId: artifacts.intent.providerCallId,
    requestFingerprint: artifacts.intent.requestFingerprint,
    actionId: action.actionId,
    actionFingerprint: action.fingerprint,
    routeKey: action.routeKey,
    sourceSyncJobId: uuid(seed + 21),
    observedAt: '2026-01-01T00:04:00.000Z',
    outcome: 'missing',
    observed: null,
    fingerprint: '0'.repeat(64),
  });
  return SpWriteObservation.parse({
    ...base,
    fingerprint: sha256(serializeSpWriteObservationFingerprint(base)),
  });
}

function reservationArtifacts(proof = keywordPlan(601)) {
  const { action, plan } = proof;
  if (action.routeKey !== 'sp.v3.keywords.update'
    || !('keywordId' in action.entity)
    || action.changes.bid === undefined) {
    throw new Error('reservation facade fixture requires a keyword-bid action');
  }
  const approvalId = uuid(610);
  const executionId = uuid(611);
  const generation = uuid(612);
  const dispatchLeaseId = uuid(613);
  const observationBase = SpWritePredispatchObservation.parse({
    schemaVersion: 'openspell.sp-write-predispatch-observation.v1',
    observationId: uuid(614),
    planId: plan.id,
    planFingerprint: plan.fingerprint,
    approvalId,
    executionId,
    generation,
    routeKey: action.routeKey,
    observedAt: '2026-01-01T00:02:00.000Z',
    validUntil: '2026-01-01T00:03:00.000Z',
    items: [{
      routeKey: action.routeKey,
      actionId: action.actionId,
      actionFingerprint: action.fingerprint,
      amazonEntityId: action.entity.keywordId,
      values: { bid: action.changes.bid.expected },
    }],
    fingerprint: '0'.repeat(64),
  });
  const observation = SpWritePredispatchObservation.parse({
    ...observationBase,
    fingerprint: sha256(serializeSpWritePredispatchObservationFingerprint(observationBase)),
  });
  const intentBase = SpWriteProviderCallIntent.parse({
    schemaVersion: 'openspell.sp-write-provider-call-intent.v1',
    intentId: uuid(615),
    providerCallId: uuid(616),
    planId: plan.id,
    planFingerprint: plan.fingerprint,
    approvalId,
    executionId,
    generation,
    routeKey: action.routeKey,
    attemptNumber: 1,
    dispatchLeaseId,
    providerObservationFingerprint: observation.fingerprint,
    requestFingerprint: '0'.repeat(64),
    recordedAt: '2026-01-01T00:02:00.000Z',
    positions: [{
      requestIndex: 0,
      actionId: action.actionId,
      actionFingerprint: action.fingerprint,
      amazonEntityId: action.entity.keywordId,
      actionRequestFingerprint: 'f'.repeat(64),
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
  return { observation, intent };
}

function dispatchClaimRow(
  artifacts = reservationArtifacts(),
  overrides: Record<string, unknown> = {},
) {
  return {
    offered_count: 1,
    claimed_count: 1,
    claim_ordinal: 1,
    outbox_id: uuid(617),
    org_id: uuid(618),
    profile_id: uuid(619),
    execution_id: artifacts.intent.executionId,
    plan_id: artifacts.intent.planId,
    approval_id: artifacts.intent.approvalId,
    generation: artifacts.intent.generation,
    kind: 'dispatch',
    provider_call_id: null,
    intent_id: null,
    source_sync_job_id: null,
    claim_epoch: '1',
    claimed_at: new Date('2026-01-01T00:01:00.000Z'),
    lease_expires_at: new Date('2026-01-01T00:03:00.000Z'),
    claim_token: uuid(620),
    ...overrides,
  };
}

async function dispatchClaimFor(
  artifacts = reservationArtifacts(),
): Promise<SpWriteDispatchOutboxClaim> {
  const mock = scriptedHandle([dispatchClaimRow(artifacts)]);
  const batch = await createSpWriteOutboxLedger(mock.handle).claimAvailable({
    claimantId: 'boundary-worker',
    kinds: ['dispatch'],
    limit: 1,
  });
  const claim = batch.claims[0];
  if (claim?.kind !== 'dispatch') throw new Error('dispatch claim fixture failed');
  return claim;
}

function reservationRow(overrides: Record<string, unknown> = {}) {
  return {
    decision: 'busy',
    refusal_reason: null,
    checked_at: new Date('2026-01-01T00:02:00.000Z'),
    result_id: null,
    intent_text: null,
    ...overrides,
  };
}

function winningReadback(
  intent: ReturnType<typeof SpWriteProviderCallIntent.parse>,
  resultId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    intent_id: intent.intentId,
    provider_call_id: intent.providerCallId,
    reserved_result_id: resultId,
    execution_id: intent.executionId,
    plan_id: intent.planId,
    approval_id: intent.approvalId,
    generation: intent.generation,
    route_key: intent.routeKey,
    dispatch_lease_id: intent.dispatchLeaseId,
    artifact_text: JSON.stringify(intent),
    position_count: intent.positions.length,
    checked_at: new Date('2026-01-01T00:02:00.000Z'),
    dispatch_start_deadline: new Date('2026-01-01T00:02:05.000Z'),
    provider_attempt_deadline: new Date('2026-01-01T00:02:35.000Z'),
    database_read_at: new Date('2026-01-01T00:02:01.000Z'),
    dispatch_window_elapsed: false,
    ...overrides,
  };
}

describe('SP write persistence facade pure boundary', () => {
  it('makes ticket authority impossible on non-winning TypeScript variants', () => {
    type NonWinner = Exclude<SpWriteReservationOutcome, { kind: 'dispatch_once' }>;
    type MemberHasTicket<T> = T extends unknown
      ? ('ticket' extends keyof T ? true : false)
      : never;
    type EveryMemberOmitsTicket = [MemberHasTicket<NonWinner>] extends [false]
      ? true
      : false;
    const everyMemberOmitsTicket: EveryMemberOmitsTicket = true;
    expect(everyMemberOmitsTicket).toBe(true);
  });

  it('refuses a transaction-shaped SQL tag at the factory boundary', () => {
    const transactionTag = async () => [];
    const transactionHandle = { sql: transactionTag } as never;
    expect(() => createSpWriteStagingLedger(transactionHandle))
      .toThrow(SpWritePersistenceError);
    expect(() => createSpWriteRuntimeLedger(transactionHandle))
      .toThrow(SpWritePersistenceError);
    expect(() => createSpWriteOutboxLedger(transactionHandle))
      .toThrow(SpWritePersistenceError);
  });

  it('rejects malformed artifacts before issuing SQL', async () => {
    const stagingMock = scriptedHandle([]);
    const staging = createSpWriteStagingLedger(stagingMock.handle);
    await expect(staging.recordPlan({ schemaVersion: 'not-a-plan' }))
      .rejects.toBeInstanceOf(SpWritePersistenceError);
    const tamperedPlan = keywordPlan(7).plan;
    await expect(staging.recordPlan({ ...tamperedPlan, fingerprint: '0'.repeat(64) }))
      .rejects.toBeInstanceOf(SpWritePersistenceError);
    expect(stagingMock.calls).toEqual([]);

    const runtimeMock = scriptedHandle([]);
    const runtime = createSpWriteRuntimeLedger(runtimeMock.handle);
    await expect(runtime.appendProviderResult({ fingerprint: 'not-a-result' }))
      .rejects.toBeInstanceOf(SpWritePersistenceError);
    const tamperedResult = providerResult(850);
    await expect(runtime.appendProviderResult({
      ...tamperedResult,
      fingerprint: '0'.repeat(64),
    })).rejects.toBeInstanceOf(SpWritePersistenceError);
    await expect(runtime.appendRecoveryResult({ fingerprint: 'not-a-result' }))
      .rejects.toBeInstanceOf(SpWritePersistenceError);
    await expect(runtime.appendObservation({ fingerprint: 'not-an-observation' }))
      .rejects.toBeInstanceOf(SpWritePersistenceError);
    expect(runtimeMock.calls).toEqual([]);
  });

  it('validates claim inputs before SQL and closes the exact zero batch', async () => {
    for (const input of [
      null,
      {},
      { claimantId: '', kinds: ['dispatch'], limit: 1 },
      { claimantId: ' worker', kinds: ['dispatch'], limit: 1 },
      { claimantId: 'worker', kinds: [], limit: 1 },
      { claimantId: 'worker', kinds: ['dispatch', 'dispatch'], limit: 1 },
      { claimantId: 'worker', kinds: ['unexpected'], limit: 1 },
      { claimantId: 'worker', kinds: ['dispatch'], limit: 0 },
      { claimantId: 'worker', kinds: ['dispatch'], limit: 1, leaseSeconds: 69 },
      { claimantId: 'worker', kinds: ['dispatch'], limit: 1, extra: true },
    ]) {
      const mock = scriptedHandle([]);
      await expect(createSpWriteOutboxLedger(mock.handle).claimAvailable(input))
        .rejects.toMatchObject({ operation: 'claim_outbox', category: 'invalid_artifact' });
      expect(mock.calls).toEqual([]);
    }

    const zero = dispatchClaimRow(reservationArtifacts(), {
      offered_count: 0,
      claimed_count: 0,
      claim_ordinal: null,
      outbox_id: null,
      org_id: null,
      profile_id: null,
      execution_id: null,
      plan_id: null,
      approval_id: null,
      generation: null,
      kind: null,
      provider_call_id: null,
      intent_id: null,
      source_sync_job_id: null,
      claim_epoch: null,
      claimed_at: null,
      lease_expires_at: null,
      claim_token: null,
    });
    const mock = scriptedHandle([zero]);
    await expect(createSpWriteOutboxLedger(mock.handle).claimAvailable({
      claimantId: 'worker-1',
      kinds: ['dispatch', 'observe_and_recover'],
      limit: 10,
      leaseSeconds: 300,
    })).resolves.toEqual({ offeredCount: 0, claimedCount: 0, claims: [] });
    expect(mock.calls[0]?.values).toEqual([
      'worker-1',
      ['dispatch', 'observe_and_recover'],
      10,
      300,
    ]);
  });

  it('keeps raw claim tokens opaque and rejects clones before SQL', async () => {
    const artifacts = reservationArtifacts();
    const token = uuid(620);
    const mock = scriptedHandle([dispatchClaimRow(artifacts)]);
    const batch = await createSpWriteOutboxLedger(mock.handle).claimAvailable({
      claimantId: 'worker-1',
      kinds: ['dispatch'],
      limit: 1,
    });
    expect(batch).toMatchObject({ offeredCount: 1, claimedCount: 1 });
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.claims)).toBe(true);
    const claim = batch.claims[0];
    expect(claim?.kind).toBe('dispatch');
    if (claim?.kind !== 'dispatch') throw new Error('expected dispatch claim');
    expect(Object.isFrozen(claim)).toBe(true);
    expect(Object.values(claim)).not.toContain(token);
    expect(Object.keys(claim)).not.toContain('claimToken');
    expect(() => JSON.stringify(claim)).toThrow(SpWritePersistenceError);

    const cloneMock = scriptedHandle([]);
    const clone = { ...claim } as SpWriteDispatchOutboxClaim;
    await expect(createSpWriteOutboxLedger(cloneMock.handle).renewClaim(clone, 120))
      .rejects.toMatchObject({
        operation: 'renew_outbox_claim',
        category: 'invalid_artifact',
      });
    expect(cloneMock.calls).toEqual([]);
  });

  it('discriminates exact observe-and-recover identity without exposing its token', async () => {
    const artifacts = reservationArtifacts();
    const row = dispatchClaimRow(artifacts, {
      kind: 'observe_and_recover',
      provider_call_id: artifacts.intent.providerCallId,
      intent_id: artifacts.intent.intentId,
      source_sync_job_id: uuid(622),
    });
    const mock = scriptedHandle([row]);
    const batch = await createSpWriteOutboxLedger(mock.handle).claimAvailable({
      claimantId: 'observer-1',
      kinds: ['observe_and_recover'],
      limit: 1,
    });
    const claim = batch.claims[0];
    expect(claim).toMatchObject({
      kind: 'observe_and_recover',
      providerCallId: artifacts.intent.providerCallId,
      intentId: artifacts.intent.intentId,
      sourceSyncJobId: uuid(622),
    });
    expect(Object.values(claim ?? {})).not.toContain(uuid(620));
    expect(Object.keys(claim ?? {})).not.toContain('claimToken');
    expect(() => JSON.stringify(claim)).toThrow(SpWritePersistenceError);
  });

  it('fails closed on malformed claim counts, ordinals, identities, and kind nullability', async () => {
    const artifacts = reservationArtifacts();
    const missingKey = dispatchClaimRow(artifacts) as Record<string, unknown>;
    delete missingKey.claim_token;
    const overLimit = [
      dispatchClaimRow(artifacts, {
        offered_count: 2,
        claimed_count: 2,
      }),
      dispatchClaimRow(artifacts, {
        offered_count: 2,
        claimed_count: 2,
        claim_ordinal: 2,
        outbox_id: uuid(621),
        claim_token: uuid(622),
      }),
    ];
    const replies: SqlReply[] = [
      [],
      [dispatchClaimRow(artifacts), dispatchClaimRow(artifacts)],
      overLimit,
      [dispatchClaimRow(artifacts, { claim_ordinal: 0 })],
      [dispatchClaimRow(artifacts, { offered_count: 2 })],
      [dispatchClaimRow(artifacts, { outbox_id: 'not-a-uuid' })],
      [dispatchClaimRow(artifacts, { claim_epoch: '01' })],
      [dispatchClaimRow(artifacts, { provider_call_id: uuid(621) })],
      [missingKey],
    ];
    for (const reply of replies) {
      const mock = scriptedHandle(reply);
      await expect(createSpWriteOutboxLedger(mock.handle).claimAvailable({
        claimantId: 'worker-1',
        kinds: ['dispatch'],
        limit: 1,
      })).rejects.toMatchObject({
        operation: 'claim_outbox',
        category: 'protocol_violation',
        recovery: 'reconcile_only',
      });
      expect(mock.calls).toHaveLength(1);
    }
  });

  it('decodes fixed claim transition outcomes without exposing custody', async () => {
    const artifacts = reservationArtifacts();
    const claim = await dispatchClaimFor(artifacts);
    const mock = scriptedHandle(
      [{
        decision: 'renewed',
        checked_at: '2026-01-01T00:02:00.000Z',
        expires_at: '2026-01-01T00:04:00.000Z',
      }],
      [{
        decision: 'renewal_limit_reached',
        checked_at: '2026-01-01T00:02:00.000Z',
        expires_at: '2026-01-01T00:06:00.000Z',
      }],
      [{
        decision: 'stale_claim',
        checked_at: '2026-01-01T00:02:00.000Z',
        expires_at: null,
      }],
      [{
        decision: 'deferred',
        reason: 'reservation_busy',
        checked_at: '2026-01-01T00:04:00.000Z',
        available_at: '2026-01-01T00:04:15.000Z',
      }],
      [{
        decision: 'already_deferred',
        reason: 'reservation_busy',
        checked_at: '2026-01-01T00:05:00.000Z',
        available_at: '2026-01-01T00:04:15.000Z',
      }],
      [{
        decision: 'stale_claim',
        reason: null,
        checked_at: '2026-01-01T00:04:00.000Z',
        available_at: null,
      }],
      [{
        decision: 'not_complete',
        checked_at: '2026-01-01T00:04:30.000Z',
        completed_at: null,
      }],
      [{
        decision: 'completed',
        checked_at: '2026-01-01T00:04:30.000Z',
        completed_at: '2026-01-01T00:04:30.000Z',
      }],
      [{
        decision: 'already_completed',
        checked_at: '2026-01-01T00:05:00.000Z',
        completed_at: '2026-01-01T00:04:30.000Z',
      }],
    );
    const outbox = createSpWriteOutboxLedger(mock.handle);
    await expect(outbox.renewClaim(claim, 120)).resolves.toEqual({
      kind: 'renewed',
      expiresAt: '2026-01-01T00:04:00.000Z',
    });
    await expect(outbox.renewClaim(claim, 120)).resolves.toEqual({
      kind: 'renewal_limit_reached',
      expiresAt: '2026-01-01T00:06:00.000Z',
    });
    await expect(outbox.renewClaim(claim, 120)).resolves.toEqual({ kind: 'stale_claim' });
    await expect(outbox.deferClaim(claim, 'reservation_busy')).resolves.toEqual({
      kind: 'deferred',
      reason: 'reservation_busy',
      availableAt: '2026-01-01T00:04:15.000Z',
    });
    await expect(outbox.deferClaim(claim, 'reservation_busy')).resolves.toEqual({
      kind: 'already_deferred',
      reason: 'reservation_busy',
      availableAt: '2026-01-01T00:04:15.000Z',
    });
    await expect(outbox.deferClaim(claim, 'reservation_busy'))
      .resolves.toEqual({ kind: 'stale_claim' });
    await expect(outbox.completeClaim(claim)).resolves.toEqual({ kind: 'not_complete' });
    await expect(outbox.completeClaim(claim)).resolves.toEqual({
      kind: 'completed',
      completedAt: '2026-01-01T00:04:30.000Z',
    });
    await expect(outbox.completeClaim(claim)).resolves.toEqual({
      kind: 'already_completed',
      completedAt: '2026-01-01T00:04:30.000Z',
    });
    expect(mock.calls).toHaveLength(9);
    expect(mock.calls[0]?.values).toEqual([claim.outboxId, '1', uuid(620), 120]);
  });

  it('derives exact plan/action bytes and preimages instead of accepting proofs', async () => {
    const proof = keywordPlan(11);
    const mock = scriptedHandle([{ record_sp_write_plan: proof.plan.id }]);
    const staging = createSpWriteStagingLedger(mock.handle);

    await expect(staging.recordPlan(proof.plan)).resolves.toBe(proof.plan.id);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.text).toContain('app.record_sp_write_plan');

    expect(mock.calls[0]?.values).toEqual([
      JSON.stringify(proof.plan),
      serializeSpWritePlanFingerprint(proof.plan),
      JSON.stringify([{
        artifactText: JSON.stringify(proof.action),
        fingerprintPreimage: serializeSpWriteActionFingerprint(proof.action),
      }]),
    ]);
    expect(mock.remaining()).toBe(0);
  });

  it('fails closed on malformed scalar and lease decoders', async () => {
    const proof = keywordPlan(41);
    for (const reply of [
      [],
      [
        { record_sp_write_plan: proof.plan.id },
        { record_sp_write_plan: proof.plan.id },
      ],
      [{ record_sp_write_plan: uuid(49) }],
    ]) {
      const mock = scriptedHandle(reply);
      const staging = createSpWriteStagingLedger(mock.handle);
      await expect(staging.recordPlan(proof.plan)).rejects.toMatchObject({
        operation: 'record_plan',
        category: 'protocol_violation',
        providerCallAllowed: false,
      });
    }

    const authorization = boundedAuthorization([proof], uuid(50));
    const binding = [{
      providerScope: proof.plan.providerScope,
      orgId: proof.plan.orgId,
      profileId: proof.plan.profileId,
    }];
    const boundedMock = scriptedHandle([{
      record_sp_write_bounded_authorization: uuid(51),
    }]);
    await expect(createSpWriteStagingLedger(boundedMock.handle).recordBoundedAuthorization({
      authorization,
      bindings: binding,
    })).rejects.toMatchObject({
      operation: 'record_bounded_authorization',
      category: 'protocol_violation',
    });

    for (const reply of [
      [],
      [
        { start_sp_write_execution: uuid(52) },
        { start_sp_write_execution: uuid(52) },
      ],
      [{ start_sp_write_execution: 'not-a-uuid' }],
    ]) {
      const mock = scriptedHandle(reply);
      const runtime = createSpWriteRuntimeLedger(mock.handle);
      await expect(runtime.startExecution({ approvalId: uuid(53), planId: uuid(54) }))
        .rejects.toMatchObject({
          operation: 'start_execution',
          category: 'protocol_violation',
        });
    }

    const leaseReplies: SqlReply[] = [
      [],
      [
        {
          lease_id: uuid(55),
          acquired_at: '2026-01-01T00:00:00.000Z',
          expires_at: '2026-01-01T00:02:00.000Z',
        },
        {
          lease_id: uuid(56),
          acquired_at: '2026-01-01T00:00:00.000Z',
          expires_at: '2026-01-01T00:02:00.000Z',
        },
      ],
      [{
        lease_id: uuid(55),
        acquired_at: 'not-a-timestamp',
        expires_at: '2026-01-01T00:02:00.000Z',
      }],
      [{
        lease_id: uuid(55),
        acquired_at: '2026-01-01T00:02:00.000Z',
        expires_at: '2026-01-01T00:00:00.000Z',
      }],
    ];
    const leaseClaim = await dispatchClaimFor();
    for (const reply of leaseReplies) {
      const mock = scriptedHandle(reply);
      const runtime = createSpWriteRuntimeLedger(mock.handle);
      await expect(runtime.acquireDispatchLease({
        claim: leaseClaim,
        routeKey: 'sp.v3.keywords.update',
      })).rejects.toMatchObject({
        operation: 'acquire_dispatch_lease',
        category: 'protocol_violation',
      });
    }

    const result = providerResult(60);
    for (const reply of [
      [],
      [{ outcome: 'recorded' }, { outcome: 'recorded' }],
      [{ outcome: 'unknown' }],
    ]) {
      const mock = scriptedHandle(reply);
      const runtime = createSpWriteRuntimeLedger(mock.handle);
      await expect(runtime.appendProviderResult(result)).rejects.toMatchObject({
        operation: 'append_provider_result',
        category: 'protocol_violation',
      });
    }

    const observation = finalObservation(70);
    for (const reply of [
      [],
      [
        { append_sp_write_observation: observation.observationId },
        { append_sp_write_observation: observation.observationId },
      ],
      [{ append_sp_write_observation: uuid(99) }],
    ]) {
      const mock = scriptedHandle(reply);
      const runtime = createSpWriteRuntimeLedger(mock.handle);
      await expect(runtime.appendObservation(observation)).rejects.toMatchObject({
        operation: 'append_observation',
        category: 'protocol_violation',
      });
    }

    const observationMock = scriptedHandle([{
      append_sp_write_observation: observation.observationId,
    }]);
    await expect(createSpWriteRuntimeLedger(observationMock.handle)
      .appendObservation(observation)).resolves.toBe(observation.observationId);
    expect(observationMock.calls[0]?.values).toEqual([
      JSON.stringify(observation),
      serializeSpWriteObservationFingerprint(observation),
    ]);
  });

  it('requires one-to-one bounded provider-scope bindings before SQL', async () => {
    const first = keywordPlan(101);
    const second = keywordPlan(201);
    const foreign = keywordPlan(251);
    const authorization = boundedAuthorization([first, second]);
    const exactBindings = [first, second].map(({ plan }) => ({
      providerScope: plan.providerScope,
      orgId: plan.orgId,
      profileId: plan.profileId,
    }));

    for (const bindings of [
      exactBindings.slice(0, 1),
      [...exactBindings, exactBindings[0]!],
      [exactBindings[0]!, exactBindings[0]!],
      [{ ...exactBindings[0]!, providerScope: foreign.plan.providerScope }, exactBindings[1]!],
    ]) {
      const mock = scriptedHandle([]);
      const staging = createSpWriteStagingLedger(mock.handle);
      await expect(staging.recordBoundedAuthorization({ authorization, bindings }))
        .rejects.toBeInstanceOf(SpWritePersistenceError);
      expect(mock.calls).toEqual([]);
    }
  });

  it('aligns complete bounded bindings to artifact profile order and derives canonical proof', async () => {
    const first = keywordPlan(301);
    const second = keywordPlan(401);
    const authorization = boundedAuthorization([first, second]);
    const reversed = [second, first].map(({ plan }) => ({
      providerScope: plan.providerScope,
      orgId: plan.orgId,
      profileId: plan.profileId,
    }));
    const mock = scriptedHandle([{ record_sp_write_bounded_authorization: authorization.authorizationId }]);
    const staging = createSpWriteStagingLedger(mock.handle);

    await expect(staging.recordBoundedAuthorization({ authorization, bindings: reversed }))
      .resolves.toBe(authorization.authorizationId);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.text).toContain('app.record_sp_write_bounded_authorization');
    expect(mock.calls[0]?.values).toEqual([
      JSON.stringify(authorization),
      serializeSpWriteBoundedAuthorizationFingerprint(authorization),
      JSON.stringify([
        { orgId: first.plan.orgId, profileId: first.plan.profileId },
        { orgId: second.plan.orgId, profileId: second.plan.profileId },
      ]),
    ]);
  });

  it('decodes every no-authority reservation outcome without exposing a ticket', async () => {
    const artifacts = reservationArtifacts();
    const claim = await dispatchClaimFor(artifacts);
    const cases = [
      {
        row: reservationRow({ decision: 'claim_unavailable' }),
        expected: { kind: 'closed_without_dispatch', reason: 'claim_unavailable' },
      },
      {
        row: reservationRow(),
        expected: { kind: 'defer_and_reobserve', reason: 'busy' },
      },
      {
        row: reservationRow({ decision: 'already_intended' }),
        expected: { kind: 'closed_without_dispatch', reason: 'already_intended' },
      },
      {
        row: reservationRow({
          decision: 'refused',
          refusal_reason: 'environment_gate_closed',
        }),
        expected: { kind: 'closed_without_dispatch', reason: 'environment_gate_closed' },
      },
    ] as const;

    for (const { row, expected } of cases) {
      const mock = scriptedHandle([row]);
      const runtime = createSpWriteRuntimeLedger(mock.handle);
      const outcome = await runtime.reserveProviderCall({ ...artifacts, claim });
      expect(outcome).toMatchObject(expected);
      expect('ticket' in outcome).toBe(false);
      expect(JSON.stringify(outcome)).not.toContain(artifacts.intent.intentId);
      expect(mock.calls).toHaveLength(1);
    }
  });

  it('fails closed on empty, extra, unknown, nullable, or over-authoritative decisions', async () => {
    const artifacts = reservationArtifacts();
    const claim = await dispatchClaimFor(artifacts);
    const resultId = uuid(620);
    const malformedReplies: SqlReply[] = [
      [],
      [reservationRow(), reservationRow()],
      [reservationRow({ decision: 'unknown' })],
      [reservationRow({ refusal_reason: 'lease_unavailable' })],
      [reservationRow({ decision: 'already_intended', result_id: resultId })],
      [reservationRow({ decision: 'refused', refusal_reason: null })],
      [reservationRow({ decision: 'refused', refusal_reason: 'not-a-reason' })],
      [reservationRow({ decision: 'won', result_id: null })],
      [reservationRow({
        decision: 'won',
        result_id: resultId,
        intent_text: JSON.stringify({ ...artifacts.intent, attemptNumber: 2 }),
      })],
    ];

    for (const reply of malformedReplies) {
      const mock = scriptedHandle(reply);
      const runtime = createSpWriteRuntimeLedger(mock.handle);
      await expect(runtime.reserveProviderCall({ ...artifacts, claim })).rejects.toMatchObject({
        operation: 'reserve_provider_call',
        category: 'protocol_violation',
        recovery: 'reconcile_only',
        providerCallAllowed: false,
      });
      expect(mock.calls).toHaveLength(1);
    }
  });

  it('returns an opaque ticket only after exact committed winner readback', async () => {
    const artifacts = reservationArtifacts();
    const claim = await dispatchClaimFor(artifacts);
    const resultId = uuid(621);
    const mock = scriptedHandle(
      [reservationRow({
        decision: 'won',
        result_id: resultId,
        intent_text: JSON.stringify(artifacts.intent),
      })],
      [winningReadback(artifacts.intent, resultId)],
    );
    const runtime = createSpWriteRuntimeLedger(mock.handle);

    const outcome = await runtime.reserveProviderCall({ ...artifacts, claim });
    expect(outcome.kind).toBe('dispatch_once');
    if (outcome.kind !== 'dispatch_once') throw new Error('winner fixture returned no ticket');
    expect(outcome.ticket.resultId).toBe(resultId);
    expect(outcome.ticket.intent).toEqual(artifacts.intent);
    expect(Object.isFrozen(outcome.ticket)).toBe(true);
    expect(Object.isFrozen(outcome.ticket.intent)).toBe(true);
    expect(Object.isFrozen(outcome.ticket.intent.positions)).toBe(true);
    expect(Object.isFrozen(outcome.ticket.intent.positions[0])).toBe(true);
    expect(() => JSON.stringify(outcome.ticket)).toThrow(SpWritePersistenceError);
    expect(mock.calls).toHaveLength(2);

    expect(mock.calls[0]?.values).toEqual([
      claim.outboxId,
      claim.claimEpoch,
      uuid(620),
      artifacts.intent.executionId,
      artifacts.intent.planId,
      artifacts.intent.generation,
      artifacts.intent.dispatchLeaseId,
      JSON.stringify(artifacts.observation),
      serializeSpWritePredispatchObservationFingerprint(artifacts.observation),
      JSON.stringify(artifacts.intent),
      serializeSpWriteProviderRequestFingerprint(artifacts.intent),
      serializeSpWriteProviderCallIntentFingerprint(artifacts.intent),
    ]);
  });

  it('fails closed on missing, duplicate, or inconsistent committed ticket readback', async () => {
    const resultId = uuid(623);
    const readbacks = [
      (_artifacts: ReturnType<typeof reservationArtifacts>): SqlReply => [],
      (artifacts: ReturnType<typeof reservationArtifacts>): SqlReply => [
        winningReadback(artifacts.intent, resultId),
        winningReadback(artifacts.intent, resultId),
      ],
      (artifacts: ReturnType<typeof reservationArtifacts>): SqlReply => [
        winningReadback(artifacts.intent, resultId, { intent_id: uuid(624) }),
      ],
      (artifacts: ReturnType<typeof reservationArtifacts>): SqlReply => [
        winningReadback(artifacts.intent, resultId, { position_count: 0 }),
      ],
      (artifacts: ReturnType<typeof reservationArtifacts>): SqlReply => [
        winningReadback(artifacts.intent, resultId, {
          provider_attempt_deadline: new Date('2026-01-01T00:02:04.000Z'),
        }),
      ],
      (artifacts: ReturnType<typeof reservationArtifacts>): SqlReply => [
        winningReadback(artifacts.intent, resultId, { database_read_at: 'not-a-timestamp' }),
      ],
    ];

    for (const readback of readbacks) {
      const artifacts = reservationArtifacts();
      const claim = await dispatchClaimFor(artifacts);
      const mock = scriptedHandle(
        [reservationRow({
          decision: 'won',
          result_id: resultId,
          intent_text: JSON.stringify(artifacts.intent),
        })],
        readback(artifacts),
      );
      const runtime = createSpWriteRuntimeLedger(mock.handle);
      await expect(runtime.reserveProviderCall({ ...artifacts, claim })).rejects.toMatchObject({
        operation: 'read_dispatch_ticket',
        category: 'protocol_violation',
        recovery: 'reconcile_only',
        providerCallAllowed: false,
      });
      expect(mock.calls).toHaveLength(2);
    }
  });

  it('withholds a ticket when the DB clock crosses the deadline within one JS millisecond', async () => {
    const artifacts = reservationArtifacts();
    const claim = await dispatchClaimFor(artifacts);
    const resultId = uuid(622);
    const mock = scriptedHandle(
      [reservationRow({
        decision: 'won',
        result_id: resultId,
        intent_text: JSON.stringify(artifacts.intent),
      })],
      [winningReadback(artifacts.intent, resultId, {
        dispatch_start_deadline: '2026-01-01T00:02:05.000500Z',
        database_read_at: '2026-01-01T00:02:05.000600Z',
        dispatch_window_elapsed: true,
      })],
    );
    const runtime = createSpWriteRuntimeLedger(mock.handle);

    const outcome = await runtime.reserveProviderCall({ ...artifacts, claim });
    expect(outcome).toMatchObject({
      kind: 'closed_without_dispatch',
      reason: 'dispatch_window_elapsed',
    });
    expect('ticket' in outcome).toBe(false);
    expect(mock.calls).toHaveLength(2);
  });

  it('locks provider and recovery origins and preserves every controlled append outcome', async () => {
    const result = providerResult();
    const mock = scriptedHandle(
      [{ outcome: 'recorded' }],
      [{ outcome: 'already_recorded' }],
      [{ outcome: 'late_audited' }],
      [{ outcome: 'canonical_result_already_recorded' }],
    );
    const runtime = createSpWriteRuntimeLedger(mock.handle);

    await expect(runtime.appendProviderResult(result)).resolves.toBe('recorded');
    await expect(runtime.appendProviderResult(result)).resolves.toBe('already_recorded');
    await expect(runtime.appendRecoveryResult(result)).resolves.toBe('late_audited');
    await expect(runtime.appendRecoveryResult(result))
      .resolves.toBe('canonical_result_already_recorded');

    expect(mock.calls).toHaveLength(4);
    for (const [index, call] of mock.calls.entries()) {
      expect(call.text).toContain('app.append_sp_write_provider_result');
      expect(call.values).toEqual([
        JSON.stringify(result),
        serializeSpWriteProviderResultFingerprint(result),
        index < 2 ? 'provider_adapter' : 'recovery_synthesized',
      ]);
    }
  });

  it('maps SQLSTATEs to fixed worker-safe categories without automatic retry', async () => {
    const cases = [
      ['22023', 'invalid_artifact', 'stop'],
      ['42501', 'permission_denied', 'stop'],
      ['23503', 'missing_dependency', 'reload_state'],
      ['P0002', 'missing_dependency', 'reload_state'],
      ['23505', 'identity_or_protocol_conflict', 'reload_state'],
      ['P0003', 'identity_or_protocol_conflict', 'reload_state'],
      ['55000', 'authority_unavailable', 'reload_state'],
      ['40001', 'transaction_aborted', 'reload_state'],
      ['40P01', 'transaction_aborted', 'reload_state'],
      ['57014', 'transaction_aborted', 'reload_state'],
      ['08006', 'outcome_unknown', 'reconcile_only'],
      ['57P01', 'outcome_unknown', 'reconcile_only'],
      ['XX000', 'protocol_violation', 'reconcile_only'],
    ] as const;
    for (const [code, category, recovery] of cases) {
      const raw = Object.assign(new Error('synthetic driver failure'), { code });
      const mock = scriptedHandle(raw);
      const runtime = createSpWriteRuntimeLedger(mock.handle);
      await expect(runtime.startExecution({ approvalId: uuid(930), planId: uuid(931) }))
        .rejects.toMatchObject({
          operation: 'start_execution',
          category,
          recovery,
          providerCallAllowed: false,
        });
      expect(mock.calls).toHaveLength(1);
    }

    const contention = scriptedHandle(
      Object.assign(new Error('synthetic lease contention'), { code: '55P03' }),
    );
    const runtime = createSpWriteRuntimeLedger(contention.handle);
    const claim = await dispatchClaimFor();
    await expect(runtime.acquireDispatchLease({
      claim,
      routeKey: 'sp.v3.keywords.update',
    })).resolves.toEqual({ kind: 'unavailable' });
    expect(contention.calls).toHaveLength(1);
  });

  it('keeps every claim-bound database exception reconciliation-only', async () => {
    const artifacts = reservationArtifacts();
    const claim = await dispatchClaimFor(artifacts);
    const cases = [
      ['22023', 'invalid_artifact'],
      ['42501', 'permission_denied'],
      ['P0002', 'missing_dependency'],
      ['23505', 'identity_or_protocol_conflict'],
      ['55000', 'authority_unavailable'],
      ['40001', 'transaction_aborted'],
      ['40P01', 'transaction_aborted'],
      ['57014', 'transaction_aborted'],
      ['08006', 'outcome_unknown'],
      ['XX000', 'protocol_violation'],
    ] as const;
    for (const [code, category] of cases) {
      const leaseMock = scriptedHandle(Object.assign(new Error('raw lease failure'), { code }));
      await expect(createSpWriteRuntimeLedger(leaseMock.handle).acquireDispatchLease({
        claim,
        routeKey: 'sp.v3.keywords.update',
      })).rejects.toMatchObject({
        operation: 'acquire_dispatch_lease',
        category,
        recovery: 'reconcile_only',
        providerCallAllowed: false,
      });
      expect(leaseMock.calls).toHaveLength(1);

      const reservationMock = scriptedHandle(
        Object.assign(new Error('raw reservation failure'), { code }),
      );
      await expect(createSpWriteRuntimeLedger(reservationMock.handle).reserveProviderCall({
        ...artifacts,
        claim,
      })).rejects.toMatchObject({
        operation: 'reserve_provider_call',
        category,
        recovery: 'reconcile_only',
        providerCallAllowed: false,
      });
      expect(reservationMock.calls).toHaveLength(1);

      const resultId = uuid(932);
      const readbackMock = scriptedHandle(
        [reservationRow({
          decision: 'won',
          result_id: resultId,
          intent_text: JSON.stringify(artifacts.intent),
        })],
        Object.assign(new Error('raw readback failure'), { code }),
      );
      await expect(createSpWriteRuntimeLedger(readbackMock.handle).reserveProviderCall({
        ...artifacts,
        claim,
      })).rejects.toMatchObject({
        operation: 'read_dispatch_ticket',
        category,
        recovery: 'reconcile_only',
        providerCallAllowed: false,
      });
      expect(readbackMock.calls).toHaveLength(2);
    }
  });

  it('sanitizes every raw database field and cause without preserving authority', async () => {
    const sentinel = `synthetic-sensitive-${uuid(991)}`;
    const raw = Object.assign(new Error(sentinel, { cause: new Error(`${sentinel}-cause`) }), {
      code: '08006',
      query: `select '${sentinel}'`,
      parameters: [sentinel],
      detail: sentinel,
      hint: sentinel,
      where: sentinel,
      schema_name: sentinel,
      table_name: sentinel,
      column_name: sentinel,
      constraint_name: sentinel,
    });
    const artifacts = reservationArtifacts();
    const claim = await dispatchClaimFor(artifacts);
    const mock = scriptedHandle(raw);
    const runtime = createSpWriteRuntimeLedger(mock.handle);
    let failure: unknown;
    try {
      await runtime.reserveProviderCall({ ...artifacts, claim });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SpWritePersistenceError);
    const error = failure as SpWritePersistenceError;
    expect(error.operation).toBe('reserve_provider_call');
    expect(error.providerCallAllowed).toBe(false);
    expect(error.category).toBe('outcome_unknown');
    expect(error.recovery).toBe('reconcile_only');
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(sentinel);
    expect(error.message).not.toContain(sentinel);
    expect(error.stack).not.toContain(sentinel);
    expect(Object.values(error)).not.toContain(sentinel);
    expect(mock.calls).toHaveLength(1);
  });
});
