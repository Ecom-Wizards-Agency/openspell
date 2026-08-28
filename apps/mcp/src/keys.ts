/**
 * API keys: minting, verification, revocation.
 *
 * The plaintext token exists exactly once, in the response to `issueApiKey`,
 * and is never stored, logged, or written to `audit_log`. What the database
 * holds is a SHA-256 hash and a short prefix; verification hashes the presented
 * token and looks the row up by that hash, so a leaked database gives an
 * attacker nothing to present.
 *
 * SHA-256 rather than a password KDF is a deliberate choice, not a shortcut: a
 * token is 32 bytes of `randomBytes`, so there is no dictionary to slow down,
 * and a KDF would force a table scan on every request instead of an index hit.
 *
 * A key is scoped three ways, all enforced here and again in the tool layer:
 * read-only, a required profile allowlist, and a bounded expiry. That is the
 * AdLabs gap the recon named first — their key is unscoped, non-expiring and
 * read-write by default.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DbHandle } from '@wizard-ads/db';
import { AuthError } from './errors.js';

/** Every token starts with this, so a leaked string is identifiable on sight. */
export const TOKEN_PREFIX = 'wza_';
const PREFIX_LENGTH = 12;
/** Matches the longest lifetime offered by the web key-management flow. */
export const MAX_API_KEY_LIFETIME_DAYS = 90;
/** Matches the web key-management flow's default. */
export const DEFAULT_API_KEY_LIFETIME_DAYS = 30;
const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type KeyScope = 'read' | 'write';

