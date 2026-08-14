/**
 * What a guarded page says when the gate did not open.
 *
 * One sentence per state, shared by every screen, because three pages phrasing
 * the same operator problem three ways is three support questions. Neither
 * state is an error: both are somebody's next action, and the sentence names it.
 */
export type GateBlock = 'no-database' | 'no-org';

export function gateMessage(state: GateBlock): string {
  return state === 'no-database'
    ? 'This instance cannot reach its database. Set DATABASE_URL to a reachable Postgres and reload; nothing on this page is computed here, so there is nothing to show until it can read.'
    : 'Your account is not a member of any organisation yet. There is no public signup: ask whoever invited you to add you to one.';
}
