/**
 * SP-API authorization metadata and weekly SQP scheduling inputs.
 *
 * Credential values cross only the three service-role Vault RPCs. Every
 * metadata query is explicitly org-scoped even though the worker handle uses
 * the service role and therefore bypasses RLS.
 */
import type { Region } from '@wizard-ads/shared';
import type { DbHandle } from '../client.js';

export interface SpApiConnectionRecord {
  id: string;
  orgId: string;
  label: string;
  sellingPartnerId: string | null;
  marketplaceIds: string[];
  status: 'pending' | 'active' | 'revoked' | 'error';
  hasCredential: boolean;
}

export interface ActiveSpApiProfileBinding {
  orgId: string;
  profileId: string;
  connectionId: string;
  marketplaceId: string;
  region: Region;
  timezone: string;
}

export interface SqpScheduleScope extends ActiveSpApiProfileBinding {
  asins: string[];
  sourceRows: number;
  duplicateRows: number;
  refusedRows: number;
}

type SpApiConnectionRow = {
  id: string;
  org_id: string;
  label: string;
  selling_partner_id: string | null;
  marketplace_ids: string[];
  status: SpApiConnectionRecord['status'];
  has_credential: boolean;
};

function toConnection(row: SpApiConnectionRow): SpApiConnectionRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    label: row.label,
    sellingPartnerId: row.selling_partner_id,
    marketplaceIds: row.marketplace_ids,
    status: row.status,
    hasCredential: row.has_credential,
  };
}

function normalizeMarketplaceIds(values: readonly string[]): string[] {
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
  if (normalized.length === 0 || normalized.some((value) => value.length > 64)) {
    throw new Error('An SP-API connection requires valid marketplace ids');
  }
  return normalized;
}

/** Create or resume one connection metadata row without handling its credential. */
export async function createSpApiConnection(
  handle: Pick<DbHandle, 'sql'>,
  input: {
    orgId: string;
    label: string;
    sellingPartnerId?: string | null;
    marketplaceIds: readonly string[];
  },
): Promise<SpApiConnectionRecord> {
  const label = input.label.trim();
  if (!label) throw new Error('An SP-API connection label cannot be empty');
  const marketplaceIds = normalizeMarketplaceIds(input.marketplaceIds);
  const rows = await handle.sql<SpApiConnectionRow[]>`
    insert into public.spapi_connections
      (org_id, label, selling_partner_id, marketplace_ids, status)
    values
      (${input.orgId}, ${label}, ${input.sellingPartnerId?.trim() || null}, ${marketplaceIds}, 'pending')
    on conflict (org_id, label) do update
      set selling_partner_id = excluded.selling_partner_id,
          marketplace_ids = excluded.marketplace_ids,
          status = case
            when spapi_connections.vault_secret_id is null then 'pending'::public.connection_status
            else spapi_connections.status
          end,
          last_error = null
    returning id, org_id, label, selling_partner_id, marketplace_ids,
              status::text as status, (vault_secret_id is not null) as has_credential
  `;
  const row = rows[0];
  if (!row) throw new Error('Creating an SP-API connection returned no row');
  return toConnection(row);
}

