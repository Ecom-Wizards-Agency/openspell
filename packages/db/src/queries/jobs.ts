/**
 * Queue helpers.
 *
 * All four wrap SQL functions rather than reimplementing them, because the
 * atomicity lives in the SQL. `claimSyncJobs` in particular is one statement:
 * an UPDATE whose subquery takes `FOR UPDATE SKIP LOCKED`. Any TypeScript that
 * "helpfully" split that into a select and an update would reintroduce exactly
 * the double-claim this design exists to prevent.
 */
import type { JobType } from '@wizard-ads/shared';
import type { DbHandle } from '../client.js';
import type { SyncJob } from '../schema/sync.js';
import {
  claimedJobFromRaw,
  type ClaimRef,
  type ClaimedJob,
  type RawClaimedJobRow,
} from './job-wire.js';

export type { ClaimRef, ClaimToken, ClaimedJob } from './job-wire.js';

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
  const allowedTypes = jobTypes === undefined ? null : handle.sql.array([...jobTypes]);
  const rows = await handle.sql<RawClaimedJobRow[]>`
    select * from public.claim_sync_jobs(
      ${workerId}, ${limit}, ${allowedTypes}::public.sync_job_type[]
    )
  `;
  return rows.map(claimedJobFromRaw);
}

/**
 * Claim jobs under fenced custody. Every returned job carries a fresh opaque
 * capability; a malformed or tokenless server response fails closed.
 */
export async function claimSyncJobsFenced(
  handle: DbHandle,
  workerId: string,
  limit: number,
  jobTypes?: readonly JobType[],
): Promise<ClaimedJob[]> {
  const allowedTypes = jobTypes === undefined ? null : handle.sql.array([...jobTypes]);
  const rows = await handle.sql<RawClaimedJobRow[]>`
    select * from public.claim_sync_jobs_fenced(
      ${workerId}, ${limit}, ${allowedTypes}::public.sync_job_type[]
    )
  `;
  return rows.map((row) => {
    const job = claimedJobFromRaw(row);
    if (job.claim === null) throw new Error('fenced claim function returned tokenless custody');
    return job;
  });
}

export type JobOutcome = 'succeeded' | 'failed';
export type FencedJobOutcome = JobOutcome | 'dead';

export type FencedFinishDecision =
  | Readonly<{ decision: 'settled'; status: SyncJob['status']; attempts: number }>
  | Readonly<{ decision: 'stale_claim'; status: null; attempts: null }>;

export type FencedDeferDecision =
  | Readonly<{ decision: 'deferred'; status: 'queued'; attempts: number }>
  | Readonly<{ decision: 'stale_claim'; status: null; attempts: null }>;

export type ReportWorkerClaimProtocol = 'legacy' | 'fenced';

/** Sanitized, capability-free report-lane authority evidence. */
export type ReportWorkerClaimAuthority = Readonly<{
  protocol: ReportWorkerClaimProtocol;
  epoch: number;
}>;

/** Closed result of the one-way report-lane authority transition. */
export type ReportWorkerClaimActivationDecision = Readonly<{
  decision: 'activated' | 'already_fenced' | 'unresolved';
  epoch: number;
  unresolved: number;
}>;

interface RawReportWorkerClaimAuthority {
  protocol: string;
  epoch: string | number;
}

interface RawReportWorkerClaimActivation {
  decision: string;
  epoch: string | number;
  unresolved: string | number;
}

function nonnegativeSafeInteger(value: string | number, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`report worker claim authority returned an invalid ${field}`);
  }
  return parsed;
}

/** Read the capability-free protocol authority used by deployment readiness. */
export async function getReportWorkerClaimAuthority(
  handle: DbHandle,
): Promise<ReportWorkerClaimAuthority> {
  const rows = await handle.sql<RawReportWorkerClaimAuthority[]>`
    select protocol, epoch from public.get_report_worker_claim_authority()
  `;
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new Error('report worker claim authority returned an invalid row count');
  }
  if (row.protocol !== 'legacy' && row.protocol !== 'fenced') {
    throw new Error('report worker claim authority returned an invalid protocol');
  }
  return {
    protocol: row.protocol,
    epoch: nonnegativeSafeInteger(row.epoch, 'epoch'),
  };
}

/** Atomically and irreversibly authorize fenced report-lane claims. */
export async function activateReportWorkerFencedClaims(
  handle: DbHandle,
): Promise<ReportWorkerClaimActivationDecision> {
  const rows = await handle.sql<RawReportWorkerClaimActivation[]>`
    select decision, epoch, unresolved
      from public.activate_report_worker_fenced_claims()
  `;
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new Error('report worker claim activation returned an invalid row count');
  }
  if (
    row.decision !== 'activated'
    && row.decision !== 'already_fenced'
    && row.decision !== 'unresolved'
  ) {
    throw new Error('report worker claim activation returned an invalid decision');
  }
  const epoch = nonnegativeSafeInteger(row.epoch, 'epoch');
  const unresolved = nonnegativeSafeInteger(row.unresolved, 'unresolved count');
  if (row.decision === 'activated' && unresolved !== 0) {
    throw new Error('report worker claim activation returned unresolved activated custody');
  }
  if (row.decision === 'unresolved' && unresolved === 0) {
    throw new Error('report worker claim activation returned an empty unresolved decision');
  }
  return { decision: row.decision, epoch, unresolved };
}

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

interface RawFencedTransition {
  decision: string;
  status: SyncJob['status'] | null;
  attempts: number | null;
}

/** Settle, retry, or dead-letter exactly one fenced attempt. */
export async function finishSyncJobFenced(
  handle: DbHandle,
  claim: ClaimRef,
  outcome: FencedJobOutcome,
  options: { error?: string; result?: unknown; retryIn?: string } = {},
): Promise<FencedFinishDecision> {
  const rows = await handle.sql<RawFencedTransition[]>`
    select decision, status, attempts from public.finish_sync_job_fenced(
      ${claim.jobId},
      ${claim.token}::uuid,
      ${outcome}::public.sync_job_status,
      ${options.error ?? null},
      ${options.result === undefined ? null : JSON.stringify(options.result)}::jsonb,
      ${options.retryIn ?? null}::interval
    )
  `;
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new Error('fenced finish returned an invalid decision count');
  }
  if (row.decision === 'stale_claim' && row.status === null && row.attempts === null) {
    return { decision: 'stale_claim', status: null, attempts: null };
  }
  if (row.decision !== 'settled' || row.status === null || row.attempts === null) {
    throw new Error('fenced finish returned an invalid decision');
  }
  return { decision: 'settled', status: row.status, attempts: row.attempts };
}

/** Defer exactly one fenced attempt without consuming its attempt count. */
export async function deferSyncJobFenced(
  handle: DbHandle,
  claim: ClaimRef,
  retryIn: string,
): Promise<FencedDeferDecision> {
  const rows = await handle.sql<RawFencedTransition[]>`
    select decision, status, attempts from public.defer_sync_job_fenced(
      ${claim.jobId}, ${claim.token}::uuid, ${retryIn}::interval
    )
  `;
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new Error('fenced defer returned an invalid decision count');
  }
  if (row.decision === 'stale_claim' && row.status === null && row.attempts === null) {
    return { decision: 'stale_claim', status: null, attempts: null };
  }
  if (row.decision !== 'deferred' || row.status !== 'queued' || row.attempts === null) {
    throw new Error('fenced defer returned an invalid decision');
  }
  return { decision: 'deferred', status: 'queued', attempts: row.attempts };
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
