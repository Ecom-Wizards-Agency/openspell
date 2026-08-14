/**
 * Who is asking, for the route handlers under `app/api/tags` and `app/go`.
 *
 * ## Two identity sources, and only ever one at a time
 *
 * WP-04 owns browser authentication: a Supabase session cookie, resolved to a
 * user by `src/auth/session.ts` and to an org by `src/data/orgs.ts`. That is
 * the path a deployed instance takes, and `requestActor` is what these routes
 * call.
 *
 * WP-08's end-to-end suite cannot take that path. It serves a **production**
 * build — `next dev` never hydrates behind Playwright's extra request headers —
 * and WP-04's test-only cookie seam refuses to run under `NODE_ENV=production`
 * by design. So the tags suite has its own seam: a header bridge that carries
 * an already-verified actor, guarded by a shared secret.
 *
 * The two must never both be live, or a stray header could impersonate any
 * membership on a real deployment. Three things keep the bridge shut:
 *
 *  - it is off unless `WIZARD_ADS_E2E_AUTH_BRIDGE=1` is set **on the server**,
 *    which only `e2e/run.ts` does;
 *  - it throws on use if that flag is set on an instance that has Supabase Auth
 *    configured — a deployment has `NEXT_PUBLIC_SUPABASE_*`, the e2e harness
 *    does not, so the two configurations are mutually exclusive rather than
 *    merely conventionally separate;
 *  - it still requires `WIZARD_ADS_AUTH_BRIDGE_SECRET` to match in constant
 *    time, so knowing the flag's name is not enough.
 *
 * `NODE_ENV` deliberately does *not* appear in that list: the tags suite runs a
 * production build on purpose, so gating on it would disarm the seam the suite
 * depends on and prove nothing about a deployment, which is distinguished by
 * having a real auth provider rather than by how it was compiled.
 */
import { timingSafeEqual } from 'node:crypto';
import { createRequestDatabase } from '@wizard-ads/db';
import type { RequestDatabase } from '@wizard-ads/db';

export interface RequestActor {
  userId: string;
  orgId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class RequestAuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 | 503,
  ) {
    super(message);
    this.name = 'RequestAuthError';
  }
}

function equalSecret(supplied: string, expected: string): boolean {
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return (
    suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

/**
 * Is the end-to-end header bridge armed? False everywhere but the WP-08 suite.
 * Throws rather than returning false when it is armed alongside a real auth
 * provider, because that combination is a misconfiguration worth shouting
 * about, not a preference to resolve quietly.
 */
export function e2eAuthBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['WIZARD_ADS_E2E_AUTH_BRIDGE'] !== '1') return false;
  if (env['NEXT_PUBLIC_SUPABASE_URL'] && env['NEXT_PUBLIC_SUPABASE_ANON_KEY']) {
    throw new Error(
      'WIZARD_ADS_E2E_AUTH_BRIDGE=1 is set on an instance that has Supabase Auth ' +
        'configured. The header bridge is a test-only authentication bypass and must ' +
        'never be enabled where real sessions exist.',
    );
  }
  return true;
}

/**
 * The e2e path: an actor vouched for by the bridge secret.
 *
 * Accepting bare user/org headers would let any caller impersonate any known
 * membership, so the secret is checked first and the ids are shape-checked
 * after.
 */
export function actorFromHeaders(
  headers: Headers,
  env: NodeJS.ProcessEnv = process.env,
): RequestActor {
  if (!e2eAuthBridgeEnabled(env)) {
    throw new RequestAuthError('Auth bridge is not enabled', 503);
  }
  const expectedBridgeSecret = env['WIZARD_ADS_AUTH_BRIDGE_SECRET'];
  if (!expectedBridgeSecret) throw new RequestAuthError('Auth bridge is not configured', 503);
  const suppliedBridgeSecret = headers.get('x-wizard-ads-auth-bridge') ?? '';
  if (!equalSecret(suppliedBridgeSecret, expectedBridgeSecret)) {
    throw new RequestAuthError('Authentication required', 401);
  }
  const userId = headers.get('x-wizard-ads-user-id') ?? '';
  const orgId = headers.get('x-wizard-ads-org-id') ?? '';
  if (!UUID.test(userId) || !UUID.test(orgId)) {
    throw new RequestAuthError('Invalid actor context', 401);
  }
  return { userId, orgId };
}

/**
 * The real path: WP-04's session cookie plus the caller's active org.
 *
 * Imported lazily so that `next/headers` — which only works inside a request —
 * is not pulled into the module graph of the Vitest route suites, which drive
 * these handlers as plain functions.
 */
async function actorFromSession(): Promise<RequestActor> {
  const { currentUser } = await import('../auth/session');
  const user = await currentUser();
  if (!user) throw new RequestAuthError('Authentication required', 401);

  const { database } = await import('../data/db');
  const handle = database();
  if (handle === null) throw new RequestAuthError('Database is not configured', 503);

  const { resolveOrgContext } = await import('../data/orgs');
  const context = await resolveOrgContext(handle, user);
  if (!context.active) throw new RequestAuthError('Resource not found', 403);
  return { userId: user.id, orgId: context.active.orgId };
}

/** The actor for this request, from whichever identity source is live. */
export async function requestActor(
  headers: Headers,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RequestActor> {
  if (e2eAuthBridgeEnabled(env)) return actorFromHeaders(headers, env);
  return await actorFromSession();
}

export function openWebDatabase(env: NodeJS.ProcessEnv = process.env): RequestDatabase {
  const connectionString = env['DATABASE_URL'];
  if (!connectionString) throw new RequestAuthError('Database is not configured', 503);
  return createRequestDatabase(connectionString);
}

export async function requireOrgMembership(
  handle: Pick<RequestDatabase, 'sql'>,
  actor: RequestActor,
): Promise<void> {
  const rows = await handle.sql<{ exists: boolean }[]>`
    select exists(
      select 1 from public.org_members
       where org_id = ${actor.orgId} and user_id = ${actor.userId}
    ) as exists
  `;
  if (!rows[0]?.exists) throw new RequestAuthError('Resource not found', 403);
}

export function errorResponse(error: unknown): Response {
  if (error instanceof RequestAuthError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof SyntaxError) {
    return Response.json({ error: 'Malformed JSON request' }, { status: 400 });
  }
  const message = error instanceof Error ? error.message : 'Unexpected error';
  if (/not found/i.test(message)) return Response.json({ error: 'Not found' }, { status: 404 });
  if (/duplicate key|unique constraint/i.test(message)) {
    return Response.json({ error: 'A sibling tag already uses that name' }, { status: 409 });
  }
  return Response.json({ error: message }, { status: 400 });
}
