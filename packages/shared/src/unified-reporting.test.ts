import { describe, expect, it } from 'vitest';
import {
  FeatureJobPayload,
  JobPayload,
  UnifiedReportOperation,
  UnifiedReportRun,
} from './index.js';

const ORG_ID = '00000000-0000-4000-8000-000000000001';
const PROFILE_ID = '00000000-0000-4000-8000-000000000002';
const REQUEST_ID = '00000000-0000-4000-8000-000000000003';
const BINDING_ID = '00000000-0000-4000-8000-000000000004';
const RUN_ID = '00000000-0000-4000-8000-000000000005';
const OPERATION_ID = '00000000-0000-4000-8000-000000000006';
const JOB_ID = '00000000-0000-4000-8000-000000000007';
const TOKEN_ID = '00000000-0000-4000-8000-000000000008';
const TIME = '2026-08-31T00:00:00.000Z';

const operationAccounting = {
  inputCount: 1,
  providerSuccessCount: 1,
  providerRefusedCount: 0,
  createAmbiguousCount: 0,
  transportFailureCount: 0,
  invalidResponseCount: 0,
  localRefusalCount: 0,
  interruptedDispatchCount: 0,
};

describe('Unified Reporting durable contracts', () => {
  it('round-trips the durable advance job through both queue unions', () => {
    const payload = {
      type: 'report.unified.advance',
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      runId: RUN_ID,
      operationId: OPERATION_ID,
    };
    expect(JobPayload.parse(payload)).toEqual(payload);
    expect(FeatureJobPayload.parse(payload)).toEqual(payload);
  });

  it('requires one settled disposition for every settled operation', () => {
    const operation = {
      id: OPERATION_ID,
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      runId: RUN_ID,
      dispatchJobId: JOB_ID,
      kind: 'create',
      sequence: 0,
      state: 'settled',
      disposition: 'provider_success',
      dispatchToken: TOKEN_ID,
      dispatchedAt: TIME,
      settledAt: TIME,
      providerCode: null,
      accounting: operationAccounting,
      createdAt: TIME,
      updatedAt: TIME,
    };
    expect(UnifiedReportOperation.parse(operation)).toEqual(operation);
    expect(UnifiedReportOperation.safeParse({
      ...operation,
      accounting: { ...operationAccounting, providerSuccessCount: 0 },
    }).success).toBe(false);
    expect(UnifiedReportOperation.safeParse({ ...operation, kind: 'retrieve', sequence: 0 }).success).toBe(false);
    expect(UnifiedReportOperation.safeParse({
      ...operation,
      kind: 'retrieve',
      sequence: 1,
      disposition: 'create_ambiguous',
      accounting: {
        ...operationAccounting,
        providerSuccessCount: 0,
        createAmbiguousCount: 1,
      },
    }).success).toBe(false);
  });

  it('keeps provider ids separate from opaque provider status', () => {
    const run = {
      id: RUN_ID,
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      v3ReportRequestId: REQUEST_ID,
      bindingId: BINDING_ID,
      advertiserAccountId: 'synthetic-advertiser',
      reportType: 'spCampaigns',
      definitionVersion: 'campaign-observation-v1',
      startDate: '2026-08-30',
      endDate: '2026-08-31',
      state: 'provider_status_observed',
      providerReportId: 'synthetic-report',
      providerStatus: 'PENDING',
      observationDeadline: TIME,
      accounting: {
        operationCount: 1,
        settledOperationCount: 1,
        inputCount: 1,
        providerSuccessCount: 1,
        providerRefusedCount: 0,
        createAmbiguousCount: 0,
        transportFailureCount: 0,
        invalidResponseCount: 0,
        localRefusalCount: 0,
        interruptedDispatchCount: 0,
      },
      createdAt: TIME,
      updatedAt: TIME,
    };
    expect(UnifiedReportRun.parse(run)).toEqual(run);
    expect(UnifiedReportRun.safeParse({ ...run, providerReportId: null }).success).toBe(false);
    expect(UnifiedReportRun.safeParse({ ...run, providerStatus: null }).success).toBe(false);
    expect(UnifiedReportRun.safeParse({
      ...run,
      state: 'local_failed',
      providerReportId: null,
      providerStatus: 'PENDING',
    }).success).toBe(false);
    expect(UnifiedReportRun.safeParse({ ...run, providerReportId: ' padded ' }).success).toBe(false);
    expect(UnifiedReportRun.safeParse({ ...run, providerReportId: 'x'.repeat(257) }).success).toBe(false);
  });
});
