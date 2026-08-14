/**
 * Sync status, v0.
 *
 * Operator trust starts here (docs/PLAN.md, v1 module scope item 3), so the
 * page shows the two ledgers unedited: what the queue is doing and what the
 * report requests did. Two things it deliberately does *not* do:
 *
 *  - It does not summarise a failure into a colour. The error text is the
 *    column, because "amber" has never once told anyone what to fix.
 *  - It does not compute freshness from `updated_at`. Freshness is the newest
 *    *fact date* the profile has, which is the number an operator is actually
 *    asking about when they ask whether the data is current.
 *
 * Styling is WP-06's job. This is a table.
 */
import type { DbHandle } from '@wizard-ads/db';

export interface JobRow {
  id: string;
  profileLabel: string;
  region: string;
  jobType: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  runAfter: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

export interface ReportRow {
  id: string;
  profileLabel: string;
  reportType: string;
  startDate: string;
  endDate: string;
  status: string;
  requestedAt: string | null;
  completedAt: string | null;
  pollAttempts: number;
  rowsParsed: number | null;
  rowsLoaded: number | null;
  countsMatch: boolean | null;
  error: string | null;
}

export interface ProfileFreshness {
  profileId: string;
  profileLabel: string;
  region: string;
  syncEnabled: boolean;
  /** Newest fact date the profile has, or null when nothing has landed. */
  latestFactDate: string | null;
  queued: number;
  running: number;
  failed: number;
}

export interface SyncStatus {
  freshness: ProfileFreshness[];
  jobs: JobRow[];
  reports: ReportRow[];
}

const JOB_LIMIT = 100;
const REPORT_LIMIT = 100;

export async function loadSyncStatus(
  handle: DbHandle,
  orgId: string,
  profileId?: string | null,
): Promise<SyncStatus> {
  const scope = profileId?.trim() || null;

  const freshness = await handle.sql<
    {
      profile_id: string;
      label: string;
      region: string;
      sync_enabled: boolean;
      latest_fact_date: string | null;
      queued: string;
      running: string;
      failed: string;
    }[]
  >`
    select p.id as profile_id,
           coalesce(p.account_name, p.amazon_profile_id) as label,
           p.region::text as region,
           p.sync_enabled,
           (select max(f.date)::text from public.fact_profile_daily f where f.profile_id = p.id)
             as latest_fact_date,
           count(*) filter (where j.status = 'queued') as queued,
           count(*) filter (where j.status = 'running') as running,
           count(*) filter (where j.status = 'failed') as failed
      from public.ad_profiles p
      left join public.sync_jobs j on j.profile_id = p.id
     where p.org_id = ${orgId}
       and (${scope}::uuid is null or p.id = ${scope}::uuid)
     group by p.id
     order by p.sync_enabled desc, label
  `;

  const jobs = await handle.sql<
    {
      id: string;
      label: string;
      region: string;
      job_type: string;
      status: string;
      attempts: number;
      max_attempts: number;
      run_after: string | null;
      started_at: string | null;
      finished_at: string | null;
      last_error: string | null;
    }[]
  >`
    select j.id,
           coalesce(p.account_name, p.amazon_profile_id) as label,
           p.region::text as region,
           j.job_type::text as job_type,
           j.status::text as status,
           j.attempts,
           j.max_attempts,
           j.run_after::text as run_after,
           j.started_at::text as started_at,
           j.finished_at::text as finished_at,
           j.last_error
      from public.sync_jobs j
      join public.ad_profiles p on p.id = j.profile_id
     where j.org_id = ${orgId}
       and (${scope}::uuid is null or j.profile_id = ${scope}::uuid)
     order by j.created_at desc
     limit ${JOB_LIMIT}
  `;

  const reports = await handle.sql<
    {
      id: string;
      label: string;
      report_type: string;
      start_date: string;
      end_date: string;
      status: string;
      requested_at: string | null;
      completed_at: string | null;
      poll_attempts: number;
      rows_parsed: string | null;
      rows_loaded: string | null;
      counts_match: boolean | null;
      error: string | null;
    }[]
  >`
    select r.id,
           coalesce(p.account_name, p.amazon_profile_id) as label,
           r.report_type::text as report_type,
           r.start_date::text as start_date,
           r.end_date::text as end_date,
           r.status::text as status,
           r.requested_at::text as requested_at,
           r.completed_at::text as completed_at,
           r.poll_attempts,
           r.rows_parsed,
           r.rows_loaded,
           r.counts_match,
           r.error
      from public.report_requests r
      join public.ad_profiles p on p.id = r.profile_id
     where r.org_id = ${orgId}
       and (${scope}::uuid is null or r.profile_id = ${scope}::uuid)
     order by r.requested_at desc
     limit ${REPORT_LIMIT}
  `;

  return {
    freshness: freshness.map((row) => ({
      profileId: row.profile_id,
      profileLabel: row.label,
      region: row.region,
      syncEnabled: row.sync_enabled,
      latestFactDate: row.latest_fact_date,
      queued: Number(row.queued),
      running: Number(row.running),
      failed: Number(row.failed),
    })),
    jobs: jobs.map((row) => ({
      id: row.id,
      profileLabel: row.label,
      region: row.region,
      jobType: row.job_type,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      runAfter: row.run_after,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      lastError: row.last_error,
    })),
    reports: reports.map((row) => ({
      id: row.id,
      profileLabel: row.label,
      reportType: row.report_type,
      startDate: row.start_date,
      endDate: row.end_date,
      status: row.status,
      requestedAt: row.requested_at,
      completedAt: row.completed_at,
      pollAttempts: row.poll_attempts,
      rowsParsed: row.rows_parsed === null ? null : Number(row.rows_parsed),
      rowsLoaded: row.rows_loaded === null ? null : Number(row.rows_loaded),
      countsMatch: row.counts_match,
      error: row.error,
    })),
  };
}
