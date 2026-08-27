/**
 * The bid corridor's reads, for the per-target history modal (WP-28/WP-48).
 *
 * The corridor is a per-target daily series (`bid_series_daily`), synced by the
 * worker from Amazon's suggested-bid endpoints. This module turns it into the
 * `BidCorridorPoint[]` the chart plots, and combines it with target identity
 * and same-window KPI bases for the asynchronous row-level drill-down.
 *
 * Every read takes the actor's `orgId` alongside the profile id and puts both in
 * the predicate — defence in depth, since the web tier connects as the service
 * role and "already checked upstream" is the only lock this layer has.
 */
import type { DbHandle } from '@wizard-ads/db';
import type { BaseTotals } from '@wizard-ads/ui';
import type { BidCorridorPoint } from '../../src/ui/viz';

/** One target's corridor over the window, oldest first, as chart points. */
export async function loadCorridor(
  handle: Pick<DbHandle, 'sql'>,
  orgId: string,
  profileId: string,
  targetId: string,
  window: { from: string; to: string },
): Promise<BidCorridorPoint[]> {
  const rows = await handle.sql<
    {
      date: string;
      suggested_bid_low: string | number | null;
      suggested_bid_median: string | number | null;
      suggested_bid_high: string | number | null;
      bid: string | number | null;
      cpc: string | number | null;
      max_potential_cpc: string | number | null;
      modifier_components: Array<{ name: string; pct: number }> | null;
    }[]
  >`
    select date::text as date,
           suggested_bid_low,
           suggested_bid_median,
           suggested_bid_high,
           bid,
           cpc,
           max_potential_cpc,
           modifier_components
      from public.bid_series_daily
     where org_id = ${orgId}
       and profile_id = ${profileId}
       and target_id = ${targetId}
       and date between ${window.from} and ${window.to}
     order by date
  `;
  const nullableNumber = (value: string | number | null): number | null =>
    value === null ? null : Number(value);
  return rows.map((row) => ({
    date: row.date,
    low: nullableNumber(row.suggested_bid_low),
    median: nullableNumber(row.suggested_bid_median),
    high: nullableNumber(row.suggested_bid_high),
    bid: nullableNumber(row.bid),
    cpc: nullableNumber(row.cpc),
    maxCpc: nullableNumber(row.max_potential_cpc),
    components: row.modifier_components ?? [],
  }));
}

export interface BidHistoryTarget {
  targetId: string;
  targeting: string;
  matchType: string | null;
  adProduct: string;
  targetKind: string;
  campaignId: string;
  campaignName: string;
}

export interface BidHistoryPayload {
  target: BidHistoryTarget;
  window: { from: string; to: string };
  totals: BaseTotals;
  points: BidCorridorPoint[];
}

/** One actor-scoped payload for the asynchronous per-target modal. */
export async function loadBidHistory(
  handle: Pick<DbHandle, 'sql'>,
  args: {
    orgId: string;
    profileId: string;
    targetId: string;
    from: string;
    to: string;
  },
): Promise<BidHistoryPayload | null> {
  const [targets, totalsRows, points] = await Promise.all([
    handle.sql<
      {
        target_id: string;
        targeting: string;
        match_type: string | null;
        ad_product: string;
        target_kind: string;
        campaign_id: string;
        campaign_name: string;
      }[]
    >`
      with target_entity as (
        select k.amazon_id as target_id,
               coalesce(k.keyword_text, k.name, k.amazon_id) as targeting,
               k.match_type::text as match_type,
               k.ad_product::text as ad_product,
               'keyword'::text as target_kind,
               k.campaign_id
          from public.keywords k
         where k.org_id = ${args.orgId}
           and k.profile_id = ${args.profileId}
           and k.amazon_id = ${args.targetId}
        union all
        select t.amazon_id as target_id,
               coalesce(t.resolved_expression, t.name, t.amazon_id) as targeting,
               null::text as match_type,
               t.ad_product::text as ad_product,
               'product target'::text as target_kind,
               t.campaign_id
          from public.targets t
         where t.org_id = ${args.orgId}
           and t.profile_id = ${args.profileId}
           and t.amazon_id = ${args.targetId}
        union all
        select f.target_id,
               f.target_id as targeting,
               max(f.match_type::text) as match_type,
               max(f.ad_product::text) as ad_product,
               replace(max(f.target_kind::text), '_', ' ') as target_kind,
               max(f.campaign_id) as campaign_id
          from public.fact_sp_target_daily f
         where f.org_id = ${args.orgId}
           and f.profile_id = ${args.profileId}
           and f.target_id = ${args.targetId}
           and not exists (
             select 1 from public.keywords k
              where k.org_id = ${args.orgId}
                and k.profile_id = ${args.profileId}
                and k.amazon_id = f.target_id
           )
           and not exists (
             select 1 from public.targets t
              where t.org_id = ${args.orgId}
                and t.profile_id = ${args.profileId}
                and t.amazon_id = f.target_id
           )
         group by f.target_id
      )
      select e.target_id,
             e.targeting,
             e.match_type,
             e.ad_product,
             e.target_kind,
             e.campaign_id,
             coalesce(c.name, e.campaign_id) as campaign_name
        from target_entity e
        left join public.campaigns c
          on c.org_id = ${args.orgId}
         and c.profile_id = ${args.profileId}
         and c.amazon_id = e.campaign_id
       limit 1
    `,
    handle.sql<
      {
        impressions: string | number;
        clicks: string | number;
        spend: string | number;
        sales: string | number;
        orders: string | number;
        units: string | number;
      }[]
    >`
      select coalesce(sum(impressions), 0) as impressions,
             coalesce(sum(clicks), 0) as clicks,
             coalesce(sum(cost), 0) as spend,
             coalesce(sum(sales_7d), 0) as sales,
             coalesce(sum(purchases_7d), 0) as orders,
             coalesce(sum(units_sold_7d), 0) as units
        from public.fact_sp_target_daily
       where org_id = ${args.orgId}
         and profile_id = ${args.profileId}
         and target_id = ${args.targetId}
         and date between ${args.from} and ${args.to}
    `,
    loadCorridor(handle, args.orgId, args.profileId, args.targetId, {
      from: args.from,
      to: args.to,
    }),
  ]);

  const target = targets[0];
  if (target === undefined) return null;
  const row = totalsRows[0];
  const number = (value: string | number | undefined): number => Number(value ?? 0);
  return {
    target: {
      targetId: target.target_id,
      targeting: target.targeting,
      matchType: target.match_type,
      adProduct: target.ad_product,
      targetKind: target.target_kind,
      campaignId: target.campaign_id,
      campaignName: target.campaign_name,
    },
    window: { from: args.from, to: args.to },
    totals: {
      impressions: number(row?.impressions),
      clicks: number(row?.clicks),
      spend: number(row?.spend),
      sales: number(row?.sales),
      orders: number(row?.orders),
      units: number(row?.units),
    },
    points,
  };
}
