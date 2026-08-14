/**
 * MCP API keys, read and written from the web app.
 *
 * WP-09 shipped the model — the `mcp.api_keys` table (migration
 * `20260814120000_mcp_api_keys.sql`), the `apps/mcp` server that verifies a
 * bearer token against it, and a `keys` CLI that issues one. What it did not
 * ship is the surface an operator uses without a terminal. This file is that
 * surface's data layer: it issues, lists and revokes keys against the same
 * table, using the same token shape the server verifies.
 *
 * The token shape is copied deliberately, not imported: `apps/mcp/src/keys.ts`
 * is the spec (an app is not a library and `apps/web` must not depend on a
 * sibling app), so the constants below — the `wza_` prefix, the 32 random bytes,
 * the SHA-256 hex hash, the 12-character stored prefix — must stay identical to
 * it or a key issued here will not verify there. v1 issues **read-only** keys,
 * exactly as the CLI does.
 *
 * The plaintext token exists only in `issueMcpKey`'s return value and is never
 * stored — only its hash and a short prefix are — so a lost token is reissued,
 * never recovered.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Sql } from '@wizard-ads/db';

/** Structural handle: both the pooled `DbHandle` and the per-request one fit. */
export interface SqlHandle {
  sql: Sql;
}

const TOKEN_PREFIX = 'wza_';
const STORED_PREFIX_LENGTH = 12;

function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface McpKeyRecord {
  id: string;
  label: string;
  keyPrefix: string;
  scope: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface IssuedMcpKey {
  record: McpKeyRecord;
  /** The plaintext token — shown once, never persisted, never retrievable. */
  token: string;
}

interface KeyRow {
  id: string;
  label: string;
  key_prefix: string;
  scope: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

function toRecord(row: KeyRow): McpKeyRecord {
  return {
    id: row.id,
    label: row.label,
    keyPrefix: row.key_prefix,
    scope: row.scope,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

/** Every key an org has, newest first — active and revoked alike. */
export async function listMcpKeys(handle: SqlHandle, orgId: string): Promise<McpKeyRecord[]> {
  const rows = await handle.sql<KeyRow[]>`
    select id, label, key_prefix, scope::text as scope,
           expires_at::text as expires_at, revoked_at::text as revoked_at,
           last_used_at::text as last_used_at, created_at::text as created_at
      from mcp.api_keys
     where org_id = ${orgId}
     order by created_at desc
  `;
  return rows.map(toRecord);
}

export interface IssueMcpKeyInput {
  orgId: string;
  label: string;
  /** The auth user issuing it, recorded for the audit trail. */
  createdBy?: string | null;
}

/**
 * Issue one read-only key, scoped to every profile in the org.
 *
 * Read-only and org-wide is the deliberate v1 shape: the MCP surface is an
 * analyst, and narrowing a key to a profile subset or granting it write is a
 * later capability, not a default an operator can reach for by accident.
 */
export async function issueMcpKey(handle: SqlHandle, input: IssueMcpKeyInput): Promise<IssuedMcpKey> {
  const label = input.label.trim();
  if (label.length === 0) throw new Error('A key needs a label so you can tell your keys apart.');

  const token = generateToken();
  const rows = await handle.sql<KeyRow[]>`
    insert into mcp.api_keys (org_id, label, key_prefix, token_hash, scope, created_by)
    values (
      ${input.orgId},
      ${label},
      ${token.slice(0, STORED_PREFIX_LENGTH)},
      ${hashToken(token)},
      'read',
      ${input.createdBy ?? null}
    )
    returning id, label, key_prefix, scope::text as scope,
              expires_at::text as expires_at, revoked_at::text as revoked_at,
              last_used_at::text as last_used_at, created_at::text as created_at
  `;
  const row = rows[0];
  if (row === undefined) throw new Error('The key could not be stored.');
  return { record: toRecord(row), token };
}

/**
 * Revoke a key. Idempotent (a second revoke keeps the first timestamp) and
 * tenant-scoped, so one org can never revoke another's key by pasting an id.
 * Returns false when no key with that id belongs to the org.
 */
export async function revokeMcpKey(handle: SqlHandle, orgId: string, keyId: string): Promise<boolean> {
  const rows = await handle.sql<{ id: string }[]>`
    update mcp.api_keys
       set revoked_at = coalesce(revoked_at, now())
     where id = ${keyId} and org_id = ${orgId}
     returning id
  `;
  return rows.length > 0;
}
