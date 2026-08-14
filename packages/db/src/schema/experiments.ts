/**
 * Experiments and their transition log (WP-19).
 *
 * Mirrors `supabase/migrations/20260814180000_experiments.sql`. The migrations
 * are the source of truth; this is the typed mirror the query helpers and the
 * rest of the system read against.
 *
 * `scope` is typed as `ExperimentScope` rather than bare jsonb: a scope without
 * a shape is a scope nobody can read back, and the comparison view depends on
 * knowing which ids it holds.
 */
import { bigint, index, jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { ts } from './columns.js';
import { adProfiles, authUsers, orgs } from './tenancy.js';

export const experimentType = pgEnum('experiment_type', [
  'bid_push',
  'creative',
  'listing_content',
  'price',
  'placement',
  'other',
]);

export const experimentMetric = pgEnum('experiment_metric', [
  'acos',
  'cvr',
  'ctr',
  'sales',
  'share',
]);

export const experimentStatus = pgEnum('experiment_status', [
  'planned',
  'running',
  'ended',
  'analyzed',
  'aborted',
]);

/**
 * The entity refs a test touches. Every field optional: a price test names
 * ASINs, a bid push names campaigns and targets, and an experiment can name
 * both. Read whole, written once.
 */
export interface ExperimentScope {
  campaignIds?: string[];
  adGroupIds?: string[];
  /** Keyword or product-target amazon ids. */
  targetIds?: string[];
  asins?: string[];
  searchTerms?: string[];
  note?: string;
}

export const experiments = pgTable(
  'experiments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => adProfiles.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    hypothesis: text('hypothesis').notNull().default(''),
    type: experimentType('type').notNull(),
    scope: jsonb('scope').$type<ExperimentScope>().notNull().default({}),
    metricFocus: experimentMetric('metric_focus').notNull(),
    startAt: ts('start_at').notNull().defaultNow(),
    endAt: ts('end_at'),
    status: experimentStatus('status').notNull().default('planned'),
    resultNote: text('result_note'),
    createdBy: uuid('created_by').references(() => authUsers.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    statusChangedAt: ts('status_changed_at').notNull().defaultNow(),
  },
  (t) => [
    index('experiments_org_status_idx').on(t.orgId, t.status, t.startAt),
    index('experiments_profile_window_idx').on(t.profileId, t.startAt),
  ],
);

export const experimentEvents = pgTable(
  'experiment_events',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    experimentId: uuid('experiment_id').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    fromStatus: experimentStatus('from_status'),
    toStatus: experimentStatus('to_status').notNull(),
    note: text('note'),
    actorId: uuid('actor_id').references(() => authUsers.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('experiment_events_experiment_idx').on(t.orgId, t.experimentId, t.createdAt)],
);

export type ExperimentRow = typeof experiments.$inferSelect;
export type NewExperiment = typeof experiments.$inferInsert;
export type ExperimentEventRow = typeof experimentEvents.$inferSelect;
export type NewExperimentEvent = typeof experimentEvents.$inferInsert;
