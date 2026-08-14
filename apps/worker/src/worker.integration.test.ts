import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from '@wizard-ads/db/testing';
import { requeueStaleSyncJobs } from '@wizard-ads/db';
import type { EntityRow, Region } from '@wizard-ads/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  AdsApiClient,
  AdsProfileContext,
  AdsReportStatus,
  CreateReportInput,
} from './ads-api.js';
import type { ParsedFactBatch } from './parsers.js';
import { RegionTokenBuckets } from './region-token-buckets.js';
import { PostgresWorkerStore } from './store.js';
import { SyncWorker, type WorkerLogger } from './worker.js';

const available = await databaseAvailable();
const USER = '77777777-7777-4777-8777-777777777777';
const quietLogger: WorkerLogger = { info: () => {}, error: () => {} };

class FakeAdsApi implements AdsApiClient {
  entities: EntityRow[] = [];
  reportRows: Record<string, unknown>[] = [];
  createCalls = 0;
  activeCreates = 0;
  maxActiveCreates = 0;
  private readonly polls = new Map<string, number>();

  async listEntities(): Promise<readonly EntityRow[]> { return this.entities; }
  async createReport(_input: CreateReportInput): Promise<{ reportId: string }> {
    this.createCalls += 1;
    this.activeCreates += 1;
    this.maxActiveCreates = Math.max(this.maxActiveCreates, this.activeCreates);
    await new Promise((resolve) => setTimeout(resolve, 4));
    this.activeCreates -= 1;
    return { reportId: `report-${this.createCalls}` };
  }
  async getReport(_profile: AdsProfileContext, reportId: string): Promise<AdsReportStatus> {
    const count = this.polls.get(reportId) ?? 0;
    this.polls.set(reportId, count + 1);
    return count === 0
      ? { status: 'PENDING' }
      : { status: 'COMPLETED', downloadUrl: `https://reports.invalid/${reportId}` };
  }
  async downloadReport(): Promise<AsyncIterable<Uint8Array>> {
    const bytes = gzipSync(JSON.stringify(this.reportRows));
    return (async function* chunks(): AsyncGenerator<Uint8Array> {
      yield bytes.subarray(0, Math.ceil(bytes.length / 2));
      yield bytes.subarray(Math.ceil(bytes.length / 2));
    })();
  }
  async listProfiles(_region: Region): Promise<readonly string[]> { return []; }
}

