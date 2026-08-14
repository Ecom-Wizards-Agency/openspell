/**
 * The profile roster the switcher renders and every read scopes to.
 *
 * The org predicate is not optional and not a convenience. This module's own
 * header used to claim RLS decided which profiles a member could see — but the
 * web tier connects as the service role (`src/data/db.ts` says so in as many
 * words), which means RLS is *not* what constrains these reads. Until the
 * predicate below existed, `/dashboard` and `/grid` listed every profile in the
 * database and defaulted to the first one, whoever owned it. Authorization for
 * everything the web tier renders is enforced above the connection, so it has
 * to actually be written down: `orgId` comes from `gate()` and travels into the
 * SQL.
 */
import { asc, eq } from 'drizzle-orm';
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

export async function listProfiles(handle: DbHandle, orgId: string): Promise<ProfileRecord[]> {
  const rows = await handle.db
    .select()
    .from(adProfiles)
    .where(eq(adProfiles.orgId, orgId))
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
