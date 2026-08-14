/**
 * The profile roster the switcher renders and every read scopes to.
 *
 * Reads go through the ordinary client, so RLS decides which org's profiles a
 * signed-in member can see. Nothing here uses a service-role key: the web tier
 * has no business holding one, and a read surface that can see every tenant is
 * one bug away from showing one tenant another's numbers.
 */
import { asc } from 'drizzle-orm';
import { adProfiles } from '@wizard-ads/db';
import type { DbHandle } from '@wizard-ads/db';
import type { ProfileOption } from '@wizard-ads/ui';

export interface ProfileRecord extends ProfileOption {
  amazonProfileId: string;
  /** Doctrine values, per profile. Absent means the widget that needs one is off. */
  targetAcos: number | null;
  monthlyBudget: number | null;
  goalLens: string | null;
  timezone: string;
}

export async function listProfiles(handle: DbHandle): Promise<ProfileRecord[]> {
  const rows = await handle.db
    .select()
    .from(adProfiles)
    .orderBy(asc(adProfiles.countryCode), asc(adProfiles.amazonProfileId));

  return rows.map((row) => ({
    id: row.id,
    amazonProfileId: row.amazonProfileId,
    label: row.accountName ?? row.amazonProfileId,
    region: row.region,
    countryCode: row.countryCode,
    currencyCode: row.currencyCode,
    syncEnabled: row.syncEnabled,
    targetAcos: row.targetAcos,
    monthlyBudget: row.monthlyBudget,
    goalLens: row.goalLens,
    timezone: row.timezone,
  }));
}

/**
 * Which profile a page is about.
 *
 * A requested profile that does not exist (or is not visible to this member)
 * falls back to the first one rather than rendering an empty page against an id
 * nobody can see.
 */
export function selectProfile(
  profiles: readonly ProfileRecord[],
  requested: string | undefined,
): ProfileRecord | null {
  if (profiles.length === 0) return null;
  const match = requested === undefined ? undefined : profiles.find((p) => p.id === requested);
  return match ?? (profiles[0] as ProfileRecord);
}
