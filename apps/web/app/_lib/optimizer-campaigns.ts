import type { DbHandle } from '@wizard-ads/db';
import type { Period } from './periods';
import { withServerTiming } from './server-timing';

export interface OptimizerCampaignFactRow {
  campaignId: string;
  name: string;
  adProduct: string;
  state: string;
  dailyBudget: number | null;
  biddingStrategy: string | null;
  startDate: string | null;
  groupId: string | null;
  currentRows: number;
  impressions: number;
  clicks: number;
  spend: number;
  sales: number;
  orders: number;
  comparisonRows: number;
  comparisonSpend: number;
}

interface CampaignWireRow {
  campaign_id: string;
  campaign_name: string;
  ad_product: string;
  campaign_state: string;
  daily_budget: string | number | null;
  bidding_strategy: string | null;
  start_date: string | null;
  group_id: string | null;
  current_rows: string | number | null;
  impressions: string | number | null;
  clicks: string | number | null;
  spend: string | number | null;
  sales: string | number | null;
  orders: string | number | null;
  comparison_rows: string | number | null;
  comparison_spend: string | number | null;
}

/**
 * Every current campaign, with SP/SB/SD evidence for the selected and comparison windows.
 * The entity mirror drives row membership, so a campaign with no activity is still visible.
 */
export async function loadOptimizerCampaignFacts(
  handle: Pick<DbHandle, 'sql'>,
  input: {
    orgId: string;
    profileId: string;
    period: Period;
    comparison: Period;
  },
): Promise<OptimizerCampaignFactRow[]> {
  return withServerTiming('optimizer.campaign_facts', async () => {
    const rows = await handle.sql<CampaignWireRow[]>`
    with source_performance as (
      select campaign_id, ad_product::text as ad_product,
             ${windowSums(handle, input.period, input.comparison)}
        from public.fact_sp_target_daily
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
         and date between ${input.comparison.start} and ${input.period.end}
       group by campaign_id, ad_product
      union all
      select campaign_id, 'SB',
             ${windowSums(handle, input.period, input.comparison)}
        from public.fact_sb_daily
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
         and date between ${input.comparison.start} and ${input.period.end}
       group by campaign_id
      union all
      select campaign_id, 'SD',
             ${windowSums(handle, input.period, input.comparison)}
        from public.fact_sd_daily
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
         and date between ${input.comparison.start} and ${input.period.end}
       group by campaign_id
    ), performance as (
      select campaign_id, ad_product,
             sum(current_rows) as current_rows,
             sum(impressions) as impressions,
             sum(clicks) as clicks,
             sum(spend) as spend,
             sum(sales) as sales,
             sum(orders) as orders,
             sum(comparison_rows) as comparison_rows,
             sum(comparison_spend) as comparison_spend
        from source_performance
       group by campaign_id, ad_product
    )
    select c.amazon_id as campaign_id, c.name as campaign_name,
           c.ad_product::text as ad_product,
           case when c.deleted_at is null then c.state::text else 'deleted' end as campaign_state,
           c.budget_amount as daily_budget, c.bidding_strategy::text as bidding_strategy,
           c.start_date::text as start_date, assignment.group_id,
           coalesce(performance.current_rows, 0) as current_rows,
           coalesce(performance.impressions, 0) as impressions,
           coalesce(performance.clicks, 0) as clicks,
           coalesce(performance.spend, 0) as spend,
           coalesce(performance.sales, 0) as sales,
           coalesce(performance.orders, 0) as orders,
           coalesce(performance.comparison_rows, 0) as comparison_rows,
           coalesce(performance.comparison_spend, 0) as comparison_spend
      from public.campaigns c
      left join performance
        on performance.campaign_id = c.amazon_id
       and performance.ad_product = c.ad_product::text
      left join public.campaign_optimization_assignments assignment
        on assignment.org_id = ${input.orgId}
       and assignment.profile_id = ${input.profileId}
       and assignment.campaign_id = c.amazon_id
     where c.org_id = ${input.orgId}
       and c.profile_id = ${input.profileId}
       and c.deleted_at is null
     order by coalesce(performance.spend, 0) desc, lower(c.name), c.amazon_id
    `;

    return rows.map((row) => ({
      campaignId: row.campaign_id,
      name: row.campaign_name,
      adProduct: row.ad_product,
      state: row.campaign_state,
      dailyBudget: nullableNumber(row.daily_budget),
      biddingStrategy: row.bidding_strategy,
      startDate: row.start_date,
      groupId: row.group_id,
      currentRows: number(row.current_rows),
      impressions: number(row.impressions),
      clicks: number(row.clicks),
      spend: number(row.spend),
      sales: number(row.sales),
      orders: number(row.orders),
      comparisonRows: number(row.comparison_rows),
      comparisonSpend: number(row.comparison_spend),
    }));
  }, (rows) => rows.length);
}

function windowSums(handle: Pick<DbHandle, 'sql'>, period: Period, comparison: Period) {
  const { sql } = handle;
  return sql`
    count(*) filter (where date between ${period.start} and ${period.end}) as current_rows,
    sum(impressions) filter (where date between ${period.start} and ${period.end}) as impressions,
    sum(clicks) filter (where date between ${period.start} and ${period.end}) as clicks,
    sum(cost) filter (where date between ${period.start} and ${period.end}) as spend,
    sum(sales_7d) filter (where date between ${period.start} and ${period.end}) as sales,
    sum(purchases_7d) filter (where date between ${period.start} and ${period.end}) as orders,
    count(*) filter (where date between ${comparison.start} and ${comparison.end}) as comparison_rows,
    sum(cost) filter (where date between ${comparison.start} and ${comparison.end}) as comparison_spend
  `;
}

function number(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
