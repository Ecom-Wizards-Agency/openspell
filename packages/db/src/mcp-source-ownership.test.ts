import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SpWriteManualApprovalRequest } from '@wizard-ads/shared/sp-write-application';
import { createDb, type DbHandle } from './client.js';
import { approveAndQueueSpWrite, previewSpWrite } from './sp-write-application.js';
import { exportAcceptedRecommendations } from './queries/recommendations.js';
import { createTestDatabase, databaseAvailable, type TestDatabase } from './testing/harness.js';
import { asServiceRole } from './testing/rls.js';

const available = await databaseAvailable();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settled<T>(operation: Promise<T>) {
  try { return { ok: true as const, value: await operation }; }
  catch (error) { return { ok: false as const, error }; }
}

describe.skipIf(!available)('native approval and legacy inverse source ownership', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  let runId: string;
  const userId = randomUUID();

  beforeAll(async () => {
    database = await createTestDatabase('source_ownership');
    const [tenant] = await database.sql<{ id: string }[]>`
      select app.seed_tenant_fixture(${randomUUID()}, ${userId}, 'owner') as id`;
    if (!tenant) throw new Error('synthetic tenant missing');
    orgId = tenant.id;
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId}`;
    const [run] = await database.sql<{ id: string }[]>`
      select id from public.recommendation_runs where org_id = ${orgId} order by id limit 1`;
    if (!profile || !run) throw new Error('synthetic source parents missing');
    profileId = profile.id;
    runId = run.id;
    const grantVersion = randomUUID();
    await database.sql`insert into public.sp_write_profile_grant_versions
      (grant_id, version_id, org_id, profile_id, enabled, amazon_profile_id,
        connection_id, region, marketplace_id, currency_code, api_dialect, created_by)
      select grant_id, ${grantVersion}, org_id, profile_id, true, amazon_profile_id,
        connection_id, region, marketplace_id, currency_code, api_dialect, created_by
      from public.sp_write_profile_grant_versions where org_id = ${orgId} and profile_id = ${profileId}`;
    await database.sql`update public.sp_write_profile_grant_heads set version_id = ${grantVersion}
      where org_id = ${orgId} and profile_id = ${profileId}`;
    const gateVersion = randomUUID();
    await database.sql`insert into public.sp_write_environment_gate_versions
      (version_id, enabled, max_unresolved_calls) values (${gateVersion}, true, 1)`;
    await database.sql`insert into public.sp_write_environment_gate_head
      (singleton, version_id) values (true, ${gateVersion})`;
  }, 60_000);

  afterAll(async () => { await database?.drop(); });

  async function fixture() {
    const recommendationId = randomUUID();
    await database.sql`insert into public.recommendations
      (id, run_id, org_id, profile_id, reason, entity_type, entity_id,
        field, current_value, proposed_value, inputs, status)
      values (${recommendationId}, ${runId}, ${orgId}, ${profileId}, 'high_acos', 'keyword', 'kw-1',
        'bid', '0.9'::jsonb, '0.7'::jsonb, '{}'::jsonb, 'accepted')`;
    const exported = await exportAcceptedRecommendations(database, {
      orgId, profileId, runId, ids: [recommendationId], tag: randomUUID(),
      optGroup: 'synthetic', lever: 'bid-down', note: 'Synthetic ownership race', actorId: userId,
    });
    const preview = await previewSpWrite(database, { orgId, userId }, {
      requestId: randomUUID(), profileId, applyBatchId: exported.batchId,
    });
    const request: SpWriteManualApprovalRequest = { profileId, approval: {
      approvalRequestId: randomUUID(), plan: preview.binding, approvalMode: 'manual',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
      boundedAuthorization: null, preapprovedInversePlan: null,
    } };
    return { batchId: exported.batchId, planId: preview.plan.id, request };
  }

  async function backendPid(handle: DbHandle) {
    const [row] = await handle.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
    if (!row) throw new Error('test backend missing');
    return row.pid;
  }

  async function waitForLock(pid: number, expectedBlocker: number) {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const [row] = await database.sql<{ waiting: boolean; blockers: number[] }[]>`
        select wait_event_type = 'Lock' as waiting, pg_blocking_pids(pid) as blockers
        from pg_stat_activity where pid = ${pid}`;
      if (row?.waiting && row.blockers.includes(expectedBlocker)) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('expected source ownership lock wait was not observed');
  }

  async function insertLegacyInverse(handle: DbHandle, batchId: string) {
    // Exercise the granted legacy staging write and its production trigger,
    // including callers that bypass the UI's lifecycle checks.
    return asServiceRole(handle, async (sql) => {
      const rows = await sql<{ id: string }[]>`insert into public.apply_batches
        (org_id, profile_id, tag, opt_group, lever, note, source_batch_id)
        values (${orgId}, ${profileId}, ${randomUUID()}, 'synthetic', 'revert',
          'Synthetic competing inverse', ${batchId}) returning id`;
      if (rows.length !== 1) throw new Error('legacy inverse count mismatch');
      return rows[0]!.id;
    });
  }

  it.each(['inverse', 'native'] as const)('keeps one owner when %s requests the source lock first', async (winner) => {
    const source = await fixture();
    // Each actor has one stable physical connection and server-side timeouts.
    const native = createDb({ connectionString: database.connectionString, max: 1, statementTimeoutSeconds: 10 });
    const legacy = createDb({ connectionString: database.connectionString, max: 1, statementTimeoutSeconds: 10 });
    const entered = deferred();
    const release = deferred();
    const operations: Promise<unknown>[] = [];
    let barrierPid = 0;
    try {
      const nativePid = await backendPid(native);
      const legacyPid = await backendPid(legacy);
      // A neutral lock makes the competing lock requests queue in a provable
      // order while still calling the real native application boundary.
      const barrier = settled(database.sql.begin(async (sql) => {
        await sql`set local statement_timeout = '10s'`;
        const [pid] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
        if (!pid) throw new Error('barrier backend missing');
        barrierPid = pid.pid;
        await sql`select id from public.apply_batches where id = ${source.batchId} for update`;
        entered.resolve();
        await release.promise;
      }));
      operations.push(barrier);
      await Promise.race([entered.promise, barrier.then(() => {
        throw new Error('source lock barrier ended before release');
      })]);
      const approve = () => approveAndQueueSpWrite(native, { orgId, userId }, source.request);
      const revert = () => insertLegacyInverse(legacy, source.batchId);
      const first = settled<unknown>(winner === 'native' ? approve() : revert());
      operations.push(first);
      await waitForLock(winner === 'native' ? nativePid : legacyPid, barrierPid);
      const second = settled<unknown>(winner === 'native' ? revert() : approve());
      operations.push(second);
      // pg_blocking_pids includes a conflicting waiter ahead of this backend:
      // this proves queue order, not just two promises started near each other.
      await waitForLock(winner === 'native' ? legacyPid : nativePid, winner === 'native' ? nativePid : legacyPid);
      release.resolve();
      const [barrierResult, firstResult, secondResult] = await Promise.all([barrier, first, second]);
      expect(barrierResult.ok).toBe(true);
      expect(firstResult.ok).toBe(true);
      if (firstResult.ok && winner === 'native') expect(firstResult.value).toMatchObject({ kind: 'queued' });
      expect(secondResult.ok).toBe(false);
      if (secondResult.ok) throw new Error('both source owners were admitted');
      expect(secondResult.error).toMatchObject({ code: winner === 'native' ? '55000' : 'source_changed' });
      const [counts] = await database.sql<{ receipts: number; requests: number; wakes: number; inverses: number }[]>`
        select (select count(*)::int from public.sp_write_authorization_receipts where plan_id = ${source.planId}) as receipts,
          (select count(*)::int from public.sp_write_execution_requests where plan_id = ${source.planId}) as requests,
          (select count(*)::int from public.sp_write_outbox where plan_id = ${source.planId}) as wakes,
          (select count(*)::int from public.apply_batches where source_batch_id = ${source.batchId}
            and status <> 'abandoned') as inverses`;
      expect(counts).toEqual(winner === 'native'
        ? { receipts: 1, requests: 1, wakes: 1, inverses: 0 }
        : { receipts: 0, requests: 0, wakes: 0, inverses: 1 });
    } finally {
      release.resolve();
      // Rejections are captured immediately; failures release the barrier and
      // wait for bounded server queries before closing pools or dropping the DB.
      await Promise.allSettled(operations);
      await Promise.allSettled([native.close(), legacy.close()]);
    }
  }, 60_000);
});
