/**
 * Analysis outputs: runs, recommendations, insights, crosscheck results.
 *
 * Mirrors `supabase/migrations/20260813120600_analysis.sql`.
 *
 * `recommendations.inputs` is typed as the contract's `RecommendationInputs`
 * and is not nullable. A proposal without its provenance is not a proposal we
 * ship.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  OptimizationGroupSnapshot,
  OptimizationRunScheduleContext,
  RecommendationInputs,
  TenantStrategy,
} from '@wizard-ads/shared';
import { money, ts } from './columns.js';
import {
  adProduct,
  crosscheckVerdict,
  entityType,
  recommendationReason,
  recommendationStatus,
  runStatus,
  optimizationGroupRole,
} from './enums.js';
import { adProfiles, authUsers, orgs } from './tenancy.js';
import { syncJobs } from './sync.js';

export const recommendationPreviewBatches = pgTable(
  'recommendation_preview_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    clientRequestId: uuid('client_request_id').notNull(),
    selectionMode: text('selection_mode').$type<'all' | 'selected'>().notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    scopeCount: integer('scope_count').notNull(),
    scopeFingerprint: text('scope_fingerprint').notNull(),
    childCount: integer('child_count').notNull(),
    createdBy: uuid('created_by').references(() => authUsers.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] })
      .onDelete('cascade'),
    unique('recommendation_preview_batches_tenant_identity_key').on(t.orgId, t.profileId, t.id),
    unique('recommendation_preview_batches_client_request_key')
      .on(t.orgId, t.profileId, t.clientRequestId),
    check(
      'recommendation_preview_batches_selection_mode_check',
      sql`${t.selectionMode} in ('all', 'selected')`,
    ),
    check(
      'recommendation_preview_batches_counts_check',
      sql`${t.scopeCount} between 1 and 10000 and ${t.childCount} > 0 and ${t.childCount} <= ${t.scopeCount}`,
    ),
    check(
      'recommendation_preview_batches_request_fingerprint_check',
      sql`${t.requestFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'recommendation_preview_batches_scope_fingerprint_check',
      sql`${t.scopeFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    index('recommendation_preview_batches_profile_created_idx').on(t.profileId, t.createdAt),
  ],
);

export const recommendationRuns = pgTable(
  'recommendation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => adProfiles.id, { onDelete: 'cascade' }),
    status: runStatus('status').notNull().default('queued'),
    lookbackDays: integer('lookback_days').notNull(),
    windowStart: date('window_start'),
    windowEnd: date('window_end'),
    /** Doctrine as it was at run time. Without it, an old proposal is unexplainable. */
    strategySnapshot: jsonb('strategy_snapshot').$type<TenantStrategy>(),
    /** Resolved goal lens paired with strategySnapshot for scoped runs. */
    strategyGoal: text('strategy_goal'),
    groupId: uuid('group_id'),
    groupRole: optimizationGroupRole('group_role'),
    groupSnapshot: jsonb('group_snapshot').$type<OptimizationGroupSnapshot>(),
    dueAt: ts('due_at'),
    scheduleContext: jsonb('schedule_context').$type<OptimizationRunScheduleContext>(),
    batchId: uuid('batch_id'),
    scopeVersion: smallint('scope_version'),
    scopeCount: integer('scope_count'),
    scopeFingerprint: text('scope_fingerprint'),
    /** Exact queue ledger row authorized to execute this scoped run. */
    jobId: uuid('job_id'),
    engineVersion: text('engine_version'),
    proposalsCount: integer('proposals_count').notNull().default(0),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    error: text('error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.profileId, t.batchId],
      foreignColumns: [
        recommendationPreviewBatches.orgId,
        recommendationPreviewBatches.profileId,
        recommendationPreviewBatches.id,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'recommendation_runs_job_fkey',
      columns: [t.orgId, t.profileId, t.jobId],
      foreignColumns: [syncJobs.orgId, syncJobs.profileId, syncJobs.id],
    }).onDelete('restrict'),
    unique('recommendation_runs_tenant_identity_key').on(t.orgId, t.profileId, t.id),
    unique('recommendation_runs_job_id_key').on(t.jobId),
    // Drizzle 0.45 cannot express `NULLS NOT DISTINCT` on a partial unique
    // index. The source migration adds it; this declaration retains the typed
    // index shape and predicate without pretending the builder can render it.
    uniqueIndex('recommendation_runs_batch_group_key')
      .on(t.batchId, t.groupId)
      .where(sql`${t.batchId} is not null`),
    unique('recommendation_runs_scope_parent_identity_key')
      .on(t.orgId, t.profileId, t.id, t.batchId)
      .nullsNotDistinct(),
    check(
      'recommendation_runs_scope_shape_check',
      sql`(
        ${t.scopeVersion} is null and ${t.scopeCount} is null
        and ${t.scopeFingerprint} is null and ${t.jobId} is null and ${t.strategyGoal} is null
      ) or (
        ${t.scopeVersion} = 1 and ${t.scopeCount} between 1 and 10000
        and ${t.scopeFingerprint} ~ '^[0-9a-f]{64}$'
        and ${t.jobId} is not null and ${t.strategySnapshot} is not null
        and btrim(${t.strategyGoal}) <> ''
      )`,
    ),
    check(
      'recommendation_runs_scoped_group_shape_check',
      sql`${t.scopeVersion} is null or (
        (${t.groupId} is null and ${t.groupRole} is null and ${t.groupSnapshot} is null)
        or
        (${t.groupId} is not null and ${t.groupRole} is not null and ${t.groupSnapshot} is not null)
      )`,
    ),
    check(
      'recommendation_runs_batch_requires_scope_check',
      sql`${t.batchId} is null or ${t.scopeVersion} = 1`,
    ),
    index('recommendation_runs_profile_idx').on(t.profileId),
    index('recommendation_runs_batch_idx').on(t.batchId),
  ],
);

