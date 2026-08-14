/**
 * The Amazon connection, as the settings page needs it.
 *
 * `vault_secret_id` is selected only as a boolean. The web tier has no reason
 * to know the id and every reason not to print it, so the query answers "is
 * there a credential" and stops there.
 */
import type { DbHandle } from '@wizard-ads/db';

export type ConnectionStatus = 'pending' | 'active' | 'error' | 'revoked';

export interface ConnectionSummary {
  id: string;
  label: string;
  status: ConnectionStatus;
  scope: string | null;
  hasCredential: boolean;
  connectedAt: string | null;
  lastHealthCheckAt: string | null;
  lastError: string | null;
  profileCount: number;
}

export async function listConnections(
  handle: DbHandle,
  orgId: string,
): Promise<ConnectionSummary[]> {
  const rows = await handle.sql<
    {
      id: string;
      label: string;
      status: ConnectionStatus;
      scope: string | null;
      has_credential: boolean;
      connected_at: string | null;
      last_health_check_at: string | null;
      last_error: string | null;
      profile_count: string;
    }[]
  >`
    select c.id,
           c.label,
           c.status::text as status,
           c.scope,
           (c.vault_secret_id is not null) as has_credential,
           c.connected_at::text as connected_at,
           c.last_health_check_at::text as last_health_check_at,
           c.last_error,
           count(p.id) as profile_count
      from public.ads_connections c
      left join public.ad_profiles p on p.connection_id = c.id
     where c.org_id = ${orgId}
     group by c.id
     order by c.created_at
  `;
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    status: row.status,
    scope: row.scope,
    hasCredential: row.has_credential,
    connectedAt: row.connected_at,
    lastHealthCheckAt: row.last_health_check_at,
    lastError: row.last_error,
    profileCount: Number(row.profile_count),
  }));
}
