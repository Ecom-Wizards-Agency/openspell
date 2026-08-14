/** Signed, tenant-scoped deep links. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DbHandle } from '../client.js';

export type GotoQueryHandle = Pick<DbHandle, 'sql'>;
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface GotoLinkRecord {
  id: string;
  orgId: string;
  token: string;
  route: string;
  state: JsonValue;
  label: string | null;
  expiresAt: Date | null;
  uses: number;
  lastUsedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
}

interface GotoRow {
  id: string;
  org_id: string;
  token: string;
  route: string;
  state: JsonValue;
  label: string | null;
  expires_at: Date | null;
  uses: number;
  last_used_at: Date | null;
  created_by: string | null;
  created_at: Date;
}

const toGotoLink = (row: GotoRow): GotoLinkRecord => ({
  id: row.id,
  orgId: row.org_id,
  token: row.token,
  route: row.route,
  state: row.state,
  label: row.label,
  expiresAt: row.expires_at,
  uses: row.uses,
  lastUsedAt: row.last_used_at,
  createdBy: row.created_by,
  createdAt: row.created_at,
});

function signature(payload: string, signingSecret: string): Buffer {
  if (signingSecret.length < 32) {
    throw new Error('GOTO_LINK_SIGNING_SECRET must contain at least 32 characters');
  }
  return createHmac('sha256', signingSecret).update(payload).digest().subarray(0, 16);
}

export function createSignedGotoToken(signingSecret: string): string {
  const payload = randomBytes(16).toString('base64url');
  return `${payload}.${signature(payload, signingSecret).toString('base64url')}`;
}

export function isValidGotoToken(token: string, signingSecret: string): boolean {
  const [payload, encoded, extra] = token.split('.');
  if (!payload || !encoded || extra !== undefined || !/^[A-Za-z0-9_-]{22}$/.test(payload)) {
    return false;
  }
  let supplied: Buffer;
  try {
    supplied = Buffer.from(encoded, 'base64url');
  } catch {
    return false;
  }
  const expected = signature(payload, signingSecret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function validateGotoRoute(route: string): string {
  const normalized = route.trim();
  const hasControlCharacter = [...normalized].some((character) => character.charCodeAt(0) < 32);
  if (
    !normalized.startsWith('/') ||
    normalized.startsWith('//') ||
    normalized.startsWith('/go/') ||
    normalized.includes('\\') ||
    hasControlCharacter
  ) {
    throw new Error('Goto route must be an internal application path outside /go');
  }
  return normalized;
}

function serializeState(state: JsonValue): string {
  const serialized = JSON.stringify(state);
  if (serialized === undefined) throw new Error('Goto state must be JSON-serializable');
  return serialized;
}

export async function createGotoLink(
  handle: GotoQueryHandle,
  input: {
    orgId: string;
    route: string;
    state: JsonValue;
    signingSecret: string;
    expiresAt?: Date | null;
    label?: string | null;
    createdBy?: string | null;
  },
): Promise<GotoLinkRecord> {
  const route = validateGotoRoute(input.route);
  const state = serializeState(input.state);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = createSignedGotoToken(input.signingSecret);
    const rows = await handle.sql<GotoRow[]>`
      insert into public.goto_links
        (org_id, token, route, state, label, expires_at, created_by)
      values (
        ${input.orgId}, ${token}, ${route}, ${state}::jsonb, ${input.label ?? null},
        ${input.expiresAt ?? null}, ${input.createdBy ?? null}
      )
      on conflict (token) do nothing
      returning id, org_id, token, route, state, label, expires_at, uses,
                last_used_at, created_by, created_at
    `;
    const row = rows[0];
    if (row) return toGotoLink(row);
  }
  throw new Error('Could not allocate a unique goto token');
}

/**
 * Resolves and records use in one statement. Supplying the current org is
 * mandatory even when RLS is active, so service-role callers cannot leak a
 * cross-tenant token accidentally.
 */
export async function resolveGotoLink(
  handle: GotoQueryHandle,
  input: { orgId: string; token: string; signingSecret: string; now?: Date },
): Promise<GotoLinkRecord | null> {
  if (!isValidGotoToken(input.token, input.signingSecret)) return null;
  const now = input.now ?? new Date();
  const rows = await handle.sql<GotoRow[]>`
    update public.goto_links
       set uses = uses + 1, last_used_at = ${now}
     where org_id = ${input.orgId}
       and token = ${input.token}
       and (expires_at is null or expires_at > ${now})
    returning id, org_id, token, route, state, label, expires_at, uses,
              last_used_at, created_by, created_at
  `;
  return rows[0] ? toGotoLink(rows[0]) : null;
}

export function gotoRedirectLocation(route: string, state: JsonValue): string {
  const url = new URL(validateGotoRoute(route), 'https://wizard-ads.invalid');
  url.searchParams.set('state', serializeState(state));
  return `${url.pathname}${url.search}${url.hash}`;
}

export function stateFromGotoRedirect(location: string): JsonValue {
  const url = new URL(location, 'https://wizard-ads.invalid');
  const state = url.searchParams.get('state');
  if (state === null) throw new Error('Goto redirect has no state parameter');
  return JSON.parse(state) as JsonValue;
}
