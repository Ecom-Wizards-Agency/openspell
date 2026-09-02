/**
 * Sync machinery: schedules, the job queue, and the report ledger.
 *
 * Mirrors `supabase/migrations/20260813120500_sync.sql`.
 *
 * `syncJobs` is queue and ledger in one row, so nothing is deleted on success:
 * the row a worker claimed is the row an operator reads afterwards to find out
 * what happened.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  foreignKey,
  index,
  integer,
  interval,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { JobPayload } from '@wizard-ads/shared';
import { count, ts } from './columns.js';
import {
  reportStatus,
  reportType,
  syncJobStatus,
  syncJobType,
  unifiedReportDefinitionVersion,
  unifiedReportOperationDisposition,
  unifiedReportOperationKind,
  unifiedReportOperationState,
  unifiedReportRunState,
} from './enums.js';
import { adProfiles, orgs } from './tenancy.js';
import { creativeSyncSnapshots } from './operator-intelligence.js';

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
    /** Inclusive number of days in a scheduled report request. */
    lookbackDays: integer('lookback_days'),
    /** Whole days between yesterday and the end of this report window. */
    windowOffsetDays: integer('window_offset_days').notNull().default(0),
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
    /** Opaque per-attempt capability. Null for legacy and unclaimed jobs. */
    claimToken: uuid('claim_token'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    lastError: text('last_error'),
    result: jsonb('result'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sync_jobs_tenant_identity_key').on(t.orgId, t.profileId, t.id),
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
    /** Attribution-aware accounting; base reports leave these null. */
    sourceRows: count('source_rows'),
    refusedRows: count('refused_rows'),
    promotedRows: count('promoted_rows'),
    unpromotedRows: count('unpromoted_rows'),
    accountingComplete: boolean('accounting_complete'),
    bytesDownloaded: count('bytes_downloaded'),
    error: text('error'),
    creativeSyncSnapshotId: uuid('creative_sync_snapshot_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('report_requests_profile_idx').on(t.profileId, t.reportType),
    foreignKey({
      columns: [t.orgId, t.profileId, t.creativeSyncSnapshotId],
      foreignColumns: [creativeSyncSnapshots.orgId, creativeSyncSnapshots.profileId, creativeSyncSnapshots.id],
    }).onDelete('restrict'),
  ],
);

/** Explicit, disabled-by-default Unified advertiser binding; never profile-derived. */
export const unifiedReportingBindings = pgTable(
  'unified_reporting_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    advertiserAccountId: text('advertiser_account_id').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    definitionVersion: unifiedReportDefinitionVersion('definition_version')
      .notNull()
      .default('campaign-observation-v1'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] })
      .onDelete('cascade'),
    uniqueIndex('unified_reporting_bindings_profile_key').on(t.profileId),
    uniqueIndex('unified_reporting_bindings_tenant_identity_key').on(t.orgId, t.profileId, t.id),
  ],
);

/** Separate Unified metadata ledger: no facts, promotion, or v3 status authority. */
export const unifiedReportRuns = pgTable(
  'unified_report_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    v3ReportRequestId: uuid('v3_report_request_id').notNull(),
    bindingId: uuid('binding_id').notNull(),
    advertiserAccountId: text('advertiser_account_id').notNull(),
    reportType: reportType('report_type').notNull(),
    definitionVersion: unifiedReportDefinitionVersion('definition_version').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    state: unifiedReportRunState('state').notNull().default('create_ready'),
    providerReportId: text('provider_report_id'),
    providerStatus: text('provider_status'),
    observationDeadline: ts('observation_deadline').notNull(),
    operationCount: integer('operation_count').notNull().default(0),
    settledOperationCount: integer('settled_operation_count').notNull().default(0),
    inputCount: integer('input_count').notNull().default(0),
    providerSuccessCount: integer('provider_success_count').notNull().default(0),
    providerRefusedCount: integer('provider_refused_count').notNull().default(0),
    createAmbiguousCount: integer('create_ambiguous_count').notNull().default(0),
    transportFailureCount: integer('transport_failure_count').notNull().default(0),
    invalidResponseCount: integer('invalid_response_count').notNull().default(0),
    localRefusalCount: integer('local_refusal_count').notNull().default(0),
    interruptedDispatchCount: integer('interrupted_dispatch_count').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] })
      .onDelete('cascade'),
    foreignKey({ columns: [t.v3ReportRequestId], foreignColumns: [reportRequests.id] })
      .onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.profileId, t.bindingId], foreignColumns: [unifiedReportingBindings.orgId, unifiedReportingBindings.profileId, unifiedReportingBindings.id] })
      .onDelete('restrict'),
    uniqueIndex('unified_report_runs_one_per_v3_request').on(t.v3ReportRequestId),
    uniqueIndex('unified_report_runs_tenant_identity_key').on(t.orgId, t.profileId, t.id),
    index('unified_report_runs_profile_state_idx').on(t.profileId, t.state, t.updatedAt),
    index('unified_report_runs_binding_idx').on(t.bindingId, t.createdAt),
  ],
);

