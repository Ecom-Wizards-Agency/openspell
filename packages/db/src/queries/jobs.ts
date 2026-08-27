/**
 * Queue helpers.
 *
 * All four wrap SQL functions rather than reimplementing them, because the
 * atomicity lives in the SQL. `claimSyncJobs` in particular is one statement:
 * an UPDATE whose subquery takes `FOR UPDATE SKIP LOCKED`. Any TypeScript that
 * "helpfully" split that into a select and an update would reintroduce exactly
 * the double-claim this design exists to prevent.
 */
import type { JobPayload, JobType } from '@wizard-ads/shared';
import type { DbHandle } from '../client.js';
import type { SyncJob } from '../schema/sync.js';

/** One row of `sync_jobs`, as the SQL functions return it. */
export interface ClaimedJob {
  id: string;
  orgId: string;
  profileId: string;
  jobType: SyncJob['jobType'];
  payload: JobPayload;
  attempts: number;
  maxAttempts: number;
  dedupeKey: string | null;
  claimedBy: string | null;
}

interface RawJobRow {
  id: string;
  org_id: string;
  profile_id: string;
  job_type: SyncJob['jobType'];
  payload: JobPayload;
  attempts: number;
  max_attempts: number;
  dedupe_key: string | null;
  claimed_by: string | null;
}

const toClaimedJob = (row: RawJobRow): ClaimedJob => ({
  id: row.id,
  orgId: row.org_id,
  profileId: row.profile_id,
  jobType: row.job_type,
  payload: row.payload,
  attempts: row.attempts,
  maxAttempts: row.max_attempts,
  dedupeKey: row.dedupe_key,
  claimedBy: row.claimed_by,
});

/**
 * Claim up to `limit` queued jobs for this worker. Returns fewer than asked
 * for when the queue is short, and an empty array when it is empty; never
 * blocks waiting for work.
 */
export async function claimSyncJobs(
  handle: DbHandle,
  workerId: string,
  limit: number,
  jobTypes?: readonly JobType[],
): Promise<ClaimedJob[]> {
  const rows = await handle.sql<RawJobRow[]>`
    select * from public.claim_sync_jobs(
      ${workerId}, ${limit}, ${jobTypes === undefined ? null : [...jobTypes]}::public.sync_job_type[]
    )
  `;
  return rows.map(toClaimedJob);
}

export type JobOutcome = 'succeeded' | 'failed';

/**
 * Report a job's outcome. A failure with attempts left is requeued with a
 * delay; out of attempts it becomes `dead`, which is a different word from
 * `failed` on purpose: dead means nobody retries without a human.
 */
export async function finishSyncJob(
  handle: DbHandle,
  jobId: string,
  outcome: JobOutcome,
  options: { error?: string; result?: unknown; retryIn?: string } = {},
): Promise<{ status: SyncJob['status']; attempts: number }> {
  const rows = await handle.sql<{ status: SyncJob['status']; attempts: number }[]>`
    select status, attempts from public.finish_sync_job(
      ${jobId},
      ${outcome}::public.sync_job_status,
      ${options.error ?? null},
      ${options.result === undefined ? null : JSON.stringify(options.result)}::jsonb,
      ${options.retryIn ?? null}::interval
    )
  `;
  const row = rows[0];
  if (!row) throw new Error(`finish_sync_job returned no row for ${jobId}`);
  return row;
}

/** Reclaim jobs whose worker went away. Returns how many were revived. */
export async function requeueStaleSyncJobs(
  handle: DbHandle,
  olderThan = '30 minutes',
): Promise<number> {
  const rows = await handle.sql<{ requeue_stale_sync_jobs: number }[]>`
    select public.requeue_stale_sync_jobs(${olderThan}::interval)
  `;
  return rows[0]?.requeue_stale_sync_jobs ?? 0;
}

export interface EnqueueResult {
  scheduleId: string;
  jobId: string | null;
  dedupeKey: string;
  enqueued: boolean;
}

/**
 * Turn due schedules into jobs. This is the pg_cron target; calling it by hand
 * is how a test (or an operator) makes the clock move.
 *
 * The returned rows report every schedule that came due, including the ones
 * whose job was deduplicated away (`enqueued: false`). Counting due against
 * enqueued is the rule-45 check for the scheduler.
 */
export async function enqueueDueSchedules(
  handle: DbHandle,
  now?: Date,
): Promise<EnqueueResult[]> {
  // Sent as an ISO string rather than a Date: the parameter carries an explicit
  // cast, which pins its type on the server side, and a driver-inferred Date
  // fights that rather than helping.
  const rows = await handle.sql<
    { schedule_id: string; job_id: string | null; dedupe_key: string; enqueued: boolean }[]
  >`
    select * from public.enqueue_due_schedules(${now?.toISOString() ?? null}::timestamptz)
  `;
  return rows.map((row) => ({
    scheduleId: row.schedule_id,
    jobId: row.job_id,
    dedupeKey: row.dedupe_key,
    enqueued: row.enqueued,
  }));
}
