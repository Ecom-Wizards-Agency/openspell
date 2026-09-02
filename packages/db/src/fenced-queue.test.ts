import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimSyncJobs,
  claimSyncJobsFenced,
  deferSyncJobFenced,
  finishSyncJobFenced,
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
      claimSyncJobsFenced(database, 'fenced-worker-a', 25, ['report.request']),
      claimSyncJobsFenced(database, 'fenced-worker-b', 25, ['report.request']),
    ]);

    const jobs = [...first, ...second];
    const ids = jobs.map((job) => job.id);
    const tokens = jobs.map((job) => job.claim?.token);
    expect(jobs).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
    expect(tokens.every((token) => token !== undefined)).toBe(true);
    expect(new Set(tokens).size).toBe(40);
  });

  it('returns a closed stale decision for a wrong capability without changing the row', async () => {
    await queueReportJobs(1, 'wrong-token');
    const [job] = await claimSyncJobsFenced(database, 'fenced-worker-c', 1, ['report.request']);
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
    const [first] = await claimSyncJobsFenced(database, 'same-worker', 1, ['report.request']);
    expect(first?.claim).not.toBeNull();
    if (first?.claim === null || first === undefined) return;

    await database.sql`
      update public.sync_jobs
         set status = 'queued', claim_token = null, claimed_by = null, claimed_at = null,
             run_after = now()
       where id = ${first.id}
    `;
    const [replacement] = await claimSyncJobsFenced(database, 'same-worker', 1, ['report.request']);
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
    const [job] = await claimSyncJobsFenced(database, 'fenced-worker-d', 1, ['report.request']);
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
      ['report.request'],
    );
    expect(replacement?.id).toBe(job.id);
    if (replacement?.claim !== null && replacement !== undefined) {
      await expect(finishSyncJobFenced(database, replacement.claim, 'succeeded')).resolves
        .toMatchObject({ decision: 'settled', status: 'succeeded' });
    }
  });

  it('keeps token-bearing work outside legacy finish, claim, and stale recovery', async () => {
    await queueReportJobs(1, 'legacy-guards');
    const [job] = await claimSyncJobsFenced(database, 'fenced-worker-e', 1, ['report.request']);
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
      /fenced job requires a fenced transition/i,
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

  it('grants every fenced primitive only to service_role', async () => {
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
          'claim_sync_jobs_fenced', 'finish_sync_job_fenced', 'defer_sync_job_fenced'
        )
      order by p.proname
    `;
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => !row.anon_execute && !row.authenticated_execute)).toBe(true);
    expect(rows.every((row) => row.service_execute)).toBe(true);
  });
});
