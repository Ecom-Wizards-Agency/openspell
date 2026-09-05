import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  McpWriteDelegation, serializeMcpWriteDelegationFingerprint, verifyMcpWriteDelegationFingerprint,
} from '@wizard-ads/shared/sp-writes';
import type { Sql } from './client.js';
import { createTestDatabase, databaseAvailable, type TestDatabase } from './testing/harness.js';
import { asAnon, asServiceRole, asUser } from './testing/rls.js';

const available = await databaseAvailable();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const hasher = { algorithm: 'sha256' as const, digest: hash };

describe.skipIf(!available)('operator-issued MCP write authority', () => {
  let database: TestDatabase;
  beforeAll(async () => { database = await createTestDatabase('mcp_delegation'); }, 60_000);
  afterAll(async () => { await database?.drop(); });

  async function fixture() {
    const orgId = randomUUID(); const issuerUserId = randomUUID(); const profileId = randomUUID();
    const connectionId = randomUUID();
    await database.sql`select public.auth_user_stub(${issuerUserId}::uuid)`;
    await database.sql`insert into public.orgs(id, slug, name) values(${orgId}, ${orgId}, 'Synthetic authority test')`;
    await database.sql`insert into public.org_members(org_id, user_id, role) values(${orgId}, ${issuerUserId}, 'owner')`;
    await database.sql`insert into public.ads_connections(id, org_id, label, status)
      values(${connectionId}, ${orgId}, 'Synthetic connection', 'active')`;
    await database.sql`insert into public.ad_profiles(id, org_id, connection_id, amazon_profile_id,
      region, country_code, currency_code, timezone, sync_enabled)
      values(${profileId}, ${orgId}, ${connectionId}, ${profileId}, 'NA', 'US', 'USD', 'UTC', true)`;
    const d = McpWriteDelegation.parse({ schemaVersion: 'openspell.mcp-write-delegation.v1',
      versionId: randomUUID(), keyId: randomUUID(), keyLabel: 'Synthetic integration', orgId, issuerUserId,
      profiles: [{ profileId, currencyCode: 'USD' }], issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      limits: { action: 'keyword.bid', maximumRowsPerCall: 2, maximumRowsPerUtcDay: 3,
        maximumAbsoluteDeltaByCurrency: [{ amount: '0.03', currencyCode: 'USD' }], maximumRelativeDelta: '0.1' },
      fingerprint: '0'.repeat(64) });
    return { ...d, fingerprint: hash(serializeMcpWriteDelegationFingerprint(d)) };
  }

  // Raw JSON is intentional: these calls test the SQL boundary without trusting a TS parser.
  function material(raw: Record<string, unknown>) {
    const { fingerprint: _fingerprint, ...policy } = raw;
    const preimage = JSON.stringify(['openspell.mcp-write-delegation-fingerprint.v1', policy]);
    return { artifact: { ...policy, fingerprint: hash(preimage) }, preimage };
  }
  async function issue(sql: Sql, raw: Record<string, unknown>) {
    const { artifact, preimage } = material(raw);
    const [row] = await sql<{ artifact: unknown }[]>`select app.issue_mcp_write_key_v1(
      ${JSON.stringify(artifact)}, ${preimage}, ${hash(String(raw['keyId']))}, ${['wza', 'synthet1'].join('_')}
    ) as artifact`;
    return row?.artifact;
  }
  async function counts(orgId: string) {
    const [row] = await database.sql<{ keys: number; delegations: number; issued: number; revoked: number; outbox: number }[]>`
      select (select count(*)::int from mcp.api_keys where org_id = ${orgId}) as keys,
        (select count(*)::int from mcp.write_delegations where org_id = ${orgId}) as delegations,
        (select count(*)::int from public.audit_log where org_id = ${orgId} and action = 'mcp.write_key.issued') as issued,
        (select count(*)::int from public.audit_log where org_id = ${orgId} and action = 'mcp.key.revoked') as revoked,
        (select count(*)::int from public.sp_write_outbox where org_id = ${orgId}) as outbox
    `;
    return row;
  }
  const empty = { keys: 0, delegations: 0, issued: 0, revoked: 0, outbox: 0 };

  it('atomically stores exact owner authority and a sanitized audit without enabling execution', async () => {
    const d = await fixture();
    const result = await asUser(database, d.issuerUserId, (sql) => issue(sql, d));
    expect(verifyMcpWriteDelegationFingerprint(result, hasher)).toEqual(d);
    expect(await counts(d.orgId)).toEqual({ ...empty, keys: 1, delegations: 1, issued: 1 });
    const [stored] = await database.sql<{ artifact_text: string; actor_id: string; payload: unknown; scope: string; created_by: string }[]>`
      select d.artifact_text, a.actor_id, a.payload, k.scope, k.created_by from mcp.write_delegations d
      join mcp.api_keys k on k.id = d.key_id join public.audit_log a on a.target_id = k.id::text
      where d.version_id = ${d.versionId} and a.action = 'mcp.write_key.issued'
    `;
    expect(stored?.artifact_text).toBe(JSON.stringify(d));
    expect(stored).toMatchObject({ actor_id: d.issuerUserId, created_by: d.issuerUserId, scope: 'write', payload: { delegation: d } });
    expect(JSON.stringify(stored?.payload)).not.toContain(hash(d.keyId));
    expect(JSON.stringify(stored?.payload)).not.toContain(['wza', 'synthet1'].join('_'));
    await asServiceRole(database, async (sql) => {
      expect(await sql`select version_id from mcp.write_delegations where version_id = ${d.versionId}`).toHaveLength(1);
      await expect(sql`update mcp.write_delegations set fingerprint = ${'a'.repeat(64)} where version_id = ${d.versionId}`)
        .rejects.toMatchObject({ code: '42501' });
    });
    await asUser(database, d.issuerUserId, async (sql) => {
      await expect(sql`select * from mcp.write_delegations`).rejects.toMatchObject({ code: '42501' });
      await expect(sql`select token_hash from mcp.api_keys`).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('accepts a current admin and refuses analyst, viewer, outsider, missing and service identity', async () => {
    const d = await fixture();
    for (const role of ['analyst', 'viewer', null] as const) {
      const actor = randomUUID();
      await database.sql`select public.auth_user_stub(${actor}::uuid)`;
      if (role) await database.sql`insert into public.org_members(org_id,user_id,role) values(${d.orgId},${actor},${role})`;
      await expect(asUser(database, actor, (sql) => issue(sql, { ...d, issuerUserId: actor })))
        .rejects.toMatchObject({ code: '42501' });
    }
    await expect(asAnon(database, (sql) => issue(sql, d))).rejects.toMatchObject({ code: '42501' });
    await expect(asServiceRole(database, (sql) => issue(sql, d))).rejects.toMatchObject({ code: '42501' });
    await expect(issue(database.sql, d)).rejects.toMatchObject({ code: '42501' });
    await expect(asUser(database, d.issuerUserId, (sql) => issue(sql, { ...d, issuerUserId: randomUUID() })))
      .rejects.toMatchObject({ code: '42501' });
    expect(await counts(d.orgId)).toEqual(empty);
    await database.sql`update public.org_members set role = 'admin' where org_id = ${d.orgId}`;
    expect(await asUser(database, d.issuerUserId, (sql) => issue(sql, d))).toEqual(d);
  });

  it('refuses malformed, enlarged, cross-tenant and noncanonical direct-RPC policy with zero side effects', async () => {
    const d = await fixture(); const foreign = await fixture();
    const invalid: Record<string, unknown>[] = [
      { ...d, extra: true }, { ...d, schemaVersion: null }, { ...d, fingerprint: null, keyLabel: null },
      { ...d, versionId: d.versionId.slice(0, 14) + '9' + d.versionId.slice(15) },
      { ...d, keyId: d.keyId.slice(0, 19) + '1' + d.keyId.slice(20) },
      ...['', '\t', '\u00a0name', 'name\ufeff', 'a'.repeat(161), '😀'.repeat(81)].map((keyLabel) => ({ ...d, keyLabel })),
      { ...d, profiles: [] }, { ...d, profiles: [d.profiles[0], d.profiles[0]] },
      { ...d, profiles: foreign.profiles },
      { ...d, profiles: [{ ...d.profiles[0], currencyCode: 'EUR' }] },
      { ...d, profiles: [{ ...d.profiles[0], extra: true }] },
      { ...d, profiles: [{ profileId: null, currencyCode: 'USD' }] },
      ...[null, 0, -1, 501, 1.2, '2'].map((maximumRowsPerCall) => ({ ...d, limits: { ...d.limits, maximumRowsPerCall } })),
      ...[null, 1, 2_147_483_648, 2.2, '3'].map((maximumRowsPerUtcDay) => ({ ...d, limits: { ...d.limits, maximumRowsPerUtcDay } })),
      ...['0', '-1', '01', '0.10', '0.0000001', '1e1', 0.1, null].map((maximumRelativeDelta) => ({ ...d, limits: { ...d.limits, maximumRelativeDelta } })),
      { ...d, limits: { ...d.limits, action: 'campaign.budget' } },
      { ...d, limits: { ...d.limits, maximumAbsoluteDeltaByCurrency: [] } },
      { ...d, limits: { ...d.limits, maximumAbsoluteDeltaByCurrency: [{ amount: '0', currencyCode: 'USD' }] } },
      { ...d, limits: { ...d.limits, maximumAbsoluteDeltaByCurrency: [{ amount: '1', currencyCode: 'EUR' }] } },
      { ...d, limits: { ...d.limits, maximumAbsoluteDeltaByCurrency: [...d.limits.maximumAbsoluteDeltaByCurrency, ...d.limits.maximumAbsoluteDeltaByCurrency] } },
      { ...d, issuedAt: new Date(Date.now() + 86_400_000).toISOString() },
      { ...d, expiresAt: d.issuedAt },
      { ...d, expiresAt: new Date(Date.parse(d.issuedAt) + 90 * 86_400_000 + 1).toISOString() },
      { ...d, expiresAt: null }, { ...d, issuedAt: 'yesterday' },
      { ...d, expiresAt: d.expiresAt.slice(0, 11) + '24:00:00.000Z' },
      { ...d, expiresAt: d.expiresAt.slice(0, 17) + '60.000Z' },
    ];
    for (const [index, raw] of invalid.entries()) {
      await expect(asUser(database, d.issuerUserId, (sql) => issue(sql, raw)), `case ${index}`).rejects.toThrow();
      expect(await counts(d.orgId), `case ${index}`).toEqual(empty);
    }
    const { artifact, preimage } = material(d);
    await asUser(database, d.issuerUserId, async (sql) => {
      await expect(sql`select app.issue_mcp_write_key_v1(${JSON.stringify(artifact)}, ${preimage + ' '}, ${hash(d.keyId)}, ${['wza', 'synthet1'].join('_')})`)
        .rejects.toMatchObject({ code: '22023' });
      await expect(sql`select app.issue_mcp_write_key_v1(${JSON.stringify(artifact)}, ${preimage}, ${'not-a-hash'}, ${['wza', 'synthet1'].join('_')})`)
        .rejects.toMatchObject({ code: '22023' });
      const pretty = JSON.stringify(JSON.parse(preimage), null, 2);
      await expect(sql`select app.issue_mcp_write_key_v1(${JSON.stringify({ ...artifact, fingerprint: hash(pretty) })},
        ${pretty}, ${hash(d.keyId)}, ${['wza', 'synthet1'].join('_')})`).rejects.toMatchObject({ code: '22023' });
    });
    expect(await counts(d.orgId)).toEqual(empty);
  });

  it('preserves canonical fingerprints for escaped, Unicode and maximum-length labels', async () => {
    for (const keyLabel of ['A "quoted" \\ label / slash', '内側\ntext\tinside', '😀'.repeat(80), 'x\u2028y\u2029z', 'a'.repeat(160)]) {
      const d = await fixture();
      const candidate = { ...d, keyLabel };
      const artifact = { ...candidate, fingerprint: hash(serializeMcpWriteDelegationFingerprint(candidate)) };
      expect(verifyMcpWriteDelegationFingerprint(await asUser(database, d.issuerUserId, (sql) => issue(sql, artifact)), hasher))
        .toEqual(artifact);
    }
  });

  it('uses exactly ninety elapsed days regardless of the SQL session timezone', async () => {
    const d = await fixture();
    const expiresAt = new Date(Date.parse(d.issuedAt) + 90 * 86_400_000).toISOString();
    await asUser(database, d.issuerUserId, async (sql) => {
      await sql`set time zone 'America/New_York'`;
      try {
        await expect(issue(sql, { ...d, expiresAt: new Date(Date.parse(expiresAt) + 1).toISOString() }))
          .rejects.toMatchObject({ code: '22023' });
        expect(verifyMcpWriteDelegationFingerprint(await issue(sql, { ...d, expiresAt }), hasher).expiresAt).toBe(expiresAt);
      } finally { await sql`reset time zone`; }
    });
  });

  it('prevents direct service issuance or permission expansion while preserving read keys and last-use tracking', async () => {
    const d = await fixture();
    await asUser(database, d.issuerUserId, (sql) => issue(sql, d));
    const readId = randomUUID();
    await asServiceRole(database, async (sql) => {
      await expect(sql`insert into mcp.api_keys(org_id,label,key_prefix,token_hash,scope)
        values(${d.orgId}, 'Bypass', 'test', ${hash('bypass')}, 'write')`).rejects.toMatchObject({ code: '42501' });
      await sql`insert into mcp.api_keys(id,org_id,label,key_prefix,token_hash,scope,profile_ids,expires_at)
        values(${readId},${d.orgId},'Read key','test',${hash(readId)},'read',${sql.array(d.profiles.map((p) => p.profileId))}::uuid[],now()+interval '1 day')`;
      await expect(sql`update mcp.api_keys set scope = 'write' where id = ${readId}`).rejects.toMatchObject({ code: '55000' });
      for (const statement of [
        sql`update mcp.api_keys set profile_ids = null where id = ${d.keyId}`,
        sql`update mcp.api_keys set expires_at = now() + interval '90 days' where id = ${d.keyId}`,
        sql`update mcp.api_keys set created_by = null where id = ${d.keyId}`,
        sql`update mcp.api_keys set token_hash = ${hash('replacement')} where id = ${d.keyId}`,
        sql`update mcp.api_keys set scope = 'read' where id = ${d.keyId}`,
      ]) await expect(statement).rejects.toMatchObject({ code: '55000' });
      await expect(sql`update mcp.api_keys set revoked_at = clock_timestamp() where id = ${d.keyId}`)
        .rejects.toMatchObject({ code: '42501' });
      await sql`update mcp.api_keys set last_used_at = clock_timestamp() where id = ${d.keyId}`;
      await sql`update mcp.api_keys set revoked_at = clock_timestamp() where id = ${readId}`;
    });
    expect(await counts(d.orgId)).toEqual({ ...empty, keys: 2, delegations: 1, issued: 1 });
  });

  it('revokes once under current operator authority and retains immutable delegation and audit evidence', async () => {
    const d = await fixture(); const foreign = await fixture();
    await asUser(database, d.issuerUserId, (sql) => issue(sql, d));
    await expect(asUser(database, foreign.issuerUserId, (sql) => sql`select app.revoke_mcp_key_v1(${d.orgId},${d.keyId})`))
      .rejects.toMatchObject({ code: '42501' });
    await asUser(database, d.issuerUserId, async (sql) => {
      expect((await sql<{ revoked: boolean }[]>`select app.revoke_mcp_key_v1(${d.orgId},${foreign.keyId}) as revoked`)[0]?.revoked).toBe(false);
      for (let i = 0; i < 2; i++) expect((await sql<{ revoked: boolean }[]>`select app.revoke_mcp_key_v1(${d.orgId},${d.keyId}) as revoked`)[0]?.revoked).toBe(true);
    });
    expect(await counts(d.orgId)).toEqual({ ...empty, keys: 1, delegations: 1, issued: 1, revoked: 1 });
    for (const statement of [
      database.sql`update mcp.api_keys set revoked_at = null where id = ${d.keyId}`,
      database.sql`delete from mcp.api_keys where id = ${d.keyId}`,
      database.sql`update mcp.write_delegations set artifact_text = artifact_text where version_id = ${d.versionId}`,
      database.sql`delete from mcp.write_delegations where version_id = ${d.versionId}`,
      database.sql`delete from public.audit_log where org_id = ${d.orgId} and action = 'mcp.write_key.issued'`,
      database.sql`update public.audit_log set payload = '{}'::jsonb where org_id = ${d.orgId} and action = 'mcp.key.revoked'`,
      database.sql`truncate mcp.write_delegations`,
    ]) await expect(statement).rejects.toMatchObject({ code: '55000' });
    await database.sql`delete from public.org_members where org_id = ${d.orgId}`;
    await expect(asUser(database, d.issuerUserId, (sql) => sql`select app.revoke_mcp_key_v1(${d.orgId},${d.keyId})`))
      .rejects.toMatchObject({ code: '42501' });
    await database.sql`delete from public.orgs where id = ${d.orgId}`;
    expect(await counts(d.orgId)).toEqual(empty);
  });

  it('rechecks membership after a concurrent downgrade and admits duplicate issuance at most once', async () => {
    const d = await fixture();
    const blocker = await database.sql.reserve();
    try {
      await blocker`begin`;
      await blocker`update public.org_members set role = 'analyst' where org_id = ${d.orgId} and user_id = ${d.issuerUserId}`;
      const pending = asUser(database, d.issuerUserId, (sql) => issue(sql, d)).then(
        () => ({ code: 'unexpected_success' }), (error: unknown) => error,
      );
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const [state] = await database.sql<{ blocked: boolean }[]>`select exists (
          select 1 from pg_catalog.pg_stat_activity where datname = current_database()
            and wait_event_type = 'Lock' and query like '%app.issue_mcp_write_key_v1%'
        ) as blocked`;
        blocked = state?.blocked === true;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await blocker`commit`;
      expect(await pending).toMatchObject({ code: '42501' });
      expect(blocked).toBe(true);
      expect(await counts(d.orgId)).toEqual(empty);
    } finally { await blocker`rollback`; blocker.release(); }
    await database.sql`update public.org_members set role = 'owner' where org_id = ${d.orgId}`;
    const results = await Promise.allSettled([
      asUser(database, d.issuerUserId, (sql) => issue(sql, d)),
      asUser(database, d.issuerUserId, (sql) => issue(sql, d)),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await counts(d.orgId)).toEqual({ ...empty, keys: 1, delegations: 1, issued: 1 });
  });

  it('rolls issuance and revocation back if the audit insert fails', async () => {
    const d = await fixture();
    await database.sql.unsafe(`create function app.reject_mcp_test_audit() returns trigger language plpgsql as $$
      begin raise exception 'synthetic audit failure' using errcode = '55000'; end; $$;
      create trigger mcp_test_audit before insert on public.audit_log for each row
      when (new.action in ('mcp.write_key.issued','mcp.key.revoked')) execute function app.reject_mcp_test_audit()`);
    try {
      await expect(asUser(database, d.issuerUserId, (sql) => issue(sql, d))).rejects.toThrow('synthetic audit failure');
      expect(await counts(d.orgId)).toEqual(empty);
    } finally { await database.sql.unsafe('drop trigger mcp_test_audit on public.audit_log'); }
    await asUser(database, d.issuerUserId, (sql) => issue(sql, d));
    await database.sql.unsafe(`create trigger mcp_test_audit before insert on public.audit_log for each row
      when (new.action = 'mcp.key.revoked') execute function app.reject_mcp_test_audit()`);
    try {
      await expect(asUser(database, d.issuerUserId, (sql) => sql`select app.revoke_mcp_key_v1(${d.orgId},${d.keyId})`))
        .rejects.toThrow('synthetic audit failure');
      expect((await database.sql<{ revoked_at: Date | null }[]>`select revoked_at from mcp.api_keys where id = ${d.keyId}`)[0]?.revoked_at).toBeNull();
      expect(await counts(d.orgId)).toEqual({ ...empty, keys: 1, delegations: 1, issued: 1 });
    } finally { await database.sql.unsafe('drop trigger mcp_test_audit on public.audit_log; drop function app.reject_mcp_test_audit()'); }
  });
});
