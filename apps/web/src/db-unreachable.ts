/**
 * "Set but unreachable" is a configuration state, not a bug.
 *
 * The read surfaces already promise, in their own doc comments, that a missing
 * database renders a page saying so rather than taking down the app. That
 * promise was only half kept: it covered an *absent* `DATABASE_URL` and not a
 * present one pointing at a Postgres that is down, moved, or refusing this
 * password — which is the state a real deployment actually lands in, and which
 * produced a stack trace where the page should have said "not wired up yet".
 *
 * This predicate is the seam. It matches transport failures and the handful of
 * server-side refusals that mean "you never got a session", and deliberately
 * nothing else: a syntax error, a missing column or a constraint violation is a
 * bug in this repository and must keep surfacing as one.
 */

/** Driver-level codes: no connection was ever established, or it was lost. */
const TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  // postgres.js's own vocabulary for the same failures.
  'CONNECTION_REFUSED',
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECTION_ENDED',
  'CONNECT_TIMEOUT',
]);

/**
 * SQLSTATEs that mean the server answered but refused to hand out a session.
 * Wrong password, no such database, no such role, shutting down, out of slots —
 * every one of them is an operator fixing configuration, not a query to debug.
 */
const REFUSAL_SQLSTATES = new Set([
  '28000', // invalid_authorization_specification
  '28P01', // invalid_password
  '3D000', // invalid_catalog_name — no such database
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
]);

function codeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** True when the failure is "this instance cannot reach its database". */
export function isDatabaseUnreachable(error: unknown): boolean {
  if (error === null || error === undefined) return false;

  const code = codeOf(error);
  if (code !== null && (TRANSPORT_CODES.has(code) || REFUSAL_SQLSTATES.has(code))) return true;

  // postgres.js wraps the socket error on the `cause` of the query error, so a
  // refused connection arrives one level down.
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== error) return isDatabaseUnreachable(cause);

  return false;
}
