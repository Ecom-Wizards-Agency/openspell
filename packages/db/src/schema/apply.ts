/**
 * Staged applies and harvesting maps. Schema in v1, written in v1.x.
 *
 * Mirrors `supabase/migrations/20260813120700_writes.sql`, which is itself a
 * port of the Python staged-apply ledger. `clicks` and `revenue` ride along on
 * a row because the caps-are-ceilings validator reads them.
 */
import { boolean, date, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import type { ApplyValue } from '@wizard-ads/shared';
import { count, money, ts } from './columns.js';
import { applyBatchStatus, applyEntityType, matchType } from './enums.js';
import { adProfiles, authUsers, orgs } from './tenancy.js';

export const applyBatches = pgTable(
  'apply_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => adProfiles.id, { onDelete: 'cascade' }),
    /** `<client>-<YYYY>W<ww>-<group>-<lever>`, as the Python flow tags them. */
    tag: text('tag').notNull(),
    /** One opt group per batch. Never a whole account. */
    optGroup: text('opt_group').notNull(),
    lever: text('lever').notNull(),
    note: text('note').notNull(),
    status: applyBatchStatus('status').notNull().default('staged'),
    appliedOn: date('applied_on'),
    cooldownDays: integer('cooldown_days').notNull().default(7),
    /** A reason, not a flag: "why was the cooldown overridden" is the question. */
    cooldownBypass: text('cooldown_bypass'),
    score: jsonb('score'),
    revertedAt: ts('reverted_at'),
    revertNote: text('revert_note'),
    createdBy: uuid('created_by').references(() => authUsers.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('apply_batches_profile_idx').on(t.profileId, t.appliedOn)],
);

export const applyRows = pgTable(
  'apply_rows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => applyBatches.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    entityType: applyEntityType('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    entityName: text('entity_name'),
    field: text('field').notNull(),
    oldValue: jsonb('old_value').$type<ApplyValue>(),
    newValue: jsonb('new_value').$type<ApplyValue>(),
    lever: text('lever'),
    clicks: count('clicks'),
    revenue: money('revenue'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('apply_rows_batch_idx').on(t.batchId)],
);

export const campaignMaps = pgTable(
  'campaign_maps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => adProfiles.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    sourceFilter: jsonb('source_filter').notNull().default({}),
    /** Enough to create the destination when it does not exist yet. */
    destinationTemplate: jsonb('destination_template').notNull().default({}),
    matchTypes: matchType('match_types').array().notNull().default([]),
    negateSource: boolean('negate_source').notNull().default(true),
    createdBy: uuid('created_by').references(() => authUsers.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('campaign_maps_profile_idx').on(t.profileId)],
);

export type ApplyBatch = typeof applyBatches.$inferSelect;
export type NewApplyBatch = typeof applyBatches.$inferInsert;
export type ApplyRowDb = typeof applyRows.$inferSelect;
export type NewApplyRowDb = typeof applyRows.$inferInsert;
export type CampaignMap = typeof campaignMaps.$inferSelect;
