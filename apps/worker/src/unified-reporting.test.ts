import {
  AdsApiParseError,
  UnifiedReportCreateAmbiguousError,
} from '@wizard-ads/ads-api';
import {
  UnifiedReportOperation,
  UnifiedReportRun,
  type UnifiedReportAdvanceJob,
} from '@wizard-ads/shared';
import { describe, expect, it, vi } from 'vitest';
import type {
  AdsProfileContext,
  UnifiedReportingClient,
  UnifiedReportMetadata,
} from './ads-api.js';
import {
  campaignObservationDefinition,
  UNIFIED_CAMPAIGN_OBSERVATION_FIELDS,
  WorkerUnifiedDualRun,
  type UnifiedBeginResult,
  type UnifiedDualRunStore,
  type UnifiedSettlement,
} from './unified-reporting.js';
import { RegionTokenBuckets } from './region-token-buckets.js';

const orgId = '11111111-1111-4111-8111-111111111111';
const profileId = '22222222-2222-4222-8222-222222222222';
const v3RequestId = '33333333-3333-4333-8333-333333333333';
const bindingId = '44444444-4444-4444-8444-444444444444';
const runId = '55555555-5555-4555-8555-555555555555';
const operationId = '66666666-6666-4666-8666-666666666666';
const jobId = '77777777-7777-4777-8777-777777777777';
const dispatchToken = '88888888-8888-4888-8888-888888888888';
const advertiserAccountId = 'synthetic-advertiser-account';
const now = new Date('2026-08-31T00:00:00.000Z');

const profile: AdsProfileContext = {
  id: profileId,
  orgId,
  amazonProfileId: 'synthetic-profile',
  region: 'NA',
  currencyCode: 'USD',
  timezone: 'UTC',
};

const payload: UnifiedReportAdvanceJob = {
  type: 'report.unified.advance', orgId, profileId, runId, operationId,
};

