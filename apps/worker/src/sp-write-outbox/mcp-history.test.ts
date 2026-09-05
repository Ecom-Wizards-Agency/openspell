import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSpWriteAdapter, type SpWriteAdapter } from '@wizard-ads/ads-api/sp-write-adapter';
import { exportAcceptedRecommendations, listTimeline } from '@wizard-ads/db';
import {
  applyMcpBidChanges, issueMcpWriteDelegation, previewMcpBidChanges,
  readMcpWriteStatus, revokeMcpKeyAsOperator,
} from '@wizard-ads/db/mcp-writes';
import {
  approveAndQueueSpWrite, previewSpWrite, previewSpWriteInverse, readSpWriteOperation,
} from '@wizard-ads/db/sp-write-application';
import { createSpWriteOutboxLedger } from '@wizard-ads/db/sp-write-persistence';
import { reconcileSpWriteObservation } from '@wizard-ads/db/sp-write-worker';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import type { McpBidAdmission, McpWriteCredential } from '@wizard-ads/shared/mcp-writes';
import type { SpWriteOperationId, SpWritePreview } from '@wizard-ads/shared/sp-write-application';
import type { McpWriteDelegation } from '@wizard-ads/shared/sp-writes';
import { hasher, providerKey } from './artifacts.js';
import { createSpWriteOutboxLoop } from './loop.js';

const available = await databaseAvailable();
const OWNER = '34343434-3434-4434-8434-343434343434';
const REVIEWER = '35353535-3535-4535-8535-353535353535';
type IssuedKey = { credential: McpWriteCredential; delegation: McpWriteDelegation };

