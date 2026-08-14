/**
 * The OAuth `state` parameter, signed.
 *
 * Ported from the working Cloudflare callback worker
 * (`amazon-agent/tools/ads-auth/callback-worker/src/index.ts`): a base64url
 * JSON payload, an HMAC-SHA256 signature over that exact encoded payload, a
 * 15-minute expiry, and a random nonce that is *also* dropped in a `__Host-`
 * cookie so a state minted for one browser cannot be replayed in another.
 *
 * wizard-ads adds two claims the CLI worker had no need for, and they are the
 * point of the whole file: `org` and `sub`. The callback stores an agency-wide
 * Amazon credential, so the round trip has to prove not only "this state came
 * from us and is fresh" but "it came from *this* signed-in admin acting for
 * *this* org". Both are compared against the live session in the callback, so a
 * valid state stolen from another tenant still lands nowhere.
 *
 * Node's crypto rather than WebCrypto because these routes run on the Node
 * runtime, and `timingSafeEqual` is not optional: a signature check with `===`
 * leaks the signature one byte at a time.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const STATE_VERSION = 1;
export const STATE_TTL_SECONDS = 15 * 60;
export const NONCE_COOKIE = '__Host-wizard_ads_oauth_nonce';

const NONCE_BYTES = 32;
/** base64url of 32 bytes, without padding. */
const NONCE_LENGTH = 43;
const MAX_STATE_LENGTH = 1024;
const MIN_KEY_BYTES = 32;

/** Claims carried across the Amazon redirect. Nothing secret, all of it signed. */
export interface OAuthStateClaims {
  /** Org the connection will belong to. */
  org: string;
  /** Supabase user id of the admin who started the flow. */
  sub: string;
  /** Random per-attempt value; its twin lives in a `__Host-` cookie. */
  nonce: string;
}

interface StatePayload extends OAuthStateClaims {
  v: number;
  iat: number;
  exp: number;
}

export type StateFailure =
  | 'missing'
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'nonce_mismatch';

export type StateVerification =
  | { ok: true; claims: OAuthStateClaims }
  | { ok: false; reason: StateFailure };

/** A fresh nonce. Returned so the caller can set the cookie and sign the state with the same value. */
export function createNonce(): string {
  return base64Url(randomBytes(NONCE_BYTES));
}

/**
 * Mint a state token. `now` is injectable so the expiry can be tested without
 * a fake clock, which is the only reason it is a parameter.
 */
export function createState(
  key: string,
  claims: OAuthStateClaims,
  now: number = Date.now(),
): string {
  const issuedAt = Math.floor(now / 1000);
  const payload: StatePayload = {
    v: STATE_VERSION,
    iat: issuedAt,
    exp: issuedAt + STATE_TTL_SECONDS,
    org: claims.org,
    sub: claims.sub,
    nonce: claims.nonce,
  };
  const encoded = base64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${encoded}.${base64Url(sign(key, encoded))}`;
}

/**
 * Verify a state token against the signing key and the cookie nonce.
 *
 * Every rejection is a named reason rather than a boolean, because the callback
 * has to tell an operator whether the link expired (start again) or whether the
 * value was altered (something is wrong), and a bare `false` cannot.
 */
export function verifyState(
  key: string,
  state: string | null | undefined,
  cookieNonce: string | null | undefined,
  now: number = Date.now(),
): StateVerification {
  if (!state || !cookieNonce) return { ok: false, reason: 'missing' };
  if (state.length > MAX_STATE_LENGTH) return { ok: false, reason: 'malformed' };

  const parts = state.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [encoded, signature] = parts;
  if (!encoded || !signature) return { ok: false, reason: 'malformed' };

  const given = fromBase64Url(signature);
  if (given === null) return { ok: false, reason: 'malformed' };
  if (!equal(given, sign(key, encoded))) return { ok: false, reason: 'bad_signature' };

  const decoded = fromBase64Url(encoded);
  if (decoded === null) return { ok: false, reason: 'malformed' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isStatePayload(parsed)) return { ok: false, reason: 'malformed' };
  // A signed payload whose TTL is not ours was minted by a different policy.
  if (parsed.exp - parsed.iat !== STATE_TTL_SECONDS) return { ok: false, reason: 'malformed' };

  const seconds = Math.floor(now / 1000);
  if (parsed.exp < seconds) return { ok: false, reason: 'expired' };
  if (parsed.iat > seconds + 30) return { ok: false, reason: 'not_yet_valid' };

  if (!equal(Buffer.from(parsed.nonce, 'utf8'), Buffer.from(cookieNonce, 'utf8'))) {
    return { ok: false, reason: 'nonce_mismatch' };
  }

  return { ok: true, claims: { org: parsed.org, sub: parsed.sub, nonce: parsed.nonce } };
}

/** The `Set-Cookie` value that carries the nonce through the Amazon round trip. */
export function nonceCookie(nonce: string, secure: boolean): string {
  // `__Host-` requires Secure and Path=/ and forbids Domain. Over plain http
  // (local dev, e2e) the prefix cannot be honoured, so the cookie drops it
  // rather than being silently refused by the browser.
  const name = secure ? NONCE_COOKIE : plainNonceCookieName();
  const flags = `Path=/; Max-Age=${STATE_TTL_SECONDS}; HttpOnly; SameSite=Lax`;
  return secure ? `${name}=${nonce}; ${flags}; Secure` : `${name}=${nonce}; ${flags}`;
}

/** Same cookie, expired. Sent on every callback outcome: a nonce is single-use. */
export function clearedNonceCookie(secure: boolean): string {
  const name = secure ? NONCE_COOKIE : plainNonceCookieName();
  const flags = 'Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax';
  return secure ? `${name}=; ${flags}; Secure` : `${name}=; ${flags}`;
}

/** The cookie name in force for a given scheme. */
export function nonceCookieName(secure: boolean): string {
  return secure ? NONCE_COOKIE : plainNonceCookieName();
}

function plainNonceCookieName(): string {
  return NONCE_COOKIE.replace('__Host-', '');
}

function sign(key: string, encodedPayload: string): Buffer {
  assertKey(key);
  return createHmac('sha256', key).update(encodedPayload).digest();
}

function assertKey(key: string): void {
  if (Buffer.byteLength(key, 'utf8') < MIN_KEY_BYTES) {
    throw new Error(
      `AMAZON_OAUTH_STATE_KEY must be at least ${MIN_KEY_BYTES} bytes; ` +
        'generate one with `openssl rand -base64 48`.',
    );
  }
}

function equal(a: Buffer, b: Buffer): boolean {
  // timingSafeEqual throws on a length mismatch, and the lengths themselves are
  // not a secret, so the guard is a plain comparison.
  return a.length === b.length && timingSafeEqual(a, b);
}

function base64Url(value: Buffer): string {
  return value.toString('base64url');
}

function fromBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    return Buffer.from(value, 'base64url');
  } catch {
    return null;
  }
}

function isStatePayload(value: unknown): value is StatePayload {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate['v'] === STATE_VERSION &&
    Number.isInteger(candidate['iat']) &&
    Number.isInteger(candidate['exp']) &&
    typeof candidate['org'] === 'string' &&
    candidate['org'].length > 0 &&
    typeof candidate['sub'] === 'string' &&
    candidate['sub'].length > 0 &&
    typeof candidate['nonce'] === 'string' &&
    candidate['nonce'].length === NONCE_LENGTH
  );
}
