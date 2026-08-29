import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  approveAmazonWriteExecution,
  amazonWriteExecutionIdempotencyKey,
  createAmazonWriteInverseBatch,
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

const available = await databaseAvailable();
const USER_ID = '11111111-1111-4111-8111-111111111111';
const APPROVED_AT = '2026-08-29T12:00:00.000Z';
const EXPIRES_AT = '2026-08-30T12:00:00.000Z';
const AUTHORIZATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DISPATCH_TOKEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe.skipIf(!available)('guarded Amazon write persistence', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  let sequence = 0;

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
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
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
    const artifact = sha(`artifact-${sequence}`);
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

  async function approve(batchId: string, artifact: string, expectedCount: number) {
    return approveAmazonWriteExecution(database, {
      orgId,
      profileId,
      applyBatchId: batchId,
      approvedBy: USER_ID,
      approvalMode: 'bounded_live_test',
      approvedAt: APPROVED_AT,
      expiresAt: EXPIRES_AT,
      previewSha256: artifact,
      expectedCount,
      authorizationId: AUTHORIZATION_ID,
      inversePreapproved: true,
    });
  }

  async function prepare(
    executionId: string,
    now = new Date(APPROVED_AT),
    dispatchLeaseToken = DISPATCH_TOKEN,
  ) {
    return prepareAmazonWriteExecution(database, {
      orgId,
      profileId,
      executionId,
      now,
      maxConcurrentMutations: 1,
      authorizationId: AUTHORIZATION_ID,
      maxRowsPerExecution: 100,
      maxTotalExecutions: 100,
      dispatchLeaseToken,
      dispatchLeaseExpiresAt: new Date(now.getTime() + 300_000),
    });
  }

  async function dispatch(
    executionId: string,
    rowIds: readonly string[],
    dispatchToken = DISPATCH_TOKEN,
  ) {
    return markAmazonWriteRowsDispatched(database, {
      orgId,
      profileId,
      executionId,
      leaseToken: dispatchToken,
      rowIds,
      dispatchedAt: new Date(APPROVED_AT),
      leaseExpiresAt: new Date('2026-08-29T12:05:00.000Z'),
    });
  }

  it('materializes an immutable bid action once and replays its derived approval identity without duplicates', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const first = await approve(batch.batchId, batch.artifact, 1);
    const replay = await approve(batch.batchId, batch.artifact, 1);
    expect(first).toMatchObject({ requested: 1, replayed: false });
    expect(first.actions[0]).toMatchObject({
      actionType: 'sp_keyword_bid', expectedValue: 0.9,
      requestedValue: 0.91, inverseValue: 0.9,
    });
    expect(replay).toMatchObject({ executionId: first.executionId, replayed: true });
    const [counts] = await database.sql<{ approvals: number; executions: number; rows: number }[]>`
      select
        (select count(*)::int from public.amazon_write_approvals where apply_batch_id = ${batch.batchId}) as approvals,
        (select count(*)::int from public.amazon_write_executions where apply_batch_id = ${batch.batchId}) as executions,
        (select count(*)::int from public.amazon_write_rows where execution_id = ${first.executionId}) as rows
    `;
    expect(counts).toEqual({ approvals: 1, executions: 1, rows: 1 });
  });

  it('derives replay identity from every immutable tenant and approval input', () => {
    const base = {
      orgId,
      profileId,
      applyBatchId: '33333333-3333-4333-8333-333333333333',
      approvedBy: USER_ID,
      approvalMode: 'manual' as const,
      approvedAt: APPROVED_AT,
      expiresAt: EXPIRES_AT,
      previewSha256: sha('preview'),
      expectedCount: 1,
      authorizationId: null,
      inversePreapproved: false,
    };
    const key = amazonWriteExecutionIdempotencyKey(base);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(amazonWriteExecutionIdempotencyKey({ ...base, profileId: USER_ID })).not.toBe(key);
    expect(amazonWriteExecutionIdempotencyKey({ ...base, expiresAt: '2026-08-31T12:00:00.000Z' })).not.toBe(key);
    expect(amazonWriteExecutionIdempotencyKey({ ...base, previewSha256: sha('changed') })).not.toBe(key);
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

  it('requires an owner or admin of the exact organization to approve', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    await expect(approveAmazonWriteExecution(database, {
      orgId, profileId, applyBatchId: batch.batchId,
      approvedBy: '99999999-9999-4999-8999-999999999999',
      approvalMode: 'bounded_live_test', approvedAt: APPROVED_AT, expiresAt: EXPIRES_AT,
      previewSha256: batch.artifact, expectedCount: 1,
      authorizationId: AUTHORIZATION_ID, inversePreapproved: true,
    })).rejects.toThrow(/owner or admin/i);
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
    await dispatch(approved.executionId, [keyword.writeRowId, target.writeRowId]);
    const result = await recordAmazonWriteOutcomes(database, {
      orgId, profileId, executionId: approved.executionId,
      attemptedAt: new Date(APPROVED_AT),
      outcomes: [
        {
          writeRowId: keyword.writeRowId, attemptNumber: 1,
          requestFingerprint: sha('attempt-keyword'),
          dispatchToken: DISPATCH_TOKEN,
          evidence: { outcome: 'accepted', providerEntityId: 'kw-1', code: null, message: null },
        },
        {
          writeRowId: target.writeRowId, attemptNumber: 1,
          requestFingerprint: sha('attempt-target'),
          dispatchToken: DISPATCH_TOKEN,
          evidence: { outcome: 'failed', providerEntityId: null, code: 'INVALID_ARGUMENT', message: 'synthetic rejection' },
        },
      ],
    });
    expect(result).toMatchObject({
      status: 'awaiting_sync',
      accounting: { requested: 2, attempted: 2, succeeded: 1, failed: 1, refused: 0, resyncRequested: 1 },
    });
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
    const inverse = await createAmazonWriteInverseBatch(database, {
      orgId, profileId, executionId: approved.executionId,
      tag: `partial-inverse-${sequence}`, note: 'synthetic partial inverse', actorId: USER_ID,
    });
    expect(inverse.rows).toEqual([expect.objectContaining({
      entityType: 'keyword', entityId: 'kw-1', old: 0.91, new: 0.9,
    })]);
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
    const prepared = await prepare(approved.executionId, new Date('2026-08-29T12:00:31.000Z'));
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
    await releaseAmazonWriteExecutionForRetry(database, {
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
      new Date('2026-08-29T12:06:00.000Z'),
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
      observedAt: new Date('2026-08-29T12:06:01.000Z'), attempt: 0,
      observations: [{ writeRowId: row.writeRowId, state: 'not_applied', currentValue: 0.9 }],
    });
    expect(observed).toMatchObject({ status: 'queued', retryApply: true, accounting: { attempted: 1 } });
    const retry = await prepare(
      approved.executionId,
      new Date('2026-08-29T12:06:02.000Z'),
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
    const first = await approve(firstBatch.batchId, firstBatch.artifact, 2);
    const overRows = await prepareAmazonWriteExecution(database, {
      orgId, profileId, executionId: first.executionId,
      now: new Date(APPROVED_AT), maxConcurrentMutations: 1,
      authorizationId: AUTHORIZATION_ID, maxRowsPerExecution: 1, maxTotalExecutions: 100,
      dispatchLeaseToken: DISPATCH_TOKEN,
      dispatchLeaseExpiresAt: new Date('2026-08-29T12:05:00.000Z'),
    });
    expect(overRows).toMatchObject({ status: 'refused', rows: [] });

    const secondBatch = await createBatch([
      { entityType: 'target', entityId: 'tg-1', field: 'bid', oldValue: 0.6, newValue: 0.61 },
    ]);
    const second = await approve(secondBatch.batchId, secondBatch.artifact, 1);
    const overTotal = await prepareAmazonWriteExecution(database, {
      orgId, profileId, executionId: second.executionId,
      now: new Date(APPROVED_AT), maxConcurrentMutations: 1,
      authorizationId: AUTHORIZATION_ID, maxRowsPerExecution: 100, maxTotalExecutions: 1,
      dispatchLeaseToken: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      dispatchLeaseExpiresAt: new Date('2026-08-29T12:05:00.000Z'),
    });
    expect(overTotal).toMatchObject({ status: 'refused', rows: [] });
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
    const acceptedResult = await recordAmazonWriteOutcomes(database, {
      orgId, profileId, executionId: approved.executionId,
      attemptedAt: new Date(APPROVED_AT),
      outcomes: [{
        writeRowId: keyword.writeRowId,
        attemptNumber: keyword.attemptNumber,
        requestFingerprint: sha('accepted-before-later-throttle'),
        dispatchToken: DISPATCH_TOKEN,
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
    await releaseAmazonWriteExecutionForRetry(database, {
      orgId, profileId, executionId: approved.executionId,
      leaseToken: DISPATCH_TOKEN,
      rowIds: [target.writeRowId],
    });
    const retry = await prepare(approved.executionId);
    expect(retry.rows).toHaveLength(1);
    expect(retry.rows[0]).toMatchObject({
      attemptNumber: 1,
      action: { actionType: 'sp_target_bid', amazonEntityId: 'tg-1' },
    });
    expect(retry.rows.some((row) => row.writeRowId === keyword.writeRowId)).toBe(false);
    await refuseAmazonWriteExecution(database, {
      orgId, profileId, executionId: approved.executionId, reason: 'synthetic cleanup',
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
    const outcome = await recordAmazonWriteOutcomes(database, {
      orgId, profileId, executionId: approved.executionId,
      attemptedAt: new Date(APPROVED_AT),
      outcomes: [{
        writeRowId: row.writeRowId, attemptNumber: 1,
        requestFingerprint: sha(`ambiguous-${approved.executionId}`),
        dispatchToken: DISPATCH_TOKEN,
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

  it('allows a late authoritative synchronization to reconcile a prior observation conflict', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 1);
    const prepared = await prepare(approved.executionId);
    const row = prepared.rows[0];
    if (!row) throw new Error('expected late reconciliation row');
    await dispatch(approved.executionId, [row.writeRowId]);
    await recordAmazonWriteOutcomes(database, {
      orgId, profileId, executionId: approved.executionId,
      attemptedAt: new Date(APPROVED_AT),
      outcomes: [{
        writeRowId: row.writeRowId, attemptNumber: 1,
        requestFingerprint: sha(`late-conflict-${approved.executionId}`),
        dispatchToken: DISPATCH_TOKEN,
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
    await recordAmazonWriteOutcomes(database, {
      orgId, profileId, executionId: approved.executionId,
      attemptedAt: new Date(APPROVED_AT),
      outcomes: [{
        writeRowId: row.writeRowId, attemptNumber: 1,
        requestFingerprint: sha(`accepted-${approved.executionId}`),
        dispatchToken: DISPATCH_TOKEN,
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
    const prepared = await prepare(approved.executionId, new Date('2026-08-29T12:00:31.000Z'));
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
    await recordAmazonWriteOutcomes(database, {
      orgId, profileId, executionId: forward.executionId,
      attemptedAt: new Date(APPROVED_AT),
      outcomes: prepared.rows.map((row, index) => ({
        writeRowId: row.writeRowId,
        attemptNumber: row.attemptNumber,
        requestFingerprint: sha(`multi-placement-${forward.executionId}-${index}`),
        dispatchToken: DISPATCH_TOKEN,
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

    const inverse = await createAmazonWriteInverseBatch(database, {
      orgId, profileId, executionId: forward.executionId,
      tag: `placement-inverse-${sequence}`, note: 'synthetic multi-placement inverse', actorId: USER_ID,
    });
    expect(inverse.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'placement', field: 'top_of_search', old: 21, new: 20 }),
      expect.objectContaining({ entityType: 'placement', field: 'product_pages', old: 6, new: 5 }),
    ]));
    expect(inverse.rows).toHaveLength(2);
    const approvedInverse = await approve(inverse.batchId, inverse.artifactSha256, 2);
    expect(approvedInverse.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'top_of_search', expectedValue: 21, requestedValue: 20 }),
      expect.objectContaining({ field: 'product_pages', expectedValue: 6, requestedValue: 5 }),
    ]));
    for (const action of approvedInverse.actions) {
      if (action.actionType !== 'sp_campaign_placement') throw new Error('expected placement inverse action');
      expect(action.campaignContext.providerState.placementBidding).toEqual([
        { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 6 },
        { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 0 },
        { placement: 'PLACEMENT_TOP', percentage: 21 },
      ]);
    }
  });
});
