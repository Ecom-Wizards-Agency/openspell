import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  McpBidApplyRequest, SpDelegatedAuthorizationReceiptV2, verifyDelegatedSpWriteReceiptArtifacts,
} from '@wizard-ads/shared/sp-writes';
import { createDb, type DbHandle } from './client.js';
import { createTestDatabase, databaseAvailable, type TestDatabase } from './testing/harness.js';
import { asAnon, asServiceRole, asUser } from './testing/rls.js';
import { issueMcpWriteDelegation, revokeMcpKeyAsOperator } from './queries/mcp-writes.js';
import { prepareMcpKeywordBidPreview } from './queries/mcp-write-preview.js';
import { mcpWriteAdmissions, mcpWriteGateHead, mcpWriteGateVersions } from './schema/mcp.js';

const available = await databaseAvailable();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const hasher = { algorithm: 'sha256' as const, digest: hash };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function settled<T>(operation: Promise<T>) {
  try { return { ok: true as const, value: await operation }; }
  catch (error) { return { ok: false as const, error }; }
}

describe.skipIf(!available)('delegated MCP admission authority and permanent capacity', () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase('mcp_admission', { throughMigration: '20260906030000_mcp_write_admissions.sql' });
  }, 60_000);
  afterAll(async () => { await database?.drop(); });

  async function gates(enabled = true) {
    const environment = randomUUID(); const mcp = randomUUID();
    await database.sql`insert into public.sp_write_environment_gate_versions(version_id,enabled,max_unresolved_calls) values (${environment},true,1)`;
    await database.sql`insert into public.sp_write_environment_gate_head(singleton,version_id) values(true,${environment})
      on conflict(singleton) do update set version_id = excluded.version_id`;
    await database.sql`insert into mcp.write_gate_versions(version_id,enabled) values (${mcp},${enabled})`;
    await database.sql`insert into mcp.write_gate_head(singleton,version_id) values(true,${mcp})
      on conflict(singleton) do update set version_id = excluded.version_id`;
  }
  async function fixture(maximumRows = 3) {
    await gates();
    const userId = randomUUID();
    const [tenant] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()},${userId},'owner') as id`;
    const orgId = tenant!.id;
    const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id = ${orgId}`;
    const profileId = profile!.id; const grant = randomUUID();
    await database.sql`insert into public.sp_write_profile_grant_versions
      (grant_id,version_id,org_id,profile_id,enabled,amazon_profile_id,connection_id,region,marketplace_id,currency_code,api_dialect,created_by)
      select grant_id,${grant},org_id,profile_id,true,amazon_profile_id,connection_id,region,marketplace_id,currency_code,api_dialect,created_by
      from public.sp_write_profile_grant_versions where org_id = ${orgId} and profile_id = ${profileId}`;
    await database.sql`update public.sp_write_profile_grant_heads set version_id = ${grant} where org_id = ${orgId} and profile_id = ${profileId}`;
    const actor = { orgId, userId }; const tokenHash = hash(randomUUID());
    const delegation = await issueMcpWriteDelegation(database, actor, {
      label: 'Synthetic admission key', profileIds: [profileId], expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      limits: { action: 'keyword.bid', maximumRowsPerCall: 1, maximumRowsPerUtcDay: maximumRows,
        maximumAbsoluteDeltaByCurrency: [{ amount: '0.3', currencyCode: 'USD' }], maximumRelativeDelta: '0.5' },
    }, { tokenHash, keyPrefix: 'wza_syntheti' });
    const credential = { orgId, keyId: delegation.keyId, tokenHash };
    async function preview() {
      return prepareMcpKeywordBidPreview(database, credential, { requestId: randomUUID(), profileId,
        source: { kind: 'keyword_proposals', note: 'Synthetic SQL admission',
          rows: [{ keywordId: 'kw-1', expectedBid: '0.9', requestedBid: '0.8' }] } });
    }
    const prepared = await preview();
    const request = McpBidApplyRequest.parse({ requestId: randomUUID(), profileId,
      planId: prepared.preview.plan.id, planFingerprint: prepared.preview.plan.fingerprint });
    return { actor, credential, delegation, profileId, prepared, preview, request };
  }
  async function admit(handle: DbHandle, f: Awaited<ReturnType<typeof fixture>>, request = f.request) {
    return asServiceRole(handle, async (sql) => {
      const [row] = await sql<{ value: unknown }[]>`select app.admit_mcp_sp_write_v1(
        ${f.actor.orgId},${f.credential.keyId},${f.credential.tokenHash},${JSON.stringify(request)}) as value`;
      return SpDelegatedAuthorizationReceiptV2.parse(row!.value);
    });
  }
  async function counts(orgId: string) {
    const [row] = await database.sql`select
      (select count(*)::int from mcp.write_admissions where org_id = ${orgId}) as admissions,
      (select coalesce(sum(reserved_rows),0)::int from mcp.write_admissions where org_id = ${orgId}) as charged,
      (select count(*)::int from public.sp_write_authorization_receipts where org_id = ${orgId} and approval_mode = 'delegated_mcp') as receipts,
      (select count(*)::int from public.sp_write_execution_requests where org_id = ${orgId}) as requests,
      (select count(*)::int from public.sp_write_outbox where org_id = ${orgId}) as wakes,
      (select count(*)::int from public.audit_log where org_id = ${orgId} and action = 'mcp.bid_apply.admitted') as audits`;
    return row;
  }
  async function backendPid(handle: DbHandle) {
    const [row] = await handle.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
    return row!.pid;
  }
  async function waitForLock(pid: number, blocker: number) {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const [row] = await database.sql<{ waiting: boolean; blockers: number[] }[]>`
        select wait_event_type = 'Lock' as waiting, pg_blocking_pids(pid) as blockers from pg_stat_activity where pid = ${pid}`;
      if (row?.waiting && row.blockers.includes(blocker)) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('expected MCP authority lock wait was not observed');
  }
  async function claim(planId: string) {
    const rows = await asServiceRole(database, (sql) => sql<{
      outbox_id: string; plan_id: string; claim_epoch: string; claim_token: string;
    }[]>`select outbox_id::text,plan_id::text,claim_epoch::text,claim_token::text
      from app.claim_sp_write_outbox('synthetic-mcp-admission',array['dispatch']::public.sp_write_outbox_kind[],10,70)`);
    const value = rows.find((row) => row.plan_id === planId);
    if (!value) throw new Error('expected delegated dispatch claim');
    return value;
  }

  it('mirrors private columns and seeds no MCP authority gate', async () => {
    expect(await database.sql`select * from mcp.write_gate_head`).toHaveLength(0);
    for (const table of [mcpWriteAdmissions, mcpWriteGateHead, mcpWriteGateVersions]) {
      const config = getTableConfig(table);
      const columns = await database.sql<{ name: string; not_null: boolean }[]>`
        select column_name as name, is_nullable = 'NO' as not_null from information_schema.columns
        where table_schema = ${config.schema!} and table_name = ${config.name} order by column_name`;
      expect(columns).toEqual(config.columns.map((column) => ({ name: column.name, not_null: column.notNull }))
        .sort((a, b) => a.name.localeCompare(b.name)));
      await expect(asAnon(database, (sql) => sql.unsafe(`select * from mcp.${config.name}`))).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('atomically charges, records the delegated actor and queues an exact replayable operation', async () => {
    const f = await fixture(); const before = await counts(f.actor.orgId);
    const receipt = await admit(database, f);
    expect(receipt.approvalRequestId).not.toBe(f.request.requestId);
    expect(receipt.mcpRequestId).toBe(f.request.requestId);
    expect(receipt.approvedBy).toBe(f.actor.userId);
    verifyDelegatedSpWriteReceiptArtifacts(f.prepared.preview.plan, f.delegation, f.request, receipt, receipt.approvedAt, hasher);
    const after = await counts(f.actor.orgId);
    expect(after).toEqual({ admissions: 1, charged: 1, receipts: 1,
      requests: Number(before!['requests']) + 1, wakes: Number(before!['wakes']) + 1, audits: 1 });
    expect(await admit(database, f)).toEqual(receipt);
    expect(await counts(f.actor.orgId)).toEqual(after);
    await expect(admit(database, f, { ...f.request, requestId: randomUUID() })).rejects.toMatchObject({ code: '23505' });
    await expect(admit(database, f, { ...f.request, planFingerprint: '0'.repeat(64) })).rejects.toMatchObject({ code: '23505' });
    expect(await counts(f.actor.orgId)).toEqual(after);
  });

  it('preserves replay/read after issuer or gates change but refuses revoked keys and fresh authority', async () => {
    const f = await fixture(); const receipt = await admit(database, f); const before = await counts(f.actor.orgId);
    await gates(false);
    await database.sql`update public.org_members set role = 'viewer' where org_id = ${f.actor.orgId} and user_id = ${f.actor.userId}`;
    expect(await admit(database, f)).toEqual(receipt);
    const [read] = await asServiceRole(database, (sql) => sql<{ value: { dailyRows: { reserved: number } } }[]>`
      select app.mcp_write_read_context(${f.actor.orgId},${f.credential.keyId},${f.credential.tokenHash},${f.profileId}) as value`);
    expect(read!.value.dailyRows.reserved).toBe(1);
    await expect(admit(database, f, { ...f.request, requestId: randomUUID() })).rejects.toMatchObject({ code: '42501' });
    await database.sql`update public.org_members set role = 'owner' where org_id = ${f.actor.orgId} and user_id = ${f.actor.userId}`;
    await revokeMcpKeyAsOperator(database, f.actor, f.credential.keyId);
    await expect(admit(database, f)).rejects.toMatchObject({ code: '42501' });
    await expect(asServiceRole(database, (sql) => sql`select app.mcp_write_read_context(
      ${f.actor.orgId},${f.credential.keyId},${f.credential.tokenHash},${f.profileId})`)).rejects.toMatchObject({ code: '42501' });
    expect(await counts(f.actor.orgId)).toEqual(before);
  });

  it('serializes the final daily row and never refunds an admitted charge', async () => {
    const f = await fixture(1); const second = await f.preview();
    const secondRequest = { ...f.request, requestId: randomUUID(), planId: second.preview.plan.id, planFingerprint: second.preview.plan.fingerprint };
    const connections = Array.from({ length: 3 }, () => createDb({ connectionString: database.connectionString, max: 1, statementTimeoutSeconds: 10 }));
    const [holder,first,contender] = connections as [DbHandle,DbHandle,DbHandle];
    const [holderPid,firstPid,contenderPid] = await Promise.all(connections.map(backendPid));
    const entered = deferred(); const release = deferred(); const pending: Promise<unknown>[] = [];
    const held = settled(holder.sql.begin(async (sql) => {
      await sql`select id from mcp.api_keys where id = ${f.credential.keyId} for update`;
      entered.resolve(); await release.promise;
    }));
    try {
      await entered.promise;
      const winner = settled(admit(first, f)); pending.push(winner);
      await waitForLock(firstPid!,holderPid!);
      const loser = settled(admit(contender, f, secondRequest)); pending.push(loser);
      await waitForLock(contenderPid!,firstPid!);
      release.resolve();
      expect(await held).toMatchObject({ ok: true });
      expect(await winner).toMatchObject({ ok: true });
      const rejected = await loser;
      if (rejected.ok) throw new Error('expected final-budget refusal');
      expect(rejected.error).toMatchObject({ code: '42501' });
    } finally {
      release.resolve(); await Promise.allSettled([held,...pending]);
      await Promise.all(connections.map((connection) => connection.sql.end({ timeout: 1 })));
    }
    expect(await counts(f.actor.orgId)).toMatchObject({ admissions: 1, charged: 1, receipts: 1, audits: 1 });
    await expect(asServiceRole(database, (sql) => sql`update mcp.write_admissions set reserved_rows = 0 where org_id = ${f.actor.orgId}`))
      .rejects.toMatchObject({ code: '42501' });
    await expect(database.sql`delete from mcp.write_admissions where org_id = ${f.actor.orgId}`).rejects.toMatchObject({ code: '55000' });
  });

  it('refuses a direct admission using a pre-charge repeatable-read snapshot', async () => {
    const f = await fixture(1); const second = await f.preview();
    const request = { ...f.request, requestId: randomUUID(), planId: second.preview.plan.id, planFingerprint: second.preview.plan.fingerprint };
    const handle = createDb({ connectionString: database.connectionString, max: 1, statementTimeoutSeconds: 10 });
    try {
      const result = await settled(handle.sql.begin('isolation level repeatable read', async (sql) => {
        const [old] = await sql`select count(*)::int as total from mcp.write_admissions where org_id = ${f.actor.orgId}`;
        expect(old!['total']).toBe(0);
        await admit(database, f);
        await sql.unsafe('set local role service_role');
        return sql`select app.admit_mcp_sp_write_v1(${f.actor.orgId},${f.credential.keyId},${f.credential.tokenHash},${JSON.stringify(request)})`;
      }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('stale admission snapshot was accepted');
      expect(result.error).toMatchObject({ code: '25001' });
      expect(await counts(f.actor.orgId)).toMatchObject({ admissions: 1, charged: 1 });
    } finally { await handle.sql.end({ timeout: 1 }); }
  });

  it('keeps control tables and internal authority helpers private to their owning RPCs', async () => {
    const f = await fixture();
    await expect(asUser(database, f.actor.userId, (sql) => sql`select app.admit_mcp_sp_write_v1(
      ${f.actor.orgId},${f.credential.keyId},${f.credential.tokenHash},${JSON.stringify(f.request)})`))
      .rejects.toMatchObject({ code: '42501' });
    await expect(asServiceRole(database, (sql) => sql`update mcp.write_gate_head set version_id = ${randomUUID()}`))
      .rejects.toMatchObject({ code: '42501' });
    await expect(asServiceRole(database, (sql) => sql`select app.lock_mcp_dispatch_authority(${f.request.planId},${randomUUID()})`))
      .rejects.toMatchObject({ code: '42501' });
    await expect(asServiceRole(database, (sql) => sql`select app.assert_mcp_admission_closed(${randomUUID()})`))
      .rejects.toMatchObject({ code: '42501' });
    await expect(asServiceRole(database, (sql) => sql`select app.assert_mcp_admission_source(${f.request.planId})`))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('rolls back the permanent charge and actor audit when enqueue fails', async () => {
    const f = await fixture(); const before = await counts(f.actor.orgId);
    await database.sql.unsafe(`create function app.test_reject_mcp_wake() returns trigger language plpgsql as $$
      begin raise exception 'synthetic enqueue failure'; end; $$;
      create trigger test_reject_mcp_wake before insert on public.sp_write_outbox
      for each row when (new.org_id = '${f.actor.orgId}'::uuid) execute function app.test_reject_mcp_wake()`);
    try {
      await expect(admit(database, f)).rejects.toMatchObject({ code: 'P0001' });
      expect(await counts(f.actor.orgId)).toEqual(before);
    } finally {
      await database.sql.unsafe('drop trigger test_reject_mcp_wake on public.sp_write_outbox; drop function app.test_reject_mcp_wake()');
    }
    expect((await admit(database, f)).mcpRequestId).toBe(f.request.requestId);
    expect(await counts(f.actor.orgId)).toMatchObject({ admissions: 1, charged: 1, audits: 1 });
  });

  it('prevents generic service audit writes from forging the admission event', async () => {
    const f = await fixture(); const receipt = await admit(database, f);
    const insert = () => asServiceRole(database, (sql) => sql`insert into public.audit_log
      (org_id,actor_type,actor_id,action,target_type,target_id,payload,source)
      select org_id,actor_type,actor_id,action,target_type,target_id,payload,source from public.audit_log
      where org_id = ${f.actor.orgId} and action = 'mcp.bid_apply.admitted'`);
    await expect(insert()).rejects.toMatchObject({ code: '42501' });
    const [other] = await asServiceRole(database, (sql) => sql<{ id: string }[]>`insert into public.audit_log
      (org_id,actor_type,actor_id,action,target_type,target_id,payload,source)
      values (${f.actor.orgId},'mcp',${f.credential.keyId},'synthetic.generic.audit','sp_write_plan',${f.request.planId},'{}','mcp')
      returning id::text`);
    await expect(asServiceRole(database, (sql) => sql`update public.audit_log set action = 'mcp.bid_apply.admitted' where id = ${other!.id}`))
      .rejects.toMatchObject({ code: '42501' });
    expect(await admit(database, f)).toEqual(receipt);
    expect(await counts(f.actor.orgId)).toMatchObject({ admissions: 1, charged: 1, audits: 1 });
  });

  it('refuses a receipt whose remaining microseconds disappear at shared-contract precision', async () => {
    const f = await fixture(); const receipt = await admit(database, f);
    const millisecond = new Date(receipt.expiresAt).toISOString().slice(0,-1);
    const approvedAt = `${millisecond}001Z`; const expiresAt = `${millisecond}999Z`;
    expect(Date.parse(approvedAt)).toBe(Date.parse(expiresAt));
    const [precision] = await database.sql<{ ordered: boolean }[]>`select ${approvedAt}::timestamptz < ${expiresAt}::timestamptz as ordered`;
    expect(precision!.ordered).toBe(true);
    const build = (at: string) => database.sql<{ value: unknown }[]>`select app.mcp_admission_receipt(
      jsonb_populate_record(null::mcp.write_admissions,to_jsonb(a) || jsonb_build_object('admitted_at',${at}::text)),r,
      jsonb_set(p.artifact,'{expiresAt}',to_jsonb(${expiresAt}::text)),d.artifact) as value
      from mcp.write_admissions a join public.sp_write_authorization_receipts r using (approval_id)
      join public.sp_write_plans p on p.plan_id = a.plan_id
      join mcp.write_delegations d on d.version_id = a.delegation_version_id where a.approval_id = ${receipt.approvalId}`;
    await expect(build(approvedAt)).rejects.toMatchObject({ code: '22023' });
    const previousMillisecond = new Date(Date.parse(approvedAt) - 1).toISOString().slice(0,-1);
    const readableAt = `${previousMillisecond}999Z`;
    const [readable] = await build(readableAt);
    const parsed = SpDelegatedAuthorizationReceiptV2.parse(readable!.value);
    expect(parsed.approvedAt).toBe(readableAt);
    expect(parsed.expiresAt).toBe(expiresAt);
  });

  it('returns stale custody after an authority lock wait crosses the claim deadline', async () => {
    const f = await fixture(); await admit(database, f); const c = await claim(f.request.planId);
    const blocker = createDb({ connectionString: database.connectionString, max: 1, statementTimeoutSeconds: 10 });
    const waiter = createDb({ connectionString: database.connectionString, max: 1, statementTimeoutSeconds: 10 });
    const blockerPid = await backendPid(blocker); const waiterPid = await backendPid(waiter);
    const entered = deferred(); const release = deferred(); let pending: Promise<unknown> | undefined;
    const held = settled(blocker.sql.begin(async (sql) => {
      await sql`select * from public.sp_write_environment_gate_head for update`;
      entered.resolve(); await release.promise;
    }));
    try {
      await entered.promise;
      // Synthetic owner clock compression keeps the production RPC's minimum
      // lease intact while testing expiry during a real observed lock wait.
      await database.sql`update app.sp_write_outbox_delivery_heads
        set lease_expires_at = clock_timestamp() + interval '1 second' where outbox_id = ${c.outbox_id}`;
      const result = settled(asServiceRole(waiter, (sql) => sql<{ decision: string; refused_rows: number }[]>`
        select decision,refused_rows from app.refuse_invalid_mcp_write_for_claim(${c.outbox_id},${c.claim_epoch},${c.claim_token})`));
      pending = result;
      await waitForLock(waiterPid, blockerPid);
      const deadline = Date.now() + 3_000;
      for (;;) {
        const [row] = await database.sql<{ expired: boolean }[]>`select clock_timestamp() >= lease_expires_at as expired
          from app.sp_write_outbox_delivery_heads where outbox_id = ${c.outbox_id}`;
        if (row!.expired) break;
        if (Date.now() > deadline) throw new Error('synthetic claim did not expire');
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      release.resolve();
      expect(await held).toMatchObject({ ok: true });
      expect(await result).toEqual({ ok: true, value: [{ decision: 'stale_claim', refused_rows: 0 }] });
      expect(await database.sql`select * from public.sp_write_action_resolutions where plan_id = ${f.request.planId}`).toHaveLength(0);
    } finally {
      release.resolve(); await Promise.allSettled([held, pending]);
      await Promise.all([blocker.sql.end({ timeout: 1 }),waiter.sql.end({ timeout: 1 })]);
    }
  });

  it('replays while a claimed settlement owns custody and waits for the replay transaction environment lock', async () => {
    const f = await fixture(); const receipt = await admit(database, f); const c = await claim(f.request.planId);
    const blocker = createDb({ connectionString: database.connectionString, max: 1, statementTimeoutSeconds: 10 });
    const waiter = createDb({ connectionString: database.connectionString, max: 1, statementTimeoutSeconds: 10 });
    const blockerPid = await backendPid(blocker); const waiterPid = await backendPid(waiter);
    const entered = deferred(); const replay = deferred(); let pending: Promise<unknown> | undefined;
    const replayResult = settled(blocker.sql.begin(async (sql) => {
      await sql`select * from public.sp_write_environment_gate_head for update`;
      entered.resolve(); await replay.promise;
      await sql.unsafe('set local role service_role');
      const [row] = await sql<{ value: unknown }[]>`select app.admit_mcp_sp_write_v1(
        ${f.actor.orgId},${f.credential.keyId},${f.credential.tokenHash},${JSON.stringify(f.request)}) as value`;
      return row!.value;
    }));
    try {
      await entered.promise;
      const result = settled(asServiceRole(waiter, (sql) => sql<{ decision: string; refused_rows: number }[]>`
        select decision,refused_rows from app.refuse_invalid_mcp_write_for_claim(${c.outbox_id},${c.claim_epoch},${c.claim_token})`));
      pending = result;
      await waitForLock(waiterPid, blockerPid);
      replay.resolve();
      expect(await replayResult).toEqual({ ok: true, value: receipt });
      expect(await result).toEqual({ ok: true, value: [{ decision: 'unchanged', refused_rows: 0 }] });
      expect(await counts(f.actor.orgId)).toMatchObject({ admissions: 1, charged: 1, audits: 1 });
    } finally {
      replay.resolve(); await Promise.allSettled([replayResult,pending]);
      await Promise.all([blocker.sql.end({ timeout: 1 }),waiter.sql.end({ timeout: 1 })]);
    }
  });

  it('retains immutable admission evidence until the entire synthetic organization is purged', async () => {
    const f = await fixture(); await admit(database, f);
    await expect(database.sql`delete from mcp.write_admissions where org_id = ${f.actor.orgId}`).rejects.toMatchObject({ code: '55000' });
    await database.sql`delete from public.orgs where id = ${f.actor.orgId}`;
    expect(await counts(f.actor.orgId)).toEqual({ admissions: 0, charged: 0, receipts: 0, requests: 0, wakes: 0, audits: 0 });
  });
});
