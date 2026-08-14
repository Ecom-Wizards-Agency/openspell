/**
 * Tenancy: orgs, membership, the Amazon connection, the profile roster and the
 * doctrine document.
 *
 * Mirrors `supabase/migrations/20260813120100_tenancy.sql`. The SQL is the
 * source of truth; this file exists so queries are typed, not so the schema can
 * be generated from TypeScript.
 */
import { relations } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  jsonb,
  pgSchema,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { TenantStrategy } from '@wizard-ads/shared';
import { money, ts } from './columns.js';
import { adsRegion, connectionStatus, orgRole, profileAccountType } from './enums.js';

/**
 * Supabase's own users table. Declared, never migrated: it belongs to the auth
 * service and this schema only points at it.
 */
const authSchema = pgSchema('auth');
export const authUsers = authSchema.table('users', {
  id: uuid('id').primaryKey(),
});

export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const orgMembers = pgTable(
  'org_members',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    role: orgRole('role').notNull().default('viewer'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.userId] }),
    index('org_members_user_idx').on(t.userId),
  ],
);

export const adsConnections = pgTable(
  'ads_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    lwaClientId: text('lwa_client_id'),
    /** Points into Supabase Vault. The credential itself is never in a column. */
    vaultSecretId: uuid('vault_secret_id'),
    status: connectionStatus('status').notNull().default('pending'),
    scope: text('scope'),
    connectedBy: uuid('connected_by').references(() => authUsers.id, { onDelete: 'set null' }),
    connectedAt: ts('connected_at'),
    lastHealthCheckAt: ts('last_health_check_at'),
    lastError: text('last_error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('ads_connections_org_id_label_key').on(t.orgId, t.label)],
);

export const adProfiles = pgTable(
  'ad_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id').references(() => adsConnections.id, {
      onDelete: 'set null',
    }),
    amazonProfileId: text('amazon_profile_id').notNull(),
    region: adsRegion('region').notNull(),
    countryCode: text('country_code').notNull(),
    currencyCode: text('currency_code').notNull(),
    timezone: text('timezone').notNull(),
    accountType: profileAccountType('account_type'),
    accountName: text('account_name'),
    amazonAccountId: text('amazon_account_id'),
    /** The cost gate: nothing syncs until somebody turns it on. */
    syncEnabled: boolean('sync_enabled').notNull().default(false),
    /** Hour (0-23) in the profile's own timezone the daily pull anchors to; null uses the scheduler default. */
    preferredSyncHour: smallint('preferred_sync_hour'),
    /** Set true when an operator pins the timezone by hand; the OAuth upsert then leaves it alone. */
    timezoneLocked: boolean('timezone_locked').notNull().default(false),
    targetAcos: money('target_acos', 6, 4),
    targetTotalAcos: money('target_total_acos', 6, 4),
    goalLens: text('goal_lens'),
    monthlyBudget: money('monthly_budget', 14, 2),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    syncedAt: ts('synced_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ad_profiles_org_id_amazon_profile_id_key').on(t.orgId, t.amazonProfileId),
    index('ad_profiles_region_idx').on(t.region),
  ],
);

export const profileStrategy = pgTable(
  'profile_strategy',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** Null is the org-wide default; a profile row overrides it wholesale. */
    profileId: uuid('profile_id').references(() => adProfiles.id, { onDelete: 'cascade' }),
    schemaVersion: text('schema_version').notNull(),
    doc: jsonb('doc').$type<TenantStrategy>().notNull(),
    refreshedAt: date('refreshed_at'),
    source: text('source'),
    updatedBy: uuid('updated_by').references(() => authUsers.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('profile_strategy_scope_key').on(t.orgId, t.profileId)],
);

export const orgsRelations = relations(orgs, ({ many }) => ({
  members: many(orgMembers),
  profiles: many(adProfiles),
  connections: many(adsConnections),
}));

export const adProfilesRelations = relations(adProfiles, ({ one }) => ({
  org: one(orgs, { fields: [adProfiles.orgId], references: [orgs.id] }),
  connection: one(adsConnections, {
    fields: [adProfiles.connectionId],
    references: [adsConnections.id],
  }),
}));

export type Org = typeof orgs.$inferSelect;
export type OrgMember = typeof orgMembers.$inferSelect;
export type AdsConnection = typeof adsConnections.$inferSelect;
export type AdProfile = typeof adProfiles.$inferSelect;
export type NewAdProfile = typeof adProfiles.$inferInsert;
export type ProfileStrategyRow = typeof profileStrategy.$inferSelect;
