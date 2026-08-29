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
import {
  enqueueDueSchedules,
  revokeIntegrationSecret,
  storeIntegrationSecret,
  type ReportDatePromotionResult,
  type StagedReportDate,
} from '@wizard-ads/db';
import { AdsApiHttpError, MAX_REPORT_RANGE_DAYS } from '@wizard-ads/ads-api';
import type { DataDiveQuota, RankRadarData, RankRadarList } from '@wizard-ads/datadive-api';
import { AdsApiRetryableError } from './ads-api.js';
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
import { PostgresBidSeriesStore } from './bid-series.js';
import { createCrosscheckIngest } from './crosscheck.js';
import { createDataDiveRankSyncHandler, type DataDiveRankClient } from './datadive.js';
import { RegionTokenBuckets } from './region-token-buckets.js';
import {
  PostgresRecommendationRunStore,
  RECOMMENDATION_SCHEDULE_PRIORITY,
  RECOMMENDATIONS_ENGINE_VERSION,
  createRecommendationsRunner,
} from './recommendations-run.js';
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

  afterAll(async () => { await database?.drop(); }, 30_000);

  // -------------------------------------------------------------------------
  // recommendations.run
  // -------------------------------------------------------------------------

  it('runs against seeded facts and persists a succeeded run plus numeric proposals', async () => {
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const strategy = {
      schema: 'wizard-ads.tenant-strategy.v1',
      pacing: {},
      opt_groups: {
        Profit: {
          target_acos: 0.3,
          max_increase: 0.25,
          max_decrease: 0.5,
          goal_lens: 'profit-maintain',
          cut_on_acos_alone: true,
        },
      },
      rank_lifecycle: {},
      staged_apply: {},
      bids: {},
      sv_bands: {},
      caps: {},
      pat_split: {},
      naming: {},
    };

    await database.sql`delete from public.recommendation_runs where org_id = ${orgId}`;
    await database.sql`select app.ensure_fact_partitions(${yesterday}::date, 1)`;
    await database.sql`
      update public.campaigns
         set name = 'Profit | exact | synthetic widget'
       where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'c-1'
    `;
    await database.sql`
      update public.profile_strategy
         set doc = ${JSON.stringify(strategy)}::text::jsonb
       where org_id = ${orgId} and profile_id is null
    `;
    await database.sql`
      insert into public.fact_sp_target_daily
        (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id,
         target_kind, match_type, impressions, clicks, cost, purchases_7d, sales_7d,
         units_sold_7d)
      values (${orgId}, ${profileId}, ${yesterday}, 'SP', 'c-1', 'ag-1', 'kw-1',
              'keyword', 'exact', 1000, 10, 10, 2, 20, 2)
      on conflict (profile_id, date, ad_product, campaign_id, ad_group_id, target_id)
      do update set impressions = excluded.impressions, clicks = excluded.clicks,
                    cost = excluded.cost, purchases_7d = excluded.purchases_7d,
                    sales_7d = excluded.sales_7d
    `;
    await database.sql`
      insert into public.fact_profile_daily
        (org_id, profile_id, date, currency_code, impressions, clicks, cost, purchases_7d,
         sales_7d, units_sold_7d, provisional)
      values (${orgId}, ${profileId}, ${yesterday}, 'USD', 1000, 10, 10, 2, 20, 2, false)
      on conflict (profile_id, date)
      do update set impressions = excluded.impressions, clicks = excluded.clicks,
                    cost = excluded.cost, purchases_7d = excluded.purchases_7d,
                    sales_7d = excluded.sales_7d
    `;

    const recommendationStore = new PostgresRecommendationRunStore(database);
    const queued = await recommendationStore.enqueueRecommendationRun({
      orgId,
      profileId,
      source: 'web',
    });
    const worker = new SyncWorker({
      workerId: 'recommendations',
      store: new PostgresWorkerStore(database),
      adsApi: new FakeAdsApi(),
      buckets: new RegionTokenBuckets(2),
      logger: quietLogger,
      recommendationsRun: createRecommendationsRunner(recommendationStore),
    });

    expect(await worker.drainOnce()).toBe(1);
    const [job] = await database.sql<{ status: string; result: Record<string, unknown> }[]>`
      select status::text as status, result from public.sync_jobs where id = ${queued.jobId}
    `;
    expect(job?.status).toBe('succeeded');
    expect(job?.result).toMatchObject({ runId: queued.runId, proposals: 1 });

    const [run] = await database.sql<{
      status: string;
      proposals_count: number;
      window_start: string;
      window_end: string;
      engine_version: string;
      strategy_snapshot: Record<string, unknown>;
    }[]>`
      select status::text as status, proposals_count,
             window_start::text as window_start, window_end::text as window_end,
             engine_version, strategy_snapshot
        from public.recommendation_runs where id = ${queued.runId}
    `;
    expect(run).toMatchObject({
      status: 'succeeded',
      proposals_count: 1,
      window_end: yesterday,
      engine_version: RECOMMENDATIONS_ENGINE_VERSION,
    });
    expect(run?.strategy_snapshot).toMatchObject({ opt_groups: strategy.opt_groups });

    const proposals = await database.sql<{
      reason: string;
      entity_id: string;
      field: string;
      status: string;
      inputs: Record<string, unknown>;
    }[]>`
      select reason::text as reason, entity_id, field, status::text as status, inputs
        from public.recommendations where run_id = ${queued.runId}
    `;
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      reason: 'high_acos',
      entity_id: 'kw-1',
      field: 'bid',
      status: 'proposed',
      inputs: { clicks: 10, cvrSourceLevel: 'keyword' },
    });

    const [preconditionNote] = await database.sql<{ payload: { note?: string; codes?: string[] } }[]>`
      select payload from public.audit_log
       where org_id = ${orgId}
         and action = 'recommendation.preconditions.noted'
         and target_id = (
           select id::text from public.recommendations where run_id = ${queued.runId} limit 1
         )
    `;
    expect(preconditionNote?.payload.note).toContain('stock unknown');
    expect(preconditionNote?.payload.note).toContain('without rank visibility');
    expect(preconditionNote?.payload.codes).toEqual(['stock_unknown', 'rank_unknown']);

    const [audit] = await database.sql<{ payload: Record<string, unknown> }[]>`
      select payload from public.audit_log
       where org_id = ${orgId}
         and action = 'recommendation.run.succeeded'
         and target_id = ${queued.runId}
    `;
    expect(audit?.payload).toMatchObject({
      proposals: 1,
      narrative: { diagnostics: { proposed: 1 } },
    });
  });

  it('mints one delayed weekly run/job per due optimization group', async () => {
    await database.sql`delete from public.recommendation_runs where org_id = ${orgId}`;
    // N-gram proposals share recommendation_runs but are not weekly optimizer
    // executions, so a recent one must not suppress this profile's due run.
    await database.sql`
      insert into public.recommendation_runs
        (org_id, profile_id, status, lookback_days, engine_version, started_at, finished_at)
      values (${orgId}, ${profileId}, 'succeeded', 7, 'ngram-explorer', now(), now())
    `;
    const store = new PostgresRecommendationRunStore(database);
    const now = new Date();

    expect(await store.enqueueDueRecommendationRuns(now)).toBe(1);
    expect(await store.enqueueDueRecommendationRuns(now)).toBe(0);

    const [job] = await database.sql<{
      run_id: string;
      payload_run_id: string;
      group_id: string | null;
      payload_group_id: string | null;
      group_snapshot_id: string | null;
      priority: number;
      delay_seconds: number;
      engine_version: string;
    }[]>`
      select r.id as run_id,
             j.payload ->> 'runId' as payload_run_id,
             r.group_id,
             j.payload ->> 'groupId' as payload_group_id,
             r.group_snapshot ->> 'id' as group_snapshot_id,
             r.engine_version,
             j.priority,
             extract(epoch from (j.run_after - ${now.toISOString()}::timestamptz)) as delay_seconds
        from public.recommendation_runs r
        join public.sync_jobs j on j.payload ->> 'runId' = r.id::text
       where r.org_id = ${orgId}
       order by r.created_at desc
       limit 1
    `;
    expect(job?.payload_run_id).toBe(job?.run_id);
    expect(job?.group_id).not.toBeNull();
    expect(job?.payload_group_id).toBe(job?.group_id);
    expect(job?.group_snapshot_id).toBe(job?.group_id);
    expect(job?.engine_version).toBe(RECOMMENDATIONS_ENGINE_VERSION);
    expect(job?.priority).toBe(RECOMMENDATION_SCHEDULE_PRIORITY);
    expect(Number(job?.delay_seconds)).toBe(5 * 60 * 60);
  });

  it('refuses overlapping group previews and holds after export until complete continue evidence', async () => {
    await database.sql`
      delete from public.apply_batches batch
       where batch.org_id = ${orgId}
         and not exists (
           select 1 from public.amazon_write_approvals approval
            where approval.apply_batch_id = batch.id
         )
    `;
    await database.sql`delete from public.recommendation_runs where org_id = ${orgId}`;
    const [group] = await database.sql<{ id: string }[]>`
      select id from public.optimization_groups
       where org_id = ${orgId} and profile_id = ${profileId}
       order by id limit 1
    `;
    if (!group) throw new Error('seeded optimization group missing');
    const store = new PostgresRecommendationRunStore(database);
    const first = await store.enqueueRecommendationRun({
      orgId,
      profileId,
      groupId: group.id,
      source: 'web',
    });
    await expect(store.enqueueRecommendationRun({
      orgId,
      profileId,
      groupId: group.id,
      source: 'web',
    })).rejects.toThrow(/queued or running preview/);

    await database.sql`delete from public.sync_jobs where id = ${first.jobId}`;
    await database.sql`
      update public.recommendation_runs
         set status = 'succeeded', started_at = now(), finished_at = now()
       where id = ${first.runId}
    `;
    const [recommendation] = await database.sql<{ id: string }[]>`
      insert into public.recommendations
        (run_id, org_id, profile_id, reason, entity_type, entity_id, ad_product,
         campaign_id, ad_group_id, field, current_value, proposed_value, inputs, status)
      values (${first.runId}, ${orgId}, ${profileId}, 'high_acos', 'keyword',
              'kw-evidence', 'SP', 'c-1', 'ag-1', 'bid', '1'::jsonb, '0.9'::jsonb,
              '{}'::jsonb, 'accepted')
      returning id
    `;
    if (!recommendation) throw new Error('synthetic recommendation missing');
    const [batch] = await database.sql<{ id: string }[]>`
      insert into public.apply_batches
        (org_id, profile_id, tag, opt_group, lever, note, status)
      values (${orgId}, ${profileId}, 'synthetic-evidence', 'Profit', 'bids',
              'synthetic evidence gate', 'staged')
      returning id
    `;
    if (!batch) throw new Error('synthetic apply batch missing');
    await database.sql`
      insert into public.apply_rows
        (batch_id, org_id, profile_id, recommendation_id, entity_type, entity_id,
         field, old_value, new_value)
      values (${batch.id}, ${orgId}, ${profileId}, ${recommendation.id}, 'keyword',
              'kw-evidence', 'bid', '1'::jsonb, '0.9'::jsonb)
    `;

    await expect(store.enqueueRecommendationRun({
      orgId,
      profileId,
      groupId: group.id,
      source: 'web',
    })).rejects.toThrow(/awaiting complete synchronized evidence/);

    await database.sql`
      insert into public.recommendation_observations
        (org_id, profile_id, recommendation_id, group_id, expected_value,
         synchronized_value, synchronized_at, observation_window_start,
         observation_window_end, evidence_state, decision, evidence_note)
      values (${orgId}, ${profileId}, ${recommendation.id}, ${group.id}, 0.9,
              0.9, now(), current_date - 8, current_date - 1, 'complete',
              'continue', 'synthetic complete lift evidence')
    `;
    await expect(store.enqueueRecommendationRun({
      orgId,
      profileId,
      groupId: group.id,
      source: 'web',
    })).resolves.toMatchObject({ runId: expect.any(String), jobId: expect.any(String) });
    await database.sql`delete from public.sync_jobs where org_id = ${orgId}`;
    await database.sql`delete from public.apply_batches where id = ${batch.id}`;
    await database.sql`delete from public.recommendation_runs where org_id = ${orgId}`;
  });

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

  it('commits Sponsored Products when Sponsored Brands 400s, and still requeues the job', async () => {
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

    // Committed: the products that listed are in the mirror.
    const [entity] = await database.sql<{ name: string }[]>`
      select name from public.campaigns where profile_id = ${profileId} and amazon_id = 'c-1'
    `;
    expect(entity?.name).toBe('sp survives');

    // And requeued: reporting success here would leave the SB mirror silently
    // stale, with the grid showing yesterday's campaigns and nothing saying so.
    const [job] = await database.sql<{ status: string; last_error: string | null }[]>`
      select status, last_error from public.sync_jobs where dedupe_key = 'entity-sb-400'
    `;
    expect(job?.status).toBe('queued');
    expect(job?.last_error ?? '').toContain('committed SP+SD');
    expect(job?.last_error ?? '').toContain('/sb/v4/campaigns/list failed with 400');
  });

  it('requeues a partial failure on the retryable failure\'s own backoff', async () => {
    const api = new FakeAdsApi();
    api.entities = [campaign(profileId, 'sp survives the throttle')];
    // A 400 next to a 429: the retry must be scheduled off the 429's
    // Retry-After, not off the 400's flat backoff.
    api.listFailures = [
      {
        adProduct: 'SB',
        message: 'SB rejected the request',
        error: new AdsApiHttpError('SB rejected the request', 400, 'bad', 1),
      },
      {
        adProduct: 'SD',
        message: 'SD throttled',
        error: new AdsApiRetryableError('SD throttled', 900),
      },
    ];
    const worker = makeWorker('entities-throttled', new PostgresWorkerStore(database), api);

    await queueEntity(database, orgId, profileId, 'entity-partial-429', false);
    expect(await worker.drainOnce()).toBe(1);

    const [entity] = await database.sql<{ name: string }[]>`
      select name from public.campaigns where profile_id = ${profileId} and amazon_id = 'c-1'
    `;
    expect(entity?.name).toBe('sp survives the throttle');

    const [job] = await database.sql<{ status: string; last_error: string; wait_seconds: number }[]>`
      select status, last_error, extract(epoch from (run_after - now())) as wait_seconds
        from public.sync_jobs where dedupe_key = 'entity-partial-429'
    `;
    expect(job?.status).toBe('queued');
    expect(job?.last_error).toContain('SD throttled');
    // 900s from Amazon, not the 60s the attempt count would have produced.
    expect(Number(job?.wait_seconds)).toBeGreaterThan(600);
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

  /**
   * The negatives mirror is one table fed by three Amazon endpoints — ad-group
   * negative keywords, campaign negative keywords and negative targets — so one
   * `(profile_id, amazon_id)` can arrive twice in a single listing. Postgres
   * refuses to let one `ON CONFLICT DO UPDATE` touch a row a second time, and
   * that error killed the sync for the profile it happened on.
   */
  it('collapses a listing that carries one negative id from two endpoints', async () => {
    const store = new PostgresWorkerStore(database, quietLogger);
    const profile = await store.profile(profileId);

    const counts = await store.syncEntities(
      profile,
      [negative(profileId, 'neg-dup', 'ad_group'), negative(profileId, 'neg-dup', 'campaign')],
      { adProduct: 'SP', full: false },
    );

    // Listed rows are still listed rows: the collision is counted, not hidden.
    expect(counts).toMatchObject({ listed: 2, upserted: 1, duplicates: 1 });
    expect(counts.listed).toBe(counts.upserted + counts.duplicates);

    const stored = await database.sql<{ scope: string }[]>`
      select scope from public.negatives
       where profile_id = ${profileId} and amazon_id = 'neg-dup'
    `;
    // One mirror row, carrying the last occurrence in listing order.
    expect(stored.map((row) => row.scope)).toEqual(['campaign']);

    const [changes] = await database.sql<{ n: string }[]>`
      select count(*) as n from public.entity_changes
       where profile_id = ${profileId} and amazon_id = 'neg-dup'
    `;
    expect(Number(changes?.n)).toBe(1);

    await database.sql`delete from public.entity_changes where profile_id = ${profileId} and amazon_id = 'neg-dup'`;
    await database.sql`delete from public.negatives where profile_id = ${profileId} and amazon_id = 'neg-dup'`;
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

  it('fails closed when promotion write counts differ from the staged date', async () => {
    const api = new FakeAdsApi();
    api.reportRows = [reportRow(today, 'c-1', 5)];
    const store = new class extends PostgresWorkerStore {
      override async promoteReportDate(input: StagedReportDate): Promise<ReportDatePromotionResult> {
        return {
          status: 'promoted',
          deletedRows: 0,
          insertedRows: 0,
          observationRows: 0,
          watermark: {
            profileId: input.profileId,
            reportType: input.reportType,
            date: input.reportDate,
            source: input.source,
            reportRequestId: input.reportRequestId,
            requestedAt: input.requestedAt.toISOString(),
            promotedAt: input.observedAt.toISOString(),
            sourceRows: input.sourceRows,
            parsedRows: input.parsedRows,
            refusedRows: input.refusedRows,
            promotedRows: input.promotedRows,
            canonicalRows: 0,
          },
        };
      }
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
    expect(job?.status).toBe('dead');
    expect(job?.last_error).toContain('accepted promotion counts do not match the staged date');
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

  it('covers current and comparison windows with legal report schedules', async () => {
    await database.sql`delete from public.sync_schedules where profile_id = ${profileId}`;
    const store = new PostgresWorkerStore(database);
    const specs = defaultSchedules(['spCampaigns']);
    expect(await store.provisionSchedules(orgId, profileId, specs)).toBe(4);
    // Idempotent: the scope key now includes `variant`, so re-provisioning is
    // a no-op rather than a unique violation.
    expect(await store.provisionSchedules(orgId, profileId, specs)).toBe(0);

    const rows = await database.sql<{
      variant: string;
      lookback_days: number;
      window_offset_days: number;
      cadence: string;
    }[]>`
      select variant, lookback_days, window_offset_days, cadence::text
        from public.sync_schedules
       where profile_id = ${profileId} and job_type = 'report.request'
       order by variant
    `;
    expect(rows.map((r) => ({
      variant: r.variant,
      lookback: Number(r.lookback_days),
      offset: Number(r.window_offset_days),
    }))).toEqual([
      { variant: 'comparison', lookback: 32, offset: 32 },
      { variant: 'default', lookback: 3, offset: 0 },
      { variant: 'restatement', lookback: 32, offset: 0 },
    ]);

    // All schedules are due. The two 32-day blocks must be contiguous, and the
    // current block must end yesterday rather than loading a partial today.
    const enqueued = await enqueueDueSchedules(database);
    expect(enqueued.filter((row) => row.enqueued)).toHaveLength(4);
    const windows = await database.sql<{
      variant: string;
      start_date: string;
      end_date: string;
    }[]>`
      select s.variant, j.payload ->> 'startDate' as start_date,
             j.payload ->> 'endDate' as end_date
        from public.sync_jobs j
        join public.sync_schedules s on s.id = j.schedule_id
       where j.org_id = ${orgId} and j.job_type = 'report.request'
       order by s.variant
    `;
    const spans = windows.map((w) => days(w.start_date, w.end_date));
    expect(spans).toEqual([32, 3, 32]);
    const comparison = windows.find((window) => window.variant === 'comparison');
    const restatement = windows.find((window) => window.variant === 'restatement');
    expect(addIsoDays(comparison?.end_date ?? '', 1)).toBe(restatement?.start_date);
    const [clock] = await database.sql<{ yesterday: string }[]>`
      select (((now() at time zone timezone)::date - 1)::text) as yesterday
        from public.ad_profiles where id = ${profileId}
    `;
    expect(restatement?.end_date).toBe(clock?.yesterday);
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

  it('repairs an already-provisioned profile on a plain provisioning pass', async () => {
    await database.sql`delete from public.sync_schedules where profile_id = ${profileId}`;
    const store = new PostgresWorkerStore(database);
    await store.provisionSchedules(orgId, profileId, defaultSchedules(['spCampaigns']));
    await database.sql`
      update public.sync_schedules set lookback_days = 35
       where profile_id = ${profileId} and variant = 'restatement'
    `;

    // The profile has schedules, so `unscheduledProfiles()` does not return it
    // and `provisionSchedules` is never called for it. The repair used to live
    // inside that call, which is why it never reached a deployed profile.
    expect(await store.unscheduledProfiles()).not.toContainEqual({ orgId, profileId });

    const provisioner = new ScheduleProvisioner(store, 60_000, quietLogger);
    provisioner.start();
    await waitFor(async () => {
      const [row] = await database.sql<{ lookback_days: number }[]>`
        select lookback_days from public.sync_schedules
         where profile_id = ${profileId} and variant = 'restatement'
      `;
      return Number(row?.lookback_days) === 32;
    });
    provisioner.stop();

    // Idempotent: a second sweep finds nothing left to clamp.
    expect(await store.repairOverlongLookbacks()).toBe(0);
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
    const expectedSchedules = 1 + 3 * DEFAULT_REPORT_TYPES.length;
    await waitFor(async () => {
      const [row] = await database.sql<{ n: string }[]>`
        select count(*) as n from public.sync_schedules where profile_id = ${profileId}
      `;
      return Number(row?.n) === expectedSchedules;
    });
    provisioner.stop();

    const [counts] = await database.sql<{ n: string; variants: string }[]>`
      select count(*) as n, count(distinct variant) as variants
        from public.sync_schedules where profile_id = ${profileId}
    `;
    // One entity pass plus recent, restatement and comparison per report type.
    expect(Number(counts?.n)).toBe(expectedSchedules);
    expect(Number(counts?.variants)).toBe(3);

    // Re-provisioning the same profile finds nothing to do rather than
    // duplicating: `variant` is in the scope key, so every row conflicts.
    expect(await store.provisionSchedules(orgId, profileId)).toBe(0);
    const [after] = await database.sql<{ n: string }[]>`
      select count(*) as n from public.sync_schedules where profile_id = ${profileId}
    `;
    expect(Number(after?.n)).toBe(expectedSchedules);
  });

  it('reconciles active integration schedules and disables them after revocation', async () => {
    await database.sql`delete from public.sync_schedules where profile_id = ${profileId}`;
    try {
      await database.sql`
        insert into public.integration_connections (org_id, provider, label, status)
        values (${orgId}, 'keepa', 'schedule-test-keepa', 'active'),
               (${orgId}, 'datadive', 'schedule-test-datadive', 'active'),
               (${orgId}, 'mrp', 'schedule-test-mrp', 'active')
      `;
      const store = new PostgresWorkerStore(database);
      expect(await store.ensureIntegrationSchedules()).toBe(4);
      expect(await store.ensureIntegrationSchedules()).toBe(0);

      const schedules = await database.sql<{
        job_type: string;
        report_type: string | null;
        cadence: string;
        payload: Record<string, unknown>;
        enabled: boolean;
      }[]>`
        select job_type::text as job_type, report_type::text as report_type,
               cadence::text as cadence, payload, enabled
          from public.sync_schedules
         where profile_id = ${profileId} and variant = 'integration'
         order by job_type
      `;
      expect(schedules.map((row) => ({
        type: row.job_type,
        cadence: row.cadence,
        reportType: row.report_type,
        enabled: row.enabled,
      }))).toEqual([
        { type: 'economics.sync', cadence: '1 day', reportType: null, enabled: true },
        { type: 'keepa.sync', cadence: '1 day', reportType: null, enabled: true },
        { type: 'rank.sync', cadence: '1 day', reportType: null, enabled: true },
        { type: 'sqp.categorize', cadence: '7 days', reportType: null, enabled: true },
      ]);
      expect(schedules.find((row) => row.job_type === 'keepa.sync')?.payload).toEqual({
        includeCompetitors: true,
      });

      await database.sql`
        update public.integration_connections
           set status = 'revoked'
         where org_id = ${orgId} and label = 'schedule-test-keepa'
      `;
      expect(await store.ensureIntegrationSchedules()).toBe(1);
      const [keepa] = await database.sql<{ enabled: boolean }[]>`
        select enabled from public.sync_schedules
         where profile_id = ${profileId} and job_type = 'keepa.sync'
      `;
      expect(keepa?.enabled).toBe(false);
    } finally {
      await database.sql`
        delete from public.integration_connections
         where org_id = ${orgId} and label like 'schedule-test-%'
      `;
    }
  });

  it('claims rank.sync, resolves Vault custody, and upserts the rank-observation grain', async () => {
    const [connection] = await database.sql<{ id: string }[]>`
      insert into public.integration_connections (org_id, provider, label, config)
      values (
        ${orgId}, 'datadive', 'worker rank integration',
        ${JSON.stringify({ profile_id: profileId, radar_ids: ['radar-integration-1'] })}::jsonb
      )
      returning id
    `;
    const connectionId = connection?.id;
    if (!connectionId) throw new Error('DataDive integration fixture returned no connection id');
    const credential = ['fake', 'datadive', 'worker', 'credential'].join('-');
    await storeIntegrationSecret(database, connectionId, credential);

    const quota: DataDiveQuota = {
      nextRefreshDate: null,
      features: {
        RANK_RADAR_KEYWORDS: { used: 1, capacity: 100, details: {} },
      },
      details: {},
    };
    const radars: RankRadarList = {
      pages: 1,
      total: 1,
      items: [{
        id: 'radar-integration-1',
        asin: 'B000QUEUE01',
        marketplace: 'US',
        keywordCount: 1,
        title: 'Queue integration fixture',
        imageUrl: 'https://images.invalid/queue.jpg',
        details: {},
      }],
    };
    const ranks: RankRadarData = {
      keywords: [{
        id: 'keyword-integration-1',
        keyword: 'queue integration keyword',
        searchVolume: 10,
        ranks: [{ date: today, organicRank: 7, details: {} }],
        details: {},
      }],
      details: {},
    };
    const client: DataDiveRankClient = {
      getQuota: async () => quota,
      listRankRadars: async () => radars,
      getRankRadarData: async () => ranks,
    };

    try {
      await database.sql`
        insert into public.sync_jobs (org_id, profile_id, job_type, payload, dedupe_key)
        values (
          ${orgId}, ${profileId}, 'rank.sync',
          ${JSON.stringify({
            type: 'rank.sync', orgId, profileId, radarIds: ['radar-integration-1'],
          })}::jsonb,
          'datadive-rank-sync'
        )
      `;
      const handler = createDataDiveRankSyncHandler({
        handle: database,
        clientFactory: (value) => {
          expect(value).toBe(credential);
          return client;
        },
        now: () => new Date(`${today}T12:00:00Z`),
      });
      const worker = new SyncWorker({
        workerId: 'datadive-integration-worker',
        store: new PostgresWorkerStore(database),
        integrations: { rankSync: handler },
        logger: quietLogger,
      });

      expect(await worker.drainOnce()).toBe(1);
      const [job] = await database.sql<{
        status: string;
        result: Record<string, unknown> | null;
      }[]>`
        select status::text as status, result
          from public.sync_jobs
         where org_id = ${orgId} and dedupe_key = 'datadive-rank-sync'
      `;
      expect(job?.status).toBe('succeeded');
      expect(job?.result).toMatchObject({ observations: 1, uniqueObservations: 1, loaded: 1 });

      const rows = await database.sql<{
        profile_id: string;
        organic_rank: number | null;
        marketplace: string | null;
        source: string;
      }[]>`
        select profile_id, organic_rank, marketplace, source
          from public.rank_observations
         where org_id = ${orgId}
           and asin = 'B000QUEUE01'
           and keyword = 'queue integration keyword'
           and observed_on = ${today}::date
      `;
      expect(rows).toEqual([{
        profile_id: profileId,
        organic_rank: 7,
        marketplace: 'US',
        source: 'rank_radar',
      }]);

      const [health] = await database.sql<{ status: string; synced: boolean; last_error: string | null }[]>`
        select status::text as status, (last_synced_at is not null) as synced, last_error
          from public.integration_connections
         where id = ${connectionId}
      `;
      expect(health).toEqual({ status: 'active', synced: true, last_error: null });
    } finally {
      await revokeIntegrationSecret(database, connectionId);
      await database.sql`delete from public.integration_connections where id = ${connectionId}`;
      await database.sql`
        delete from public.rank_observations
         where org_id = ${orgId} and asin = 'B000QUEUE01'
      `;
    }
  });

  // -------------------------------------------------------------------------
  // The bid corridor's own store (WP-28)
  // -------------------------------------------------------------------------

  describe('PostgresBidSeriesStore', () => {
    it('reads only live targets, and answers whether the day is already written', async () => {
      const store = new PostgresBidSeriesStore(database);
      const profile = await new PostgresWorkerStore(database).profile(profileId);
      // An earlier `full` pass in this file tombstones the mirror; this case is
      // about state, not tombstones, so start from the fixture's live rows.
      await database.sql`
        update public.keywords set deleted_at = null, state = 'enabled' where profile_id = ${profileId}
      `;
      await database.sql`
        update public.targets set deleted_at = null, state = 'enabled' where profile_id = ${profileId}
      `;
      const [yesterdayRow] = await database.sql<{ d: string }[]>`
        select (current_date - 1)::text as d
      `;
      const reference = yesterdayRow?.d ?? '';

      const live = await store.listBidSeriesTargets(profile, reference);
      expect(live.map((target) => target.targetId).sort()).toEqual(['kw-1', 'tg-1']);

      // Amazon still answers a suggested bid for a paused keyword. Paying for
      // that answer, and storing a band under a line that cannot move, is the
      // waste this excludes.
      await database.sql`
        update public.keywords set state = 'paused'
         where profile_id = ${profileId} and amazon_id = 'kw-1'
      `;
      await database.sql`
        update public.targets set state = 'archived'
         where profile_id = ${profileId} and amazon_id = 'tg-1'
      `;
      expect(await store.listBidSeriesTargets(profile, reference)).toEqual([]);
      await database.sql`
        update public.keywords set state = 'enabled' where profile_id = ${profileId}
      `;
      await database.sql`
        update public.targets set state = 'enabled' where profile_id = ${profileId}
      `;

      // The daily gate: false until the day is written, true after.
      const [todayRow] = await database.sql<{ d: string }[]>`select current_date::text as d`;
      const day = todayRow?.d ?? '';
      await database.sql`
        delete from public.bid_series_daily where profile_id = ${profileId} and date = ${day}
      `;
      expect(await store.hasSeriesForDate(profile, day)).toBe(false);
      expect(await store.upsertBidSeries([{
        orgId, profileId, date: day, campaignId: 'c-1', adGroupId: 'ag-1', targetId: 'kw-1',
        isKeyword: true, suggestedBidLow: 0.4, suggestedBidMedian: 0.7, suggestedBidHigh: 1.1,
        bid: 0.9, cpc: 0.9, maxPotentialCpc: 1.35, modifierComponents: [],
      }])).toBe(1);
      expect(await store.hasSeriesForDate(profile, day)).toBe(true);
    });
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

/** One negative, as either of the two endpoints that feed the same mirror row. */
function negative(profileId: string, amazonId: string, scope: 'campaign' | 'ad_group'): EntityRow {
  return {
    entityType: 'negative', profileId, amazonId, adProduct: 'SP', name: 'blocked term',
    state: 'enabled', campaignId: 'c-1', adGroupId: scope === 'ad_group' ? 'ag-1' : null,
    scope, keywordText: 'blocked term', expression: null, matchType: 'negative_exact',
  };
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

function addIsoDays(date: string, amount: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + amount * 86_400_000).toISOString().slice(0, 10);
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
