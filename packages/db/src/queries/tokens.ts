/**
 * Amazon credential custody.
 *
 * Three thin wrappers, and the thinness is the point: the rules live in the
 * database (`security definer`, service role only, value in Vault) so they
 * cannot be forgotten by a caller. This file never logs a value, never returns
 * one except to the worker that asked for it, and never accepts one it would
 * store in a column.
 *
 * These calls fail with a permission error under any client that is not the
 * service role. That is the intended behaviour, and `vault.test.ts` asserts it.
 */
import type { DbHandle } from '../client.js';

/**
 * Put a credential into Vault and point the connection at it. Returns the vault
 * secret id, which is safe to log; the value itself never comes back.
 */
export async function storeAdsRefreshToken(
  handle: DbHandle,
  connectionId: string,
  value: string,
): Promise<string> {
  const rows = await handle.sql<{ store_ads_refresh_token: string }[]>`
    select public.store_ads_refresh_token(${connectionId}, ${value})
  `;
  const secretId = rows[0]?.store_ads_refresh_token;
  if (!secretId) throw new Error('store_ads_refresh_token returned no secret id');
  return secretId;
}

/** Read a credential back. Worker only. Null when the connection has none. */
export async function getAdsRefreshToken(
  handle: DbHandle,
  connectionId: string,
): Promise<string | null> {
  const rows = await handle.sql<{ get_ads_refresh_token: string | null }[]>`
    select public.get_ads_refresh_token(${connectionId})
  `;
  return rows[0]?.get_ads_refresh_token ?? null;
}

/** Delete the secret and mark the connection revoked. True if there was one. */
export async function revokeAdsRefreshToken(
  handle: DbHandle,
  connectionId: string,
): Promise<boolean> {
  const rows = await handle.sql<{ revoke_ads_refresh_token: boolean }[]>`
    select public.revoke_ads_refresh_token(${connectionId})
  `;
  return rows[0]?.revoke_ads_refresh_token ?? false;
}
