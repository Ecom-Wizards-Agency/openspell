import { createHash, randomUUID } from 'node:crypto';
import {
  BoundedAmazonWriteAuthorization,
  serializeAmazonWriteAttemptFingerprint,
  serializeAmazonWriteProviderCallFingerprint,
  serializeApplyRows,
  serializeBoundedAmazonWriteAuthorization,
  type AmazonWriteAction,
  type AmazonWriteProviderCallEvidence,
} from '@wizard-ads/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  approveAmazonWriteExecution,
  amazonWriteExecutionIdempotencyKey,
  getAmazonWriteProviderCallAccounting,
  getAmazonWriteInversePreview,
  listAmazonWriteObservationRows,
  markAmazonWriteRowsDispatched,
  prepareAmazonWriteExecution,
  recoverAmazonWriteOutbox,
  recordAmazonWritePredispatchObservations,
  recordAmazonWriteObservations,
  recordAmazonWriteOutcomes,
  reapproveAmazonWriteInverseExecution,
  refuseAmazonWriteExecution,
  releaseAmazonWriteExecutionForRetry,
} from './amazon-writes.js';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { asUser } from '../testing/rls.js';
import { recordEntityChanges } from './entities.js';

const available = await databaseAvailable();
const USER_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '12121212-1212-4212-8212-121212121212';
const APPROVED_AT = new Date(Date.now() - 60_000).toISOString();
const EXPIRES_AT = new Date(Date.now() + 86_400_000).toISOString();
const AUTHORIZATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BUDGET_AUTHORIZATION_ID = 'abababab-abab-4bab-8bab-abababababab';
const DISPATCH_TOKEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function providerCallFingerprint(input: {
  executionId: string;
  callId: string;
  providerOperation: AmazonWriteAction['actionType'];
  requestedEntityIds: readonly string[];
  actions: readonly AmazonWriteAction[];
}): string {
  return sha(serializeAmazonWriteProviderCallFingerprint(input));
}

