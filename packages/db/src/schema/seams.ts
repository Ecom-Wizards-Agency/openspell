/**
 * Reserved seams. Tables for lanes blocked on an external dependency: SP-API,
 * DataDive rank, Keepa BSR, the creative hub.
 *
 * Mirrors `supabase/migrations/20260813121100_reserved_seams.sql`. Nothing in
 * v1 reads or writes any of this; the definitions exist so the lane that
 * unblocks first does not also need a migration under a live database.
 */
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { count, money, ts } from './columns.js';
import { connectionStatus, entityState, supaRule } from './enums.js';
import { adProfiles, orgs } from './tenancy.js';

export const spapiConnections = pgTable('spapi_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  sellingPartnerId: text('selling_partner_id'),
  marketplaceIds: text('marketplace_ids').array().notNull().default([]),
  vaultSecretId: uuid('vault_secret_id'),
  status: connectionStatus('status').notNull().default('pending'),
  connectedAt: ts('connected_at'),
  lastError: text('last_error'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const factSalesTrafficDaily = pgTable(
  'fact_sales_traffic_daily',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => adProfiles.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    asin: text('asin').notNull(),
    sku: text('sku'),
    sessions: count('sessions').notNull().default(0),
    pageViews: count('page_views').notNull().default(0),
    unitsOrdered: count('units_ordered').notNull().default(0),
    orderedProductSales: money('ordered_product_sales').notNull().default(0),
    totalOrderItems: count('total_order_items').notNull().default(0),
    buyBoxPercentage: money('buy_box_percentage', 7, 6),
    loadedAt: ts('loaded_at').notNull().defaultNow(),
  },
  (t) => [index('fact_sales_traffic_daily_profile_date').on(t.profileId, t.date)],
);

export const factSqpWeekly = pgTable(
  'fact_sqp_weekly',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => adProfiles.id, { onDelete: 'cascade' }),
    weekStart: date('week_start').notNull(),
    asin: text('asin').notNull(),
    searchQuery: text('search_query').notNull(),
    /** Top 100 queries per ASIN per week: these totals are floors, never sums. */
    searchVolume: count('search_volume'),
    impressions: count('impressions'),
    impressionShare: money('impression_share', 9, 6),
    clicks: count('clicks'),
    clickShare: money('click_share', 9, 6),
    purchases: count('purchases'),
    purchaseShare: money('purchase_share', 9, 6),
    medianPrice: money('median_price'),
    loadedAt: ts('loaded_at').notNull().defaultNow(),
  },
  (t) => [index('fact_sqp_weekly_profile_week').on(t.profileId, t.weekStart)],
);

export const supaFlags = pgTable(
  'supa_flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => adProfiles.id, { onDelete: 'cascade' }),
    weekStart: date('week_start').notNull(),
    asin: text('asin').notNull(),
    searchQuery: text('search_query').notNull(),
    rule: supaRule('rule').notNull(),
    score: money('score', 12, 4),
    /** Stock is read before rank and CVR, because it causes both. */
    outOfStockDays: integer('out_of_stock_days'),
    organicRank: integer('organic_rank'),
    cvrGap: money('cvr_gap', 9, 6),
    advice: text('advice'),
    details: jsonb('details').notNull().default({}),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('supa_flags_key').on(t.profileId, t.weekStart, t.asin, t.searchQuery, t.rule)],
);

export const rankObservations = pgTable(
  'rank_observations',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').references(() => adProfiles.id, { onDelete: 'cascade' }),
    asin: text('asin').notNull(),
    keyword: text('keyword').notNull(),
    observedOn: date('observed_on').notNull(),
    organicRank: integer('organic_rank'),
    sponsoredRank: integer('sponsored_rank'),
    marketplace: text('marketplace'),
    source: text('source').notNull().default('rank_radar'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('rank_observations_lookup_idx').on(t.orgId, t.asin, t.keyword, t.observedOn)],
);

export const keepaBsrObservations = pgTable(
  'keepa_bsr_observations',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    asin: text('asin').notNull(),
    observedAt: ts('observed_at').notNull(),
    category: text('category'),
    bsr: integer('bsr'),
    price: money('price'),
    rating: money('rating', 4, 2),
    reviewCount: integer('review_count'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('keepa_bsr_observations_key').on(t.orgId, t.asin, t.category, t.observedAt)],
);

export const competitorLinks = pgTable(
  'competitor_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').references(() => adProfiles.id, { onDelete: 'cascade' }),
    ourAsin: text('our_asin').notNull(),
    competitorAsin: text('competitor_asin').notNull(),
    category: text('category'),
    proximityThreshold: money('proximity_threshold', 9, 6),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('competitor_links_key').on(t.orgId, t.ourAsin, t.competitorAsin)],
);

export const creativeAssets = pgTable(
  'creative_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').references(() => adProfiles.id, { onDelete: 'cascade' }),
    amazonAssetId: text('amazon_asset_id'),
    kind: text('kind').notNull(),
    url: text('url'),
    /** One row per asset: dedupe is the point of an asset-centric table. */
    contentHash: text('content_hash'),
    name: text('name'),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    metrics: jsonb('metrics').notNull().default({}),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('creative_assets_key').on(t.orgId, t.contentHash)],
);

export const creativePlacements = pgTable(
  'creative_placements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => creativeAssets.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').references(() => adProfiles.id, { onDelete: 'cascade' }),
    campaignId: text('campaign_id'),
    adGroupId: text('ad_group_id'),
    adId: text('ad_id'),
    state: entityState('state'),
    startedAt: ts('started_at'),
    endedAt: ts('ended_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('creative_placements_asset_idx').on(t.assetId)],
);
