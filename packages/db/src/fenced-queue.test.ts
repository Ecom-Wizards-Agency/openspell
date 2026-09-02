import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activateReportWorkerFencedClaims,
  claimSyncJobs,
  claimSyncJobsFenced,
  deferSyncJobFenced,
  finishSyncJobFenced,
  finishSyncJob,
  getReportWorkerClaimAuthority,
  requeueStaleSyncJobs,
} from './queries/jobs.js';
import { expectRejection } from './testing/errors.js';
import {
  applySqlFile,
  createTestDatabase,
  databaseAvailable,
} from './testing/harness.js';
import type { TestDatabase } from './testing/harness.js';

const available = await databaseAvailable();
const USER = '34343434-3434-4434-8434-343434343434';
const PREVIOUS_MIGRATION = '20260901030000_sp_write_outbox_delivery.sql';
const FENCED_MIGRATION = fileURLToPath(
  new URL('../../../supabase/migrations/20260901040000_fenced_sync_claims.sql', import.meta.url),
);
const REPORT_LANE = [
  'creative.sync',
  'report.request',
  'report.poll',
  'report.fetch',
] as const;
const REPORT_LANE_SET = new Set<string>(REPORT_LANE);

describe.skipIf(!available)('fenced sync job custody', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  let prefixSequence = 0;
  let queueCountBefore = 0;
  let reportCountBefore = 0;

  beforeAll(async () => {
    database = await createTestDatabase('fenced_queue', {
      throughMigration: PREVIOUS_MIGRATION,
    });
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('fenced-queue', ${USER}, 'owner')
    `;
    orgId = org?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId} limit 1
    `;
    profileId = profile?.id ?? '';

    await database.sql`
      insert into public.sync_jobs (org_id, profile_id, job_type, payload, dedupe_key)
      values (
        ${orgId}, ${profileId}, 'entity.sync',
        jsonb_build_object(
          'type', 'entity.sync', 'orgId', ${orgId}::uuid,
          'profileId', ${profileId}::uuid, 'full', false
        ),
        'fenced:migration:job'
      )
    `;
    await database.sql`
      insert into public.report_requests (
        org_id, profile_id, report_type, start_date, end_date
      ) values (${orgId}, ${profileId}, 'spCampaigns', date '2026-01-01', date '2026-01-01')
    `;

    const [counts] = await database.sql<{ queue_count: string; report_count: string }[]>`
      select
        (select count(*) from public.sync_jobs) as queue_count,
        (select count(*) from public.report_requests) as report_count
    `;
    queueCountBefore = Number(counts?.queue_count);
    reportCountBefore = Number(counts?.report_count);

    await applySqlFile(database, FENCED_MIGRATION);
    const activation = await activateReportWorkerFencedClaims(database);
    if (activation.decision !== 'activated') {
      throw new Error(`fenced queue fixture activation failed: ${activation.decision}`);
    }
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  async function queueReportJobs(count: number, label: string): Promise<void> {
    prefixSequence += 1;
    const prefix = `fenced:${label}:${prefixSequence}`;
    await database.sql`
      insert into public.sync_jobs (org_id, profile_id, job_type, payload, dedupe_key)
      select
        ${orgId}::uuid,
        ${profileId}::uuid,
        'report.request'::public.sync_job_type,
        jsonb_build_object(
          'type', 'report.request', 'orgId', ${orgId}::uuid,
          'profileId', ${profileId}::uuid, 'reportType', 'spCampaigns',
          'startDate', '2026-01-01', 'endDate', '2026-01-01'
        ),
        ${prefix}::text || ':' || g
      from generate_series(1, ${count}) g
    `;
  }

  it('preserves populated queue and report ledgers while adding null capabilities', async () => {
    const [counts] = await database.sql<{
      queue_count: string;
      report_count: string;
      token_count: string;
    }[]>`
      select
        (select count(*) from public.sync_jobs) as queue_count,
        (select count(*) from public.report_requests) as report_count,
        (select count(*) from public.sync_jobs where claim_token is not null) as token_count
    `;
    expect(Number(counts?.queue_count)).toBe(queueCountBefore);
    expect(Number(counts?.report_count)).toBe(reportCountBefore);
    expect(Number(counts?.token_count)).toBe(0);
  });

  it('hands concurrent fenced claimers disjoint jobs with unique capabilities', async () => {
    await queueReportJobs(40, 'concurrent');
    const [first, second] = await Promise.all([
      claimSyncJobsFenced(database, 'fenced-worker-a', 25, REPORT_LANE),
      claimSyncJobsFenced(database, 'fenced-worker-b', 25, REPORT_LANE),
    ]);

    const jobs = [...first, ...second];
    const ids = jobs.map((job) => job.id);
    const tokens = jobs.map((job) => job.claim?.token);
    expect(jobs).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
    expect(tokens.every((token) => token !== undefined)).toBe(true);
    expect(new Set(tokens).size).toBe(40);
  });

  it('refuses a fenced caller that does not present the exact report lane', async () => {
    await expectRejection(
      claimSyncJobsFenced(database, 'misconfigured-fenced-worker', 1, ['report.request']),
      /fenced claim requires the complete report lane/i,
    );
    await expectRejection(
      claimSyncJobsFenced(database, 'expanded-fenced-worker', 1, [
        ...REPORT_LANE,
        'entity.sync',
      ]),
      /fenced claim requires the complete report lane/i,
    );
  });

  it('returns a closed stale decision for a wrong capability without changing the row', async () => {
    await queueReportJobs(1, 'wrong-token');
    const [job] = await claimSyncJobsFenced(database, 'fenced-worker-c', 1, REPORT_LANE);
    expect(job?.claim).not.toBeNull();
    if (job?.claim === null || job === undefined) return;

    const [wrong] = await database.sql<{
      decision: string;
      status: string | null;
      attempts: number | null;
    }[]>`
      select decision, status, attempts
      from public.finish_sync_job_fenced(
        ${job.id}, '00000000-0000-4000-8000-000000000001'::uuid,
        'succeeded'::public.sync_job_status, null, null, null
      )
    `;
    expect(wrong).toEqual({ decision: 'stale_claim', status: null, attempts: null });

    const [unchanged] = await database.sql<{ status: string; claim_token: string | null }[]>`
      select status, claim_token from public.sync_jobs where id = ${job.id}
    `;
    expect(unchanged?.status).toBe('running');
    expect(unchanged?.claim_token).toBe(job.claim.token);

    await expect(finishSyncJobFenced(database, job.claim, 'succeeded')).resolves.toMatchObject({
      decision: 'settled',
      status: 'succeeded',
    });
  });

  it('invalidates the old capability after attended requeue and same-worker reclaim', async () => {
    await queueReportJobs(1, 'replacement');
    const [first] = await claimSyncJobsFenced(database, 'same-worker', 1, REPORT_LANE);
    expect(first?.claim).not.toBeNull();
    if (first?.claim === null || first === undefined) return;

    await database.sql`
      update public.sync_jobs
         set status = 'queued', claim_token = null, claimed_by = null, claimed_at = null,
             run_after = now()
       where id = ${first.id}
    `;
    const [replacement] = await claimSyncJobsFenced(database, 'same-worker', 1, REPORT_LANE);
    expect(replacement?.id).toBe(first.id);
    expect(replacement?.claim).not.toBeNull();
    if (replacement?.claim === null || replacement === undefined) return;
    expect(replacement.claim.token).not.toBe(first.claim.token);

    await expect(finishSyncJobFenced(database, first.claim, 'succeeded')).resolves.toEqual({
      decision: 'stale_claim',
      status: null,
      attempts: null,
    });
    await expect(finishSyncJobFenced(database, replacement.claim, 'dead', {
      error: 'synthetic permanent refusal',
    })).resolves.toMatchObject({ decision: 'settled', status: 'dead' });
  });

  it('defers only the exact attempt, clears custody, and does not consume an attempt', async () => {
    await queueReportJobs(1, 'defer');
    const [job] = await claimSyncJobsFenced(database, 'fenced-worker-d', 1, REPORT_LANE);
    expect(job?.attempts).toBe(1);
    expect(job?.claim).not.toBeNull();
    if (job?.claim === null || job === undefined) return;

    await expect(deferSyncJobFenced(database, job.claim, '0 seconds')).resolves.toEqual({
      decision: 'deferred',
      status: 'queued',
      attempts: 0,
    });
    const [row] = await database.sql<{
      status: string;
      attempts: number;
      claim_token: string | null;
      claimed_by: string | null;
    }[]>`
      select status, attempts, claim_token, claimed_by from public.sync_jobs where id = ${job.id}
    `;
    expect(row).toEqual({ status: 'queued', attempts: 0, claim_token: null, claimed_by: null });

    const [replacement] = await claimSyncJobsFenced(
      database,
      'fenced-worker-d',
      1,
      REPORT_LANE,
    );
    expect(replacement?.id).toBe(job.id);
    if (replacement?.claim !== null && replacement !== undefined) {
      await expect(finishSyncJobFenced(database, replacement.claim, 'succeeded')).resolves
        .toMatchObject({ decision: 'settled', status: 'succeeded' });
    }
  });

  it('keeps token-bearing work outside legacy finish, claim, and stale recovery', async () => {
    await queueReportJobs(1, 'legacy-guards');
    const [job] = await claimSyncJobsFenced(database, 'fenced-worker-e', 1, REPORT_LANE);
    expect(job?.claim).not.toBeNull();
    if (job?.claim === null || job === undefined) return;

    await database.sql`
      update public.sync_jobs set claimed_at = now() - interval '2 hours' where id = ${job.id}
    `;
    await expectRejection(
      database.sql`
        select public.finish_sync_job(
          ${job.id}, 'succeeded'::public.sync_job_status, null, null, null
        )
      `,
      /legacy finish requires running tokenless custody/i,
    );
    expect(await requeueStaleSyncJobs(database, '30 minutes')).toBe(0);

    await database.sql`
      update public.sync_jobs set status = 'queued', run_after = now() where id = ${job.id}
    `;
    expect(await claimSyncJobs(database, 'legacy-worker', 1, ['report.request'])).toEqual([]);

    const [row] = await database.sql<{ status: string; claim_token: string | null }[]>`
      select status, claim_token from public.sync_jobs where id = ${job.id}
    `;
    expect(row?.status).toBe('queued');
    expect(row?.claim_token).toBe(job.claim.token);
  });

  it('keeps the claim capability outside tenant relation privileges', async () => {
    const [privileges] = await database.sql<{
      auth_table_select: boolean;
      anon_table_select: boolean;
      auth_safe_select: boolean;
      auth_token_select: boolean;
      anon_token_select: boolean;
      service_private_select: boolean;
    }[]>`
      select
        has_table_privilege('authenticated', 'public.sync_jobs', 'select') as auth_table_select,
        has_table_privilege('anon', 'public.sync_jobs', 'select') as anon_table_select,
        has_column_privilege(
          'authenticated', 'public.sync_jobs', 'updated_at', 'select'
        ) as auth_safe_select,
        has_column_privilege(
          'authenticated', 'public.sync_jobs', 'claim_token', 'select'
        ) as auth_token_select,
        has_column_privilege(
          'anon', 'public.sync_jobs', 'claim_token', 'select'
        ) as anon_token_select,
        has_table_privilege(
          'service_role', 'app.report_worker_claim_authority', 'select'
        ) as service_private_select
    `;
    expect(privileges).toEqual({
      auth_table_select: false,
      anon_table_select: false,
      auth_safe_select: true,
      auth_token_select: false,
      anon_token_select: false,
      service_private_select: false,
    });

    const rolePool = postgres(database.connectionString, {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    try {
      await expect(rolePool.begin(async (sql) => {
        await sql.unsafe('set local role authenticated');
        return sql.unsafe(`
          select
            id, org_id, profile_id, schedule_id, job_type, payload, status,
            priority, run_after, attempts, max_attempts, dedupe_key,
            claimed_by, claimed_at, started_at, finished_at, last_error,
            result, created_at, updated_at
          from public.sync_jobs
          limit 0
        `);
      })).resolves.toEqual([]);
      await expectRejection(
        rolePool.begin(async (sql) => {
          await sql.unsafe('set local role authenticated');
          return sql`select claim_token from public.sync_jobs limit 0`;
        }),
        /permission denied/i,
      );
      await expectRejection(
        rolePool.begin(async (sql) => {
          await sql.unsafe('set local role anon');
          return sql`select claim_token from public.sync_jobs limit 0`;
        }),
        /permission denied/i,
      );
    } finally {
      await rolePool.end({ timeout: 5 });
    }
  });

  it('grants every fenced and authority primitive only to service_role', async () => {
    const rows = await database.sql<{
      function_name: string;
      anon_execute: boolean;
      authenticated_execute: boolean;
      service_execute: boolean;
    }[]>`
      select
        p.proname as function_name,
        has_function_privilege('anon', p.oid, 'execute') as anon_execute,
        has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute,
        has_function_privilege('service_role', p.oid, 'execute') as service_execute
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in (
          'claim_sync_jobs_fenced', 'finish_sync_job_fenced', 'defer_sync_job_fenced',
          'get_report_worker_claim_authority', 'activate_report_worker_fenced_claims'
        )
      order by p.proname
    `;
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => !row.anon_execute && !row.authenticated_execute)).toBe(true);
    expect(rows.every((row) => row.service_execute)).toBe(true);
  });
});

describe.skipIf(!available)('report-lane claim authority cutover', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  let sequence = 0;

  beforeAll(async () => {
    database = await createTestDatabase('report_claim_authority', {
      throughMigration: PREVIOUS_MIGRATION,
    });
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('report-claim-authority', ${USER}, 'owner')
    `;
    orgId = org?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId} limit 1
    `;
    profileId = profile?.id ?? '';
    await applySqlFile(database, FENCED_MIGRATION);
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  async function queueJob(jobType: 'entity.sync' | 'report.request'): Promise<string> {
    sequence += 1;
    const [row] = await database.sql<{ id: string }[]>`
      insert into public.sync_jobs (
        org_id, profile_id, job_type, payload, dedupe_key
      ) values (
        ${orgId}::uuid,
        ${profileId}::uuid,
        ${jobType}::public.sync_job_type,
        jsonb_build_object(
          'type', ${jobType}::text,
          'orgId', ${orgId}::uuid,
          'profileId', ${profileId}::uuid
        ),
        ${`authority:${sequence}`}::text
      )
      returning id
    `;
    if (!row) throw new Error('authority fixture failed to queue a job');
    return row.id;
  }

  it('orders an in-flight legacy claim before activation and excludes late legacy report claims', async () => {
    await expect(getReportWorkerClaimAuthority(database)).resolves.toEqual({
      protocol: 'legacy',
      epoch: 0,
    });
    await expectRejection(
      claimSyncJobsFenced(database, 'too-early-fenced', 1, REPORT_LANE),
      /fenced report claims are not authoritative/i,
    );

    const firstReportId = await queueJob('report.request');
    const legacyPool = postgres(database.connectionString, {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    const activationPool = postgres(database.connectionString, {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    let releaseLegacy!: () => void;
    const holdLegacy = new Promise<void>((resolve) => { releaseLegacy = resolve; });
    let legacyClaimedResolve!: (jobId: string) => void;
    const legacyClaimed = new Promise<string>((resolve) => { legacyClaimedResolve = resolve; });
    let activationPidResolve!: (pid: number) => void;
    const activationPid = new Promise<number>((resolve) => { activationPidResolve = resolve; });

    try {
      const legacyTransaction = legacyPool.begin(async (sql) => {
        await sql.unsafe('set local role service_role');
        const [claimed] = await sql<{ id: string }[]>`
          select id from public.claim_sync_jobs(
            'legacy-before-cutover', 1, ${sql.array([...REPORT_LANE])}::public.sync_job_type[]
          )
        `;
        if (!claimed) throw new Error('legacy pre-cutover claim returned no report job');
        legacyClaimedResolve(claimed.id);
        await holdLegacy;
        return claimed.id;
      });
      expect(await legacyClaimed).toBe(firstReportId);

      const activationTransaction = activationPool.begin(async (sql) => {
        await sql.unsafe('set local role service_role');
        const [backend] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
        if (!backend) throw new Error('activation backend PID is unavailable');
        activationPidResolve(backend.pid);
        return sql<{ decision: string; epoch: string; unresolved: number }[]>`
          select decision, epoch, unresolved
            from public.activate_report_worker_fenced_claims()
        `;
      });

      const pid = await activationPid;
      let activationWaited = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [activity] = await database.sql<{
          query: string;
          wait_event_type: string | null;
        }[]>`
          select query, wait_event_type from pg_stat_activity where pid = ${pid}
        `;
        if (
          activity?.query.includes('activate_report_worker_fenced_claims')
          && activity.wait_event_type === 'Lock'
        ) {
          activationWaited = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(activationWaited).toBe(true);

      releaseLegacy();
      await expect(legacyTransaction).resolves.toBe(firstReportId);
      await expect(activationTransaction).resolves.toEqual([{
        decision: 'unresolved',
        epoch: '0',
        unresolved: 1,
      }]);
    } finally {
      releaseLegacy();
      await Promise.all([
        legacyPool.end({ timeout: 5 }),
        activationPool.end({ timeout: 5 }),
      ]);
    }

    await expect(finishSyncJob(database, firstReportId, 'succeeded')).resolves.toMatchObject({
      status: 'succeeded',
    });
    await expect(activateReportWorkerFencedClaims(database)).resolves.toEqual({
      decision: 'activated',
      epoch: 1,
      unresolved: 0,
    });
    await expect(getReportWorkerClaimAuthority(database)).resolves.toEqual({
      protocol: 'fenced',
      epoch: 1,
    });
    await expect(activateReportWorkerFencedClaims(database)).resolves.toEqual({
      decision: 'already_fenced',
      epoch: 1,
      unresolved: 0,
    });

    const filteredReportId = await queueJob('report.request');
    const filteredEntityId = await queueJob('entity.sync');
    const filtered = await claimSyncJobs(database, 'legacy-filtered-after-cutover', 10, [
      ...REPORT_LANE,
      'entity.sync',
    ]);
    expect(filtered.map((job) => job.id)).toEqual([filteredEntityId]);

    const unfilteredReportId = await queueJob('report.request');
    const unfilteredEntityId = await queueJob('entity.sync');
    const unfiltered = await database.sql<{ id: string; job_type: string }[]>`
      select id, job_type from public.claim_sync_jobs('legacy-unfiltered-after-cutover', 10)
    `;
    expect(unfiltered).toContainEqual({ id: unfilteredEntityId, job_type: 'entity.sync' });
    expect(unfiltered.every((job) => !REPORT_LANE_SET.has(job.job_type))).toBe(true);

    const queuedReports = await database.sql<{ id: string }[]>`
      select id from public.sync_jobs
       where id in (${filteredReportId}, ${unfilteredReportId})
         and status = 'queued'
         and claim_token is null
       order by id
    `;
    expect(queuedReports.map((row) => row.id).sort()).toEqual(
      [filteredReportId, unfilteredReportId].sort(),
    );

    await expectRejection(
      database.sql`
        select public.finish_sync_job(
          ${filteredReportId}, 'succeeded'::public.sync_job_status, null, null, null
        )
      `,
      /legacy finish requires running tokenless custody/i,
    );

    const fenced = await claimSyncJobsFenced(database, 'fenced-after-cutover', 10, REPORT_LANE);
    const fencedIds = new Set(fenced.map((job) => job.id));
    expect(fencedIds.has(filteredReportId)).toBe(true);
    expect(fencedIds.has(unfilteredReportId)).toBe(true);
    expect(fenced.every((job) => REPORT_LANE_SET.has(job.jobType))).toBe(true);
  }, 20_000);
});
