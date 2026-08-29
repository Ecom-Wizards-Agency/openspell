import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  approveAmazonWriteExecution,
  getAmazonWriteInversePreview,
  listAmazonWriteObservationRows,
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
      approvalMode: 'manual',
      approvedAt: APPROVED_AT,
      expiresAt: EXPIRES_AT,
      previewSha256: artifact,
      expectedCount,
      idempotencyKey: sha(`execution-${batchId}`),
      inversePreapproved: false,
    });
  }

  it('materializes an immutable bid action once and replays the idempotency key without duplicates', async () => {
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

  it('freezes approved apply rows and preview identity while leaving lifecycle fields available', async () => {
    const batch = await createBatch([
      { entityType: 'target', entityId: 'tg-1', field: 'bid', oldValue: 0.6, newValue: 0.61 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 1);
    await expect(database.sql`
      update public.apply_rows set new_value = '0.62'::jsonb where batch_id = ${batch.batchId}
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
    const prepared = await prepareAmazonWriteExecution(database, {
      orgId, profileId, executionId: approved.executionId,
      now: new Date(APPROVED_AT), maxConcurrentMutations: 1,
    });
    const [keyword, target] = prepared.rows;
    if (!keyword || !target) throw new Error('expected two prepared rows');
    const result = await recordAmazonWriteOutcomes(database, {
      orgId, profileId, executionId: approved.executionId,
      attemptedAt: new Date(APPROVED_AT),
      outcomes: [
        {
          writeRowId: keyword.writeRowId, attemptNumber: 1,
          requestFingerprint: sha('attempt-keyword'),
          evidence: { outcome: 'accepted', providerEntityId: 'kw-1', code: null, message: null },
        },
        {
          writeRowId: target.writeRowId, attemptNumber: 1,
          requestFingerprint: sha('attempt-target'),
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
      status: 'partial', inverseReady: false,
      accounting: { succeeded: 1, failed: 1, ambiguous: 0, resynchronized: 1 },
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
    const prepared = await prepareAmazonWriteExecution(database, {
      orgId, profileId, executionId: approved.executionId,
      now: new Date('2026-08-29T12:00:31.000Z'), maxConcurrentMutations: 1,
    });
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
    const first = await prepareAmazonWriteExecution(database, {
      orgId, profileId, executionId: approved.executionId,
      now: new Date(APPROVED_AT), maxConcurrentMutations: 1,
    });
    expect(first.rows).toHaveLength(1);
    const replay = await prepareAmazonWriteExecution(database, {
      orgId, profileId, executionId: approved.executionId,
      now: new Date(APPROVED_AT), maxConcurrentMutations: 1,
    });
    expect(replay).toMatchObject({ status: 'running', rows: [], replayed: true });

    await releaseAmazonWriteExecutionForRetry(database, {
      orgId, profileId, executionId: approved.executionId,
    });
    const released = await prepareAmazonWriteExecution(database, {
      orgId, profileId, executionId: approved.executionId,
      now: new Date(APPROVED_AT), maxConcurrentMutations: 1,
    });
    expect(released).toMatchObject({ status: 'running', replayed: false });
    expect(released.rows).toHaveLength(1);
    expect(released.rows[0]?.attemptNumber).toBe(1);
    await refuseAmazonWriteExecution(database, {
      orgId, profileId, executionId: approved.executionId, reason: 'synthetic cleanup',
    });
  });

  it('resolves an ambiguous provider outcome through synchronization before enabling inverse', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 1);
    const prepared = await prepareAmazonWriteExecution(database, {
      orgId, profileId, executionId: approved.executionId,
      now: new Date(APPROVED_AT), maxConcurrentMutations: 1,
    });
    const row = prepared.rows[0];
    if (!row) throw new Error('expected prepared row');
    const outcome = await recordAmazonWriteOutcomes(database, {
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

  it('unlocks the exact inverse only after the provider value is synchronized', async () => {
    const batch = await createBatch([
      { entityType: 'keyword', entityId: 'kw-1', field: 'bid', oldValue: 0.9, newValue: 0.91 },
    ]);
    const approved = await approve(batch.batchId, batch.artifact, 1);
    const prepared = await prepareAmazonWriteExecution(database, {
      orgId, profileId, executionId: approved.executionId,
      now: new Date(APPROVED_AT), maxConcurrentMutations: 1,
    });
    const row = prepared.rows[0];
    if (!row) throw new Error('expected prepared row');
    await recordAmazonWriteOutcomes(database, {
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
        strategy: 'auto_for_sales',
        placementBidding: { topOfSearch: 20, productPages: 5, restOfSearch: 0 },
      },
    });
  });
});
