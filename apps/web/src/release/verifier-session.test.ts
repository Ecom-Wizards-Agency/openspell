import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { ORG_COOKIE, PROFILE_COOKIE } from '../cookies';
import {
  activeProfileCandidatesInPage,
  validatedAuthCookies,
  validatedOrgCookie,
  validatedProfileCookie,
} from '../../scripts/verify-release-candidate';

const PRODUCTION = new URL('https://ads.ecomwizards.agency');
const PROFILE_A = '10000000-0000-4000-8000-000000000001';
const PROFILE_B = '20000000-0000-4000-8000-000000000002';
const AUTH_NAME = ['sb', 'synthetic', 'auth-token'].join('-');

describe('release verifier session boundary', () => {
  it('accepts actual host-only non-Secure auth and org cookie shapes', () => {
    const auth = browserCookie(AUTH_NAME, ['synthetic', 'session'].join('-'));
    const org = browserCookie(ORG_COOKIE, PROFILE_A, { httpOnly: true });

    expect(validatedAuthCookies([auth, org], PRODUCTION)).toEqual([auth]);
    expect(validatedOrgCookie([auth, org], PRODUCTION)).toEqual(org);
    expect(validatedProfileCookie([
      browserCookie(PROFILE_COOKIE, PROFILE_A),
    ], PRODUCTION)?.value).toBe(PROFILE_A);
  });

  it('rejects duplicate, parent-domain, malformed, and control-bearing cookies', () => {
    const auth = browserCookie(AUTH_NAME, ['synthetic', 'session'].join('-'));
    const parentDomain = browserCookie(AUTH_NAME, auth.value, {
      domain: '.ecomwizards.agency',
    });
    const controlValue = `${auth.value}${String.fromCharCode(10)}`;

    expect(() => validatedAuthCookies([auth, { ...auth }], PRODUCTION))
      .toThrow('session_unavailable');
    expect(() => validatedAuthCookies([parentDomain], PRODUCTION))
      .toThrow('session_unavailable');
    expect(() => validatedAuthCookies([
      auth,
      browserCookie(['sb', 'unrelated', 'auth-token'].join('-'), auth.value),
    ], PRODUCTION)).toThrow('session_unavailable');
    expect(() => validatedAuthCookies([
      browserCookie(AUTH_NAME, controlValue),
    ], PRODUCTION)).toThrow('session_unavailable');
    expect(() => validatedOrgCookie([
      browserCookie(ORG_COOKIE, 'not-a-uuid'),
    ], PRODUCTION)).toThrow('session_unavailable');
    expect(() => validatedProfileCookie([
      browserCookie(PROFILE_COOKIE, PROFILE_A, { domain: '.ecomwizards.agency' }),
    ], PRODUCTION)).toThrow('profile_unavailable');
    expect(() => validatedProfileCookie([
      browserCookie(PROFILE_COOKIE, PROFILE_A, { path: '/dashboard' }),
    ], PRODUCTION)).toThrow('profile_unavailable');
  });

  it('ignores alternative-profile links when deriving the active profile', () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <input name="profile" value="${PROFILE_A}">
      <a href="/sync-status?profile=${PROFILE_B}">Alternative profile</a>
      <select name="profileId"><option selected value="${PROFILE_B}">Competitor</option></select>
    </body></html>`, {
      url: `${PRODUCTION.origin}/sync-status?profile=${PROFILE_A}`,
    });
    dom.window.document.cookie = `${PROFILE_COOKIE}=${PROFILE_A}; path=/`;
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
    });
    try {
      const candidates = activeProfileCandidatesInPage(PROFILE_COOKIE);
      expect(candidates).toContain(PROFILE_A);
      expect(candidates).not.toContain(PROFILE_B);
    } finally {
      Object.assign(globalThis, {
        window: previousWindow,
        document: previousDocument,
      });
      dom.window.close();
    }
  });
});

function browserCookie(
  name: string,
  value: string,
  override: Partial<{
    domain: string;
    expires: number;
    httpOnly: boolean;
    path: string;
    sameSite: 'Strict' | 'Lax' | 'None';
    secure: boolean;
  }> = {},
) {
  return {
    name,
    value,
    domain: PRODUCTION.hostname,
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: 'Lax' as const,
    ...override,
  };
}