describe('Unified Reporting sidecar', () => {
  it('keeps the disabled and non-allowlisted paths free of store and provider work', async () => {
    const store = fakeStore();
    const provider = fakeProvider();
    const disabled = new WorkerUnifiedDualRun({
      policy: { enabled: false, profileIds: [] }, store, provider, now: () => now,
    });
    await expect(disabled.admit(admission())).resolves.toEqual({ kind: 'disabled' });

    const excluded = new WorkerUnifiedDualRun({
      policy: { enabled: true, profileIds: [orgId] }, store, provider, now: () => now,
    });
    await expect(excluded.admit(admission())).resolves.toEqual({ kind: 'profile_not_allowed' });
    expect(store.admit).not.toHaveBeenCalled();
    expect(provider.createUnifiedReport).not.toHaveBeenCalled();
  });

  it('admits only spCampaigns with one fixed, primary-evidenced definition', async () => {
    const store = fakeStore();
    const worker = sidecar(store, fakeProvider());
    await expect(worker.admit(admission())).resolves.toMatchObject({ kind: 'enqueued' });
    await expect(worker.admit({ ...admission(), reportType: 'spTargeting' }))
      .resolves.toEqual({ kind: 'unsupported_report_type' });
    expect(store.admit).toHaveBeenCalledTimes(1);
    expect(campaignObservationDefinition('2026-08-01', '2026-08-02')).toEqual({
      format: 'CSV',
      periods: [{ startDate: '2026-08-01', endDate: '2026-08-02' }],
      fields: [...UNIFIED_CAMPAIGN_OBSERVATION_FIELDS],
    });
  });

  it('fences one create, stores success, and schedules the first observation', async () => {
    const store = fakeStore({ begin: dispatch('create', 0) });
    const provider = fakeProvider();
    const worker = sidecar(store, provider);

    await expect(worker.advance({ jobId, attempts: 1, profile, payload })).resolves.toMatchObject({
      state: 'observing', disposition: 'provider_success', providerCalls: 1,
    });
    expect(provider.createUnifiedReport).toHaveBeenCalledTimes(1);
    expect(store.settle).toHaveBeenCalledWith(expect.objectContaining({
      runId, operationId, dispatchToken,
      disposition: 'provider_success',
      runState: 'observing',
      providerReportId: 'provider-report',
      providerStatus: 'PENDING',
      nextRunAt: new Date('2026-08-31T00:05:00.000Z'),
    }));
  });

  it('keeps a near-horizon create result but does not schedule an out-of-window retrieve', async () => {
    const store = fakeStore({ begin: dispatch('create', 0) });
    const provider = fakeProvider();
    const worker = new WorkerUnifiedDualRun({
      policy: { enabled: true, profileIds: [profileId] },
      store,
      provider,
      now: () => new Date('2026-08-31T03:58:00.000Z'),
    });
    await worker.advance({ jobId, attempts: 1, profile, payload });
    expect(store.settle).toHaveBeenCalledWith(expect.objectContaining({
      disposition: 'provider_success',
      runState: 'observation_horizon_reached',
      providerReportId: 'provider-report',
    }));
    expect(store.settle.mock.calls[0]?.[0]).not.toHaveProperty('nextRunAt');
  });

  it('never retries an ambiguous create and records no provider detail', async () => {
    const store = fakeStore({ begin: dispatch('create', 0) });
    const provider = fakeProvider({
      create: async () => { throw new UnifiedReportCreateAmbiguousError(1, 'transport', 0); },
    });
    const worker = sidecar(store, provider);

    await worker.advance({ jobId, attempts: 1, profile, payload });
    expect(provider.createUnifiedReport).toHaveBeenCalledTimes(1);
    expect(store.settle).toHaveBeenCalledWith({
      runId, operationId, dispatchToken, now,
      disposition: 'create_ambiguous', runState: 'create_ambiguous',
    });

    store.begin.mockResolvedValueOnce({
      kind: 'recovered', runState: 'create_ambiguous', successorEnqueued: false,
    });
    await worker.advance({ jobId, attempts: 2, profile, payload });
    expect(provider.createUnifiedReport).toHaveBeenCalledTimes(1);
  });

  it('treats a post-dispatch create parse failure as ambiguity, never as retryable work', async () => {
    const store = fakeStore({ begin: dispatch('create', 0) });
    const provider = fakeProvider({
      create: async () => { throw new AdsApiParseError('malformed create response'); },
    });
    await sidecar(store, provider).advance({ jobId, attempts: 1, profile, payload });
    expect(store.settle).toHaveBeenCalledWith(expect.objectContaining({
      disposition: 'create_ambiguous', runState: 'create_ambiguous',
    }));
  });

  it('retains no foreign provider identity from an account-mismatched create', async () => {
    const store = fakeStore({ begin: dispatch('create', 0) });
    const provider = fakeProvider({ linkedAdvertiserAccountIds: ['different-account'] });
    await sidecar(store, provider).advance({ jobId, attempts: 1, profile, payload });
    expect(store.settle).toHaveBeenCalledWith({
      runId,
      operationId,
      dispatchToken,
      now,
      disposition: 'invalid_response',
      runState: 'local_failed',
    });
  });

  it('records PENDING retrieval and schedules another idempotent observation', async () => {
    const store = fakeStore({ begin: dispatch('retrieve', 1) });
    const provider = fakeProvider();
    const worker = sidecar(store, provider);
    await worker.advance({ jobId, attempts: 1, profile, payload });
    expect(provider.retrieveUnifiedReport).toHaveBeenCalledTimes(1);
    expect(store.settle).toHaveBeenCalledWith(expect.objectContaining({
      disposition: 'provider_success', runState: 'observing',
      nextRunAt: new Date('2026-08-31T00:10:00.000Z'),
    }));
  });

  it('stops on opaque non-PENDING metadata without claiming completion', async () => {
    const store = fakeStore({ begin: dispatch('retrieve', 1) });
    const provider = fakeProvider({ retrieveStatus: 'FUTURE_PROVIDER_STATE' });
    const worker = sidecar(store, provider);
    await worker.advance({ jobId, attempts: 1, profile, payload });
    expect(store.settle).toHaveBeenCalledWith(expect.objectContaining({
      disposition: 'provider_success',
      runState: 'provider_status_observed',
      providerStatus: 'FUTURE_PROVIDER_STATE',
    }));
    expect(store.settle.mock.calls[0]?.[0]).not.toHaveProperty('nextRunAt');
  });

  it('turns unproven completed-part parsing into a terminal contract block', async () => {
    const store = fakeStore({ begin: dispatch('retrieve', 1) });
    const provider = fakeProvider({
      retrieve: async () => { throw new AdsApiParseError('unproven completed parts'); },
    });
    const worker = sidecar(store, provider);
    await worker.advance({ jobId, attempts: 1, profile, payload });
    expect(store.settle).toHaveBeenCalledWith(expect.objectContaining({
      disposition: 'invalid_response', runState: 'contract_blocked',
    }));
  });

  it('contract-blocks retrieve metadata linked to a different advertiser account', async () => {
    const store = fakeStore({ begin: dispatch('retrieve', 1) });
    const provider = fakeProvider({ linkedAdvertiserAccountIds: ['different-account'] });
    await sidecar(store, provider).advance({ jobId, attempts: 1, profile, payload });
    expect(store.settle).toHaveBeenCalledWith(expect.objectContaining({
      disposition: 'invalid_response',
      runState: 'contract_blocked',
      providerReportId: 'provider-report',
    }));
  });

  it('shares the regional provider concurrency budget with the established worker path', async () => {
    const base = fakeProvider();
    let active = 0;
    let maximumActive = 0;
    const provider: UnifiedReportingClient = {
      ...base,
      createUnifiedReport: vi.fn(async (input) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const result = await base.createUnifiedReport(input);
        active -= 1;
        return result;
      }),
    };
    const buckets = new RegionTokenBuckets(1);
    const workers = [fakeStore({ begin: dispatch('create', 0) }), fakeStore({ begin: dispatch('create', 0) })]
      .map((store) => new WorkerUnifiedDualRun({
        policy: { enabled: true, profileIds: [profileId] },
        store,
        provider,
        buckets,
        now: () => now,
      }));
    await Promise.all(workers.map((worker) =>
      worker.advance({ jobId, attempts: 1, profile, payload })));
    expect(provider.createUnifiedReport).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);
  });

  it('rechecks the binding after a regional-capacity wait and before any provider call', async () => {
    const buckets = new RegionTokenBuckets(1);
    let releaseCapacity!: () => void;
    let markCapacityHeld!: () => void;
    const capacityHeld = new Promise<void>((resolve) => { markCapacityHeld = resolve; });
    const capacityRelease = new Promise<void>((resolve) => { releaseCapacity = resolve; });
    const holder = buckets.run('NA', async () => {
      markCapacityHeld();
      await capacityRelease;
    });
    await capacityHeld;

    const store = fakeStore({ begin: dispatch('create', 0) });
    const provider = fakeProvider();
    const worker = new WorkerUnifiedDualRun({
      policy: { enabled: true, profileIds: [profileId] },
      store,
      provider,
      buckets,
      now: () => now,
    });
    const advancing = worker.advance({ jobId, attempts: 1, profile, payload });
    await vi.waitFor(() => expect(buckets.snapshot('NA')).toEqual({
      active: 1,
      waiting: 1,
      capacity: 1,
    }));
    expect(store.begin).not.toHaveBeenCalled();
    expect(provider.createUnifiedReport).not.toHaveBeenCalled();

    // This represents an operator disabling the durable account binding while
    // the provider lane is saturated. begin() must observe that later state.
    store.begin.mockResolvedValueOnce({
      kind: 'settled',
      runState: 'paused',
    });
    releaseCapacity();
    await holder;

    await expect(advancing).resolves.toMatchObject({ state: 'paused', providerCalls: 0 });
    expect(store.begin).toHaveBeenCalledTimes(1);
    expect(provider.createUnifiedReport).not.toHaveBeenCalled();
    expect(provider.retrieveUnifiedReport).not.toHaveBeenCalled();
  });

  it('releases regional provider capacity before durable settlement', async () => {
    const buckets = new RegionTokenBuckets(1);
    const store = fakeStore({ begin: dispatch('create', 0) });
    let releaseSettlement!: () => void;
    const settlementRelease = new Promise<void>((resolve) => { releaseSettlement = resolve; });
    store.settle.mockImplementationOnce(async (input) => {
      await settlementRelease;
      return { runState: input.runState, successorEnqueued: input.nextRunAt !== undefined };
    });
    const worker = new WorkerUnifiedDualRun({
      policy: { enabled: true, profileIds: [profileId] },
      store,
      provider: fakeProvider(),
      buckets,
      now: () => now,
    });

    const advancing = worker.advance({ jobId, attempts: 1, profile, payload });
    await vi.waitFor(() => expect(store.settle).toHaveBeenCalledTimes(1));
    expect(buckets.snapshot('NA')).toEqual({ active: 0, waiting: 0, capacity: 1 });
    let establishedPathStarted = false;
    await buckets.run('NA', async () => { establishedPathStarted = true; });
    expect(establishedPathStarted).toBe(true);

    releaseSettlement();
    await expect(advancing).resolves.toMatchObject({
      state: 'observing',
      providerCalls: 1,
    });
  });

  it('does no Unified work when the deployment gate is gone', async () => {
    const store = fakeStore();
    const provider = fakeProvider();
    const worker = new WorkerUnifiedDualRun({
      policy: { enabled: false, profileIds: [] }, store, provider, now: () => now,
    });
    await worker.advance({ jobId, attempts: 1, profile, payload });
    expect(store.begin).not.toHaveBeenCalled();
    expect(store.settle).not.toHaveBeenCalled();
    expect(store.failTerminal).not.toHaveBeenCalled();
    expect(provider.createUnifiedReport).not.toHaveBeenCalled();
    expect(provider.retrieveUnifiedReport).not.toHaveBeenCalled();
  });

  it('closes queued work whose profile leaves an otherwise enabled cohort', async () => {
    const store = fakeStore();
    const provider = fakeProvider();
    const worker = new WorkerUnifiedDualRun({
      policy: { enabled: true, profileIds: [orgId] }, store, provider, now: () => now,
    });
    await worker.advance({ jobId, attempts: 1, profile, payload });
    expect(store.failTerminal).toHaveBeenCalledTimes(1);
    expect(provider.createUnifiedReport).not.toHaveBeenCalled();
    expect(provider.retrieveUnifiedReport).not.toHaveBeenCalled();
  });
});

