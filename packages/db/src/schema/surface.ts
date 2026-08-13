/**
 * Product surface: tags, dashboards, deep links, audit log.
 *
 * Mirrors the product-surface migration in supabase/migrations.
 */
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { ts } from './columns.js';
import { auditActorType, entityType } from './enums.js';
import { adProfiles, authUsers, orgs } from './tenancy.js';

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** Nesting is a parent pointer; `tag_subtree(id)` walks it. */
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    color: text('color'),
    createdBy: uuid('created_by').references(() => authUsers.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('tags_sibling_slug_key').on(t.orgId, t.parentId, t.slug)],
);

export const entityTags = pgTable(
  'entity_tags',
  {
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').references(() => adProfiles.id, { onDelete: 'cascade' }),
    entityType: entityType('entity_type'),
    entityId: text('entity_id'),
    createdBy: uuid('created_by').references(() => authUsers.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('entity_tags_key').on(t.tagId, t.profileId, t.entityType, t.entityId),
    index('entity_tags_entity_idx').on(t.orgId, t.entityType, t.entityId),
  ],
);

export const dashboards = pgTable(
  'dashboards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    layout: jsonb('layout').notNull().default({}),
    filters: jsonb('filters').notNull().default({}),
    whiteLabel: jsonb('white_label'),
    shareToken: text('share_token').unique(),
    shareExpiresAt: ts('share_expires_at'),
    createdBy: uuid('created_by').references(() => authUsers.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('dashboards_org_id_name_key').on(t.orgId, t.name)],
);

export const gotoLinks = pgTable(
  'goto_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    route: text('route').notNull(),
    /** Filter and grid state, restored verbatim on resolve. */
    state: jsonb('state').notNull().default({}),
    label: text('label'),
    expiresAt: ts('expires_at'),
    uses: integer('uses').notNull().default(0),
    lastUsedAt: ts('last_used_at'),
    createdBy: uuid('created_by').references(() => authUsers.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('goto_links_org_idx').on(t.orgId)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    actorType: auditActorType('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    payload: jsonb('payload').notNull().default({}),
    source: text('source'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('audit_log_org_time_idx').on(t.orgId, t.createdAt)],
);

export type Tag = typeof tags.$inferSelect;
export type EntityTag = typeof entityTags.$inferSelect;
export type Dashboard = typeof dashboards.$inferSelect;
export type GotoLink = typeof gotoLinks.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