/** Assign one profile atomically; the migration rejects cross-org/mismatched marketplaces. */
export async function upsertSpApiProfileBinding(
  handle: Pick<DbHandle, 'sql'>,
  input: {
    orgId: string;
    profileId: string;
    connectionId: string;
    marketplaceId: string;
    enabled?: boolean;
  },
): Promise<ActiveSpApiProfileBinding & { enabled: boolean }> {
  const marketplaceId = input.marketplaceId.trim();
  if (!marketplaceId) throw new Error('An SP-API profile binding requires a marketplace id');
  const rows = await handle.sql<Array<{
    org_id: string;
    profile_id: string;
    connection_id: string;
    marketplace_id: string;
    enabled: boolean;
    region: Region;
    timezone: string;
  }>>`
    with bound as (
      insert into public.spapi_profile_bindings
        (org_id, profile_id, connection_id, marketplace_id, enabled)
      values
        (${input.orgId}, ${input.profileId}, ${input.connectionId}, ${marketplaceId}, ${input.enabled ?? true})
      on conflict (profile_id) do update
        set connection_id = excluded.connection_id,
            marketplace_id = excluded.marketplace_id,
            enabled = excluded.enabled
      where spapi_profile_bindings.org_id = excluded.org_id
      returning org_id, profile_id, connection_id, marketplace_id, enabled
    )
    select b.org_id, b.profile_id, b.connection_id, b.marketplace_id, b.enabled,
           p.region::text as region, p.timezone
      from bound b
      join public.ad_profiles p on p.id = b.profile_id and p.org_id = b.org_id
  `;
  const row = rows[0];
  if (!row) throw new Error('Assigning the SP-API profile binding returned no row');
  return {
    orgId: row.org_id,
    profileId: row.profile_id,
    connectionId: row.connection_id,
    marketplaceId: row.marketplace_id,
    region: row.region,
    timezone: row.timezone,
    enabled: row.enabled,
  };
}

export class SpApiCredentialStoreError extends Error {
  constructor() {
    super('The SP-API credential could not be stored');
    this.name = 'SpApiCredentialStoreError';
  }
}

/** Store or rotate the refresh credential without allowing it onto a query error. */
export async function storeSpApiRefreshToken(
  handle: Pick<DbHandle, 'sql'>,
  input: { orgId: string; connectionId: string; refreshToken: string },
): Promise<string> {
  let rows: Array<{ secret_id: string }>;
  try {
    rows = await handle.sql<Array<{ secret_id: string }>>`
      select public.store_spapi_refresh_token(c.id, ${input.refreshToken}) as secret_id
        from public.spapi_connections c
       where c.org_id = ${input.orgId} and c.id = ${input.connectionId}
    `;
  } catch {
    throw new SpApiCredentialStoreError();
  }
  const secretId = rows[0]?.secret_id;
  if (!secretId) throw new Error('SP-API connection not found');
  return secretId;
}

/** Worker-only exact-org credential read. Null means missing, inactive, or mismatched. */
export async function getSpApiRefreshToken(
  handle: Pick<DbHandle, 'sql'>,
  input: { orgId: string; connectionId: string },
): Promise<string | null> {
  const rows = await handle.sql<Array<{ refresh_token: string | null }>>`
    select public.get_spapi_refresh_token(c.id) as refresh_token
      from public.spapi_connections c
     where c.org_id = ${input.orgId}
       and c.id = ${input.connectionId}
       and c.status = 'active'
       and c.vault_secret_id is not null
  `;
  return rows[0]?.refresh_token ?? null;
}

export async function revokeSpApiRefreshToken(
  handle: Pick<DbHandle, 'sql'>,
  input: { orgId: string; connectionId: string },
): Promise<boolean> {
  const rows = await handle.sql<Array<{ revoked: boolean }>>`
    select public.revoke_spapi_refresh_token(c.id) as revoked
      from public.spapi_connections c
     where c.org_id = ${input.orgId} and c.id = ${input.connectionId}
  `;
  return rows[0]?.revoked ?? false;
}

/** Re-check exact tenant/profile/marketplace ownership before every queued workflow. */
export async function resolveActiveSpApiProfileBinding(
  handle: Pick<DbHandle, 'sql'>,
  input: { orgId: string; profileId: string; marketplaceId: string },
): Promise<ActiveSpApiProfileBinding | null> {
  const rows = await handle.sql<Array<{
    org_id: string;
    profile_id: string;
    connection_id: string;
    marketplace_id: string;
    region: Region;
    timezone: string;
  }>>`
    select b.org_id, b.profile_id, b.connection_id, b.marketplace_id,
           p.region::text as region, p.timezone
      from public.spapi_profile_bindings b
      join public.ad_profiles p
        on p.id = b.profile_id and p.org_id = b.org_id
      join public.spapi_connections c
        on c.id = b.connection_id and c.org_id = b.org_id
     where b.org_id = ${input.orgId}
       and b.profile_id = ${input.profileId}
       and b.marketplace_id = ${input.marketplaceId}
       and b.enabled
       and p.sync_enabled
       and c.status = 'active'
       and c.vault_secret_id is not null
       and nullif(btrim(c.selling_partner_id), '') is not null
       and b.marketplace_id = any(c.marketplace_ids)
       and p.region = app.spapi_region_for_marketplace(b.marketplace_id)
  `;
  const row = rows[0];
  return row
    ? {
        orgId: row.org_id,
        profileId: row.profile_id,
        connectionId: row.connection_id,
        marketplaceId: row.marketplace_id,
        region: row.region,
        timezone: row.timezone,
      }
    : null;
}

