import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { McpBidPreviewRequest } from '@wizard-ads/shared/mcp-writes';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { asServiceRole, asUser } from '../testing/rls.js';
import { issueMcpWriteDelegation, revokeMcpKeyAsOperator } from './mcp-writes.js';
import { prepareMcpKeywordBidPreview } from './mcp-write-preview.js';
import { getExportBatch } from './recommendations.js';
import { listTimeline } from './time-machine.js';
import { approveAndQueueSpWrite, previewSpWriteInverse, readSpWriteOperation } from '../sp-write-application.js';
import { executeSyntheticKeywordWrite } from '../testing/sp-write-synthetic-execution.js';

const available = await databaseAvailable();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
describe.skipIf(!available)('controlled MCP keyword bid preview', () => {
  let database: TestDatabase;
  beforeAll(async () => { database = await createTestDatabase('mcp_preview'); }, 60_000);
  afterAll(async () => { await database?.drop(); });
  async function fixture() {
    const userId = randomUUID();
    const [tenant] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()}, ${userId}, 'owner') as id`;
    const orgId = tenant!.id;
    const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id = ${orgId}`;
    const profileId = profile!.id; const versionId = randomUUID();
    await database.sql`insert into public.sp_write_profile_grant_versions
      (grant_id,version_id,org_id,profile_id,enabled,amazon_profile_id,connection_id,region,marketplace_id,currency_code,api_dialect,created_by)
      select grant_id,${versionId},org_id,profile_id,true,amazon_profile_id,connection_id,region,marketplace_id,currency_code,api_dialect,created_by
      from public.sp_write_profile_grant_versions where org_id = ${orgId} and profile_id = ${profileId}`;
    await database.sql`update public.sp_write_profile_grant_heads set version_id = ${versionId} where org_id = ${orgId} and profile_id = ${profileId}`;
    const actor = { orgId, userId }; const tokenHash = hash(randomUUID());
    const delegation = await issueMcpWriteDelegation(database, actor, { label: 'Synthetic preview caller', profileIds: [profileId],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), limits: { action: 'keyword.bid', maximumRowsPerCall: 2,
        maximumRowsPerUtcDay: 3, maximumAbsoluteDeltaByCurrency: [{ amount: '0.2', currencyCode: 'USD' }], maximumRelativeDelta: '0.25' } },
    { tokenHash, keyPrefix: 'wza_syntheti' });
    const credential = { orgId, keyId: delegation.keyId, tokenHash };
    const request: McpBidPreviewRequest = { requestId: randomUUID(), profileId, source: { kind: 'keyword_proposals',
      note: 'Synthetic MCP preview', rows: [{ keywordId: 'kw-1', expectedBid: '0.9', requestedBid: '0.8' }] } };
    const initial = await counts(orgId);
    if (!initial) throw new Error('synthetic baseline missing');
    return { actor, credential, request, delegation, initial };
  }
  async function counts(orgId: string) {
    const [row] = await database.sql`select
      (select count(*)::int from mcp.write_previews where org_id = ${orgId}) as previews,
      (select count(*)::int from mcp.bid_proposal_sources where org_id = ${orgId}) as sources,
      (select count(*)::int from public.apply_batches where org_id = ${orgId} and source_kind = 'mcp_keyword_proposals') as batches,
      (select count(*)::int from public.apply_rows r join public.apply_batches b on b.id = r.batch_id
        where b.org_id = ${orgId} and b.source_kind = 'mcp_keyword_proposals') as rows,
      (select count(*)::int from public.audit_log where org_id = ${orgId} and action = 'mcp.bid_preview.prepared') as audits,
      (select count(*)::int from public.sp_write_outbox where org_id = ${orgId}) as outbox`;
    return row;
  }

  it('records exact source/evidence/audit once through the service role, with no approval or execution', async () => {
    const f = await fixture(); const orgId = f.actor.orgId;
    const before = await listTimeline(database, { orgId, profileId: f.request.profileId });
    const first = await asServiceRole(database, (sql) => prepareMcpKeywordBidPreview({ sql }, f.credential, f.request));
    expect(await counts(orgId)).toEqual({ ...f.initial, previews: 1, sources: 1, batches: 1, rows: 1, audits: 1 });
    expect(first.preview.evidence?.schemaVersion).toBe('openspell.sp-write-preview-evidence.v2');
    expect(first.delegation).toEqual(f.delegation);
    const action = first.preview.plan.actions[0]!;
    expect(action).toMatchObject({ changes: { bid: { expected: { amount: '0.9' }, requested: { amount: '0.8' } } } });
    expect(await prepareMcpKeywordBidPreview(database, f.credential, f.request)).toEqual(first);
    const batchId = first.preview.evidence!.provenance.applyBatchId;
    expect(await getExportBatch(database, { orgId, batchId })).toBeNull();
    expect(await listTimeline(database, { orgId, profileId: f.request.profileId })).toEqual(before);
    const [saved] = await database.sql`select r.recommendation_id, r.proposal_revision_id, r.old_value, r.new_value,
      a.actor_type, a.actor_id, a.payload from public.apply_rows r join public.audit_log a
      on a.org_id = r.org_id and a.target_id = ${first.preview.plan.id} and a.action = 'mcp.bid_preview.prepared'
      where r.batch_id = ${batchId}`;
    expect(saved).toMatchObject({ recommendation_id: null, proposal_revision_id: null, old_value: '0.9', new_value: '0.8',
      actor_type: 'mcp', actor_id: f.credential.keyId, payload: { issuerUserId: f.actor.userId, rows: 1 } });
    expect(JSON.stringify(saved)).not.toContain(f.credential.tokenHash);
  });

  it('serializes duplicate requests and rejects changed request content', async () => {
    const f = await fixture();
    const [first, second] = await Promise.all([prepareMcpKeywordBidPreview(database, f.credential, f.request),
      prepareMcpKeywordBidPreview(database, f.credential, f.request)]);
    expect(first).toEqual(second);
    expect(await counts(f.actor.orgId)).toEqual({ ...f.initial, previews: 1, sources: 1, batches: 1, rows: 1, audits: 1 });
    const changed = structuredClone(f.request);
    if (changed.source.kind === 'keyword_proposals') changed.source.rows[0]!.requestedBid = '0.79';
    await expect(prepareMcpKeywordBidPreview(database, f.credential, changed)).rejects.toMatchObject({ code: 'identity_conflict' });
  });

  it('refuses stale and unavailable keywords or excessive deltas with no source residue', async () => {
    const f = await fixture();
    for (const row of [
      { keywordId: 'kw-1', expectedBid: '0.89', requestedBid: '0.8' },
      { keywordId: 'missing-keyword', expectedBid: '0.9', requestedBid: '0.8' },
      { keywordId: 'kw-1', expectedBid: '0.9', requestedBid: '0.6' },
    ]) {
      await expect(prepareMcpKeywordBidPreview(database, f.credential, { ...f.request, requestId: randomUUID(),
        source: { kind: 'keyword_proposals', note: 'Synthetic refusal', rows: [row] } })).rejects.toBeInstanceOf(Error);
      expect(await counts(f.actor.orgId)).toEqual(f.initial);
    }
    await expect(prepareMcpKeywordBidPreview(database, f.credential, { ...f.request,
      source: { kind: 'keyword_proposals', note: 'Synthetic partial preparation refusal', rows: [
        { keywordId: 'kw-1', expectedBid: '0.9', requestedBid: '0.8' },
        { keywordId: 'missing-keyword', expectedBid: '0.9', requestedBid: '0.8' },
      ] } })).rejects.toMatchObject({ code: 'source_changed' });
    expect(await counts(f.actor.orgId)).toEqual(f.initial);
  });

  it('recovers a lost committed response by request ID without creating a second plan', async () => {
    const f = await fixture(); let lost = false;
    const sql = new Proxy(database.sql, { apply(target, receiver, args: unknown[]) {
      const statement = Array.isArray(args[0]) ? args[0].join(' ') : '';
      if (!lost && statement.includes('app.prepare_mcp_bid_proposals_v1(')) {
        lost = true;
        return Promise.resolve(Reflect.apply(target, receiver, args)).then(() => { throw new Error('synthetic lost response'); });
      }
      return Reflect.apply(target, receiver, args);
    } });
    const recovered = await prepareMcpKeywordBidPreview({ sql }, f.credential, f.request);
    expect(lost).toBe(true);
    expect(await prepareMcpKeywordBidPreview(database, f.credential, f.request)).toEqual(recovered);
    expect(await counts(f.actor.orgId)).toEqual({ ...f.initial, previews: 1, sources: 1, batches: 1, rows: 1, audits: 1 });
  });

  it('rechecks revocation at the SQL producer after the initial context read', async () => {
    const f = await fixture(); let revoked = false;
    const sql = new Proxy(database.sql, { apply(target, receiver, args: unknown[]) {
      const statement = Array.isArray(args[0]) ? args[0].join(' ') : '';
      if (!revoked && statement.includes('app.prepare_mcp_bid_proposals_v1(')) {
        revoked = true;
        return revokeMcpKeyAsOperator(database, f.actor, f.credential.keyId).then(() => Reflect.apply(target, receiver, args));
      }
      return Reflect.apply(target, receiver, args);
    } });
    await expect(prepareMcpKeywordBidPreview({ sql }, f.credential, f.request)).rejects.toMatchObject({ code: 'authorization_refused' });
    expect(revoked).toBe(true);
    expect(await counts(f.actor.orgId)).toEqual(f.initial);
  });

  it('retains a two-row source sequence through human execution and inverse after the source key is revoked', async () => {
    const f = await fixture();
    const cloned = await database.sql<{ amazon_id: string }[]>`insert into public.keywords
      (org_id,profile_id,amazon_id,ad_product,name,state,campaign_id,ad_group_id,keyword_text,match_type,bid)
      select org_id,profile_id,'kw-2',ad_product,'Synthetic second keyword',state,campaign_id,ad_group_id,
        'synthetic second keyword',match_type,bid
      from public.keywords where org_id = ${f.actor.orgId} and profile_id = ${f.request.profileId} and amazon_id = 'kw-1'
      returning amazon_id`;
    expect(cloned).toEqual([{ amazon_id: 'kw-2' }]);
    const proposed = [
      { keywordId: 'kw-2', expectedBid: '0.9', requestedBid: '0.8' },
      { keywordId: 'kw-1', expectedBid: '0.9', requestedBid: '0.75' },
    ];
    expect(proposed.map((row) => row.keywordId)).not.toEqual(proposed.map((row) => row.keywordId).sort((a, b) => a.localeCompare(b)));
    const request: McpBidPreviewRequest = { ...f.request, source: { kind: 'keyword_proposals', note: 'Synthetic source order proof', rows: proposed } };
    const { preview } = await prepareMcpKeywordBidPreview(database, f.credential, request);
    expect(preview.plan.schemaVersion).toBe('openspell.sp-write-plan.v2');
    if (preview.evidence?.schemaVersion !== 'openspell.sp-write-preview-evidence.v2') throw new Error('expected MCP proposal evidence');
    const sourceRows = preview.evidence.provenance.rows;
    expect(sourceRows.map(({ keywordId, expectedBid, requestedBid }) => ({ keywordId, expectedBid, requestedBid }))).toEqual(proposed);
    expect(preview.plan.actions.map((action) => action.routeKey === 'sp.v3.keywords.update' ? action.entity.keywordId : null))
      .toEqual(proposed.map((row) => row.keywordId));
    expect(preview.plan.actions.map((action) => action.sources)).toEqual(sourceRows.map((row) =>
      [{ kind: 'apply_row', applyRowId: row.applyRowId, changeKey: 'keyword.bid' }]));
    expect(preview.plan.counts).toEqual({ logicalChanges: 2, providerRows: 2, uniqueEntities: 2, byRoute: {
      'sp.v3.campaigns.update': 0, 'sp.v3.ad_groups.update': 0, 'sp.v3.keywords.update': 2,
      'sp.v3.targets.update': 0, 'sp.v3.product_ads.update': 0,
    } });
    expect(await counts(f.actor.orgId)).toEqual({ ...f.initial, previews: 1, sources: 1, batches: 1, rows: 2, audits: 1 });
    expect(await prepareMcpKeywordBidPreview(database, f.credential, request)).toEqual({ preview, delegation: f.delegation });
    await revokeMcpKeyAsOperator(database, f.actor, f.credential.keyId);
    const gate = randomUUID();
    await database.sql`insert into public.sp_write_environment_gate_versions(version_id, enabled, max_unresolved_calls) values (${gate},true,1)`;
    await database.sql`insert into public.sp_write_environment_gate_head(singleton,version_id) values(true,${gate})`;
    async function observe(p: typeof preview) {
      const admitted = await approveAndQueueSpWrite(database, f.actor, { profileId: f.request.profileId,
        approval: { approvalRequestId: randomUUID(), plan: p.binding, approvalMode: 'manual',
          confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1', boundedAuthorization: null, preapprovedInversePlan: null } });
      const detail = await readSpWriteOperation(database, f.actor, { profileId: f.request.profileId, ...admitted.operation });
      await executeSyntheticKeywordWrite(database, p.plan, detail.receipt, 'accepted', 'native_receipt');
      const observed = await readSpWriteOperation(database, f.actor, { profileId: f.request.profileId, ...admitted.operation });
      expect(observed.snapshot.status).toBe('succeeded');
      expect(observed.snapshot.accounting).toMatchObject({ approvedRows: 2, intentCommitted: 2, providerAccepted: 2,
        observedRequested: 2, pendingDispatch: 0, refusedBeforeDispatch: 0 });
      expect(observed.mirror).toMatchObject({ observations: 2, promoted: 2, pending: 0 });
      const [stored] = await database.sql<{ calls: number; positions: number; results: number; observations: number }[]>`select
        (select count(*)::int from public.sp_write_provider_call_intents where plan_id = ${p.plan.id}) as calls,
        (select count(*)::int from public.sp_write_provider_call_positions where plan_id = ${p.plan.id}) as positions,
        (select count(*)::int from public.sp_write_provider_results r join public.sp_write_provider_call_intents i on i.intent_id = r.intent_id
          where i.plan_id = ${p.plan.id}) as results,
        (select count(*)::int from public.sp_write_observations where plan_id = ${p.plan.id}) as observations`;
      expect(stored).toEqual({ calls: 1, positions: 2, results: 1, observations: 2 });
      return admitted;
    }
    async function mirrorValues() {
      return database.sql<{ keyword_id: string; bid: string }[]>`select amazon_id as keyword_id, bid::text as bid
        from public.keywords where org_id = ${f.actor.orgId} and profile_id = ${f.request.profileId}
          and amazon_id in ('kw-1','kw-2') order by amazon_id`;
    }
    const initialMirror = await mirrorValues();
    const original = await observe(preview);
    const appliedMirror = await mirrorValues();
    expect(appliedMirror).toEqual([{ keyword_id: 'kw-1', bid: '0.7500' }, { keyword_id: 'kw-2', bid: '0.8000' }]);
    const inverse = await previewSpWriteInverse(database, f.actor, { profileId: f.request.profileId,
      requestId: randomUUID(), original: original.operation });
    expect(inverse.plan.schemaVersion).toBe('openspell.sp-write-plan.v2');
    expect(inverse.plan.counts).toEqual(preview.plan.counts);
    expect(inverse.plan.actions.map((action) => action.sources)).toEqual(preview.plan.actions.map((action) =>
      [{ kind: 'inverse_action', sourceActionId: action.actionId, changeKey: 'keyword.bid' }]));
    for (const [index, action] of inverse.plan.actions.entries()) {
      const forward = preview.plan.actions[index]!;
      expect(action.entity).toEqual(forward.entity);
      expect(action.actionId).not.toBe(forward.actionId);
      if (action.routeKey !== 'sp.v3.keywords.update' || forward.routeKey !== action.routeKey) throw new Error('expected keyword inverse');
      expect(action.changes.bid).toEqual({ expected: forward.changes.bid!.requested, requested: forward.changes.bid!.expected });
    }
    const reverted = await observe(inverse);
    expect(await mirrorValues()).toEqual(initialMirror);
    const entries = (await listTimeline(database, { orgId: f.actor.orgId, profileId: f.request.profileId }))
      .filter((entry) => entry.write !== null);
    expect(entries).toHaveLength(4);
    expect(entries.every((entry) => entry.batch === null && entry.write?.phase === 'observed_requested'
      && entry.write.actor.kind === 'operator' && entry.write.actor.userId === f.actor.userId)).toBe(true);
    const forwards = entries.filter((entry) => entry.write?.direction === 'forward');
    const inverses = entries.filter((entry) => entry.write?.direction === 'inverse');
    expect(forwards).toHaveLength(2); expect(inverses).toHaveLength(2);
    expect(new Set(forwards.map((entry) => entry.write!.actionId))).toEqual(new Set(preview.plan.actions.map((action) => action.actionId)));
    expect(new Set(inverses.map((entry) => entry.write!.actionId))).toEqual(new Set(inverse.plan.actions.map((action) => action.actionId)));
    expect(forwards.every((entry) => JSON.stringify(entry.write!.execution.inverses) === JSON.stringify([reverted.operation]))).toBe(true);
    expect(inverses.every((entry) => JSON.stringify(entry.write!.execution.original) === JSON.stringify(original.operation))).toBe(true);
  });

  it('rechecks credential, owner membership and revocation, including preview recovery', async () => {
    const f = await fixture();
    await expect(prepareMcpKeywordBidPreview(database, { ...f.credential, tokenHash: hash('wrong') }, f.request))
      .rejects.toMatchObject({ code: 'authorization_refused' });
    await database.sql`update public.org_members set role = 'analyst' where org_id = ${f.actor.orgId} and user_id = ${f.actor.userId}`;
    await expect(prepareMcpKeywordBidPreview(database, f.credential, f.request)).rejects.toMatchObject({ code: 'authorization_refused' });
    await database.sql`update public.org_members set role = 'owner' where org_id = ${f.actor.orgId} and user_id = ${f.actor.userId}`;
    expect(await counts(f.actor.orgId)).toEqual(f.initial);
    await prepareMcpKeywordBidPreview(database, f.credential, f.request);
    await revokeMcpKeyAsOperator(database, f.actor, f.credential.keyId);
    await expect(prepareMcpKeywordBidPreview(database, f.credential, f.request)).rejects.toMatchObject({ code: 'authorization_refused' });
    await expect(asUser(database, f.actor.userId, (sql) => sql`select app.mcp_bid_preview_context(
      ${f.actor.orgId},${f.credential.keyId},${f.credential.tokenHash},${f.request.profileId})`)).rejects.toMatchObject({ code: '42501' });
  });

  it('rolls back source rows and plan when preview auditing fails', async () => {
    const f = await fixture();
    await database.sql.unsafe(`create function public.reject_preview_audit() returns trigger language plpgsql as $$
      begin raise exception 'synthetic preview audit failure'; end $$;
      create trigger reject_preview_audit before insert on public.audit_log for each row
      when (new.action = 'mcp.bid_preview.prepared') execute function public.reject_preview_audit()`);
    try {
      const [before] = await database.sql`select count(*)::int as plans from public.sp_write_plans where org_id = ${f.actor.orgId}`;
      await expect(prepareMcpKeywordBidPreview(database, f.credential, f.request)).rejects.toMatchObject({ code: 'outcome_unknown' });
      expect(await counts(f.actor.orgId)).toEqual(f.initial);
      const [after] = await database.sql`select count(*)::int as plans from public.sp_write_plans where org_id = ${f.actor.orgId}`;
      expect(after).toEqual(before);
    } finally {
      await database.sql`drop trigger reject_preview_audit on public.audit_log`;
      await database.sql`drop function public.reject_preview_audit()`;
    }
  });
});
