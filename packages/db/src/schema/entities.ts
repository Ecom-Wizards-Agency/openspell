/**
 * The entity mirror, one table per entity kind, every one keyed
 * `(profileId, amazonId)`.
 *
 * Mirrors `supabase/migrations/20260813120200_entity_mirror.sql`.
 *
 * `deletedAt` rather than a delete: a fact row from last month still points at
 * an entity that vanished from Amazon this month, and a grid that cannot name
 * the keyword it is showing spend for is worse than one showing a struck-out
 * name.
 */
import {
  bigint,
  date,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { TargetExpression } from '@wizard-ads/shared';
import { money, ts } from './columns.js';
import {
  adProduct,
  biddingStrategy,
  budgetType,
  entityChangeSource,
  entityState,
  entityType,
  matchType,
  negativeScope,
  targetingType,
} from './enums.js';
import { adProfiles, orgs } from './tenancy.js';

/** Placement uplift percentages exactly as Amazon stores them. */
export interface PlacementBiddingJson {
  topOfSearch: number | null;
  productPages: number | null;
  restOfSearch: number | null;
}

const mirrorBase = () => ({
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id')
    .notNull()
    .references(() => adProfiles.id, { onDelete: 'cascade' }),
  amazonId: text('amazon_id').notNull(),
  adProduct: adProduct('ad_product').notNull(),
  name: text('name'),
  state: entityState('state').notNull(),
  firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
  syncedAt: ts('synced_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
});

export const portfolios = pgTable(
  'portfolios',
  {
    ...mirrorBase(),
    budgetAmount: money('budget_amount', 14, 2),
    budgetPolicy: text('budget_policy'),
  },
  (t) => [uniqueIndex('portfolios_profile_id_amazon_id_key').on(t.profileId, t.amazonId)],
);

export const campaigns = pgTable(
  'campaigns',
  {
    ...mirrorBase(),
    portfolioAmazonId: text('portfolio_amazon_id'),
    budgetAmount: money('budget_amount', 14, 2).notNull(),
    budgetType: budgetType('budget_type').notNull(),
    targetingType: targetingType('targeting_type'),
    biddingStrategy: biddingStrategy('bidding_strategy'),
    placementBidding: jsonb('placement_bidding').$type<PlacementBiddingJson>(),
    startDate: date('start_date'),
    endDate: date('end_date'),
  },
  (t) => [
    uniqueIndex('campaigns_profile_id_amazon_id_key').on(t.profileId, t.amazonId),
    index('campaigns_org_profile_idx').on(t.orgId, t.profileId),
  ],
);

export const adGroups = pgTable(
  'ad_groups',
  {
    ...mirrorBase(),
    campaignId: text('campaign_id').notNull(),
    defaultBid: money('default_bid', 12, 4),
  },
  (t) => [
    uniqueIndex('ad_groups_profile_id_amazon_id_key').on(t.profileId, t.amazonId),
    index('ad_groups_campaign_idx').on(t.profileId, t.campaignId),
  ],
);

export const productAds = pgTable(
  'product_ads',
  {
    ...mirrorBase(),
    campaignId: text('campaign_id').notNull(),
    adGroupId: text('ad_group_id').notNull(),
    asin: text('asin'),
    sku: text('sku'),
  },
  (t) => [
    uniqueIndex('product_ads_profile_id_amazon_id_key').on(t.profileId, t.amazonId),
    index('product_ads_ad_group_idx').on(t.profileId, t.adGroupId),
  ],
);

export const keywords = pgTable(
  'keywords',
  {
    ...mirrorBase(),
    campaignId: text('campaign_id').notNull(),
    adGroupId: text('ad_group_id').notNull(),
    keywordText: text('keyword_text').notNull(),
    matchType: matchType('match_type').notNull(),
    bid: money('bid', 12, 4),
    /** Freshness of this field; observing a bid does not refresh the whole entity. */
    bidObservedAt: ts('bid_observed_at'),
  },
  (t) => [
    uniqueIndex('keywords_profile_id_amazon_id_key').on(t.profileId, t.amazonId),
    index('keywords_ad_group_idx').on(t.profileId, t.adGroupId),
  ],
);

export const targets = pgTable(
  'targets',
  {
    ...mirrorBase(),
    campaignId: text('campaign_id').notNull(),
    adGroupId: text('ad_group_id').notNull(),
    expression: jsonb('expression').$type<TargetExpression[]>().notNull().default([]),
    resolvedExpression: text('resolved_expression'),
    bid: money('bid', 12, 4),
  },
  (t) => [
    uniqueIndex('targets_profile_id_amazon_id_key').on(t.profileId, t.amazonId),
    index('targets_ad_group_idx').on(t.profileId, t.adGroupId),
  ],
);

export const negatives = pgTable(
  'negatives',
  {
    ...mirrorBase(),
    campaignId: text('campaign_id').notNull(),
    /** Null for a campaign-scoped negative, which is what `scope` records. */
    adGroupId: text('ad_group_id'),
    scope: negativeScope('scope').notNull(),
    keywordText: text('keyword_text'),
    expression: jsonb('expression').$type<TargetExpression[] | null>(),
    matchType: matchType('match_type').notNull(),
  },
  (t) => [
    uniqueIndex('negatives_profile_id_amazon_id_key').on(t.profileId, t.amazonId),
    index('negatives_campaign_idx').on(t.profileId, t.campaignId),
  ],
);

export const entityChanges = pgTable(
  'entity_changes',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => adProfiles.id, { onDelete: 'cascade' }),
    entityType: entityType('entity_type').notNull(),
    amazonId: text('amazon_id').notNull(),
    entityName: text('entity_name'),
    field: text('field').notNull(),
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value'),
    /** `sync` means somebody changed it outside wizard-ads. That is the point. */
    source: entityChangeSource('source').notNull(),
    applyBatchId: uuid('apply_batch_id'),
    /** Exact immutable export row this synchronization event uniquely proves. */
    applyRowId: uuid('apply_row_id'),
    observedAt: ts('observed_at').notNull().defaultNow(),
  },
  (t) => [
    index('entity_changes_profile_time_idx').on(t.profileId, t.observedAt),
    uniqueIndex('entity_changes_tenant_identity_key').on(t.orgId, t.profileId, t.id),
    uniqueIndex('entity_changes_apply_row_once_key')
      .on(t.applyRowId)
      .where(sql`${t.applyRowId} is not null`),
  ],
);

export type CampaignRowDb = typeof campaigns.$inferSelect;
export type KeywordRowDb = typeof keywords.$inferSelect;
export type TargetRowDb = typeof targets.$inferSelect;
export type EntityChangeRow = typeof entityChanges.$inferSelect;
export type NewEntityChange = typeof entityChanges.$inferInsert;