export interface ApiKeyRecord {
  id: string;
  orgId: string;
  label: string;
  keyPrefix: string;
  scope: KeyScope;
  /** Null is retained only so operators can identify legacy unsafe rows. */
  profileIds: string[] | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface IssuedApiKey {
  record: ApiKeyRecord;
  /** The only time this value exists. Hand it to the operator and forget it. */
  token: string;
}

interface KeyRow {
  id: string;
  org_id: string;
  label: string;
  key_prefix: string;
  scope: KeyScope;
  profile_ids: string[] | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
}

const toRecord = (row: KeyRow): ApiKeyRecord => ({
  id: row.id,
  orgId: row.org_id,
  label: row.label,
  keyPrefix: row.key_prefix,
  scope: row.scope,
  profileIds: row.profile_ids,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  lastUsedAt: row.last_used_at,
  createdAt: row.created_at,
});

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export interface IssueApiKeyInput {
  orgId: string;
  label: string;
  scope?: KeyScope;
  /** A required hard allowlist. Every id is verified against `orgId`. */
  profileIds: readonly string[];
  /** Required, future, and no more than 90 days from issuance. */
  expiresAt: Date;
  createdBy?: string | null;
}

export async function issueApiKey(
  handle: DbHandle,
  input: IssueApiKeyInput,
): Promise<IssuedApiKey> {
  const scope = input.scope ?? 'read';
  if (scope !== 'read') {
    // v1 has no write path at all. Issuing a write key would create a
    // credential whose permission the server cannot honor, which is worse than
    // refusing: it reads as capability that does not exist.
    throw new Error('v1 issues read-only keys only. A write scope unlocks with WP-12.');
  }

  const label = input.label.trim();
  if (label.length === 0) throw new Error('API keys require a non-empty label.');

  const profileIds = Array.isArray(input.profileIds) ? [...input.profileIds] : [];
  if (profileIds.length === 0) throw new Error('API keys require at least one profile.');
  if (!profileIds.every((profileId) => UUID.test(profileId))) {
    throw new Error('Every API key profile must be a valid UUID.');
  }
  if (new Set(profileIds).size !== profileIds.length) {
    throw new Error('API key profile allowlists must not contain duplicates.');
  }

  const now = new Date();
  const expiresAtMs = input.expiresAt instanceof Date ? input.expiresAt.getTime() : Number.NaN;
  if (!Number.isFinite(expiresAtMs)) throw new Error('API key expiry is invalid.');
  if (expiresAtMs <= now.getTime()) throw new Error('API key expiry must be in the future.');
  if (expiresAtMs - now.getTime() > MAX_API_KEY_LIFETIME_DAYS * DAY_MS) {
    throw new Error(`API key expiry cannot exceed ${MAX_API_KEY_LIFETIME_DAYS} days.`);
  }

  return handle.sql.begin(async (sql) => {
    // Keep the ownership proof and credential insert in one transaction. The
    // row locks prevent a profile from being removed between those two steps.
    const ownedProfiles = await sql<{ id: string }[]>`
      select id
        from public.ad_profiles
       where org_id = ${input.orgId}
         and id = any(${sql.array(profileIds)}::uuid[])
       for key share
    `;
    if (ownedProfiles.length !== profileIds.length) {
      throw new Error('Every API key profile must belong to the selected organization.');
    }

    const token = generateToken();
    const rows = await sql<KeyRow[]>`
      insert into mcp.api_keys
        (org_id, label, key_prefix, token_hash, scope, profile_ids, expires_at, created_by)
      values (
        ${input.orgId},
        ${label},
        ${token.slice(0, PREFIX_LENGTH)},
        ${hashToken(token)},
        ${scope},
        ${sql.array(profileIds)}::uuid[],
        ${input.expiresAt.toISOString()}::timestamptz,
        ${input.createdBy ?? null}
      )
      returning id, org_id, label, key_prefix, scope, profile_ids, expires_at,
                revoked_at, last_used_at, created_at
    `;

    const row = rows[0];
    if (!row) throw new Error('issueApiKey wrote no row');
    return { record: toRecord(row), token };
  });
}

export async function listApiKeys(handle: DbHandle, orgId: string): Promise<ApiKeyRecord[]> {
  const rows = await handle.sql<KeyRow[]>`
    select id, org_id, label, key_prefix, scope, profile_ids, expires_at, revoked_at, last_used_at, created_at
    from mcp.api_keys
    where org_id = ${orgId}
    order by created_at desc
  `;
  return rows.map(toRecord);
}

/** Revoking is idempotent and irreversible. Returns false when the id is unknown. */
export async function revokeApiKey(handle: DbHandle, keyId: string): Promise<boolean> {
  const rows = await handle.sql<{ id: string }[]>`
    update mcp.api_keys set revoked_at = coalesce(revoked_at, now())
    where id = ${keyId}
    returning id
  `;
  return rows.length === 1;
}

/**
 * Resolve a presented token to a read-only key, stamp its last-used time, or
 * throw an `AuthError`.
 *
 * Every failure is a 401 with the same message. Distinguishing "no such key"
 * from "revoked" from "expired" tells an attacker which of their guesses was
 * once real, and tells a legitimate operator nothing they cannot read off the
 * key list.
 */
export async function verifyApiKey(handle: DbHandle, token: string): Promise<ApiKeyRecord> {
  const unauthorized = new AuthError(401, 'invalid or revoked API key');
  if (!token.startsWith(TOKEN_PREFIX) || token.length < TOKEN_PREFIX.length + 20) {
    throw unauthorized;
  }

  const hash = hashToken(token);
  const rows = await handle.sql<(KeyRow & { token_hash: string })[]>`
    update mcp.api_keys
       set last_used_at = now()
     where token_hash = ${hash}
       and scope = 'read'
       and revoked_at is null
       and profile_ids is not null
       and cardinality(profile_ids) > 0
       and expires_at is not null
       and expires_at > now()
       and expires_at <= created_at + make_interval(days => ${MAX_API_KEY_LIFETIME_DAYS})
    returning id, org_id, label, key_prefix, token_hash, scope, profile_ids,
              expires_at, revoked_at, last_used_at, created_at
  `;

  const row = rows[0];
  if (!row) throw unauthorized;
  // The lookup already matched on the hash; the constant-time compare is here
  // so the code does not depend on the index comparison being safe.
  if (!constantTimeEquals(row.token_hash, hash)) throw unauthorized;
  if (row.scope !== 'read') throw unauthorized;

  return toRecord(row);
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
