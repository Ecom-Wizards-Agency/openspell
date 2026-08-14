/**
 * The state token, attacked from every direction the brief names.
 *
 * "State tampering and expired state are rejected" is the acceptance check, so
 * tampering is tested at each layer separately rather than once: the payload,
 * the signature, the key, the clock and the cookie. A single "returns false for
 * a bad state" test passes even when three of those checks have been deleted.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createNonce,
  createState,
  clearedNonceCookie,
  nonceCookie,
  nonceCookieName,
  STATE_TTL_SECONDS,
  verifyState,
} from './state';

const KEY = 'x'.repeat(48);
const OTHER_KEY = 'y'.repeat(48);
const ORG = '11111111-1111-4111-8111-111111111111';
const SUB = '22222222-2222-4222-8222-222222222222';

function mint(now = Date.now()): { state: string; nonce: string } {
  const nonce = createNonce();
  return { state: createState(KEY, { org: ORG, sub: SUB, nonce }, now), nonce };
}

describe('oauth state', () => {
  it('round-trips the org and the user it was minted for', () => {
    const { state, nonce } = mint();
    const result = verifyState(KEY, state, nonce);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.org).toBe(ORG);
    expect(result.claims.sub).toBe(SUB);
  });

  it('rejects a payload edited in flight', () => {
    const { state, nonce } = mint();
    const [encoded, signature] = state.split('.') as [string, string];
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    payload.org = '33333333-3333-4333-8333-333333333333';
    const forged = `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.${signature}`;

    expect(verifyState(KEY, forged, nonce)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a swapped signature', () => {
    const { state, nonce } = mint();
    const [encoded] = state.split('.') as [string, string];
    const other = createState(OTHER_KEY, { org: ORG, sub: SUB, nonce });
    const [, otherSignature] = other.split('.') as [string, string];

    expect(verifyState(KEY, `${encoded}.${otherSignature}`, nonce)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a state signed with a different key', () => {
    const nonce = createNonce();
    const state = createState(OTHER_KEY, { org: ORG, sub: SUB, nonce });
    expect(verifyState(KEY, state, nonce)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a state that expired', () => {
    const issued = Date.now();
    const { state, nonce } = mint(issued);
    const oneSecondLate = issued + (STATE_TTL_SECONDS + 1) * 1000;

    expect(verifyState(KEY, state, nonce, issued)).toMatchObject({ ok: true });
    expect(verifyState(KEY, state, nonce, oneSecondLate)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects a state minted in the future', () => {
    const issued = Date.now() + 10 * 60 * 1000;
    const { state, nonce } = mint(issued);
    expect(verifyState(KEY, state, nonce, Date.now())).toEqual({
      ok: false,
      reason: 'not_yet_valid',
    });
  });

  it('rejects a longer TTL forged with a valid signature', () => {
    // The signature is genuine; only the window was widened. Without the
    // exp-minus-iat check this passes, which is why the check exists.
    const nonce = createNonce();
    const issuedAt = Math.floor(Date.now() / 1000);
    const payload = { v: 1, iat: issuedAt, exp: issuedAt + 86400, org: ORG, sub: SUB, nonce };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    // Signed with the real key, so the signature check passes and the TTL
    // assertion is the only defence left standing.
    const real = createHmac('sha256', KEY).update(encoded).digest('base64url');

    expect(verifyState(KEY, `${encoded}.${real}`, nonce)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects a state replayed in another browser', () => {
    const { state } = mint();
    expect(verifyState(KEY, state, createNonce())).toEqual({
      ok: false,
      reason: 'nonce_mismatch',
    });
  });

  it('rejects a missing state or a missing cookie', () => {
    const { state, nonce } = mint();
    expect(verifyState(KEY, null, nonce)).toEqual({ ok: false, reason: 'missing' });
    expect(verifyState(KEY, state, null)).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejects junk without throwing', () => {
    const nonce = createNonce();
    for (const junk of ['', 'a', 'a.b.c', '...', '!!!.???', 'x'.repeat(2000)]) {
      const result = verifyState(KEY, junk, nonce);
      expect(result.ok).toBe(false);
    }
  });

  it('refuses to sign with a key that is too short', () => {
    expect(() => createState('short', { org: ORG, sub: SUB, nonce: createNonce() })).toThrow(
      /at least 32 bytes/,
    );
  });

  it('carries __Host- only where a browser would accept it', () => {
    const nonce = createNonce();
    expect(nonceCookie(nonce, true)).toContain('__Host-');
    expect(nonceCookie(nonce, true)).toContain('Secure');
    expect(nonceCookie(nonce, false)).not.toContain('__Host-');
    expect(nonceCookieName(false)).not.toContain('__Host-');
    expect(clearedNonceCookie(true)).toContain('Max-Age=0');
  });
});
