/**
 * Grid rows, per entity level, straight out of the fact tables.
 *
 * Three things this module does deliberately:
 *
 * 1. **Selected period and comparison period in one query.** `filter (where
 *    date between ...)` aggregates both windows in a single pass over a single
 *    index range, so a grid with deltas costs one round trip rather than two,
 *    and the two windows can never be read from different snapshots.
 *
 * 2. **It sums bases and nothing else.** No `avg(acos)` appears anywhere in this
 *    file, and there is nowhere for one to hide: the SQL returns
 *    impressions/clicks/spend/sales/orders/units and the ratios are computed in
 *    `@wizard-ads/ui` from those sums, at whatever level is being displayed.
 *    This is the same rule the recon says to clone (`02-data-grid.md` §4), held
 *    at the query layer as well as the render layer.
 *
 * 3. **`c_days = 0` means no comparison row, not a zero one.** An entity that
 *    did not serve last month did not spend nothing; it has no figure. The
 *    difference is what makes a delta honest, and it survives all the way to
 *    the cell, which renders `—`.
 *
 * Read-only. Every write in this product happens in the worker.
 */
import { classifyCampaignCategory } from '@wizard-ads/core';
import { readLatestBidSeriesByTargetIds } from '@wizard-ads/db';
import type { DbHandle } from '@wizard-ads/db';
import type { EntityLevel, GridRow } from '@wizard-ads/ui';
import type { Period } from './periods.js';

interface AggregateRow {
  impressions: string | number | null;
  clicks: string | number | null;
  spend: string | number | null;
  sales: string | number | null;
  orders: string | number | null;
  units: string | number | null;
  c_days: string | number | null;
  c_impressions: string | number | null;
  c_clicks: string | number | null;
  c_spend: string | number | null;
  c_sales: string | number | null;
  c_orders: string | number | null;
  c_units: string | number | null;
}

/** Postgres returns numeric and bigint as strings. One conversion, one place. */
const num = (value: string | number | null | undefined): number => {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : Number(value);
};

function totalsOf(row: AggregateRow): GridRow['totals'] {
  return {
    impressions: num(row.impressions),
    clicks: num(row.clicks),
    spend: num(row.spend),
    sales: num(row.sales),
    orders: num(row.orders),
    units: num(row.units),
  };
}

function comparisonOf(row: AggregateRow): GridRow['comparison'] {
  if (num(row.c_days) === 0) return null;
  return {
    impressions: num(row.c_impressions),
    clicks: num(row.c_clicks),
    spend: num(row.c_spend),
    sales: num(row.c_sales),
    orders: num(row.c_orders),
    units: num(row.c_units),
  };
}

export interface LoadGridOptions {
  /**
   * The actor's org. Required, and in the predicate of every statement below:
   * the web tier connects as the service role, so a query scoped only by a
   * profile id is scoped only by a uuid nobody checked.
   */
  orgId: string;
  profileId: string;
  currencyCode: string;
  period: Period;
  comparison: Period;
  /**
   * Hard cap on rows returned. The grid holds the whole set in memory with no
   * pagination, which is the point (`02-data-grid.md` §6) -- but "no pagination"
   * has to mean "50k rows", not "however many the account has". Past the cap the
   * page says so rather than silently truncating.
   */
  limit?: number;
}

export const ROW_CAP = 50_000;

export interface GridPayload {
  rows: GridRow[];
  /** True when the cap was hit and the set on screen is not the whole account. */
  truncated: boolean;
}

