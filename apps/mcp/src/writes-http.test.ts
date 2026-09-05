import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { listTimeline } from '@wizard-ads/db';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { executeSyntheticKeywordWrite } from '@wizard-ads/db/testing/sp-write';
import { issueMcpWriteDelegation, revokeMcpKeyAsOperator } from '@wizard-ads/db/mcp-writes';
import { readSpWriteOperation } from '@wizard-ads/db/sp-write-application';
import { McpBidAdmission, McpBidPreview, McpWriteStatus } from '@wizard-ads/shared/mcp-writes';
import { generateToken, hashToken, issueApiKey } from './keys.js';
import { startHttpServer, type RunningServer } from './http.js';
import { configFromEnv } from './config.js';

const available = await databaseAvailable();
const toolNames = ['preview_bid_changes', 'apply_bid_changes', 'get_write_status'];
const resultSchema = z.object({ isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1) });

describe.skipIf(!available)('delegated writes over authenticated MCP HTTP', () => {
  let database: TestDatabase;
  let server: RunningServer;
  let actor: { orgId: string; userId: string };
  let profileId: string;
  let token: string;
  let keyId: string;
  const clients: Client[] = [];

  beforeEach(async () => {
    database = await createTestDatabase('mcp_write_http');
    const userId = randomUUID();
    const [org] = await database.sql<{ id: string }[]>`
      select app.seed_tenant_fixture(${randomUUID()},${userId},'owner') as id`;
    actor = { orgId: org!.id, userId };
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${actor.orgId}`;
    profileId = profile!.id;
    const grantVersion = randomUUID();
    await database.sql`insert into public.sp_write_profile_grant_versions
      (grant_id,version_id,org_id,profile_id,enabled,amazon_profile_id,connection_id,region,marketplace_id,currency_code,api_dialect,created_by)
      select grant_id,${grantVersion},org_id,profile_id,true,amazon_profile_id,connection_id,region,marketplace_id,currency_code,api_dialect,created_by
      from public.sp_write_profile_grant_versions where org_id = ${actor.orgId} and profile_id = ${profileId}`;
    await database.sql`update public.sp_write_profile_grant_heads set version_id = ${grantVersion}
      where org_id = ${actor.orgId} and profile_id = ${profileId}`;
    const gateVersion = randomUUID(); const mcpGateVersion = randomUUID();
    await database.sql`insert into public.sp_write_environment_gate_versions(version_id,enabled,max_unresolved_calls)
      values(${gateVersion},true,1)`;
    await database.sql`insert into public.sp_write_environment_gate_head(singleton,version_id) values(true,${gateVersion})`;
    await database.sql`insert into mcp.write_gate_versions(version_id,enabled) values(${mcpGateVersion},true)`;
    await database.sql`insert into mcp.write_gate_head(singleton,version_id) values(true,${mcpGateVersion})`;
    await database.sql`insert into public.keywords
      (org_id,profile_id,amazon_id,ad_product,state,campaign_id,ad_group_id,keyword_text,match_type,bid)
      select org_id,profile_id,'kw-2',ad_product,state,campaign_id,ad_group_id,'Synthetic second keyword',match_type,bid
      from public.keywords where org_id = ${actor.orgId} and profile_id = ${profileId} and amazon_id = 'kw-1'`;
    token = generateToken();
    keyId = (await issueMcpWriteDelegation(database, actor, {
      label: 'Synthetic HTTP integration', profileIds: [profileId],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), limits: { action: 'keyword.bid',
        maximumRowsPerCall: 2, maximumRowsPerUtcDay: 10, maximumRelativeDelta: '0.5',
        maximumAbsoluteDeltaByCurrency: [{ currencyCode: 'USD', amount: '0.3' }] },
    }, { tokenHash: hashToken(token), keyPrefix: token.slice(0, 12) })).keyId;
    server = await startHttpServer({ handle: database, config: { ...configFromEnv({
      WIZARD_ADS_MCP_DATABASE_URL: database.connectionString, OPENSPELL_MCP_WRITES_ENABLED: '1',
    }), host: '127.0.0.1', port: 0 } });
  }, 90_000);

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    await server?.close();
    await database?.drop();
  });

  async function connect(credential = token, dropApplyResponse = false) {
    let dropped = false;
    const client = new Client({ name: 'synthetic-mcp-write-client', version: '0.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${credential}` } },
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        const body = typeof init?.body === 'string' ? init.body : '';
        if (dropApplyResponse && !dropped && body.includes('"apply_bid_changes"')) {
          dropped = true;
          await response.text(); // The real HTTP response exists; deliberately discard it.
          throw new Error('Synthetic lost HTTP response');
        }
        return response;
      },
    }));
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const result = resultSchema.parse(await client.callTool({ name, arguments: args }));
    return { failed: result.isError === true, value: JSON.parse(result.content[0]!.text) as unknown };
  }

  function proposal() {
    return { requestId: randomUUID(), profileId, source: { kind: 'keyword_proposals',
      note: 'Synthetic HTTP proposal', rows: [
        { keywordId: 'kw-2', expectedBid: '0.9', requestedBid: '0.8' },
        { keywordId: 'kw-1', expectedBid: '0.9', requestedBid: '0.8' },
      ] } };
  }

  async function prepare(client: Client) {
    const result = await call(client, 'preview_bid_changes', proposal());
    expect(result.failed).toBe(false);
    const preview = McpBidPreview.parse(result.value);
    return { preview, request: { requestId: randomUUID(), profileId,
      planId: preview.preview.plan.id, planFingerprint: preview.preview.plan.fingerprint } };
  }

  async function counts() {
    const [row] = await database.sql`select
      (select count(*)::int from mcp.write_admissions where org_id = ${actor.orgId}) as admissions,
      (select coalesce(sum(reserved_rows),0)::int from mcp.write_admissions where org_id = ${actor.orgId}) as charged,
      (select count(*)::int from public.audit_log where org_id = ${actor.orgId} and action = 'mcp.bid_apply.admitted') as audits,
      (select count(*)::int from public.sp_write_execution_requests request join mcp.write_admissions admission
        using(org_id,profile_id,execution_id,plan_id,approval_id,generation) where request.org_id = ${actor.orgId}) as queued`;
    return { ...row };
  }

  it('exposes write tools only to explicitly enabled write credentials, retaining read-key analytics', async () => {
    const writeClient = await connect();
    expect((await writeClient.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(toolNames));
    const read = await issueApiKey(database, { orgId: actor.orgId, label: 'Synthetic read caller',
      profileIds: [profileId], expiresAt: new Date(Date.now() + 3_600_000) });
    const readClient = await connect(read.token);
    const names = (await readClient.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('list_profiles');
    expect(names.filter((name) => toolNames.includes(name))).toEqual([]);
    expect(await readClient.callTool({ name: 'preview_bid_changes', arguments: proposal() })).toMatchObject({ isError: true });
    const [attempt] = await database.sql`select actor_id from public.audit_log
      where org_id = ${actor.orgId} and action = 'mcp.preview_bid_changes.attempt'`;
    expect(attempt?.actor_id).toBe(read.record.id);
    await server.close();
    server = await startHttpServer({ handle: database, config: { ...configFromEnv({
      WIZARD_ADS_MCP_DATABASE_URL: database.connectionString,
    }), host: '127.0.0.1', port: 0 } });
    await expect(connect()).rejects.toThrow();
    expect((await (await connect(read.token)).listTools()).tools.map((tool) => tool.name)).toContain('list_profiles');
  });

  it('completes HTTP preview/apply/status/inverse and retains four exact Time Machine entries', async () => {
    const client = await connect();
    const { preview, request } = await prepare(client);
    const admitted = await call(client, 'apply_bid_changes', request);
    expect(admitted.failed).toBe(false);
    const admission = McpBidAdmission.parse(admitted.value);
    const queued = McpWriteStatus.parse((await call(client, 'get_write_status', { profileId,
      lookup: { kind: 'apply_request', requestId: request.requestId } })).value);
    if (queued.kind !== 'found') throw new Error('HTTP admission missing');
    expect(queued.execution).toEqual(await readSpWriteOperation(database, actor, { profileId, ...admission.operation }));
    expect(queued.capacity).toMatchObject({ requested: 2, reserved: 2, attempted: 0, observed: 0 });
    await executeSyntheticKeywordWrite(database, preview.preview.plan, queued.execution.receipt, 'accepted', 'native_receipt');
    const inverse = McpBidPreview.parse((await call(client, 'preview_bid_changes', {
      requestId: randomUUID(), profileId, source: { kind: 'inverse', original: admission.operation },
    })).value);
    const inverseAdmission = McpBidAdmission.parse((await call(client, 'apply_bid_changes', {
      requestId: randomUUID(), profileId, planId: inverse.preview.plan.id, planFingerprint: inverse.preview.plan.fingerprint,
    })).value);
    const inverseStatus = McpWriteStatus.parse((await call(client, 'get_write_status', {
      profileId, lookup: { kind: 'operation', ...inverseAdmission.operation },
    })).value);
    if (inverseStatus.kind !== 'found') throw new Error('HTTP inverse admission missing');
    await executeSyntheticKeywordWrite(database, inverse.preview.plan, inverseStatus.execution.receipt, 'accepted', 'native_receipt');
    const final = McpWriteStatus.parse((await call(client, 'get_write_status', {
      profileId, lookup: { kind: 'operation', ...inverseAdmission.operation },
    })).value);
    expect(final).toMatchObject({ kind: 'found', capacity: { reserved: 2, attempted: 2, accepted: 2, observed: 2, refused: 0 } });
    expect(await counts()).toEqual({ admissions: 2, charged: 4, audits: 2, queued: 2 });
    const history = await listTimeline(database, { orgId: actor.orgId, profileId });
    const native = history.filter((item) => item.write?.execution.operation.executionId === admission.operation.executionId);
    expect(native).toHaveLength(4);
    for (const entry of native) {
      expect(entry.write?.actor).toMatchObject({ kind: 'mcp_key', keyId, userId: actor.userId });
      const operation = entry.write!.execution;
      if (operation.operation.planId === admission.operation.planId) expect(operation.inverses).toEqual([inverseAdmission.operation]);
      else expect(operation.original).toEqual(admission.operation);
    }
    const bids = await database.sql<{ bid: string }[]>`select bid::text from public.keywords
      where org_id = ${actor.orgId} and profile_id = ${profileId} and amazon_id in ('kw-1','kw-2')`;
    expect([...bids].map((row) => Number(row.bid))).toEqual([0.9,0.9]);
    const audits = await database.sql`select payload from public.audit_log where org_id = ${actor.orgId}`;
    expect(JSON.stringify(audits)).not.toContain(token);
    expect(JSON.stringify(audits)).not.toContain(hashToken(token));
  });

  it('recovers a deliberately lost HTTP apply response without another charge or execution', async () => {
    const client = await connect(token, true);
    const { request } = await prepare(client);
    await expect(client.callTool({ name: 'apply_bid_changes', arguments: request })).rejects.toThrow('Synthetic lost HTTP response');
    const recoveredClient = await connect();
    const recovered = McpWriteStatus.parse((await call(recoveredClient, 'get_write_status', {
      profileId, lookup: { kind: 'apply_request', requestId: request.requestId },
    })).value);
    if (recovered.kind !== 'found') throw new Error('lost HTTP admission not recovered');
    const replay = McpBidAdmission.parse((await call(recoveredClient, 'apply_bid_changes', request)).value);
    expect(replay.operation).toEqual(recovered.execution.operation);
    expect(await counts()).toEqual({ admissions: 1, charged: 2, audits: 1, queued: 1 });
  });

  it('audits SDK-rejected spoofed input without retaining arbitrary input or preparing a source', async () => {
    const client = await connect();
    const privateInput = 'synthetic-arbitrary-private-input';
    expect(await client.callTool({ name: 'preview_bid_changes', arguments: {
      ...proposal(), issuerUserId: actor.userId, credential: privateInput,
    } })).toMatchObject({ isError: true });
    const [source] = await database.sql`select count(*)::int as count from mcp.write_previews where org_id = ${actor.orgId}`;
    expect(source?.count).toBe(0);
    const attempts = await database.sql`select actor_id,payload from public.audit_log
      where org_id = ${actor.orgId} and action = 'mcp.preview_bid_changes.attempt'`;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.actor_id).toBe(keyId);
    expect(JSON.stringify(attempts)).not.toContain(privateInput);
  });

  it('rolls back admission on audit failure and returns uncertainty with the original client ID', async () => {
    const client = await connect(); const { request } = await prepare(client);
    await database.sql.unsafe(`create function app.synthetic_refuse_http_admission_audit() returns trigger
      language plpgsql as $$ begin raise exception 'Synthetic admission audit unavailable'; end; $$;
      create trigger synthetic_refuse_http_admission_audit before insert on public.audit_log
      for each row when (new.action = 'mcp.bid_apply.admitted') execute function app.synthetic_refuse_http_admission_audit();`);
    const response = await call(client, 'apply_bid_changes', request);
    expect(response.failed).toBe(true);
    expect(response.value).toMatchObject({ error: 'outcome_unknown', requestId: request.requestId });
    expect(JSON.stringify(response.value)).not.toContain('nothing was changed');
    expect(await counts()).toEqual({ admissions: 0, charged: 0, audits: 0, queued: 0 });
  });

  it('stops before SDK execution when the attempt audit cannot be persisted', async () => {
    const client = await connect();
    await database.sql.unsafe(`create function app.synthetic_refuse_http_attempt() returns trigger
      language plpgsql as $$ begin raise exception 'Synthetic attempt audit unavailable'; end; $$;
      create trigger synthetic_refuse_http_attempt before insert on public.audit_log
      for each row when (new.action = 'mcp.preview_bid_changes.attempt') execute function app.synthetic_refuse_http_attempt();`);
    await expect(client.callTool({ name: 'preview_bid_changes', arguments: proposal() })).rejects.toThrow();
    const [sources] = await database.sql`select count(*)::int as count from mcp.write_previews where org_id = ${actor.orgId}`;
    expect(sources?.count).toBe(0);
    expect(await counts()).toEqual({ admissions: 0, charged: 0, audits: 0, queued: 0 });
  });

  it('keeps own status readable after issuer downgrade, refuses new admission and rejects revoked bearer access', async () => {
    const client = await connect(); const { request } = await prepare(client);
    const admission = McpBidAdmission.parse((await call(client, 'apply_bid_changes', request)).value);
    const next = await prepare(client);
    await database.sql`update public.org_members set role = 'viewer' where org_id = ${actor.orgId} and user_id = ${actor.userId}`;
    expect(McpWriteStatus.parse((await call(client, 'get_write_status', {
      profileId, lookup: { kind: 'operation', ...admission.operation },
    })).value).kind).toBe('found');
    expect((await call(client, 'apply_bid_changes', next.request)).value).toMatchObject({ error: 'authorization_refused' });
    await database.sql`update public.org_members set role = 'owner' where org_id = ${actor.orgId} and user_id = ${actor.userId}`;
    await revokeMcpKeyAsOperator(database, actor, keyId);
    await expect(client.callTool({ name: 'get_write_status', arguments: {
      profileId, lookup: { kind: 'apply_request', requestId: request.requestId },
    } })).rejects.toThrow();
    expect(await counts()).toEqual({ admissions: 1, charged: 2, audits: 1, queued: 1 });
  });
});
