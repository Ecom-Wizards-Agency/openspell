/**
 * External integration connection metadata and credential custody.
 *
 * Metadata helpers are always org-scoped because the web handle is the service
 * role and therefore bypasses RLS. Their public record exposes only whether a
 * credential exists, never the Vault pointer. The three RPC wrappers preserve
 * the database custody boundary used by workers and the one-time web write.
 */
import type { DbHandle } from '../client.js';
import type { INTEGRATION_PROVIDERS, connectionStatus } from '../schema/enums.js';
import type { IntegrationConfig } from '../schema/integrations.js';
import { toDate, toDateOrNull } from './pg-time.js';

export type IntegrationQueryHandle = Pick<DbHandle, 'sql'>;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];
export type IntegrationConnectionStatus = (typeof connectionStatus.enumValues)[number];

export interface IntegrationConnectionRecord {
  id: string;
  orgId: string;
  provider: IntegrationProvider;
  label: string;
  config: IntegrationConfig;
  status: IntegrationConnectionStatus;
  hasSecret: boolean;
  connectedBy: string | null;
  connectedAt: Date | null;
  lastSyncedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateIntegrationConnectionInput {
  orgId: string;
  provider: IntegrationProvider;
  label: string;
  connectedBy?: string | null;
  config?: IntegrationConfig;
}

export interface SetIntegrationConnectionStatusInput {
  orgId: string;
  connectionId: string;
  status: IntegrationConnectionStatus;
  lastError?: string | null;
}

interface IntegrationConnectionRow {
  id: string;
  org_id: string;
  provider: IntegrationProvider;
  label: string;
  config: IntegrationConfig;
  status: IntegrationConnectionStatus;
  has_secret: boolean;
  connected_by: string | null;
  connected_at: Date | string | null;
  last_synced_at: Date | string | null;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const toRecord = (row: IntegrationConnectionRow): IntegrationConnectionRecord => ({
  id: row.id,
  orgId: row.org_id,
  provider: row.provider,
  label: row.label,
  config: row.config ?? {},
  status: row.status,
  hasSecret: row.has_secret,
  connectedBy: row.connected_by,
  connectedAt: toDateOrNull(row.connected_at),
  lastSyncedAt: toDateOrNull(row.last_synced_at),
  lastError: row.last_error,
  createdAt: toDate(row.created_at),
  updatedAt: toDate(row.updated_at),
});

function normalizeLabel(value: string): string {
  const label = value.trim();
  if (!label) throw new Error('An integration connection label cannot be empty');
  return label;
}

function serializeConfig(config: IntegrationConfig | undefined): string {
  const serialized = JSON.stringify(config ?? {});
  if (serialized === undefined) throw new Error('Integration config must be JSON-serializable');
  return serialized;
}

/** List one organisation's connections without exposing Vault ids or values. */
export async function listIntegrationConnections(
  handle: IntegrationQueryHandle,
  orgId: string,
): Promise<IntegrationConnectionRecord[]> {
  const rows = await handle.sql<IntegrationConnectionRow[]>`
    select c.id, c.org_id, c.provider::text as provider, c.label, c.config,
           c.status::text as status,
           (c.vault_secret_id is not null) as has_secret,
           c.connected_by, c.connected_at, c.last_synced_at, c.last_error,
           c.created_at, c.updated_at
      from public.integration_connections c
     where c.org_id = ${orgId}
     order by c.provider, lower(c.label), c.created_at, c.id
  `;
  return rows.map(toRecord);
}

/** Create pending metadata. Store the credential through `storeIntegrationSecret` next. */
export async function createIntegrationConnection(
  handle: IntegrationQueryHandle,
  input: CreateIntegrationConnectionInput,
): Promise<IntegrationConnectionRecord> {
  const rows = await handle.sql<IntegrationConnectionRow[]>`
    insert into public.integration_connections
      (org_id, provider, label, connected_by, config)
    values (
      ${input.orgId}, ${input.provider}::public.integration_provider, ${normalizeLabel(input.label)},
      ${input.connectedBy ?? null}, ${serializeConfig(input.config)}::text::jsonb
    )
    returning id, org_id, provider::text as provider, label, config,
              status::text as status, (vault_secret_id is not null) as has_secret,
              connected_by, connected_at, last_synced_at, last_error, created_at, updated_at
  `;
  const row = rows[0];
  if (!row) throw new Error('Creating an integration connection returned no row');
  return toRecord(row);
}

/** Set provider health state/error, scoped to the owning organisation. */
export async function setIntegrationConnectionStatus(
  handle: IntegrationQueryHandle,
  input: SetIntegrationConnectionStatusInput,
): Promise<IntegrationConnectionRecord> {
  const rows = await handle.sql<IntegrationConnectionRow[]>`
    update public.integration_connections
       set status = ${input.status}::public.connection_status,
           last_error = ${input.lastError ?? null}
     where org_id = ${input.orgId} and id = ${input.connectionId}
    returning id, org_id, provider::text as provider, label, config,
              status::text as status, (vault_secret_id is not null) as has_secret,
              connected_by, connected_at, last_synced_at, last_error, created_at, updated_at
  `;
  const row = rows[0];
  if (!row) throw new Error('Integration connection not found');
  return toRecord(row);
}

/** Store or rotate a credential. Returns the safe-to-log Vault row id, never the value. */
export async function storeIntegrationSecret(
  handle: IntegrationQueryHandle,
  connectionId: string,
  value: string,
): Promise<string> {
  const rows = await handle.sql<{ store_integration_secret: string }[]>`
    select public.store_integration_secret(${connectionId}, ${value})
  `;
  const secretId = rows[0]?.store_integration_secret;
  if (!secretId) throw new Error('store_integration_secret returned no secret id');
  return secretId;
}

/** Read a credential back. Service-role worker only; null means none is stored. */
export async function getIntegrationSecret(
  handle: IntegrationQueryHandle,
  connectionId: string,
): Promise<string | null> {
  const rows = await handle.sql<{ get_integration_secret: string | null }[]>`
    select public.get_integration_secret(${connectionId})
  `;
  return rows[0]?.get_integration_secret ?? null;
}

/** Delete the Vault row and mark the connection revoked. True when a secret existed. */
export async function revokeIntegrationSecret(
  handle: IntegrationQueryHandle,
  connectionId: string,
): Promise<boolean> {
  const rows = await handle.sql<{ revoke_integration_secret: boolean }[]>`
    select public.revoke_integration_secret(${connectionId})
  `;
  return rows[0]?.revoke_integration_secret ?? false;
}
