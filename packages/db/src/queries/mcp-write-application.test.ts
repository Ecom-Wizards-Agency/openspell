import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serializeApplyRows } from '@wizard-ads/shared';
import type { McpBidApplyRequest, McpBidPreviewRequest } from '@wizard-ads/shared/mcp-writes';
import { serializeMcpBidPreviewRequest } from '@wizard-ads/shared/mcp-writes';
import { serializeSpWritePreviewGuardrails, serializeSpWritePreviewProvenance } from '@wizard-ads/shared/sp-write-preview-evidence';
import { serializeSpWriteActionFingerprint, serializeSpWritePlanFingerprint } from '@wizard-ads/shared/sp-writes';
import type { DbHandle } from '../client.js';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { asServiceRole, asUser } from '../testing/rls.js';
import { executeSyntheticKeywordWrite } from '../testing/sp-write-synthetic-execution.js';
import { issueMcpWriteDelegation, revokeMcpKeyAsOperator } from './mcp-writes.js';
import { applyMcpBidChanges, previewMcpBidChanges, readMcpWriteStatus } from './mcp-write-application.js';
import { buildSpWriteLegacyPreview } from './sp-write-plan-builder.js';
import { approveAndQueueSpWrite, readSpWriteOperation } from '../sp-write-application.js';

const available = await databaseAvailable();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