describe.skipIf(!available)('worker + real Postgres', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  let today: string;

  beforeAll(async () => {
    database = await createTestDatabase('worker');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('worker', ${USER}, 'owner')
    `;
    orgId = org?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId} limit 1
    `;
    profileId = profile?.id ?? '';
    const [clock] = await database.sql<{ today: string }[]>`select current_date::text as today`;
    today = clock?.today ?? '';
  }, 60_000);

  beforeEach(async () => {
    await database.sql`delete from public.sync_jobs where org_id = ${orgId}`;
    await database.sql`delete from public.report_requests where org_id = ${orgId}`;
    await database.sql`delete from public.fact_profile_daily where profile_id = ${profileId}`;
  });

  afterAll(async () => { await database?.drop(); });

  it('runs entity sync and request-poll-fetch, then idempotently restates facts', async () => {
    const api = new FakeAdsApi();
    api.entities = [campaign(profileId, 'updated campaign')];
    api.reportRows = [reportRow(today, 12.5)];
    const worker = makeWorker('pipeline', new PostgresWorkerStore(database), api);

    await queueEntity(database, orgId, profileId, 'entity-cycle');
    await queueReport(database, orgId, profileId, today, 'report-cycle-1');
    expect(await worker.drainOnce()).toBe(2);
    await runQueuedPipeline(worker, database);

    const [entity] = await database.sql<{ name: string }[]>`
      select name from public.campaigns where profile_id = ${profileId} and amazon_id = 'c-1'
    `;
    const [fact] = await database.sql<{ n: string; cost: string }[]>`
      select count(*) as n, max(cost)::text as cost from public.fact_profile_daily where profile_id = ${profileId}
    `;
    const [ledger] = await database.sql<{ rows_parsed: string; rows_loaded: string; counts_match: boolean }[]>`
      select rows_parsed, rows_loaded, counts_match from public.report_requests order by requested_at desc limit 1
    `;
    expect(entity?.name).toBe('updated campaign');
    expect({ count: Number(fact?.n), cost: Number(fact?.cost) }).toEqual({ count: 1, cost: 12.5 });
    expect({ parsed: Number(ledger?.rows_parsed), loaded: Number(ledger?.rows_loaded), match: ledger?.counts_match }).toEqual({ parsed: 1, loaded: 1, match: true });

    api.reportRows = [reportRow(today, 21.75)];
    await queueReport(database, orgId, profileId, today, 'report-cycle-2');
    expect(await worker.drainOnce()).toBe(1);
    await runQueuedPipeline(worker, database);
    const [restated] = await database.sql<{ n: string; cost: string }[]>`
      select count(*) as n, max(cost)::text as cost from public.fact_profile_daily where profile_id = ${profileId}
    `;
    expect({ count: Number(restated?.n), cost: Number(restated?.cost) }).toEqual({ count: 1, cost: 21.75 });
  }, 60_000);

  it('fails a fetch whose parsed and loaded counts differ', async () => {
    const api = new FakeAdsApi();
    api.reportRows = [reportRow(today, 5)];
    const store = new class extends PostgresWorkerStore {
      override async loadFacts(_batch: ParsedFactBatch): Promise<number> { return 0; }
    }(database);
    const [report] = await database.sql<{ id: string }[]>`
      insert into public.report_requests
        (org_id, profile_id, report_type, start_date, end_date, amazon_report_id, status)
      values (${orgId}, ${profileId}, 'spCampaigns', ${today}, ${today}, 'mismatch-report', 'processing')
      returning id
    `;
    const reportId = report?.id ?? '';
    await database.sql`
      insert into public.sync_jobs (org_id, profile_id, job_type, payload, dedupe_key)
      values (${orgId}, ${profileId}, 'report.fetch', ${JSON.stringify({ type: 'report.fetch', orgId, profileId, reportRequestId: reportId, amazonReportId: 'mismatch-report', downloadUrl: 'https://reports.invalid/mismatch' })}::jsonb, 'mismatch-fetch')
    `;
    await makeWorker('mismatch', store, api).drainOnce();
    const [job] = await database.sql<{ status: string; last_error: string }[]>`
      select status, last_error from public.sync_jobs where dedupe_key = 'mismatch-fetch'
    `;
    const [ledger] = await database.sql<{ counts_match: boolean; status: string }[]>`
      select counts_match, status from public.report_requests where id = ${reportId}
    `;
    expect(job?.status).toBe('queued');
    expect(job?.last_error).toContain('parsed 1 rows but loaded 0');
    expect(ledger).toEqual({ counts_match: false, status: 'failed' });
  });

  it('reclaims and completes a job after the claiming process is SIGKILLed', async () => {
    await queueEntity(database, orgId, profileId, 'kill-resume');
    const fixture = fileURLToPath(new URL('./test-fixtures/claim-and-hang.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
      env: { ...process.env, DATABASE_URL: database.connectionString }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('error', reject);
      child.stderr.once('data', (data) => reject(new Error(String(data))));
    });
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));

    expect(await requeueStaleSyncJobs(database, '0 seconds')).toBe(1);
    const api = new FakeAdsApi();
    api.entities = [campaign(profileId, 'resumed campaign')];
    expect(await makeWorker('resumer', new PostgresWorkerStore(database), api).drainOnce()).toBe(1);
    const [job] = await database.sql<{ status: string; attempts: number }[]>`
      select status, attempts from public.sync_jobs where dedupe_key = 'kill-resume'
    `;
    expect(job).toEqual({ status: 'succeeded', attempts: 2 });
  }, 30_000);

  it('lets two workers drain 100 jobs without double claims while sharing the regional cap', async () => {
    const api = new FakeAdsApi();
    await database.sql`
      insert into public.sync_jobs (org_id, profile_id, job_type, payload, dedupe_key)
      select ${orgId}, ${profileId}, 'report.request',
             jsonb_build_object('type', 'report.request', 'orgId', ${orgId}::uuid,
               'profileId', ${profileId}::uuid, 'reportType', 'spCampaigns',
               'startDate', ${today}, 'endDate', ${today}),
             'concurrency:' || g
        from generate_series(1, 100) g
    `;
    const buckets = new RegionTokenBuckets(2);
    const first = makeWorker('worker-a', new PostgresWorkerStore(database), api, buckets, 50);
    const second = makeWorker('worker-b', new PostgresWorkerStore(database), api, buckets, 50);
    const claimed = await Promise.all([first.drainOnce(), second.drainOnce()]);
    const [counts] = await database.sql<{ succeeded: string; distinct_claimers: string }[]>`
      select count(*) filter (where status = 'succeeded') as succeeded,
             count(distinct claimed_by) filter (where status = 'succeeded') as distinct_claimers
        from public.sync_jobs where dedupe_key like 'concurrency:%'
    `;
    expect(claimed.reduce((sum, value) => sum + value, 0)).toBe(100);
    expect({ calls: api.createCalls, succeeded: Number(counts?.succeeded), claimers: Number(counts?.distinct_claimers) }).toEqual({ calls: 100, succeeded: 100, claimers: 2 });
    expect(api.maxActiveCreates).toBeLessThanOrEqual(2);
  }, 60_000);
});

