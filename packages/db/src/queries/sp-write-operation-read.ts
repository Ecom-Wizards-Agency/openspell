import {
  SpWriteActor, SpWriteOperationDetail, SpWriteOperationRequest,
} from '@wizard-ads/shared/sp-write-application';
import type { DbHandle } from '../client.js';
import { SpWriteApplicationError } from './sp-write-errors.js';
import { createSpWriteRuntimeLedger } from './sp-write-persistence.js';
import { readSpWriteMirrorCounts } from './sp-write-mirror.js';

/** Read ledger evidence under exact tenant/operation identity; no status is cached. */
export async function readSpWriteOperation(
  handle: Pick<DbHandle, 'sql'>, rawActor: SpWriteActor, rawRequest: SpWriteOperationRequest,
): Promise<SpWriteOperationDetail> {
  const actor = SpWriteActor.parse(rawActor);
  const request = SpWriteOperationRequest.parse(rawRequest);
  const roots = await handle.sql<{ approval_id: string; generation: string }[]>`
    select approval_id::text, generation::text from public.sp_write_cycle_plans
     where org_id = ${actor.orgId}::uuid and profile_id = ${request.profileId}::uuid
       and execution_id = ${request.executionId}::uuid and plan_id = ${request.planId}::uuid
       and exists(select 1 from public.org_members where org_id = ${actor.orgId}::uuid
         and user_id = ${actor.userId}::uuid and role in ('owner','admin'))
  `;
  if (roots.length === 0) throw new SpWriteApplicationError('not_found');
  if (roots.length !== 1) throw new SpWriteApplicationError('identity_conflict');
  const root = roots[0]!;
  const evidence = await createSpWriteRuntimeLedger(handle).loadVerifiedExecution({
    orgId: actor.orgId, profileId: request.profileId, executionId: request.executionId,
    planId: request.planId, approvalId: root.approval_id, generation: root.generation,
  });
  if (evidence === null) throw new SpWriteApplicationError('not_found');
  const { plan, authorization: receipt, snapshot } = evidence;
  const [admission] = await handle.sql<{ queued: boolean }[]>`
    select exists(select 1 from public.sp_write_execution_requests
      where org_id = ${actor.orgId}::uuid and profile_id = ${request.profileId}::uuid
        and execution_id = ${request.executionId}::uuid and plan_id = ${request.planId}::uuid
        and approval_id = ${root.approval_id}::uuid and generation = ${root.generation}::uuid) as queued
  `;
  if (admission === undefined) throw new SpWriteApplicationError('outcome_unknown');
  const inverseRows = plan.direction === 'inverse' ? [] : await handle.sql<{ plan_id: string }[]>`
    select inverse.plan_id::text from public.sp_write_plans inverse
    join public.sp_write_cycle_plans child
      on child.org_id = inverse.org_id and child.profile_id = inverse.profile_id and child.plan_id = inverse.plan_id
     and child.execution_id = inverse.source_execution_id
    where inverse.org_id = ${actor.orgId}::uuid and inverse.profile_id = ${request.profileId}::uuid
      and inverse.source_execution_id = ${request.executionId}::uuid
      and inverse.source_plan_id = ${request.planId}::uuid and inverse.source_plan_fingerprint = ${plan.fingerprint}
      and inverse.direction = 'inverse'
    order by inverse.generated_at, inverse.plan_id
  `;
  return SpWriteOperationDetail.parse({
    operation: { executionId: request.executionId, planId: request.planId },
    admission: admission.queued ? 'queued' : 'approved_pending_start',
    receipt, snapshot, mirror: await readSpWriteMirrorCounts(handle, evidence),
    original: plan.source.kind === 'inverse_execution'
      ? { executionId: plan.source.sourceExecutionId, planId: plan.source.sourcePlanId } : null,
    inverses: inverseRows.map((inverse) => ({ executionId: request.executionId, planId: inverse.plan_id })),
  });
}
