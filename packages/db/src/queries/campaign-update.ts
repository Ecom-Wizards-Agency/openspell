/**
 * The narrow read boundary for campaign-builder UPDATE mode.
 *
 * UPDATE rows are only safe when every real Amazon id and current value comes
 * from the latest entity mirror. This loader returns the already-frozen shared
 * `EntityRow` contract, so the database package does not depend on the pure
 * campaigns engine and the web tier does not translate one duplicate snapshot
 * shape into another.
 */
import { EntityRow } from '@wizard-ads/shared';
import type { EntityRow as EntityRowValue, TargetExpression } from '@wizard-ads/shared';
import type { DbHandle } from '../client.js';

export type CampaignUpdateQueryHandle = Pick<DbHandle, 'sql'>;

export interface CampaignUpdateEntityCounts {
  campaigns: number;
  adGroups: number;
  productAds: number;
  keywords: number;
  targets: number;
  negatives: number;
}

export interface CampaignUpdateEntitySnapshot {
  entities: EntityRowValue[];
  counts: CampaignUpdateEntityCounts;
}

interface BaseRow {
  profile_id: string;
  amazon_id: string;
  name: string | null;
  state: string;
}

interface CampaignSourceRow extends BaseRow {
  portfolio_amazon_id: string | null;
  budget_amount: string | number;
  budget_type: string;
  targeting_type: string | null;
  bidding_strategy: string | null;
  placement_bidding: unknown;
  start_date: string | null;
  end_date: string | null;
}

interface AdGroupSourceRow extends BaseRow {
  campaign_id: string;
  default_bid: string | number | null;
}

interface ProductAdSourceRow extends BaseRow {
  campaign_id: string;
  ad_group_id: string;
  asin: string | null;
  sku: string | null;
}

interface KeywordSourceRow extends BaseRow {
  campaign_id: string;
  ad_group_id: string;
  keyword_text: string;
  match_type: string;
  bid: string | number | null;
}

interface TargetSourceRow extends BaseRow {
  campaign_id: string;
  ad_group_id: string;
  expression: TargetExpression[];
  resolved_expression: string | null;
  bid: string | number | null;
}

interface NegativeSourceRow extends BaseRow {
  campaign_id: string;
  ad_group_id: string | null;
  scope: string;
  keyword_text: string | null;
  expression: TargetExpression[] | null;
  match_type: string;
}

function numeric(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`entity mirror contains non-numeric value '${value}'`);
  return parsed;
}

/**
 * Load one profile's non-deleted Sponsored Products mirror.
 *
 * Both tenant predicates are mandatory. The web connection can be a service
 * role, so RLS is defense in depth rather than the source of authorization.
 * Every selected row is parsed through the shared contract and the final count
 * is asserted against the six source lists before anything reaches the engine.
 */