describe.skipIf(!available)('delegated writes in the real worker and Time Machine with a fake provider', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  let adapter: SpWriteAdapter;
  let dispatchEnabled: boolean;
  let providerUnavailable: boolean;
  let puts: number;
  let reads: number;
  let mutationRows: number[];
  let providerBids: Map<string, number>;
  let afterPut: (() => Promise<void>) | undefined;
  let afterRead: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    // Every mutation below targets this throwaway database, never a shared project.
    database = await createTestDatabase('mcp_worker_history');
    const [tenant] = await database.sql<{ org_id: string }[]>`
      select app.seed_tenant_fixture('mcp-worker-history', ${OWNER}, 'owner') as org_id`;
    orgId = tenant!.org_id;
    await database.sql`insert into auth.users (id) values (${REVIEWER}) on conflict do nothing`;
    await database.sql`insert into public.org_members (org_id, user_id, role) values (${orgId}, ${REVIEWER}, 'owner')`;
    const [profile] = await database.sql<{ id: string }[]>`
      select id::text from public.ad_profiles where org_id = ${orgId}`;
    profileId = profile!.id;
    // The old RLS fixture's completed observation wake is unrelated to this test.
    const outbox = createSpWriteOutboxLedger(database);
    const fixture = await outbox.claimAvailable({ claimantId: 'synthetic-history-cleanup', kinds: ['observe_and_recover'], limit: 1 });
    expect(fixture.claimedCount).toBe(1);
    expect((await outbox.completeClaim(fixture.claims[0]!)).kind).toBe('completed');
    const grantVersion = randomUUID();
    await database.sql`insert into public.sp_write_profile_grant_versions
      (grant_id, version_id, org_id, profile_id, enabled, amazon_profile_id, connection_id,
        region, marketplace_id, currency_code, api_dialect, created_by)
      select grant_id, ${grantVersion}, org_id, profile_id, true, amazon_profile_id, connection_id,
        region, 'ATVPDKIKX0DER', currency_code, api_dialect, created_by
      from public.sp_write_profile_grant_versions where org_id = ${orgId} and profile_id = ${profileId}`;
    await database.sql`update public.sp_write_profile_grant_heads set version_id = ${grantVersion}
      where org_id = ${orgId} and profile_id = ${profileId}`;
    const environmentVersion = randomUUID();
    await database.sql`insert into public.sp_write_environment_gate_versions (version_id, enabled, max_unresolved_calls)
      values (${environmentVersion}, true, 1)`;
    await database.sql`insert into public.sp_write_environment_gate_head (singleton, version_id) values (true, ${environmentVersion})`;
    const mcpVersion = randomUUID();
    await database.sql`insert into mcp.write_gate_versions (version_id, enabled) values (${mcpVersion}, true)`;
    await database.sql`insert into mcp.write_gate_head (singleton, version_id) values (true, ${mcpVersion})`;
    dispatchEnabled = true;
    providerUnavailable = false;
    puts = 0; reads = 0; mutationRows = []; providerBids = new Map(); afterPut = undefined; afterRead = undefined;
    adapter = createSpWriteAdapter({ region: 'NA', credentials: {
      clientId: 'synthetic-client', clientSecret: ['synthetic', 'secret'].join('-'), refreshToken: ['synthetic', 'refresh'].join('-'),
    }, fetch: async (url, init = {}) => {
      if (url.endsWith('/auth/o2/token')) return new Response(JSON.stringify({ access_token: 'synthetic', expires_in: 3600 }));
      if (init.method === 'PUT') {
        puts += 1;
        const body = JSON.parse(String(init.body)) as { keywords: Array<{ keywordId: string; bid: number }> };
        expect(body.keywords.length).toBeGreaterThan(0);
        expect(body.keywords.length).toBeLessThanOrEqual(100);
        mutationRows.push(body.keywords.length);
        for (const row of body.keywords) providerBids.set(row.keywordId, row.bid);
        await afterPut?.();
        return new Response(JSON.stringify({ keywords: {
          success: body.keywords.map((row, index) => ({ index, keywordId: row.keywordId })), error: [],
        } }), { status: 207 });
      }
      reads += 1;
      const body = JSON.parse(String(init.body)) as { keywordIdFilter: { include: string[] } };
      await afterRead?.();
      return new Response(JSON.stringify({ keywords: body.keywordIdFilter.include.map((keywordId) => ({
        keywordId, bid: providerBids.get(keywordId) ?? 0.9, state: 'ENABLED',
      })) }));
    } }, { hasher });
  }, 60_000);

  afterEach(async () => { await database?.drop(); });

  const actor = () => ({ orgId, userId: OWNER });
  const reviewer = () => ({ orgId, userId: REVIEWER });

  async function issue(label: string, lifetimeMs = 3_600_000): Promise<IssuedKey> {
    const tokenHash = createHash('sha256').update(randomUUID()).digest('hex');
    const delegation = await issueMcpWriteDelegation(database, actor(), {
      label, profileIds: [profileId], expiresAt: new Date(Date.now() + lifetimeMs).toISOString(),
      limits: { action: 'keyword.bid', maximumRowsPerCall: 500, maximumRowsPerUtcDay: 1_000,
        maximumAbsoluteDeltaByCurrency: [{ amount: '0.3', currencyCode: 'USD' }], maximumRelativeDelta: '0.5' },
    }, { tokenHash, keyPrefix: 'wza_syntheti' });
    return { credential: { orgId, keyId: delegation.keyId, tokenHash }, delegation };
  }

  async function keywords(count: number): Promise<string[]> {
    if (count > 1) {
      const inserted = await database.sql<{ amazon_id: string }[]>`insert into public.keywords
        (org_id, profile_id, amazon_id, ad_product, name, state, campaign_id, ad_group_id, keyword_text, match_type, bid)
        select k.org_id, k.profile_id, 'kw-' || n::text, k.ad_product, 'Synthetic history keyword', k.state,
          k.campaign_id, k.ad_group_id, 'synthetic history keyword', k.match_type, k.bid
        from public.keywords k cross join generate_series(2, ${count}::int) n
        where k.org_id = ${orgId} and k.profile_id = ${profileId} and k.amazon_id = 'kw-1'
        returning amazon_id`;
      expect(inserted).toHaveLength(count - 1);
    }
    return Array.from({ length: count }, (_, index) => `kw-${index + 1}`);
  }

  async function forward(key: IssuedKey, count = 2) {
    const ids = await keywords(count);
    const prepared = await previewMcpBidChanges(database, key.credential, {
      requestId: randomUUID(), profileId, source: { kind: 'keyword_proposals', note: 'Synthetic delegated worker proof',
        rows: ids.reverse().map((keywordId) => ({ keywordId, expectedBid: '0.9', requestedBid: '0.8' })) },
    });
    expect(prepared.preview.plan.actions).toHaveLength(count);
    expect(prepared.preview.plan.actions.map((action) => action.entity)).toEqual(ids.map((keywordId) => ({ keywordId })));
    return { preview: prepared.preview, admission: await apply(key, prepared.preview) };
  }

  async function apply(key: IssuedKey, preview: SpWritePreview): Promise<McpBidAdmission> {
    const request = { requestId: randomUUID(), profileId, planId: preview.plan.id, planFingerprint: preview.plan.fingerprint };
    const admission = await applyMcpBidChanges(database, key.credential, request);
    expect(admission).toMatchObject({ kind: 'queued', reservation: { rows: preview.plan.counts.providerRows, releasedRows: 0 } });
    const status = await readMcpWriteStatus(database, key.credential, { profileId, lookup: { kind: 'apply_request', requestId: request.requestId } });
    expect(status.kind).toBe('found');
    if (status.kind !== 'found') throw new Error('new admission cannot be recovered');
    expect(status.execution.operation).toEqual(admission.operation);
    expect(status.execution.receipt).toMatchObject({ approvalMode: 'delegated_mcp', mcpRequestId: request.requestId,
      approvalRequestId: admission.approvalRequestId, delegation: key.delegation });
    expect(admission.approvalRequestId).not.toBe(request.requestId);
    return admission;
  }

  async function humanApprove(preview: SpWritePreview) {
    return approveAndQueueSpWrite(database, reviewer(), { profileId, approval: {
      approvalRequestId: randomUUID(), plan: preview.binding, approvalMode: 'manual',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1', boundedAuthorization: null, preapprovedInversePlan: null,
    } });
  }

  async function humanForward() {
    const [run] = await database.sql<{ id: string }[]>`select id::text from public.recommendation_runs
      where org_id = ${orgId} and profile_id = ${profileId}`;
    const recommendationId = randomUUID();
    await database.sql`insert into public.recommendations
      (id, run_id, org_id, profile_id, reason, entity_type, entity_id, field, current_value, proposed_value, inputs, status)
      values (${recommendationId}, ${run!.id}, ${orgId}, ${profileId}, 'high_acos', 'keyword', 'kw-1',
        'bid', '0.9'::jsonb, '0.8'::jsonb, '{}'::jsonb, 'accepted')`;
    const exported = await exportAcceptedRecommendations(database, { orgId, profileId, runId: run!.id, ids: [recommendationId],
      tag: randomUUID(), optGroup: 'synthetic', lever: 'bid-down', note: 'Synthetic UI original', actorId: REVIEWER });
    const preview = await previewSpWrite(database, reviewer(), { requestId: randomUUID(), profileId, applyBatchId: exported.batchId });
    expect(preview.plan.schemaVersion).toBe('openspell.sp-write-plan.v1');
    return { preview, admission: await humanApprove(preview) };
  }

  function worker() {
    return createSpWriteOutboxLoop({ database, claimantId: 'synthetic-mcp-history-worker',
      policy: () => ({ dispatchEnabled, reconcileEnabled: true, profileIds: [profileId] }),
      prepareProviders: async (plans) => providerUnavailable ? new Map() : new Map(plans.map((plan) => [providerKey(plan), adapter])),
      reconcileObservation: async (observation) => {
        const receipt = await reconcileSpWriteObservation(database, observation);
        expect(['promoted', 'already_current']).toContain(receipt.outcome);
        return true;
      },
    });
  }

  const detail = (operation: SpWriteOperationId) => readSpWriteOperation(database, reviewer(), { profileId, ...operation });
  const history = (operation: SpWriteOperationId) => listTimeline(database, { orgId, profileId, operation });
  const keyActor = (key: IssuedKey) => ({ kind: 'mcp_key', userId: OWNER,
    keyId: key.delegation.keyId, delegationVersionId: key.delegation.versionId });

  async function finish(loop: ReturnType<typeof worker>, operation: SpWriteOperationId, count: number) {
    expect(await loop.tick()).toEqual({ kind: 'completed', attemptedCalls: Math.ceil(count / 100) });
    for (let chunk = 0; chunk < Math.ceil(count / 100); chunk += 1) {
      expect(await loop.tick()).toEqual({ kind: 'completed', attemptedCalls: 0 });
    }
    expect((await detail(operation)).snapshot).toMatchObject({ status: 'succeeded', accounting: {
      approvedRows: count, pendingDispatch: 0, refusedBeforeDispatch: 0, intentCommitted: count,
      providerAccepted: count, observedRequested: count, pendingObservation: 0,
    } });
  }

  async function closeMcpGate() {
    const version = randomUUID();
    await database.sql`insert into mcp.write_gate_versions (version_id, enabled) values (${version}, false)`;
    await database.sql`update mcp.write_gate_head set version_id = ${version}`;
  }

  it('records two-row MCP forward and independently delegated inverse with exact restored values and durable key actors', async () => {
    const originalKey = await issue('Synthetic forward key');
    const original = await forward(originalKey);
    const loop = worker();
    const before = await history(original.admission.operation);
    expect(before).toHaveLength(2);
    expect(before.every((entry) => entry.write?.phase === 'queued' && entry.batch === null)).toBe(true);
    await finish(loop, original.admission.operation, 2);
    await revokeMcpKeyAsOperator(database, actor(), originalKey.delegation.keyId);
    const inverseKey = await issue('Synthetic independent inverse key');
    const inverse = await previewMcpBidChanges(database, inverseKey.credential, {
      requestId: randomUUID(), profileId, source: { kind: 'inverse', original: original.admission.operation },
    });
    const inverseAdmission = await apply(inverseKey, inverse.preview);
    expect(inverseAdmission.operation.executionId).toBe(original.admission.operation.executionId);
    await finish(loop, inverseAdmission.operation, 2);
    expect(puts).toBe(2); expect(reads).toBe(4); expect(mutationRows).toEqual([2, 2]);
    expect([...providerBids.values()]).toEqual([0.9, 0.9]);
    const restored = await database.sql<{ bid: string }[]>`select bid::text from public.keywords
      where org_id = ${orgId} and profile_id = ${profileId} and amazon_id in ('kw-1', 'kw-2')`;
    expect(restored).toEqual([{ bid: '0.9000' }, { bid: '0.9000' }]);
    const originalHistory = await history(original.admission.operation);
    const inverseHistory = await history(inverseAdmission.operation);
    expect(originalHistory.map((entry) => entry.id)).toEqual(before.map((entry) => entry.id));
    expect(originalHistory).toHaveLength(2); expect(inverseHistory).toHaveLength(2);
    for (const entry of originalHistory) expect(entry.write).toMatchObject({ actor: keyActor(originalKey), phase: 'observed_requested',
      execution: { inverses: [inverseAdmission.operation] }, inverseSummaries: [{ operation: inverseAdmission.operation,
        snapshot: { status: 'succeeded', accounting: { observedRequested: 2 } } }] });
    for (const entry of inverseHistory) expect(entry.write).toMatchObject({ actor: keyActor(inverseKey), direction: 'inverse',
      phase: 'observed_requested', execution: { original: original.admission.operation } });
    for (const entry of [...originalHistory, ...inverseHistory]) expect(entry.write?.mirrorReceipt?.entityChangeId).toEqual(expect.any(String));
    expect(new Set([...originalHistory, ...inverseHistory].map((entry) => entry.write?.mirrorReceipt?.entityChangeId)).size).toBe(4);
    const status = await readMcpWriteStatus(database, inverseKey.credential, {
      profileId, lookup: { kind: 'operation', ...inverseAdmission.operation },
    });
    expect(status).toMatchObject({ kind: 'found', capacity: { requested: 2, reserved: 2, attempted: 2,
      accepted: 2, observed: 2, refused: 0, released: 0 } });
    expect((await detail(original.admission.operation)).receipt).toMatchObject({ delegation: originalKey.delegation,
      reservation: { rows: 2, releasedRows: 0 } });
  });

  it.each(['MCP original and UI inverse', 'UI original and MCP inverse'] as const)('preserves separate actors for %s', async (kind) => {
    const key = await issue('Synthetic mixed approval key');
    const original = kind === 'MCP original and UI inverse' ? await forward(key, 1) : await humanForward();
    const loop = worker();
    await finish(loop, original.admission.operation, 1);
    if (kind === 'MCP original and UI inverse') await revokeMcpKeyAsOperator(database, actor(), key.delegation.keyId);
    const inverse = kind === 'MCP original and UI inverse'
      ? await previewSpWriteInverse(database, reviewer(), { requestId: randomUUID(), profileId, original: original.admission.operation })
      : (await previewMcpBidChanges(database, key.credential, {
        requestId: randomUUID(), profileId, source: { kind: 'inverse', original: original.admission.operation },
      })).preview;
    const inverseAdmission = kind === 'MCP original and UI inverse' ? await humanApprove(inverse) : await apply(key, inverse);
    expect(inverseAdmission.operation.executionId).toBe(original.admission.operation.executionId);
    await finish(loop, inverseAdmission.operation, 1);
    const originalHistory = await history(original.admission.operation);
    const inverseHistory = await history(inverseAdmission.operation);
    expect(originalHistory).toHaveLength(1); expect(inverseHistory).toHaveLength(1);
    const operatorActor = { kind: 'operator', userId: REVIEWER };
    expect(originalHistory[0]!.write?.actor).toEqual(kind === 'MCP original and UI inverse' ? keyActor(key) : operatorActor);
    expect(inverseHistory[0]!.write?.actor).toEqual(kind === 'MCP original and UI inverse' ? operatorActor : keyActor(key));
    expect(inverseHistory[0]!.write?.execution.original).toEqual(original.admission.operation);
    expect(originalHistory[0]!.write?.execution.inverses).toEqual([inverseAdmission.operation]);
    expect(providerBids.get('kw-1')).toBe(0.9); expect(puts).toBe(2);
    const [charged] = await database.sql<{ count: number; rows: number }[]>`select count(*)::int as count,
      sum((artifact #>> '{reservation,rows}')::int)::int as rows from public.sp_write_authorization_receipts
      where execution_id = ${original.admission.operation.executionId} and approval_mode = 'delegated_mcp'`;
    expect(charged).toEqual({ count: 1, rows: 1 });
  });

  it.each(['key', 'MCP gate', 'environment', 'profile', 'issuer'] as const)(
    'durably refuses every untouched row with zero provider reads when %s authority closes before preflight', async (kind) => {
      const key = await issue('Synthetic initial refusal key');
      const original = await forward(key);
      if (kind === 'key') await revokeMcpKeyAsOperator(database, actor(), key.delegation.keyId);
      if (kind === 'MCP gate') await closeMcpGate();
      if (kind === 'environment') {
        const version = randomUUID();
        await database.sql`insert into public.sp_write_environment_gate_versions (version_id, enabled, max_unresolved_calls) values (${version}, false, 1)`;
        await database.sql`update public.sp_write_environment_gate_head set version_id = ${version}`;
      }
      if (kind === 'profile') await database.sql`update public.ad_profiles set sync_enabled = false where id = ${profileId}`;
      if (kind === 'issuer') await database.sql`update public.org_members set role = 'viewer' where org_id = ${orgId} and user_id = ${OWNER}`;
      providerUnavailable = true;
      const loop = worker();
      expect(await loop.tick()).toEqual({ kind: 'completed', attemptedCalls: 0 });
      expect(puts).toBe(0); expect(reads).toBe(0);
      expect((await detail(original.admission.operation)).snapshot).toMatchObject({ status: 'refused', accounting: {
        approvedRows: 2, pendingDispatch: 0, refusedBeforeDispatch: 2, intentCommitted: 0,
        providerAccepted: 0, observedRequested: 0,
      } });
      const rows = await history(original.admission.operation);
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.write).toMatchObject({ actor: keyActor(key), phase: 'refused', observation: null,
        execution: { receipt: { reservation: { rows: 2, releasedRows: 0 } } } });
      expect(await loop.tick()).toEqual({ kind: 'idle', attemptedCalls: 0 });
    },
  );

  it('keeps expired delegated history readable and refuses without an adapter after the database authority window ends', async () => {
    const key = await issue('Synthetic short authority', 4_000);
    const original = await forward(key, 1);
    await delay(Math.max(0, Date.parse(key.delegation.expiresAt) - Date.now()) + 30);
    providerUnavailable = true;
    expect(await worker().tick()).toEqual({ kind: 'completed', attemptedCalls: 0 });
    expect((await detail(original.admission.operation)).snapshot).toMatchObject({ status: 'refused',
      accounting: { refusedBeforeDispatch: 1, intentCommitted: 0 } });
    expect((await history(original.admission.operation))[0]!.write?.actor).toEqual(keyActor(key));
    expect(puts).toBe(0); expect(reads).toBe(0);
  }, 15_000);

  it('retains paused dispatch until resumption, then settles the database MCP kill switch without provider access', async () => {
    const key = await issue('Synthetic paused authority');
    const original = await forward(key);
    const loop = worker();
    dispatchEnabled = false; await closeMcpGate(); providerUnavailable = true;
    // Local pause deliberately retains work. A stopped/paused worker does not promise immediate terminalization.
    expect((await loop.tick()).attemptedCalls).toBe(0);
    expect((await detail(original.admission.operation)).snapshot.accounting.pendingDispatch).toBe(2);
    dispatchEnabled = true;
    expect(await loop.tick()).toEqual({ kind: 'completed', attemptedCalls: 0 });
    expect((await detail(original.admission.operation)).snapshot.accounting.refusedBeforeDispatch).toBe(2);
    expect(puts).toBe(0); expect(reads).toBe(0);
  });

  it('preserves the first 100 intended rows through revocation and refuses the final untouched row before another provider read', async () => {
    const key = await issue('Synthetic chunk revocation key');
    const original = await forward(key, 101);
    afterPut = async () => {
      expect(puts).toBe(1);
      await revokeMcpKeyAsOperator(database, actor(), key.delegation.keyId);
    };
    const loop = worker();
    expect(await loop.tick()).toEqual({ kind: 'completed', attemptedCalls: 1 });
    expect(puts).toBe(1); expect(reads).toBe(1); expect(mutationRows).toEqual([100]);
    expect((await detail(original.admission.operation)).snapshot.accounting).toMatchObject({
      approvedRows: 101, pendingDispatch: 0, refusedBeforeDispatch: 1, intentCommitted: 100,
      providerAccepted: 100, pendingObservation: 100,
    });
    expect(await loop.tick()).toEqual({ kind: 'completed', attemptedCalls: 0 });
    expect((await detail(original.admission.operation)).snapshot.accounting).toMatchObject({
      approvedRows: 101, refusedBeforeDispatch: 1, providerCallsCommitted: 1, intentCommitted: 100,
      providerAccepted: 100, observedRequested: 100, pendingObservation: 0,
    });
    const rows = await history(original.admission.operation);
    expect(rows).toHaveLength(101);
    expect(rows.filter((row) => row.write?.phase === 'observed_requested')).toHaveLength(100);
    expect(rows.filter((row) => row.write?.phase === 'refused')).toHaveLength(1);
    for (const row of rows) expect(row.write).toMatchObject({ actor: keyActor(key),
      execution: { receipt: { reservation: { rows: 101, releasedRows: 0 } } } });
    expect(puts).toBe(1); expect(reads).toBe(2);
    expect(await loop.tick()).toEqual({ kind: 'idle', attemptedCalls: 0 });
  });

  it('rechecks canonical authority when revocation wins after the provider read and before intent reservation', async () => {
    const key = await issue('Synthetic reservation race key');
    const original = await forward(key);
    afterRead = async () => {
      expect(reads).toBe(1);
      await revokeMcpKeyAsOperator(database, actor(), key.delegation.keyId);
    };
    expect(await worker().tick()).toEqual({ kind: 'completed', attemptedCalls: 0 });
    expect(puts).toBe(0); expect(reads).toBe(1);
    expect((await detail(original.admission.operation)).snapshot.accounting).toMatchObject({
      approvedRows: 2, pendingDispatch: 0, refusedBeforeDispatch: 2, intentCommitted: 0,
      providerCallsCommitted: 0, providerAccepted: 0, observedRequested: 0,
    });
    const rows = await history(original.admission.operation);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.write).toMatchObject({ actor: keyActor(key), phase: 'refused', observation: null });
  });
});
