/**
 * One deterministic definition of the advertising profile an account-scoped
 * screen is about.
 *
 * Both database adapters return the same shape but use different connection
 * handles. Keeping ordering and selection pure lets both adapters share the
 * decision without mixing those handles or duplicating tenant logic.
 */
export interface ActiveProfileCandidate {
  id: string;
  label: string;
  syncEnabled: boolean;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Human label first, then the original casing and id as deterministic ties. */
export function compareActiveProfiles(
  left: ActiveProfileCandidate,
  right: ActiveProfileCandidate,
): number {
  return (
    compareText(left.label.toLowerCase(), right.label.toLowerCase()) ||
    compareText(left.label, right.label) ||
    compareText(left.id, right.id)
  );
}

/** Return a sorted copy. Callers never have their roster mutated underneath them. */
export function orderActiveProfiles<T extends ActiveProfileCandidate>(
  profiles: readonly T[],
): T[] {
  return [...profiles].sort(compareActiveProfiles);
}

/**
 * A valid explicit preference wins. Otherwise the first syncing profile in
 * the shared order wins, followed by the first profile when none are syncing.
 */
export function resolveActiveProfile<T extends ActiveProfileCandidate>(
  profiles: readonly T[],
  requested: string | undefined,
): T | null {
  if (profiles.length === 0) return null;

  const ordered = orderActiveProfiles(profiles);
  const requestedProfile =
    requested === undefined ? undefined : ordered.find((profile) => profile.id === requested);
  if (requestedProfile !== undefined) return requestedProfile;

  return ordered.find((profile) => profile.syncEnabled) ?? (ordered[0] as T);
}

export type ProfileSearchParams = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

/**
 * Canonical account-scoped URL, or null when the URL already names the active
 * profile exactly once. Other page state is retained verbatim and encoded by
 * URLSearchParams.
 */
export function canonicalProfilePath(
  path: string,
  searchParams: ProfileSearchParams,
  activeProfileId: string,
): string | null {
  const current = searchParams['profile'];
  if (typeof current === 'string' && current === activeProfileId) return null;

  const canonical = new URLSearchParams();
  canonical.set('profile', activeProfileId);
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === 'profile' || value === undefined) continue;
    if (typeof value === 'string') {
      canonical.append(key, value);
    } else {
      for (const item of value) canonical.append(key, item);
    }
  }
  return `${path}?${canonical.toString()}`;
}
