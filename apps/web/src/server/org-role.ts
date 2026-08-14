/**
 * The actor's role in the org they are acting in.
 *
 * `requireOrgMembership` in `request-context.ts` answers "is this actor in this
 * org"; feedback triage needs the next question, "as what". Kept next to it
 * rather than inside it because WP-08 owns that file and this is additive: the
 * lookup is one statement and the decision it feeds is WP-04's capability
 * table, not a second rule invented here.
 */
import type { RequestDatabase } from '@wizard-ads/db';
import { isOrgRole } from '../auth/roles';
import type { Capability, OrgRole } from '../auth/roles';
import { authorize } from '../auth/roles';
import { RequestAuthError } from './request-context';
import type { RequestActor } from './request-context';

/**
 * Resolve the role, or refuse the request.
 *
 * A non-member gets 403 with the same message a missing row would produce, so
 * "you are not in that org" and "that org does not exist" are indistinguishable
 * from outside.
 */
export async function requireOrgRole(
  handle: Pick<RequestDatabase, 'sql'>,
  actor: RequestActor,
): Promise<OrgRole> {
  const rows = await handle.sql<{ role: string }[]>`
    select role::text as role from public.org_members
     where org_id = ${actor.orgId} and user_id = ${actor.userId}
  `;
  const role = rows[0]?.role;
  if (!role) throw new RequestAuthError('Resource not found', 403);
  // An unknown label is a schema drift, and reading it as `viewer` is the safe
  // direction: it grants nothing beyond reading.
  return isOrgRole(role) ? role : 'viewer';
}

/** Resolve the role and assert a capability, as one call. */
export async function requireCapability(
  handle: Pick<RequestDatabase, 'sql'>,
  actor: RequestActor,
  capability: Capability,
): Promise<OrgRole> {
  const role = await requireOrgRole(handle, actor);
  try {
    authorize(role, capability);
  } catch {
    throw new RequestAuthError(`role ${role} is not permitted to ${capability}`, 403);
  }
  return role;
}