export async function loadCampaignUpdateEntities(
  handle: CampaignUpdateQueryHandle,
  input: { orgId: string; profileId: string },
): Promise<CampaignUpdateEntitySnapshot> {
  const [campaignRows, adGroupRows, productAdRows, keywordRows, targetRows, negativeRows] =
    await Promise.all([
      handle.sql<CampaignSourceRow[]>`
        select profile_id, amazon_id, name, state::text as state, portfolio_amazon_id,
               budget_amount, budget_type::text as budget_type,
               targeting_type::text as targeting_type,
               bidding_strategy::text as bidding_strategy, placement_bidding,
               start_date::text as start_date, end_date::text as end_date
          from public.campaigns
         where org_id = ${input.orgId} and profile_id = ${input.profileId}
           and ad_product = 'SP' and deleted_at is null
         order by amazon_id
      `,
      handle.sql<AdGroupSourceRow[]>`
        select profile_id, amazon_id, name, state::text as state, campaign_id, default_bid
          from public.ad_groups
         where org_id = ${input.orgId} and profile_id = ${input.profileId}
           and ad_product = 'SP' and deleted_at is null
         order by amazon_id
      `,
      handle.sql<ProductAdSourceRow[]>`
        select profile_id, amazon_id, name, state::text as state, campaign_id, ad_group_id,
               asin, sku
          from public.product_ads
         where org_id = ${input.orgId} and profile_id = ${input.profileId}
           and ad_product = 'SP' and deleted_at is null
         order by amazon_id
      `,
      handle.sql<KeywordSourceRow[]>`
        select profile_id, amazon_id, name, state::text as state, campaign_id, ad_group_id,
               keyword_text, match_type::text as match_type, bid
          from public.keywords
         where org_id = ${input.orgId} and profile_id = ${input.profileId}
           and ad_product = 'SP' and deleted_at is null
         order by amazon_id
      `,
      handle.sql<TargetSourceRow[]>`
        select profile_id, amazon_id, name, state::text as state, campaign_id, ad_group_id,
               expression, resolved_expression, bid
          from public.targets
         where org_id = ${input.orgId} and profile_id = ${input.profileId}
           and ad_product = 'SP' and deleted_at is null
         order by amazon_id
      `,
      handle.sql<NegativeSourceRow[]>`
        select profile_id, amazon_id, name, state::text as state, campaign_id, ad_group_id,
               scope::text as scope, keyword_text, expression, match_type::text as match_type
          from public.negatives
         where org_id = ${input.orgId} and profile_id = ${input.profileId}
           and ad_product = 'SP' and deleted_at is null
         order by amazon_id
      `,
    ]);

  const candidates: unknown[] = [
    ...campaignRows.map((row) => ({
      entityType: 'campaign',
      profileId: row.profile_id,
      amazonId: row.amazon_id,
      adProduct: 'SP',
      name: row.name,
      state: row.state,
      portfolioId: row.portfolio_amazon_id,
      budgetAmount: numeric(row.budget_amount),
      budgetType: row.budget_type,
      targetingType: row.targeting_type,
      biddingStrategy: row.bidding_strategy,
      placementBidding: row.placement_bidding,
      startDate: row.start_date,
      endDate: row.end_date,
    })),
    ...adGroupRows.map((row) => ({
      entityType: 'ad_group',
      profileId: row.profile_id,
      amazonId: row.amazon_id,
      adProduct: 'SP',
      name: row.name,
      state: row.state,
      campaignId: row.campaign_id,
      defaultBid: numeric(row.default_bid),
    })),
    ...productAdRows.map((row) => ({
      entityType: 'product_ad',
      profileId: row.profile_id,
      amazonId: row.amazon_id,
      adProduct: 'SP',
      name: row.name,
      state: row.state,
      campaignId: row.campaign_id,
      adGroupId: row.ad_group_id,
      asin: row.asin,
      sku: row.sku,
    })),
    ...keywordRows.map((row) => ({
      entityType: 'keyword',
      profileId: row.profile_id,
      amazonId: row.amazon_id,
      adProduct: 'SP',
      name: row.name,
      state: row.state,
      campaignId: row.campaign_id,
      adGroupId: row.ad_group_id,
      keywordText: row.keyword_text,
      matchType: row.match_type,
      bid: numeric(row.bid),
    })),
    ...targetRows.map((row) => ({
      entityType: 'target',
      profileId: row.profile_id,
      amazonId: row.amazon_id,
      adProduct: 'SP',
      name: row.name,
      state: row.state,
      campaignId: row.campaign_id,
      adGroupId: row.ad_group_id,
      expression: row.expression,
      resolvedExpression: row.resolved_expression,
      bid: numeric(row.bid),
    })),
    ...negativeRows.map((row) => ({
      entityType: 'negative',
      profileId: row.profile_id,
      amazonId: row.amazon_id,
      adProduct: 'SP',
      name: row.name,
      state: row.state,
      campaignId: row.campaign_id,
      adGroupId: row.ad_group_id,
      scope: row.scope,
      keywordText: row.keyword_text,
      expression: row.expression,
      matchType: row.match_type,
    })),
  ];

  const entities = EntityRow.array().parse(candidates);
  const counts: CampaignUpdateEntityCounts = {
    campaigns: campaignRows.length,
    adGroups: adGroupRows.length,
    productAds: productAdRows.length,
    keywords: keywordRows.length,
    targets: targetRows.length,
    negatives: negativeRows.length,
  };
  const listed = Object.values(counts).reduce((total, count) => total + count, 0);
  if (entities.length !== listed) {
    throw new Error(
      `campaign UPDATE mirror: selected ${listed} rows, returned ${entities.length}`,
    );
  }
  return { entities, counts };
}
