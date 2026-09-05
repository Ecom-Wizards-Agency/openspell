import { describe, expect, it } from 'vitest';
import {
  SpWriteActor,
  SpWriteAdmission,
  SpWriteInversePreviewRequest,
  SpWriteOperationId,
  SpWritePreviewRequest,
} from './sp-write-application.js';

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;

describe('write application boundary', () => {
  it('requires a plan identity even when forward and inverse share an execution cycle', () => {
    const forward = SpWriteOperationId.parse({ executionId: id('1'), planId: id('2') });
    const inverse = SpWriteOperationId.parse({ executionId: id('1'), planId: id('3') });
    expect(forward).not.toEqual(inverse);
    expect(SpWriteOperationId.safeParse({ executionId: id('1') }).success).toBe(false);
    expect(SpWriteInversePreviewRequest.parse({
      requestId: id('4'), profileId: id('5'), original: forward,
    }).original).toEqual(forward);
  });

  it('rejects caller-supplied actor and provider authority in preview requests', () => {
    const request = { requestId: id('1'), profileId: id('2'), applyBatchId: id('3') };
    expect(SpWritePreviewRequest.safeParse(request).success).toBe(true);
    for (const extra of [{ userId: id('4') }, { orgId: id('5') }, { writeEnabled: true }]) {
      expect(SpWritePreviewRequest.safeParse({ ...request, ...extra }).success).toBe(false);
    }
    expect(SpWriteActor.safeParse({ orgId: id('1'), userId: 'unverified' }).success).toBe(false);
  });

  it('retains the same operation after approval when enqueue is unresolved', () => {
    const approved = SpWriteAdmission.parse({
      kind: 'approved_pending_start', operation: { executionId: id('1'), planId: id('2') },
      approvalId: id('3'), approvalRequestId: id('4'),
    });
    expect(SpWriteAdmission.parse({ ...approved, kind: 'queued' }).operation).toEqual(approved.operation);
    expect(SpWriteAdmission.safeParse({ ...approved, kind: 'applied' }).success).toBe(false);
    expect(SpWriteAdmission.safeParse({ ...approved, outboxId: id('5') }).success).toBe(false);
  });
});