export async function loadGridRows(
  handle: DbHandle,
  level: EntityLevel,
  options: LoadGridOptions,
): Promise<GridPayload> {
  const limit = options.limit ?? ROW_CAP;
  const loaders: Record<EntityLevel, () => Promise<GridRow[]>> = {
    campaigns: () => loadCampaigns(handle, options, limit),
    ad_groups: () => loadAdGroups(handle, options, limit),
    targets: () => loadTargets(handle, options, limit),
    search_terms: () => loadSearchTerms(handle, options, limit),
    placements: () => loadPlacements(handle, options, limit),
  };
  const rows = await loaders[level]();
  return { rows, truncated: rows.length >= limit };
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

interface CampaignRow extends AggregateRow {
  campaign_id: string;
  ad_product: string;
  campaign_name: string | null;
  campaign_state: string | null;
  targeting_type: string | null;
  bidding_strategy: string | null;
  budget_amount: string | number | null;
  budget_type: string | null;
  portfolio_name: string | null;
  start_date: string | null;
  end_date: string | null;
  is_ended: boolean | null;
}

async function loadCampaigns(
  handle: DbHandle,
  options: LoadGridOptions,
  limit: number,
): Promise<GridRow[]> {
  const { orgId, profileId, period, comparison } = options;
  const rows = await handle.sql<CampaignRow[]>`
    with facts as (
      select campaign_id, ad_product,
             ${windowSums(handle, period, comparison)}
      from public.fact_sp_target_daily
      where org_id = ${orgId} and profile_id = ${profileId}
        and date between ${comparison.start} and ${period.end}
      group by campaign_id, ad_product
    )
    select f.*,
           c.name as campaign_name,
           c.state::text as campaign_state,
           c.targeting_type::text as targeting_type,
           c.bidding_strategy::text as bidding_strategy,
           c.budget_amount, c.budget_type::text as budget_type,
           p.name as portfolio_name,
           c.start_date::text as start_date,
           c.end_date::text as end_date,
           -- Computed, not stored: an ended campaign cannot take a budget or a
           -- bid update even while its state still reads Enabled, and the grid
           -- has to say so before somebody queues a write against it.
           (c.end_date is not null and c.end_date < (now() at time zone coalesce(pr.timezone, 'UTC'))::date) as is_ended
      from facts f
      left join public.campaigns c
        on c.org_id = ${orgId} and c.profile_id = ${profileId} and c.amazon_id = f.campaign_id
      left join public.portfolios p
        on p.org_id = ${orgId} and p.profile_id = ${profileId}
       and p.amazon_id = c.portfolio_amazon_id
      left join public.ad_profiles pr on pr.id = ${profileId} and pr.org_id = ${orgId}
     limit ${limit}
  `;

  return rows.map((row) => ({
    id: `campaign:${row.campaign_id}`,
    dimensions: {
      campaign_id: row.campaign_id,
      campaign_name: row.campaign_name ?? row.campaign_id,
      campaign_state: row.campaign_state,
      ad_product: row.ad_product,
      targeting_type: row.targeting_type,
      bidding_strategy: row.bidding_strategy,
      budget_amount: row.budget_amount === null ? null : num(row.budget_amount),
      budget_type: row.budget_type,
      portfolio_name: row.portfolio_name,
      start_date: row.start_date,
      end_date: row.end_date,
      is_ended: row.is_ended ?? false,
    },
    totals: totalsOf(row),
    comparison: comparisonOf(row),
    currencyCode: options.currencyCode,
  }));
}

// ---------------------------------------------------------------------------
// Ad groups
// ---------------------------------------------------------------------------

interface AdGroupRow extends AggregateRow {
  campaign_id: string;
  ad_group_id: string;
  ad_product: string;
  ad_group_name: string | null;
  ad_group_state: string | null;
  default_bid: string | number | null;
  campaign_name: string | null;
}

async function loadAdGroups(
  handle: DbHandle,
  options: LoadGridOptions,
  limit: number,
): Promise<GridRow[]> {
  const { orgId, profileId, period, comparison } = options;
  const rows = await handle.sql<AdGroupRow[]>`
    with facts as (
      select campaign_id, ad_group_id, ad_product,
             ${windowSums(handle, period, comparison)}
      from public.fact_sp_target_daily
      where org_id = ${orgId} and profile_id = ${profileId}
        and date between ${comparison.start} and ${period.end}
      group by campaign_id, ad_group_id, ad_product
    )
    select f.*,
           g.name as ad_group_name,
           g.state::text as ad_group_state,
           g.default_bid,
           c.name as campaign_name
      from facts f
      left join public.ad_groups g
        on g.org_id = ${orgId} and g.profile_id = ${profileId} and g.amazon_id = f.ad_group_id
      left join public.campaigns c
        on c.org_id = ${orgId} and c.profile_id = ${profileId} and c.amazon_id = f.campaign_id
     limit ${limit}
  `;

  return rows.map((row) => ({
    id: `ad_group:${row.ad_group_id}`,
    dimensions: {
      ad_group_id: row.ad_group_id,
      ad_group_name: row.ad_group_name ?? row.ad_group_id,
      ad_group_state: row.ad_group_state,
      campaign_id: row.campaign_id,
      campaign_name: row.campaign_name ?? row.campaign_id,
      default_bid: row.default_bid === null ? null : num(row.default_bid),
      ad_product: row.ad_product,
    },
    totals: totalsOf(row),
    comparison: comparisonOf(row),
    currencyCode: options.currencyCode,
  }));
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

interface TargetRow extends AggregateRow {
  campaign_id: string;
  ad_group_id: string;
  target_id: string;
  target_kind: string;
  match_type: string | null;
  ad_product: string;
  targeting: string | null;
  target_state: string | null;
  bid: string | number | null;
  ad_group_name: string | null;
  campaign_name: string | null;
}

async function loadTargets(
  handle: DbHandle,
  options: LoadGridOptions,
  limit: number,
): Promise<GridRow[]> {
  const { orgId, profileId, period, comparison } = options;
  const rows = await handle.sql<TargetRow[]>`
    with facts as (
      select campaign_id, ad_group_id, target_id, target_kind::text as target_kind,
             max(match_type::text) as match_type, ad_product,
             ${windowSums(handle, period, comparison)}
      from public.fact_sp_target_daily
      where org_id = ${orgId} and profile_id = ${profileId}
        and date between ${comparison.start} and ${period.end}
      group by campaign_id, ad_group_id, target_id, target_kind, ad_product
    )
    select f.*,
           -- One column for "what is being targeted", whether it is a keyword
           -- or a product target. Two nouns three characters apart is exactly
           -- what the recon says not to ship.
           coalesce(k.keyword_text, t.resolved_expression, t.name, k.name) as targeting,
           coalesce(k.state::text, t.state::text) as target_state,
           coalesce(k.bid, t.bid) as bid,
           g.name as ad_group_name,
           c.name as campaign_name
      from facts f
      left join public.keywords k
        on k.org_id = ${orgId} and k.profile_id = ${profileId} and k.amazon_id = f.target_id
      left join public.targets t
        on t.org_id = ${orgId} and t.profile_id = ${profileId} and t.amazon_id = f.target_id
      left join public.ad_groups g
        on g.org_id = ${orgId} and g.profile_id = ${profileId} and g.amazon_id = f.ad_group_id
      left join public.campaigns c
        on c.org_id = ${orgId} and c.profile_id = ${profileId} and c.amazon_id = f.campaign_id
     limit ${limit}
  `;

  const latest = await readLatestBidSeriesByTargetIds(handle, {
    orgId,
    profileId,
    targetIds: rows.map((row) => row.target_id),
  });
  const latestByTarget = new Map(latest.map((row) => [row.targetId, row]));

  return rows.map((row) => {
    const series = latestByTarget.get(row.target_id);
    const bid = row.bid === null ? null : num(row.bid);
    const suggestedBid = series?.suggestedBidMedian ?? null;
    const suggestedBidLow = series?.suggestedBidLow ?? null;
    const suggestedBidHigh = series?.suggestedBidHigh ?? null;
    return {
      id: `target:${row.target_id}`,
      dimensions: {
        target_id: row.target_id,
        targeting: row.targeting ?? row.target_id,
        target_state: row.target_state,
        target_kind: row.target_kind,
        match_type: row.match_type,
        bid,
        suggested_bid: suggestedBid,
        suggested_bid_low: suggestedBidLow,
        suggested_bid_high: suggestedBidHigh,
        bid_corridor_position: bidCorridorPosition(bid, suggestedBidLow, suggestedBidHigh),
        max_potential_cpc: series?.maxPotentialCpc ?? null,
        diff_from_suggested_bid:
          bid === null || suggestedBid === null ? null : bid - suggestedBid,
        ad_group_name: row.ad_group_name ?? row.ad_group_id,
        campaign_name: row.campaign_name ?? row.campaign_id,
        rpc_category: classifyCampaignCategory(row.campaign_name),
        ad_product: row.ad_product,
      },
      totals: totalsOf(row),
      comparison: comparisonOf(row),
      currencyCode: options.currencyCode,
    };
  });
}

function bidCorridorPosition(
  bid: number | null,
  low: number | null,
  high: number | null,
): 'Below range' | 'Within range' | 'Above range' | 'Unavailable' {
  if (bid === null || low === null || high === null) return 'Unavailable';
  if (bid < low) return 'Below range';
  if (bid > high) return 'Above range';
  return 'Within range';
}

// ---------------------------------------------------------------------------
// Search terms
// ---------------------------------------------------------------------------

interface SearchTermRow extends AggregateRow {
  search_term: string;
  campaign_id: string;
  ad_group_id: string;
  target_id: string | null;
  match_type: string | null;
  ad_product: string;
  targeting: string | null;
  ad_group_name: string | null;
  campaign_name: string | null;
  harvested: boolean;
}

async function loadSearchTerms(
  handle: DbHandle,
  options: LoadGridOptions,
  limit: number,
): Promise<GridRow[]> {
  const { orgId, profileId, period, comparison } = options;
  const rows = await handle.sql<SearchTermRow[]>`
    with facts as (
      select search_term, campaign_id, ad_group_id, target_id,
             max(match_type::text) as match_type, ad_product,
             ${windowSums(handle, period, comparison)}
      from public.fact_search_term_daily
      where org_id = ${orgId} and profile_id = ${profileId}
        and date between ${comparison.start} and ${period.end}
      group by search_term, campaign_id, ad_group_id, target_id, ad_product
    ), harvested_terms as materialized (
      -- Build the profile vocabulary once. A correlated EXISTS with
      -- lower(keyword_text) makes Postgres revisit the current keyword mirror
      -- for every aggregated search-term row; on an operator-sized account
      -- that becomes the cold route's dominant work.
      select lower(keyword_text) as normalized_term
        from public.keywords
       where org_id = ${orgId}
         and profile_id = ${profileId}
         and deleted_at is null
         and keyword_text is not null
       group by lower(keyword_text)
    )
    select f.*,
           k.keyword_text as targeting,
           g.name as ad_group_name,
           c.name as campaign_name,
           -- "Have I already acted on this row." Without it an operator
           -- re-harvests the same winners every week.
           (harvested.normalized_term is not null) as harvested
      from facts f
      left join public.keywords k
        on k.org_id = ${orgId} and k.profile_id = ${profileId} and k.amazon_id = f.target_id
      left join public.ad_groups g
        on g.org_id = ${orgId} and g.profile_id = ${profileId} and g.amazon_id = f.ad_group_id
      left join public.campaigns c
        on c.org_id = ${orgId} and c.profile_id = ${profileId} and c.amazon_id = f.campaign_id
      left join harvested_terms harvested
        on harvested.normalized_term = lower(f.search_term)
     limit ${limit}
  `;

  return rows.map((row) => ({
    id: `st:${row.campaign_id}:${row.ad_group_id}:${row.target_id ?? '-'}:${row.search_term}`,
    dimensions: {
      search_term: row.search_term,
      targeting: row.targeting,
      match_type: row.match_type,
      ad_group_name: row.ad_group_name ?? row.ad_group_id,
      campaign_name: row.campaign_name ?? row.campaign_id,
      harvested: row.harvested,
      ad_product: row.ad_product,
    },
    totals: totalsOf(row),
    comparison: comparisonOf(row),
    currencyCode: options.currencyCode,
  }));
}

// ---------------------------------------------------------------------------
// Placements
// ---------------------------------------------------------------------------

interface PlacementRow extends AggregateRow {
  campaign_id: string;
  placement: string;
  ad_product: string;
  campaign_name: string | null;
  placement_bidding: { topOfSearch: number | null; productPages: number | null; restOfSearch: number | null } | null;
}

const MODIFIER_KEY: Record<string, 'topOfSearch' | 'productPages' | 'restOfSearch'> = {
  top_of_search: 'topOfSearch',
  product_pages: 'productPages',
  rest_of_search: 'restOfSearch',
};

async function loadPlacements(
  handle: DbHandle,
  options: LoadGridOptions,
  limit: number,
): Promise<GridRow[]> {
  const { orgId, profileId, period, comparison } = options;
  const rows = await handle.sql<PlacementRow[]>`
    with facts as (
      select campaign_id, placement::text as placement, ad_product,
             sum(impressions) filter (where date between ${period.start} and ${period.end}) as impressions,
             sum(clicks)      filter (where date between ${period.start} and ${period.end}) as clicks,
             sum(cost)        filter (where date between ${period.start} and ${period.end}) as spend,
             sum(sales_7d)    filter (where date between ${period.start} and ${period.end}) as sales,
             sum(purchases_7d) filter (where date between ${period.start} and ${period.end}) as orders,
             0 as units,
             count(*)         filter (where date between ${comparison.start} and ${comparison.end}) as c_days,
             sum(impressions) filter (where date between ${comparison.start} and ${comparison.end}) as c_impressions,
             sum(clicks)      filter (where date between ${comparison.start} and ${comparison.end}) as c_clicks,
             sum(cost)        filter (where date between ${comparison.start} and ${comparison.end}) as c_spend,
             sum(sales_7d)    filter (where date between ${comparison.start} and ${comparison.end}) as c_sales,
             sum(purchases_7d) filter (where date between ${comparison.start} and ${comparison.end}) as c_orders,
             0 as c_units
      from public.fact_placement_daily
      where org_id = ${orgId} and profile_id = ${profileId}
        and date between ${comparison.start} and ${period.end}
      group by campaign_id, placement, ad_product
    )
    select f.*, c.name as campaign_name, c.placement_bidding
      from facts f
      left join public.campaigns c
        on c.org_id = ${orgId} and c.profile_id = ${profileId} and c.amazon_id = f.campaign_id
     limit ${limit}
  `;

  return rows.map((row) => {
    const key = MODIFIER_KEY[row.placement];
    const modifier = key === undefined ? null : (row.placement_bidding?.[key] ?? null);
    return {
      id: `placement:${row.campaign_id}:${row.placement}`,
      dimensions: {
        placement: row.placement,
        campaign_id: row.campaign_id,
        campaign_name: row.campaign_name ?? row.campaign_id,
        // Amazon stores the modifier as a whole percent; the grid renders
        // percents from fractions, so the conversion happens once, here.
        placement_modifier: modifier === null ? null : modifier / 100,
        ad_product: row.ad_product,
      },
      totals: totalsOf(row),
      comparison: comparisonOf(row),
      currencyCode: options.currencyCode,
    };
  });
}

// ---------------------------------------------------------------------------

/**
 * The two-window sum block shared by every target-grain query.
 *
 * `count(*) filter (...)` on the comparison window is what distinguishes "spent
 * nothing" from "has no comparison row": zero days means no row, and the caller
 * turns that into a null comparison rather than a zeroed one.
 */
function windowSums(handle: DbHandle, period: Period, comparison: Period) {
  const { sql } = handle;
  return sql`
    sum(impressions) filter (where date between ${period.start} and ${period.end}) as impressions,
    sum(clicks)      filter (where date between ${period.start} and ${period.end}) as clicks,
    sum(cost)        filter (where date between ${period.start} and ${period.end}) as spend,
    sum(sales_7d)    filter (where date between ${period.start} and ${period.end}) as sales,
    sum(purchases_7d) filter (where date between ${period.start} and ${period.end}) as orders,
    sum(units_sold_7d) filter (where date between ${period.start} and ${period.end}) as units,
    count(*)         filter (where date between ${comparison.start} and ${comparison.end}) as c_days,
    sum(impressions) filter (where date between ${comparison.start} and ${comparison.end}) as c_impressions,
    sum(clicks)      filter (where date between ${comparison.start} and ${comparison.end}) as c_clicks,
    sum(cost)        filter (where date between ${comparison.start} and ${comparison.end}) as c_spend,
    sum(sales_7d)    filter (where date between ${comparison.start} and ${comparison.end}) as c_sales,
    sum(purchases_7d) filter (where date between ${comparison.start} and ${comparison.end}) as c_orders,
    sum(units_sold_7d) filter (where date between ${comparison.start} and ${comparison.end}) as c_units
  `;
}
