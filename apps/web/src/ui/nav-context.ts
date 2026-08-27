/**
 * What the frame needs to know, read without ever being able to break a page.
 *
 * The top bar shows the active organisation and the profiles you can switch
 * between, which means the frame now wants a database read on every route —
 * including `/login`, `/not-found` and the error boundary, none of which have
 * any business failing because a roster could not be listed.
 *
 * So this composes the existing reads (`resolveOrgContext`, `listProfiles`) and
 * swallows everything: no membership, no database, an unreachable one, a
 * malformed cookie. The answer to all of them is the same and it is not an
 * exception — it is a top bar with no switcher, on a page that is perfectly able
 * to explain the real problem itself.
 */
import type { SessionUser } from '../auth/session';
import type { NavProfile } from './topbar-controls';

export interface NavContext {
  orgName: string | null;
  profiles: readonly NavProfile[];
}

const EMPTY: NavContext = { orgName: null, profiles: [] };

type NavProfileSource = Pick<NavProfile, 'id' | 'label' | 'countryCode' | 'syncEnabled'>;

/** Keep the roster whole while reducing it to exactly what the frame renders. */
export function mapNavProfiles(rows: readonly NavProfileSource[]): NavProfile[] {
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    countryCode: row.countryCode,
    syncEnabled: row.syncEnabled,
  }));
}

export async function navContext(user: SessionUser): Promise<NavContext> {
  try {
    const { database } = await import('../data/db');
    const handle = database();
    if (handle === null) return EMPTY;

    const { resolveOrgContext } = await import('../data/orgs');
    const context = await resolveOrgContext(handle, user);
    const active = context.active;
    if (!active) return EMPTY;

    const { listProfiles } = await import('../../app/_lib/profiles');
    const rows = await listProfiles(handle, active.orgId);
    return {
      orgName: active.name,
      profiles: mapNavProfiles(rows),
    };
  } catch {
    return EMPTY;
  }
}