/**
 * All enabled SQP scopes plus reconciled advertised-ASIN counts.
 *
 * `sourceRows = unique ASINs + duplicates + refused` is asserted after the SQL
 * boundary so an Amazon mirror shape change cannot silently shrink scheduling.
 */
export async function listSqpScheduleScopes(
  handle: Pick<DbHandle, 'sql'>,
): Promise<SqpScheduleScope[]> {
  const rows = await handle.sql<Array<{
    org_id: string;
    profile_id: string;
    connection_id: string;
    marketplace_id: string;
    region: Region;
    timezone: string;
    asins: string[];
    source_rows: string;
    valid_rows: string;
    refused_rows: string;
  }>>`
    select b.org_id, b.profile_id, b.connection_id, b.marketplace_id,
           p.region::text as region, p.timezone,
           coalesce(products.asins, array[]::text[]) as asins,
           coalesce(products.source_rows, 0)::text as source_rows,
           coalesce(products.valid_rows, 0)::text as valid_rows,
           coalesce(products.refused_rows, 0)::text as refused_rows
      from public.spapi_profile_bindings b
      join public.ad_profiles p
        on p.id = b.profile_id and p.org_id = b.org_id
      join public.spapi_connections c
        on c.id = b.connection_id and c.org_id = b.org_id
      left join lateral (
        select
          array_agg(distinct upper(btrim(pa.asin)) order by upper(btrim(pa.asin)))
            filter (where btrim(pa.asin) ~ '^[A-Za-z0-9]{10}$') as asins,
          count(*) as source_rows,
          count(*) filter (where btrim(pa.asin) ~ '^[A-Za-z0-9]{10}$') as valid_rows,
          count(*) filter (where pa.asin is null or btrim(pa.asin) !~ '^[A-Za-z0-9]{10}$') as refused_rows
        from public.product_ads pa
        where pa.org_id = b.org_id
          and pa.profile_id = b.profile_id
          and pa.deleted_at is null
      ) products on true
     where b.enabled
       and p.sync_enabled
       and c.status = 'active'
       and c.vault_secret_id is not null
       and nullif(btrim(c.selling_partner_id), '') is not null
       and b.marketplace_id = any(c.marketplace_ids)
       and p.region = app.spapi_region_for_marketplace(b.marketplace_id)
     order by b.org_id, b.profile_id
  `;

  return rows.map((row) => {
    const sourceRows = Number(row.source_rows);
    const validRows = Number(row.valid_rows);
    const refusedRows = Number(row.refused_rows);
    const duplicateRows = validRows - row.asins.length;
    if (
      !Number.isSafeInteger(sourceRows) || !Number.isSafeInteger(validRows) ||
      !Number.isSafeInteger(refusedRows) || duplicateRows < 0 ||
      sourceRows !== row.asins.length + duplicateRows + refusedRows
    ) {
      throw new Error('SP-API SQP scheduling ASIN counts do not reconcile');
    }
    return {
      orgId: row.org_id,
      profileId: row.profile_id,
      connectionId: row.connection_id,
      marketplaceId: row.marketplace_id,
      region: row.region,
      timezone: row.timezone,
      asins: row.asins,
      sourceRows,
      duplicateRows,
      refusedRows,
    };
  });
}
