import { timingSafeEqual } from 'node:crypto';
import { createWp08Database } from './wp08-service';
import type { Wp08Database } from './wp08-service';

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
 * WP-04 owns browser authentication. Its middleware hands server routes a
 * verified actor through this guarded bridge; accepting bare user/org headers
 * would let a caller impersonate any known membership.
 */
export function actorFromHeaders(
  headers: Headers,
  env: NodeJS.ProcessEnv = process.env,
): RequestActor {
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

export function openWebDatabase(env: NodeJS.ProcessEnv = process.env): Wp08Database {
  const connectionString = env['DATABASE_URL'];
  if (!connectionString) throw new RequestAuthError('Database is not configured', 503);
  return createWp08Database(connectionString);
}

export async function requireOrgMembership(
  handle: Pick<Wp08Database, 'sql'>,
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
