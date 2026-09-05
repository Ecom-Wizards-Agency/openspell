import { createHash, randomUUID } from 'node:crypto';
import {
  McpBidAdmission, McpBidApplyRequest, McpBidPreview, McpBidPreviewRequest,
  McpWriteCredential, McpWriteStatus, McpWriteStatusRequest, serializeMcpBidPreviewRequest,
} from '@wizard-ads/shared/mcp-writes';
import { SpWritePreview, type SpWriteOperationRequest } from '@wizard-ads/shared/sp-write-application';
import {
  serializeSpWritePreviewGuardrails, serializeSpWritePreviewProvenance,
} from '@wizard-ads/shared/sp-write-preview-evidence';
import {
  SpDelegatedAuthorizationReceiptV2, serializeSpWriteActionFingerprint,
  serializeSpWritePlanFingerprint, spWritePlanBinding, verifyDelegatedSpWriteReceiptArtifacts,
  verifyMcpPlanLimits, verifyMcpWriteDelegationFingerprint, verifySpWriteInversePair,
  verifySpWritePlanFingerprints,
} from '@wizard-ads/shared/sp-writes';
import type { DbHandle } from '../client.js';
import { SpWriteApplicationError } from './sp-write-errors.js';
import { prepareMcpKeywordBidPreview } from './mcp-write-preview.js';
import { buildSpWriteLegacyPreview } from './sp-write-plan-builder.js';
import { buildSpWriteInversePreview } from './sp-write-inverse-preview.js';
import { loadSpWriteOperationDetail } from './sp-write-operation-read.js';
import { loadSpWritePreviewEvidence } from './sp-write-preview-evidence.js';

const hasher = { algorithm: 'sha256' as const,
  digest: (value: string) => createHash('sha256').update(value).digest('hex') };

function refuse(error: unknown): never {
  if (error instanceof SpWriteApplicationError) throw error;
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === '42501') throw new SpWriteApplicationError('authorization_refused');
  if (code === '55000' || code === 'P0002') throw new SpWriteApplicationError('source_changed');
  if (code === '23505') throw new SpWriteApplicationError('identity_conflict');
  if (code === '22023' || code === '22P02' || code === '22003') throw new SpWriteApplicationError('invalid_request');
  throw new SpWriteApplicationError('outcome_unknown');
}

async function readContext(handle: Pick<DbHandle, 'sql'>, c: McpWriteCredential, profileId: string) {
  const rows = await handle.sql<{ value: { delegation: unknown; now: unknown; dailyRows: unknown } }[]>`
    select app.mcp_write_read_context(${c.orgId},${c.keyId},${c.tokenHash},${profileId}) as value`;
  if (rows.length !== 1 || !rows[0]?.value) throw new SpWriteApplicationError('outcome_unknown');
  const value = rows[0].value;
  const delegation = verifyMcpWriteDelegationFingerprint(value.delegation, hasher);
  if (delegation.orgId !== c.orgId || delegation.keyId !== c.keyId
    || !delegation.profiles.some((profile) => profile.profileId === profileId)) {
    throw new SpWriteApplicationError('authorization_refused');
  }
  return { delegation, dailyRows: McpBidPreview.shape.dailyRows.parse(value.dailyRows) };
}

async function previewAuthority(handle: Pick<DbHandle, 'sql'>, c: McpWriteCredential, profileId: string) {
  await handle.sql`select app.mcp_bid_preview_context(${c.orgId},${c.keyId},${c.tokenHash},${profileId})`;
  return readContext(handle, c, profileId);
}