function admission() {
  return {
    v3ReportRequestId: v3RequestId,
    profile,
    reportType: 'spCampaigns' as const,
    startDate: '2026-08-01',
    endDate: '2026-08-02',
  };
}

function sidecar(store: ReturnType<typeof fakeStore>, provider: ReturnType<typeof fakeProvider>) {
  return new WorkerUnifiedDualRun({
    policy: { enabled: true, profileIds: [profileId] }, store, provider, now: () => now,
  });
}

function dispatch(kind: 'create' | 'retrieve', sequence: number): UnifiedBeginResult {
  const accounting = {
    operationCount: 1, settledOperationCount: 0, inputCount: 1,
    providerSuccessCount: 0, providerRefusedCount: 0, createAmbiguousCount: 0,
    transportFailureCount: 0, invalidResponseCount: 0, localRefusalCount: 0,
    interruptedDispatchCount: 0,
  };
  const run = UnifiedReportRun.parse({
    id: runId, orgId, profileId, v3ReportRequestId: v3RequestId, bindingId,
    advertiserAccountId, reportType: 'spCampaigns',
    definitionVersion: 'campaign-observation-v1',
    startDate: '2026-08-01', endDate: '2026-08-02',
    state: kind === 'create' ? 'create_dispatching' : 'observing',
    providerReportId: kind === 'create' ? null : 'provider-report',
    providerStatus: kind === 'create' ? null : 'PENDING',
    observationDeadline: '2026-08-31T04:00:00.000Z', accounting,
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
  });
  const operation = UnifiedReportOperation.parse({
    id: operationId, orgId, profileId, runId, dispatchJobId: jobId,
    kind, sequence, state: 'dispatching', disposition: null,
    dispatchToken, dispatchedAt: now.toISOString(), settledAt: null,
    providerCode: null,
    accounting: {
      inputCount: 1, providerSuccessCount: 0, providerRefusedCount: 0,
      createAmbiguousCount: 0, transportFailureCount: 0, invalidResponseCount: 0,
      localRefusalCount: 0, interruptedDispatchCount: 0,
    },
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
  });
  return { kind: 'dispatch', value: { run, operation, dispatchToken } };
}

