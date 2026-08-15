/**
 * The worker against a real, migrated Postgres.
 *
 * Skipped when no database is reachable, so `pnpm check` stays honest on a
 * machine without one; point it at a database with
 * `WIZARD_ADS_TEST_DATABASE_URL`.
 *
 * Every case here asserts the *ledger*, not the claim count: `drainOnce()`
 * returns how many jobs were claimed, and a claimed job that threw is still a
 * claimed job. `expectAllSucceeded` is what makes a green run mean something.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from '@wizard-ads/db/testing';
import { enqueueDueSchedules } from '@wizard-ads/db';
import { AdsApiHttpError, MAX_REPORT_RANGE_DAYS } from '@wizard-ads/ads-api';
import type { EntityRow, Region } from '@wizard-ads/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  AdProductCode,
  AdsApiClient,
  AdsProfileContext,
  AdsReportStatus,
  CreateReportInput,
  EntityListFailure,
  EntityListing,
} from './ads-api.js';
import { createCrosscheckIngest } from './crosscheck.js';
import type { ParsedFactBatch } from './parsers.js';
import { RegionTokenBuckets } from './region-token-buckets.js';
import { DEFAULT_REPORT_TYPES, defaultSchedules } from './schedules.js';
import { PostgresWorkerStore } from './store.js';
import { ScheduleProvisioner, StaleClaimReaper, SyncWorker, type WorkerLogger } from './worker.js';

const available = await databaseAvailable();
const USER = '77777777-7777-4777-8777-777777777777';
const quietLogger: WorkerLogger = process.env['WORKER_TEST_VERBOSE']
  ? { info: (m, d) => console.info(m, d), error: (m, d) => console.error(m, d) }
  : { info: () => {}, error: () => {} };

class FakeAdsApi implements AdsApiClient {
  entities: EntityRow[] = [];
  /** Ad products whose listing should fail; their rows are still in `entities`. */
  listFailures: EntityListFailure[] = [];
  reportRows: Record<string, unknown>[] = [];
  createCalls = 0;
  activeCreates = 0;
  maxActiveCreates = 0;
  private readonly polls = new Map<string, number>();

  async listEntities(): Promise<EntityListing> {
    const failed = new Set(this.listFailures.map((failure) => failure.adProduct));
    const all: readonly AdProductCode[] = ['SP', 'SB', 'SD'];
    const succeeded = all.filter((product) => !failed.has(product));
    // A failed product contributes no rows, exactly as the real adapter drops a
    // product it could not fully list.
    const rows = this.entities.filter((entity) => !failed.has(entity.adProduct as AdProductCode));
    return { rows, succeeded, failures: this.listFailures };
  }
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
  let amazonProfileId: string;
  let today: string;

  beforeAll(async () => {
    database = await createTestDatabase('worker');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('worker', ${USER}, 'owner')
    `;
    orgId = org?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{ id: string; amazon_profile_id: string }[]>`
      select id, amazon_profile_id from public.ad_profiles where org_id = ${orgId} limit 1
    `;
    profileId = profile?.id ?? '';
    amazonProfileId = profile?.amazon_profile_id ?? '';
    const [clock] = await database.sql<{ today: string }[]>`select current_date::text as today`;
    today = clock?.today ?? '';
  }, 60_000);

  beforeEach(async () => {
    await database.sql`delete from public.sync_jobs where org_id = ${orgId}`;
    await database.sql`delete from public.report_requests where org_id = ${orgId}`;
    await database.sql`delete from public.fact_profile_daily where profile_id = ${profileId}`;
  });

  afterAll(async () => { await database?.drop(); });

  // -------------------------------------------------------------------------
  // entity.sync
  // -------------------------------------------------------------------------

  it('upserts every listed entity and records only the fields that changed', async () => {
    const api = new FakeAdsApi();
    api.entities = [campaign(profileId, 'updated campaign')];
    const worker = makeWorker('entities', new PostgresWorkerStore(database), api);

    await queueEntity(database, orgId, profileId, 'entity-delta', false);
    expect(await worker.drainOnce()).toBe(1);
    await expectAllSucceeded(database, orgId);

    const [job] = await database.sql<{ result: Record<string, number> }[]>`
      select result from public.sync_jobs where dedupe_key = 'entity-delta'
    `;
    expect(job?.result).toMatchObject({ listed: 1, upserted: 1 });
    const [entity] = await database.sql<{ name: string }[]>`
      select name from public.campaigns where profile_id = ${profileId} and amazon_id = 'c-1'
    `;
    expect(entity?.name).toBe('updated campaign');
  });

  it('commits Sponsored Products even when Sponsored Brands listing 400s', async () => {
    const api = new FakeAdsApi();
    api.entities = [campaign(profileId, 'sp survives')];
    // The exact production failure: SB's list throws, the whole SB product is
    // dropped, and the job must still commit the SP rows that listed fine.
    api.listFailures = [{
      adProduct: 'SB',
      message: 'POST /sb/v4/campaigns/list failed with 400',
      error: new AdsApiHttpError('POST /sb/v4/campaigns/list failed with 400', 400, 'bad', 1),
    }];
    const worker = makeWorker('entities-isolated', new PostgresWorkerStore(database), api);

    await queueEntity(database, orgId, profileId, 'entity-sb-400', false);
    expect(await worker.drainOnce()).toBe(1);
    // The job SUCCEEDS despite the SB failure, because SP committed.
    await expectAllSucceeded(database, orgId);

    const [entity] = await database.sql<{ name: string }[]>`
      select name from public.campaigns where profile_id = ${profileId} and amazon_id = 'c-1'
    `;
    expect(entity?.name).toBe('sp survives');

    const [job] = await database.sql<{ result: { failures: { adProduct: string }[]; succeeded: string[] } }[]>`
      select result from public.sync_jobs where dedupe_key = 'entity-sb-400'
    `;
    expect(job?.result.succeeded).toContain('SP');
    expect(job?.result.failures).toEqual([{ adProduct: 'SB', error: 'POST /sb/v4/campaigns/list failed with 400' }]);
  });

  it('fails the job only when every requested ad product fails', async () => {
    const api = new FakeAdsApi();
    api.entities = [];
    const all = ['SP', 'SB', 'SD'] as const;
    api.listFailures = all.map((adProduct) => ({
      adProduct,
      message: `${adProduct} exploded`,
      error: new AdsApiHttpError(`${adProduct} exploded`, 400, 'bad', 1),
    }));
    const worker = makeWorker('entities-all-fail', new PostgresWorkerStore(database), api);

    await queueEntity(database, orgId, profileId, 'entity-all-fail', false);
    expect(await worker.drainOnce()).toBe(1);

    const [job] = await database.sql<{ status: string; last_error: string | null }[]>`
      select status, last_error from public.sync_jobs where dedupe_key = 'entity-all-fail'
    `;
    // A failed job with attempts left is requeued, carrying the real error.
    expect(job?.status).toBe('queued');
    expect(job?.last_error ?? '').toContain('SP exploded');
  });

  it('tombstones missing entities only on a full pass', async () => {
    const api = new FakeAdsApi();
    api.entities = [campaign(profileId, 'still here')];
    const store = new PostgresWorkerStore(database);
    const profile = await store.profile(profileId);

    // A delta pass lists campaigns and nothing else. Sweeping on it would
    // tombstone every keyword and ad group the pass never claimed to cover.
    const delta = await store.syncEntities(profile, api.entities, { full: false });
    expect(delta.tombstoned).toBe(0);
    const [afterDelta] = await database.sql<{ live: string }[]>`
      select count(*) as live from public.keywords where profile_id = ${profileId} and deleted_at is null
    `;
    expect(Number(afterDelta?.live)).toBeGreaterThan(0);

    // A full pass re-listed everything, so an id it omits really is gone.
    const full = await store.syncEntities(profile, api.entities, { full: true });
    expect(full.tombstoned).toBeGreaterThan(0);
    const [afterFull] = await database.sql<{ live: string }[]>`
      select count(*) as live from public.keywords where profile_id = ${profileId} and deleted_at is null
    `;
    expect(Number(afterFull?.live)).toBe(0);

    await database.sql`
      update public.keywords set deleted_at = null where profile_id = ${profileId}
    `;
  });

  // -------------------------------------------------------------------------
  // report.request → poll → fetch
  // -------------------------------------------------------------------------

  it('runs request-poll-fetch, then idempotently restates the facts on a re-pull', async () => {
    const api = new FakeAdsApi();
    api.reportRows = [reportRow(today, 'c-1', 12.5), reportRow(today, 'c-2', 7.5)];
    const worker = makeWorker('pipeline', new PostgresWorkerStore(database), api);

    await queueReport(database, orgId, profileId, today, 'report-cycle-1');
    expect(await worker.drainOnce()).toBe(1);
    await runQueuedPipeline(worker, database);
    await expectAllSucceeded(database, orgId);

    // Two campaign rows on one day are one profile-grain fact row, summed.
    const [fact] = await database.sql<{ n: string; cost: string }[]>`
      select count(*) as n, max(cost)::text as cost from public.fact_profile_daily where profile_id = ${profileId}
    `;
    const [ledger] = await database.sql<{ rows_parsed: string; rows_loaded: string; counts_match: boolean }[]>`
      select rows_parsed, rows_loaded, counts_match from public.report_requests order by requested_at desc limit 1
    `;
    expect({ count: Number(fact?.n), cost: Number(fact?.cost) }).toEqual({ count: 1, cost: 20 });
    expect({
      parsed: Number(ledger?.rows_parsed), loaded: Number(ledger?.rows_loaded), match: ledger?.counts_match,
    }).toEqual({ parsed: 1, loaded: 1, match: true });

    // The restatement re-pull: same day, Amazon's numbers have moved. The fact
    // row must be replaced, not duplicated.
    api.reportRows = [reportRow(today, 'c-1', 21.75), reportRow(today, 'c-2', 8.25)];
    await queueReport(database, orgId, profileId, today, 'report-cycle-2');
    expect(await worker.drainOnce()).toBe(1);
    await runQueuedPipeline(worker, database);
    await expectAllSucceeded(database, orgId);

    const [restated] = await database.sql<{ n: string; cost: string }[]>`
      select count(*) as n, max(cost)::text as cost from public.fact_profile_daily where profile_id = ${profileId}
    `;
    expect({ count: Number(restated?.n), cost: Number(restated?.cost) }).toEqual({ count: 1, cost: 30 });
  }, 60_000);

  it('fails a fetch whose parsed and loaded counts differ', async () => {
    const api = new FakeAdsApi();
    api.reportRows = [reportRow(today, 'c-1', 5)];
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

  // -------------------------------------------------------------------------
  // Resilience
  // -------------------------------------------------------------------------

  it('reclaims and completes a job after the claiming process is SIGKILLed', async () => {
    await queueEntity(database, orgId, profileId, 'kill-resume', false);
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

    const [stranded] = await database.sql<{ status: string }[]>`
      select status from public.sync_jobs where dedupe_key = 'kill-resume'
    `;
    expect(stranded?.status).toBe('running');

    // The production path: the reaper the worker starts, not a hand-rolled
    // requeue. Nothing else moves a job off a dead worker.
    const store = new PostgresWorkerStore(database);
    const reaper = new StaleClaimReaper(store, '0 seconds', 60_000, quietLogger);
    reaper.start();
    await waitFor(async () => {
      const [row] = await database.sql<{ status: string }[]>`
        select status from public.sync_jobs where dedupe_key = 'kill-resume'
      `;
      return row?.status === 'queued';
    });
    reaper.stop();

    const api = new FakeAdsApi();
    api.entities = [campaign(profileId, 'resumed campaign')];
    expect(await makeWorker('resumer', store, api).drainOnce()).toBe(1);
    const [job] = await database.sql<{ status: string; attempts: number }[]>`
      select status, attempts from public.sync_jobs where dedupe_key = 'kill-resume'
    `;
    expect(job).toEqual({ status: 'succeeded', attempts: 2 });

    // No double fact rows: the entity was upserted, not inserted twice.
    const [entity] = await database.sql<{ n: string; name: string }[]>`
      select count(*) as n, max(name) as name from public.campaigns
       where profile_id = ${profileId} and amazon_id = 'c-1'
    `;
    expect({ count: Number(entity?.n), name: entity?.name }).toEqual({ count: 1, name: 'resumed campaign' });
  }, 30_000);

  it('lets two workers drain 100 jobs without double claims while sharing the regional cap', async () => {
    const api = new FakeAdsApi();
    await database.sql`
      insert into public.sync_jobs (org_id, profile_id, job_type, payload, dedupe_key)
      select ${orgId}::uuid, ${profileId}::uuid, 'report.request',
             jsonb_build_object('type', 'report.request', 'orgId', ${orgId}::uuid,
               'profileId', ${profileId}::uuid, 'reportType', 'spCampaigns',
               'startDate', ${today}::text, 'endDate', ${today}::text),
             'concurrency:' || g
        from generate_series(1, 100) g
    `;
    const buckets = new RegionTokenBuckets(2);
    const first = makeWorker('worker-a', new PostgresWorkerStore(database), api, buckets, 50);
    const second = makeWorker('worker-b', new PostgresWorkerStore(database), api, buckets, 50);
    const claimed = await Promise.all([first.drainOnce(), second.drainOnce()]);
    const [counts] = await database.sql<{ succeeded: string; distinct_claimers: string; claims: string }[]>`
      select count(*) filter (where status = 'succeeded') as succeeded,
             count(distinct claimed_by) filter (where status = 'succeeded') as distinct_claimers,
             count(*) as claims
        from public.sync_jobs where dedupe_key like 'concurrency:%'
    `;
    expect(claimed.reduce((sum, value) => sum + value, 0)).toBe(100);
    expect({
      calls: api.createCalls,
      succeeded: Number(counts?.succeeded),
      claimers: Number(counts?.distinct_claimers),
      rows: Number(counts?.claims),
    }).toEqual({ calls: 100, succeeded: 100, claimers: 2, rows: 100 });
    expect(api.maxActiveCreates).toBeLessThanOrEqual(2);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Schedules
  // -------------------------------------------------------------------------

  it('holds a daily and a weekly restatement schedule for one profile and report type', async () => {
    await database.sql`delete from public.sync_schedules where profile_id = ${profileId}`;
    const store = new PostgresWorkerStore(database);
    const specs = defaultSchedules(['spCampaigns']);
    expect(await store.provisionSchedules(orgId, profileId, specs)).toBe(3);
    // Idempotent: the scope key now includes `variant`, so re-provisioning is
    // a no-op rather than a unique violation.
    expect(await store.provisionSchedules(orgId, profileId, specs)).toBe(0);

    const rows = await database.sql<{ variant: string; lookback_days: number; cadence: string }[]>`
      select variant, lookback_days, cadence::text from public.sync_schedules
       where profile_id = ${profileId} and job_type = 'report.request'
       order by variant
    `;
    expect(rows.map((r) => ({ variant: r.variant, lookback: Number(r.lookback_days) }))).toEqual([
      { variant: 'default', lookback: 3 },
      { variant: 'restatement', lookback: 32 },
    ]);

    // Both are due, so one tick mints both windows: 3 days and 32 days.
    const enqueued = await enqueueDueSchedules(database);
    expect(enqueued.filter((row) => row.enqueued)).toHaveLength(3);
    const windows = await database.sql<{ start_date: string; end_date: string }[]>`
      select payload ->> 'startDate' as start_date, payload ->> 'endDate' as end_date
        from public.sync_jobs
       where org_id = ${orgId} and job_type = 'report.request'
       order by payload ->> 'startDate'
    `;
    const spans = windows.map((w) => days(w.start_date, w.end_date));
    expect(spans).toEqual([32, 3]);
    // The restatement window must be one Amazon will actually generate: it
    // refuses a difference over MAX_REPORT_RANGE_DAYS, and 35 (a 34-day
    // difference) is what 400'd every restatement job in the first live sync.
    for (const span of spans) expect(span - 1).toBeLessThanOrEqual(MAX_REPORT_RANGE_DAYS);
  });

  it('repairs a schedule already provisioned with the illegal 35-day lookback', async () => {
    await database.sql`delete from public.sync_schedules where profile_id = ${profileId}`;
    const store = new PostgresWorkerStore(database);
    await store.provisionSchedules(orgId, profileId, defaultSchedules(['spCampaigns']));
    // Simulate a profile provisioned before the bug was found.
    await database.sql`
      update public.sync_schedules set lookback_days = 35
       where profile_id = ${profileId} and variant = 'restatement'
    `;

    // Re-provisioning is `do nothing` on conflict, so the repair is what has to
    // fix the row.
    await store.provisionSchedules(orgId, profileId, defaultSchedules(['spCampaigns']));

    const [row] = await database.sql<{ lookback_days: number }[]>`
      select lookback_days from public.sync_schedules
       where profile_id = ${profileId} and variant = 'restatement'
    `;
    expect(Number(row?.lookback_days)).toBe(32);
  });

  it('leaves a legal operator-chosen lookback alone', async () => {
    await database.sql`delete from public.sync_schedules where profile_id = ${profileId}`;
    const store = new PostgresWorkerStore(database);
    await store.provisionSchedules(orgId, profileId, defaultSchedules(['spCampaigns']));
    await database.sql`
      update public.sync_schedules set lookback_days = 14
       where profile_id = ${profileId} and variant = 'restatement'
    `;

    await store.provisionSchedules(orgId, profileId, defaultSchedules(['spCampaigns']));

    const [row] = await database.sql<{ lookback_days: number }[]>`
      select lookback_days from public.sync_schedules
       where profile_id = ${profileId} and variant = 'restatement'
    `;
    expect(Number(row?.lookback_days)).toBe(14);
  });

  it('gives an unscheduled profile the defaults, once', async () => {
    await database.sql`delete from public.sync_schedules where profile_id = ${profileId}`;
    const store = new PostgresWorkerStore(database);
    expect(await store.unscheduledProfiles()).toContainEqual({ orgId, profileId });

    const provisioner = new ScheduleProvisioner(store, 60_000, quietLogger);
    provisioner.start();
    await waitFor(async () => (await store.unscheduledProfiles()).length === 0);
    provisioner.stop();

    const [counts] = await database.sql<{ n: string; variants: string }[]>`
      select count(*) as n, count(distinct variant) as variants
        from public.sync_schedules where profile_id = ${profileId}
    `;
    // One entity pass plus a recent and a restatement schedule per report type.
    expect(Number(counts?.n)).toBe(1 + 2 * DEFAULT_REPORT_TYPES.length);
    expect(Number(counts?.variants)).toBe(2);

    // Re-provisioning the same profile finds nothing to do rather than
    // duplicating: `variant` is in the scope key, so every row conflicts.
    expect(await store.provisionSchedules(orgId, profileId)).toBe(0);
    const [after] = await database.sql<{ n: string }[]>`
      select count(*) as n from public.sync_schedules where profile_id = ${profileId}
    `;
    expect(Number(after?.n)).toBe(1 + 2 * DEFAULT_REPORT_TYPES.length);
  });

  // -------------------------------------------------------------------------
  // crosscheck.ingest wiring (WP-10 owns the logic; this proves the seam)
  // -------------------------------------------------------------------------

  describe('crosscheck.ingest', () => {
    let inbox: string;

    beforeEach(async () => {
      inbox = await mkdtemp(join(tmpdir(), 'wizard-ads-worker-crosscheck-'));
    });
    afterEach(async () => { await rm(inbox, { recursive: true, force: true }); });

    async function runIngest(sourcePath: string, dedupeKey: string): Promise<{ status: string; last_error: string | null; attempts: number; result: Record<string, unknown> | null }> {
      await database.sql`
        insert into public.sync_jobs (org_id, profile_id, job_type, payload, dedupe_key)
        values (${orgId}, ${profileId}, 'crosscheck.ingest',
                ${JSON.stringify({ type: 'crosscheck.ingest', orgId, profileId, date: today, sourcePath })}::jsonb,
                ${dedupeKey})
      `;
      const worker = new SyncWorker({
        workerId: 'crosscheck', store: new PostgresWorkerStore(database), adsApi: new FakeAdsApi(),
        buckets: new RegionTokenBuckets(2), logger: quietLogger,
        crosscheckIngest: createCrosscheckIngest(database, { inboxDir: inbox, archive: false }),
      });
      expect(await worker.drainOnce()).toBe(1);
      const [job] = await database.sql<{ status: string; last_error: string | null; attempts: number; result: Record<string, unknown> | null }[]>`
        select status, last_error, attempts, result from public.sync_jobs where dedupe_key = ${dedupeKey}
      `;
      return job as never;
    }

    it('reaches runCrosscheckIngest and records the verdict as a success', async () => {
      const day = '2026-08-01';
      await database.sql`select app.ensure_fact_partitions(${day}::date, 1)`;
      await database.sql`
        insert into public.fact_profile_daily
          (org_id, profile_id, date, currency_code, impressions, clicks, cost, purchases_7d, sales_7d, units_sold_7d, provisional)
        values (${orgId}, ${profileId}, ${day}, 'USD', 1000, 50, 100, 4, 400, 4, false)
        on conflict (profile_id, date) do update set cost = excluded.cost, sales_7d = excluded.sales_7d
      `;
      await writeFile(
        join(inbox, `adlabs_profile_${amazonProfileId}_${day}_${day}.csv`),
        `date,profile_id,spend,sales,total_sales\n${day},${amazonProfileId},100,400,1200\n`,
        'utf8',
      );

      const job = await runIngest('.', 'crosscheck-ok');
      expect(job.status).toBe('succeeded');
      expect(job.result).toMatchObject({ headline: 'verified', filesParsed: 1, rowsParsed: 1, rowsKept: 1 });
      const [written] = await database.sql<{ n: string }[]>`
        select count(*) as n from public.crosscheck_results where profile_id = ${profileId}
      `;
      expect(Number(written?.n)).toBeGreaterThan(0);
    });

    it('requeues when the export has not landed yet', async () => {
      const job = await runIngest('.', 'crosscheck-missing');
      expect(job.status).toBe('queued');
      expect(job.attempts).toBe(1);
      expect(job.last_error).toContain('no AdLabs export');
    });

    it('dead-letters an export that breaks the contract, without spending attempts', async () => {
      const day = '2026-08-01';
      // A missing `sales` column: no number of retries grows one back.
      await writeFile(
        join(inbox, `adlabs_profile_${amazonProfileId}_${day}_${day}.csv`),
        `date,profile_id,spend\n${day},${amazonProfileId},100\n`,
        'utf8',
      );
      const job = await runIngest('.', 'crosscheck-contract');
      expect(job.status).toBe('dead');
      expect(job.attempts).toBe(1);
      expect(job.last_error).toContain('sales');
    });

    it('dead-letters a payload naming a profile we do not have', async () => {
      await database.sql`
        insert into public.sync_jobs (org_id, profile_id, job_type, payload, dedupe_key)
        values (${orgId}, ${profileId}, 'crosscheck.ingest',
                ${JSON.stringify({
                  type: 'crosscheck.ingest', orgId, profileId,
                  date: today, sourcePath: '.',
                })}::jsonb, 'crosscheck-no-profile')
      `;
      const worker = new SyncWorker({
        workerId: 'crosscheck', store: new PostgresWorkerStore(database), adsApi: new FakeAdsApi(),
        buckets: new RegionTokenBuckets(2), logger: quietLogger,
        crosscheckIngest: async () => { throw named('ProfileNotFound', 'no such profile'); },
      });
      expect(await worker.drainOnce()).toBe(1);
      const [job] = await database.sql<{ status: string; attempts: number }[]>`
        select status, attempts from public.sync_jobs where dedupe_key = 'crosscheck-no-profile'
      `;
      expect(job).toEqual({ status: 'dead', attempts: 1 });
    });
  });
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

function reportRow(date: string, campaignId: string, cost: number): Record<string, unknown> {
  return { date, campaignId, impressions: 100, clicks: 10, cost, purchases7d: 2, sales7d: 40, unitsSoldClicks7d: 2 };
}

function named(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function days(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
}

async function queueEntity(database: TestDatabase, orgId: string, profileId: string, key: string, full: boolean): Promise<void> {
  await database.sql`
    insert into public.sync_jobs (org_id, profile_id, job_type, payload, dedupe_key)
    values (${orgId}, ${profileId}, 'entity.sync', ${JSON.stringify({ type: 'entity.sync', orgId, profileId, full })}::jsonb, ${key})
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

/**
 * A claimed job that threw is still a claimed job, so `drainOnce()`'s count
 * proves nothing on its own. This is the assertion that does.
 */
async function expectAllSucceeded(database: TestDatabase, orgId: string): Promise<void> {
  const bad = await database.sql<{ job_type: string; status: string; last_error: string | null }[]>`
    select job_type, status, last_error from public.sync_jobs
     where org_id = ${orgId} and status <> 'succeeded'
  `;
  expect(bad.map((row) => ({ ...row }))).toEqual([]);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition never became true');
}
