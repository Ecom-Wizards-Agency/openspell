/**
 * Profile lookups for the review and explorer screens.
 *
 * These screens run on the request handle (`openWebDatabase`) rather than the
 * Drizzle handle the dashboard uses, because they also write: deciding and
 * exporting go through the same connection and the same explicit `org_id`
 * predicate as every other statement in the request. Duplicating the profile
 * read here rather than reaching for `app/_lib/profiles.ts` keeps that one
 * boundary rather than mixing two handles in one request.
 */
import type { RequestDatabase } from '@wizard-ads/db';
import { orderActiveProfiles, resolveActiveProfile } from '../data/active-profile';

export type ProfileQueryHandle = Pick<RequestDatabase, 'sql'>;

export interface OrgProfile {
  id: string;
  amazonProfileId: string;
  label: string;
  currencyCode: string;
  countryCode: string;
  timezone: string;
  targetAcos: number | null;
  goalLens: string | null;
  /** Whether the sync is paying for this profile's reports. Drives the default. */
  syncEnabled: boolean;
}

export async function listOrgProfiles(
  handle: ProfileQueryHandle,
  orgId: string,
): Promise<OrgProfile[]> {
  const rows = await handle.sql<
    {
      id: string;
      amazon_profile_id: string;
      account_name: string | null;
      currency_code: string;
      country_code: string;
      timezone: string;
      target_acos: string | number | null;
      goal_lens: string | null;
      sync_enabled: boolean;
    }[]
  >`
    select id, amazon_profile_id, account_name, currency_code, country_code, timezone,
           target_acos, goal_lens, sync_enabled
     from public.ad_profiles
     where org_id = ${orgId}
  `;
  return orderActiveProfiles(
    rows.map((row) => ({
      id: row.id,
      amazonProfileId: row.amazon_profile_id,
      label: row.account_name ?? row.amazon_profile_id,
      currencyCode: row.currency_code,
      countryCode: row.country_code,
      timezone: row.timezone,
      targetAcos: row.target_acos === null ? null : Number(row.target_acos),
      goalLens: row.goal_lens,
      syncEnabled: row.sync_enabled,
    })),
  );
}

/**
 * Adapter-preserving wrapper around the shared deterministic resolver. A
 * requested profile must belong to this org-scoped roster; otherwise the first
 * syncing profile in human-label order is used.
 */
export function selectOrgProfile(
  profiles: readonly OrgProfile[],
  requested: string | undefined,
): OrgProfile | null {
  return resolveActiveProfile(profiles, requested);
}