async function savedPreview(handle: Pick<DbHandle, 'sql'>, c: McpWriteCredential, request: McpBidPreviewRequest) {
  const rows = await handle.sql<{ plan_text: string; request: unknown }[]>`
    select p.artifact_text as plan_text, m.request from mcp.write_previews m
    join public.sp_write_plans p on p.org_id = m.org_id and p.profile_id = m.profile_id and p.plan_id = m.plan_id
    where m.org_id = ${c.orgId} and m.key_id = ${c.keyId} and m.request_id = ${request.requestId}`;
  if (rows.length === 0) return null;
  if (rows.length !== 1 || serializeMcpBidPreviewRequest(McpBidPreviewRequest.parse(rows[0]!.request))
    !== serializeMcpBidPreviewRequest(request)) throw new SpWriteApplicationError('identity_conflict');
  const plan = verifySpWritePlanFingerprints(JSON.parse(rows[0]!.plan_text), hasher);
  if (plan.orgId !== c.orgId || plan.profileId !== request.profileId) throw new SpWriteApplicationError('identity_conflict');
  if (plan.source.kind === 'inverse_execution') {
    if (request.source.kind !== 'inverse' || plan.source.sourceExecutionId !== request.source.original.executionId
      || plan.source.sourcePlanId !== request.source.original.planId) throw new SpWriteApplicationError('identity_conflict');
    const forward = await loadPlan(handle, c.orgId, request.profileId, plan.source.sourcePlanId);
    verifySpWriteInversePair(forward, plan, hasher);
    return SpWritePreview.parse({ plan, binding: spWritePlanBinding(plan), evidence: null });
  }
  const recorded = await loadSpWritePreviewEvidence(handle.sql, { orgId: c.orgId, profileId: request.profileId, planId: plan.id });
  if (!recorded) throw new SpWriteApplicationError('identity_conflict');
  return SpWritePreview.parse({ ...recorded, binding: spWritePlanBinding(plan) });
}

async function loadPlan(handle: Pick<DbHandle, 'sql'>, orgId: string, profileId: string, planId: string) {
  const rows = await handle.sql<{ artifact_text: string }[]>`select artifact_text from public.sp_write_plans
    where org_id = ${orgId} and profile_id = ${profileId} and plan_id = ${planId}`;
  if (rows.length !== 1) throw new SpWriteApplicationError('not_found');
  return verifySpWritePlanFingerprints(JSON.parse(rows[0]!.artifact_text), hasher);
}

/** The enclosing MCP call authenticates profile scope before this private cross-actor original read. */
async function readOriginal(handle: Pick<DbHandle, 'sql'>, orgId: string, request: SpWriteOperationRequest) {
  const rows = await handle.sql<{ approval_id: string; generation: string }[]>`
    select approval_id, generation from public.sp_write_cycle_plans where org_id = ${orgId}
      and profile_id = ${request.profileId} and execution_id = ${request.executionId} and plan_id = ${request.planId}`;
  if (rows.length !== 1) throw new SpWriteApplicationError('not_found');
  return loadSpWriteOperationDetail(handle, { orgId, ...request,
    approvalId: rows[0]!.approval_id, generation: rows[0]!.generation });
}

