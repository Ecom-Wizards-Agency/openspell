/**
 * Connection lookups the worker needs to build an Amazon client.
 *
 * The refresh token itself never lives here — it moves only through the Vault
 * `security definer` functions in `tokens.ts`. These two reads answer the
 * questions those functions cannot: which connection a profile belongs to, and
 * which connections can be probed in a region. Both are plain, non-secret
 * columns.
 */
import type { Region } from '@wizard-ads/shared';
import type { DbHandle } from '../client.js';

/**
 * The connection a profile is grafted onto, or null when it has none (a profile
 * whose connection was deleted keeps its row with `connection_id` null).
 */
export async function getProfileConnectionId(
  handle: DbHandle,
  profileId: string,
): Promise<string | null> {
  const rows = await handle.sql<{ connection_id: string | null }[]>`
    select connection_id from public.ad_profiles where id = ${profileId}
  `;
  return rows[0]?.connection_id ?? null;
}

/**
 * Active connections with a stored credential that have at least one profile in
 * `region`. The auth healthcheck probes exactly these: a connection with no
 * profile in a region gives no host to ask, and a connection with no vault
 * secret has nothing to authenticate with.
 */
export async function listActiveConnectionIdsForRegion(
  handle: DbHandle,
  region: Region,
): Promise<string[]> {
  const rows = await handle.sql<{ id: string }[]>`
    select distinct c.id
      from public.ads_connections c
      join public.ad_profiles p on p.connection_id = c.id
     where c.status = 'active'
       and c.vault_secret_id is not null
       and p.region = ${region}
  `;
  return rows.map((row) => row.id);
}
