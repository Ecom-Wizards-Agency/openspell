/**
 * Login with Amazon: the consent URL, the one-time code exchange, and the
 * refresh-token-to-access-token loop every other call depends on.
 *
 * Ported from `SPAdsApiDataSource._get_access_token` (live-verified 2026-08-13)
 * and `tools/ads-auth/exchange_token.py`. Two details are load-bearing and both
 * come from the reference: the token is refreshed 60 seconds before Amazon says
 * it expires, because a token that dies in flight costs a whole request; and
 * the exchange is form-encoded, because LWA rejects a JSON body.
 *
 * `exchangeAuthorizationCode` and `buildAuthorizationUrl` are the surface
 * WP-04's OAuth callback consumes. They are free functions on purpose: at
 * callback time there is a code and no profile, so there is nothing to scope a
 * client to.
 */
import type { Region } from '@wizard-ads/shared';
import { createHttpContext, type EffectOptions } from './context.js';
import { AdsApiParseError, AdsAuthError } from './errors.js';
import { decodeText, httpRequest } from './http.js';
import { LWA_AUTHORIZE_URL, LWA_TOKEN_URL } from './regions.js';
import type { AdsCredentials } from './types.js';

/** What LWA hands back. `refreshToken` is present only on a code exchange. */
export interface LwaTokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Seconds, as Amazon reports it. Typically 3600. */
  expiresIn: number;
  tokenType: string;
}

/** The scope this application is approved for. Anything narrower fails later. */
export const ADS_SCOPE = 'advertising::campaign_management';

export interface AuthorizationUrlParams {
  clientId: string;
  redirectUri: string;
  /** Signed, session-bound, short-lived. WP-04 mints and verifies it. */
  state: string;
  /** Picks the consent host. A grant is per-region on Amazon's side. */
  region?: Region;
  scope?: string;
}

/**
 * The URL a human opens to grant access.
 *
 * Included here rather than in the web app so the host table has exactly one
 * home: an EU advertiser sent to the NA consent page gets a grant that then
 * fails against the EU API, with no error that says so.
 */
export function buildAuthorizationUrl(params: AuthorizationUrlParams): string {
  const base = LWA_AUTHORIZE_URL[params.region ?? 'NA'];
  const query = new URLSearchParams({
    client_id: params.clientId,
    scope: params.scope ?? ADS_SCOPE,
    response_type: 'code',
    redirect_uri: params.redirectUri,
    state: params.state,
  });
  return `${base}?${query.toString()}`;
}

interface LwaResponseBody {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
  error?: unknown;
  error_description?: unknown;
}

async function postToken(
  form: Record<string, string>,
  options: EffectOptions,
  label: string,
): Promise<LwaTokenSet> {
  // LWA is a single global endpoint; the region here only labels retry events.
  const ctx = createHttpContext('NA', options);
  const result = await httpRequest(ctx, {
    method: 'POST',
    url: LWA_TOKEN_URL,
    path: `lwa:${label}`,
    headers: async () => ({
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    }),
    body: new URLSearchParams(form).toString(),
    // A token mint has no side effect worth protecting: re-sending it costs a
    // token, not a state change, and a 5xx here would otherwise fail a job.
    idempotent: true,
    // LWA reports a dead grant as 400/401 with a machine-readable body. Read it
    // rather than throwing a bare "failed with 400" that hides the reason.
    expectedStatuses: [400, 401],
  });

  const text = decodeText(result.body);
  let parsed: LwaResponseBody;
  try {
    parsed = JSON.parse(text) as LwaResponseBody;
  } catch {
    throw new AdsApiParseError(`LWA ${label} returned a body that is not JSON`);
  }

  if (typeof parsed.error === 'string') {
    const description =
      typeof parsed.error_description === 'string'
        ? parsed.error_description
        : 'no description returned';
    throw new AdsAuthError(
      `LWA ${label} refused: ${parsed.error}: ${description}`,
      result.status,
      '',
      result.attempts,
    );
  }

  if (typeof parsed.access_token !== 'string') {
    // Never echo the body: it is the one place a live token could be logged.
    const keys = Object.keys(parsed).sort().join(', ');
    throw new AdsAuthError(
      `LWA ${label} returned no access_token (keys: ${keys})`,
      result.status,
      '',
      result.attempts,
    );
  }

  return {
    accessToken: parsed.access_token,
    refreshToken: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : null,
    expiresIn: typeof parsed.expires_in === 'number' ? parsed.expires_in : 3_600,
    tokenType: typeof parsed.token_type === 'string' ? parsed.token_type : 'bearer',
  };
}

export interface CodeExchangeParams {
  clientId: string;
  clientSecret: string;
  /** The one-time `code` from the consent redirect. */
  code: string;
  /** Must byte-match the redirect URI registered on the LWA app. */
  redirectUri: string;
}

/**
 * Turn a consent redirect into a refresh token. Single use: a code that has
 * been exchanged once is dead, so a retried callback must not call this twice.
 */
export async function exchangeAuthorizationCode(
  params: CodeExchangeParams,
  options: EffectOptions = {},
): Promise<LwaTokenSet & { refreshToken: string }> {
  const tokens = await postToken(
    {
      grant_type: 'authorization_code',
      code: params.code,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
    },
    options,
    'code-exchange',
  );

  if (tokens.refreshToken === null) {
    throw new AdsAuthError('LWA code exchange returned no refresh_token', 200, '', 1);
  }
  return { ...tokens, refreshToken: tokens.refreshToken };
}

/** Exchange a stored refresh token for a fresh access token. */
export async function refreshAccessToken(
  credentials: AdsCredentials,
  options: EffectOptions = {},
): Promise<LwaTokenSet> {
  return postToken(
    {
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    },
    options,
    'refresh',
  );
}

/** Seconds of headroom before expiry. Ported verbatim from the reference. */
export const TOKEN_REFRESH_MARGIN_SECONDS = 60;

/**
 * An in-memory access-token cache for one set of credentials.
 *
 * In memory and nowhere else: the worker holds tokens for the length of a job
 * and the web tier never holds one at all. Concurrent callers share a single
 * in-flight refresh, because 30 jobs starting at once must not mint 30 tokens.
 */
export class TokenProvider {
  private accessToken: string | null = null;
  private expiresAt = 0;
  private inFlight: Promise<string> | null = null;

  constructor(
    private readonly credentials: AdsCredentials,
    private readonly options: EffectOptions = {},
  ) {}

  private get now(): number {
    return (this.options.now ?? (() => Date.now()))();
  }

  /** Cached until 60 seconds before expiry, then refreshed. */
  async getAccessToken(): Promise<string> {
    if (this.accessToken !== null && this.now < this.expiresAt) return this.accessToken;
    return this.forceRefresh();
  }

  /** Discard the cached token and mint a new one. The 401 recovery path. */
  async forceRefresh(): Promise<string> {
    if (this.inFlight !== null) return this.inFlight;
    const pending = refreshAccessToken(this.credentials, this.options)
      .then((tokens) => {
        this.accessToken = tokens.accessToken;
        this.expiresAt =
          this.now + (tokens.expiresIn - TOKEN_REFRESH_MARGIN_SECONDS) * 1_000;
        return tokens.accessToken;
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = pending;
    return pending;
  }
}
