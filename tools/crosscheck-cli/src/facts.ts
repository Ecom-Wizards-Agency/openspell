/**
 * Our side of the comparison, read straight out of the fact tables.
 *
 * The queries live here rather than in `packages/db` on purpose: WP-01 owns
 * that package, and a crosscheck that needs a schema change to run is a
 * crosscheck nobody runs. They are raw SQL for the same reason the loaders are
 * — numerics come back from the driver as strings and every one of them is
 * converted explicitly, because `"10.80" + "9.20"` is a data-quality incident
 * with a plausible-looking output.
 *
 * The campaign aggregate unions the three ad products rather than reading a
 * campaign-grain table, because there is no campaign-grain table: SP spend
 * lives on targets, SB and SD on their own dailies. Summing targets to a
 * campaign is exactly what the grid does, so a disagreement here is a real
 * disagreement and not an artefact of a different roll-up.
 */
import type { DbHandle } from '@wizard-ads/db';
import type { OurCampaignTotals, OurProfileDay } from './compare.js';

export interface ProfileIdentity {
  profileId: string;
  orgId: string;
  amazonProfileId: string;
  region: string;
  currencyCode: string;
  timezone: string;
  accountLabel: string | null;
}

export class ProfileNotFound extends Error {
  constructor(profileId: string) {
    super(`no ad_profiles row for ${profileId}`);
    this.name = 'ProfileNotFound';
  }
}

export async function readProfile(handle: DbHandle, profileId: string): Promise<ProfileIdentity> {
  const rows = await handle.sql<
    {
      id: string;
      org_id: string;
      amazon_profile_id: string;
      region: string;
      currency_code: string;
      timezone: string;
      account_name: string | null;
    }[]
  >`
    select id, org_id, amazon_profile_id, region::text as region, currency_code, timezone, account_name
    from public.ad_profiles
    where id = ${profileId}
  `;
  const row = rows[0];
  if (!row) throw new ProfileNotFound(profileId);
  return {
    profileId: row.id,
    orgId: row.org_id,
    amazonProfileId: row.amazon_profile_id,
    region: row.region,
    currencyCode: row.currency_code,
    timezone: row.timezone,
    accountLabel: row.account_name,
  };
}

/** `fact_profile_daily` over an inclusive window, oldest first. */
export async function readOurProfileDays(
  handle: DbHandle,
  profileId: string,
  startDate: string,
  endDate: string,
): Promise<OurProfileDay[]> {
  const rows = await handle.sql<
    { date: string; cost: string | number; sales_7d: string | number; provisional: boolean }[]
  >`
    select date::text as date, cost, sales_7d, provisional
    from public.fact_profile_daily
    where profile_id = ${profileId} and date between ${startDate} and ${endDate}
    order by date
  `;
  return rows.map((row) => ({
    date: row.date,
    adSpend: toNumber(row.cost),
    adSales: toNumber(row.sales_7d),
    provisional: row.provisional,
  }));
}

/** Campaign totals over an inclusive window, summed across SP targets, SB and SD. */
export async function readOurCampaignTotals(
  handle: DbHandle,
  profileId: string,
  startDate: string,
  endDate: string,
): Promise<OurCampaignTotals[]> {
  const rows = await handle.sql<
    { campaign_id: string; cost: string | number; sales: string | number }[]
  >`
    with grains as (
      select campaign_id, cost, sales_7d
      from public.fact_sp_target_daily
      where profile_id = ${profileId} and date between ${startDate} and ${endDate}
      union all
      select campaign_id, cost, sales_7d
      from public.fact_sb_daily
      where profile_id = ${profileId} and date between ${startDate} and ${endDate}
      union all
      select campaign_id, cost, sales_7d
      from public.fact_sd_daily
      where profile_id = ${profileId} and date between ${startDate} and ${endDate}
    )
    select campaign_id, sum(cost) as cost, sum(sales_7d) as sales
    from grains
    group by campaign_id
    order by campaign_id
  `;
  return rows.map((row) => ({
    campaignId: row.campaign_id,
    adSpend: toNumber(row.cost),
    adSales: toNumber(row.sales),
  }));
}

/** Campaign names for the drill-down, from the entity mirror. */
export async function readCampaignNames(
  handle: DbHandle,
  profileId: string,
  campaignIds: readonly string[],
): Promise<Map<string, string>> {
  if (campaignIds.length === 0) return new Map();
  const rows = await handle.sql<{ amazon_id: string; name: string | null }[]>`
    select amazon_id, name from public.campaigns
    where profile_id = ${profileId} and amazon_id in ${handle.sql([...campaignIds])}
  `;
  return new Map(rows.filter((row) => row.name !== null).map((row) => [row.amazon_id, row.name as string]));
}

function toNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
