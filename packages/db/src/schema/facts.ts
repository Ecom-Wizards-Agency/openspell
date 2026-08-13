/**
 * Fact tables.
 *
 * Mirrors `supabase/migrations/20260813120300_facts.sql`. Drizzle has no notion
 * of declarative partitioning and does not need one: a partitioned table is
 * read and written through its parent, which is exactly what these definitions
 * describe. The partitions themselves are the migration's business and the
 * automation's, never a query's.
 *
 * Each attribution window is its own column because Amazon restates sales for
 * 14+ days. A single `sales` column would silently change value under a report
 * that has not been re-pulled, and nobody would see it happen.
 */
import { boolean, date, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { count, money, ts } from './columns.js';
import { adProduct, matchType, placement, targetKind } from './enums.js';
import { adProfiles, orgs } from './tenancy.js';

const factBase = () => ({
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id')
    .notNull()
    .references(() => adProfiles.id, { onDelete: 'cascade' }),
  /** The profile's own calendar day, never a timestamp. */
  date: date('date').notNull(),
  impressions: count('impressions').notNull().default(0),
  clicks: count('clicks').notNull().default(0),
  cost: money('cost').notNull().default(0),
  /** Which report load produced the row: the crosscheck's provenance. */
  reportRequestId: uuid('report_request_id'),
  loadedAt: ts('loaded_at').notNull().defaultNow(),
});

export const factSpTargetDaily = pgTable(
  'fact_sp_target_daily',
  {
    ...factBase(),
    adProduct: adProduct('ad_product').notNull(),
    campaignId: text('campaign_id').notNull(),
    adGroupId: text('ad_group_id').notNull(),
    targetId: text('target_id').notNull(),
    targetKind: targetKind('target_kind').notNull(),
    matchType: matchType('match_type'),
    purchases1d: count('purchases_1d').notNull().default(0),
    purchases7d: count('purchases_7d').notNull().default(0),
    purchases14d: count('purchases_14d').notNull().default(0),
    purchases30d: count('purchases_30d').notNull().default(0),
    sales1d: money('sales_1d').notNull().default(0),
    sales7d: money('sales_7d').notNull().default(0),
    sales14d: money('sales_14d').notNull().default(0),
    sales30d: money('sales_30d').notNull().default(0),
    unitsSold7d: count('units_sold_7d').notNull().default(0),
    topOfSearchImpressionShare: money('top_of_search_impression_share', 7, 6),
  },
  (t) => [index('fact_sp_target_daily_profile_date').on(t.profileId, t.date)],
);

export const factSearchTermDaily = pgTable(
  'fact_search_term_daily',
  {
    ...factBase(),
    adProduct: adProduct('ad_product').notNull(),
    campaignId: text('campaign_id').notNull(),
    adGroupId: text('ad_group_id').notNull(),
    /** Null where the report attributes a term to an auto target it does not name. */
    targetId: text('target_id'),
    searchTerm: text('search_term').notNull(),
    matchType: matchType('match_type'),
    purchases7d: count('purchases_7d').notNull().default(0),
    sales7d: money('sales_7d').notNull().default(0),
    unitsSold7d: count('units_sold_7d').notNull().default(0),
  },
  (t) => [index('fact_search_term_daily_term').on(t.profileId, t.searchTerm)],
);

export const factPlacementDaily = pgTable(
  'fact_placement_daily',
  {
    ...factBase(),
    adProduct: adProduct('ad_product').notNull(),
    campaignId: text('campaign_id').notNull(),
    placement: placement('placement').notNull(),
    purchases7d: count('purchases_7d').notNull().default(0),
    sales7d: money('sales_7d').notNull().default(0),
  },
  (t) => [index('fact_placement_daily_profile_date').on(t.profileId, t.date)],
);

export const factSbDaily = pgTable(
  'fact_sb_daily',
  {
    ...factBase(),
    campaignId: text('campaign_id').notNull(),
    adGroupId: text('ad_group_id'),
    purchases7d: count('purchases_7d').notNull().default(0),
    sales7d: money('sales_7d').notNull().default(0),
    unitsSold7d: count('units_sold_7d').notNull().default(0),
    /** Video and viewability metrics no other grain has. */
    metrics: jsonb('metrics').notNull().default({}),
  },
  (t) => [index('fact_sb_daily_profile_date').on(t.profileId, t.date)],
);

export const factSdDaily = pgTable(
  'fact_sd_daily',
  {
    ...factBase(),
    campaignId: text('campaign_id').notNull(),
    adGroupId: text('ad_group_id'),
    purchases7d: count('purchases_7d').notNull().default(0),
    sales7d: money('sales_7d').notNull().default(0),
    unitsSold7d: count('units_sold_7d').notNull().default(0),
    metrics: jsonb('metrics').notNull().default({}),
  },
  (t) => [index('fact_sd_daily_profile_date').on(t.profileId, t.date)],
);

export const factProfileDaily = pgTable(
  'fact_profile_daily',
  {
    ...factBase(),
    currencyCode: text('currency_code').notNull(),
    purchases7d: count('purchases_7d').notNull().default(0),
    sales7d: money('sales_7d').notNull().default(0),
    unitsSold7d: count('units_sold_7d').notNull().default(0),
    /** Sales are still attributing. The crosscheck skips these days. */
    provisional: boolean('provisional').notNull().default(false),
  },
  (t) => [index('fact_profile_daily_org_date').on(t.orgId, t.date)],
);

export const factMonthlyRollup = pgTable('fact_monthly_rollup', {
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id')
    .notNull()
    .references(() => adProfiles.id, { onDelete: 'cascade' }),
  month: date('month').notNull(),
  source: text('source').notNull(),
  dimensions: jsonb('dimensions').$type<Record<string, string | null>>().notNull().default({}),
  days: count('days').notNull().default(0),
  impressions: count('impressions'),
  clicks: count('clicks'),
  cost: money('cost', 16, 4),
  purchases7d: count('purchases_7d'),
  purchases14d: count('purchases_14d'),
  sales7d: money('sales_7d', 16, 4),
  sales14d: money('sales_14d', 16, 4),
  unitsSold7d: count('units_sold_7d'),
  rolledUpAt: ts('rolled_up_at').notNull().defaultNow(),
});

export type SpTargetFactRow = typeof factSpTargetDaily.$inferSelect;
export type NewSpTargetFact = typeof factSpTargetDaily.$inferInsert;
export type SearchTermFactRow = typeof factSearchTermDaily.$inferSelect;
export type NewSearchTermFact = typeof factSearchTermDaily.$inferInsert;
export type PlacementFactRow = typeof factPlacementDaily.$inferSelect;
export type NewPlacementFact = typeof factPlacementDaily.$inferInsert;
export type ProfileFactRow = typeof factProfileDaily.$inferSelect;
export type NewProfileFact = typeof factProfileDaily.$inferInsert;
export type MonthlyRollupRow = typeof factMonthlyRollup.$inferSelect;