export const recommendationRunCampaigns = pgTable(
  'recommendation_run_campaigns',
  {
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(),
    batchId: uuid('batch_id'),
    runId: uuid('run_id').notNull(),
    campaignId: text('campaign_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.campaignId] }),
    foreignKey({
      columns: [t.orgId, t.profileId],
      foreignColumns: [adProfiles.orgId, adProfiles.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.profileId, t.runId],
      foreignColumns: [recommendationRuns.orgId, recommendationRuns.profileId, recommendationRuns.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.profileId, t.batchId],
      foreignColumns: [
        recommendationPreviewBatches.orgId,
        recommendationPreviewBatches.profileId,
        recommendationPreviewBatches.id,
      ],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.profileId, t.runId, t.batchId],
      foreignColumns: [
        recommendationRuns.orgId,
        recommendationRuns.profileId,
        recommendationRuns.id,
        recommendationRuns.batchId,
      ],
    }).onDelete('cascade'),
    uniqueIndex('recommendation_run_campaigns_batch_campaign_key')
      .on(t.batchId, t.campaignId)
      .where(sql`${t.batchId} is not null`),
    check('recommendation_run_campaigns_campaign_nonempty', sql`btrim(${t.campaignId}) <> ''`),
    index('recommendation_run_campaigns_profile_run_idx').on(t.profileId, t.runId),
  ],
);

export const recommendations = pgTable(
  'recommendations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => recommendationRuns.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => adProfiles.id, { onDelete: 'cascade' }),
    reason: recommendationReason('reason').notNull(),
    /** EntityRef, flattened: resolvable without a join. */
    entityType: entityType('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    adProduct: adProduct('ad_product'),
    campaignId: text('campaign_id'),
    adGroupId: text('ad_group_id'),
    entityName: text('entity_name'),
    field: text('field').notNull(),
    currentValue: jsonb('current_value').$type<number | string | null>(),
    proposedValue: jsonb('proposed_value').$type<number | string | null>(),
    inputs: jsonb('inputs').$type<RecommendationInputs>().notNull(),
    status: recommendationStatus('status').notNull().default('proposed'),
    decidedBy: uuid('decided_by').references(() => authUsers.id, { onDelete: 'set null' }),
    decidedAt: ts('decided_at'),
    exportBatchId: uuid('export_batch_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('recommendations_run_idx').on(t.runId),
    index('recommendations_open_idx').on(t.profileId, t.status),
    uniqueIndex('recommendations_org_profile_id_key').on(t.orgId, t.profileId, t.id),
  ],
);

export const insights = pgTable(
  'insights',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').references(() => adProfiles.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** The numbers the prose refers to, so a claim can be checked. */
    figures: jsonb('figures').notNull().default({}),
    source: text('source').notNull().default('headless_analyst'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('insights_org_date_idx').on(t.orgId, t.date)],
);

export const crosscheckResults = pgTable(
  'crosscheck_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => adProfiles.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    grain: text('grain').notNull(),
    entityId: text('entity_id'),
    metric: text('metric').notNull(),
    ours: money('ours', 16, 4),
    theirs: money('theirs', 16, 4),
    deltaPct: money('delta_pct', 10, 6),
    tolerance: money('tolerance', 10, 6).notNull(),
    verdict: crosscheckVerdict('verdict').notNull(),
    source: text('source'),
    runId: uuid('run_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('crosscheck_results_verdict_idx').on(t.profileId, t.date, t.verdict)],
);

export type RecommendationRun = typeof recommendationRuns.$inferSelect;
export type NewRecommendationRun = typeof recommendationRuns.$inferInsert;
export type RecommendationRow = typeof recommendations.$inferSelect;
export type NewRecommendation = typeof recommendations.$inferInsert;
export type InsightRow = typeof insights.$inferSelect;
export type CrosscheckResultRow = typeof crosscheckResults.$inferSelect;