function makeWorker(
  id: string,
  store: PostgresWorkerStore,
  api: FakeAdsApi,
  buckets = new RegionTokenBuckets(2),
  concurrency = 10,
): SyncWorker {
  return new SyncWorker({ workerId: id, store, adsApi: api, buckets, claimBatchSize: concurrency, maxConcurrentJobs: concurrency, logger: quietLogger });
}

function campaign(profileId: string, name: string): EntityRow {
  return { entityType: 'campaign', profileId, amazonId: 'c-1', adProduct: 'SP', name, state: 'enabled', portfolioId: null, budgetAmount: 15, budgetType: 'daily', targetingType: 'manual', biddingStrategy: 'manual', placementBidding: null, startDate: null, endDate: null };
}

function reportRow(date: string, cost: number): Record<string, unknown> {
  return { date, campaignId: 'c-1', impressions: 100, clicks: 10, cost, purchases7d: 2, sales7d: 40, unitsSoldClicks7d: 2 };
}

async function queueEntity(database: TestDatabase, orgId: string, profileId: string, key: string): Promise<void> {
  await database.sql`
    insert into public.sync_jobs (org_id, profile_id, job_type, payload, dedupe_key)
    values (${orgId}, ${profileId}, 'entity.sync', ${JSON.stringify({ type: 'entity.sync', orgId, profileId, full: false })}::jsonb, ${key})
  `;
}

async function queueReport(database: TestDatabase, orgId: string, profileId: string, date: string, key: string): Promise<void> {
  await database.sql`
    insert into public.sync_jobs (org_id, profile_id, job_type, payload, dedupe_key)
    values (${orgId}, ${profileId}, 'report.request', ${JSON.stringify({ type: 'report.request', orgId, profileId, reportType: 'spCampaigns', startDate: date, endDate: date })}::jsonb, ${key})
  `;
}

async function runQueuedPipeline(worker: SyncWorker, database: TestDatabase): Promise<void> {
  await database.sql`update public.sync_jobs set run_after = now() where status = 'queued' and job_type = 'report.poll'`;
  expect(await worker.drainOnce()).toBe(1);
  await database.sql`update public.sync_jobs set run_after = now() where status = 'queued' and job_type = 'report.poll'`;
  expect(await worker.drainOnce()).toBe(1);
  expect(await worker.drainOnce()).toBe(1);
}
