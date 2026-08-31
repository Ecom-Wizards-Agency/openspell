import { randomUUID } from 'node:crypto';
import {
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from '@wizard-ads/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresUnifiedDualRunStore } from './unified-reporting-store.js';
import type {
  AdsProfileContext,
  UnifiedReportingClient,
  UnifiedReportMetadata,
} from './ads-api.js';
import {
  UNIFIED_CAMPAIGN_OBSERVATION_FIELDS,
  WorkerUnifiedDualRun,
} from './unified-reporting.js';
import { RegionTokenBuckets } from './region-token-buckets.js';

const available = await databaseAvailable();
const USER = '71717171-7171-4717-8717-717171717171';
const NOW = new Date('2026-08-31T12:00:00.000Z');

describe.skipIf(!available)('Unified Reporting store + real Postgres', () => {
  let database: TestDatabase;
  let store: PostgresUnifiedDualRunStore;
  let orgId: string;
  let profileId: string;

  beforeAll(async () => {
    database = await createTestDatabase('unified_store');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('unified-store', ${USER}, 'owner')
    `;
    orgId = org?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId} limit 1
    `;
    profileId = profile?.id ?? '';
    store = new PostgresUnifiedDualRunStore(database);
  });

  beforeEach(async () => {
    await database.sql`
      update public.unified_reporting_bindings
         set enabled = true,
             advertiser_account_id = 'synthetic-unified-account',
             definition_version = 'campaign-observation-v1',
             updated_at = ${NOW.toISOString()}::timestamptz
       where org_id = ${orgId} and profile_id = ${profileId}
    `;
  });

  afterAll(async () => database.drop());

  it('atomically admits one run, operation, and queue job under concurrent replay', async () => {
    const requestId = await insertV3Request(database, orgId, profileId);
    const [left, right] = await Promise.all([
      store.admit(admission(requestId, orgId, profileId)),
      store.admit(admission(requestId, orgId, profileId)),
    ]);
    expect([left, right].filter((result) => result.kind === 'enqueued' && result.inserted))
      .toHaveLength(1);
    expect(left.kind).toBe('enqueued');
    expect(right.kind).toBe('enqueued');

    const runId = left.kind === 'enqueued' ? left.runId : '';
    expect(right.kind === 'enqueued' ? right.runId : '').toBe(runId);
    const [counts] = await database.sql<{
      runs: string;
      operations: string;
      jobs: string;
    }[]>`
      select
        (select count(*) from public.unified_report_runs where id = ${runId}) as runs,
        (select count(*) from public.unified_report_operations where run_id = ${runId}) as operations,
        (select count(*) from public.sync_jobs
          where dedupe_key = ${`report.unified.advance:${runId}:0`}) as jobs
    `;
    expect(counts).toEqual({ runs: '1', operations: '1', jobs: '1' });
  });

  it('refuses admission until the matching v3 poll job is durable', async () => {
    const requestId = await insertV3Request(database, orgId, profileId, false);
    await expect(store.admit(admission(requestId, orgId, profileId)))
      .rejects.toThrow(/v3 request and poll job/);
    const [count] = await database.sql<{ runs: string }[]>`
      select count(*) as runs
        from public.unified_report_runs
       where v3_report_request_id = ${requestId}
    `;
    expect(count?.runs).toBe('0');
  });

  it('turns an interrupted create fence into terminal ambiguity without a successor', async () => {
    const admitted = await admitFresh(store, database, orgId, profileId);
    const jobId = await operationJobId(database, admitted.operationId);
    const payload = { type: 'report.unified.advance' as const, orgId, profileId, ...admitted };

    const first = await store.begin({ jobId, payload, now: NOW });
    expect(first.kind).toBe('dispatch');
    const replay = await store.begin({
      jobId,
      payload,
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(replay).toEqual({
      kind: 'recovered',
      runState: 'create_ambiguous',
      successorEnqueued: false,
    });

    const [ledger] = await database.sql<{
      state: string;
      operation_count: number;
      settled_operation_count: number;
      create_ambiguous_count: number;
      operation_state: string;
      disposition: string;
    }[]>`
      select r.state, r.operation_count, r.settled_operation_count,
             r.create_ambiguous_count, o.state as operation_state, o.disposition
        from public.unified_report_runs r
        join public.unified_report_operations o on o.run_id = r.id
       where r.id = ${admitted.runId}
    `;
    expect(ledger).toMatchObject({
      state: 'create_ambiguous',
      operation_count: 1,
      settled_operation_count: 1,
      create_ambiguous_count: 1,
      operation_state: 'settled',
      disposition: 'create_ambiguous',
    });
  });

  it('accepts a late same-token create result as stronger evidence than ambiguity', async () => {
    const admitted = await admitFresh(store, database, orgId, profileId);
    const jobId = await operationJobId(database, admitted.operationId);
    const payload = { type: 'report.unified.advance' as const, orgId, profileId, ...admitted };
    const first = await store.begin({ jobId, payload, now: NOW });
    if (first.kind !== 'dispatch') throw new Error('expected create dispatch');
    await store.begin({ jobId, payload, now: new Date(NOW.getTime() + 60_000) });

    await expect(store.settle({
      runId: admitted.runId,
      operationId: admitted.operationId,
      dispatchToken: first.value.dispatchToken,
      now: new Date(NOW.getTime() + 2 * 60_000),
      disposition: 'provider_success',
      runState: 'observing',
      providerReportId: 'synthetic-late-provider-report',
      providerStatus: 'PENDING',
      nextRunAt: new Date(NOW.getTime() + 7 * 60_000),
    })).resolves.toEqual({ runState: 'observing', successorEnqueued: true });

    const [ledger] = await database.sql<{
      state: string;
      provider_success_count: number;
      create_ambiguous_count: number;
      disposition: string;
      operations: string;
    }[]>`
      select r.state, r.provider_success_count, r.create_ambiguous_count,
             c.disposition,
             (select count(*) from public.unified_report_operations o where o.run_id = r.id) as operations
        from public.unified_report_runs r
        join public.unified_report_operations c
          on c.run_id = r.id and c.kind = 'create'
       where r.id = ${admitted.runId}
    `;
    expect(ledger).toEqual({
      state: 'observing',
      provider_success_count: 1,
      create_ambiguous_count: 0,
      disposition: 'provider_success',
      operations: '2',
    });
  });

  it('strengthens late account-mismatch evidence without retaining provider identity', async () => {
    const admitted = await admitFresh(store, database, orgId, profileId);
    const jobId = await operationJobId(database, admitted.operationId);
    const payload = { type: 'report.unified.advance' as const, orgId, profileId, ...admitted };
    const first = await store.begin({ jobId, payload, now: NOW });
    if (first.kind !== 'dispatch') throw new Error('expected create dispatch');
    await store.begin({ jobId, payload, now: new Date(NOW.getTime() + 60_000) });

    await expect(store.settle({
      runId: admitted.runId,
      operationId: admitted.operationId,
      dispatchToken: first.value.dispatchToken,
      now: new Date(NOW.getTime() + 2 * 60_000),
      disposition: 'invalid_response',
      runState: 'local_failed',
    })).resolves.toEqual({ runState: 'local_failed', successorEnqueued: false });

    const [ledger] = await database.sql<{
      state: string;
      provider_report_id: string | null;
      provider_status: string | null;
      invalid_response_count: number;
      create_ambiguous_count: number;
      disposition: string;
    }[]>`
      select r.state, r.provider_report_id, r.provider_status,
             r.invalid_response_count, r.create_ambiguous_count, o.disposition
        from public.unified_report_runs r
        join public.unified_report_operations o
          on o.run_id = r.id and o.kind = 'create'
       where r.id = ${admitted.runId}
    `;
    expect(ledger).toEqual({
      state: 'local_failed',
      provider_report_id: null,
      provider_status: null,
      invalid_response_count: 1,
      create_ambiguous_count: 0,
      disposition: 'invalid_response',
    });
  });

  it('makes one provider create call when recovery races an in-flight create', async () => {
    const admitted = await admitFresh(store, database, orgId, profileId);
    const jobId = await operationJobId(database, admitted.operationId);
    const payload = { type: 'report.unified.advance' as const, orgId, profileId, ...admitted };
    const profile: AdsProfileContext = {
      id: profileId,
      orgId,
      amazonProfileId: 'synthetic-profile',
      region: 'NA',
      currencyCode: 'USD',
      timezone: 'UTC',
    };
    let createCalls = 0;
    let releaseCreate: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const metadata: UnifiedReportMetadata = {
      reportId: 'synthetic-raced-report',
      status: 'PENDING',
      format: 'CSV',
      periods: [{ startDate: '2026-08-01', endDate: '2026-08-02' }],
      fields: [...UNIFIED_CAMPAIGN_OBSERVATION_FIELDS],
      filter: null,
      linkedAdvertiserAccountIds: ['synthetic-unified-account'],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      completedAt: null,
      currencyOfView: null,
      locale: null,
      timeZoneMode: null,
      failureCode: null,
      completedParts: { kind: 'not-returned' },
    };
    const provider: UnifiedReportingClient = {
      createUnifiedReport: async () => {
        createCalls += 1;
        markStarted?.();
        await release;
        return { kind: 'created', metadata };
      },
      retrieveUnifiedReport: async () => { throw new Error('unused'); },
    };
    const coordinator = new WorkerUnifiedDualRun({
      policy: { enabled: true, profileIds: [profileId] },
      store,
      provider,
      now: () => NOW,
    });

    const original = coordinator.advance({ jobId, attempts: 1, profile, payload });
    await started;
    const recovery = await coordinator.advance({ jobId, attempts: 2, profile, payload });
    expect(recovery).toMatchObject({
      state: 'create_ambiguous', providerCalls: 0, recovered: true,
    });
    releaseCreate?.();
    await expect(original).resolves.toMatchObject({
      state: 'observing', providerCalls: 1, successorEnqueued: true,
    });
    expect(createCalls).toBe(1);

    const [ledger] = await database.sql<{
      state: string;
      provider_success_count: number;
      create_ambiguous_count: number;
      operations: string;
    }[]>`
      select r.state, r.provider_success_count, r.create_ambiguous_count,
             (select count(*) from public.unified_report_operations o where o.run_id = r.id) as operations
        from public.unified_report_runs r
       where r.id = ${admitted.runId}
    `;
    expect(ledger).toEqual({
      state: 'observing',
      provider_success_count: 1,
      create_ambiguous_count: 0,
      operations: '2',
    });
  });

  it('refuses a create first claimed after its observation deadline', async () => {
    const admitted = await admitFresh(store, database, orgId, profileId);
    const jobId = await operationJobId(database, admitted.operationId);
    await expect(store.begin({
      jobId,
      payload: { type: 'report.unified.advance', orgId, profileId, ...admitted },
      now: new Date(NOW.getTime() + 4 * 60 * 60_000),
    })).resolves.toEqual({
      kind: 'recovered', runState: 'local_failed', successorEnqueued: false,
    });
    const [operation] = await database.sql<{ disposition: string; dispatch_token: string | null }[]>`
      select disposition, dispatch_token
        from public.unified_report_operations
       where id = ${admitted.operationId}
    `;
    expect(operation).toEqual({ disposition: 'local_refusal', dispatch_token: null });
  });

  it('refuses a delayed ready retrieve after the observation deadline', async () => {
    const admitted = await admitFresh(store, database, orgId, profileId);
    const createJobId = await operationJobId(database, admitted.operationId);
    const createPayload = {
      type: 'report.unified.advance' as const, orgId, profileId, ...admitted,
    };
    const create = await store.begin({ jobId: createJobId, payload: createPayload, now: NOW });
    if (create.kind !== 'dispatch') throw new Error('expected create dispatch');
    await store.settle({
      runId: admitted.runId,
      operationId: admitted.operationId,
      dispatchToken: create.value.dispatchToken,
      now: NOW,
      disposition: 'provider_success',
      runState: 'observing',
      providerReportId: 'synthetic-delayed-provider-report',
      providerStatus: 'PENDING',
      nextRunAt: new Date(NOW.getTime() + 5 * 60_000),
    });
    const [retrieve] = await database.sql<{ id: string; dispatch_job_id: string }[]>`
      select id, dispatch_job_id
        from public.unified_report_operations
       where run_id = ${admitted.runId} and kind = 'retrieve'
    `;
    await expect(store.begin({
      jobId: retrieve?.dispatch_job_id ?? '',
      payload: {
        type: 'report.unified.advance', orgId, profileId,
        runId: admitted.runId, operationId: retrieve?.id ?? '',
      },
      now: new Date(NOW.getTime() + 4 * 60 * 60_000),
    })).resolves.toEqual({
      kind: 'recovered', runState: 'observation_horizon_reached', successorEnqueued: false,
    });
    const [operation] = await database.sql<{ disposition: string; dispatch_token: string | null }[]>`
      select disposition, dispatch_token
        from public.unified_report_operations
       where id = ${retrieve?.id ?? null}::uuid
    `;
    expect(operation).toEqual({ disposition: 'local_refusal', dispatch_token: null });
  });

  it('settles create and retrieve outcomes with reconciled successor accounting', async () => {
    const admitted = await admitFresh(store, database, orgId, profileId);
    const createJobId = await operationJobId(database, admitted.operationId);
    const createPayload = {
      type: 'report.unified.advance' as const, orgId, profileId, ...admitted,
    };
    const begun = await store.begin({ jobId: createJobId, payload: createPayload, now: NOW });
    if (begun.kind !== 'dispatch') throw new Error('expected create dispatch');
    await expect(store.settle({
      runId: admitted.runId,
      operationId: admitted.operationId,
      dispatchToken: begun.value.dispatchToken,
      now: NOW,
      disposition: 'provider_success',
      runState: 'observing',
      providerReportId: 'synthetic-provider-report',
      providerStatus: 'PENDING',
      nextRunAt: new Date(NOW.getTime() + 5 * 60_000),
    })).resolves.toEqual({ runState: 'observing', successorEnqueued: true });

    const [retrieve] = await database.sql<{
      id: string;
      dispatch_job_id: string;
      sequence: number;
    }[]>`
      select id, dispatch_job_id, sequence
        from public.unified_report_operations
       where run_id = ${admitted.runId} and kind = 'retrieve'
    `;
    expect(retrieve?.sequence).toBe(1);
    const retrievePayload = {
      type: 'report.unified.advance' as const,
      orgId,
      profileId,
      runId: admitted.runId,
      operationId: retrieve?.id ?? '',
    };
    const retrieveBegun = await store.begin({
      jobId: retrieve?.dispatch_job_id ?? '',
      payload: retrievePayload,
      now: new Date(NOW.getTime() + 5 * 60_000),
    });
    expect(retrieveBegun.kind).toBe('dispatch');
    const recovered = await store.begin({
      jobId: retrieve?.dispatch_job_id ?? '',
      payload: retrievePayload,
      now: new Date(NOW.getTime() + 6 * 60_000),
    });
    expect(recovered).toEqual({
      kind: 'recovered', runState: 'observing', successorEnqueued: true,
    });

    const [counts] = await database.sql<{
      operation_count: number;
      settled_operation_count: number;
      input_count: number;
      provider_success_count: number;
      interrupted_dispatch_count: number;
      operations: string;
      jobs: string;
    }[]>`
      select r.operation_count, r.settled_operation_count, r.input_count,
             r.provider_success_count, r.interrupted_dispatch_count,
             (select count(*) from public.unified_report_operations o where o.run_id = r.id) as operations,
             (select count(*) from public.sync_jobs j
               where j.dedupe_key like 'report.unified.advance:' || r.id::text || ':%') as jobs
        from public.unified_report_runs r
       where r.id = ${admitted.runId}
    `;
    expect(counts).toEqual({
      operation_count: 3,
      settled_operation_count: 2,
      input_count: 3,
      provider_success_count: 1,
      interrupted_dispatch_count: 1,
      operations: '3',
      jobs: '3',
    });
  });

  it('re-reads a disabled binding and locally refuses queued work before dispatch', async () => {
    const admitted = await admitFresh(store, database, orgId, profileId);
    const jobId = await operationJobId(database, admitted.operationId);
    await database.sql`
      update public.unified_reporting_bindings
         set enabled = false
       where org_id = ${orgId} and profile_id = ${profileId}
    `;
    await expect(store.begin({
      jobId,
      payload: { type: 'report.unified.advance', orgId, profileId, ...admitted },
      now: NOW,
    })).resolves.toEqual({
      kind: 'recovered', runState: 'paused', successorEnqueued: false,
    });
    const [operation] = await database.sql<{ disposition: string; dispatch_token: string | null }[]>`
      select disposition, dispatch_token
        from public.unified_report_operations
       where id = ${admitted.operationId}
    `;
    expect(operation).toEqual({ disposition: 'local_refusal', dispatch_token: null });
  });

  it('converges an orphan advance job after its parent v3 ledger is deleted', async () => {
    const requestId = await insertV3Request(database, orgId, profileId);
    const admitted = await store.admit(admission(requestId, orgId, profileId));
    if (admitted.kind !== 'enqueued') throw new Error('expected Unified admission');
    const jobId = await operationJobId(database, admitted.operationId);
    await database.sql`delete from public.report_requests where id = ${requestId}`;

    let providerCalls = 0;
    const provider: UnifiedReportingClient = {
      createUnifiedReport: async () => {
        providerCalls += 1;
        throw new Error('orphaned create must not reach the provider');
      },
      retrieveUnifiedReport: async () => {
        providerCalls += 1;
        throw new Error('orphaned retrieve must not reach the provider');
      },
    };
    const coordinator = new WorkerUnifiedDualRun({
      policy: { enabled: true, profileIds: [profileId] },
      store,
      provider,
      now: () => NOW,
    });
    const payload = {
      type: 'report.unified.advance' as const,
      orgId,
      profileId,
      runId: admitted.runId,
      operationId: admitted.operationId,
    };

    await expect(coordinator.advance({ jobId, attempts: 1, profile: testProfile(orgId, profileId), payload }))
      .resolves.toEqual({ state: 'local_failed', providerCalls: 0, alreadySettled: true });
    await expect(coordinator.failTerminal(payload, 'synthetic terminal cleanup')).resolves.toBeUndefined();
    expect(providerCalls).toBe(0);
    const [retained] = await database.sql<{ count: string }[]>`
      select count(*)::text as count from public.sync_jobs where id = ${jobId}
    `;
    expect(retained?.count).toBe('1');
  });

  it('fails a contended begin immediately and releases the shared provider permit', async () => {
    const admitted = await admitFresh(store, database, orgId, profileId);
    const jobId = await operationJobId(database, admitted.operationId);
    let releaseLock!: () => void;
    let markLocked!: () => void;
    const lockReady = new Promise<void>((resolve) => { markLocked = resolve; });
    const lockRelease = new Promise<void>((resolve) => { releaseLock = resolve; });
    const locking = database.sql.begin(async (sql) => {
      await sql`
        select r.id
          from public.unified_report_runs r
          join public.unified_report_operations o on o.run_id = r.id
         where r.id = ${admitted.runId} and o.id = ${admitted.operationId}
         for update of r, o
      `;
      markLocked();
      await lockRelease;
    });
    await lockReady;

    const buckets = new RegionTokenBuckets(1);
    let providerCalls = 0;
    const provider: UnifiedReportingClient = {
      createUnifiedReport: async () => {
        providerCalls += 1;
        throw new Error('contended create must not reach the provider');
      },
      retrieveUnifiedReport: async () => {
        providerCalls += 1;
        throw new Error('contended retrieve must not reach the provider');
      },
    };
    const coordinator = new WorkerUnifiedDualRun({
      policy: { enabled: true, profileIds: [profileId] },
      store,
      provider,
      buckets,
      now: () => NOW,
    });
    try {
      await expect(coordinator.advance({
        jobId,
        attempts: 1,
        profile: testProfile(orgId, profileId),
        payload: {
          type: 'report.unified.advance',
          orgId,
          profileId,
          runId: admitted.runId,
          operationId: admitted.operationId,
        },
      })).rejects.toThrow();
      expect(providerCalls).toBe(0);
      expect(buckets.snapshot('NA')).toEqual({ active: 0, waiting: 0, capacity: 1 });
      let establishedPathStarted = false;
      await buckets.run('NA', async () => { establishedPathStarted = true; });
      expect(establishedPathStarted).toBe(true);
    } finally {
      releaseLock();
      await locking;
    }
  });
});

function admission(requestId: string, orgId: string, profileId: string) {
  return {
    v3ReportRequestId: requestId,
    orgId,
    profileId,
    reportType: 'spCampaigns' as const,
    definitionVersion: 'campaign-observation-v1' as const,
    startDate: '2026-08-01',
    endDate: '2026-08-02',
    observationDeadline: new Date(NOW.getTime() + 4 * 60 * 60_000),
    now: NOW,
  };
}

async function insertV3Request(
  database: TestDatabase,
  orgId: string,
  profileId: string,
  withPoll = true,
): Promise<string> {
  const id = randomUUID();
  await database.sql`
    insert into public.report_requests (
      id, org_id, profile_id, report_type, start_date, end_date,
      amazon_report_id, status, source
    ) values (
      ${id}, ${orgId}, ${profileId}, 'spCampaigns', '2026-08-01', '2026-08-02',
      'synthetic-v3-report', 'pending', 'amazon_api'
    )
  `;
  if (!withPoll) return id;
  const pollPayload = {
    type: 'report.poll',
    orgId,
    profileId,
    reportRequestId: id,
    amazonReportId: 'synthetic-v3-report',
    attempt: 0,
  };
  await database.sql`
    insert into public.sync_jobs (org_id, profile_id, job_type, payload, dedupe_key)
    values (
      ${orgId}, ${profileId}, 'report.poll', ${JSON.stringify(pollPayload)}::jsonb,
      ${`report.poll:${id}:0`}
    )
  `;
  return id;
}

async function admitFresh(
  store: PostgresUnifiedDualRunStore,
  database: TestDatabase,
  orgId: string,
  profileId: string,
): Promise<{ runId: string; operationId: string }> {
  const requestId = await insertV3Request(database, orgId, profileId);
  const result = await store.admit(admission(requestId, orgId, profileId));
  if (result.kind !== 'enqueued') throw new Error('expected Unified admission');
  return { runId: result.runId, operationId: result.operationId };
}

async function operationJobId(database: TestDatabase, operationId: string): Promise<string> {
  const [row] = await database.sql<{ dispatch_job_id: string }[]>`
    select dispatch_job_id from public.unified_report_operations where id = ${operationId}
  `;
  if (!row) throw new Error('expected Unified operation job');
  return row.dispatch_job_id;
}

function testProfile(orgId: string, profileId: string): AdsProfileContext {
  return {
    id: profileId,
    orgId,
    amazonProfileId: 'synthetic-profile',
    region: 'NA',
    currencyCode: 'USD',
    timezone: 'UTC',
  };
}