/** Create a key-bound immutable preview. No admission, capacity charge, or provider I/O. */
export async function previewMcpBidChanges(
  handle: Pick<DbHandle, 'sql'>, rawCredential: McpWriteCredential, rawRequest: McpBidPreviewRequest,
): Promise<McpBidPreview> {
  const credential = McpWriteCredential.safeParse(rawCredential); const request = McpBidPreviewRequest.safeParse(rawRequest);
  if (!credential.success || !request.success) throw new SpWriteApplicationError('invalid_request');
  const c = credential.data; const r = request.data;
  try {
    const authority = await previewAuthority(handle, c, r.profileId);
    const existing = await savedPreview(handle, c, r);
    if (existing) return McpBidPreview.parse({ preview: existing, delegation: authority.delegation, dailyRows: authority.dailyRows });
    if (r.source.kind === 'keyword_proposals') {
      const prepared = await prepareMcpKeywordBidPreview(handle, c, r);
      const current = await readContext(handle, c, r.profileId);
      return McpBidPreview.parse({ ...prepared, dailyRows: current.dailyRows });
    }
    const planId = randomUUID();
    let preview: SpWritePreview;
    if (r.source.kind === 'apply_batch') {
      const source = r.source;
      const artifacts = await handle.sql.begin('isolation level repeatable read read only', (sql) =>
        buildSpWriteLegacyPreview(sql, c.orgId, { requestId: planId, profileId: r.profileId, applyBatchId: source.applyBatchId }));
      preview = SpWritePreview.parse({ ...artifacts, binding: spWritePlanBinding(artifacts.plan) });
    } else {
      const inverseRequest = { requestId: planId, profileId: r.profileId, original: r.source.original };
      const original = await readOriginal(handle, c.orgId, { profileId: r.profileId, ...r.source.original });
      const forward = await loadPlan(handle, c.orgId, r.profileId, r.source.original.planId);
      preview = await buildSpWriteInversePreview(handle, inverseRequest, original, forward);
    }
    try { verifyMcpPlanLimits(preview.plan, authority.delegation); }
    catch { throw new SpWriteApplicationError('authorization_refused'); }
    const { plan, evidence } = preview;
    try {
      const rows = await handle.sql<{ plan_id: string }[]>`select app.prepare_mcp_sp_write_preview_v1(
        ${c.orgId},${c.keyId},${c.tokenHash},${JSON.stringify(r)},${serializeMcpBidPreviewRequest(r)},
        ${JSON.stringify(plan)},${serializeSpWritePlanFingerprint(plan)},
        ${JSON.stringify(plan.actions.map((action) => ({ artifactText: JSON.stringify(action),
          fingerprintPreimage: serializeSpWriteActionFingerprint(action) })))}::jsonb,
        ${evidence === null ? null : JSON.stringify(evidence)},
        ${evidence === null ? null : serializeSpWritePreviewGuardrails(evidence)},
        ${evidence === null ? null : serializeSpWritePreviewProvenance(evidence)})::text as plan_id`;
      if (rows.length !== 1 || !rows[0]?.plan_id) throw new SpWriteApplicationError('outcome_unknown');
    } catch (error) {
      await previewAuthority(handle, c, r.profileId);
      const committed = await savedPreview(handle, c, r);
      if (!committed) throw error;
    }
    const saved = await savedPreview(handle, c, r);
    if (!saved) throw new SpWriteApplicationError('outcome_unknown');
    const current = await readContext(handle, c, r.profileId);
    return McpBidPreview.parse({ preview: saved, delegation: current.delegation, dailyRows: current.dailyRows });
  } catch (error) { return refuse(error); }
}

async function recordedAdmission(handle: Pick<DbHandle, 'sql'>, c: McpWriteCredential, request: McpBidApplyRequest) {
  const rows = await handle.sql<{ request: unknown; receipt: unknown }[]>`
    select a.request, r.artifact as receipt from mcp.write_admissions a
    join public.sp_write_authorization_receipts r on r.org_id = a.org_id and r.profile_id = a.profile_id
      and r.plan_id = a.plan_id and r.approval_id = a.approval_id
    where a.org_id = ${c.orgId} and a.key_id = ${c.keyId} and a.mcp_request_id = ${request.requestId}`;
  if (rows.length === 0) return null;
  if (rows.length !== 1 || JSON.stringify(McpBidApplyRequest.parse(rows[0]!.request)) !== JSON.stringify(request)) {
    throw new SpWriteApplicationError('identity_conflict');
  }
  return rows[0]!.receipt;
}

