/**
 * Queue primitives.
 *
 * The headline check is the one the brief names: 100 queued jobs, two claimers
 * running at the same time, and not one job claimed twice. `FOR UPDATE SKIP
 * LOCKED` is what makes that true, and the only honest way to test it is to run
 * both claimers concurrently against a real Postgres, which is what happens
 * below.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobPayload } from '@wizard-ads/shared';
import { claimSyncJobs, enqueueDueSchedules, finishSyncJob, requeueStaleSyncJobs } from './queries/jobs.js';
import { expectRejection } from './testing/errors.js';
import { createTestDatabase, databaseAvailable } from './testing/harness.js';
import type { TestDatabase } from './testing/harness.js';

const available = await databaseAvailable();
const USER = '33333333-3333-4333-8333-333333333333';

describe.skipIf(!available)('sync job queue', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;

  beforeAll(async () => {
    database = await createTestDatabase('queue');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('queue', ${USER}, 'owner')
    `;
    orgId = org?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId} limit 1
    `;
    profileId = profile?.id ?? '';
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  async function queueJobs(count: number, prefix: string): Promise<void> {
    await database.sql`
      insert into public.sync_jobs (org_id, profile_id, job_type, payload, dedupe_key)
      select ${orgId}::uuid, ${profileId}::uuid, 'entity.sync',
             jsonb_build_object('type', 'entity.sync', 'orgId', ${orgId}::uuid,
                                'profileId', ${profileId}::uuid, 'full', false),
             ${prefix}::text || ':' || g
      from generate_series(1, ${count}) g
    `;
  }

  it('never hands the same job to two concurrent claimers', async () => {
    await queueJobs(100, 'concurrent');
    const [before] = await database.sql<{ n: string }[]>`
      select count(*) as n from public.sync_jobs where status = 'queued'
    `;
    const queued = Number(before?.n);
    expect(queued).toBeGreaterThanOrEqual(100);

    // Both claimers ask for more than half the queue, so a naive
    // select-then-update implementation would overlap on almost every row.
    const [first, second] = await Promise.all([
      claimSyncJobs(database, 'worker-a', 60),
      claimSyncJobs(database, 'worker-b', 60),
    ]);

    const ids = [...first, ...second].map((job) => job.id);
    // The assertion that matters: no id appears twice. Rows claimed against
    // rows queued is the second half, because a claim loop that quietly drops
    // work is as bad as one that duplicates it.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(queued);

    const rows = await database.sql<{ status: string; claimed_by: string; attempts: number }[]>`
      select status, claimed_by, attempts from public.sync_jobs
      where dedupe_key like 'concurrent:%'
    `;
    expect(rows.every((row) => row.status === 'running')).toBe(true);
    expect(rows.every((row) => row.attempts === 1)).toBe(true);
    expect(new Set(rows.map((row) => row.claimed_by))).toEqual(new Set(['worker-a', 'worker-b']));
  });

  it('claims nothing that is not due yet', async () => {
    await database.sql`
      insert into public.sync_jobs (org_id, profile_id, job_type, payload, dedupe_key, run_after)
      values (${orgId}::uuid, ${profileId}::uuid, 'entity.sync',
              jsonb_build_object('type', 'entity.sync', 'orgId', ${orgId}::uuid,
                                 'profileId', ${profileId}::uuid, 'full', false),
              'future:1', now() + interval '1 hour')
    `;
    const claimed = await claimSyncJobs(database, 'worker-c', 10);
    expect(claimed.map((job) => job.dedupeKey)).not.toContain('future:1');
  });

  it('claims only allowed job types when an allowlist is present', async () => {
    await database.sql`
      insert into public.sync_jobs (org_id, profile_id, job_type, payload, dedupe_key)
      values
        (${orgId}, ${profileId}, 'keepa.sync',
         ${JSON.stringify({ type: 'keepa.sync', orgId, profileId, includeCompetitors: false })}::jsonb,
         'filter:keepa'),
        (${orgId}, ${profileId}, 'rank.sync',
         ${JSON.stringify({ type: 'rank.sync', orgId, profileId })}::jsonb,
         'filter:rank')
    `;

    const keepa = await claimSyncJobs(database, 'worker-filtered', 10, ['keepa.sync']);
    expect(keepa.map((job) => job.dedupeKey)).toEqual(['filter:keepa']);
    expect(await claimSyncJobs(database, 'worker-empty-filter', 10, [])).toEqual([]);

    const [rank] = await database.sql<{ status: string }[]>`
      select status from public.sync_jobs where dedupe_key = 'filter:rank'
    `;
    expect(rank?.status).toBe('queued');
  });

  it('refuses a duplicate dedupe key inside one org', async () => {
    await expectRejection(queueJobs(1, 'concurrent'), /duplicate key|unique/i);
  });

  it('requeues a failure with attempts left and buries one without', async () => {
    await queueJobs(1, 'retry');
    await database.sql`update public.sync_jobs set priority = 10000 where dedupe_key = 'retry:1'`;
    const [job] = await claimSyncJobs(database, 'worker-d', 1);
    expect(job).toBeDefined();
    if (!job) return;

    const requeued = await finishSyncJob(database, job.id, 'failed', {
      error: 'throttled',
      retryIn: '5 seconds',
      claimToken: job.claimToken,
    });
    expect(requeued.status).toBe('queued');

    await database.sql`
      update public.sync_jobs set attempts = max_attempts, run_after = now(), priority = 20000
       where id = ${job.id}
    `;
    const [reclaimed] = await claimSyncJobs(database, 'worker-d', 1);
    expect(reclaimed?.id).toBe(job.id);
    const buried = await finishSyncJob(database, job.id, 'failed', {
      error: 'still throttled', claimToken: reclaimed?.claimToken,
    });
    expect(buried.status).toBe('dead');
  });

  it('reclaims a job whose worker went away', async () => {
    await queueJobs(1, 'stale');
    await database.sql`update public.sync_jobs set priority = 30000 where dedupe_key = 'stale:1'`;
    const [job] = await claimSyncJobs(database, 'worker-e', 1);
    expect(job).toBeDefined();
    if (!job) return;

    await database.sql`
      update public.sync_jobs set claimed_at = now() - interval '2 hours' where id = ${job.id}
    `;
    const revived = await requeueStaleSyncJobs(database, '30 minutes');
    expect(revived).toBeGreaterThanOrEqual(1);

    const [row] = await database.sql<{ status: string }[]>`
      select status from public.sync_jobs where id = ${job.id}
    `;
    expect(row?.status).toBe('queued');
  });

  it('fences a stale owner after the reaper issues a replacement claim', async () => {
    await queueJobs(1, 'fenced-stale');
    await database.sql`
      update public.sync_jobs set priority = 40000 where dedupe_key = 'fenced-stale:1'
    `;
    const [original] = await claimSyncJobs(database, 'worker-fence-old', 1);
    expect(original?.claimToken).toMatch(/[0-9a-f-]{36}/);
    if (!original) return;
    await database.sql`
      update public.sync_jobs set claimed_at = now() - interval '2 hours'
       where id = ${original.id}
    `;
    expect(await requeueStaleSyncJobs(database, '30 minutes')).toBeGreaterThanOrEqual(1);
    await database.sql`
      update public.sync_jobs set priority = 50000 where id = ${original.id}
    `;
    const [replacement] = await claimSyncJobs(database, 'worker-fence-new', 1);
    expect(replacement?.id).toBe(original.id);
    expect(replacement?.claimToken).not.toBe(original.claimToken);

    await expect(finishSyncJob(database, original.id, 'succeeded', {
      claimToken: original.claimToken,
    })).rejects.toThrow(/stale|claim token/i);
    const completed = await finishSyncJob(database, replacement!.id, 'succeeded', {
      claimToken: replacement!.claimToken,
    });
    expect(completed.status).toBe('succeeded');
  });

  it('removes the unfenced completion protocol after the required stop-and-drain migration', async () => {
    const [signatures] = await database.sql<{ legacy: boolean; fenced: boolean }[]>`
      select
        to_regprocedure('public.finish_sync_job(uuid,public.sync_job_status,text,jsonb,interval)') is not null as legacy,
        to_regprocedure('public.finish_sync_job(uuid,uuid,public.sync_job_status,text,jsonb,interval)') is not null as fenced
    `;
    expect(signatures).toEqual({ legacy: false, fenced: true });
  });

  it('proves the protocol migration drain gate rejects an active claimer', async () => {
    await queueJobs(1, 'protocol-drain');
    await database.sql`update public.sync_jobs set priority = 70000
      where dedupe_key = 'protocol-drain:1'`;
    const [job] = await claimSyncJobs(database, 'worker-before-protocol-migration', 1);
    if (!job) throw new Error('expected protocol-drain job');
    await expect(database.sql`
      select app.assert_sync_queue_drained_for_protocol_migration()
    `).rejects.toThrow(/fully drained/i);
    await finishSyncJob(database, job.id, 'succeeded', { claimToken: job.claimToken });
  });

  describe('scheduler', () => {
    it('enqueues a due schedule once per slot and advances it', async () => {
      const [schedule] = await database.sql<{ id: string }[]>`
        insert into public.sync_schedules
          (org_id, profile_id, job_type, report_type, cadence, next_run_at, lookback_days)
        values (${orgId}, ${profileId}, 'report.request', 'spSearchTerm', interval '1 day',
                now() - interval '1 minute', 3)
        returning id
      `;
      expect(schedule).toBeDefined();

      const first = await enqueueDueSchedules(database);
      const mine = first.filter((row) => row.scheduleId === schedule?.id);
      expect(mine.length).toBe(1);
      expect(mine[0]?.enqueued).toBe(true);

      // The second tick finds nothing due: next_run_at moved a day ahead.
      const second = await enqueueDueSchedules(database);
      expect(second.filter((row) => row.scheduleId === schedule?.id)).toEqual([]);

      const [job] = await database.sql<{ payload: Record<string, unknown> }[]>`
        select payload from public.sync_jobs
        where schedule_id = ${schedule?.id ?? null} order by created_at desc limit 1
      `;
      expect(job?.payload['reportType']).toBe('spSearchTerm');
      expect(job?.payload['type']).toBe('report.request');
      // lookback 3 means a three-day window, inclusive of both ends.
      const start = String(job?.payload['startDate']);
      const end = String(job?.payload['endDate']);
      expect(Date.parse(end) - Date.parse(start)).toBe(2 * 24 * 3600 * 1000);
    });

    it('deduplicates a slot that is enqueued twice', async () => {
      const [schedule] = await database.sql<{ id: string }[]>`
        insert into public.sync_schedules (org_id, profile_id, job_type, cadence, next_run_at)
        values (${orgId}, ${profileId}, 'recommendations.run', interval '1 day', now() - interval '1 minute')
        returning id
      `;

      const at = new Date();
      const first = await enqueueDueSchedules(database, at);
      expect(first.find((row) => row.scheduleId === schedule?.id)?.enqueued).toBe(true);

      // Wind the schedule back to the same slot: a cron tick that fired twice.
      await database.sql`
        update public.sync_schedules
        set next_run_at = ${at.toISOString()}::timestamptz - interval '1 minute'
        where id = ${schedule?.id ?? null}
      `;
      const second = await enqueueDueSchedules(database, at);
      const repeat = second.find((row) => row.scheduleId === schedule?.id);
      expect(repeat?.enqueued).toBe(false);
      expect(repeat?.jobId).toBeNull();
    });

    it('ignores schedules on profiles that are not sync enabled', async () => {
      await database.sql`update public.ad_profiles set sync_enabled = false where id = ${profileId}`;
      await database.sql`
        update public.sync_schedules set next_run_at = now() - interval '1 minute'
        where profile_id = ${profileId}
      `;
      const enqueued = await enqueueDueSchedules(database);
      expect(enqueued).toEqual([]);
      await database.sql`update public.ad_profiles set sync_enabled = true where id = ${profileId}`;
    });

    it('anchors next_run_at to the preferred sync hour in the profile timezone', async () => {
      // 6am in Los Angeles, and a tick at 13:00 PDT (20:00 UTC) that same day —
      // past 6am, so the anchor lands on the *next* day's 6am, not this one.
      await database.sql`
        update public.ad_profiles
           set timezone = 'America/Los_Angeles', preferred_sync_hour = 6
         where id = ${profileId}
      `;
      const [schedule] = await database.sql<{ id: string }[]>`
        insert into public.sync_schedules
          (org_id, profile_id, job_type, variant, cadence, next_run_at)
        values (${orgId}, ${profileId}, 'entity.sync', 'anchored-test', interval '1 day',
                '2026-06-15T19:59:00Z')
        returning id
      `;
      const scheduleId = schedule?.id ?? '';

      const at = new Date('2026-06-15T20:00:00Z');
      const rows = await enqueueDueSchedules(database, at);
      expect(rows.find((row) => row.scheduleId === scheduleId)?.enqueued).toBe(true);

      const [anchored] = await database.sql<{ local_hour: number; local_date: string }[]>`
        select extract(hour from next_run_at at time zone 'America/Los_Angeles')::int as local_hour,
               (next_run_at at time zone 'America/Los_Angeles')::date::text as local_date
          from public.sync_schedules where id = ${scheduleId}
      `;
      expect(anchored?.local_hour).toBe(6);
      expect(anchored?.local_date).toBe('2026-06-16');

      // A tick before 6am local anchors to the same day's 6am, not the next.
      await database.sql`
        update public.sync_schedules set next_run_at = '2026-06-15T11:59:00Z'
         where id = ${scheduleId}
      `;
      await enqueueDueSchedules(database, new Date('2026-06-15T12:00:00Z')); // 05:00 PDT
      const [early] = await database.sql<{ local_hour: number; local_date: string }[]>`
        select extract(hour from next_run_at at time zone 'America/Los_Angeles')::int as local_hour,
               (next_run_at at time zone 'America/Los_Angeles')::date::text as local_date
          from public.sync_schedules where id = ${scheduleId}
      `;
      expect(early?.local_hour).toBe(6);
      expect(early?.local_date).toBe('2026-06-15');
    });

    it('derives a Sunday weekStart for due SQP categorization jobs', async () => {
      const [schedule] = await database.sql<{ id: string }[]>`
        insert into public.sync_schedules
          (org_id, profile_id, job_type, variant, cadence, next_run_at)
        values (${orgId}, ${profileId}, 'sqp.categorize', 'sqp-week-test', interval '7 days',
                '2026-08-27T11:59:00Z')
        returning id
      `;
      const scheduleId = schedule?.id ?? '';

      const rows = await enqueueDueSchedules(database, new Date('2026-08-27T12:00:00Z'));
      expect(rows.find((row) => row.scheduleId === scheduleId)?.enqueued).toBe(true);
      const [job] = await database.sql<{ payload: unknown }[]>`
        select payload from public.sync_jobs where schedule_id = ${scheduleId}
      `;
      expect(JobPayload.parse(job?.payload)).toMatchObject({
        type: 'sqp.categorize',
        weekStart: '2026-08-23',
      });
    });
  });
});
