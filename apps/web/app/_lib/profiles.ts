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
import { asc, eq, sql } from 'drizzle-orm';
import { adProfiles } from '@wizard-ads/db';
import type { AdProfile, DbHandle } from '@wizard-ads/db';

export interface ProfileRecord
  extends Pick<
    AdProfile,
    | 'id'
    | 'amazonProfileId'
    | 'region'
    | 'countryCode'
    | 'currencyCode'
    | 'syncEnabled'
    | 'targetAcos'
    | 'monthlyBudget'
    | 'goalLens'
    | 'timezone'
  > {
  label: string;
  /** Doctrine values, per profile. Absent means the widget that needs one is off. */
}

export async function listProfiles(handle: DbHandle, orgId: string): Promise<ProfileRecord[]> {
  const rows = await handle.db
    .select()
    .from(adProfiles)
    .where(eq(adProfiles.orgId, orgId))
    // Lead with the human name, falling back to the Amazon id when a profile has
    // none, so the switcher reads the way the roster does.
    .orderBy(asc(sql`coalesce(${adProfiles.accountName}, ${adProfiles.amazonProfileId})`));

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
 * falls back to a default rather than rendering an empty page against an id
 * nobody can see. When nothing is requested the default is the first
 * *sync-enabled* profile: an org of two hundred profiles with three switched on
 * should open on one that actually has data, not on whichever profile happens to
 * sort first — that was the "All profiles" foot-gun from the video. If none is
 * sync-enabled, the first profile stands in so the page still renders.
 */
export function selectProfile(
  profiles: readonly ProfileRecord[],
  requested: string | undefined,
): ProfileRecord | null {
  if (profiles.length === 0) return null;
  const match = requested === undefined ? undefined : profiles.find((p) => p.id === requested);
  if (match) return match;
  const firstSynced = profiles.find((p) => p.syncEnabled);
  return firstSynced ?? (profiles[0] as ProfileRecord);
}