/** A single SQL authority transaction charges, records, audits and enqueues exactly once. */
export async function applyMcpBidChanges(
  handle: Pick<DbHandle, 'sql'>, rawCredential: McpWriteCredential, rawRequest: McpBidApplyRequest,
): Promise<McpBidAdmission> {
  const credential = McpWriteCredential.safeParse(rawCredential); const request = McpBidApplyRequest.safeParse(rawRequest);
  if (!credential.success || !request.success) throw new SpWriteApplicationError('invalid_request');
  const c = credential.data; const r = request.data;
  try {
    let rawReceipt: unknown;
    try {
      const rows = await handle.sql<{ receipt: unknown }[]>`
        select app.admit_mcp_sp_write_v1(${c.orgId},${c.keyId},${c.tokenHash},${JSON.stringify(r)}) as receipt`;
      if (rows.length !== 1 || !rows[0]?.receipt) throw new SpWriteApplicationError('outcome_unknown');
      rawReceipt = rows[0].receipt;
    } catch (error) {
      await readContext(handle, c, r.profileId);
      rawReceipt = await recordedAdmission(handle, c, r);
      if (rawReceipt === null) throw error;
    }
    const receipt = SpDelegatedAuthorizationReceiptV2.parse(rawReceipt);
    if (receipt.delegation.orgId !== c.orgId || receipt.delegation.keyId !== c.keyId) {
      throw new SpWriteApplicationError('identity_conflict');
    }
    const plan = await loadPlan(handle, c.orgId, r.profileId, r.planId);
    // Replay verifies immutable authority at admission; today's key was checked by SQL.
    verifyDelegatedSpWriteReceiptArtifacts(plan, receipt.delegation, r, receipt, receipt.approvedAt, hasher);
    return McpBidAdmission.parse({ kind: 'queued', operation: { executionId: receipt.executionId, planId: plan.id },
      approvalId: receipt.approvalId, approvalRequestId: receipt.approvalRequestId, reservation: receipt.reservation });
  } catch (error) { return refuse(error); }
}

/** Read only this key's admitted operations, including after execution authority closes. */
export async function readMcpWriteStatus(
  handle: Pick<DbHandle, 'sql'>, rawCredential: McpWriteCredential, rawRequest: McpWriteStatusRequest,
): Promise<McpWriteStatus> {
  const credential = McpWriteCredential.safeParse(rawCredential); const request = McpWriteStatusRequest.safeParse(rawRequest);
  if (!credential.success || !request.success) throw new SpWriteApplicationError('invalid_request');
  const c = credential.data; const r = request.data;
  try {
    await readContext(handle, c, r.profileId);
    const byRequest = r.lookup.kind === 'apply_request';
    const rows = await handle.sql<{ execution_id: string; plan_id: string; approval_id: string; generation: string }[]>`
      select execution_id, plan_id, approval_id, generation from mcp.write_admissions
      where org_id = ${c.orgId} and key_id = ${c.keyId} and profile_id = ${r.profileId}
        and ${byRequest ? handle.sql`mcp_request_id = ${r.lookup.kind === 'apply_request' ? r.lookup.requestId : null}`
          : handle.sql`execution_id = ${r.lookup.kind === 'operation' ? r.lookup.executionId : null}
            and plan_id = ${r.lookup.kind === 'operation' ? r.lookup.planId : null}`}`;
    if (rows.length === 0 && r.lookup.kind === 'apply_request') {
      return McpWriteStatus.parse({ kind: 'request_unresolved', requestId: r.lookup.requestId });
    }
    if (rows.length !== 1) throw new SpWriteApplicationError('not_found');
    const row = rows[0]!;
    const execution = await loadSpWriteOperationDetail(handle, { orgId: c.orgId, profileId: r.profileId,
      executionId: row.execution_id, planId: row.plan_id, approvalId: row.approval_id, generation: row.generation });
    if (execution.receipt.approvalMode !== 'delegated_mcp' || execution.receipt.delegation.keyId !== c.keyId) {
      throw new SpWriteApplicationError('identity_conflict');
    }
    const a = execution.snapshot.accounting;
    return McpWriteStatus.parse({ kind: 'found', execution, capacity: {
      requested: a.approvedRows, reserved: execution.receipt.reservation.rows, attempted: a.intentCommitted,
      accepted: a.providerAccepted, observed: a.observedRequested, refused: a.refusedBeforeDispatch, released: 0,
    } });
  } catch (error) { return refuse(error); }
}
