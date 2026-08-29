import { createHash, randomUUID } from 'node:crypto';
import {
  serializeApplyRows,
  type AmazonWriteAction,
  type AmazonWriteProviderCallEvidence,
} from '@wizard-ads/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  approveAmazonWriteExecution,
  amazonWriteExecutionIdempotencyKey,
  getAmazonWriteInversePreview,
  listAmazonWriteObservationRows,
  markAmazonWriteRowsDispatched,
  prepareAmazonWriteExecution,
  recordAmazonWriteObservations,
  recordAmazonWriteOutcomes,
  refuseAmazonWriteExecution,
  releaseAmazonWriteExecutionForRetry,
} from './amazon-writes.js';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { asUser } from '../testing/rls.js';

const available = await databaseAvailable();
const USER_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '12121212-1212-4212-8212-121212121212';
const APPROVED_AT = new Date(Date.now() - 60_000).toISOString();
const EXPIRES_AT = new Date(Date.now() + 86_400_000).toISOString();
const AUTHORIZATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BUDGET_AUTHORIZATION_ID = 'abababab-abab-4bab-8bab-abababababab';
const DISPATCH_TOKEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AUTHORIZATION_SHA256 = createHash('sha256').update('synthetic-authorization').digest('hex');

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe.skipIf(!available)('guarded Amazon write persistence', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  let sequence = 0;
  const callByWriteRow = new Map<string, string>();

  beforeAll(async () => {
    database = await createTestDatabase('amazon_writes');
    const [seeded] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('write-fixture', ${USER_ID}, 'owner')
    `;
    orgId = seeded?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId}
    `;
    profileId = profile?.id ?? '';
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
      authorizationSha256: AUTHORIZATION_SHA256,
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
      authorizationSha256: AUTHORIZATION_SHA256,
      maxRowsPerExecution: 100,
      maxTotalExecutions: 100,
      dispatchLeaseToken,
      dispatchLeaseExpiresAt: new Date(Date.now() + 300_000),
    });
  }

  async function dispatch(
    executionId: string,
    rowIds: readonly string[],
    dispatchToken = DISPATCH_TOKEN,
  ) {
    const stored = await database.sql<{ id: string; action: { actionType: 'sp_keyword_bid' | 'sp_target_bid' | 'sp_campaign_placement'; amazonEntityId: string } }[]>`
      select id, action from public.amazon_write_rows where id = any(${[...rowIds]}::uuid[])
    `;
    const operations = new Set(stored.map((row) => row.action.actionType));
    if (stored.length !== rowIds.length || operations.size !== 1) {
      throw new Error('test dispatch must contain one provider operation');
    }
    const providerOperation = [...operations][0];
    if (!providerOperation) throw new Error('test dispatch has no provider operation');
    const callId = randomUUID();
    await markAmazonWriteRowsDispatched(database, {
      orgId,
      profileId,
      executionId,
      leaseToken: dispatchToken,
      rowIds,
      callId,
      providerOperation,
      requestFingerprint: sha(`call:${callId}`),
      requestedEntityIds: [...new Set(stored.map((row) => row.action.amazonEntityId))],
      authorizationId: AUTHORIZATION_ID,
      authorizationSha256: AUTHORIZATION_SHA256,
      leaseExpiresAt: new Date(Date.now() + 120_000),
      minimumExecutionExpiresAt: new Date(Date.now() + 4 * 60 * 60_000),
    });
    rowIds.forEach((rowId) => callByWriteRow.set(rowId, callId));
    return callId;
  }

  async function recordOutcomes(
    input: Omit<Parameters<typeof recordAmazonWriteOutcomes>[1], 'callId' | 'callEvidence'>,
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
    return recordAmazonWriteOutcomes(database, { ...input, callId, callEvidence });
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
        authorizationId: AUTHORIZATION_ID, authorizationSha256: AUTHORIZATION_SHA256,
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
      authorizationId: AUTHORIZATION_ID, authorizationSha256: AUTHORIZATION_SHA256,
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

  it('freezes approved apply rows and preview identity while leaving lifecycle fields available', async () => {
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
    await expect(recordAmazonWriteOutcomes(database, {
      orgId, profileId, executionId: approved.executionId,
      callId: keywordCallId,
      callEvidence: {
        outcome: 'accepted', requested: 1, accepted: 1, failed: 0,
        code: null, message: null,
      },
      attemptedAt: new Date(APPROVED_AT),
      outcomes: [{
        writeRowId: keyword.writeRowId, attemptNumber: 1,
        requestFingerprint: sha('wrong-provider-identity'),
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
      authorizationSha256: AUTHORIZATION_SHA256,
      leaseExpiresAt: new Date(Date.now() + 120_000),
      minimumExecutionExpiresAt: new Date(Date.now() + 4 * 60 * 60_000),
    })).rejects.toThrow(/entity identities/i);
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

    // Simulate an out-of-band change in the narrow interval between the
    // targeted freshness gate and durable provider dispatch.
    await database.sql`
      update public.keywords set bid = 0.95, synced_at = clock_timestamp()
       where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'kw-1'
    `;
    const callId = randomUUID();
    await expect(markAmazonWriteRowsDispatched(database, {
      orgId, profileId, executionId: approved.executionId,
      leaseToken: recoveryToken, rowIds: [row.writeRowId], callId,
      providerOperation: 'sp_keyword_bid', requestFingerprint: sha(`final-race:${callId}`),
      requestedEntityIds: ['kw-1'], authorizationId: AUTHORIZATION_ID,
      authorizationSha256: AUTHORIZATION_SHA256,
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

  it('recovers an expired dispatched lease by observing before any retry', async () => {
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
    })).toEqual([expect.objectContaining({ writeRowId: row.writeRowId, rowStatus: 'dispatched' })]);

    const observed = await recordAmazonWriteObservations(database, {
      orgId, profileId, executionId: approved.executionId,
      observedAt: new Date('2026-08-29T12:06:01.000Z'), attempt: 5,
      observations: [{ writeRowId: row.writeRowId, state: 'not_applied', currentValue: 0.9 }],
    });
    expect(observed).toMatchObject({ status: 'queued', retryApply: true, accounting: { attempted: 1 } });
    const retry = await prepare(
      approved.executionId,
      new Date(Date.now() + 3 * 60_000 + 2_000),
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    );
    expect(retry.rows).toEqual([expect.objectContaining({
      writeRowId: row.writeRowId, attemptNumber: 2,
    })]);
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
      authorizationSha256: AUTHORIZATION_SHA256,
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
      authorizationSha256: AUTHORIZATION_SHA256,
      dispatchLeaseToken: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      dispatchLeaseExpiresAt: new Date('2026-08-29T12:05:00.000Z'),
    });
    expect(overTotal).toMatchObject({ status: 'refused', rows: [] });
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
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === 'rejected')).toHaveLength(1);
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
      .rejects.toThrow(/earlier bounded Amazon write cycle/i);
    await database.sql`
      update public.keywords set bid = 0.91, synced_at = now()
       where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'kw-1'
    `;
    const forwardObserved = await recordAmazonWriteObservations(database, {
      orgId, profileId, executionId: first.executionId, observedAt: new Date(), attempt: 0,
      observations: [{ writeRowId: row.writeRowId, state: 'observed', currentValue: 0.91 }],
    });
    if (!forwardObserved.inverseExecutionId) throw new Error('serialized cycle has no reserved inverse');
    await expect(prepare(second.executionId, new Date(), secondToken))
      .rejects.toThrow(/earlier bounded Amazon write cycle/i);

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
      observedAt: new Date(), attempt: 0,
      observations: [{ writeRowId: inverseRow.writeRowId, state: 'observed', currentValue: 0.9 }],
    });
    const released = await prepare(second.executionId, new Date(), secondToken);
    expect(released.rows).toHaveLength(1);
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

  it('creates a fresh observation generation after a final not-applied recovery', async () => {
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
    const observation = await recordAmazonWriteObservations(database, {
      orgId, profileId, executionId: approved.executionId,
      observedAt: new Date(), attempt: 5,
      observations: [{ writeRowId: row.writeRowId, state: 'not_applied', currentValue: 0.9 }],
    });
    expect(observation).toMatchObject({ status: 'queued', retryApply: true });

    const retryToken = randomUUID();
    const retry = await prepare(approved.executionId, new Date(), retryToken);
    expect(retry.rows).toEqual([expect.objectContaining({ writeRowId: row.writeRowId, attemptNumber: 2 })]);
    await dispatch(approved.executionId, [row.writeRowId], retryToken);
    const [jobs] = await database.sql<{ total: number; distinct_keys: number; queued: number }[]>`
      select count(*)::int as total, count(distinct dedupe_key)::int as distinct_keys,
             count(*) filter (where status = 'queued')::int as queued
        from public.sync_jobs
       where org_id = ${orgId}
         and dedupe_key like ${`amazon.observe:${approved.executionId}:%:0`}
    `;
    expect(jobs).toEqual({ total: 2, distinct_keys: 2, queued: 1 });
    await recordOutcomes({
      orgId, profileId, executionId: approved.executionId,
      attemptedAt: new Date(),
      outcomes: [{
        writeRowId: row.writeRowId, attemptNumber: retry.rows[0]?.attemptNumber ?? 2,
        requestFingerprint: sha(`not-applied-cleanup-${approved.executionId}`),
        evidence: { outcome: 'failed', providerEntityId: null, code: 'SYNTHETIC', message: 'cleanup' },
      }],
    });
  });

  it('grants service_role the worker lifecycle transitions while evidence stays append-only', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 1);
    const first = await prepare(approved.executionId);
    const row = first.rows[0];
    if (!row) throw new Error('expected prepared row');

    await database.sql.begin(async (sql) => {
      await sql.unsafe('set local role service_role');
      const attempts = await sql`
        insert into public.amazon_write_attempts
          (org_id, profile_id, execution_id, write_row_id, attempt_number,
           request_fingerprint, outcome, provider_evidence, attempted_at)
        values (${orgId}, ${profileId}, ${approved.executionId}, ${row.writeRowId}, 1,
                ${sha('service-role-retryable')}, 'retryable',
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
    });

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
    })).toHaveLength(1);

    await database.sql`
      update public.keywords set bid = 0.91, synced_at = '2026-08-29T12:01:00.000Z'
       where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'kw-1'
    `;
    const recorded = await recordAmazonWriteObservations(database, {
      orgId, profileId, executionId: approved.executionId,
      observedAt: new Date('2026-08-29T12:01:00.000Z'), attempt: 0,
      observations: [{ writeRowId: row.writeRowId, state: 'observed', currentValue: 0.91 }],
    });
    expect(recorded).toMatchObject({
      status: 'succeeded', inverseReady: true,
      accounting: { succeeded: 1, failed: 0, ambiguous: 0, resynchronized: 1 },
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
      observedAt: new Date(), attempt: 0,
      observations: [{ writeRowId: keyword.writeRowId, state: 'observed', currentValue: 0.91 }],
    });
    expect(early).toMatchObject({
      status: 'queued', inverseReady: false, inverseExecutionId: null,
      retryApply: true, accounting: { succeeded: 1, resynchronized: 1 },
    });
    const [reservation] = await database.sql<{ inverse_execution_id: string | null }[]>`
      select inverse_execution_id from public.amazon_write_inverse_reservations
       where forward_execution_id = ${approved.executionId}
    `;
    expect(reservation?.inverse_execution_id).toBeNull();
    const resumed = await prepare(approved.executionId, new Date(), randomUUID());
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
    });
    expect(observationRows).toHaveLength(1);
    const observedAt = new Date('2026-08-29T12:01:00.000Z');
    const recorded = await recordAmazonWriteObservations(database, {
      orgId, profileId, executionId: approved.executionId, observedAt, attempt: 0,
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
    const inversePrepared = await prepare(inverseExecutionId);
    await dispatch(inverseExecutionId, inversePrepared.rows.map((row) => row.writeRowId));
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
  });

  it('allows service-role tenant teardown without bypassing direct append-only deletes', async () => {
    const teardownUser = randomUUID();
    const [seeded] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture(${`teardown-${sequence}`}, ${teardownUser}, 'owner')
    `;
    const teardownOrg = seeded?.seed_tenant_fixture;
    if (!teardownOrg) throw new Error('teardown fixture failed');
    await expect(database.sql`
      delete from public.amazon_write_provider_call_events where org_id = ${teardownOrg}
    `).rejects.toThrow(/immutable/i);
    const deleted = await database.sql<{ id: string }[]>`
      delete from public.orgs where id = ${teardownOrg} returning id
    `;
    expect(deleted).toEqual([{ id: teardownOrg }]);
    const [remaining] = await database.sql<{ count: number }[]>`
      select count(*)::int as count from public.amazon_write_executions where org_id = ${teardownOrg}
    `;
    expect(remaining?.count).toBe(0);
  });
});
