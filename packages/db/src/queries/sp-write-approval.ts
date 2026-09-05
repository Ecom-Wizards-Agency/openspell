import {
  SpWriteActor, SpWriteAdmission, SpWriteManualApprovalRequest,
} from '@wizard-ads/shared/sp-write-application';
import { SpWriteAuthorizationReceipt } from '@wizard-ads/shared/sp-writes';
import type { DbHandle, QuerySql } from '../client.js';
import { withAuthenticatedActor } from './authenticated-actor.js';
import { SpWriteApplicationError } from './sp-write-errors.js';
import { createSpWriteRuntimeLedger } from './sp-write-persistence.js';

async function priorReceipt(
  sql: QuerySql, actor: SpWriteActor, request: SpWriteManualApprovalRequest,
): Promise<SpWriteAuthorizationReceipt | null> {
  const rows = await sql<{ artifact: unknown }[]>`
    select receipt.artifact from public.sp_write_authorization_receipts receipt
    join public.sp_write_approval_requests request
      on request.org_id = receipt.org_id and request.profile_id = receipt.profile_id
     and request.approval_request_id = receipt.approval_request_id
    where receipt.org_id = ${actor.orgId}::uuid and receipt.profile_id = ${request.profileId}::uuid
      and receipt.plan_id = ${request.approval.plan.planId}::uuid
      and receipt.approved_by = ${actor.userId}::uuid
      and request.artifact = ${JSON.stringify(request.approval)}::jsonb
      and exists(select 1 from public.org_members where org_id = receipt.org_id
        and user_id = ${actor.userId}::uuid and role in ('owner','admin'))
  `;
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new SpWriteApplicationError('identity_conflict');
  return SpWriteAuthorizationReceipt.parse(rows[0]!.artifact);
}

async function isQueued(
  handle: Pick<DbHandle, 'sql'>, receipt: SpWriteAuthorizationReceipt,
): Promise<boolean> {
  const rows = await handle.sql<{ queued: boolean }[]>`
    select exists(select 1 from public.sp_write_execution_requests
      where org_id = ${receipt.plan.orgId}::uuid and profile_id = ${receipt.plan.profileId}::uuid
        and execution_id = ${receipt.executionId}::uuid and plan_id = ${receipt.plan.planId}::uuid
        and approval_id = ${receipt.approvalId}::uuid and generation = ${receipt.generation}::uuid) as queued
  `;
  if (rows.length !== 1) throw new SpWriteApplicationError('outcome_unknown');
  return rows[0]!.queued;
}

function approvalFailure(error: unknown): SpWriteApplicationError {
  if (error instanceof SpWriteApplicationError) return error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  if (code === '23505') return new SpWriteApplicationError('identity_conflict');
  if (code === '42501') return new SpWriteApplicationError('authorization_refused');
  if (code === '55000' || code === 'P0002') return new SpWriteApplicationError('source_changed');
  if (code === '22023' || code === '22P02') return new SpWriteApplicationError('invalid_request');
  return new SpWriteApplicationError('outcome_unknown');
}

/** Exact confirmation records authority first; retry recovers that same operation. */
export async function approveAndQueueSpWrite(
  handle: Pick<DbHandle, 'sql'>, rawActor: SpWriteActor, rawRequest: SpWriteManualApprovalRequest,
): Promise<SpWriteAdmission> {
  const actor = SpWriteActor.parse(rawActor);
  const request = SpWriteManualApprovalRequest.parse(rawRequest);
  if (request.approval.plan.orgId !== actor.orgId) throw new SpWriteApplicationError('authorization_refused');
  let receipt: SpWriteAuthorizationReceipt;
  try {
    receipt = await withAuthenticatedActor(handle, actor, async (sql) => {
      const rows = await sql<{ artifact: unknown }[]>`
        select app.approve_sp_write_cycle(${request.approval.plan.planId}::uuid,
          ${JSON.stringify(request.approval)}) as artifact
      `;
      if (rows.length !== 1) throw new SpWriteApplicationError('outcome_unknown');
      return SpWriteAuthorizationReceipt.parse(rows[0]!.artifact);
    });
  } catch (error) {
    // A connection can fail after COMMIT. Never invent another confirmation ID.
    const recovered = await withAuthenticatedActor(handle, actor, (sql) => priorReceipt(sql, actor, request))
      .catch(() => null);
    if (recovered === null) throw approvalFailure(error);
    receipt = recovered;
  }
  if (receipt.approvedBy !== actor.userId
    || receipt.approvalRequestId !== request.approval.approvalRequestId
    || JSON.stringify(receipt.plan) !== JSON.stringify(request.approval.plan)) {
    throw new SpWriteApplicationError('outcome_unknown');
  }
  let queued: boolean;
  try {
    // Existing requests remain admitted after expiration; do not re-enqueue them.
    queued = await isQueued(handle, receipt);
    if (!queued) {
      await createSpWriteRuntimeLedger(handle).startExecution({ approvalId: receipt.approvalId, planId: receipt.plan.planId });
      queued = await isQueued(handle, receipt);
    }
  } catch {
    queued = await isQueued(handle, receipt).catch(() => false);
  }
  return SpWriteAdmission.parse({
    kind: queued ? 'queued' : 'approved_pending_start',
    operation: { executionId: receipt.executionId, planId: receipt.plan.planId },
    approvalId: receipt.approvalId, approvalRequestId: receipt.approvalRequestId,
  });
}