function fakeStore(options: { begin?: UnifiedBeginResult } = {}) {
  const settle = vi.fn(async (input: UnifiedSettlement) => ({
    runState: input.runState,
    successorEnqueued: input.nextRunAt !== undefined,
  }));
  return {
    admit: vi.fn(async () => ({ kind: 'enqueued' as const, runId, operationId, inserted: true })),
    begin: vi.fn(async () => options.begin ?? dispatch('create', 0)),
    settle,
    failTerminal: vi.fn(async () => undefined),
  } satisfies UnifiedDualRunStore;
}

function fakeProvider(options: {
  create?: UnifiedReportingClient['createUnifiedReport'];
  retrieve?: UnifiedReportingClient['retrieveUnifiedReport'];
  retrieveStatus?: string;
  linkedAdvertiserAccountIds?: string[];
} = {}) {
  const metadata = (status: string): UnifiedReportMetadata => ({
    reportId: 'provider-report', status, format: 'CSV',
    periods: [{ startDate: '2026-08-01', endDate: '2026-08-02' }],
    fields: [...UNIFIED_CAMPAIGN_OBSERVATION_FIELDS], filter: null,
    linkedAdvertiserAccountIds: options.linkedAdvertiserAccountIds ?? [advertiserAccountId],
    createdAt: now.toISOString(), updatedAt: now.toISOString(), completedAt: null,
    currencyOfView: null, locale: null, timeZoneMode: null, failureCode: null,
    completedParts: { kind: 'not-returned' },
  });
  return {
    createUnifiedReport: vi.fn(options.create ?? (async () => ({
      kind: 'created' as const, metadata: metadata('PENDING'),
    }))),
    retrieveUnifiedReport: vi.fn(options.retrieve ?? (async () => ({
      kind: 'observed' as const, metadata: metadata(options.retrieveStatus ?? 'PENDING'),
    }))),
  } satisfies UnifiedReportingClient;
}
