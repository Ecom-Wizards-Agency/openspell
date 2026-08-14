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
 *
 * Every read here excludes backfilled facts. See the note above the queries.
 */
import type { DbHandle } from '@wizard-ads/db';
import type { OurCampaignTotals, OurProfileDay } from './compare.js';

/**
 * ## Why every fact read below carries the same `not exists` clause
 *
 * A fact row's provenance is its `report_request_id`. The AdLabs history
 * backfill (WP-18) writes rows whose request carries
 * `source = 'adlabs_backfill'` — data we got *from* AdLabs. Comparing those
 * against a fresh AdLabs export is comparing AdLabs against itself: it agrees,
 * it returns `verified`, and the verdict means nothing. That is worse than no
 * check at all, because it is shaped exactly like a passing one.
 *
 * So the reader drops them, and the day falls out as `missing_ours` — which is
 * the truth: we hold no independently-sourced figure for that day.
 *
 * `not exists` rather than a join on `source = 'amazon_api'` because
 * `report_request_id` is nullable. A fact with no request row is not thereby
 * suspect (fixtures and pre-ledger loads have none); a fact pointing at a
 * request that names a non-Amazon source is. The backfill loader's side of this
 * bargain is that it never writes a fact row without a ledger row.
 *
 * The clause is written out at each call site rather than interpolated from a
 * constant: these are tagged templates, a spliced string is the one thing that
 * turns a parameterised query into an injectable one, and four lines repeated
 * three times is a cheaper price than a fragment builder nobody audits.
 */

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
    select f.date::text as date, f.cost, f.sales_7d, f.provisional
    from public.fact_profile_daily f
    where f.profile_id = ${profileId} and f.date between ${startDate} and ${endDate}
      and not exists (
        select 1 from public.report_requests r
        where r.id = f.report_request_id and r.source <> 'amazon_api'
      )
    order by f.date
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
      select f.campaign_id, f.cost, f.sales_7d
      from public.fact_sp_target_daily f
      where f.profile_id = ${profileId} and f.date between ${startDate} and ${endDate}
        and not exists (
          select 1 from public.report_requests r
          where r.id = f.report_request_id and r.source <> 'amazon_api'
        )
      union all
      select f.campaign_id, f.cost, f.sales_7d
      from public.fact_sb_daily f
      where f.profile_id = ${profileId} and f.date between ${startDate} and ${endDate}
        and not exists (
          select 1 from public.report_requests r
          where r.id = f.report_request_id and r.source <> 'amazon_api'
        )
      union all
      select f.campaign_id, f.cost, f.sales_7d
      from public.fact_sd_daily f
      where f.profile_id = ${profileId} and f.date between ${startDate} and ${endDate}
        and not exists (
          select 1 from public.report_requests r
          where r.id = f.report_request_id and r.source <> 'amazon_api'
        )
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
