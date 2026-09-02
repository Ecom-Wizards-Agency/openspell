import { createHash, randomUUID } from 'node:crypto';
import {
  ApproveSpWritePlan,
  SpWriteAction,
  SpWriteAuthorizationReceipt,
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
  spWritePlanBinding,
} from '@wizard-ads/shared/sp-writes';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSpWriteOutboxLedger,
  createSpWriteRuntimeLedger,
  createSpWriteStagingLedger,
} from './sp-write-persistence.js';
import type { SpWriteDispatchOutboxClaim } from './sp-write-persistence.js';
import { createTestDatabase, databaseAvailable } from './testing/harness.js';
import { asServiceRole, asUser } from './testing/rls.js';
import type { TestDatabase } from './testing/harness.js';

const available = await databaseAvailable();
const OWNER_USER_ID = '00000000-0000-4000-8000-000000009188';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForDatabaseLock(
  database: TestDatabase,
  queryFragment: string,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const [row] = await database.sql<{ waiting: boolean }[]>`
      select exists (
        select 1 from pg_catalog.pg_stat_activity activity
        where activity.datname = current_database()
          and activity.pid <> pg_backend_pid()
          and activity.wait_event_type = 'Lock'
          and activity.query like ${`%${queryFragment}%`}
      ) as waiting
    `;
    if (row?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`database call did not enter a Lock wait: ${queryFragment}`);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

interface Tenant {
  orgId: string;
  profileId: string;
  connectionId: string;
  amazonProfileId: string;
  userId: string;
}

function keywordPlan(tenant: Tenant, seed: number) {
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
    orgId: tenant.orgId,
    profileId: tenant.profileId,
    providerScope: {
      amazonProfileId: tenant.amazonProfileId,
      connectionId: tenant.connectionId,
      region: 'NA',
      marketplaceId: 'synthetic-marketplace',
      currencyCode: 'USD',
      apiDialect: 'sp_v3',
    },
    direction: 'forward',
    source: {
      kind: 'apply_batch',
      applyBatchId: uuid(seed + 3),
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
  return { plan, action };
}

function reservationArtifacts(
  proof: ReturnType<typeof keywordPlan>,
  receipt: Pick<
    ReturnType<typeof SpWriteAuthorizationReceipt.parse>,
    'approvalId' | 'executionId' | 'generation'
  >,
  leaseId: string,
  observedAt: string,
  validUntil: string,
  seed: number,
  observedSide: 'expected' | 'requested' = 'expected',
) {
  const { action } = proof;
  if (action.routeKey !== 'sp.v3.keywords.update' || action.changes.bid === undefined) {
    throw new Error('integration fixture requires a keyword bid action');
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
      values: { bid: action.changes.bid[observedSide] },
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
  const withRequest = SpWriteProviderCallIntent.parse({
    ...intentBase,
    requestFingerprint: sha256(serializeSpWriteProviderRequestFingerprint(intentBase)),
  });
  const intent = SpWriteProviderCallIntent.parse({
    ...withRequest,
    fingerprint: sha256(serializeSpWriteProviderCallIntentFingerprint(withRequest)),
  });
  return { observation, intent };
}

function acceptedResult(
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

function requestedObservation(
  proof: ReturnType<typeof keywordPlan>,
  receipt: Pick<
    ReturnType<typeof SpWriteAuthorizationReceipt.parse>,
    'approvalId' | 'executionId' | 'generation'
  >,
  intent: ReturnType<typeof SpWriteProviderCallIntent.parse>,
  sourceSyncJobId: string,
  observedAt: string,
  seed: number,
) {
  const { action } = proof;
  if (action.routeKey !== 'sp.v3.keywords.update' || action.changes.bid === undefined) {
    throw new Error('integration fixture requires a keyword bid action');
  }
  const base = SpWriteObservation.parse({
    schemaVersion: 'openspell.sp-write-observation.v1',
    observationId: uuid(seed),
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

function boundedAuthorization(
  proof: ReturnType<typeof keywordPlan>,
  authorizationId: string,
) {
  const { action, plan } = proof;
  if (action.routeKey !== 'sp.v3.keywords.update' || !('keywordId' in action.entity)) {
    throw new Error('bounded integration fixture requires a keyword action');
  }
  const base = SpWriteBoundedAuthorization.parse({
    schemaVersion: 'openspell.sp-write-bounded-authorization.v1',
    authorizationId,
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2030-01-01T01:00:00.000Z',
    profiles: [{
      providerScope: plan.providerScope,
      allowedEntities: [{
        routeKey: action.routeKey,
        amazonEntityId: action.entity.keywordId,
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

async function approveManualPlan(
  database: TestDatabase,
  tenant: Tenant,
  plan: ReturnType<typeof SpWritePlan.parse>,
  approvalRequestId: string,
) {
  const approvalRequest = ApproveSpWritePlan.parse({
    approvalRequestId,
    plan: spWritePlanBinding(plan),
    approvalMode: 'manual',
    confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
    boundedAuthorization: null,
    preapprovedInversePlan: null,
  });
  const [approval] = await asUser(database, tenant.userId, async (sql) => sql<{
    receipt: unknown;
  }[]>`
    select app.approve_sp_write_cycle(
      ${plan.id}::uuid,
      ${JSON.stringify(approvalRequest)}
    ) as receipt
  `);
  return SpWriteAuthorizationReceipt.parse(approval?.receipt);
}

async function enableAuthority(database: TestDatabase, tenant: Tenant, seed: number) {
  await database.sql.begin(async (sql) => {
    await sql`
      insert into public.sp_write_environment_gate_versions
        (version_id, enabled, max_unresolved_calls, created_by)
      values (${uuid(seed)}::uuid, true, 1, ${tenant.userId}::uuid)
    `;
    await sql`
      insert into public.sp_write_environment_gate_head (singleton, version_id)
      values (true, ${uuid(seed)}::uuid)
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

describe.skipIf(!available)('SP write persistence facade default-off integration', () => {
  it('cannot start, lease, or reserve from an empty authority state', async () => {
    const database = await createTestDatabase('sp_write_facade_empty');
    try {
      const [seed] = await database.sql<{ seed_tenant_fixture: string }[]>`
        select app.seed_tenant_fixture(
          'sp-write-facade-empty', ${uuid(188_880)}::uuid, 'owner'
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
      if (!seed || !profile) throw new Error('empty facade tenant was not seeded');
      const tenant: Tenant = {
        orgId: seed.seed_tenant_fixture,
        profileId: profile.id,
        connectionId: profile.connection_id,
        amazonProfileId: profile.amazon_profile_id,
        userId: uuid(188_880),
      };
      const staging = createSpWriteStagingLedger(database);
      const outbox = createSpWriteOutboxLedger(database);
      const runtime = createSpWriteRuntimeLedger(database);
      const proof = keywordPlan(tenant, 188_881);
      await expect(staging.recordPlan(proof.plan)).resolves.toBe(proof.plan.id);

      await expect(runtime.startExecution({
        approvalId: uuid(188_885),
        planId: proof.plan.id,
      })).rejects.toMatchObject({
        operation: 'start_execution',
        category: 'missing_dependency',
        providerCallAllowed: false,
      });
      await expect(outbox.claimAvailable({
        claimantId: 'empty-facade-worker',
        kinds: ['dispatch'],
        limit: 1,
      })).resolves.toEqual({ offeredCount: 0, claimedCount: 0, claims: [] });

      const [time] = await database.sql<{ observed_at: string; valid_until: string }[]>`
        select app.sp_write_instant(clock_timestamp()) as observed_at,
               app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
      `;
      if (!time) throw new Error('empty facade reservation time was not derived');
      const artifacts = reservationArtifacts(
        proof,
        {
          approvalId: uuid(188_885),
          executionId: uuid(188_886),
          generation: uuid(188_887),
        },
        uuid(188_888),
        time.observed_at,
        time.valid_until,
        188_890,
      );
      const forgedClaim = {
        outboxId: uuid(188_889),
        orgId: tenant.orgId,
        profileId: tenant.profileId,
        executionId: artifacts.intent.executionId,
        planId: artifacts.intent.planId,
        approvalId: artifacts.intent.approvalId,
        generation: artifacts.intent.generation,
        claimEpoch: '1',
        claimedAt: time.observed_at,
        expiresAt: time.valid_until,
        kind: 'dispatch',
        toJSON(): never {
          throw new Error('forged claim');
        },
      } as SpWriteDispatchOutboxClaim;
      await expect(runtime.acquireDispatchLease({
        claim: forgedClaim,
        routeKey: 'sp.v3.keywords.update',
      })).rejects.toMatchObject({
        operation: 'acquire_dispatch_lease',
        category: 'invalid_artifact',
        providerCallAllowed: false,
      });
      await expect(runtime.reserveProviderCall({ ...artifacts, claim: forgedClaim }))
        .rejects.toMatchObject({
          operation: 'reserve_provider_call',
          category: 'invalid_artifact',
          providerCallAllowed: false,
        });
      const [closure] = await database.sql<{ intents: number; dispositions: number }[]>`
        select
          (select count(*)::int from public.sp_write_provider_call_intents
            where plan_id = ${proof.plan.id}::uuid) as intents,
          (select count(*)::int from public.sp_write_predispatch_dispositions
            where plan_id = ${proof.plan.id}::uuid) as dispositions
      `;
      expect(closure).toEqual({ intents: 0, dispositions: 0 });
    } finally {
      await database.drop();
    }
  }, 90_000);
});

describe.skipIf(!available)('SP write persistence facade integration', () => {
  let database: TestDatabase;
  let tenant: Tenant;
  let secondTenant: Pick<Tenant, 'orgId' | 'profileId'>;

  beforeAll(async () => {
    database = await createTestDatabase('sp_write_facade');
    const [seed] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('sp-write-facade', ${OWNER_USER_ID}::uuid, 'owner')
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
    if (!seed || !profile) throw new Error('facade tenant was not seeded');
    tenant = {
      orgId: seed.seed_tenant_fixture,
      profileId: profile.id,
      connectionId: profile.connection_id,
      amazonProfileId: profile.amazon_profile_id,
      userId: OWNER_USER_ID,
    };
    const [secondSeed] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('sp-write-facade-b', ${uuid(188_998)}::uuid, 'owner')
    `;
    const [secondProfile] = await database.sql<{ id: string }[]>`
      select id
        from public.ad_profiles
       where org_id = ${secondSeed?.seed_tenant_fixture ?? null}::uuid
    `;
    if (!secondSeed || !secondProfile) throw new Error('second facade tenant was not seeded');
    secondTenant = { orgId: secondSeed.seed_tenant_fixture, profileId: secondProfile.id };
    await enableAuthority(database, tenant, 188_000);
    await asServiceRole(database, async (sql) => {
      const [acl] = await sql<{
        current_user: string;
        can_record: boolean;
        can_read: boolean;
      }[]>`
        select current_user::text,
               has_function_privilege(
                 current_user,
                 'app.record_sp_write_plan(text,text,jsonb)',
                 'EXECUTE'
               ) as can_record,
               has_table_privilege(
                 current_user,
                 'public.sp_write_plans',
                 'SELECT'
               ) as can_read
      `;
      expect(acl).toEqual({
        current_user: 'service_role',
        can_record: true,
        can_read: true,
      });
      await expect(sql`select app.record_sp_write_plan('', '', '[]'::jsonb)`)
        .rejects.toMatchObject({ code: '22023' });
    });
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('closes the service-role lifecycle matrix and reconstructs exact evidence', async () => {
    const staging = createSpWriteStagingLedger(database);
    const outbox = createSpWriteOutboxLedger(database);
    const runtime = createSpWriteRuntimeLedger(database);
    const proof = keywordPlan(tenant, 188_100);
    const recordedPlanId = await staging.recordPlan(proof.plan);
    expect(recordedPlanId).toBe(proof.plan.id);
    const authorization = boundedAuthorization(proof, uuid(188_104));
    await expect(staging.recordBoundedAuthorization({
      authorization,
      bindings: [{
        orgId: tenant.orgId,
        profileId: tenant.profileId,
        providerScope: proof.plan.providerScope,
      }],
    })).resolves.toBe(authorization.authorizationId);
    const [roundTrip] = await database.sql<{
      plan_text: string;
      action_text: string;
      authorization_text: string;
      profile_count: number;
      entity_count: number;
    }[]>`
      select plan.artifact_text as plan_text,
             action.artifact_text as action_text,
             bounded.artifact_text as authorization_text,
             (select count(*)::int
                from public.sp_write_bounded_authorization_profiles profile
               where profile.authorization_id = bounded.authorization_id) as profile_count,
             (select count(*)::int
                from public.sp_write_bounded_authorization_entities entity
               where entity.authorization_id = bounded.authorization_id) as entity_count
        from public.sp_write_plans plan
        join public.sp_write_plan_actions action on action.plan_id = plan.plan_id
        join public.sp_write_bounded_authorizations bounded
          on bounded.authorization_id = ${authorization.authorizationId}::uuid
       where plan.plan_id = ${proof.plan.id}::uuid
    `;
    expect(roundTrip).toEqual({
      plan_text: JSON.stringify(proof.plan),
      action_text: JSON.stringify(proof.action),
      authorization_text: JSON.stringify(authorization),
      profile_count: 1,
      entity_count: 1,
    });

    const receipt = await approveManualPlan(database, tenant, proof.plan, uuid(188_105));

    const outboxId = await runtime.startExecution({
      approvalId: receipt.approvalId,
      planId: proof.plan.id,
    });
    expect(outboxId).toMatch(/^[0-9a-f-]{36}$/u);
    await expect(runtime.startExecution({
      approvalId: receipt.approvalId,
      planId: proof.plan.id,
    })).resolves.toBe(outboxId);
    const [startCounts] = await database.sql<{ requests: number; wakes: number }[]>`
      select
        (select count(*)::int from public.sp_write_execution_requests
          where execution_id = ${receipt.executionId}::uuid
            and plan_id = ${proof.plan.id}::uuid) as requests,
        (select count(*)::int from public.sp_write_outbox
          where execution_id = ${receipt.executionId}::uuid
            and plan_id = ${proof.plan.id}::uuid and kind = 'dispatch') as wakes
    `;
    expect(startCounts).toEqual({ requests: 1, wakes: 1 });

    const firstBatch = await outbox.claimAvailable({
      claimantId: 'facade-worker-a',
      kinds: ['dispatch'],
      limit: 1,
    });
    expect(firstBatch).toMatchObject({ offeredCount: 1, claimedCount: 1 });
    const dispatchClaim = firstBatch.claims[0];
    if (dispatchClaim?.kind !== 'dispatch') throw new Error('facade dispatch wake was not claimed');

    const lease = await runtime.acquireDispatchLease({
      claim: dispatchClaim,
      routeKey: 'sp.v3.keywords.update',
      leaseSeconds: 120,
    });
    expect(lease.kind).toBe('acquired');
    if (lease.kind !== 'acquired') throw new Error('facade lease was unavailable');
    await expect(runtime.acquireDispatchLease({
      claim: dispatchClaim,
      routeKey: 'sp.v3.keywords.update',
      leaseSeconds: 120,
    })).resolves.toEqual({ kind: 'unavailable' });

    const [time] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!time) throw new Error('facade reservation time was not derived');
    const artifacts = reservationArtifacts(
      proof,
      receipt,
      lease.leaseId,
      time.observed_at,
      time.valid_until,
      188_110,
    );

    const reservations = await Promise.all([
      runtime.reserveProviderCall({ ...artifacts, claim: dispatchClaim }),
      runtime.reserveProviderCall({ ...artifacts, claim: dispatchClaim }),
    ]);
    const winners = reservations.filter((outcome) => outcome.kind === 'dispatch_once');
    expect(winners).toHaveLength(1);
    expect(reservations.filter((outcome) => outcome.kind !== 'dispatch_once')).toEqual([
      expect.objectContaining({
        kind: 'closed_without_dispatch',
        reason: 'already_intended',
      }),
    ]);
    const winner = winners[0];
    if (winner?.kind !== 'dispatch_once') throw new Error('facade had no ticket winner');
    expect(() => JSON.stringify(winner.ticket)).toThrow();
    const [committed] = await database.sql<{
      intent_id: string;
      reserved_result_id: string;
      positions: number;
    }[]>`
      select intent.intent_id::text, intent.reserved_result_id::text,
             (select count(*)::int from public.sp_write_provider_call_positions position
               where position.intent_id = intent.intent_id) as positions
        from public.sp_write_provider_call_intents intent
       where intent.intent_id = ${winner.ticket.intent.intentId}::uuid
    `;
    expect(committed).toEqual({
      intent_id: winner.ticket.intent.intentId,
      reserved_result_id: winner.ticket.resultId,
      positions: 1,
    });
    await expect(outbox.completeClaim(dispatchClaim)).resolves.toMatchObject({
      kind: 'completed',
    });

    const blockedProof = keywordPlan(tenant, 188_200);
    await staging.recordPlan(blockedProof.plan);
    const blockedReceipt = await approveManualPlan(
      database,
      tenant,
      blockedProof.plan,
      uuid(188_204),
    );
    await runtime.startExecution({
      approvalId: blockedReceipt.approvalId,
      planId: blockedProof.plan.id,
    });
    const blockedBatch = await outbox.claimAvailable({
      claimantId: 'facade-worker-b',
      kinds: ['dispatch'],
      limit: 1,
    });
    const blockedClaim = blockedBatch.claims[0];
    if (blockedClaim?.kind !== 'dispatch') {
      throw new Error('blocked facade dispatch wake was not claimed');
    }
    const blockedLease = await runtime.acquireDispatchLease({
      claim: blockedClaim,
      routeKey: 'sp.v3.keywords.update',
    });
    if (blockedLease.kind !== 'acquired') throw new Error('blocked facade lease was unavailable');
    const [blockedTime] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!blockedTime) throw new Error('blocked facade reservation time was not derived');
    const blockedArtifacts = reservationArtifacts(
      blockedProof,
      blockedReceipt,
      blockedLease.leaseId,
      blockedTime.observed_at,
      blockedTime.valid_until,
      188_210,
    );
    await expect(runtime.reserveProviderCall({ ...blockedArtifacts, claim: blockedClaim }))
      .resolves.toMatchObject({
        kind: 'defer_and_reobserve',
        reason: 'busy',
      });

    const [completion] = await database.sql<{ completed_at: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as completed_at
    `;
    if (!completion) throw new Error('facade result time was not derived');
    const result = acceptedResult(
      winner.ticket.intent,
      winner.ticket.resultId,
      completion.completed_at,
    );
    const firstAppend = await runtime.appendProviderResult(result);
    const replayAppend = await runtime.appendProviderResult(result);
    expect([firstAppend, replayAppend]).toEqual(['recorded', 'already_recorded']);

    const [refusalTime] = await database.sql<{ observed_at: string; valid_until: string }[]>`
      select app.sp_write_instant(clock_timestamp()) as observed_at,
             app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
    `;
    if (!refusalTime) throw new Error('refusal facade reservation time was not derived');
    const refusalArtifacts = reservationArtifacts(
      blockedProof,
      blockedReceipt,
      blockedLease.leaseId,
      refusalTime.observed_at,
      refusalTime.valid_until,
      188_220,
      'requested',
    );
    await expect(runtime.reserveProviderCall({ ...refusalArtifacts, claim: blockedClaim }))
      .resolves.toMatchObject({
        kind: 'closed_without_dispatch',
        reason: 'stale_expected_state',
      });
    await expect(outbox.completeClaim(blockedClaim)).resolves.toMatchObject({
      kind: 'completed',
    });
    const refusedEvidence = await runtime.loadVerifiedExecution({
      orgId: tenant.orgId,
      profileId: tenant.profileId,
      executionId: blockedReceipt.executionId,
      planId: blockedProof.plan.id,
      approvalId: blockedReceipt.approvalId,
      generation: blockedReceipt.generation,
    });
    expect(refusedEvidence?.snapshot.status).toBe('refused');

    const [wake] = await database.sql<{
      source_sync_job_id: string;
      observed_at: string;
    }[]>`
      select source_sync_job_id::text,
             app.sp_write_instant(clock_timestamp()) as observed_at
        from public.sp_write_outbox
       where intent_id = ${winner.ticket.intent.intentId}::uuid
         and kind = 'observe_and_recover'
    `;
    if (!wake) throw new Error('facade observation wake was not recorded');
    const observationBatch = await outbox.claimAvailable({
      claimantId: 'facade-worker-observe',
      kinds: ['observe_and_recover'],
      limit: 10,
    });
    const observationClaim = observationBatch.claims.find((claim) =>
      claim.kind === 'observe_and_recover'
      && claim.intentId === winner.ticket.intent.intentId);
    if (observationClaim?.kind !== 'observe_and_recover') {
      throw new Error('facade observation wake was not claimed');
    }
    expect(observationClaim.sourceSyncJobId).toBe(wake.source_sync_job_id);
    const observation = requestedObservation(
      proof,
      receipt,
      winner.ticket.intent,
      wake.source_sync_job_id,
      wake.observed_at,
      188_120,
    );
    const firstObservation = await runtime.appendObservation(observation);
    const replayObservation = await runtime.appendObservation(observation);
    expect([firstObservation, replayObservation]).toEqual([
      observation.observationId,
      observation.observationId,
    ]);
    await expect(outbox.completeClaim(observationClaim)).resolves.toMatchObject({
      kind: 'completed',
    });

    const evidence = await runtime.loadVerifiedExecution({
      orgId: tenant.orgId,
      profileId: tenant.profileId,
      executionId: receipt.executionId,
      planId: proof.plan.id,
      approvalId: receipt.approvalId,
      generation: receipt.generation,
    });
    expect(evidence?.snapshot).toEqual({
      accounting: {
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
      status: 'succeeded',
    });

    const mismatched = await runtime.loadVerifiedExecution({
      orgId: secondTenant.orgId,
      profileId: secondTenant.profileId,
      executionId: receipt.executionId,
      planId: proof.plan.id,
      approvalId: receipt.approvalId,
      generation: receipt.generation,
    });
    expect(mismatched).toBeNull();
    await expect(runtime.loadVerifiedExecution({
      orgId: tenant.orgId,
      profileId: secondTenant.profileId,
      executionId: receipt.executionId,
      planId: proof.plan.id,
      approvalId: receipt.approvalId,
      generation: receipt.generation,
    })).resolves.toBeNull();
  }, 60_000);
});

describe.skipIf(!available)('SP write outbox reservation purge interlock', () => {
  it('commits the reservation winner before a waiting purge fails closed', async () => {
    const database = await createTestDatabase('sp_write_reservation_purge');
    const blocker = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const caller = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const deleter = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const userId = uuid(189_500);
      const orgId = randomUUID();
      const profileId = randomUUID();
      const connectionId = randomUUID();
      const amazonProfileId = `synthetic-${profileId.slice(0, 8)}`;
      await database.sql`select public.auth_user_stub(${userId}::uuid)`;
      await database.sql`
        insert into public.orgs (id, slug, name)
        values (${orgId}::uuid, ${`wp192-${orgId.slice(0, 8)}`}, 'WP 192 purge tenant')
      `;
      await database.sql`
        insert into public.org_members (org_id, user_id, role)
        values (${orgId}::uuid, ${userId}::uuid, 'owner')
      `;
      await database.sql`
        insert into public.ads_connections (id, org_id, label, status)
        values (${connectionId}::uuid, ${orgId}::uuid, 'synthetic-purge', 'active')
      `;
      await database.sql`
        insert into public.ad_profiles (
          id, org_id, connection_id, amazon_profile_id, region, country_code,
          currency_code, timezone, sync_enabled, first_seen_at
        ) values (
          ${profileId}::uuid, ${orgId}::uuid, ${connectionId}::uuid,
          ${amazonProfileId}, 'NA', 'US', 'USD', 'UTC', false, clock_timestamp()
        )
      `;
      const tenant: Tenant = {
        orgId,
        profileId,
        connectionId,
        amazonProfileId,
        userId,
      };
      await enableAuthority(database, tenant, 189_510);
      const proof = keywordPlan(tenant, 189_600);
      await createSpWriteStagingLedger(database).recordPlan(proof.plan);
      const receipt = await approveManualPlan(database, tenant, proof.plan, uuid(189_605));
      const outboxId = await createSpWriteRuntimeLedger(database).startExecution({
        approvalId: receipt.approvalId,
        planId: proof.plan.id,
      });
      const countCycle = async () => {
        const [row] = await database.sql<{
          outboxes: number;
          leases: number;
          intents: number;
        }[]>`
          select
            (select count(*)::int from public.sp_write_outbox
              where org_id = ${tenant.orgId}::uuid) as outboxes,
            (select count(*)::int from public.sp_write_dispatch_leases
              where org_id = ${tenant.orgId}::uuid) as leases,
            (select count(*)::int from public.sp_write_provider_call_intents
              where org_id = ${tenant.orgId}::uuid) as intents
        `;
        return row;
      };
      expect(await countCycle()).toEqual({ outboxes: 1, leases: 0, intents: 0 });
      const [claim] = await database.sql<{
        claim_epoch: string;
        claim_token: string;
      }[]>`
        select claim_epoch::text, claim_token::text
        from app.claim_sp_write_outbox(
          'wp192-reservation-purge',
          array['dispatch']::public.sp_write_outbox_kind[], 1, 120
        )
      `;
      if (!claim) throw new Error('reservation-purge dispatch wake was not claimed');
      expect(await countCycle()).toEqual({ outboxes: 1, leases: 0, intents: 0 });
      const [lease] = await database.sql<{ lease_id: string }[]>`
        select lease_id::text from app.acquire_sp_write_dispatch_lease_for_claim(
          ${outboxId}::uuid, ${claim.claim_epoch}::bigint, ${claim.claim_token}::uuid,
          'sp.v3.keywords.update', 120
        )
      `;
      if (!lease) throw new Error('reservation-purge dispatch lease was not acquired');
      expect(await countCycle()).toEqual({ outboxes: 1, leases: 1, intents: 0 });
      const [time] = await database.sql<{ observed_at: string; valid_until: string }[]>`
        select app.sp_write_instant(clock_timestamp()) as observed_at,
               app.sp_write_instant(clock_timestamp() + interval '60 seconds') as valid_until
      `;
      if (!time) throw new Error('reservation-purge timestamps were not derived');
      const artifacts = reservationArtifacts(
        proof,
        receipt,
        lease.lease_id,
        time.observed_at,
        time.valid_until,
        189_610,
      );
      const [baseline] = await database.sql<{
        outboxes: number;
        heads: number;
        leases: number;
        intents: number;
        positions: number;
      }[]>`
        select
          (select count(*)::int from public.sp_write_outbox
            where org_id = ${tenant.orgId}::uuid) as outboxes,
          (select count(*)::int from app.sp_write_outbox_delivery_heads
            where org_id = ${tenant.orgId}::uuid) as heads,
          (select count(*)::int from public.sp_write_dispatch_leases
            where org_id = ${tenant.orgId}::uuid) as leases,
          (select count(*)::int from public.sp_write_provider_call_intents
            where org_id = ${tenant.orgId}::uuid) as intents,
          (select count(*)::int from public.sp_write_provider_call_positions
            where org_id = ${tenant.orgId}::uuid) as positions
      `;
      expect(baseline).toEqual({
        outboxes: 1,
        heads: 1,
        leases: 1,
        intents: 0,
        positions: 0,
      });

      const locked = deferred();
      const release = deferred();
      const blockerWork = blocker.begin(async (transaction) => {
        await transaction`
          select 1 from public.sp_write_environment_gate_head head
          where head.singleton
          for update
        `;
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      const reservationCall = caller<{ decision: string; result_id: string | null }[]>`
          select decision, result_id::text
          from app.reserve_sp_write_provider_call_for_claim(
            ${outboxId}::uuid, ${claim.claim_epoch}::bigint, ${claim.claim_token}::uuid,
            ${receipt.executionId}::uuid, ${proof.plan.id}::uuid,
            ${receipt.generation}::uuid, ${lease.lease_id}::uuid,
            ${JSON.stringify(artifacts.observation)},
            ${serializeSpWritePredispatchObservationFingerprint(artifacts.observation)},
            ${JSON.stringify(artifacts.intent)},
            ${serializeSpWriteProviderRequestFingerprint(artifacts.intent)},
            ${serializeSpWriteProviderCallIntentFingerprint(artifacts.intent)}
          )
        `.then((rows) => rows);
      await waitForDatabaseLock(database, 'reserve_sp_write_provider_call_for_claim');
      const deletion = deleter`
          delete /* wp192_reservation_wrapper_purge_wait */ from public.orgs
          where id = ${tenant.orgId}::uuid
        `.then(
          (rows) => ({ rows }),
          (error: unknown) => ({ error }),
        );
      try {
        await waitForDatabaseLock(database, 'wp192_reservation_wrapper_purge_wait');
      } finally {
        release.resolve();
      }
      await blockerWork;
      const [reservation] = await reservationCall;
      expect(reservation?.decision).toBe('won');
      expect(reservation?.result_id).toMatch(/^[0-9a-f-]{36}$/u);
      const deletionResult = await deletion;
      expect('error' in deletionResult ? deletionResult.error : undefined)
        .toMatchObject({ code: '55000' });
      const [counts] = await database.sql<{
        orgs: number;
        outboxes: number;
        heads: number;
        events: number;
        leases: number;
        intents: number;
        positions: number;
      }[]>`
        select
          (select count(*)::int from public.orgs where id = ${tenant.orgId}::uuid) as orgs,
          (select count(*)::int from public.sp_write_outbox
            where org_id = ${tenant.orgId}::uuid) as outboxes,
          (select count(*)::int from app.sp_write_outbox_delivery_heads
            where org_id = ${tenant.orgId}::uuid) as heads,
          (select count(*)::int from app.sp_write_outbox_delivery_events
            where org_id = ${tenant.orgId}::uuid) as events,
          (select count(*)::int from public.sp_write_dispatch_leases
            where org_id = ${tenant.orgId}::uuid) as leases,
          (select count(*)::int from public.sp_write_provider_call_intents
            where org_id = ${tenant.orgId}::uuid) as intents,
          (select count(*)::int from public.sp_write_provider_call_positions
            where org_id = ${tenant.orgId}::uuid) as positions
      `;
      expect(counts).toEqual({
        orgs: 1,
        outboxes: 2,
        heads: 2,
        events: 1,
        leases: 1,
        intents: 1,
        positions: 1,
      });
    } finally {
      await blocker.end({ timeout: 2 }).catch(() => {});
      await caller.end({ timeout: 2 }).catch(() => {});
      await deleter.end({ timeout: 2 }).catch(() => {});
      await database.drop();
    }
  }, 90_000);
});