/** Append-only one-input operation evidence, including the dispatch-token fence. */
export const unifiedReportOperations = pgTable(
  'unified_report_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    runId: uuid('run_id').notNull(),
    dispatchJobId: uuid('dispatch_job_id').notNull(),
    kind: unifiedReportOperationKind('kind').notNull(),
    sequence: integer('sequence').notNull(),
    state: unifiedReportOperationState('state').notNull().default('ready'),
    disposition: unifiedReportOperationDisposition('disposition'),
    dispatchToken: uuid('dispatch_token'),
    dispatchedAt: ts('dispatched_at'),
    settledAt: ts('settled_at'),
    providerCode: text('provider_code'),
    inputCount: integer('input_count').notNull().default(1),
    providerSuccessCount: integer('provider_success_count').notNull().default(0),
    providerRefusedCount: integer('provider_refused_count').notNull().default(0),
    createAmbiguousCount: integer('create_ambiguous_count').notNull().default(0),
    transportFailureCount: integer('transport_failure_count').notNull().default(0),
    invalidResponseCount: integer('invalid_response_count').notNull().default(0),
    localRefusalCount: integer('local_refusal_count').notNull().default(0),
    interruptedDispatchCount: integer('interrupted_dispatch_count').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.profileId, t.runId], foreignColumns: [unifiedReportRuns.orgId, unifiedReportRuns.profileId, unifiedReportRuns.id] })
      .onDelete('cascade'),
    foreignKey({ columns: [t.dispatchJobId], foreignColumns: [syncJobs.id] })
      .onDelete('restrict'),
    uniqueIndex('unified_report_operations_dispatch_job_key').on(t.dispatchJobId),
    uniqueIndex('unified_report_operations_run_sequence_key').on(t.runId, t.sequence),
    uniqueIndex('unified_report_operations_one_create_per_run')
      .on(t.runId)
      .where(sql`${t.kind} = 'create'`),
    index('unified_report_operations_run_state_idx').on(t.runId, t.state, t.sequence),
    index('unified_report_operations_dispatching_idx').on(t.dispatchedAt),
  ],
);

export type SyncSchedule = typeof syncSchedules.$inferSelect;
export type NewSyncSchedule = typeof syncSchedules.$inferInsert;
export type SyncJob = typeof syncJobs.$inferSelect;
export type NewSyncJob = typeof syncJobs.$inferInsert;
export type ReportRequest = typeof reportRequests.$inferSelect;
export type NewReportRequest = typeof reportRequests.$inferInsert;
export type UnifiedReportingBinding = typeof unifiedReportingBindings.$inferSelect;
export type NewUnifiedReportingBinding = typeof unifiedReportingBindings.$inferInsert;
export type UnifiedReportRun = typeof unifiedReportRuns.$inferSelect;
export type NewUnifiedReportRun = typeof unifiedReportRuns.$inferInsert;
export type UnifiedReportOperation = typeof unifiedReportOperations.$inferSelect;
export type NewUnifiedReportOperation = typeof unifiedReportOperations.$inferInsert;
