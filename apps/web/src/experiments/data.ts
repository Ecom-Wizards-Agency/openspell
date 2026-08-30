/**
 * The reads the experiment pages share.
 *
 * They go through the request database (raw `sql`) rather than the Drizzle
 * handle, because the experiment surfaces authenticate through the same header
 * bridge the feedback and tag surfaces use, not through the session gate — so
 * they live on `openWebDatabase`, and every read names the org the actor
 * resolved to.
 */
import type { RequestDatabase } from '@wizard-ads/db';
import {
  CATEGORY_DISCOVERY,
  CATEGORY_PROFIT,
  CATEGORY_RANK,
  CATEGORY_SHIELD,
  classifyCampaignCategory,
  selectTests,
  type TestIdea,
} from '@wizard-ads/core';

export interface ProfileOption {
  id: string;
  label: string;
  currencyCode: string;
  countryCode: string;
}

export async function listProfileOptions(
  handle: Pick<RequestDatabase, 'sql'>,
  orgId: string,
): Promise<ProfileOption[]> {
  const rows = await handle.sql<{
    id: string;
    label: string;
    currency_code: string;
    country_code: string;
  }[]>`
    select id,
           coalesce(account_name, amazon_profile_id) as label,
           currency_code,
           country_code
      from public.ad_profiles
     where org_id = ${orgId}
       and sync_enabled = true
     order by coalesce(account_name, amazon_profile_id)
  `;
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    currencyCode: row.currency_code,
    countryCode: row.country_code,
  }));
}

export function selectProfileId(
  profiles: readonly ProfileOption[],
  requested: string | null | undefined,
): string | null {
  if (profiles.length === 0) return null;
  const match = requested ? profiles.find((profile) => profile.id === requested) : undefined;
  return (match ?? profiles[0])?.id ?? null;
}

export interface ExperimentCampaignOption {
  id: string;
  name: string;
  available: boolean;
}

export interface ExperimentProductOption {
  asin: string;
  name: string | null;
  sku: string | null;
  available: boolean;
}

export interface ExperimentScopeOptions {
  campaigns: ExperimentCampaignOption[];
  products: ExperimentProductOption[];
}

/**
 * Current Amazon entities that can scope an experiment.
 *
 * Deleted campaigns remain in the result so a deep link or historical scope
 * can be named honestly. Product ads are collapsed to one ASIN: an ASIN can be
 * advertised by several ads, but it is still one product selection here.
 *
 * The entity mirror does not currently synchronize a catalog image URL. Do not
 * derive or guess one from an ASIN; the UI cleanly omits imagery until a
 * reliable, already-synchronized source exists.
 */
export async function listExperimentScopeOptions(
  handle: Pick<RequestDatabase, 'sql'>,
  input: { orgId: string; profileId: string },
): Promise<ExperimentScopeOptions> {
  const [campaignRows, productRows] = await Promise.all([
    handle.sql<{
      amazon_id: string;
      name: string | null;
      available: boolean;
    }[]>`
      select amazon_id,
             name,
             deleted_at is null as available
        from public.campaigns
       where org_id = ${input.orgId}
         and profile_id = ${input.profileId}
       order by deleted_at nulls first, name nulls last, amazon_id
    `,
    handle.sql<{
      asin: string;
      name: string | null;
      sku: string | null;
      available: boolean;
    }[]>`
      select asin,
             max(nullif(btrim(name), '')) filter (
               where nullif(btrim(name), '') is distinct from asin
                 and nullif(btrim(name), '') is distinct from nullif(btrim(sku), '')
             ) as name,
             max(nullif(btrim(sku), '')) as sku,
             bool_or(deleted_at is null) as available
        from public.product_ads
       where org_id = ${input.orgId}
         and profile_id = ${input.profileId}
         and nullif(btrim(asin), '') is not null
       group by asin
       order by max(nullif(btrim(name), '')) nulls last, asin
    `,
  ]);

  return {
    campaigns: campaignRows.map((row) => ({
      id: row.amazon_id,
      name: row.name?.trim() || 'Unnamed campaign',
      available: row.available,
    })),
    products: productRows.map((row) => ({
      asin: row.asin,
      // Amazon's SP product-ad endpoint commonly repeats the ASIN or SKU in
      // `name`. Treat that as an identifier fallback, not a product title.
      name:
        row.name !== null && row.name !== row.asin && row.name !== row.sku
          ? row.name
          : null,
      sku: row.sku,
      available: row.available,
    })),
  };
}

