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
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { count, money, ts } from './columns.js';
import { connectionStatus, entityState, queryCategory, supaRule } from './enums.js';
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

export const spapiProfileBindings = pgTable(
  'spapi_profile_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => adProfiles.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => spapiConnections.id, { onDelete: 'cascade' }),
    marketplaceId: text('marketplace_id').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('spapi_profile_bindings_one_per_profile').on(t.profileId),
    index('spapi_profile_bindings_connection_idx').on(t.connectionId, t.marketplaceId),
  ],
);

export type SpApiConnection = typeof spapiConnections.$inferSelect;
export type SpApiProfileBinding = typeof spapiProfileBindings.$inferSelect;

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
    marketplaceId: text('marketplace_id'),
    weekEnd: date('week_end').generatedAlwaysAs(sql`week_start + 6`),
    asin: text('asin').notNull(),
    searchQuery: text('search_query').notNull(),
    normalizedQuery: text('normalized_query'),
    category: queryCategory('category').notNull().default('unreviewed'),
    searchQueryScore: money('search_query_score', 16, 6),
    /** Top 100 queries per ASIN per week: these totals are floors, never sums. */
    searchVolume: count('search_volume'),
    impressions: count('impressions'),
    totalImpressions: count('total_impressions'),
    asinImpressions: count('asin_impressions'),
    impressionShare: money('impression_share', 9, 6),
    clicks: count('clicks'),
    totalClicks: count('total_clicks'),
    asinClicks: count('asin_clicks'),
    clickShare: money('click_share', 9, 6),
    totalCartAdds: count('total_cart_adds'),
    asinCartAdds: count('asin_cart_adds'),
    asinCartAddShare: money('asin_cart_add_share', 9, 6),
    purchases: count('purchases'),
    totalPurchases: count('total_purchases'),
    asinPurchases: count('asin_purchases'),
    purchaseShare: money('purchase_share', 9, 6),
    medianPrice: money('median_price'),
    loadedAt: ts('loaded_at').notNull().defaultNow(),
  },
  (t) => [
    index('fact_sqp_weekly_profile_week').on(t.profileId, t.weekStart),
    uniqueIndex('fact_sqp_weekly_normalized_grain_key')
      .on(t.profileId, t.marketplaceId, t.weekStart, t.asin, t.normalizedQuery)
      .where(sql`${t.marketplaceId} is not null and ${t.normalizedQuery} is not null`),
  ],
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
    category: text('category').notNull().default(''),
    bsr: integer('bsr'),
    price: money('price'),
    buyBoxPrice: money('buy_box_price'),
    rating: money('rating', 4, 2),
    reviewCount: integer('review_count'),
    lightningDeal: boolean('lightning_deal'),
    coupon: jsonb('coupon').$type<readonly [number, number] | null>(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('keepa_bsr_observations_key').on(t.orgId, t.asin, t.category, t.observedAt)],
);

export const COMPETITOR_PRICE_EVENT_KINDS = [
  'deal_start',
  'deal_end',
  'price_drop',
  'price_restore',
  'coupon_start',
  'coupon_end',
] as const;

export type CompetitorPriceEventKind = (typeof COMPETITOR_PRICE_EVENT_KINDS)[number];

export const competitorPriceEvents = pgTable(
  'competitor_price_events',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    asin: text('asin').notNull(),
    eventKind: text('event_kind').$type<CompetitorPriceEventKind>().notNull(),
    detectedAt: ts('detected_at').notNull(),
    price: money('price'),
    baselinePrice: money('baseline_price'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'competitor_price_events_event_kind_check',
      sql`${t.eventKind} in ('deal_start', 'deal_end', 'price_drop', 'price_restore', 'coupon_start', 'coupon_end')`,
    ),
    uniqueIndex('competitor_price_events_org_id_asin_event_kind_detected_at_key').on(
      t.orgId,
      t.asin,
      t.eventKind,
      t.detectedAt,
    ),
    index('competitor_price_events_org_asin_time_idx').on(t.orgId, t.asin, t.detectedAt),
  ],
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
    amazonCreatedAt: ts('amazon_created_at'),
    amazonUpdatedAt: ts('amazon_updated_at'),
    metrics: jsonb('metrics').notNull().default({}),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('creative_assets_profile_amazon_asset_key')
      .on(t.profileId, t.amazonAssetId)
      .where(sql`${t.profileId} is not null and ${t.amazonAssetId} is not null`),
    index('creative_assets_content_hash_idx')
      .on(t.orgId, t.contentHash)
      .where(sql`${t.contentHash} is not null`),
    uniqueIndex('creative_assets_org_profile_id_key').on(t.orgId, t.profileId, t.id),
  ],
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

export type KeepaBsrObservation = typeof keepaBsrObservations.$inferSelect;
export type NewKeepaBsrObservation = typeof keepaBsrObservations.$inferInsert;
export type CompetitorPriceEventRow = typeof competitorPriceEvents.$inferSelect;
export type NewCompetitorPriceEvent = typeof competitorPriceEvents.$inferInsert;
export type CompetitorLinkRow = typeof competitorLinks.$inferSelect;
