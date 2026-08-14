/**
 * The boundary between the two identity sources.
 *
 * `tags-route.test.ts` and `goto-route.test.ts` prove what the bridge does when
 * it is armed. This file proves what it does when it is not, which is the half
 * that protects a deployment: a caller who knows the header names, and even one
 * who knows the secret, gets nothing unless the server opted in.
 */
import { describe, expect, it } from 'vitest';
import {
  RequestAuthError,
  actorFromHeaders,
  e2eAuthBridgeEnabled,
  isUnauthenticated,
  requestActor,
} from './request-context.js';

/** Assembled from fragments; nothing in this repository may look like a credential. */
const SECRET = ['synthetic', 'request', 'context', 'bridge', 'value'].join('-');
const USER = '8e8e8e8e-8e8e-4e8e-8e8e-8e8e8e8e8e8e';
const ORG = '8f8f8f8f-8f8f-4f8f-8f8f-8f8f8f8f8f8f';

const bridgeHeaders = (secret = SECRET) =>
  new Headers({
    'x-wizard-ads-auth-bridge': secret,
    'x-wizard-ads-user-id': USER,
    'x-wizard-ads-org-id': ORG,
  });

/** `NodeJS.ProcessEnv` insists on `NODE_ENV`; nothing here reads it. */
const env = (values: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  ...values,
});

const armed = env({ WIZARD_ADS_E2E_AUTH_BRIDGE: '1', WIZARD_ADS_AUTH_BRIDGE_SECRET: SECRET });

describe('the e2e auth bridge', () => {
  it('is off unless the server explicitly arms it', () => {
    expect(e2eAuthBridgeEnabled(env())).toBe(false);
    // Knowing the secret is not enough: the flag is a separate, server-side act.
    expect(e2eAuthBridgeEnabled(env({ WIZARD_ADS_AUTH_BRIDGE_SECRET: SECRET }))).toBe(false);
    expect(e2eAuthBridgeEnabled(env({ WIZARD_ADS_E2E_AUTH_BRIDGE: 'true' }))).toBe(false);
    expect(e2eAuthBridgeEnabled(armed)).toBe(true);
  });

  it('refuses to be armed on an instance that has real sessions', () => {
    expect(() =>
      e2eAuthBridgeEnabled({
        ...armed,
        NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-anon-key',
      }),
    ).toThrow(/never be enabled where real sessions exist/);
  });

  it('rejects bridge headers when it is not armed, secret or no secret', () => {
    for (const notArmed of [env(), env({ WIZARD_ADS_AUTH_BRIDGE_SECRET: SECRET })]) {
      const error = (() => {
        try {
          actorFromHeaders(bridgeHeaders(), notArmed);
          return null;
        } catch (thrown) {
          return thrown;
        }
      })();
      expect(error).toBeInstanceOf(RequestAuthError);
      expect((error as RequestAuthError).status).toBe(503);
    }
  });

  it('checks the secret and the actor shape once it is armed', async () => {
    expect(() => actorFromHeaders(bridgeHeaders('wrong'), armed)).toThrow(
      /Authentication required/,
    );
    expect(() =>
      actorFromHeaders(new Headers({ 'x-wizard-ads-auth-bridge': SECRET }), armed),
    ).toThrow(/Invalid actor context/);
    expect(actorFromHeaders(bridgeHeaders(), armed)).toEqual({ userId: USER, orgId: ORG });
    // `requestActor` routes to the bridge only while it is armed; the session
    // path it falls back to otherwise is exercised by the WP-04 e2e suite,
    // which is the only place a real request context exists.
    await expect(requestActor(bridgeHeaders(), armed)).resolves.toEqual({
      userId: USER,
      orgId: ORG,
    });
  });
});

/**
 * The five WP-07/08/15 pages used to catch every one of these and render the
 * message with a 200. Only the first is answered by signing in, so only the
 * first may become a redirect to `/login`; sending the other two there would be
 * a loop for a visitor who is already signed in.
 */
describe('isUnauthenticated', () => {
  it('is true only for a 401', () => {
    expect(isUnauthenticated(new RequestAuthError('Authentication required', 401))).toBe(true);
    expect(isUnauthenticated(new RequestAuthError('Resource not found', 403))).toBe(false);
    expect(isUnauthenticated(new RequestAuthError('Database is not configured', 503))).toBe(false);
  });

  it('does not match a look-alike from anywhere else', () => {
    expect(isUnauthenticated(new Error('Authentication required'))).toBe(false);
    expect(isUnauthenticated({ status: 401 })).toBe(false);
    expect(isUnauthenticated(null)).toBe(false);
  });
});