describe.skipIf(!available)('guarded Amazon write persistence', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  let amazonProfileId: string;
  let connectionId: string;
  let profileRegion: 'NA' | 'EU' | 'FE';
  let sequence = 0;
  const callByWriteRow = new Map<string, string>();

  function authorizationSnapshot(authorizationId = AUTHORIZATION_ID) {
    return BoundedAmazonWriteAuthorization.parse({
      schema: 'openspell.amazon-write-authorization.v1',
      authorization_id: authorizationId,
      expires_at: EXPIRES_AT,
      profiles: [{
        org_id: orgId, profile_id: profileId, amazon_profile_id: amazonProfileId,
        connection_id: connectionId, region: profileRegion,
        account_label: 'Synthetic account', marketplace: 'US',
        allowed_entities: [
          { action_type: 'sp_keyword_bid', amazon_entity_id: 'kw-1', field: 'bid' },
          { action_type: 'sp_target_bid', amazon_entity_id: 'tg-1', field: 'bid' },
          { action_type: 'sp_campaign_placement', amazon_entity_id: 'c-1', field: 'top_of_search' },
          { action_type: 'sp_campaign_placement', amazon_entity_id: 'c-1', field: 'product_pages' },
        ],
      }],
      allowed_tests: {
        bid: { enabled: true, max_absolute_delta: 0.01, require_immediate_inverse: true },
        placement: { enabled: true, max_absolute_percentage_points: 1, require_immediate_inverse: true },
        cadence: { enabled: false, max_executions: 0, disable_after_test: true, require_immediate_inverse: true },
      },
      constraints: {
        max_concurrent_mutations: 1, max_rows_per_execution: 100,
        max_total_executions: 100, require_current_value_match: true,
        require_amazon_acceptance: true, require_sync_observation_before_inverse: true,
        stop_on_conflict: true,
      },
    });
  }

  function authorizationSha256(authorizationId = AUTHORIZATION_ID): string {
    return sha(serializeBoundedAmazonWriteAuthorization(authorizationSnapshot(authorizationId)));
  }

  beforeAll(async () => {
    database = await createTestDatabase('amazon_writes');
    const [seeded] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('write-fixture', ${USER_ID}, 'owner')
    `;
    orgId = seeded?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{
      id: string; amazon_profile_id: string; connection_id: string | null;
      region: 'NA' | 'EU' | 'FE';
    }[]>`
      select id, amazon_profile_id, connection_id, region::text as region
        from public.ad_profiles where org_id = ${orgId}
    `;
    profileId = profile?.id ?? '';
    amazonProfileId = profile?.amazon_profile_id ?? '';
    connectionId = profile?.connection_id ?? '';
    profileRegion = profile?.region ?? 'NA';
    await database.sql`select public.auth_user_stub(${ADMIN_ID})`;
    await database.sql`
      insert into public.org_members (org_id, user_id, role)
      values (${orgId}, ${ADMIN_ID}, 'admin')
    `;
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await database.sql`
      insert into public.org_members (org_id, user_id, role)
      values (${orgId}, ${USER_ID}, 'owner')
      on conflict (org_id, user_id) do update set role = excluded.role
    `;
    await database.sql`
      update public.amazon_write_executions execution
         set status = 'refused', completed_at = coalesce(completed_at, now()),
             dispatch_lease_token = null, dispatch_lease_expires_at = null
        from public.apply_batches batch
       where batch.id = execution.apply_batch_id
         and execution.org_id = ${orgId} and execution.profile_id = ${profileId}
         and (batch.tag ~ '^write-[0-9]+$' or batch.tag like 'write-fixture-%')
    `;
    callByWriteRow.clear();
    await database.sql`
      update public.ad_profiles
         set amazon_profile_id = ${amazonProfileId}, connection_id = ${connectionId},
             region = ${profileRegion}::public.ads_region
       where org_id = ${orgId} and id = ${profileId}
    `;
    await database.sql`
      update public.keywords set bid = 0.90, synced_at = ${APPROVED_AT}
       where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'kw-1'
    `;
    await database.sql`
      update public.targets set bid = 0.60, synced_at = ${APPROVED_AT}
       where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'tg-1'
    `;
    await database.sql`
      update public.campaigns
         set bidding_strategy = 'auto_for_sales',
             placement_bidding = '{"topOfSearch":20,"productPages":5,"restOfSearch":0}'::jsonb,
             campaign_write_context = '{"strategy":"auto_for_sales","placementBidding":[{"placement":"PLACEMENT_PRODUCT_PAGE","percentage":5},{"placement":"PLACEMENT_REST_OF_SEARCH","percentage":0},{"placement":"PLACEMENT_TOP","percentage":20}],"shopperCohortBidding":null,"offAmazonSettings":null}'::jsonb,
             synced_at = ${APPROVED_AT}
       where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'c-1'
    `;
  });

  async function createBatch(rows: Array<{
    entityType: 'keyword' | 'target' | 'placement';
    entityId: string;
    field: string;
    oldValue: number;
    newValue: number;
  }>) {
    sequence += 1;
    const artifact = sha(serializeApplyRows(rows.map((row) => ({
      entityType: row.entityType,
      entityId: row.entityId,
      field: row.field,
      old: row.oldValue,
      new: row.newValue,
    }))));
    const [batch] = await database.sql<{ id: string }[]>`
      insert into public.apply_batches
        (org_id, profile_id, tag, opt_group, lever, note, artifact_sha256,
         exported_proposals, reversible_rows, unsupported_rows)
      values (${orgId}, ${profileId}, ${`write-${sequence}`}, 'rank', 'push', 'synthetic',
              ${artifact}, ${rows.length}, ${rows.length}, 0)
      returning id
    `;
    if (!batch) throw new Error('batch fixture failed');
    for (const row of rows) {
      await database.sql`
        insert into public.apply_rows
          (batch_id, org_id, profile_id, entity_type, entity_id, field, old_value, new_value)
        values (${batch.id}, ${orgId}, ${profileId}, ${row.entityType}, ${row.entityId},
                ${row.field}, ${JSON.stringify(row.oldValue)}::jsonb,
                ${JSON.stringify(row.newValue)}::jsonb)
      `;
    }
    return { batchId: batch.id, artifact };
  }

  async function approve(
    batchId: string,
    artifact: string,
    expectedCount: number,
    authorizationId = AUTHORIZATION_ID,
  ) {
    return asUser(database, USER_ID, (sql) => approveAmazonWriteExecution(database, { sql }, {
      orgId,
      profileId,
      applyBatchId: batchId,
      approvalMode: 'bounded_live_test',
      expiresAt: EXPIRES_AT,
      previewSha256: artifact,
      expectedCount,
      authorizationId,
      authorizationSha256: authorizationSha256(authorizationId),
      authorizationSnapshot: authorizationSnapshot(authorizationId),
      inversePreapproved: true,
    }));
  }

  async function prepare(
    executionId: string,
    now = new Date(),
    dispatchLeaseToken = DISPATCH_TOKEN,
    authorizationId = AUTHORIZATION_ID,
  ) {
    return prepareAmazonWriteExecution(database, {
      orgId,
      profileId,
      executionId,
      now,
      maxConcurrentMutations: 1,
      authorizationId,
      authorizationSha256: authorizationSha256(authorizationId),
      maxRowsPerExecution: 100,
      maxTotalExecutions: 100,
      amazonProfileId,
      connectionId,
      region: profileRegion,
      dispatchLeaseToken,
      dispatchLeaseExpiresAt: new Date(Date.now() + 300_000),
    });
  }

  async function dispatch(
    executionId: string,
    rowIds: readonly string[],
    dispatchToken = DISPATCH_TOKEN,
    authorizationId = AUTHORIZATION_ID,
    authorizationFingerprint = authorizationSha256(),
  ) {
    const stored = await database.sql<{ id: string; action: AmazonWriteAction }[]>`
      select id, action from public.amazon_write_rows where id = any(${[...rowIds]}::uuid[])
    `;
    const operations = new Set(stored.map((row) => row.action.actionType));
    if (stored.length !== rowIds.length || operations.size !== 1) {
      throw new Error('test dispatch must contain one provider operation');
    }
    const providerOperation = [...operations][0];
    if (!providerOperation) throw new Error('test dispatch has no provider operation');
    const callId = randomUUID();
    const requestedEntityIds = [...new Set(stored.map((row) => row.action.amazonEntityId))];
    await recordAmazonWritePredispatchObservations(database, {
      orgId,
      profileId,
      executionId,
      leaseToken: dispatchToken,
      callId,
      observedAt: new Date(),
      observations: stored.map((row) => ({
        writeRowId: row.id,
        currentValue: row.action.expectedValue,
        providerState: row.action.actionType === 'sp_campaign_placement'
          ? row.action.campaignContext.providerState
          : null,
      })),
    });
    await markAmazonWriteRowsDispatched(database, {
      orgId,
      profileId,
      executionId,
      leaseToken: dispatchToken,
      rowIds,
      callId,
      providerOperation,
      requestFingerprint: providerCallFingerprint({
        executionId,
        callId,
        providerOperation,
        requestedEntityIds,
        actions: stored.map((row) => row.action),
      }),
      requestedEntityIds,
      authorizationId,
      authorizationSha256: authorizationFingerprint,
      amazonProfileId,
      connectionId,
      region: profileRegion,
      leaseExpiresAt: new Date(Date.now() + 120_000),
      minimumExecutionExpiresAt: new Date(Date.now() + 4 * 60 * 60_000),
    });
    rowIds.forEach((rowId) => callByWriteRow.set(rowId, callId));
    return callId;
  }

  async function recordOutcomes(
    input: Omit<Parameters<typeof recordAmazonWriteOutcomes>[1], 'callId' | 'callEvidence' | 'apiCallCount'>,
  ) {
    const callIds = new Set(input.outcomes.map((outcome) => callByWriteRow.get(outcome.writeRowId)));
    if (callIds.size !== 1 || callIds.has(undefined)) throw new Error('outcomes lack one test provider call');
    const callId = [...callIds][0] as string;
    const [dispatchEvent] = await database.sql<{ requested_count: number }[]>`
      select requested_count from public.amazon_write_provider_call_events
       where call_id = ${callId} and event_type = 'dispatch'
    `;
    if (!dispatchEvent) throw new Error('test provider call is missing');
    const hasAmbiguous = input.outcomes.some((row) => row.evidence.outcome === 'ambiguous');
    const acceptedRows = input.outcomes.filter((row) => row.evidence.outcome === 'accepted').length;
    const accepted = hasAmbiguous ? 0 : Math.min(dispatchEvent.requested_count, acceptedRows);
    const failed = hasAmbiguous ? 0 : dispatchEvent.requested_count - accepted;
    const callEvidence: AmazonWriteProviderCallEvidence = {
      outcome: hasAmbiguous ? 'ambiguous'
        : accepted === dispatchEvent.requested_count ? 'accepted'
          : accepted > 0 ? 'mixed' : 'rejected',
      requested: dispatchEvent.requested_count,
      accepted,
      failed,
      code: null,
      message: null,
    };
    const stored = await database.sql<{ id: string; action: AmazonWriteAction }[]>`
      select id, action from public.amazon_write_rows
       where execution_id = ${input.executionId}
         and id = any(${input.outcomes.map((outcome) => outcome.writeRowId)}::uuid[])
    `;
    const actionById = new Map(stored.map((row) => [row.id, row.action] as const));
    return recordAmazonWriteOutcomes(database, {
      ...input,
      callId,
      callEvidence,
      apiCallCount: 1,
      outcomes: input.outcomes.map((outcome) => ({
        ...outcome,
        requestFingerprint: sha(serializeAmazonWriteAttemptFingerprint({
          executionId: input.executionId,
          callId,
          writeRowId: outcome.writeRowId,
          attemptNumber: outcome.attemptNumber,
          action: actionById.get(outcome.writeRowId)!,
        })),
      })),
    });
  }

  function observationGeneration(writeRowId: string): string {
    const generation = callByWriteRow.get(writeRowId);
    if (!generation) throw new Error('observation row lacks a test provider call generation');
    return generation;
  }

  async function releaseForRetry(input: {
    orgId: string; profileId: string; executionId: string; leaseToken: string; rowIds: readonly string[];
  }) {
    const callId = callByWriteRow.get(input.rowIds[0] ?? '');
    if (!callId) throw new Error('retry rows lack a test provider call');
    const [event] = await database.sql<{ requested_count: number }[]>`
      select requested_count from public.amazon_write_provider_call_events
       where call_id = ${callId} and event_type = 'dispatch'
    `;
    if (!event) throw new Error('retry provider call is missing');
    return releaseAmazonWriteExecutionForRetry(database, {
      ...input,
      callId,
      apiCallCount: 1,
      callEvidence: {
        outcome: 'throttled', requested: event.requested_count,
        accepted: 0, failed: 0, code: 'THROTTLED', message: 'synthetic throttle',
      },
    });
  }

  it('materializes immutable bid actions once and replays them in artifact order without duplicates', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
      { entityType: 'target', entityId: 'tg-1', field: 'bid', oldValue: 0.6, newValue: 0.61 },
    ]);
    const first = await approve(batch.batchId, batch.artifact, 2);
    const replay = await approve(batch.batchId, batch.artifact, 2);
    expect(first).toMatchObject({ requested: 2, replayed: false });
    expect(first.actions).toEqual([
      expect.objectContaining({
        actionType: 'sp_keyword_bid', expectedValue: 0.9,
        requestedValue: 0.91, inverseValue: 0.9,
      }),
      expect.objectContaining({
        actionType: 'sp_target_bid', expectedValue: 0.6,
        requestedValue: 0.61, inverseValue: 0.6,
      }),
    ]);
    expect(replay).toMatchObject({ executionId: first.executionId, replayed: true });
    expect(replay.actions).toEqual(first.actions);
    const [counts] = await database.sql<{ approvals: number; executions: number; rows: number }[]>`
      select
        (select count(*)::int from public.amazon_write_approvals where apply_batch_id = ${batch.batchId}) as approvals,
        (select count(*)::int from public.amazon_write_executions where apply_batch_id = ${batch.batchId}) as executions,
        (select count(*)::int from public.amazon_write_rows where execution_id = ${first.executionId}) as rows
    `;
    expect(counts).toEqual({ approvals: 1, executions: 1, rows: 2 });
  });

  it('derives replay identity from every immutable tenant and approval input', () => {
    const base = {
      orgId,
      profileId,
      applyBatchId: '33333333-3333-4333-8333-333333333333',
      approvalMode: 'manual' as const,
      expiresAt: EXPIRES_AT,
      previewSha256: sha('preview'),
      expectedCount: 1,
      authorizationId: null,
      authorizationSha256: null,
      authorizationSnapshot: null,
      inversePreapproved: false,
    };
    const key = amazonWriteExecutionIdempotencyKey(base, USER_ID);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(amazonWriteExecutionIdempotencyKey(base, AUTHORIZATION_ID)).not.toBe(key);
    expect(amazonWriteExecutionIdempotencyKey({ ...base, profileId: USER_ID }, USER_ID)).not.toBe(key);
    expect(amazonWriteExecutionIdempotencyKey({ ...base, expiresAt: '2026-08-31T12:00:00.000Z' }, USER_ID)).not.toBe(key);
    expect(amazonWriteExecutionIdempotencyKey({ ...base, previewSha256: sha('changed') }, USER_ID)).not.toBe(key);
  });

  it('refuses approval when synchronized state drifted and records no execution', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.8, newValue: 0.81 },
    ]);
    await expect(approve(batch.batchId, batch.artifact, 1)).rejects.toThrow(/no longer matches/i);
    const [count] = await database.sql<{ count: number }[]>`
      select count(*)::int as count from public.amazon_write_executions where apply_batch_id = ${batch.batchId}
    `;
    expect(count?.count).toBe(0);
  });

  it.each([
    ['keyword' as const, 'kw-1', 0.901, 0.914],
    ['target' as const, 'tg-1', 0.601, 0.604],
  ])('refuses fractional-cent %s actions before an execution exists', async (
    entityType,
    entityId,
    oldValue,
    newValue,
  ) => {
    if (entityType === 'keyword') {
      await database.sql`
        update public.keywords set bid = ${oldValue}
         where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = ${entityId}
      `;
    } else {
      await database.sql`
        update public.targets set bid = ${oldValue}
         where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = ${entityId}
      `;
    }
    const batch = await createBatch([{ entityType, entityId, field: 'bid', oldValue, newValue }]);
    await expect(approve(batch.batchId, batch.artifact, 1)).rejects.toThrow(/currency-minor-unit/i);
    const [count] = await database.sql<{ count: number }[]>`
      select count(*)::int as count from public.amazon_write_executions
       where apply_batch_id = ${batch.batchId}
    `;
    expect(count?.count).toBe(0);
  });

  it('recomputes the canonical artifact from locked rows before approval', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    await database.sql`
      update public.apply_rows set new_value = '0.92'::jsonb where batch_id = ${batch.batchId}
    `;
    await expect(approve(batch.batchId, batch.artifact, 1)).rejects.toThrow(/locked rows/i);
    const [count] = await database.sql<{ count: number }[]>`
      select count(*)::int as count from public.amazon_write_approvals
       where apply_batch_id = ${batch.batchId}
    `;
    expect(count?.count).toBe(0);
  });

  it('requires an owner or admin of the exact organization to approve', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    await expect(asUser(database, '99999999-9999-4999-8999-999999999999', (sql) =>
      approveAmazonWriteExecution(database, { sql }, {
        orgId, profileId, applyBatchId: batch.batchId,
        approvalMode: 'bounded_live_test', expiresAt: EXPIRES_AT,
        previewSha256: batch.artifact, expectedCount: 1,
        authorizationId: AUTHORIZATION_ID, authorizationSha256: authorizationSha256(),
        authorizationSnapshot: authorizationSnapshot(),
        inversePreapproved: true,
      }),
    )).rejects.toThrow(/owner or admin/i);
  });

  it('derives the approver from the authenticated session and rejects a spoofed admin field', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const request = {
      orgId, profileId, applyBatchId: batch.batchId,
      approvalMode: 'bounded_live_test' as const, expiresAt: EXPIRES_AT,
      previewSha256: batch.artifact, expectedCount: 1,
      authorizationId: AUTHORIZATION_ID, authorizationSha256: authorizationSha256(),
      authorizationSnapshot: authorizationSnapshot(),
      inversePreapproved: true,
    };
    await expect(asUser(database, USER_ID, (sql) => approveAmazonWriteExecution(
      database,
      { sql },
      { ...request, approvedBy: ADMIN_ID } as unknown as typeof request,
    ))).rejects.toThrow();
    const approved = await asUser(database, USER_ID, (sql) =>
      approveAmazonWriteExecution(database, { sql }, request));
    const [stored] = await database.sql<{ approved_by: string }[]>`
      select approval.approved_by
        from public.amazon_write_approvals approval
        join public.amazon_write_executions execution on execution.approval_id = approval.id
       where execution.id = ${approved.executionId}
    `;
    expect(stored?.approved_by).toBe(USER_ID);
  });

  it('freezes approved artifact provenance and reserves lifecycle transitions for the worker', async () => {
    const batch = await createBatch([
      { entityType: 'target', entityId: 'tg-1', field: 'bid', oldValue: 0.6, newValue: 0.61 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 1);
    await expect(database.sql`
      update public.apply_rows set new_value = '0.62'::jsonb where batch_id = ${batch.batchId}
    `).rejects.toThrow(/immutable/i);
    const unapproved = await createBatch([
      { entityType: 'target', entityId: 'tg-1', field: 'bid', oldValue: 0.6, newValue: 0.61 },
    ]);
    await expect(database.sql`
      update public.apply_rows set batch_id = ${unapproved.batchId} where batch_id = ${batch.batchId}
    `).rejects.toThrow(/immutable/i);
    await expect(database.sql`
      update public.apply_batches set artifact_sha256 = ${sha('changed')} where id = ${batch.batchId}
    `).rejects.toThrow(/immutable/i);
    await expect(database.sql`
      update public.apply_batches set note = 'changed provenance' where id = ${batch.batchId}
    `).rejects.toThrow(/immutable/i);
    await expect(asUser(database, USER_ID, (sql) => sql`
      update public.apply_batches set status = 'abandoned' where id = ${batch.batchId}
    `)).rejects.toThrow(/service-role only/i);
    await expect(database.sql`
      update public.amazon_write_executions set requested_count = 2
       where id = ${approved.executionId}
    `).rejects.toThrow(/immutable/i);
    await expect(database.sql`
      update public.amazon_write_rows set requested_value = '0.62'::jsonb
       where execution_id = ${approved.executionId}
    `).rejects.toThrow(/immutable/i);
    const updated = await database.sql`
      update public.apply_batches set updated_at = now() where id = ${batch.batchId} returning id
    `;
    expect(updated).toHaveLength(1);
    const [snapshot] = await database.sql<{ authorization_snapshot: unknown }[]>`
      select approval.authorization_snapshot
        from public.amazon_write_approvals approval
        join public.amazon_write_executions execution on execution.approval_id = approval.id
       where execution.id = ${approved.executionId}
    `;
    expect(BoundedAmazonWriteAuthorization.parse(snapshot?.authorization_snapshot))
      .toEqual(authorizationSnapshot());
  });

  it('does not attribute an external exact-new sync to a gateway batch before dispatch', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 1);
    const observedAt = new Date();
    await database.sql`
      update public.keywords set bid = 0.91, synced_at = ${observedAt.toISOString()}
       where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'kw-1'
    `;
    const recorded = await recordEntityChanges(database, [{
      orgId,
      profileId,
      entityType: 'keyword',
      amazonId: 'kw-1',
      field: 'bid',
      oldValue: 0.9,
      newValue: 0.91,
      source: 'sync',
      observedAt,
    }]);
    expect(recorded).toBe(1);
    const [state] = await database.sql<{
      batch_status: string; linked: number; provider_calls: number;
    }[]>`
      select batch.status::text as batch_status,
             (select count(*)::int from public.entity_changes change
               where change.apply_batch_id = batch.id) as linked,
             (select count(*)::int from public.amazon_write_provider_call_events call
               where call.execution_id = ${approved.executionId}) as provider_calls
        from public.apply_batches batch where batch.id = ${batch.batchId}
    `;
    expect(state).toEqual({ batch_status: 'staged', linked: 0, provider_calls: 0 });
    const prepared = await prepare(approved.executionId);
    expect(prepared).toMatchObject({ status: 'refused', rows: [] });
  });

  it('never attributes ordinary sync to a gateway batch after durable dispatch', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 1);
    const prepared = await prepare(approved.executionId);
    const row = prepared.rows[0];
    if (!row) throw new Error('expected gateway row');
    await dispatch(approved.executionId, [row.writeRowId]);
    const observedAt = new Date();
    await database.sql`update public.keywords set bid = 0.91, synced_at = ${observedAt.toISOString()}
      where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'kw-1'`;
    await recordEntityChanges(database, [{
      orgId, profileId, entityType: 'keyword', amazonId: 'kw-1', field: 'bid',
      oldValue: 0.9, newValue: 0.91, source: 'sync', observedAt,
    }]);
    const [state] = await database.sql<{ status: string; linked: number }[]>`
      select batch.status::text as status,
        (select count(*)::int from public.entity_changes change
          where change.apply_batch_id = batch.id) as linked
      from public.apply_batches batch where batch.id = ${batch.batchId}
    `;
    expect(state).toEqual({ status: 'staged', linked: 0 });
    await recordOutcomes({
      orgId, profileId, executionId: approved.executionId, attemptedAt: new Date(),
      outcomes: [{ writeRowId: row.writeRowId, attemptNumber: row.attemptNumber,
        requestFingerprint: sha('synthetic post-dispatch cleanup'),
        evidence: { outcome: 'failed', providerEntityId: 'kw-1', code: 'SYNTHETIC', message: 'cleanup' } }],
    });
  });

  it('accounts partial provider success and keeps every attempt append-only', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
      { entityType: 'target', entityId: 'tg-1', field: 'bid', oldValue: 0.6, newValue: 0.61 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 2);
    const prepared = await prepare(approved.executionId);
    const keyword = prepared.rows.find((row) => row.action.actionType === 'sp_keyword_bid');
    const target = prepared.rows.find((row) => row.action.actionType === 'sp_target_bid');
    if (!keyword || !target) throw new Error('expected two prepared rows');
    const keywordCallId = await dispatch(approved.executionId, [keyword.writeRowId]);
    await expect(getAmazonWriteProviderCallAccounting(database, {
      orgId, profileId, executionId: approved.executionId,
    })).resolves.toEqual({
      intendedCalls: 1, possibleUnknownCalls: 1, provenApiCalls: 0,
    });
    await expect(recordAmazonWriteOutcomes(database, {
      orgId, profileId, executionId: approved.executionId,
      callId: keywordCallId,
      callEvidence: {
        outcome: 'accepted', requested: 1, accepted: 1, failed: 0,
        code: null, message: null,
      },
      apiCallCount: 1,
      attemptedAt: new Date(APPROVED_AT),
      outcomes: [{
        writeRowId: keyword.writeRowId, attemptNumber: 1,
        requestFingerprint: sha('forged-provider-call-fingerprint'),
        evidence: { outcome: 'accepted', providerEntityId: 'kw-1', code: null, message: null },
      }],
    })).rejects.toThrow(/fingerprint/i);
    await expect(recordAmazonWriteOutcomes(database, {
      orgId, profileId, executionId: approved.executionId,
      callId: keywordCallId,
      callEvidence: {
        outcome: 'accepted', requested: 1, accepted: 1, failed: 0,
        code: null, message: null,
      },
      apiCallCount: 1,
      attemptedAt: new Date(APPROVED_AT),
      outcomes: [{
        writeRowId: keyword.writeRowId, attemptNumber: 1,
        requestFingerprint: sha(serializeAmazonWriteAttemptFingerprint({
          executionId: approved.executionId,
          callId: keywordCallId,
          writeRowId: keyword.writeRowId,
          attemptNumber: 1,
          action: keyword.action,
        })),
        evidence: { outcome: 'accepted', providerEntityId: 'another-keyword', code: null, message: null },
      }],
    })).rejects.toThrow(/provider identity/i);
    await recordOutcomes({
      orgId, profileId, executionId: approved.executionId,
      attemptedAt: new Date(APPROVED_AT),
      outcomes: [{
          writeRowId: keyword.writeRowId, attemptNumber: 1,
          requestFingerprint: sha('attempt-keyword'),
          evidence: { outcome: 'accepted', providerEntityId: 'kw-1', code: null, message: null },
        }],
    });
    await dispatch(approved.executionId, [target.writeRowId]);
    const result = await recordOutcomes({
      orgId, profileId, executionId: approved.executionId,
      attemptedAt: new Date(APPROVED_AT),
      outcomes: [{
          writeRowId: target.writeRowId, attemptNumber: 1,
          requestFingerprint: sha('attempt-target'),
          evidence: { outcome: 'failed', providerEntityId: null, code: 'INVALID_ARGUMENT', message: 'synthetic rejection' },
        }],
    });
    expect(result).toMatchObject({
      status: 'awaiting_sync',
      accounting: { requested: 2, attempted: 2, succeeded: 1, failed: 1, refused: 0, resyncRequested: 1 },
    });
    const [providerCalls] = await database.sql<{ events: number; api_calls: number }[]>`
      select count(*)::int as events, sum(api_call_count)::int as api_calls
        from public.amazon_write_provider_call_events
       where execution_id = ${approved.executionId}
    `;
    expect(providerCalls).toEqual({ events: 4, api_calls: 2 });
    await expect(getAmazonWriteProviderCallAccounting(database, {
      orgId, profileId, executionId: approved.executionId,
    })).resolves.toEqual({
      intendedCalls: 2, possibleUnknownCalls: 0, provenApiCalls: 2,
    });
    await expect(database.sql`
      update public.amazon_write_provider_call_events set outcome = 'ambiguous'
       where execution_id = ${approved.executionId}
    `).rejects.toThrow(/immutable/i);
    await expect(database.sql`
      update public.amazon_write_attempts set outcome = 'failed'
       where execution_id = ${approved.executionId}
    `).rejects.toThrow(/immutable/i);
    await database.sql`
      update public.keywords set bid = 0.91, synced_at = '2026-08-29T12:01:00.000Z'
       where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'kw-1'
    `;
    const settled = await recordAmazonWriteObservations(database, {
      orgId, profileId, executionId: approved.executionId,
      generation: observationGeneration(keyword.writeRowId),
      nextObservationAt: new Date(Date.now() + 60_000),
      observedAt: new Date('2026-08-29T12:01:00.000Z'), attempt: 0,
      observations: [{ writeRowId: keyword.writeRowId, state: 'observed', currentValue: 0.91 }],
    });
    expect(settled).toMatchObject({
      status: 'partial', inverseReady: true,
      accounting: { succeeded: 1, failed: 1, ambiguous: 0, resynchronized: 1 },
    });
    expect(settled.inverseExecutionId).toMatch(/^[a-f0-9-]{36}$/);
    const inverseRows = await database.sql<{ action: { actionType: string; amazonEntityId: string; expectedValue: number; requestedValue: number } }[]>`
      select write_row.action from public.amazon_write_rows write_row
      join public.amazon_write_executions execution on execution.id = write_row.execution_id
      where execution.source_execution_id = ${approved.executionId}
    `;
    expect(inverseRows.map((row) => row.action)).toEqual([expect.objectContaining({
      actionType: 'sp_keyword_bid', amazonEntityId: 'kw-1',
      expectedValue: 0.91, requestedValue: 0.9,
    })]);

    const inverseExecutionId = settled.inverseExecutionId;
    if (inverseExecutionId === null) throw new Error('partial success inverse was not materialized');
    await database.sql`
      update public.org_members set role = 'analyst'
       where org_id = ${orgId} and user_id = ${USER_ID}
    `;
    const inverseToken = randomUUID();
    const inversePrepared = await prepare(inverseExecutionId, new Date(), inverseToken);
    const inverseRow = inversePrepared.rows[0];
    if (!inverseRow) throw new Error('partial success inverse has no row');
    await dispatch(inverseExecutionId, [inverseRow.writeRowId], inverseToken);
    await recordOutcomes({
      orgId, profileId, executionId: inverseExecutionId, attemptedAt: new Date(),
      outcomes: [{
        writeRowId: inverseRow.writeRowId,
        attemptNumber: inverseRow.attemptNumber,
        requestFingerprint: sha(`partial-inverse-${inverseExecutionId}`),
        evidence: { outcome: 'accepted', providerEntityId: 'kw-1', code: null, message: null },
      }],
    });
    await database.sql`
      update public.keywords set bid = 0.9, synced_at = now()
       where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'kw-1'
    `;
    const inverseSettled = await recordAmazonWriteObservations(database, {
      orgId, profileId, executionId: inverseExecutionId,
      generation: observationGeneration(inverseRow.writeRowId),
      nextObservationAt: new Date(Date.now() + 60_000),
      observedAt: new Date(), attempt: 0,
      observations: [{ writeRowId: inverseRow.writeRowId, state: 'observed', currentValue: 0.9 }],
    });
    expect(inverseSettled).toMatchObject({ status: 'succeeded', inverseReady: true });
    const [partialLifecycle] = await database.sql<{ source_status: string; inverse_status: string }[]>`
      select source.status::text as source_status, inverse.status::text as inverse_status
        from public.amazon_write_executions execution
        join public.apply_batches inverse on inverse.id = execution.apply_batch_id
        join public.apply_batches source on source.id = inverse.source_batch_id
       where execution.id = ${inverseExecutionId}
    `;
    expect(partialLifecycle).toEqual({ source_status: 'reverted', inverse_status: 'applied' });

    const evidenceCounts = async () => {
      const [counts] = await database.sql<{
        approvals: number; attempts: number; provider_events: number;
      }[]>`
        select
          (select count(*)::int from public.amazon_write_approvals
            where id in (select approval_id from public.amazon_write_executions
              where id = ${approved.executionId})) as approvals,
          (select count(*)::int from public.amazon_write_attempts
            where execution_id = ${approved.executionId}) as attempts,
          (select count(*)::int from public.amazon_write_provider_call_events
            where execution_id = ${approved.executionId}) as provider_events
      `;
      return counts;
    };
    const beforeDeletion = await evidenceCounts();
    await expect(database.sql`
      delete from public.amazon_write_approvals
       where id in (select approval_id from public.amazon_write_executions
         where id = ${approved.executionId})
    `).rejects.toThrow(/immutable/i);
    await expect(database.sql`
      delete from public.apply_batches where id = ${batch.batchId}
    `).rejects.toThrow();
    await expect(database.sql`
      delete from public.ad_profiles where org_id = ${orgId} and id = ${profileId}
    `).rejects.toThrow();
    await expect(database.sql`
      delete from public.orgs where id = ${orgId}
    `).rejects.toThrow();
    expect(await evidenceCounts()).toEqual(beforeDeletion);
  });

  it('wakes the next queued cycle after a partial predecessor made no Amazon changes', async () => {
    const firstBatch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
      { entityType: 'target', entityId: 'tg-1', field: 'bid', oldValue: 0.6, newValue: 0.61 },
    ]);
    const first = await approve(firstBatch.batchId, firstBatch.artifact, 2);
    const secondBatch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const second = await approve(secondBatch.batchId, secondBatch.artifact, 1);
    await database.sql`
      update public.sync_jobs set status = 'dead', attempts = max_attempts, finished_at = now()
       where job_type = 'amazon.apply' and payload->>'executionId' = ${second.executionId}
    `;

    const prepared = await prepare(first.executionId);
    const failedRow = prepared.rows.find((row) => row.action.actionType === 'sp_keyword_bid');
    if (!failedRow) throw new Error('partial predecessor has no failed row');
    await dispatch(first.executionId, [failedRow.writeRowId]);
    await recordOutcomes({
      orgId, profileId, executionId: first.executionId, attemptedAt: new Date(),
      outcomes: [{
        writeRowId: failedRow.writeRowId,
        attemptNumber: failedRow.attemptNumber,
        requestFingerprint: sha('partial-zero-success'),
        evidence: {
          outcome: 'failed', providerEntityId: null,
          code: 'INVALID_ARGUMENT', message: 'synthetic deterministic failure',
        },
      }],
    });
    const accounting = await refuseAmazonWriteExecution(database, {
      orgId, profileId, executionId: first.executionId,
      reason: 'remaining group refused after deterministic failure',
    });
    expect(accounting).toMatchObject({ succeeded: 0, failed: 1, refused: 1 });
    const [state] = await database.sql<{ status: string; successor_jobs: number }[]>`
      select execution.status::text as status,
             (select count(*)::int from public.sync_jobs job
               where job.job_type = 'amazon.apply'
                 and job.payload->>'executionId' = ${second.executionId}
                 and job.status = 'queued') as successor_jobs
        from public.amazon_write_executions execution where execution.id = ${first.executionId}
    `;
    expect(state).toEqual({ status: 'partial', successor_jobs: 1 });
  });

  it('persists one mixed provider-call result for a partial multi-status response', async () => {
    const secondKeyword = `kw-mixed-${sequence + 1}`;
    await database.sql`
      insert into public.keywords
        (org_id, profile_id, amazon_id, ad_product, state, campaign_id, ad_group_id,
         keyword_text, match_type, bid, synced_at)
      values (${orgId}, ${profileId}, ${secondKeyword}, 'SP', 'enabled', 'c-1', 'ag-1',
              'synthetic second keyword', 'exact', 0.80, ${APPROVED_AT})
    `;
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
      { entityType: 'keyword', entityId: secondKeyword, field: 'bid', oldValue: 0.8, newValue: 0.81 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 2);
    const prepared = await prepare(approved.executionId);
    const callId = await dispatch(approved.executionId, prepared.rows.map((row) => row.writeRowId));
    const result = await recordOutcomes({
      orgId, profileId, executionId: approved.executionId,
      attemptedAt: new Date(APPROVED_AT),
      outcomes: prepared.rows.map((row, index) => ({
        writeRowId: row.writeRowId,
        attemptNumber: row.attemptNumber,
        requestFingerprint: sha(`mixed-provider-result-${index}`),
        evidence: index === 0
          ? { outcome: 'accepted' as const, providerEntityId: 'kw-1', code: null, message: null }
          : { outcome: 'failed' as const, providerEntityId: null, code: 'INVALID_ARGUMENT', message: 'synthetic' },
      })),
    });
    expect(result).toMatchObject({
      status: 'awaiting_sync', accounting: { attempted: 2, succeeded: 1, failed: 1 },
    });
    const [event] = await database.sql<{
      outcome: string; requested_count: number; accepted_count: number; failed_count: number;
    }[]>`
      select outcome::text as outcome, requested_count, accepted_count, failed_count
        from public.amazon_write_provider_call_events
       where call_id = ${callId} and event_type = 'result'
    `;
    expect(event).toEqual({
      outcome: 'mixed', requested_count: 2, accepted_count: 1, failed_count: 1,
    });
  });

  it('rejects a provider result that omits any row in its durable dispatch membership', async () => {
    const secondKeyword = `kw-membership-${sequence + 1}`;
    await database.sql`
      insert into public.keywords
        (org_id, profile_id, amazon_id, ad_product, state, campaign_id, ad_group_id,
         keyword_text, match_type, bid, synced_at)
      values (${orgId}, ${profileId}, ${secondKeyword}, 'SP', 'enabled', 'c-1', 'ag-1',
              'synthetic membership keyword', 'exact', 0.80, ${APPROVED_AT})
    `;
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
      { entityType: 'keyword', entityId: secondKeyword, field: 'bid', oldValue: 0.8, newValue: 0.81 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 2);
    const prepared = await prepare(approved.executionId);
    const callId = await dispatch(approved.executionId, prepared.rows.map((row) => row.writeRowId));
    const first = prepared.rows[0]!;

    await expect(recordAmazonWriteOutcomes(database, {
      orgId, profileId, executionId: approved.executionId, callId,
      callEvidence: {
        outcome: 'accepted', requested: 2, accepted: 2, failed: 0,
        code: null, message: null,
      },
      apiCallCount: 1,
      attemptedAt: new Date(),
      outcomes: [{
        writeRowId: first.writeRowId,
        attemptNumber: first.attemptNumber,
        requestFingerprint: sha(serializeAmazonWriteAttemptFingerprint({
          executionId: approved.executionId,
          callId,
          writeRowId: first.writeRowId,
          attemptNumber: first.attemptNumber,
          action: first.action,
        })),
        evidence: {
          outcome: 'accepted', providerEntityId: first.action.amazonEntityId,
          code: null, message: null,
        },
      }],
    })).rejects.toThrow(/every row/i);
  });

  it('refuses every unresolved row when state drifts after approval but before execution', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 1);
    await database.sql`
      update public.keywords set bid = 0.95, synced_at = '2026-08-29T12:00:30.000Z'
       where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'kw-1'
    `;
    const prepared = await prepare(approved.executionId, new Date(Date.now() + 30_000));
    expect(prepared).toMatchObject({ status: 'refused', rows: [], replayed: false });
    const [counts] = await database.sql<{
      attempted_count: number; refused_count: number; attempt_rows: number;
    }[]>`
      select execution.attempted_count, execution.refused_count,
             (select count(*)::int from public.amazon_write_attempts attempt
               where attempt.execution_id = execution.id) as attempt_rows
        from public.amazon_write_executions execution
       where execution.id = ${approved.executionId}
    `;
    expect(counts).toEqual({ attempted_count: 0, refused_count: 1, attempt_rows: 0 });
  });

  it('binds approval to the exact external Amazon advertiser identity', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 1);
    await expect(database.sql`
      update public.ad_profiles
         set amazon_profile_id = 'synthetic-rebound-profile'
       where org_id = ${orgId} and id = ${profileId}
    `).rejects.toThrow(/route is frozen/i);
    await expect(database.sql`
      update public.ad_profiles set connection_id = null
       where org_id = ${orgId} and id = ${profileId}
    `).rejects.toThrow(/route is frozen/i);
    await expect(database.sql`
      delete from public.ads_connections where id = ${connectionId}
    `).rejects.toThrow(/route is frozen/i);
    const prepared = await prepare(approved.executionId);
    expect(prepared.rows).toHaveLength(1);
    await refuseAmazonWriteExecution(database, {
      orgId, profileId, executionId: approved.executionId, reason: 'synthetic cleanup',
    });
  });

  it('blocks a forward after approver revocation at prepare and final dispatch', async () => {
    const firstBatch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const firstApproval = await approve(firstBatch.batchId, firstBatch.artifact, 1);
    await database.sql`
      update public.org_members set role = 'analyst'
       where org_id = ${orgId} and user_id = ${USER_ID}
    `;
    const refusedAtPrepare = await prepare(firstApproval.executionId);
    expect(refusedAtPrepare).toMatchObject({ status: 'refused', rows: [] });

    await database.sql`
      update public.org_members set role = 'owner'
       where org_id = ${orgId} and user_id = ${USER_ID}
    `;
    const secondBatch = await createBatch([
      { entityType: 'target', entityId: 'tg-1', field: 'bid', oldValue: 0.6, newValue: 0.61 },
    ]);
    const secondApproval = await approve(secondBatch.batchId, secondBatch.artifact, 1);
    const secondPrepared = await prepare(secondApproval.executionId);
    const secondRow = secondPrepared.rows[0]!;
    await database.sql`
      delete from public.org_members where org_id = ${orgId} and user_id = ${USER_ID}
    `;
    const dispatched = await markAmazonWriteRowsDispatched(database, {
      orgId, profileId, executionId: secondApproval.executionId,
      leaseToken: DISPATCH_TOKEN,
      rowIds: [secondRow.writeRowId],
      callId: randomUUID(),
      providerOperation: 'sp_target_bid',
      requestFingerprint: sha('revoked-final-dispatch'),
      requestedEntityIds: ['tg-1'],
      authorizationId: AUTHORIZATION_ID,
      authorizationSha256: authorizationSha256(),
      amazonProfileId,
      connectionId,
      region: profileRegion,
      leaseExpiresAt: new Date(Date.now() + 120_000),
      minimumExecutionExpiresAt: new Date(Date.now() + 4 * 60 * 60_000),
    });
    expect(dispatched).toBe(false);
    const [evidence] = await database.sql<{ calls: number; status: string }[]>`
      select (select count(*)::int from public.amazon_write_provider_call_events
               where execution_id = execution.id) as calls,
             execution.status::text as status
        from public.amazon_write_executions execution
       where execution.id = ${secondApproval.executionId}
    `;
    expect(evidence).toEqual({ calls: 0, status: 'refused' });
  });

  it('rejects a cross-tenant profile credential route before any write approval exists', async () => {
    const otherUser = randomUUID();
    const [other] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture(${`route-${sequence}`}, ${otherUser}, 'owner')
    `;
    if (!other?.seed_tenant_fixture) throw new Error('cross-tenant route fixture failed');
    const [otherConnection] = await database.sql<{ id: string }[]>`
      select id from public.ads_connections where org_id = ${other.seed_tenant_fixture} limit 1
    `;
    if (!otherConnection) throw new Error('cross-tenant route connection is missing');

    await expect(database.sql`
      update public.ad_profiles set connection_id = ${otherConnection.id}
       where org_id = ${orgId} and id = ${profileId}
    `).rejects.toThrow();
  });

  it('binds dispatch to the exact authorization fingerprint and staged batch lifecycle', async () => {
    const changed = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const changedApproval = await approve(changed.batchId, changed.artifact, 1);
    const fingerprintRefusal = await prepareAmazonWriteExecution(database, {
      orgId, profileId, executionId: changedApproval.executionId, now: new Date(),
      maxConcurrentMutations: 1, authorizationId: AUTHORIZATION_ID,
      authorizationSha256: sha('changed-authorization'), maxRowsPerExecution: 100,
      maxTotalExecutions: 100, dispatchLeaseToken: DISPATCH_TOKEN,
      amazonProfileId, connectionId, region: profileRegion,
      dispatchLeaseExpiresAt: new Date(Date.now() + 120_000),
    });
    expect(fingerprintRefusal).toMatchObject({ status: 'refused', rows: [] });

    const abandoned = await createBatch([
      { entityType: 'target', entityId: 'tg-1', field: 'bid', oldValue: 0.6, newValue: 0.61 },
    ]);
    const approved = await approve(abandoned.batchId, abandoned.artifact, 1);
    const prepared = await prepare(approved.executionId);
    const row = prepared.rows[0];
    if (!row) throw new Error('expected staged lifecycle row');
    await expect(markAmazonWriteRowsDispatched(database, {
      orgId, profileId, executionId: approved.executionId,
      leaseToken: DISPATCH_TOKEN, rowIds: [row.writeRowId],
      callId: randomUUID(), providerOperation: 'sp_target_bid',
      requestFingerprint: sha('wrong-dispatch-identity'),
      requestedEntityIds: ['another-target'],
      authorizationId: AUTHORIZATION_ID,
      authorizationSha256: authorizationSha256(),
      amazonProfileId, connectionId, region: profileRegion,
      leaseExpiresAt: new Date(Date.now() + 120_000),
      minimumExecutionExpiresAt: new Date(Date.now() + 4 * 60 * 60_000),
    })).rejects.toThrow(/entity identities/i);
    await expect(markAmazonWriteRowsDispatched(database, {
      orgId, profileId, executionId: approved.executionId,
      leaseToken: DISPATCH_TOKEN, rowIds: [row.writeRowId],
      callId: randomUUID(), providerOperation: 'sp_target_bid',
      requestFingerprint: sha('forged-provider-call-fingerprint'),
      requestedEntityIds: ['tg-1'],
      authorizationId: AUTHORIZATION_ID,
      authorizationSha256: authorizationSha256(),
      amazonProfileId, connectionId, region: profileRegion,
      leaseExpiresAt: new Date(Date.now() + 120_000),
      minimumExecutionExpiresAt: new Date(Date.now() + 4 * 60 * 60_000),
    })).rejects.toThrow(/provider call fingerprint/i);
    await database.sql`update public.apply_batches set status = 'abandoned' where id = ${abandoned.batchId}`;
    await expect(dispatch(approved.executionId, [row.writeRowId]))
      .rejects.toThrow(/final dispatch gate/i);
    const [calls] = await database.sql<{ count: number }[]>`
      select count(*)::int as count from public.amazon_write_provider_call_events
       where execution_id = ${approved.executionId}
    `;
    expect(calls?.count).toBe(0);
    await refuseAmazonWriteExecution(database, {
      orgId, profileId, executionId: approved.executionId, reason: 'synthetic cleanup',
    });
  });

  it('never dispatches a running execution twice and reopens only an explicit pre-mutation retry', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 1);
    const first = await prepare(approved.executionId);
    expect(first.rows).toHaveLength(1);
    const replay = await prepare(approved.executionId);
    expect(replay).toMatchObject({ status: 'running', rows: [], replayed: true });

    const firstRow = first.rows[0];
    if (!firstRow) throw new Error('expected retry row');
    await dispatch(approved.executionId, [firstRow.writeRowId]);
    await releaseForRetry({
      orgId, profileId, executionId: approved.executionId,
      leaseToken: DISPATCH_TOKEN,
      rowIds: [firstRow.writeRowId],
    });
    const released = await prepare(approved.executionId);
    expect(released).toMatchObject({ status: 'running', replayed: false });
    expect(released.rows).toHaveLength(1);
    expect(released.rows[0]?.attemptNumber).toBe(1);
    await refuseAmazonWriteExecution(database, {
      orgId, profileId, executionId: approved.executionId, reason: 'synthetic cleanup',
    });
  });

  it('recovers a pre-dispatch crash after lease expiry and terminally refuses a final state race', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 1);
    const firstToken = randomUUID();
    const first = await prepare(approved.executionId, new Date(), firstToken);
    const row = first.rows[0];
    if (!row) throw new Error('expected pre-dispatch crash row');

    const liveLease = await prepare(
      approved.executionId,
      new Date(Date.now() + 1_000),
      randomUUID(),
    );
    expect(liveLease).toMatchObject({
      status: 'running', rows: [], replayed: true,
      retryAfterSeconds: expect.any(Number),
    });

    const recoveryToken = randomUUID();
    const recovered = await prepare(
      approved.executionId,
      new Date(Date.now() + 301_000),
      recoveryToken,
    );
    expect(recovered.rows).toEqual([expect.objectContaining({
      writeRowId: row.writeRowId, attemptNumber: 1,
    })]);

    const callId = randomUUID();
    await recordAmazonWritePredispatchObservations(database, {
      orgId,
      profileId,
      executionId: approved.executionId,
      leaseToken: recoveryToken,
      callId,
      observedAt: new Date(),
      observations: [{
        writeRowId: row.writeRowId,
        currentValue: row.action.expectedValue,
        providerState: null,
      }],
    });
    const [predispatch] = await database.sql<{ observations: number; provider_calls: number }[]>`
      select
        (select count(*)::int from public.amazon_write_predispatch_observations
          where execution_id = ${approved.executionId} and call_id = ${callId}) as observations,
        (select count(*)::int from public.amazon_write_provider_call_events
          where execution_id = ${approved.executionId} and call_id = ${callId}) as provider_calls
    `;
    expect(predispatch).toEqual({ observations: 1, provider_calls: 0 });

    // Simulate an out-of-band change after durable targeted freshness evidence
    // but before durable provider dispatch. The call remains provably unmade.
    await database.sql`
      update public.keywords set bid = 0.95, synced_at = clock_timestamp()
       where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'kw-1'
    `;
    await expect(markAmazonWriteRowsDispatched(database, {
      orgId, profileId, executionId: approved.executionId,
      leaseToken: recoveryToken, rowIds: [row.writeRowId], callId,
      providerOperation: 'sp_keyword_bid',
      requestFingerprint: providerCallFingerprint({
        executionId: approved.executionId,
        callId,
        providerOperation: 'sp_keyword_bid',
        requestedEntityIds: ['kw-1'],
        actions: [row.action],
      }),
      requestedEntityIds: ['kw-1'], authorizationId: AUTHORIZATION_ID,
      authorizationSha256: authorizationSha256(),
      amazonProfileId, connectionId, region: profileRegion,
      leaseExpiresAt: new Date(Date.now() + 120_000),
      minimumExecutionExpiresAt: new Date(Date.now() + 4 * 60 * 60_000),
    })).resolves.toBe(false);

    const [state] = await database.sql<{
      status: string; refused_count: number; completed_at: Date | null; provider_calls: number;
    }[]>`
      select execution.status::text as status, execution.refused_count,
             execution.completed_at,
             (select count(*)::int from public.amazon_write_provider_call_events call
               where call.execution_id = execution.id) as provider_calls
        from public.amazon_write_executions execution
       where execution.id = ${approved.executionId}
    `;
    expect(state).toMatchObject({
      status: 'refused', refused_count: 1, provider_calls: 0,
    });
    expect(state?.completed_at).not.toBeNull();
  });

  it('keeps an expired ambiguous dispatch in conflict instead of automatically resending', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 1);
    const first = await prepare(approved.executionId);
    const row = first.rows[0];
    if (!row) throw new Error('expected dispatched recovery row');
    await dispatch(approved.executionId, [row.writeRowId]);

    const recovered = await prepare(
      approved.executionId,
      new Date(Date.now() + 3 * 60_000),
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    );
    expect(recovered).toMatchObject({
      status: 'awaiting_sync', rows: [], replayed: true, recoveryObservation: true,
    });
    expect(await listAmazonWriteObservationRows(database, {
      orgId, profileId, executionId: approved.executionId,
      generation: observationGeneration(row.writeRowId),
    })).toEqual([expect.objectContaining({ writeRowId: row.writeRowId, rowStatus: 'dispatched' })]);

    const observed = await recordAmazonWriteObservations(database, {
      orgId, profileId, executionId: approved.executionId,
      generation: observationGeneration(row.writeRowId),
      nextObservationAt: new Date(Date.now() + 60_000),
      observedAt: new Date('2026-08-29T12:06:01.000Z'), attempt: 5,
      observations: [{ writeRowId: row.writeRowId, state: 'not_applied', currentValue: 0.9 }],
    });
    expect(observed).toMatchObject({ status: 'conflict', retryApply: false, accounting: { attempted: 1 } });
    const retry = await prepare(
      approved.executionId,
      new Date(Date.now() + 3 * 60_000 + 2_000),
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    );
    expect(retry.rows).toEqual([]);
    expect(retry.status).toBe('conflict');
    await refuseAmazonWriteExecution(database, {
      orgId, profileId, executionId: approved.executionId, reason: 'synthetic cleanup',
    });
  });

  it('enforces the authorization row and total-execution budgets transactionally', async () => {
    const firstBatch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
      { entityType: 'target', entityId: 'tg-1', field: 'bid', oldValue: 0.6, newValue: 0.61 },
    ]);
    const first = await approve(firstBatch.batchId, firstBatch.artifact, 2, BUDGET_AUTHORIZATION_ID);
    const overRows = await prepareAmazonWriteExecution(database, {
      orgId, profileId, executionId: first.executionId,
      now: new Date(APPROVED_AT), maxConcurrentMutations: 1,
      authorizationId: BUDGET_AUTHORIZATION_ID, maxRowsPerExecution: 1, maxTotalExecutions: 100,
      authorizationSha256: authorizationSha256(BUDGET_AUTHORIZATION_ID),
      amazonProfileId, connectionId, region: profileRegion,
      dispatchLeaseToken: DISPATCH_TOKEN,
      dispatchLeaseExpiresAt: new Date('2026-08-29T12:05:00.000Z'),
    });
    expect(overRows).toMatchObject({ status: 'refused', rows: [] });

    const consumedBatch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const consumed = await approve(
      consumedBatch.batchId, consumedBatch.artifact, 1, BUDGET_AUTHORIZATION_ID,
    );
    const started = await prepare(
      consumed.executionId,
      new Date(),
      'fafafafa-fafa-4afa-8afa-fafafafafafa',
      BUDGET_AUTHORIZATION_ID,
    );
    expect(started.rows).toHaveLength(1);
    await refuseAmazonWriteExecution(database, {
      orgId, profileId, executionId: consumed.executionId, reason: 'synthetic consumed authorization slot',
    });

    const secondBatch = await createBatch([
      { entityType: 'target', entityId: 'tg-1', field: 'bid', oldValue: 0.6, newValue: 0.61 },
    ]);
    const second = await approve(secondBatch.batchId, secondBatch.artifact, 1, BUDGET_AUTHORIZATION_ID);
    const overTotal = await prepareAmazonWriteExecution(database, {
      orgId, profileId, executionId: second.executionId,
      now: new Date(APPROVED_AT), maxConcurrentMutations: 1,
      authorizationId: BUDGET_AUTHORIZATION_ID, maxRowsPerExecution: 100, maxTotalExecutions: 1,
      authorizationSha256: authorizationSha256(BUDGET_AUTHORIZATION_ID),
      amazonProfileId, connectionId, region: profileRegion,
      dispatchLeaseToken: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      dispatchLeaseExpiresAt: new Date('2026-08-29T12:05:00.000Z'),
    });
    expect(overTotal).toMatchObject({ status: 'refused', rows: [] });
  });

  it('atomically reserves both authorization slots before accepting a forward approval', async () => {
    const authorizationId = randomUUID();
    const bounded = BoundedAmazonWriteAuthorization.parse({
      ...authorizationSnapshot(authorizationId),
      constraints: { ...authorizationSnapshot(authorizationId).constraints, max_total_executions: 2 },
    });
    const authorizationFingerprint = sha(serializeBoundedAmazonWriteAuthorization(bounded));
    const firstBatch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const secondBatch = await createBatch([
      { entityType: 'target', entityId: 'tg-1', field: 'bid', oldValue: 0.6, newValue: 0.61 },
    ]);
    const approveBounded = (batch: { batchId: string; artifact: string }) => asUser(
      database, USER_ID, (sql) => approveAmazonWriteExecution(database, { sql }, {
        orgId, profileId, applyBatchId: batch.batchId, approvalMode: 'bounded_live_test',
        expiresAt: EXPIRES_AT, previewSha256: batch.artifact, expectedCount: 1,
        authorizationId, authorizationSha256: authorizationFingerprint,
        authorizationSnapshot: bounded, inversePreapproved: true,
      }),
    );
    const attempts = await Promise.allSettled([
      approveBounded(firstBatch), approveBounded(secondBatch),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const [usage] = await database.sql<{ executions: number; reservations: number }[]>`
      select
        (select count(*)::int from public.amazon_write_executions execution
          join public.amazon_write_approvals approval on approval.id = execution.approval_id
         where approval.authorization_id = ${authorizationId}) as executions,
        (select count(*)::int from public.amazon_write_inverse_reservations
         where authorization_id = ${authorizationId} and inverse_execution_id is null) as reservations
    `;
    expect(usage).toEqual({ executions: 1, reservations: 1 });
  });

  it('rejects a later same-authorization approval without poisoning the materialized inverse', async () => {
    const authorizationId = randomUUID();
    const bounded = BoundedAmazonWriteAuthorization.parse({
      ...authorizationSnapshot(authorizationId),
      constraints: { ...authorizationSnapshot(authorizationId).constraints, max_total_executions: 2 },
    });
    const authSha = sha(serializeBoundedAmazonWriteAuthorization(bounded));
    const source = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const forward = await asUser(database, USER_ID, (sql) => approveAmazonWriteExecution(database, { sql }, {
      orgId, profileId, applyBatchId: source.batchId, approvalMode: 'bounded_live_test',
      expiresAt: EXPIRES_AT, previewSha256: source.artifact, expectedCount: 1,
      authorizationId, authorizationSha256: authSha, authorizationSnapshot: bounded,
      inversePreapproved: true,
    }));
    const token = randomUUID();
    const preparedForward = await prepareAmazonWriteExecution(database, {
      orgId, profileId, executionId: forward.executionId, now: new Date(), maxConcurrentMutations: 1,
      authorizationId, authorizationSha256: authSha, maxRowsPerExecution: 1, maxTotalExecutions: 2,
      amazonProfileId, connectionId, region: profileRegion, dispatchLeaseToken: token,
      dispatchLeaseExpiresAt: new Date(Date.now() + 300_000),
    });
    const forwardRow = preparedForward.rows[0];
    if (!forwardRow) throw new Error('expected bounded forward row');
    await dispatch(forward.executionId, [forwardRow.writeRowId], token, authorizationId, authSha);
    await recordOutcomes({
      orgId, profileId, executionId: forward.executionId, attemptedAt: new Date(),
      outcomes: [{ writeRowId: forwardRow.writeRowId, attemptNumber: forwardRow.attemptNumber,
        requestFingerprint: sha('bounded-forward-result'),
        evidence: { outcome: 'accepted', providerEntityId: 'kw-1', code: null, message: null } }],
    });
    await database.sql`update public.keywords set bid = 0.91 where org_id = ${orgId}
      and profile_id = ${profileId} and amazon_id = 'kw-1'`;
    const observed = await recordAmazonWriteObservations(database, {
      orgId, profileId, executionId: forward.executionId,
      generation: observationGeneration(forwardRow.writeRowId), observedAt: new Date(), attempt: 0,
      nextObservationAt: new Date(Date.now() + 60_000),
      observations: [{ writeRowId: forwardRow.writeRowId, state: 'observed', currentValue: 0.91 }],
    });
    if (!observed.inverseExecutionId) throw new Error('expected materialized exact inverse');
    const later = await createBatch([
      { entityType: 'target', entityId: 'tg-1', field: 'bid', oldValue: 0.6, newValue: 0.61 },
    ]);
    await expect(asUser(database, USER_ID, (sql) => approveAmazonWriteExecution(database, { sql }, {
      orgId, profileId, applyBatchId: later.batchId, approvalMode: 'bounded_live_test',
      expiresAt: EXPIRES_AT, previewSha256: later.artifact, expectedCount: 1,
      authorizationId, authorizationSha256: authSha, authorizationSnapshot: bounded,
      inversePreapproved: true,
    }))).rejects.toThrow(/no capacity/i);
    const inverse = await prepareAmazonWriteExecution(database, {
      orgId, profileId, executionId: observed.inverseExecutionId, now: new Date(), maxConcurrentMutations: 1,
      authorizationId, authorizationSha256: authSha, maxRowsPerExecution: 1, maxTotalExecutions: 2,
      amazonProfileId, connectionId, region: profileRegion, dispatchLeaseToken: randomUUID(),
      dispatchLeaseExpiresAt: new Date(Date.now() + 300_000),
    });
    expect(inverse.rows).toHaveLength(1);
    expect(inverse.direction).toBe('inverse');
    await refuseAmazonWriteExecution(database, {
      orgId, profileId, executionId: observed.inverseExecutionId, reason: 'synthetic cleanup',
    });
  });

  it('serializes concurrent prepares and reserves the profile until the exact inverse is observed', async () => {
    const firstBatch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const first = await approve(firstBatch.batchId, firstBatch.artifact, 1);
    const secondBatch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const second = await approve(secondBatch.batchId, secondBatch.artifact, 1);
    const firstToken = '13131313-1313-4313-8313-131313131313';
    const secondToken = '14141414-1414-4414-8414-141414141414';
    const concurrent = await Promise.allSettled([
      prepare(first.executionId, new Date(), firstToken),
      prepare(second.executionId, new Date(), secondToken),
    ]);
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    const startedResult = concurrent[0];
    if (startedResult?.status !== 'fulfilled') throw new Error('earliest approved cycle did not win serialization');
    const row = startedResult.value.rows[0];
    if (!row) throw new Error('serialized execution has no row');
    await dispatch(first.executionId, [row.writeRowId], firstToken);
    await recordOutcomes({
      orgId, profileId, executionId: first.executionId, attemptedAt: new Date(),
      outcomes: [{
        writeRowId: row.writeRowId, attemptNumber: 1,
        requestFingerprint: sha('serialized-forward'),
        evidence: { outcome: 'accepted', providerEntityId: 'kw-1', code: null, message: null },
      }],
    });
    await expect(prepare(second.executionId, new Date(), secondToken))
      .resolves.toMatchObject({ status: 'queued', rows: [], replayed: true });
    await database.sql`
      update public.keywords set bid = 0.91, synced_at = now()
       where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'kw-1'
    `;
    const forwardObserved = await recordAmazonWriteObservations(database, {
      orgId, profileId, executionId: first.executionId,
      generation: observationGeneration(row.writeRowId),
      nextObservationAt: new Date(Date.now() + 60_000), observedAt: new Date(), attempt: 0,
      observations: [{ writeRowId: row.writeRowId, state: 'observed', currentValue: 0.91 }],
    });
    if (!forwardObserved.inverseExecutionId) throw new Error('serialized cycle has no reserved inverse');
    await expect(prepare(second.executionId, new Date(), secondToken))
      .resolves.toMatchObject({ status: 'queued', rows: [], replayed: true });

    const inverseToken = '15151515-1515-4515-8515-151515151515';
    const inverse = await prepare(forwardObserved.inverseExecutionId, new Date(), inverseToken);
    const inverseRow = inverse.rows[0];
    if (!inverseRow) throw new Error('serialized inverse has no row');
    await dispatch(forwardObserved.inverseExecutionId, [inverseRow.writeRowId], inverseToken);
    await recordOutcomes({
      orgId, profileId, executionId: forwardObserved.inverseExecutionId, attemptedAt: new Date(),
      outcomes: [{
        writeRowId: inverseRow.writeRowId, attemptNumber: 1,
        requestFingerprint: sha('serialized-inverse'),
        evidence: { outcome: 'accepted', providerEntityId: 'kw-1', code: null, message: null },
      }],
    });
    await database.sql`
      update public.keywords set bid = 0.9, synced_at = now()
       where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'kw-1'
    `;
    await recordAmazonWriteObservations(database, {
      orgId, profileId, executionId: forwardObserved.inverseExecutionId,
      generation: observationGeneration(inverseRow.writeRowId),
      nextObservationAt: new Date(Date.now() + 60_000),
      observedAt: new Date(), attempt: 0,
      observations: [{ writeRowId: inverseRow.writeRowId, state: 'observed', currentValue: 0.9 }],
    });
    const [releaseJob] = await database.sql<{ count: number }[]>`
      select count(*)::int as count from public.sync_jobs
       where org_id = ${orgId}
         and dedupe_key = ${`amazon.apply:${second.executionId}:released:${first.executionId}`}
    `;
    expect(releaseJob?.count).toBe(1);
    const released = await prepare(second.executionId, new Date(), secondToken);
    expect(released.rows).toHaveLength(1);
  });

  it('holds the single live-test cycle globally while another profile awaits the inverse', async () => {
    const firstBatch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const first = await approve(firstBatch.batchId, firstBatch.artifact, 1);
    const firstToken = randomUUID();
    const firstPrepared = await prepare(first.executionId, new Date(), firstToken);
    const firstRow = firstPrepared.rows[0];
    if (!firstRow) throw new Error('first global cycle row is missing');
    await dispatch(first.executionId, [firstRow.writeRowId], firstToken);
    await recordOutcomes({
      orgId, profileId, executionId: first.executionId, attemptedAt: new Date(),
      outcomes: [{
        writeRowId: firstRow.writeRowId, attemptNumber: firstRow.attemptNumber,
        requestFingerprint: sha('global-cycle-first'),
        evidence: { outcome: 'accepted', providerEntityId: 'kw-1', code: null, message: null },
      }],
    });

    const [otherProfile] = await database.sql<{
      id: string; amazon_profile_id: string; region: 'NA' | 'EU' | 'FE';
    }[]>`
      insert into public.ad_profiles
        (org_id, connection_id, amazon_profile_id, region, country_code,
         currency_code, timezone, account_name, sync_enabled)
      values (${orgId}, ${connectionId}, ${`synthetic-other-${sequence}`}, ${profileRegion},
              'US', 'USD', 'UTC', 'Synthetic other account', true)
      returning id, amazon_profile_id, region::text as region
    `;
    if (!otherProfile) throw new Error('second global profile was not created');
    await database.sql`
      insert into public.keywords
        (org_id, profile_id, amazon_id, ad_product, name, state, campaign_id,
         ad_group_id, keyword_text, match_type, bid, synced_at)
      values (${orgId}, ${otherProfile.id}, 'kw-other', 'SP', 'synthetic', 'enabled',
              'c-other', 'ag-other', 'synthetic', 'exact', 0.50, ${APPROVED_AT})
    `;
    const otherRows = [{
      entityType: 'keyword' as const, entityId: 'kw-other', field: 'bid', old: 0.5, new: 0.51,
    }];
    const otherArtifact = sha(serializeApplyRows(otherRows));
    const [otherBatch] = await database.sql<{ id: string }[]>`
      insert into public.apply_batches
        (org_id, profile_id, tag, opt_group, lever, note, artifact_sha256,
         exported_proposals, reversible_rows, unsupported_rows)
      values (${orgId}, ${otherProfile.id}, ${`write-other-${sequence}`}, 'rank', 'push',
              'synthetic', ${otherArtifact}, 1, 1, 0)
      returning id
    `;
    if (!otherBatch) throw new Error('second global batch was not created');
    await database.sql`
      insert into public.apply_rows
        (batch_id, org_id, profile_id, entity_type, entity_id, field, old_value, new_value)
      values (${otherBatch.id}, ${orgId}, ${otherProfile.id}, 'keyword', 'kw-other',
              'bid', '0.5'::jsonb, '0.51'::jsonb)
    `;
    const otherAuthorizationId = randomUUID();
    const otherAuthorization = BoundedAmazonWriteAuthorization.parse({
      ...authorizationSnapshot(otherAuthorizationId),
      profiles: [{
        org_id: orgId, profile_id: otherProfile.id,
        amazon_profile_id: otherProfile.amazon_profile_id, connection_id: connectionId,
        region: otherProfile.region, account_label: 'Synthetic other account', marketplace: 'US',
        allowed_entities: [{ action_type: 'sp_keyword_bid', amazon_entity_id: 'kw-other', field: 'bid' }],
      }],
    });
    const otherSha = sha(serializeBoundedAmazonWriteAuthorization(otherAuthorization));
    const other = await asUser(database, USER_ID, (sql) => approveAmazonWriteExecution(database, { sql }, {
      orgId, profileId: otherProfile.id, applyBatchId: otherBatch.id,
      approvalMode: 'bounded_live_test', expiresAt: EXPIRES_AT,
      previewSha256: otherArtifact, expectedCount: 1,
      authorizationId: otherAuthorizationId, authorizationSha256: otherSha,
      authorizationSnapshot: otherAuthorization, inversePreapproved: true,
    }));
    const blocked = await prepareAmazonWriteExecution(database, {
      orgId, profileId: otherProfile.id, executionId: other.executionId,
      now: new Date(), maxConcurrentMutations: 1,
      authorizationId: otherAuthorizationId, authorizationSha256: otherSha,
      maxRowsPerExecution: 1, maxTotalExecutions: 2,
      amazonProfileId: otherProfile.amazon_profile_id, connectionId,
      region: otherProfile.region, dispatchLeaseToken: randomUUID(),
      dispatchLeaseExpiresAt: new Date(Date.now() + 300_000),
    });
    expect(blocked).toMatchObject({ status: 'queued', rows: [], replayed: true });

    await database.sql`
      update public.amazon_write_executions
         set status = 'refused', completed_at = now(), dispatch_lease_token = null,
             dispatch_lease_expires_at = null
       where id in (${first.executionId}, ${other.executionId})
    `;
  });

  it('excludes an accepted first provider group when a later pre-mutation throttle is retried', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
      { entityType: 'target', entityId: 'tg-1', field: 'bid', oldValue: 0.6, newValue: 0.61 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 2);
    const first = await prepare(approved.executionId);
    const keyword = first.rows.find((row) => row.action.actionType === 'sp_keyword_bid');
    const target = first.rows.find((row) => row.action.actionType === 'sp_target_bid');
    if (!keyword || !target) throw new Error('expected prepared keyword and target rows');
    await dispatch(approved.executionId, [keyword.writeRowId]);
    const acceptedResult = await recordOutcomes({
      orgId, profileId, executionId: approved.executionId,
      attemptedAt: new Date(APPROVED_AT),
      outcomes: [{
        writeRowId: keyword.writeRowId,
        attemptNumber: keyword.attemptNumber,
        requestFingerprint: sha('accepted-before-later-throttle'),
        evidence: { outcome: 'accepted', providerEntityId: 'kw-1', code: null, message: null },
      }],
    });
    expect(acceptedResult).toMatchObject({
      status: 'running', retryable: 1,
      accounting: { requested: 2, attempted: 1, succeeded: 1 },
    });

    // This is the worker's response to a 429 that Amazon explicitly reports
    // before mutating the second provider group.
    await dispatch(approved.executionId, [target.writeRowId]);
    await releaseForRetry({
      orgId, profileId, executionId: approved.executionId,
      leaseToken: DISPATCH_TOKEN,
      rowIds: [target.writeRowId],
    });
    const [durable] = await database.sql<{ observation_jobs: number; result_events: number }[]>`
      select
        (select count(*)::int from public.sync_jobs
          where org_id = ${orgId}
            and dedupe_key like ${`amazon.observe:${approved.executionId}:%:0`}) as observation_jobs,
        (select count(*)::int from public.amazon_write_provider_call_events
          where execution_id = ${approved.executionId} and event_type = 'result') as result_events
    `;
    expect(durable).toEqual({ observation_jobs: 2, result_events: 2 });
    await database.sql`
      update public.sync_jobs set status = 'succeeded', finished_at = now()
       where org_id = ${orgId}
         and dedupe_key like ${`amazon.observe:${approved.executionId}:%:0`}
    `;
    const retryToken = randomUUID();
    const retry = await prepare(approved.executionId, new Date(), retryToken);
    expect(retry.rows).toHaveLength(1);
    expect(retry.rows[0]).toMatchObject({
      attemptNumber: 1,
      action: { actionType: 'sp_target_bid', amazonEntityId: 'tg-1' },
    });
    expect(retry.rows.some((row) => row.writeRowId === keyword.writeRowId)).toBe(false);
    await dispatch(approved.executionId, [target.writeRowId], retryToken);
    const [afterRetry] = await database.sql<{ jobs: number; distinct_keys: number; queued: number }[]>`
      select count(*)::int as jobs, count(distinct dedupe_key)::int as distinct_keys,
             count(*) filter (where status = 'queued')::int as queued
        from public.sync_jobs
       where org_id = ${orgId}
         and dedupe_key like ${`amazon.observe:${approved.executionId}:%:0`}
    `;
    expect(afterRetry).toEqual({ jobs: 3, distinct_keys: 3, queued: 1 });
    await recordOutcomes({
      orgId, profileId, executionId: approved.executionId,
      attemptedAt: new Date(),
      outcomes: [{
        writeRowId: target.writeRowId, attemptNumber: retry.rows[0]?.attemptNumber ?? 1,
        requestFingerprint: sha(`retry-cleanup-${approved.executionId}`),
        evidence: { outcome: 'failed', providerEntityId: null, code: 'SYNTHETIC', message: 'cleanup' },
      }],
    });
  });

  it('does not create a fresh dispatch generation from a final old-value observation', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 1);
    const first = await prepare(approved.executionId);
    const row = first.rows[0];
    if (!row) throw new Error('expected final-not-applied recovery row');
    await dispatch(approved.executionId, [row.writeRowId]);
    await database.sql`
      update public.sync_jobs set status = 'succeeded', finished_at = now()
       where org_id = ${orgId}
         and dedupe_key like ${`amazon.observe:${approved.executionId}:%:0`}
    `;
    await database.sql`
      update public.amazon_write_executions
         set dispatch_lease_expires_at = clock_timestamp() - interval '1 second'
       where id = ${approved.executionId}
    `;
    const observation = await recordAmazonWriteObservations(database, {
      orgId, profileId, executionId: approved.executionId,
      generation: observationGeneration(row.writeRowId),
      nextObservationAt: new Date(Date.now() + 60_000),
      observedAt: new Date(), attempt: 5,
      observations: [{ writeRowId: row.writeRowId, state: 'not_applied', currentValue: 0.9 }],
    });
    expect(observation).toMatchObject({ status: 'conflict', retryApply: false });

    const retryToken = randomUUID();
    const retry = await prepare(approved.executionId, new Date(), retryToken);
    expect(retry.rows).toEqual([]);
    expect(retry.status).toBe('conflict');
    const [jobs] = await database.sql<{ total: number; distinct_keys: number; queued: number }[]>`
      select count(*)::int as total, count(distinct dedupe_key)::int as distinct_keys,
             count(*) filter (where status = 'queued')::int as queued
        from public.sync_jobs
       where org_id = ${orgId}
         and dedupe_key like ${`amazon.observe:${approved.executionId}:%:0`}
    `;
    expect(jobs).toEqual({ total: 1, distinct_keys: 1, queued: 0 });
  });

  it('keeps a throttled dispatch observer isolated from the redispatched call generation', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 1);
    const first = await prepare(approved.executionId);
    const row = first.rows[0];
    if (!row) throw new Error('expected throttled generation row');
    const firstGeneration = await dispatch(approved.executionId, [row.writeRowId]);
    await releaseForRetry({
      orgId, profileId, executionId: approved.executionId,
      leaseToken: DISPATCH_TOKEN, rowIds: [row.writeRowId],
    });

    const retryToken = randomUUID();
    const retry = await prepare(approved.executionId, new Date(), retryToken);
    const secondGeneration = await dispatch(
      approved.executionId,
      [row.writeRowId],
      retryToken,
    );
    expect(secondGeneration).not.toBe(firstGeneration);
    expect(await listAmazonWriteObservationRows(database, {
      orgId, profileId, executionId: approved.executionId, generation: firstGeneration,
    })).toEqual([]);
    expect(await listAmazonWriteObservationRows(database, {
      orgId, profileId, executionId: approved.executionId, generation: secondGeneration,
    })).toEqual([expect.objectContaining({ writeRowId: row.writeRowId })]);

    await recordOutcomes({
      orgId, profileId, executionId: approved.executionId, attemptedAt: new Date(),
      outcomes: [{
        writeRowId: row.writeRowId,
        attemptNumber: retry.rows[0]?.attemptNumber ?? 1,
        requestFingerprint: sha(`generation-cleanup-${approved.executionId}`),
        evidence: {
          outcome: 'failed', providerEntityId: 'kw-1',
          code: 'SYNTHETIC', message: 'cleanup',
        },
      }],
    });
  });

  it('gives each accepted provider group an independent observation set and window', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
      { entityType: 'target', entityId: 'tg-1', field: 'bid', oldValue: 0.6, newValue: 0.61 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 2);
    const prepared = await prepare(approved.executionId);
    const keyword = prepared.rows.find((row) => row.action.actionType === 'sp_keyword_bid');
    const target = prepared.rows.find((row) => row.action.actionType === 'sp_target_bid');
    if (!keyword || !target) throw new Error('expected two provider groups');
    const keywordGeneration = await dispatch(approved.executionId, [keyword.writeRowId]);
    await recordOutcomes({
      orgId, profileId, executionId: approved.executionId, attemptedAt: new Date(),
      outcomes: [{
        writeRowId: keyword.writeRowId, attemptNumber: keyword.attemptNumber,
        requestFingerprint: sha('group-keyword'),
        evidence: { outcome: 'accepted', providerEntityId: 'kw-1', code: null, message: null },
      }],
    });
    const targetGeneration = await dispatch(approved.executionId, [target.writeRowId]);
    await recordOutcomes({
      orgId, profileId, executionId: approved.executionId, attemptedAt: new Date(),
      outcomes: [{
        writeRowId: target.writeRowId, attemptNumber: target.attemptNumber,
        requestFingerprint: sha('group-target'),
        evidence: { outcome: 'accepted', providerEntityId: 'tg-1', code: null, message: null },
      }],
    });
    expect((await listAmazonWriteObservationRows(database, {
      orgId, profileId, executionId: approved.executionId, generation: keywordGeneration,
    })).map((row) => row.writeRowId)).toEqual([keyword.writeRowId]);
    expect((await listAmazonWriteObservationRows(database, {
      orgId, profileId, executionId: approved.executionId, generation: targetGeneration,
    })).map((row) => row.writeRowId)).toEqual([target.writeRowId]);

    const firstObserved = await recordAmazonWriteObservations(database, {
      orgId, profileId, executionId: approved.executionId,
      generation: keywordGeneration, nextObservationAt: new Date(Date.now() + 60_000),
      observedAt: new Date(), attempt: 0,
      observations: [{
        writeRowId: keyword.writeRowId, state: 'observed', currentValue: 0.91,
      }],
    });
    expect(firstObserved).toMatchObject({
      status: 'awaiting_sync', inverseReady: false, observationRequeued: false,
    });
    expect((await listAmazonWriteObservationRows(database, {
      orgId, profileId, executionId: approved.executionId, generation: targetGeneration,
    })).map((row) => row.writeRowId)).toEqual([target.writeRowId]);

    await recordAmazonWriteObservations(database, {
      orgId, profileId, executionId: approved.executionId,
      generation: targetGeneration, nextObservationAt: new Date(Date.now() + 24 * 60 * 60_000),
      observedAt: new Date(), attempt: 6,
      observations: [{ writeRowId: target.writeRowId, state: 'conflict', currentValue: 0.6 }],
    });
  });

  it('keeps the owning lease while a later provider group is in flight, then releases its 429 safely', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
      { entityType: 'target', entityId: 'tg-1', field: 'bid', oldValue: 0.6, newValue: 0.61 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 2);
    const leaseToken = randomUUID();
    const prepared = await prepare(approved.executionId, new Date(), leaseToken);
    const keyword = prepared.rows.find((row) => row.action.actionType === 'sp_keyword_bid');
    const target = prepared.rows.find((row) => row.action.actionType === 'sp_target_bid');
    if (!keyword || !target) throw new Error('expected two in-flight provider groups');

    const keywordGeneration = await dispatch(
      approved.executionId,
      [keyword.writeRowId],
      leaseToken,
    );
    await recordOutcomes({
      orgId, profileId, executionId: approved.executionId, attemptedAt: new Date(),
      outcomes: [{
        writeRowId: keyword.writeRowId, attemptNumber: keyword.attemptNumber,
        requestFingerprint: sha('race-keyword-result'),
        evidence: { outcome: 'accepted', providerEntityId: 'kw-1', code: null, message: null },
      }],
    });
    await dispatch(approved.executionId, [target.writeRowId], leaseToken);
    await database.sql`
      update public.keywords set bid = 0.91, synced_at = now()
       where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'kw-1'
    `;

    const firstObserved = await recordAmazonWriteObservations(database, {
      orgId, profileId, executionId: approved.executionId,
      generation: keywordGeneration, nextObservationAt: new Date(Date.now() + 60_000),
      observedAt: new Date(), attempt: 0,
      observations: [{
        writeRowId: keyword.writeRowId, state: 'observed', currentValue: 0.91,
      }],
    });
    expect(firstObserved).toMatchObject({
      status: 'running', inverseReady: false, observationRequeued: false,
    });
    const [held] = await database.sql<{
      status: string; dispatch_lease_token: string | null;
    }[]>`
      select status::text as status, dispatch_lease_token
        from public.amazon_write_executions where id = ${approved.executionId}
    `;
    expect(held).toEqual({ status: 'running', dispatch_lease_token: leaseToken });

    const concurrent = await prepare(
      approved.executionId,
      new Date(),
      randomUUID(),
    );
    expect(concurrent).toMatchObject({
      status: 'running', rows: [], replayed: true,
      retryAfterSeconds: expect.any(Number),
    });
    await releaseForRetry({
      orgId, profileId, executionId: approved.executionId,
      leaseToken, rowIds: [target.writeRowId],
    });
    const [released] = await database.sql<{ status: string; row_status: string }[]>`
      select execution.status::text as status, write_row.row_status::text as row_status
        from public.amazon_write_executions execution
        join public.amazon_write_rows write_row on write_row.execution_id = execution.id
       where execution.id = ${approved.executionId} and write_row.id = ${target.writeRowId}
    `;
    expect(released).toEqual({ status: 'queued', row_status: 'retryable' });
  });

  it.each(['accepted', 'rejected', 'throttled'] as const)(
    'does not let an early observer consume an in-flight %s provider result',
    async (providerOutcome) => {
      const batch = await createBatch([
        { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
      ]);
      const approved = await approve(batch.batchId, batch.artifact, 1);
      const leaseToken = randomUUID();
      const prepared = await prepare(approved.executionId, new Date(), leaseToken);
      const row = prepared.rows[0];
      if (!row) throw new Error('expected in-flight provider row');
      const generation = await dispatch(approved.executionId, [row.writeRowId], leaseToken);

      // Models the +15 second observer while the provider's bounded request is
      // still in flight. Even a matching value cannot classify the row or
      // consume its immutable attempt number until the call result lands.
      const early = await recordAmazonWriteObservations(database, {
        orgId, profileId, executionId: approved.executionId, generation,
        nextObservationAt: new Date(Date.now() + 60_000),
        observedAt: new Date(), attempt: 0,
        observations: [{ writeRowId: row.writeRowId, state: 'observed', currentValue: 0.91 }],
      });
      expect(early).toMatchObject({ status: 'running', inverseReady: false });
      const [beforeResult] = await database.sql<{
        row_status: string; observation_status: string; attempt_count: number;
        attempts: number; dispatch_lease_token: string | null;
      }[]>`
        select write_row.row_status::text as row_status,
               write_row.observation_status::text as observation_status,
               write_row.attempt_count,
               (select count(*)::int from public.amazon_write_attempts attempt
                 where attempt.write_row_id = write_row.id) as attempts,
               execution.dispatch_lease_token
          from public.amazon_write_rows write_row
          join public.amazon_write_executions execution on execution.id = write_row.execution_id
         where write_row.id = ${row.writeRowId}
      `;
      expect(beforeResult).toEqual({
        row_status: 'dispatched', observation_status: 'pending', attempt_count: 0,
        attempts: 0, dispatch_lease_token: leaseToken,
      });

      if (providerOutcome === 'throttled') {
        await releaseForRetry({
          orgId, profileId, executionId: approved.executionId,
          leaseToken, rowIds: [row.writeRowId],
        });
      } else {
        await recordOutcomes({
          orgId, profileId, executionId: approved.executionId, attemptedAt: new Date(),
          outcomes: [{
            writeRowId: row.writeRowId, attemptNumber: row.attemptNumber,
            requestFingerprint: sha(`late-${providerOutcome}-${approved.executionId}`),
            evidence: providerOutcome === 'accepted'
              ? { outcome: 'accepted', providerEntityId: 'kw-1', code: null, message: null }
              : { outcome: 'failed', providerEntityId: null, code: 'REJECTED', message: 'synthetic' },
          }],
        });
      }
      const [afterResult] = await database.sql<{
        row_status: string; attempts: number; dispatch_events: number; result_events: number;
      }[]>`
        select write_row.row_status::text as row_status,
               (select count(*)::int from public.amazon_write_attempts attempt
                 where attempt.write_row_id = write_row.id) as attempts,
               (select count(*)::int from public.amazon_write_provider_call_events event
                 where event.call_id = ${generation} and event.event_type = 'dispatch') as dispatch_events,
               (select count(*)::int from public.amazon_write_provider_call_events event
                 where event.call_id = ${generation} and event.event_type = 'result') as result_events
          from public.amazon_write_rows write_row where write_row.id = ${row.writeRowId}
      `;
      expect(afterResult).toEqual({
        row_status: providerOutcome === 'accepted' ? 'accepted'
          : providerOutcome === 'rejected' ? 'failed' : 'retryable',
        attempts: providerOutcome === 'throttled' ? 0 : 1,
        dispatch_events: 1,
        result_events: 1,
      });
      if (providerOutcome !== 'accepted') {
        await refuseAmazonWriteExecution(database, {
          orgId, profileId, executionId: approved.executionId, reason: 'synthetic cleanup',
        });
      }
    },
  );

  it('repairs dead apply and observation outbox rows without duplicating a live wake-up', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 1);
    const leaseToken = randomUUID();
    const prepared = await prepare(approved.executionId, new Date(), leaseToken);
    const row = prepared.rows[0];
    if (!row) throw new Error('expected outbox recovery row');
    await database.sql`
      update public.sync_jobs set status = 'dead', attempts = max_attempts, finished_at = now()
       where job_type = 'amazon.apply'
         and payload->>'executionId' = ${approved.executionId}
    `;
    await database.sql`
      update public.amazon_write_executions
         set dispatch_lease_expires_at = clock_timestamp() - interval '1 second'
       where id = ${approved.executionId}
    `;
    expect((await recoverAmazonWriteOutbox(database)).applyJobs).toBe(1);
    expect((await recoverAmazonWriteOutbox(database)).applyJobs).toBe(0);
    await database.sql`
      update public.sync_jobs set status = 'succeeded', finished_at = now()
       where job_type = 'amazon.apply' and status = 'queued'
         and payload->>'executionId' = ${approved.executionId}
    `;

    const recoveredLeaseToken = randomUUID();
    const recovered = await prepare(approved.executionId, new Date(), recoveredLeaseToken);
    const recoveredRow = recovered.rows[0];
    if (!recoveredRow) throw new Error('expected recovered outbox row');
    const generation = await dispatch(
      approved.executionId,
      [recoveredRow.writeRowId],
      recoveredLeaseToken,
    );
    await recordOutcomes({
      orgId, profileId, executionId: approved.executionId, attemptedAt: new Date(),
      outcomes: [{
        writeRowId: recoveredRow.writeRowId, attemptNumber: recoveredRow.attemptNumber,
        requestFingerprint: sha(`outbox-observe-${approved.executionId}`),
        evidence: { outcome: 'accepted', providerEntityId: 'kw-1', code: null, message: null },
      }],
    });
    await database.sql`
      update public.sync_jobs set status = 'dead', attempts = max_attempts, finished_at = now()
       where job_type = 'amazon.observe'
         and payload->>'executionId' = ${approved.executionId}
         and payload->>'generation' = ${generation}
    `;
    expect((await recoverAmazonWriteOutbox(database)).observationJobs).toBe(1);
    expect((await recoverAmazonWriteOutbox(database)).observationJobs).toBe(0);
    const [wakes] = await database.sql<{ apply: number; observe: number }[]>`
      select
        count(*) filter (where job_type = 'amazon.apply' and status = 'queued')::int as apply,
        count(*) filter (where job_type = 'amazon.observe' and status = 'queued')::int as observe
        from public.sync_jobs where payload->>'executionId' = ${approved.executionId}
    `;
    expect(wakes).toEqual({ apply: 1, observe: 1 });
  });

  it('grants service_role the worker lifecycle transitions while evidence stays append-only', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 1);
    const first = await prepare(approved.executionId);
    const row = first.rows[0];
    if (!row) throw new Error('expected prepared row');
    const callId = await dispatch(approved.executionId, [row.writeRowId]);
    const attemptFingerprint = sha(serializeAmazonWriteAttemptFingerprint({
      executionId: approved.executionId,
      callId,
      writeRowId: row.writeRowId,
      attemptNumber: 1,
      action: row.action,
    }));

    await database.sql.begin(async (sql) => {
      await sql.unsafe('set local role service_role');
      const attempts = await sql`
        insert into public.amazon_write_attempts
          (org_id, profile_id, execution_id, write_row_id, call_id, attempt_number,
           request_fingerprint, outcome, provider_evidence, attempted_at)
        values (${orgId}, ${profileId}, ${approved.executionId}, ${row.writeRowId}, ${callId}, 1,
                ${attemptFingerprint}, 'retryable',
                '{"outcome":"retryable","providerEntityId":null,"code":"THROTTLED","message":"synthetic"}'::jsonb,
                ${APPROVED_AT})
        returning id
      `;
      expect(attempts).toHaveLength(1);
      const rows = await sql`
        update public.amazon_write_rows
           set row_status = 'retryable', attempt_count = 1,
               provider_evidence = '{"outcome":"retryable","providerEntityId":null,"code":"THROTTLED","message":"synthetic"}'::jsonb
         where id = ${row.writeRowId}
        returning id
      `;
      expect(rows).toHaveLength(1);
      const executions = await sql`
        update public.amazon_write_executions
           set status = 'queued', attempted_count = 1, started_at = null
         where id = ${approved.executionId}
        returning id
      `;
      expect(executions).toHaveLength(1);
      const [truncatePrivileges] = await sql<{ none_allowed: boolean }[]>`
        select bool_and(not has_table_privilege(
          current_user,
          table_name,
          'TRUNCATE'
        )) as none_allowed
          from unnest(array[
            'public.amazon_write_approvals',
            'public.amazon_write_executions',
            'public.amazon_write_inverse_reservations',
            'public.amazon_write_rows',
            'public.amazon_write_predispatch_observations',
            'public.amazon_write_attempts',
            'public.amazon_write_provider_call_events'
          ]) as table_name
      `;
      expect(truncatePrivileges).toEqual({ none_allowed: true });
    });
    await expect(database.sql.begin(async (sql) => {
      await sql.unsafe('set local role service_role');
      await sql`truncate table public.amazon_write_attempts`;
    })).rejects.toThrow(/permission denied/i);

    const retried = await prepare(approved.executionId);
    expect(retried.rows[0]).toMatchObject({ attemptNumber: 2 });
    await expect(database.sql`
      update public.amazon_write_attempts set outcome = 'failed'
       where execution_id = ${approved.executionId}
    `).rejects.toThrow(/immutable/i);
    await refuseAmazonWriteExecution(database, {
      orgId, profileId, executionId: approved.executionId, reason: 'synthetic cleanup',
    });
  });

  it('resolves an ambiguous provider outcome through synchronization before enabling inverse', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 1);
    const prepared = await prepare(approved.executionId);
    const row = prepared.rows[0];
    if (!row) throw new Error('expected prepared row');
    await dispatch(approved.executionId, [row.writeRowId]);
    const outcome = await recordOutcomes({
      orgId, profileId, executionId: approved.executionId,
      attemptedAt: new Date(APPROVED_AT),
      outcomes: [{
        writeRowId: row.writeRowId, attemptNumber: 1,
        requestFingerprint: sha(`ambiguous-${approved.executionId}`),
        evidence: {
          outcome: 'ambiguous', providerEntityId: null,
          code: 'AdsApiTimeoutError', message: 'synthetic timeout',
        },
      }],
    });
    expect(outcome).toMatchObject({
      status: 'awaiting_sync', shouldObserve: true,
      accounting: { attempted: 1, succeeded: 0, failed: 0, ambiguous: 1, resyncRequested: 1 },
    });
    expect(await listAmazonWriteObservationRows(database, {
      orgId, profileId, executionId: approved.executionId,
      generation: observationGeneration(row.writeRowId),
    })).toHaveLength(1);

    await database.sql`
      update public.keywords set bid = 0.91, synced_at = '2026-08-29T12:01:00.000Z'
       where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'kw-1'
    `;
    const recorded = await recordAmazonWriteObservations(database, {
      orgId, profileId, executionId: approved.executionId,
      generation: observationGeneration(row.writeRowId),
      nextObservationAt: new Date(Date.now() + 60_000),
      observedAt: new Date('2026-08-29T12:01:00.000Z'), attempt: 0,
      observations: [{ writeRowId: row.writeRowId, state: 'observed', currentValue: 0.91 }],
    });
    expect(recorded).toMatchObject({
      status: 'succeeded', inverseReady: true,
      accounting: { succeeded: 0, failed: 0, ambiguous: 1, resynchronized: 1 },
    });
    const [ambiguousEvidence] = await database.sql<{
      row_status: string; provider_accepted_at: Date | null; accepted_count: number;
    }[]>`
      select write_row.row_status::text as row_status, write_row.provider_accepted_at,
             result.accepted_count
        from public.amazon_write_rows write_row
        join public.amazon_write_provider_call_events result
          on result.call_id = write_row.dispatch_token and result.event_type = 'result'
       where write_row.id = ${row.writeRowId}
    `;
    expect(ambiguousEvidence).toEqual({
      row_status: 'observed_after_ambiguous',
      provider_accepted_at: null,
      accepted_count: 0,
    });
  });

  it('upgrades observation-only recovery when the exact delayed acceptance arrives', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 1);
    const leaseToken = randomUUID();
    const prepared = await prepare(approved.executionId, new Date(), leaseToken);
    const row = prepared.rows[0];
    if (!row) throw new Error('expected delayed provider row');
    const generation = await dispatch(
      approved.executionId,
      [row.writeRowId],
      leaseToken,
    );
    await database.sql`
      update public.amazon_write_executions
         set dispatch_lease_expires_at = clock_timestamp() - interval '1 second'
       where id = ${approved.executionId}
    `;
    await database.sql`
      update public.keywords set bid = 0.91, synced_at = clock_timestamp()
       where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'kw-1'
    `;
    const recovered = await recordAmazonWriteObservations(database, {
      orgId, profileId, executionId: approved.executionId, generation,
      nextObservationAt: new Date(Date.now() + 60_000),
      observedAt: new Date(), attempt: 0,
      observations: [{ writeRowId: row.writeRowId, state: 'observed', currentValue: 0.91 }],
    });
    expect(recovered).toMatchObject({
      status: 'succeeded', inverseReady: true,
      accounting: { succeeded: 0, ambiguous: 1, resynchronized: 1 },
    });

    const definitive = await recordOutcomes({
      orgId, profileId, executionId: approved.executionId, attemptedAt: new Date(),
      outcomes: [{
        writeRowId: row.writeRowId, attemptNumber: row.attemptNumber,
        requestFingerprint: sha('late-accepted-result'),
        evidence: { outcome: 'accepted', providerEntityId: 'kw-1', code: null, message: null },
      }],
    });
    expect(definitive).toMatchObject({
      status: 'succeeded',
      accounting: { succeeded: 1, ambiguous: 0, resynchronized: 1 },
    });
    const [state] = await database.sql<{
      row_status: string; provider_accepted_at: string | null;
      attempts: number; inverse_executions: number;
    }[]>`
      select write_row.row_status::text as row_status, write_row.provider_accepted_at,
             (select count(*)::int from public.amazon_write_attempts attempt
               where attempt.write_row_id = write_row.id) as attempts,
             (select count(*)::int from public.amazon_write_executions inverse
               where inverse.source_execution_id = ${approved.executionId}) as inverse_executions
        from public.amazon_write_rows write_row where write_row.id = ${row.writeRowId}
    `;
    expect(state).toEqual({
      row_status: 'accepted', provider_accepted_at: expect.any(String),
      attempts: 1, inverse_executions: 1,
    });
  });

  it('does not materialize a subset inverse while another forward row is unresolved', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
      { entityType: 'target', entityId: 'tg-1', field: 'bid', oldValue: 0.6, newValue: 0.61 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 2);
    const prepared = await prepare(approved.executionId);
    const keyword = prepared.rows.find((row) => row.action.actionType === 'sp_keyword_bid');
    const target = prepared.rows.find((row) => row.action.actionType === 'sp_target_bid');
    if (!keyword || !target) throw new Error('expected unresolved forward rows');
    await dispatch(approved.executionId, [keyword.writeRowId]);
    await recordOutcomes({
      orgId, profileId, executionId: approved.executionId,
      attemptedAt: new Date(),
      outcomes: [{
        writeRowId: keyword.writeRowId, attemptNumber: keyword.attemptNumber,
        requestFingerprint: sha(`early-observation-${approved.executionId}`),
        evidence: { outcome: 'accepted', providerEntityId: 'kw-1', code: null, message: null },
      }],
    });
    await database.sql`
      update public.keywords set bid = 0.91, synced_at = now()
       where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'kw-1'
    `;
    const early = await recordAmazonWriteObservations(database, {
      orgId, profileId, executionId: approved.executionId,
      generation: observationGeneration(keyword.writeRowId),
      nextObservationAt: new Date(Date.now() + 60_000),
      observedAt: new Date(), attempt: 0,
      observations: [{ writeRowId: keyword.writeRowId, state: 'observed', currentValue: 0.91 }],
    });
    expect(early).toMatchObject({
      status: 'running', inverseReady: false, inverseExecutionId: null,
      retryApply: true, accounting: { succeeded: 1, resynchronized: 1 },
    });
    const [reservation] = await database.sql<{ inverse_execution_id: string | null }[]>`
      select inverse_execution_id from public.amazon_write_inverse_reservations
       where forward_execution_id = ${approved.executionId}
    `;
    expect(reservation?.inverse_execution_id).toBeNull();
    const stillOwned = await prepare(approved.executionId, new Date(), randomUUID());
    expect(stillOwned).toMatchObject({ status: 'running', rows: [], replayed: true });
    const resumed = await prepare(
      approved.executionId,
      new Date(Date.now() + 301_000),
      randomUUID(),
    );
    expect(resumed.rows).toEqual([expect.objectContaining({ writeRowId: target.writeRowId })]);
    await refuseAmazonWriteExecution(database, {
      orgId, profileId, executionId: approved.executionId, reason: 'synthetic cleanup',
    });
  });

  it('allows a late authoritative synchronization to reconcile a prior observation conflict', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 1);
    const prepared = await prepare(approved.executionId);
    const row = prepared.rows[0];
    if (!row) throw new Error('expected late reconciliation row');
    await dispatch(approved.executionId, [row.writeRowId]);
    await recordOutcomes({
      orgId, profileId, executionId: approved.executionId,
      attemptedAt: new Date(APPROVED_AT),
      outcomes: [{
        writeRowId: row.writeRowId, attemptNumber: 1,
        requestFingerprint: sha(`late-conflict-${approved.executionId}`),
        evidence: { outcome: 'accepted', providerEntityId: 'kw-1', code: null, message: null },
      }],
    });
    const conflict = await recordAmazonWriteObservations(database, {
      orgId, profileId, executionId: approved.executionId,
      generation: observationGeneration(row.writeRowId),
      nextObservationAt: new Date(Date.now() + 60_000),
      observedAt: new Date('2026-08-29T12:01:00.000Z'), attempt: 5,
      observations: [{ writeRowId: row.writeRowId, state: 'conflict', currentValue: 0.9 }],
    });
    expect(conflict).toMatchObject({ status: 'conflict', inverseReady: false });
    await database.sql`
      update public.keywords set bid = 0.91, synced_at = '2026-08-29T12:02:00.000Z'
       where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'kw-1'
    `;
    const reconciled = await recordAmazonWriteObservations(database, {
      orgId, profileId, executionId: approved.executionId,
      generation: observationGeneration(row.writeRowId),
      nextObservationAt: null,
      observedAt: new Date('2026-08-29T12:02:00.000Z'), attempt: 6,
      observations: [{ writeRowId: row.writeRowId, state: 'observed', currentValue: 0.91 }],
    });
    expect(reconciled).toMatchObject({ status: 'succeeded', inverseReady: true });
  });

  it('unlocks the exact inverse only after the provider value is synchronized', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 1);
    const prepared = await prepare(approved.executionId);
    const row = prepared.rows[0];
    if (!row) throw new Error('expected prepared row');
    await dispatch(approved.executionId, [row.writeRowId]);
    await recordOutcomes({
      orgId, profileId, executionId: approved.executionId,
      attemptedAt: new Date(APPROVED_AT),
      outcomes: [{
        writeRowId: row.writeRowId, attemptNumber: 1,
        requestFingerprint: sha(`accepted-${approved.executionId}`),
        evidence: { outcome: 'accepted', providerEntityId: 'kw-1', code: null, message: null },
      }],
    });
    await expect(getAmazonWriteInversePreview(database, {
      orgId, profileId, executionId: approved.executionId,
    })).rejects.toThrow(/blocked until/i);

    await database.sql`
      update public.keywords set bid = 0.91, synced_at = '2026-08-29T12:01:00.000Z'
       where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'kw-1'
    `;
    const observationRows = await listAmazonWriteObservationRows(database, {
      orgId, profileId, executionId: approved.executionId,
      generation: observationGeneration(row.writeRowId),
    });
    expect(observationRows).toHaveLength(1);
    const observedAt = new Date('2026-08-29T12:01:00.000Z');
    const recorded = await recordAmazonWriteObservations(database, {
      orgId, profileId, executionId: approved.executionId,
      generation: observationGeneration(row.writeRowId),
      nextObservationAt: new Date(Date.now() + 60_000), observedAt, attempt: 0,
      observations: [{ writeRowId: row.writeRowId, state: 'observed', currentValue: 0.91 }],
    });
    expect(recorded).toMatchObject({ status: 'succeeded', inverseReady: true, accounting: { resynchronized: 1 } });
    const inverse = await getAmazonWriteInversePreview(database, {
      orgId, profileId, executionId: approved.executionId,
    });
    expect(inverse.actions).toEqual([expect.objectContaining({
      expectedValue: 0.91, requestedValue: 0.9, inverseValue: 0.91,
    })]);
    const [linked] = await database.sql<{ apply_batch_id: string; apply_row_id: string }[]>`
      select apply_batch_id, apply_row_id from public.entity_changes
       where apply_batch_id = ${batch.batchId}
    `;
    expect(linked).toMatchObject({ apply_batch_id: batch.batchId, apply_row_id: row.action.applyRowId });
  });

  it('materializes placement context so an unrelated modifier cannot be erased', async () => {
    const batch = await createBatch([
      { entityType: 'placement', entityId: 'c-1', field: 'top_of_search_placement', oldValue: 20, newValue: 21 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 1);
    expect(approved.actions[0]).toMatchObject({
      actionType: 'sp_campaign_placement', field: 'top_of_search',
      campaignContext: {
        providerState: {
          strategy: 'auto_for_sales',
          placementBidding: [
            { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 5 },
            { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 0 },
            { placement: 'PLACEMENT_TOP', percentage: 20 },
          ],
          shopperCohortBidding: null,
          offAmazonSettings: null,
        },
      },
    });
  });

  it('refuses a placement write when unrelated provider-owned bidding state changed after approval', async () => {
    const batch = await createBatch([
      { entityType: 'placement', entityId: 'c-1', field: 'top_of_search', oldValue: 20, newValue: 21 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 1);
    await database.sql`
      update public.campaigns
         set campaign_write_context = '{"strategy":"auto_for_sales","placementBidding":[{"placement":"PLACEMENT_PRODUCT_PAGE","percentage":5},{"placement":"PLACEMENT_REST_OF_SEARCH","percentage":0},{"placement":"PLACEMENT_TOP","percentage":20},{"placement":"SITE_AMAZON_BUSINESS","percentage":1}],"shopperCohortBidding":null,"offAmazonSettings":null}'::jsonb,
             synced_at = '2026-08-29T12:00:30.000Z'
       where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'c-1'
    `;
    const prepared = await prepare(approved.executionId, new Date(Date.now() + 30_000));
    expect(prepared).toMatchObject({ status: 'refused', rows: [], replayed: false });
  });

  it('materializes a multi-placement inverse as a normal approvable batch with complete provider state', async () => {
    const source = await createBatch([
      { entityType: 'placement', entityId: 'c-1', field: 'top_of_search', oldValue: 20, newValue: 21 },
      { entityType: 'placement', entityId: 'c-1', field: 'product_pages', oldValue: 5, newValue: 6 },
    ]);
    const forward = await approve(source.batchId, source.artifact, 2);
    const prepared = await prepare(forward.executionId);
    await dispatch(forward.executionId, prepared.rows.map((row) => row.writeRowId));
    await recordOutcomes({
      orgId, profileId, executionId: forward.executionId,
      attemptedAt: new Date(APPROVED_AT),
      outcomes: prepared.rows.map((row, index) => ({
        writeRowId: row.writeRowId,
        attemptNumber: row.attemptNumber,
        requestFingerprint: sha(`multi-placement-${forward.executionId}-${index}`),
        evidence: { outcome: 'accepted' as const, providerEntityId: 'c-1', code: null, message: null },
      })),
    });
    const forwardCallId = observationGeneration(prepared.rows[0]!.writeRowId);
    const [forwardCallAccounting] = await database.sql<{
      attempts: number; attempt_calls: number; dispatch_events: number;
      result_events: number; proven_api_calls: number;
    }[]>`
      select
        (select count(*)::int from public.amazon_write_attempts
          where execution_id = ${forward.executionId}) as attempts,
        (select count(distinct call_id)::int from public.amazon_write_attempts
          where execution_id = ${forward.executionId}) as attempt_calls,
        (select count(*)::int from public.amazon_write_provider_call_events
          where execution_id = ${forward.executionId} and call_id = ${forwardCallId}
            and event_type = 'dispatch') as dispatch_events,
        (select count(*)::int from public.amazon_write_provider_call_events
          where execution_id = ${forward.executionId} and call_id = ${forwardCallId}
            and event_type = 'result') as result_events,
        (select coalesce(sum(api_call_count), 0)::int
           from public.amazon_write_provider_call_events
          where execution_id = ${forward.executionId} and call_id = ${forwardCallId})
          as proven_api_calls
    `;
    expect(forwardCallAccounting).toEqual({
      attempts: 2,
      attempt_calls: 1,
      dispatch_events: 1,
      result_events: 1,
      proven_api_calls: 1,
    });
    await database.sql`
      update public.campaigns
         set placement_bidding = '{"topOfSearch":21,"productPages":6,"restOfSearch":0}'::jsonb,
             campaign_write_context = '{"strategy":"auto_for_sales","placementBidding":[{"placement":"PLACEMENT_PRODUCT_PAGE","percentage":6},{"placement":"PLACEMENT_REST_OF_SEARCH","percentage":0},{"placement":"PLACEMENT_TOP","percentage":21}],"shopperCohortBidding":null,"offAmazonSettings":null}'::jsonb,
             synced_at = '2026-08-29T12:01:00.000Z'
       where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'c-1'
    `;
    const byField = new Map(prepared.rows.map((row) => [row.action.field, row] as const));
    const top = byField.get('top_of_search');
    const product = byField.get('product_pages');
    if (!top || !product) throw new Error('expected two placement rows');
    const observed = await recordAmazonWriteObservations(database, {
      orgId, profileId, executionId: forward.executionId,
      generation: observationGeneration(top.writeRowId),
      nextObservationAt: new Date(Date.now() + 60_000),
      observedAt: new Date('2026-08-29T12:01:00.000Z'), attempt: 0,
      observations: [
        { writeRowId: top.writeRowId, state: 'observed', currentValue: 21 },
        { writeRowId: product.writeRowId, state: 'observed', currentValue: 6 },
      ],
    });
    expect(observed).toMatchObject({ status: 'succeeded', inverseReady: true });

    expect(observed.inverseExecutionId).toMatch(/^[a-f0-9-]{36}$/);
    const inverseRows = await database.sql<{ action: unknown }[]>`
      select write_row.action from public.amazon_write_rows write_row
      join public.amazon_write_executions execution on execution.id = write_row.execution_id
      where execution.source_execution_id = ${forward.executionId}
      order by write_row.created_at, write_row.id
    `;
    const inverseActions = inverseRows.map((row) => row.action as AmazonWriteAction);
    expect(inverseActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'top_of_search', expectedValue: 21, requestedValue: 20 }),
      expect.objectContaining({ field: 'product_pages', expectedValue: 6, requestedValue: 5 }),
    ]));
    expect(inverseActions).toHaveLength(2);
    for (const action of inverseActions) {
      if (action.actionType !== 'sp_campaign_placement') throw new Error('expected placement inverse action');
      expect(action.campaignContext.providerState.placementBidding).toEqual([
        { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 6 },
        { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 0 },
        { placement: 'PLACEMENT_TOP', percentage: 21 },
      ]);
    }

    const inverseExecutionId = observed.inverseExecutionId;
    if (inverseExecutionId === null) throw new Error('expected reserved inverse execution');
    const reauthorizationId = randomUUID();
    const reauthorization = BoundedAmazonWriteAuthorization.parse({
      ...authorizationSnapshot(reauthorizationId),
      authorization_id: reauthorizationId,
      expires_at: EXPIRES_AT,
    });
    const reauthorizationSha = sha(serializeBoundedAmazonWriteAuthorization(reauthorization));
    const reapproved = await asUser(database, USER_ID, (sql) =>
      reapproveAmazonWriteInverseExecution(database, { sql }, {
        orgId, profileId, executionId: inverseExecutionId, expiresAt: EXPIRES_AT,
        authorizationId: reauthorizationId, authorizationSha256: reauthorizationSha,
        authorizationSnapshot: reauthorization,
      }));
    expect(reapproved).toMatchObject({ executionId: inverseExecutionId, replayed: false });
    const inversePrepared = await prepareAmazonWriteExecution(database, {
      orgId, profileId, executionId: inverseExecutionId, now: new Date(),
      maxConcurrentMutations: 1, authorizationId: reauthorizationId,
      authorizationSha256: reauthorizationSha, maxRowsPerExecution: 100,
      maxTotalExecutions: 100, amazonProfileId, connectionId, region: profileRegion,
      dispatchLeaseToken: DISPATCH_TOKEN,
      dispatchLeaseExpiresAt: new Date(Date.now() + 300_000),
    });
    await dispatch(
      inverseExecutionId, inversePrepared.rows.map((row) => row.writeRowId),
      DISPATCH_TOKEN, reauthorizationId, reauthorizationSha,
    );
    await recordOutcomes({
      orgId, profileId, executionId: inverseExecutionId,
      attemptedAt: new Date(),
      outcomes: inversePrepared.rows.map((row, index) => ({
        writeRowId: row.writeRowId,
        attemptNumber: row.attemptNumber,
        requestFingerprint: sha(`inverse-placement-${inverseExecutionId}-${index}`),
        evidence: { outcome: 'accepted' as const, providerEntityId: 'c-1', code: null, message: null },
      })),
    });
    await database.sql`
      update public.campaigns
         set placement_bidding = '{"topOfSearch":20,"productPages":5,"restOfSearch":0}'::jsonb,
             campaign_write_context = '{"strategy":"auto_for_sales","placementBidding":[{"placement":"PLACEMENT_PRODUCT_PAGE","percentage":5},{"placement":"PLACEMENT_REST_OF_SEARCH","percentage":0},{"placement":"PLACEMENT_TOP","percentage":20}],"shopperCohortBidding":null,"offAmazonSettings":null}'::jsonb,
             synced_at = now()
       where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'c-1'
    `;
    const inverseByField = new Map(inversePrepared.rows.map((row) => [row.action.field, row] as const));
    const inverseTop = inverseByField.get('top_of_search');
    const inverseProduct = inverseByField.get('product_pages');
    if (!inverseTop || !inverseProduct) throw new Error('expected inverse placement rows');
    const inverseObserved = await recordAmazonWriteObservations(database, {
      orgId, profileId, executionId: inverseExecutionId,
      generation: observationGeneration(inverseTop.writeRowId),
      nextObservationAt: new Date(Date.now() + 60_000),
      observedAt: new Date(), attempt: 0,
      observations: [
        { writeRowId: inverseTop.writeRowId, state: 'observed', currentValue: 20 },
        { writeRowId: inverseProduct.writeRowId, state: 'observed', currentValue: 5 },
      ],
    });
    expect(inverseObserved).toMatchObject({
      status: 'succeeded', inverseReady: true, inverseExecutionId: null,
      accounting: { requested: 2, succeeded: 2, resynchronized: 2 },
    });
    const [lifecycle] = await database.sql<{ source_status: string; inverse_status: string }[]>`
      select source.status::text as source_status, inverse.status::text as inverse_status
        from public.amazon_write_executions execution
        join public.apply_batches inverse on inverse.id = execution.apply_batch_id
        join public.apply_batches source on source.id = inverse.source_batch_id
       where execution.id = ${inverseExecutionId}
    `;
    expect(lifecycle).toEqual({ source_status: 'reverted', inverse_status: 'applied' });
  });

  it('blocks tenant teardown from erasing append-only write evidence', async () => {
    const teardownUser = randomUUID();
    const [seeded] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture(${`teardown-${sequence}`}, ${teardownUser}, 'owner')
    `;
    const teardownOrg = seeded?.seed_tenant_fixture;
    if (!teardownOrg) throw new Error('teardown fixture failed');
    await expect(database.sql`
      delete from public.amazon_write_provider_call_events where org_id = ${teardownOrg}
    `).rejects.toThrow(/immutable/i);
    await expect(database.sql`
      delete from public.orgs where id = ${teardownOrg} returning id
    `).rejects.toThrow();
    const [remaining] = await database.sql<{ executions: number; provider_events: number }[]>`
      select
        (select count(*)::int from public.amazon_write_executions
          where org_id = ${teardownOrg}) as executions,
        (select count(*)::int from public.amazon_write_provider_call_events
          where org_id = ${teardownOrg}) as provider_events
    `;
    expect(remaining).toMatchObject({
      executions: expect.any(Number), provider_events: expect.any(Number),
    });
    expect(remaining?.executions).toBeGreaterThan(0);
    expect(remaining?.provider_events).toBeGreaterThan(0);
  });
});