describe.skipIf(!available)('MCP write application sources and admission recovery', () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase('mcp_application');
    const gateId = randomUUID();
    await database.sql`insert into public.sp_write_environment_gate_versions(version_id,enabled,max_unresolved_calls) values(${gateId},true,1)`;
    await database.sql`insert into public.sp_write_environment_gate_head(singleton,version_id) values(true,${gateId})`;
    await setMcpGate(true);
  }, 60_000);
  afterAll(async () => { await database?.drop(); });

  async function setMcpGate(enabled: boolean) {
    const id = randomUUID();
    await database.sql`insert into mcp.write_gate_versions(version_id,enabled) values(${id},${enabled})`;
    await database.sql`insert into mcp.write_gate_head(singleton,version_id) values(true,${id})
      on conflict(singleton) do update set version_id = excluded.version_id`;
  }
  async function key(actor: { orgId: string; userId: string }, profileId: string) {
    const tokenHash = hash(randomUUID());
    const delegation = await issueMcpWriteDelegation(database, actor, {
      label: 'Synthetic application caller', profileIds: [profileId], expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      limits: { action: 'keyword.bid', maximumRowsPerCall: 2, maximumRowsPerUtcDay: 3,
        maximumAbsoluteDeltaByCurrency: [{ amount: '0.2', currencyCode: 'USD' }], maximumRelativeDelta: '0.25' },
    }, { tokenHash, keyPrefix: 'wza_syntheti' });
    return { credential: { orgId: actor.orgId, keyId: delegation.keyId, tokenHash }, delegation };
  }
  async function fixture() {
    const userId = randomUUID();
    const [tenant] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()},${userId},'owner') as id`;
    const orgId = tenant!.id;
    const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id = ${orgId}`;
    const profileId = profile!.id; const versionId = randomUUID();
    await database.sql`insert into public.sp_write_profile_grant_versions
      (grant_id,version_id,org_id,profile_id,enabled,amazon_profile_id,connection_id,region,marketplace_id,currency_code,api_dialect,created_by)
      select grant_id,${versionId},org_id,profile_id,true,amazon_profile_id,connection_id,region,marketplace_id,currency_code,api_dialect,created_by
      from public.sp_write_profile_grant_versions where org_id = ${orgId} and profile_id = ${profileId}`;
    await database.sql`update public.sp_write_profile_grant_heads set version_id = ${versionId} where org_id = ${orgId} and profile_id = ${profileId}`;
    const actor = { orgId, userId }; const issued = await key(actor, profileId);
    const proposal: McpBidPreviewRequest = { requestId: randomUUID(), profileId, source: { kind: 'keyword_proposals',
      note: 'Synthetic application proposal', rows: [{ keywordId: 'kw-1', expectedBid: '0.9', requestedBid: '0.8' }] } };
    return { actor, profileId, ...issued, proposal };
  }
  async function legacy(f: Awaited<ReturnType<typeof fixture>>, requested = 0.8) {
    const batchId = randomUUID(); const rowId = randomUUID(); const recommendationId = randomUUID();
    const [run] = await database.sql<{ id: string }[]>`select id from public.recommendation_runs where org_id = ${f.actor.orgId} and profile_id = ${f.profileId}`;
    const artifactSha = hash(serializeApplyRows([{ entityType: 'keyword', entityId: 'kw-1', field: 'bid', old: 0.9, new: requested }]));
    await database.sql`insert into public.recommendations
      (id,run_id,org_id,profile_id,reason,entity_type,entity_id,field,current_value,proposed_value,inputs)
      values(${recommendationId},${run!.id},${f.actor.orgId},${f.profileId},'high_acos','keyword','kw-1','bid',
        '0.9'::jsonb, ${JSON.stringify(requested)}::jsonb, '{}'::jsonb)`;
    await database.sql`insert into public.apply_batches
      (id,org_id,profile_id,tag,opt_group,lever,note,artifact_sha256,exported_proposals,reversible_rows,unsupported_rows,created_by)
      values(${batchId},${f.actor.orgId},${f.profileId},${batchId},'synthetic','bid','Synthetic legacy source',${artifactSha},1,1,0,${f.actor.userId})`;
    await database.sql`insert into public.apply_rows(id,batch_id,org_id,profile_id,recommendation_id,entity_type,entity_id,field,old_value,new_value)
      values(${rowId},${batchId},${f.actor.orgId},${f.profileId},${recommendationId},'keyword','kw-1','bid','0.9'::jsonb,${JSON.stringify(requested)}::jsonb)`;
    await database.sql`update public.recommendations set status = 'exported',export_batch_id = ${batchId} where id = ${recommendationId}`;
    return { batchId, rowId, recommendationId, request: { requestId: randomUUID(), profileId: f.profileId,
      source: { kind: 'apply_batch' as const, applyBatchId: batchId } } };
  }
  async function counts(orgId: string) {
    const [row] = await database.sql<{ previews: number; sources: number; plans: number; evidence: number; actions: number;
      batches: number; rows: number; preview_audits: number; admissions: number; receipts: number; outbox: number }[]>`select
      (select count(*)::int from mcp.write_previews where org_id = ${orgId}) as previews,
      (select count(*)::int from mcp.bid_proposal_sources where org_id = ${orgId}) as sources,
      (select count(*)::int from public.sp_write_plans where org_id = ${orgId}) as plans,
      (select count(*)::int from public.sp_write_preview_evidence where org_id = ${orgId}) as evidence,
      (select count(*)::int from public.sp_write_plan_actions where org_id = ${orgId}) as actions,
      (select count(*)::int from public.apply_batches where org_id = ${orgId}) as batches,
      (select count(*)::int from public.apply_rows where org_id = ${orgId}) as rows,
      (select count(*)::int from public.audit_log where org_id = ${orgId} and action = 'mcp.bid_preview.prepared') as preview_audits,
      (select count(*)::int from mcp.write_admissions where org_id = ${orgId}) as admissions,
      (select count(*)::int from public.sp_write_authorization_receipts where org_id = ${orgId}) as receipts,
      (select count(*)::int from public.sp_write_outbox where org_id = ${orgId}) as outbox`;
    if (!row) throw new Error('synthetic count snapshot missing');
    return row;
  }
  function loseResponse(fragment: string): Pick<DbHandle, 'sql'> {
    let lost = false;
    return { sql: new Proxy(database.sql, { apply(target, receiver, args: unknown[]) {
      const statement = Array.isArray(args[0]) ? args[0].join(' ') : '';
      if (!lost && statement.includes(fragment)) {
        lost = true;
        return Promise.resolve(Reflect.apply(target, receiver, args)).then(() => { throw new Error('synthetic lost response'); });
      }
      return Reflect.apply(target, receiver, args);
    } }) };
  }
  function applyRequest(preview: Awaited<ReturnType<typeof previewMcpBidChanges>>, requestId = randomUUID()): McpBidApplyRequest {
    return { requestId, profileId: preview.preview.plan.profileId, planId: preview.preview.plan.id,
      planFingerprint: preview.preview.plan.fingerprint };
  }

  it('exposes controlled proposals with exact source counts, capacity and stable key-owned replay', async () => {
    const f = await fixture(); const before = await counts(f.actor.orgId);
    const first = await asServiceRole(database, (sql) => previewMcpBidChanges({ sql },f.credential,f.proposal));
    expect(first.dailyRows).toEqual({ day: new Date().toISOString().slice(0,10), reserved: 0, maximum: 3 });
    expect(first.delegation).toEqual(f.delegation);
    expect(first.preview.evidence?.schemaVersion).toBe('openspell.sp-write-preview-evidence.v2');
    expect(await previewMcpBidChanges(database,f.credential,f.proposal)).toEqual(first);
    expect(await counts(f.actor.orgId)).toEqual({ ...before, previews: before.previews + 1, sources: before.sources + 1,
      plans: before.plans + 1, evidence: before.evidence + 1, actions: before.actions + 1,
      batches: before.batches + 1, rows: before.rows + 1, preview_audits: before.preview_audits + 1 });
  });

  it('binds real legacy evidence atomically and gives equal external IDs independent key namespaces', async () => {
    const f = await fixture(); const source = await legacy(f); const second = await key(f.actor,f.profileId);
    const before = await counts(f.actor.orgId);
    const [first, replay] = await Promise.all([previewMcpBidChanges(database,f.credential,source.request),
      previewMcpBidChanges(database,f.credential,source.request)]);
    expect(replay).toEqual(first);
    const other = await previewMcpBidChanges(database,second.credential,source.request);
    expect(first.preview.plan.id).not.toBe(source.request.requestId);
    expect(other.preview.plan.id).not.toBe(first.preview.plan.id);
    expect(first.preview.evidence?.schemaVersion).toBe('openspell.sp-write-preview-evidence.v1');
    expect(first.preview.evidence?.provenance.rows).toEqual([{ applyRowId: source.rowId,
      recommendationId: source.recommendationId, runId: expect.any(String) }]);
    const preparedCounts = { ...before, previews: before.previews + 2, plans: before.plans + 2,
      evidence: before.evidence + 2, actions: before.actions + 2, preview_audits: before.preview_audits + 2 };
    expect(await counts(f.actor.orgId)).toEqual(preparedCounts);
    const admission = await applyMcpBidChanges(database,f.credential,applyRequest(first));
    const status = await readMcpWriteStatus(database,f.credential,{ profileId: f.profileId,
      lookup: { kind: 'operation', ...admission.operation } });
    expect(status.kind).toBe('found');
    if (status.kind !== 'found') throw new Error('expected delegated legacy operation');
    expect(status.execution.receipt.approvalMode).toBe('delegated_mcp');
    expect(status.execution.receipt.plan.planFingerprint).toBe(first.preview.plan.fingerprint);
    expect(await counts(f.actor.orgId)).toEqual({ ...preparedCounts, admissions: before.admissions + 1,
      receipts: before.receipts + 1, outbox: before.outbox + 1 });
  });

  it('recovers a lost committed legacy preview and refuses a changed source or bearer without residue', async () => {
    const f = await fixture(); const source = await legacy(f);
    const first = await previewMcpBidChanges(loseResponse('app.prepare_mcp_sp_write_preview_v1('),f.credential,source.request);
    expect(await previewMcpBidChanges(database,f.credential,source.request)).toEqual(first);
    const before = await counts(f.actor.orgId);
    await expect(previewMcpBidChanges(database,f.credential,{ ...source.request,
      source: { kind: 'apply_batch', applyBatchId: randomUUID() } })).rejects.toMatchObject({ code: 'identity_conflict' });
    await expect(previewMcpBidChanges(database,{ ...f.credential, tokenHash: hash('wrong') },source.request))
      .rejects.toMatchObject({ code: 'authorization_refused' });
    await revokeMcpKeyAsOperator(database,f.actor,f.credential.keyId);
    await expect(previewMcpBidChanges(database,f.credential,source.request)).rejects.toMatchObject({ code: 'authorization_refused' });
    expect(await counts(f.actor.orgId)).toEqual(before);
  });

  it('refuses legacy caps before producing any plan, mapping or audit', async () => {
    const f = await fixture(); const source = await legacy(f,0.6); const before = await counts(f.actor.orgId);
    await expect(previewMcpBidChanges(database,f.credential,source.request)).rejects.toMatchObject({ code: 'authorization_refused' });
    expect(await counts(f.actor.orgId)).toEqual(before);
  });

  async function rawLegacy(f: Awaited<ReturnType<typeof fixture>>, source: Awaited<ReturnType<typeof legacy>>) {
    const artifacts = await buildSpWriteLegacyPreview(database.sql,f.actor.orgId,
      { requestId: randomUUID(), profileId: f.profileId, applyBatchId: source.batchId });
    return [f.actor.orgId,f.credential.keyId,f.credential.tokenHash,JSON.stringify(source.request),serializeMcpBidPreviewRequest(source.request),
      JSON.stringify(artifacts.plan),serializeSpWritePlanFingerprint(artifacts.plan),
      JSON.stringify(artifacts.plan.actions.map((action) => ({ artifactText: JSON.stringify(action),
        fingerprintPreimage: serializeSpWriteActionFingerprint(action) }))), JSON.stringify(artifacts.evidence),
      serializeSpWritePreviewGuardrails(artifacts.evidence),serializeSpWritePreviewProvenance(artifacts.evidence)];
  }
  async function rawRecord(values: string[], userId?: string) {
    const call = (sql: DbHandle['sql']) => sql.unsafe('select app.prepare_mcp_sp_write_preview_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)',values);
    return userId ? asUser(database,userId,call) : asServiceRole(database,call);
  }
  function rehashRawPlan(values: string[], mutate: (plan: Record<string,unknown>) => void) {
    const plan = JSON.parse(values[5]!) as Record<string,unknown>;
    const preimage = JSON.parse(values[6]!) as [string,Record<string,unknown>];
    mutate(plan); mutate(preimage[1]); values[6] = JSON.stringify(preimage);
    plan['fingerprint'] = hash(values[6]); values[5] = JSON.stringify(plan);
  }
  function noncanonicalEvidencePreimage(values: string[], index: number, field: string) {
    values[index] = ` ${values[index]}`;
    const plan = JSON.parse(values[5]!) as { source: Record<string,unknown>; fingerprint: string };
    const preimage = JSON.parse(values[6]!) as [string,{ source: Record<string,unknown> }];
    plan.source[field] = hash(values[index]!); preimage[1].source[field] = plan.source[field];
    values[6] = JSON.stringify(preimage); plan.fingerprint = hash(values[6]); values[5] = JSON.stringify(plan);
  }
  it('validates raw recorder requests and artifacts without trusting the TypeScript facade', async () => {
    const f = await fixture(); const source = await legacy(f); const before = await counts(f.actor.orgId);
    const mutations: Array<(values: string[]) => void> = [
      (v) => { v[4] = ` ${v[4]}`; },
      (v) => { const r = JSON.parse(v[3]!) as Record<string,unknown>; r['actor'] = f.actor; v[3] = JSON.stringify(r); },
      (v) => { const r: McpBidPreviewRequest = { ...source.request, source: { kind: 'apply_batch', applyBatchId: randomUUID() } };
        v[3] = JSON.stringify(r); v[4] = serializeMcpBidPreviewRequest(r); },
      (v) => { v[2] = hash('wrong'); },
      (v) => { rehashRawPlan(v,(plan) => { const counts = plan['counts'] as Record<string,unknown>; counts['logicalChanges'] = '1'; }); },
      (v) => { rehashRawPlan(v,(plan) => { plan['generatedAt'] = '2026-02-30T00:00:00.000Z'; }); },
      (v) => { v[8] = '{}'; },
      (v) => {
        v[6] = ` ${v[6]}`;
        const plan = JSON.parse(v[5]!) as { fingerprint: string }; plan.fingerprint = hash(v[6]); v[5] = JSON.stringify(plan);
      },
      (v) => {
        const proofs = JSON.parse(v[7]!) as Array<{ artifactText: string; fingerprintPreimage: string }>;
        const proof = proofs[0]!; proof.fingerprintPreimage = ` ${proof.fingerprintPreimage}`;
        const action = JSON.parse(proof.artifactText) as { fingerprint: string };
        action.fingerprint = hash(proof.fingerprintPreimage); proof.artifactText = JSON.stringify(action); v[7] = JSON.stringify(proofs);
        const plan = JSON.parse(v[5]!) as { fingerprint: string; actions: Array<{ fingerprint: string }> };
        const preimage = JSON.parse(v[6]!) as [string,{ actions: Array<{ fingerprint: string }> }];
        plan.actions[0]!.fingerprint = action.fingerprint; preimage[1].actions[0]!.fingerprint = action.fingerprint;
        v[6] = JSON.stringify(preimage); plan.fingerprint = hash(v[6]); v[5] = JSON.stringify(plan);
      },
      (v) => { noncanonicalEvidencePreimage(v,9,'guardrailSnapshotFingerprint'); },
      (v) => { noncanonicalEvidencePreimage(v,10,'provenanceSnapshotFingerprint'); },
    ];
    for (const mutate of mutations) {
      const values = await rawLegacy(f,source); mutate(values);
      await expect(rawRecord(values)).rejects.toBeInstanceOf(Error);
      expect(await counts(f.actor.orgId)).toEqual(before);
    }
    const values = await rawLegacy(f,source);
    await expect(rawRecord(values,f.actor.userId)).rejects.toMatchObject({ code: '42501' });
    expect(await counts(f.actor.orgId)).toEqual(before);
    await rawRecord(values);
    const recorded = await counts(f.actor.orgId);
    expect(recorded).toEqual({ ...before, previews: before.previews + 1, plans: before.plans + 1,
      evidence: before.evidence + 1, actions: before.actions + 1, preview_audits: before.preview_audits + 1 });
    await rawRecord(values);
    expect(await counts(f.actor.orgId)).toEqual(recorded);
  });

  it('rolls back legacy plan, evidence and mapping when its preview audit insert fails', async () => {
    const f = await fixture(); const source = await legacy(f); const before = await counts(f.actor.orgId);
    await database.sql.unsafe(`create trigger synthetic_mcp_preview_failure before insert on public.audit_log
      for each row when (new.action = 'mcp.bid_preview.prepared' and new.org_id = '${f.actor.orgId}'::uuid)
      execute function app.reject_sp_write_evidence_change()`);
    try {
      await expect(previewMcpBidChanges(database,f.credential,source.request)).rejects.toBeInstanceOf(Error);
      expect(await counts(f.actor.orgId)).toEqual(before);
    } finally { await database.sql`drop trigger synthetic_mcp_preview_failure on public.audit_log`; }
  });

  it('records an exact MCP inverse of a fully observed human action without impersonating its actor', async () => {
    const f = await fixture(); const preview = await previewMcpBidChanges(database,f.credential,f.proposal);
    const human = await approveAndQueueSpWrite(database,f.actor,{ profileId: f.profileId, approval: {
      approvalRequestId: randomUUID(), plan: preview.preview.binding, approvalMode: 'manual',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1', boundedAuthorization: null, preapprovedInversePlan: null,
    } });
    const operation = await readSpWriteOperation(database,f.actor,{ profileId: f.profileId, ...human.operation });
    const request: McpBidPreviewRequest = { requestId: randomUUID(), profileId: f.profileId,
      source: { kind: 'inverse', original: human.operation } };
    const beforeObservation = await counts(f.actor.orgId);
    await expect(previewMcpBidChanges(database,f.credential,request)).rejects.toMatchObject({ code: 'source_changed' });
    expect(await counts(f.actor.orgId)).toEqual(beforeObservation);
    await executeSyntheticKeywordWrite(database,preview.preview.plan,operation.receipt,'accepted','native_receipt');
    const before = await counts(f.actor.orgId);
    const inverse = await previewMcpBidChanges(loseResponse('app.prepare_mcp_sp_write_preview_v1('),f.credential,request);
    expect(inverse.preview.evidence).toBeNull();
    expect(inverse.preview.plan.source).toMatchObject({ kind: 'inverse_execution', sourceExecutionId: human.operation.executionId,
      sourcePlanId: human.operation.planId });
    expect(inverse.preview.plan.actions[0]?.changes).toEqual({ bid: {
      expected: { amount: '0.8', currencyCode: 'USD' }, requested: { amount: '0.9', currencyCode: 'USD' },
    } });
    expect(await counts(f.actor.orgId)).toEqual({ ...before, previews: before.previews + 1, plans: before.plans + 1,
      actions: before.actions + 1, preview_audits: before.preview_audits + 1 });
    const admitted = await applyMcpBidChanges(database,f.credential,applyRequest(inverse));
    const status = await readMcpWriteStatus(database,f.credential,{ profileId: f.profileId, lookup: { kind: 'operation', ...admitted.operation } });
    expect(status.kind).toBe('found');
    if (status.kind !== 'found') throw new Error('expected committed inverse');
    expect(status.execution.receipt.approvalMode).toBe('delegated_mcp');
    expect(status.execution.original).toEqual(human.operation);
  });

  it('recovers a lost apply response with one charge and preserves status after issuer and gate closure', async () => {
    const f = await fixture(); const preview = await previewMcpBidChanges(database,f.credential,f.proposal);
    const request = applyRequest(preview); const before = await counts(f.actor.orgId);
    const admitted = await applyMcpBidChanges(loseResponse('app.admit_mcp_sp_write_v1('),f.credential,request);
    expect(admitted.approvalRequestId).not.toBe(request.requestId);
    expect(await applyMcpBidChanges(database,f.credential,request)).toEqual(admitted);
    expect(await counts(f.actor.orgId)).toEqual({ ...before, admissions: before.admissions + 1,
      receipts: before.receipts + 1, outbox: before.outbox + 1 });
    const lookup = { profileId: f.profileId, lookup: { kind: 'apply_request' as const, requestId: request.requestId } };
    await database.sql`update public.org_members set role = 'analyst' where org_id = ${f.actor.orgId} and user_id = ${f.actor.userId}`;
    await setMcpGate(false);
    try {
      const status = await readMcpWriteStatus(database,f.credential,lookup);
      expect(status.kind).toBe('found');
      if (status.kind !== 'found') throw new Error('expected committed operation');
      expect(status.execution.operation).toEqual(admitted.operation);
      expect(status.capacity).toEqual({ requested: 1, reserved: 1, attempted: 0, accepted: 0, observed: 0, refused: 0, released: 0 });
      expect(await applyMcpBidChanges(database,f.credential,request)).toEqual(admitted);
    } finally {
      await setMcpGate(true);
      await database.sql`update public.org_members set role = 'owner' where org_id = ${f.actor.orgId} and user_id = ${f.actor.userId}`;
    }
    await revokeMcpKeyAsOperator(database,f.actor,f.credential.keyId);
    await expect(readMcpWriteStatus(database,f.credential,lookup)).rejects.toMatchObject({ code: 'authorization_refused' });
  });

  it('uses key-scoped apply IDs and refuses cross-key plan/status access or a changed retry', async () => {
    const f = await fixture(); const second = await key(f.actor,f.profileId);
    const firstPreview = await previewMcpBidChanges(database,f.credential,f.proposal);
    const secondPreview = await previewMcpBidChanges(database,second.credential,f.proposal);
    const requestId = randomUUID(); const firstRequest = applyRequest(firstPreview,requestId);
    await expect(applyMcpBidChanges(database,second.credential,firstRequest)).rejects.toBeInstanceOf(Error);
    const [first, other] = await Promise.all([applyMcpBidChanges(database,f.credential,firstRequest),
      applyMcpBidChanges(database,second.credential,applyRequest(secondPreview,requestId))]);
    expect(first.approvalRequestId).not.toBe(other.approvalRequestId);
    await expect(applyMcpBidChanges(database,f.credential,{ ...firstRequest, planFingerprint: 'a'.repeat(64) }))
      .rejects.toMatchObject({ code: 'identity_conflict' });
    await expect(applyMcpBidChanges(database,f.credential,{ ...firstRequest, requestId: randomUUID() }))
      .rejects.toMatchObject({ code: 'identity_conflict' });
    await expect(readMcpWriteStatus(database,second.credential,{ profileId: f.profileId,
      lookup: { kind: 'operation', ...first.operation } })).rejects.toMatchObject({ code: 'not_found' });
    const absent = randomUUID();
    expect(await readMcpWriteStatus(database,f.credential,{ profileId: f.profileId,
      lookup: { kind: 'apply_request', requestId: absent } })).toEqual({ kind: 'request_unresolved', requestId: absent });
    const current = await previewMcpBidChanges(database,f.credential,f.proposal);
    expect(current.dailyRows.reserved).toBe(1);
  });

  it('does not treat a lost apply plus failed recovery read as proof that nothing committed', async () => {
    const f = await fixture(); const preview = await previewMcpBidChanges(database,f.credential,f.proposal);
    const request = applyRequest(preview); let committed = false;
    const sql = new Proxy(database.sql,{ apply(target,receiver,args: unknown[]) {
      const statement = Array.isArray(args[0]) ? args[0].join(' ') : '';
      if (statement.includes('app.admit_mcp_sp_write_v1(')) {
        return Promise.resolve(Reflect.apply(target,receiver,args)).then(() => { committed = true; throw new Error('synthetic lost apply'); });
      }
      if (committed && statement.includes('from mcp.write_admissions a')) return Promise.reject(new Error('synthetic unavailable recovery read'));
      return Reflect.apply(target,receiver,args);
    } });
    await expect(applyMcpBidChanges({ sql },f.credential,request)).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(committed).toBe(true);
    const status = await readMcpWriteStatus(database,f.credential,{ profileId: f.profileId,
      lookup: { kind: 'apply_request', requestId: request.requestId } });
    expect(status.kind).toBe('found');
    const retry = await applyMcpBidChanges(database,f.credential,request);
    if (status.kind !== 'found') throw new Error('expected committed operation');
    expect(retry.operation).toEqual(status.execution.operation);
  });
});
