/**
 * The one entry gate every WP-04 page and server action goes through.
 *
 * Returns the org context or sends the visitor to `/login`. Two failures are
 * *not* redirects, because a redirect would hide them: an unusable database and
 * a user who belongs to no org both render a page that says so. There is no
 * public signup, so "no org" is a real state an invited-but-unseeded user lands
 * in, and it deserves an explanation rather than a loop.
 *
 * "Unusable" covers both an absent `DATABASE_URL` and one that points at a
 * Postgres this instance cannot reach. The second is the state a real
 * deployment lands in, and it used to arrive as a stack trace on every guarded
 * page; it is the same operator fix as the first, so it gets the same answer.
 */
import { redirect } from 'next/navigation';
import type { DbHandle } from '@wizard-ads/db';
import { isDatabaseUnreachable } from '../db-unreachable';
import { database, requireDatabase } from '../data/db';
import { resolveOrgContext } from '../data/orgs';
import type { Membership, OrgContext } from '../data/orgs';
import {
  authorizeOperatorRole,
  currentOperatorIdentity,
} from './security-authorization';
import { currentUser } from './session';

export type Gate =
  | { state: 'ok'; handle: DbHandle; context: OrgContext }
  | { state: 'no-database' }
  | { state: 'no-org'; context: OrgContext };

export async function gate(): Promise<Gate> {
  return resolvePageGate(true);
}

/** Account security must remain reachable when policy requires MFA enrollment. */
export async function gateAccountSecurity(): Promise<Gate> {
  return resolvePageGate(false);
}

async function resolvePageGate(enforceAssurance: boolean): Promise<Gate> {
  const identity = enforceAssurance ? await currentOperatorIdentity() : null;
  const user = identity === null ? await currentUser() : identity.user;
  if (!user) {
    if (identity?.security?.state === 'unavailable') {
      redirect('/login?error=account+security+could+not+be+verified');
    }
    redirect('/login');
  }

  const handle = database();
  if (handle === null) return { state: 'no-database' };

  let context: OrgContext;
  try {
    context = await resolveOrgContext(handle, user);
  } catch (error) {
    if (isDatabaseUnreachable(error)) return { state: 'no-database' };
    throw error;
  }
  if (!context.active) return { state: 'no-org', context };

  if (identity !== null) {
    const authorization = authorizeOperatorRole(identity, context.active.role, '/dashboard');
    if (authorization.status === 'challenge') redirect(authorization.href);
    if (authorization.status === 'error') {
      redirect('/login?error=account+security+could+not+be+verified');
    }
  }
  return { state: 'ok', handle, context };
}

/**
 * The same gate for a server action, where there is no page to render a
 * message on: anything short of a usable context throws.
 */
export async function gateAction(): Promise<{ handle: DbHandle; active: Membership }> {
  const identity = await currentOperatorIdentity();
  const user = identity.user;
  if (!user) throw new Error('not signed in');
  const handle = requireDatabase();
  const context = await resolveOrgContext(handle, user);
  const active = context.active;
  if (!active) throw new Error('you belong to no organisation');
  const authorization = authorizeOperatorRole(identity, active.role, '/dashboard');
  if (authorization.status !== 'ok') throw new Error('additional authentication required');
  return { handle, active };
}

/** Account-security actions still require membership, but apply their own step-up rule. */
export async function gateAccountSecurityAction(): Promise<{
  handle: DbHandle;
  active: Membership;
}> {
  const user = await currentUser();
  if (!user) throw new Error('not signed in');
  const handle = requireDatabase();
  const context = await resolveOrgContext(handle, user);
  const active = context.active;
  if (!active) throw new Error('you belong to no organisation');
  return { handle, active };
}
