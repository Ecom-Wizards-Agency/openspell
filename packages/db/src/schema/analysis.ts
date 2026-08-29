/**
 * Analysis outputs: runs, recommendations, insights, crosscheck results.
 *
 * Mirrors `supabase/migrations/20260813120600_analysis.sql`.
 *
 * `recommendations.inputs` is typed as the contract's `RecommendationInputs`
 * and is not nullable. A proposal without its provenance is not a proposal we
 * ship.
 */
import { date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { OptimizationGroup, RecommendationInputs, TenantStrategy } from '@wizard-ads/shared';
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
    groupId: uuid('group_id'),
    groupRole: optimizationGroupRole('group_role'),
    groupSnapshot: jsonb('group_snapshot').$type<OptimizationGroup>(),
    dueAt: ts('due_at'),
    engineVersion: text('engine_version'),
    proposalsCount: integer('proposals_count').notNull().default(0),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    error: text('error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('recommendation_runs_profile_idx').on(t.profileId)],
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
