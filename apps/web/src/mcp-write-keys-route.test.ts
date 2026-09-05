import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { McpWriteKeyIssued } from '@wizard-ads/shared/mcp-writes';
import { POST as issueRoute } from '../app/api/mcp-keys/write/route';
import { POST as revokeRoute } from '../app/api/mcp-keys/[keyId]/revoke/route';
import { issueMcpKey, listMcpKeys, listMcpWriteKeys } from './data/mcp-keys';

const available = await databaseAvailable();
const bridge = 'synthetic-write-key-route-bridge';
const origin = 'http://localhost:3000';

describe.skipIf(!available)('operator MCP write key HTTP boundary', () => {
  let database: TestDatabase;
  const owner = randomUUID(); const foreignOwner = randomUUID(); const analyst = randomUUID();
  let orgId = ''; let foreignOrgId = ''; let profileId = ''; let foreignProfileId = '';
  const variables = ['DATABASE_URL', 'WIZARD_ADS_AUTH_BRIDGE_SECRET', 'WIZARD_ADS_E2E_AUTH_BRIDGE', 'WIZARD_ADS_APP_URL'] as const;
  const previous = Object.fromEntries(variables.map((name) => [name, process.env[name]]));
  const actor = () => ({ orgId, userId: owner });
  const policy = () => ({ label: 'Synthetic write integration', profileIds: [profileId],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    limits: { action: 'keyword.bid', maximumRowsPerCall: 2, maximumRowsPerUtcDay: 3,
      maximumAbsoluteDeltaByCurrency: [{ amount: '0.03', currencyCode: 'USD' }], maximumRelativeDelta: '0.1' } });
  function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
    return new Request(`${origin}${path}`, { method: 'POST', headers: {
      origin, 'content-type': 'application/json', 'x-wizard-ads-auth-bridge': bridge,
      'x-wizard-ads-user-id': owner, 'x-wizard-ads-org-id': orgId, ...headers,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  const issue = (body: unknown = policy(), headers: Record<string, string> = {}) =>
    issueRoute(request('/api/mcp-keys/write', body, headers));
  const revoke = (keyId: string, headers: Record<string, string> = {}) =>
    revokeRoute(request(`/api/mcp-keys/${keyId}/revoke`, undefined, headers), { params: Promise.resolve({ keyId }) });
  async function counts() {
    const [row] = await database.sql<{ keys: number; delegations: number; audits: number; wakes: number }[]>`
      select (select count(*)::int from mcp.api_keys) as keys,
        (select count(*)::int from mcp.write_delegations) as delegations,
        (select count(*)::int from public.audit_log where action like 'mcp.%') as audits,
        (select count(*)::int from public.sp_write_outbox) as wakes
    `;
    return row!;
  }
  beforeAll(async () => {
    database = await createTestDatabase('mcp_write_key_http');
    for (const [slug, userId] of [['write-key-http-alpha', owner], ['write-key-http-bravo', foreignOwner]] as const) {
      const [row] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${slug}, ${userId}, 'owner') as id`;
      const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id = ${row!.id}`;
      if (userId === owner) { orgId = row!.id; profileId = profile!.id; }
      else { foreignOrgId = row!.id; foreignProfileId = profile!.id; }
    }
    await database.sql`select public.auth_user_stub(${analyst}::uuid)`;
    await database.sql`insert into public.org_members(org_id,user_id,role) values(${orgId},${analyst},'analyst')`;
    process.env['DATABASE_URL'] = database.connectionString;
    process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] = bridge;
    process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'] = '1';
    process.env['WIZARD_ADS_APP_URL'] = origin;
  }, 60_000);
  afterAll(async () => {
    for (const name of variables) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
    await database?.drop();
  });

  it('issues one bounded token, stores only its digest and exposes retained policy through the loader', async () => {
    const before = await counts();
    const response = await issue();
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const issued = McpWriteKeyIssued.parse(await response.json());
    expect(issued.delegation).toMatchObject({ orgId, issuerUserId: owner, profiles: [{ profileId, currencyCode: 'USD' }], limits: policy().limits });
    const [stored] = await database.sql<{ token_hash: string; key_prefix: string; scope: string }[]>`
      select token_hash, key_prefix, scope from mcp.api_keys where id = ${issued.delegation.keyId}
    `;
    expect(stored).toEqual({ token_hash: createHash('sha256').update(issued.token).digest('hex'), key_prefix: issued.token.slice(0, 12), scope: 'write' });
    const listed = await listMcpWriteKeys(database, actor());
    expect(listed).toEqual([{ delegation: issued.delegation, revokedAt: null, lastUsedAt: null }]);
    expect(JSON.stringify(listed)).not.toContain(issued.token);
    expect(await listMcpWriteKeys(database, { orgId, userId: foreignOwner })).toEqual([]);
    expect(await listMcpWriteKeys(database, { orgId, userId: analyst })).toEqual([]);
    const audit = await database.sql`select actor_type,actor_id,payload from public.audit_log where target_id = ${issued.delegation.keyId}`;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_type: 'user', actor_id: owner, payload: { delegation: issued.delegation } });
    expect(JSON.stringify(audit)).not.toContain(issued.token);
    expect(await counts()).toEqual({ keys: before.keys + 1, delegations: before.delegations + 1, audits: before.audits + 1, wakes: before.wakes });
  });

  it('rejects forged identity, foreign scope, bad limits and unbounded bodies without adding any row', async () => {
    const before = await counts();
    const attempts: [unknown, Record<string, string>, number][] = [
      [{ ...policy(), issuerUserId: owner }, {}, 400], [{ ...policy(), orgId: foreignOrgId }, {}, 400],
      [{ ...policy(), tokenHash: 'a'.repeat(64) }, {}, 400],
      [{ ...policy(), profileIds: [foreignProfileId] }, {}, 403],
      [{ ...policy(), limits: { ...policy().limits, maximumRowsPerCall: 4 } }, {}, 400],
      [{ ...policy(), expiresAt: new Date(Date.now() + 91 * 86_400_000).toISOString() }, {}, 400],
      [policy(), { origin: 'https://elsewhere.example.test' }, 403],
      [policy(), { 'x-wizard-ads-user-id': analyst }, 403],
      [policy(), { 'x-wizard-ads-org-id': foreignOrgId }, 403],
      [policy(), { 'content-type': 'text/plain' }, 415],
      [policy(), { 'content-length': '16385' }, 413],
      [{ ...policy(), label: 'x'.repeat(17_000) }, {}, 413],
    ];
    for (const [body, headers, status] of attempts) {
      const response = await issue(body, headers);
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await counts()).toEqual(before);
    }
    const bearerOnly = new Request(`${origin}/api/mcp-keys/write`, { method: 'POST', headers: {
      origin, 'content-type': 'application/json', authorization: `Bearer ${['wza', 'a'.repeat(43)].join('_')}`,
    }, body: JSON.stringify(policy()) });
    expect((await issueRoute(bearerOnly)).status).toBe(401);
    expect(await counts()).toEqual(before);
  });

  it('audits revocation once, keeps policy visible, and preserves the existing read-key revoke flow', async () => {
    const issued = McpWriteKeyIssued.parse(await (await issue()).json());
    const before = await counts();
    expect((await revoke(issued.delegation.keyId, { 'x-wizard-ads-org-id': foreignOrgId, 'x-wizard-ads-user-id': foreignOwner })).status).toBe(404);
    expect((await revoke(issued.delegation.keyId, { origin: 'https://elsewhere.example.test' })).status).toBe(403);
    expect((await revoke(issued.delegation.keyId, { 'x-wizard-ads-user-id': analyst })).status).toBe(403);
    for (let i = 0; i < 2; i++) {
      const response = await revoke(issued.delegation.keyId);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ revoked: true });
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    const retained = (await listMcpWriteKeys(database, actor())).find((key) => key.delegation.keyId === issued.delegation.keyId);
    expect(retained?.delegation).toEqual(issued.delegation);
    expect(retained?.revokedAt).not.toBeNull();
    expect(await counts()).toEqual({ ...before, audits: before.audits + 1 });
    const read = await issueMcpKey(database, { orgId, label: 'Synthetic read integration', profileIds: [profileId], createdBy: owner });
    expect((await revoke(read.record.id)).status).toBe(200);
    expect((await listMcpKeys(database, orgId)).find((key) => key.id === read.record.id)?.revokedAt).not.toBeNull();
  });

  it('sanitizes unknown commit outcomes and exposes no token when the audit transaction fails', async () => {
    const before = await counts();
    await database.sql.unsafe(`create function app.reject_web_key_audit() returns trigger language plpgsql as $$
      begin raise exception 'synthetic-private-sql-detail'; end; $$;
      create trigger web_key_audit_failure before insert on public.audit_log for each row
      when (new.action = 'mcp.write_key.issued') execute function app.reject_web_key_audit()`);
    try {
      const response = await issue();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: 'outcome_unknown' });
      expect(await counts()).toEqual(before);
    } finally { await database.sql.unsafe('drop trigger web_key_audit_failure on public.audit_log; drop function app.reject_web_key_audit()'); }
  });
});
