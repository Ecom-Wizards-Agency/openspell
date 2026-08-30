/**
 * Org membership and the active org.
 *
 * There is no public signup: a user exists because somebody invited or seeded
 * them, so "which orgs am I in" is a read of `org_members` and nothing more. A
 * user in no org sees a page that says so rather than an empty dashboard.
 *
 * The active org is a cookie, validated against membership on every read. A
 * tampered cookie therefore cannot select an org the user is not in; it falls
 * back to the first membership.
 */
import { cookies } from 'next/headers';
import { cache } from 'react';
import type { DbHandle } from '@wizard-ads/db';
import { isOrgRole } from '../auth/roles';
import type { OrgRole } from '../auth/roles';
import type { SessionUser } from '../auth/session';
import { ORG_COOKIE } from '../cookies';

export { ORG_COOKIE };

export interface Membership {
  orgId: string;
  slug: string;
  name: string;
  role: OrgRole;
}

export interface OrgContext {
  user: SessionUser;
  memberships: Membership[];
  /** The selected membership, or null when the user belongs to no org. */
  active: Membership | null;
}

export async function listMemberships(handle: DbHandle, userId: string): Promise<Membership[]> {
  const rows = await handle.sql<
    { org_id: string; slug: string; name: string; role: string }[]
  >`
    select o.id as org_id, o.slug, o.name, m.role::text as role
    from public.org_members m
    join public.orgs o on o.id = m.org_id
    where m.user_id = ${userId}
    -- Display names are not unique. The id tie-break keeps the page shell and
    -- the Grid request receipt on one canonical fallback membership.
    order by o.name, o.id
  `;
  return rows.map((row) => ({
    orgId: row.org_id,
    slug: row.slug,
    name: row.name,
    role: isOrgRole(row.role) ? row.role : 'viewer',
  }));
}

/**
 * Resolve the whole context in one call: memberships plus the active one.
 *
 * `preferredOrgId` exists for the OAuth callback, which is handed an org id in
 * a signed state and must confirm the *user* is still a member of it rather
 * than trusting the cookie it arrived with.
 */
async function readOrgContext(
  handle: DbHandle,
  user: SessionUser,
  preferredOrgId?: string | null,
): Promise<OrgContext> {
  const memberships = await listMemberships(handle, user.id);
  const cookieOrg = preferredOrgId ?? (await cookies()).get(ORG_COOKIE)?.value ?? null;
  const active =
    memberships.find((membership) => membership.orgId === cookieOrg) ?? memberships[0] ?? null;
  return { user, memberships, active };
}

/**
 * Layout navigation and the page gate resolve the same membership context.
 * Deduplicate that read within one React server render; argument identity keeps
 * OAuth's explicit preferred-org lookup separate from the cookie-backed one.
 */
export const resolveOrgContext = cache(readOrgContext);

/** Membership lookup with no cookie involved. The OAuth callback's check. */
export function membershipFor(context: OrgContext, orgId: string): Membership | null {
  return context.memberships.find((membership) => membership.orgId === orgId) ?? null;
}
