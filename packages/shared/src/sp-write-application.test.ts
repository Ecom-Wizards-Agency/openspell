import { describe, expect, it } from 'vitest';
import {
  SpWriteActor,
  SpWriteAdmission,
  SpWriteInversePreviewRequest,
  SpWriteManualApprovalRequest,
  SpWriteOperationDetail,
  SpWriteOperationId,
  SpWritePreviewRequest,
} from './sp-write-application.js';

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;

function operationFixture() {
  const binding = {
    planId: id('2'), planFingerprint: 'a'.repeat(64), orgId: id('5'), profileId: id('6'),
    providerScope: {
      amazonProfileId: 'synthetic-profile', connectionId: id('7'), region: 'NA',
      marketplaceId: 'synthetic-marketplace', currencyCode: 'USD', apiDialect: 'sp_v3',
    },
    direction: 'forward', expiresAt: '2026-09-05T12:15:00.000Z',
    counts: { logicalChanges: 1, providerRows: 1, uniqueEntities: 1, byRoute: {
      'sp.v3.campaigns.update': 0, 'sp.v3.ad_groups.update': 0, 'sp.v3.keywords.update': 1,
      'sp.v3.targets.update': 0, 'sp.v3.product_ads.update': 0,
    } },
  };
  return {
    operation: { executionId: id('1'), planId: id('2') }, admission: 'approved_pending_start',
    receipt: {
      schemaVersion: 'openspell.sp-write-authorization-receipt.v1',
      approvalId: id('3'), approvalRequestId: id('4'), executionId: id('1'), generation: id('8'),
      approvalMode: 'manual', plan: binding, preapprovedInversePlan: null, boundedAuthorization: null,
      approvedBy: id('9'), approvedAt: '2026-09-05T12:00:00.000Z', expiresAt: binding.expiresAt,
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
      gateSnapshot: { environmentGate: 'enabled', environmentGateVersion: id('10'), profileGrantId: id('11'), profileGrantVersion: id('12'),
        checkedAt: '2026-09-05T12:00:00.000Z', gateSnapshotFingerprint: 'b'.repeat(64) },
    },
    snapshot: { status: 'queued', accounting: {
      approvedRows: 1, pendingDispatch: 1, refusedBeforeDispatch: 0, intentCommitted: 0,
      providerAccepted: 0, providerRejected: 0, providerAmbiguous: 0, observedRequested: 0,
      observedExpectedAfterAmbiguous: 0, observationConflict: 0, observationMissing: 0,
      pendingObservation: 0, providerCallsCommitted: 0, providerCallsCompleted: 0,
    } }, original: null, inverses: [],
  };
}

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

  it('binds manual approval to the profile being authorized', () => {
    const receipt = operationFixture().receipt;
    const request = {
      profileId: receipt.plan.profileId,
      approval: {
        approvalRequestId: receipt.approvalRequestId, plan: receipt.plan, approvalMode: 'manual',
        confirmationVersion: receipt.confirmationVersion, boundedAuthorization: null, preapprovedInversePlan: null,
      },
    };
    expect(SpWriteManualApprovalRequest.safeParse(request).success).toBe(true);
    expect(SpWriteManualApprovalRequest.safeParse({ ...request, profileId: id('99') }).success).toBe(false);
  });

  it('refuses status counts and execution facts that disagree with a recorded approval', () => {
    const fixture = operationFixture();
    expect(SpWriteOperationDetail.parse(fixture).operation).toEqual(fixture.operation);
    expect(SpWriteOperationDetail.safeParse({ ...fixture, snapshot: { ...fixture.snapshot, status: 'succeeded' } }).success).toBe(false);
    expect(SpWriteOperationDetail.safeParse({ ...fixture, snapshot: {
      status: 'queued', accounting: { ...fixture.snapshot.accounting, approvedRows: 0, pendingDispatch: 0 },
    } }).success).toBe(false);
  });

  it('keeps inverse lineage in the same cycle and bound to the original profile', () => {
    const fixture = operationFixture();
    expect(SpWriteOperationDetail.safeParse({ ...fixture, inverses: [{ executionId: id('99'), planId: id('98') }] }).success).toBe(false);
    const inverse = {
      ...fixture, operation: { ...fixture.operation, planId: id('20') },
      original: fixture.operation,
      receipt: { ...fixture.receipt, approvalMode: 'bounded_live_test',
        preapprovedInversePlan: { ...fixture.receipt.plan, planId: id('20'), direction: 'inverse' },
        boundedAuthorization: { authorizationId: id('21'), authorizationFingerprint: 'c'.repeat(64), expiresAt: fixture.receipt.expiresAt },
      },
    };
    expect(SpWriteOperationDetail.parse(inverse).original).toEqual(fixture.operation);
    expect(SpWriteOperationDetail.safeParse({ ...inverse, original: null }).success).toBe(false);
    expect(SpWriteOperationDetail.safeParse({ ...inverse, receipt: { ...inverse.receipt,
      preapprovedInversePlan: { ...inverse.receipt.preapprovedInversePlan, profileId: id('99') },
    } }).success).toBe(false);
  });
});
