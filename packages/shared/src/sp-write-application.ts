import { z } from 'zod';
import { Uuid } from './primitives.js';
import {
  ApproveSpWritePlan,
  SpWriteAuthorizationReceipt,
  SpWriteExecutionSnapshot,
  SpWritePlan,
  SpWritePlanBinding,
  spWritePlanBinding,
} from './sp-writes.js';

/** Server authentication supplies this context; it is never part of request JSON. */
export const SpWriteActor = z.object({ orgId: Uuid, userId: Uuid }).strict();
export type SpWriteActor = z.infer<typeof SpWriteActor>;

/** Forward and inverse plans can belong to the same execution cycle. */
export const SpWriteOperationId = z.object({
  executionId: Uuid,
  planId: Uuid,
}).strict();
export type SpWriteOperationId = z.infer<typeof SpWriteOperationId>;

export const SpWritePreviewRequest = z.object({
  requestId: Uuid,
  profileId: Uuid,
  applyBatchId: Uuid,
}).strict();
export type SpWritePreviewRequest = z.infer<typeof SpWritePreviewRequest>;

export const SpWriteInversePreviewRequest = z.object({
  requestId: Uuid,
  profileId: Uuid,
  original: SpWriteOperationId,
}).strict();
export type SpWriteInversePreviewRequest = z.infer<typeof SpWriteInversePreviewRequest>;

/** Ordinary UI confirmation cannot create a bounded test authorization. */
export const SpWriteManualApprovalRequest = z.object({
  profileId: Uuid,
  approval: ApproveSpWritePlan.refine((value) => value.approvalMode === 'manual', {
    message: 'the UI approval endpoint accepts manual confirmation only',
  }),
}).strict().refine((value) => value.profileId === value.approval.plan.profileId, {
  path: ['profileId'], message: 'approval must bind the requested profile',
});
export type SpWriteManualApprovalRequest = z.infer<typeof SpWriteManualApprovalRequest>;

export const SpWriteOperationRequest = SpWriteOperationId.extend({
  profileId: Uuid,
}).strict();
export type SpWriteOperationRequest = z.infer<typeof SpWriteOperationRequest>;

export const SpWritePreview = z.object({
  plan: SpWritePlan,
  binding: SpWritePlanBinding,
}).strict().superRefine((value, context) => {
  if (JSON.stringify(spWritePlanBinding(value.plan)) !== JSON.stringify(value.binding)) {
    context.addIssue({ code: 'custom', path: ['binding'], message: 'preview binding differs from its plan' });
  }
});
export type SpWritePreview = z.infer<typeof SpWritePreview>;

/** A known approval survives a lost or failed enqueue response and can be resumed. */
export const SpWriteAdmission = z.object({
  kind: z.enum(['queued', 'approved_pending_start']),
  operation: SpWriteOperationId,
  approvalId: Uuid,
  approvalRequestId: Uuid,
}).strict();
export type SpWriteAdmission = z.infer<typeof SpWriteAdmission>;

export const SpWriteOperationDetail = z.object({
  operation: SpWriteOperationId,
  admission: z.enum(['queued', 'approved_pending_start']),
  receipt: SpWriteAuthorizationReceipt,
  snapshot: SpWriteExecutionSnapshot,
  original: SpWriteOperationId.nullable(),
  inverses: z.array(SpWriteOperationId),
}).strict().superRefine((value, context) => {
  const receiptPlans = [value.receipt.plan, value.receipt.preapprovedInversePlan];
  const binding = receiptPlans.find((plan) => plan?.planId === value.operation.planId);
  if (value.operation.executionId !== value.receipt.executionId
    || binding === undefined || binding === null) {
    context.addIssue({ code: 'custom', path: ['operation'], message: 'operation differs from its receipt' });
  }
  const inverseBinding = value.receipt.preapprovedInversePlan;
  if (inverseBinding !== null && (
    inverseBinding.direction !== 'inverse'
    || inverseBinding.planId === value.receipt.plan.planId
    || inverseBinding.orgId !== value.receipt.plan.orgId
    || inverseBinding.profileId !== value.receipt.plan.profileId
    || JSON.stringify(inverseBinding.providerScope) !== JSON.stringify(value.receipt.plan.providerScope)
    || JSON.stringify(inverseBinding.counts) !== JSON.stringify(value.receipt.plan.counts)
  )) {
    context.addIssue({ code: 'custom', path: ['receipt'], message: 'bounded inverse scope differs from its forward plan' });
  }
  if (binding != null && (binding.direction === 'inverse') !== (value.original !== null)) {
    context.addIssue({ code: 'custom', path: ['original'], message: 'only inverse operations require an original link' });
  }
  if (value.original !== null && (
    value.original.planId === value.operation.planId
    || value.original.executionId !== value.operation.executionId
    || (binding === inverseBinding && value.original.planId !== value.receipt.plan.planId)
  )) {
    context.addIssue({ code: 'custom', path: ['original'], message: 'original link differs from the source cycle' });
  }
  const inversePlans = value.inverses.map((inverse) => inverse.planId);
  if (new Set(inversePlans).size !== inversePlans.length || inversePlans.includes(value.operation.planId)
    || value.inverses.some((inverse) => inverse.executionId !== value.operation.executionId)
    || (binding?.direction === 'inverse' && value.inverses.length !== 0)) {
    context.addIssue({ code: 'custom', path: ['inverses'], message: 'inverse links must be distinct operations' });
  }
  if (binding != null && value.snapshot.accounting.approvedRows !== binding.counts.providerRows) {
    context.addIssue({ code: 'custom', path: ['snapshot'], message: 'accounting differs from the approved plan count' });
  }
  if (value.admission === 'approved_pending_start' && (
    value.snapshot.status !== 'queued'
    || value.snapshot.accounting.pendingDispatch !== value.snapshot.accounting.approvedRows
    || Object.entries(value.snapshot.accounting).some(([key, count]) =>
      !['approvedRows', 'pendingDispatch'].includes(key) && count !== 0)
  )) {
    context.addIssue({ code: 'custom', path: ['snapshot'], message: 'unstarted approval cannot contain execution evidence' });
  }
});
export type SpWriteOperationDetail = z.infer<typeof SpWriteOperationDetail>;
