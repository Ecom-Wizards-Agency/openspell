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
}).strict();
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
  const receiptPlans = [value.receipt.plan.planId, value.receipt.preapprovedInversePlan?.planId];
  if (value.operation.executionId !== value.receipt.executionId
    || !receiptPlans.includes(value.operation.planId)) {
    context.addIssue({ code: 'custom', path: ['operation'], message: 'operation differs from its receipt' });
  }
  if (value.original !== null && value.original.planId === value.operation.planId) {
    context.addIssue({ code: 'custom', path: ['original'], message: 'an operation cannot inverse itself' });
  }
  const inversePlans = value.inverses.map((inverse) => inverse.planId);
  if (new Set(inversePlans).size !== inversePlans.length || inversePlans.includes(value.operation.planId)) {
    context.addIssue({ code: 'custom', path: ['inverses'], message: 'inverse links must be distinct operations' });
  }
});
export type SpWriteOperationDetail = z.infer<typeof SpWriteOperationDetail>;
