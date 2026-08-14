/**
 * The one entry gate every WP-04 page and server action goes through.
 *
 * Returns the org context or sends the visitor to `/login`. Two failures are
 * *not* redirects, because a redirect would hide them: a missing database and a
 * user who belongs to no org both render a page that says so. There is no
 * public signup, so "no org" is a real state an invited-but-unseeded user lands
 * in, and it deserves an explanation rather than a loop.
 */
import { redirect } from 'next/navigation';
import type { DbHandle } from '@wizard-ads/db';
import { database, requireDatabase } from '../data/db';
import { resolveOrgContext } from '../data/orgs';
import type { Membership, OrgContext } from '../data/orgs';
import { currentUser } from './session';

export type Gate =
  | { state: 'ok'; handle: DbHandle; context: OrgContext }
  | { state: 'no-database' }
  | { state: 'no-org'; context: OrgContext };

export async function gate(): Promise<Gate> {
  const user = await currentUser();
  if (!user) redirect('/login');

  const handle = database();
  if (handle === null) return { state: 'no-database' };

  const context = await resolveOrgContext(handle, user);
  if (!context.active) return { state: 'no-org', context };
  return { state: 'ok', handle, context };
}

/**
 * The same gate for a server action, where there is no page to render a
 * message on: anything short of a usable context throws.
 */
export async function gateAction(): Promise<{ handle: DbHandle; active: Membership }> {
  const user = await currentUser();
  if (!user) throw new Error('not signed in');
  const handle = requireDatabase();
  const context = await resolveOrgContext(handle, user);
  const active = context.active;
  if (!active) throw new Error('you belong to no organisation');
  return { handle, active };
}
