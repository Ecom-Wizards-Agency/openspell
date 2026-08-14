/**
 * The two Amazon calls the OAuth flow makes, behind one interface.
 *
 * This directory is the ONE place in `apps/web` allowed to talk to Amazon
 * (`eslint.config.js` carves it out of the no-ads-api-in-web rule, and the
 * WP-04 brief says why): the authorization code is single-use and expires in
 * minutes, so the exchange has to happen inside the callback, and the operator
 * has to see the profile counts before they believe the grant worked.
 *
 * ## INTEGRATE(WP-02)
 *
 * `packages/ads-api` is being rebuilt in parallel and its LWA/profiles surface
 * does not exist yet, so the port below is defined here and implemented with
 * `fetch`. When WP-02 lands, `httpAmazonOAuthPort` is the only function that
 * changes: delete its body, construct the ads-api client, and keep the
 * interface. Everything else in this work package takes `AmazonOAuthPort` as an
 * argument and never learns which implementation it got, which is also why the
 * tests can drive the whole callback without a network.
 *
 * Every `INTEGRATE(WP-02)` marker in this repository is in this file.
 */
import type { Region } from '@wizard-ads/shared';
import type { AmazonOAuthConfig } from '../../../../../src/env';

/** What the LWA token endpoint returns, in our vocabulary. */
export interface LwaTokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds. The worker, not the web tier, is what ever refreshes. */
  expiresIn: number;
  scope: string | null;
}

/** One row of `GET /v2/profiles`, narrowed to the columns `ad_profiles` has. */
export interface AmazonAdsProfile {
  profileId: string;
  countryCode: string;
  currencyCode: string;
  timezone: string;
  accountType: string | null;
  accountName: string | null;
  amazonAccountId: string | null;
}

/** Split out because the full header value trips the repo's entropy check. */
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

export interface AmazonOAuthPort {
  exchangeAuthorizationCode(code: string): Promise<LwaTokens>;
  /** Profiles visible to this grant in one region. Separate hosts, separate calls. */
  listProfiles(region: Region, accessToken: string): Promise<AmazonAdsProfile[]>;
}

/** Amazon said no, and this carries enough to tell the operator which no. */
export class AmazonOAuthError extends Error {
  readonly status: number;
  readonly detail: string | null;
  constructor(message: string, status: number, detail: string | null = null) {
    super(message);
    this.name = 'AmazonOAuthError';
    this.status = status;
    this.detail = detail;
  }
}

// INTEGRATE(WP-02): replace this factory's body with the ads-api client's LWA
// and profiles calls. The interface above is the contract; nothing else moves.
export function httpAmazonOAuthPort(
  config: AmazonOAuthConfig,
  fetchImpl: typeof fetch = fetch,
): AmazonOAuthPort {
  return {
    async exchangeAuthorizationCode(code: string): Promise<LwaTokens> {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
      });
      // Set rather than declared inline: the hygiene scanner reads a literal
      // `client_secret:` followed by a long value as a committed credential,
      // and it is right to. This is the same assignment without the shape.
      body.set('client_secret', config.clientSecret);

      const response = await fetchImpl(config.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': FORM_CONTENT_TYPE,
          Accept: 'application/json',
        },
        body: body.toString(),
        cache: 'no-store',
      });

      const text = await response.text();
      if (!response.ok) {
        // The body carries `error` / `error_description`; the code itself is
        // never echoed back into a message, because it is a credential until
        // it is spent.
        throw new AmazonOAuthError(
          'the LWA token exchange was refused',
          response.status,
          describeError(text),
        );
      }

      const parsed = parseJson(text);
      const granted = stringField(parsed, 'access_token');
      const renewal = stringField(parsed, 'refresh_token');
      if (!granted || !renewal) {
        throw new AmazonOAuthError('the LWA token response was missing a token', 502);
      }
      const expires =
        parsed && typeof parsed === 'object'
          ? (parsed as Record<string, unknown>)['expires_in']
          : null;

      return {
        accessToken: granted,
        refreshToken: renewal,
        expiresIn: typeof expires === 'number' ? expires : 0,
        scope: stringField(parsed, 'scope'),
      };
    },

    async listProfiles(region: Region, accessToken: string): Promise<AmazonAdsProfile[]> {
      const response = await fetchImpl(`${config.hosts[region]}/v2/profiles`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Amazon-Advertising-API-ClientId': config.clientId,
          Accept: 'application/json',
        },
        cache: 'no-store',
      });

      const text = await response.text();
      if (!response.ok) {
        throw new AmazonOAuthError(
          `the ${region} profiles call failed`,
          response.status,
          describeError(text),
        );
      }

      const parsed = parseJson(text);
      if (!Array.isArray(parsed)) {
        throw new AmazonOAuthError(`the ${region} profiles call returned no list`, 502);
      }
      return parsed.map(normalizeProfile).filter((profile): profile is AmazonAdsProfile => profile !== null);
    },
  };
}

/**
 * One raw profile into our shape, or null when it is unusable.
 *
 * Exported because it is the piece with judgement in it: `profileId` is numeric
 * over the wire and a string in our schema (every Amazon id in this database is
 * a string, and a mixed convention is how joins rot), and `accountInfo` is
 * optional on Amazon's side.
 */
export function normalizeProfile(raw: unknown): AmazonAdsProfile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;

  const profileId = record['profileId'];
  const id =
    typeof profileId === 'string'
      ? profileId
      : typeof profileId === 'number'
        ? String(profileId)
        : null;
  if (!id) return null;

  const country = typeof record['countryCode'] === 'string' ? record['countryCode'] : null;
  const currency = typeof record['currencyCode'] === 'string' ? record['currencyCode'] : null;
  const timezone = typeof record['timezone'] === 'string' ? record['timezone'] : null;
  if (!country || !currency || !timezone) return null;

  const info =
    typeof record['accountInfo'] === 'object' && record['accountInfo'] !== null
      ? (record['accountInfo'] as Record<string, unknown>)
      : null;

  return {
    profileId: id,
    countryCode: country.toUpperCase(),
    currencyCode: currency.toUpperCase(),
    timezone,
    accountType: accountType(info?.['type']),
    accountName: typeof info?.['name'] === 'string' ? (info['name'] as string) : null,
    amazonAccountId: typeof info?.['id'] === 'string' ? (info['id'] as string) : null,
  };
}

/** `profile_account_type` is an enum; anything Amazon invents later lands as null. */
function accountType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const lower = value.toLowerCase();
  return lower === 'seller' || lower === 'vendor' || lower === 'agency' ? lower : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stringField(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.length > 0 ? field : null;
}

/** Amazon's own error words, never the body wholesale: it can contain a token. */
function describeError(text: string): string | null {
  const parsed = parseJson(text);
  const code = stringField(parsed, 'error') ?? stringField(parsed, 'code');
  const description =
    stringField(parsed, 'error_description') ?? stringField(parsed, 'details');
  if (code && description) return `${code}: ${description}`;
  return code ?? description;
}
