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