export interface ProfileTestSignals {
  goal: string | null;
  campaignNames: string[];
}

/** Turn profile facts into the exact requirement tags the Python backlog uses. */
export function profileTestTags(signals: ProfileTestSignals): Set<string> {
  const tags = new Set<string>();
  if (signals.goal) tags.add(`goal:${signals.goal}`);
  const categories = new Set(signals.campaignNames.map(classifyCampaignCategory));
  if (categories.has(CATEGORY_RANK)) tags.add('rank_present');
  if (categories.has(CATEGORY_DISCOVERY)) tags.add('discovery_present');
  if (categories.has(CATEGORY_PROFIT)) tags.add('profit_present');
  if (categories.has(CATEGORY_SHIELD)) tags.add('shield_present');
  return tags;
}

/**
 * Proposed tests for one scoped profile. These are selections, not experiment
 * rows: creating a tracked experiment remains the existing manual flow.
 */
export async function listProposedTests(
  handle: Pick<RequestDatabase, 'sql'>,
  input: { orgId: string; profileId: string },
): Promise<TestIdea[]> {
  const [profiles, campaigns] = await Promise.all([
    handle.sql<{ goal_lens: string | null }[]>`
      select goal_lens
        from public.ad_profiles
       where org_id = ${input.orgId}
         and id = ${input.profileId}
    `,
    handle.sql<{ name: string | null }[]>`
      select name
        from public.campaigns
       where org_id = ${input.orgId}
         and profile_id = ${input.profileId}
         and deleted_at is null
         and state = 'enabled'
       order by amazon_id
    `,
  ]);
  const profile = profiles[0];
  if (!profile) return [];
  return selectTests(
    profileTestTags({
      goal: profile.goal_lens,
      campaignNames: campaigns
        .map((campaign) => campaign.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0),
    }),
  );
}

export interface DailySpendPoint {
  date: string;
  value: number | null;
}

/**
 * Daily spend for the detail page's trend chart — profile-wide and, when the
 * scope names ad entities, the scoped subset. One row per day over the window,
 * with a null (not a zero) for a day Amazon reported nothing, so the line breaks
 * rather than dropping to the floor.
 */
export async function loadExperimentSpendSeries(
  handle: Pick<RequestDatabase, 'sql'>,
  input: {
    orgId: string;
    profileId: string;
    start: string;
    end: string;
    campaignIds?: string[];
    targetIds?: string[];
  },
): Promise<{ profile: DailySpendPoint[]; scoped: DailySpendPoint[] | null }> {
  const profileRows = await handle.sql<{ date: string; spend: string }[]>`
    select date::text as date, sum(cost) as spend
      from public.fact_profile_daily
     where org_id = ${input.orgId}
       and profile_id = ${input.profileId}
       and date between ${input.start} and ${input.end}
     group by date
     order by date
  `;
  const profile = profileRows.map((row) => ({ date: row.date, value: Number(row.spend) }));

  const campaignIds = input.campaignIds ?? [];
  const targetIds = input.targetIds ?? [];
  if (campaignIds.length === 0 && targetIds.length === 0) return { profile, scoped: null };

  const scopedRows = await handle.sql<{ date: string; spend: string }[]>`
    select date::text as date, sum(cost) as spend
      from public.fact_sp_target_daily
     where org_id = ${input.orgId}
       and profile_id = ${input.profileId}
       and date between ${input.start} and ${input.end}
       and (
         (${campaignIds}::text[] <> '{}'::text[] and campaign_id = any(${campaignIds}::text[]))
         or (${targetIds}::text[] <> '{}'::text[] and target_id = any(${targetIds}::text[]))
       )
     group by date
     order by date
  `;
  const scoped = scopedRows.map((row) => ({ date: row.date, value: Number(row.spend) }));
  return { profile, scoped };
}
