/**
 * What happens between "Amazon redirected back" and "the roster is on screen".
 *
 * Written as one function taking a port and a database handle, so the whole
 * flow is exercised by tests against a real migrated database with a fake
 * Amazon, which is the only honest way to test it: the live redirect URI is not
 * registered yet, and a suite that mocks the database as well would prove
 * nothing about the upsert.
 *
 * Order matters here and is not arbitrary:
 *
 *  1. Exchange the code. It is single-use and short-lived; if this fails,
 *     nothing has been written and the operator simply starts again.
 *  2. Upsert the connection row, then put the refresh token in Vault through
 *     `storeAdsRefreshToken`. The RPC needs a connection id to hang the secret
 *     off, so the row has to exist first; the RPC is also what flips the row to
 *     `active`, so a row without a credential is visibly `pending`.
 *  3. Fetch profiles per region and upsert them, counting listed against
 *     upserted and refusing to report success on a mismatch (program rule 4).
 *
 * A region that errors is recorded and the others continue. Grants routinely
 * cover one or two of the three regions, and failing the whole connection
 * because FE returned 401 would throw away a working NA grant.
 */
import { storeAdsRefreshToken } from '@wizard-ads/db';
import type { DbHandle } from '@wizard-ads/db';
import type { Region } from '@wizard-ads/shared';
import { REGIONS } from '../../../../../src/env';
import type { AmazonAdsProfile, AmazonOAuthPort } from './lwa';

export interface ConnectInput {
  orgId: string;
  /** The admin who authorised. Recorded on the connection row. */
  userId: string;
  /** Unique per org; reconnecting reuses it rather than making a second row. */
  label: string;
  lwaClientId: string;
  scope: string;
  code: string;
}

export interface RegionOutcome {
  region: Region;
  /** Profiles Amazon listed. */
  listed: number;
  /** Rows the upsert wrote. Equal to `listed` or the connection failed. */
  upserted: number;
  /** Of those, rows that did not exist before this connect. */
  created: number;
  error: string | null;
}

export interface ConnectResult {
  connectionId: string;
  regions: RegionOutcome[];
  totalListed: number;
  totalUpserted: number;
}

export async function completeConnection(
  handle: DbHandle,
  port: AmazonOAuthPort,
  input: ConnectInput,
): Promise<ConnectResult> {
  const tokens = await port.exchangeAuthorizationCode(input.code);

  const connectionId = await upsertConnection(handle, input, tokens.scope ?? input.scope);
  // The refresh token never touches a column, a log line or this module's
  // return value. It goes into Vault through the security-definer RPC and is
  // read back only by the worker, only as the service role.
  await storeAdsRefreshToken(handle, connectionId, tokens.refreshToken);

  const regions: RegionOutcome[] = [];
  for (const region of REGIONS) {
    try {
      const profiles = await port.listProfiles(region, tokens.accessToken);
      const written = await upsertProfiles(handle, input.orgId, connectionId, region, profiles);
      if (written.upserted !== profiles.length) {
        throw new Error(
          `${region}: Amazon listed ${profiles.length} profile(s) but ${written.upserted} row(s) ` +
            'were written. Refusing to report a partial roster as a success.',
        );
      }
      regions.push({
        region,
        listed: profiles.length,
        upserted: written.upserted,
        created: written.created,
        error: null,
      });
    } catch (error) {
      regions.push({
        region,
        listed: 0,
        upserted: 0,
        created: 0,
        error: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  const failures = regions.filter((outcome) => outcome.error !== null);
  if (failures.length === REGIONS.length) {
    // Every region refused: the grant is not usable, so the connection says so
    // rather than sitting at `active` with an empty roster.
    await markConnectionError(
      handle,
      connectionId,
      failures.map((outcome) => `${outcome.region}: ${outcome.error}`).join(' | '),
    );
  }

  return {
    connectionId,
    regions,
    totalListed: regions.reduce((sum, outcome) => sum + outcome.listed, 0),
    totalUpserted: regions.reduce((sum, outcome) => sum + outcome.upserted, 0),
  };
}

async function upsertConnection(
  handle: DbHandle,
  input: ConnectInput,
  scope: string,
): Promise<string> {
  const rows = await handle.sql<{ id: string }[]>`
    insert into public.ads_connections
      (org_id, label, lwa_client_id, scope, connected_by, connected_at, status, last_error)
    values
      (${input.orgId}, ${input.label}, ${input.lwaClientId}, ${scope}, ${input.userId},
       now(), 'pending', null)
    on conflict (org_id, label) do update
      set lwa_client_id = excluded.lwa_client_id,
          scope = excluded.scope,
          connected_by = excluded.connected_by,
          connected_at = now(),
          last_error = null
    returning id
  `;
  const row = rows[0];
  if (!row) throw new Error('the connection row was not written');
  return row.id;
}

interface UpsertCounts {
  upserted: number;
  created: number;
}

/**
 * Write one region's profiles.
 *
 * `sync_enabled`, `target_acos`, `target_total_acos`, `goal_lens` and
 * `monthly_budget` are deliberately absent from the update list. They are the
 * operator's settings; re-running the connect flow must not silently re-disable
 * a synced profile or wipe a target that took a conversation to agree.
 */
async function upsertProfiles(
  handle: DbHandle,
  orgId: string,
  connectionId: string,
  region: Region,
  profiles: readonly AmazonAdsProfile[],
): Promise<UpsertCounts> {
  if (profiles.length === 0) return { upserted: 0, created: 0 };

  const values = profiles.map((profile) => ({
    org_id: orgId,
    connection_id: connectionId,
    amazon_profile_id: profile.profileId,
    region,
    country_code: profile.countryCode,
    currency_code: profile.currencyCode,
    timezone: profile.timezone,
    account_type: profile.accountType,
    account_name: profile.accountName,
    amazon_account_id: profile.amazonAccountId,
  }));

  const rows = await handle.sql<{ created: boolean }[]>`
    insert into public.ad_profiles ${handle.sql(
      values,
      'org_id',
      'connection_id',
      'amazon_profile_id',
      'region',
      'country_code',
      'currency_code',
      'timezone',
      'account_type',
      'account_name',
      'amazon_account_id',
    )}
    on conflict (org_id, amazon_profile_id) do update
      set connection_id = excluded.connection_id,
          region = excluded.region,
          country_code = excluded.country_code,
          currency_code = excluded.currency_code,
          -- A timezone an operator pinned by hand sticks: Amazon's re-sync
          -- reports the marketplace timezone, but a manual choice (the
          -- account's own reporting calendar) must survive the next connect.
          timezone = case
            when ad_profiles.timezone_locked then ad_profiles.timezone
            else excluded.timezone
          end,
          account_type = excluded.account_type,
          account_name = excluded.account_name,
          amazon_account_id = excluded.amazon_account_id
    returning (xmax = 0) as created
  `;

  return {
    upserted: rows.length,
    created: rows.filter((row) => row.created).length,
  };
}

async function markConnectionError(
  handle: DbHandle,
  connectionId: string,
  message: string,
): Promise<void> {
  await handle.sql`
    update public.ads_connections
       set status = 'error', last_error = ${message.slice(0, 1000)}
     where id = ${connectionId}
  `;
}
