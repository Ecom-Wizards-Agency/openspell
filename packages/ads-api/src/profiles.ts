/**
 * `GET /v2/profiles`: which advertisers this grant can see.
 *
 * Still v2, still the only way to enumerate profiles, and the first call any
 * new connection makes. WP-04's OAuth callback runs it immediately after the
 * code exchange to populate the profile roster, which is why the entry points
 * here are free functions: at that moment there is a grant and no profile, so
 * there is nothing to scope a client to yet.
 *
 * A grant spans regions and a profile lives on exactly one host, so discovery
 * means asking all three. `listProfilesAcrossRegions` therefore reports
 * per-region failures instead of throwing: an advertiser with only EU accounts
 * gets a 401 from NA and FE, and that is a normal result, not an outage. The
 * reference does the same thing (`test_profiles` prints the failure and
 * continues).
 */
import type { Region } from '@wizard-ads/shared';
import { TokenProvider } from './auth.js';
import { createHttpContext, type EffectOptions } from './context.js';
import { AdsApiParseError } from './errors.js';
import { adsHeaders } from './headers.js';
import { decodeText, httpRequest, type HttpContext } from './http.js';
import { ALL_REGIONS, hostFor } from './regions.js';
import { isRecord, readId, readNumber, readRecord, readString } from './read.js';
import type { AdsCredentials } from './types.js';

export type ProfileAccountType = 'seller' | 'vendor' | 'agency';

export interface AdsProfile {
  /** Amazon's profile id. A string here; it is a JSON number on the wire. */
  profileId: string;
  /** Which host answered. A profile is only addressable on this one. */
  region: Region;
  countryCode: string | null;
  currencyCode: string | null;
  /** The profile's own timezone. Every "day" in this product is a day here. */
  timezone: string | null;
  dailyBudget: number | null;
  accountType: ProfileAccountType | null;
  accountName: string | null;
  /** Seller id or vendor code, as `accountInfo.id`. */
  amazonAccountId: string | null;
  marketplaceStringId: string | null;
}

function mapAccountType(value: string | null): ProfileAccountType | null {
  if (value === null) return null;
  const normalized = value.toLowerCase();
  if (normalized === 'seller' || normalized === 'vendor' || normalized === 'agency') {
    return normalized;
  }
  return null;
}

/** Rows Amazon sends that carry no profile id are dropped, and counted. */
export function parseProfiles(raw: unknown, region: Region): AdsProfile[] {
  if (!Array.isArray(raw)) {
    throw new AdsApiParseError('GET /v2/profiles did not return a JSON array');
  }
  const profiles: AdsProfile[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const profileId = readId(entry, 'profileId');
    if (profileId === null) continue;
    const accountInfo = readRecord(entry, 'accountInfo');
    profiles.push({
      profileId,
      region,
      countryCode: readString(entry, 'countryCode'),
      currencyCode: readString(entry, 'currencyCode'),
      timezone: readString(entry, 'timezone'),
      dailyBudget: readNumber(entry, 'dailyBudget'),
      accountType: accountInfo === null ? null : mapAccountType(readString(accountInfo, 'type')),
      accountName: accountInfo === null ? null : readString(accountInfo, 'name'),
      amazonAccountId: accountInfo === null ? null : readId(accountInfo, 'id'),
      marketplaceStringId:
        accountInfo === null ? null : readString(accountInfo, 'marketplaceStringId'),
    });
  }
  return profiles;
}

/** Shared by the client method and the free function. */
export async function fetchProfiles(
  ctx: HttpContext,
  region: Region,
  clientId: string,
  getAccessToken: (force: boolean) => Promise<string>,
  userAgent?: string,
): Promise<AdsProfile[]> {
  const result = await httpRequest(ctx, {
    method: 'GET',
    url: `${hostFor(region)}/v2/profiles`,
    path: '/v2/profiles',
    // No `Amazon-Advertising-API-Scope`: this is the call that finds the scopes.
    headers: adsHeaders(getAccessToken, {
      clientId,
      accept: 'application/json',
      ...(userAgent === undefined ? {} : { userAgent }),
    }),
    idempotent: true,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeText(result.body));
  } catch (cause) {
    throw new AdsApiParseError('GET /v2/profiles returned a body that is not JSON', cause);
  }
  return parseProfiles(parsed, region);
}

/** Every profile this grant can see in one region. */
export async function listProfiles(
  credentials: AdsCredentials,
  region: Region,
  options: EffectOptions & { userAgent?: string } = {},
): Promise<AdsProfile[]> {
  const ctx = createHttpContext(region, options);
  const tokens = new TokenProvider(credentials, options);
  return fetchProfiles(
    ctx,
    region,
    credentials.clientId,
    (force) => (force ? tokens.forceRefresh() : tokens.getAccessToken()),
    options.userAgent,
  );
}

export interface RegionFailure {
  region: Region;
  error: unknown;
}

export interface CrossRegionProfiles {
  profiles: AdsProfile[];
  /** Regions that refused. Usually "this grant has no accounts there". */
  failures: RegionFailure[];
  /** Regions asked. `profiles` spans `regions.length - failures.length` of them. */
  regionsQueried: Region[];
}

/**
 * Discovery across all three hosts, used once per connection.
 *
 * One token provider for all three: LWA is global, so three regions do not need
 * three refreshes.
 */
export async function listProfilesAcrossRegions(
  credentials: AdsCredentials,
  options: EffectOptions & { regions?: readonly Region[]; userAgent?: string } = {},
): Promise<CrossRegionProfiles> {
  const regions = [...(options.regions ?? ALL_REGIONS)];
  const tokens = new TokenProvider(credentials, options);
  const getAccessToken = (force: boolean): Promise<string> =>
    force ? tokens.forceRefresh() : tokens.getAccessToken();

  const profiles: AdsProfile[] = [];
  const failures: RegionFailure[] = [];

  for (const region of regions) {
    const ctx = createHttpContext(region, options);
    try {
      profiles.push(
        ...(await fetchProfiles(ctx, region, credentials.clientId, getAccessToken, options.userAgent)),
      );
    } catch (error) {
      failures.push({ region, error });
    }
  }

  return { profiles, failures, regionsQueried: regions };
}
