/**
 * Sync machinery: schedules, the job queue, and the report ledger.
 *
 * Mirrors `supabase/migrations/20260813120500_sync.sql`.
 *
 * `syncJobs` is queue and ledger in one row, so nothing is deleted on success:
 * the row a worker claimed is the row an operator reads afterwards to find out
 * what happened.
 */
import {
  boolean,
  date,
  index,
  integer,
  interval,
  jsonb,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import type { JobPayload } from '@wizard-ads/shared';
import { count, ts } from './columns.js';
import { reportStatus, reportType, syncJobStatus, syncJobType } from './enums.js';
import { adProfiles, orgs } from './tenancy.js';

export const syncSchedules = pgTable(
  'sync_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => adProfiles.id, { onDelete: 'cascade' }),
    jobType: syncJobType('job_type').notNull(),
    reportType: reportType('report_type'),
    /**
     * Which of this profile's schedules for one report type this row is.
     * `default` is the daily recent-window pass; `restatement` the slower
     * long-lookback re-pull. Part of the uniqueness key, because a profile
     * needs both and they differ only in cadence and lookback.
     */
    variant: text('variant').notNull().default('default'),
    /** Postgres interval, read and written as a string ('1 day', '05:00:00'). */
    cadence: interval('cadence').notNull(),
    nextRunAt: ts('next_run_at').notNull().defaultNow(),
    enabled: boolean('enabled').notNull().default(true),
    priority: integer('priority').notNull().default(100),
    payload: jsonb('payload').notNull().default({}),
    /** Report windows: the restatement re-pull is a longer lookback, nothing more. */
    lookbackDays: integer('lookback_days'),
    lastEnqueuedAt: ts('last_enqueued_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('sync_schedules_due_idx').on(t.nextRunAt)],
);

export const syncJobs = pgTable(
  'sync_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => adProfiles.id, { onDelete: 'cascade' }),
    scheduleId: uuid('schedule_id').references(() => syncSchedules.id, { onDelete: 'set null' }),
    jobType: syncJobType('job_type').notNull(),
    /** JobPayload from the contract package, verbatim. */
    payload: jsonb('payload').$type<JobPayload>().notNull(),
    status: syncJobStatus('status').notNull().default('queued'),
    priority: integer('priority').notNull().default(100),
    runAfter: ts('run_after').notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    /** One key per schedule per due slot: a double cron tick enqueues once. */
    dedupeKey: text('dedupe_key'),
    claimedBy: text('claimed_by'),
    claimedAt: ts('claimed_at'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    lastError: text('last_error'),
    result: jsonb('result'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('sync_jobs_org_status_idx').on(t.orgId, t.status),
    index('sync_jobs_profile_idx').on(t.profileId),
  ],
);

// NOTE: `source` ('amazon_api' | 'adlabs_backfill', check-constrained) was added
// by migration 20260814160000; mirrored below per WP-18's handoff.
export const reportRequests = pgTable(
  'report_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => adProfiles.id, { onDelete: 'cascade' }),
    reportType: reportType('report_type').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    amazonReportId: text('amazon_report_id'),
    status: reportStatus('status').notNull().default('pending'),
    source: text('source').notNull().default('amazon_api'),
    requestedAt: ts('requested_at').notNull().defaultNow(),
    completedAt: ts('completed_at'),
    downloadUrl: text('download_url'),
    downloadExpiresAt: ts('download_expires_at'),
    pollAttempts: integer('poll_attempts').notNull().default(0),
    lastPolledAt: ts('last_polled_at'),
    nextPollAt: ts('next_poll_at'),
    /** Rule 45 as data: what the file said, and what reached the fact table. */
    rowsParsed: count('rows_parsed'),
    rowsLoaded: count('rows_loaded'),
    /** Generated column: never written, always true or false or null. */
    countsMatch: boolean('counts_match'),
    bytesDownloaded: count('bytes_downloaded'),
    error: text('error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('report_requests_profile_idx').on(t.profileId, t.reportType)],
);

export type SyncSchedule = typeof syncSchedules.$inferSelect;
export type NewSyncSchedule = typeof syncSchedules.$inferInsert;
export type SyncJob = typeof syncJobs.$inferSelect;
export type NewSyncJob = typeof syncJobs.$inferInsert;
export type ReportRequest = typeof reportRequests.$inferSelect;
export type NewReportRequest = typeof reportRequests.$inferInsert;
