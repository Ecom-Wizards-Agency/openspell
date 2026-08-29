import { SpApiAuthError } from './errors.js';
import type { FetchLike, SpApiAccessTokenProvider } from './types.js';

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const EXPIRY_MARGIN_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeProviderErrorCode(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
    ? value
    : 'request_refused';
}

export interface LwaRefreshTokenProviderOptions {
  clientId: string;
  clientSecret: string;
  /** Read from worker-owned custody only when a fresh access token is needed. */
  refreshTokenProvider: () => Promise<string | null>;
  fetch?: FetchLike;
  now?: () => number;
}

/**
 * Cached LWA access tokens with lazy refresh-credential reads.
 *
 * The refresh value is never retained after the form body is built. Concurrent
 * callers share one exchange, and `invalidate` makes the next request reread
 * Vault after a rotation or provider-side 401.
 */
export class LwaRefreshTokenProvider implements SpApiAccessTokenProvider {
  private access: string | null = null;
  private expiresAt = 0;
  private inFlight: Promise<string> | null = null;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(private readonly options: LwaRefreshTokenProviderOptions) {
    if (!options.clientId || !options.clientSecret) {
      throw new SpApiAuthError('SP-API LWA application credentials are not configured', null);
    }
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getAccessToken(): Promise<string> {
    if (this.access !== null && this.now() < this.expiresAt) return this.access;
    if (this.inFlight !== null) return this.inFlight;
    const pending = this.exchange().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = pending;
    return pending;
  }

  invalidate(): void {
    this.access = null;
    this.expiresAt = 0;
  }

  private async exchange(): Promise<string> {
    const refresh = await this.options.refreshTokenProvider();
    if (!refresh) throw new SpApiAuthError('SP-API refresh credential is unavailable', null);
    const { clientId, clientSecret: lwaKey } = this.options;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: clientId,
      client_secret: lwaKey,
    }).toString();
    const response = await this.fetchImpl(LWA_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new SpApiAuthError('SP-API LWA returned a non-JSON response', response.status);
    }
    if (!response.ok) {
      const code = safeProviderErrorCode(isRecord(parsed) ? parsed['error'] : undefined);
      throw new SpApiAuthError(`SP-API LWA request failed: ${code}`, response.status);
    }
    if (!isRecord(parsed) || typeof parsed['access_token'] !== 'string') {
      throw new SpApiAuthError('SP-API LWA returned no access token', response.status);
    }
    const expiresIn = typeof parsed['expires_in'] === 'number' && parsed['expires_in'] > 0
      ? parsed['expires_in']
      : 3_600;
    this.access = parsed['access_token'];
    this.expiresAt = this.now() + Math.max(0, expiresIn * 1_000 - EXPIRY_MARGIN_MS);
    return this.access;
  }
}
