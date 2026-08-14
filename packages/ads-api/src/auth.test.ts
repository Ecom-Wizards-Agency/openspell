/**
 * LWA: the consent URL, the one-time code exchange, and the refresh loop.
 *
 * The 60-second refresh margin is ported from the live-verified reference and
 * is tested as a boundary, not as a round number: a token used in its final
 * second is a request that fails for no visible reason.
 */
import { describe, expect, it } from 'vitest';
import {
  ADS_SCOPE,
  TokenProvider,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
} from './auth.js';
import { AdsAuthError } from './errors.js';
import { createMockServer } from './__fixtures__/server.js';

const CREDENTIALS = {
  clientId: 'amzn1.application-oa2-client.example',
  clientSecret: 'example-client-secret',
  refreshToken: 'fake-refresh-token',
};

function clock(start = 1_700_000_000_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

describe('buildAuthorizationUrl', () => {
  it('carries the ads scope, the state and the caller redirect', () => {
    const url = new URL(
      buildAuthorizationUrl({
        clientId: CREDENTIALS.clientId,
        redirectUri: 'https://example.test/amazon/callback',
        state: 'signed-state',
      }),
    );
    expect(url.origin).toBe('https://www.amazon.com');
    expect(url.searchParams.get('scope')).toBe(ADS_SCOPE);
    expect(url.searchParams.get('state')).toBe('signed-state');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.test/amazon/callback');
  });

  it('sends an EU advertiser to the EU consent host', () => {
    const url = new URL(
      buildAuthorizationUrl({
        clientId: CREDENTIALS.clientId,
        redirectUri: 'https://example.test/amazon/callback',
        state: 'signed-state',
        region: 'EU',
      }),
    );
    expect(url.origin).toBe('https://eu.account.amazon.com');
  });
});

describe('code exchange', () => {
  it('posts a form-encoded grant and returns the refresh token', async () => {
    const server = createMockServer([
      {
        method: 'POST',
        match: '/auth/o2/token',
        responses: [
          {
            status: 200,
            json: {
              access_token: 'fake-access-token',
              refresh_token: 'fake-new-refresh-token',
              expires_in: 3600,
              token_type: 'bearer',
            },
          },
        ],
      },
    ]);

    const tokens = await exchangeAuthorizationCode(
      {
        clientId: CREDENTIALS.clientId,
        clientSecret: CREDENTIALS.clientSecret,
        code: 'one-time-code',
        redirectUri: 'https://example.test/amazon/callback',
      },
      { fetch: server.fetch },
    );

    expect(tokens.refreshToken).toBe('fake-new-refresh-token');
    const request = server.requests[0];
    expect(request?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(request?.body ?? '');
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('one-time-code');
    expect(form.get('redirect_uri')).toBe('https://example.test/amazon/callback');
  });

  it('reports Amazon error bodies instead of a bare status', async () => {
    const server = createMockServer([
      {
        method: 'POST',
        match: '/auth/o2/token',
        responses: [
          { status: 400, json: { error: 'invalid_grant', error_description: 'The authorization code is invalid' } },
        ],
      },
    ]);

    const error = await exchangeAuthorizationCode(
      {
        clientId: CREDENTIALS.clientId,
        clientSecret: CREDENTIALS.clientSecret,
        code: 'stale-code',
        redirectUri: 'https://example.test/amazon/callback',
      },
      { fetch: server.fetch },
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AdsAuthError);
    expect((error as AdsAuthError).message).toContain('invalid_grant');
    expect((error as AdsAuthError).message).toContain('authorization code is invalid');
  });

  it('fails loudly when the grant came back without a refresh token', async () => {
    const server = createMockServer([
      {
        method: 'POST',
        match: '/auth/o2/token',
        responses: [{ status: 200, json: { access_token: 'fake-access-token', expires_in: 3600 } }],
      },
    ]);

    await expect(
      exchangeAuthorizationCode(
        {
          clientId: CREDENTIALS.clientId,
          clientSecret: CREDENTIALS.clientSecret,
          code: 'one-time-code',
          redirectUri: 'https://example.test/amazon/callback',
        },
        { fetch: server.fetch },
      ),
    ).rejects.toBeInstanceOf(AdsAuthError);
  });

  it('never echoes the response body when a token is missing', async () => {
    const server = createMockServer([
      {
        method: 'POST',
        match: '/auth/o2/token',
        responses: [{ status: 200, json: { unexpected: 'Atza|not-a-real-value' } }],
      },
    ]);

    const error = await refreshAccessToken(CREDENTIALS, { fetch: server.fetch }).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(AdsAuthError);
    expect((error as AdsAuthError).message).toContain('unexpected');
    expect((error as AdsAuthError).message).not.toContain('not-a-real-value');
    expect((error as AdsAuthError).body).toBe('');
  });
});

describe('TokenProvider', () => {
  it('caches until 60 seconds before expiry, then refreshes', async () => {
    const server = createMockServer([
      {
        method: 'POST',
        match: '/auth/o2/token',
        responses: [
          { status: 200, json: { access_token: 'fake-token-one', expires_in: 3600 } },
          { status: 200, json: { access_token: 'fake-token-two', expires_in: 3600 } },
        ],
      },
    ]);
    const time = clock();
    const provider = new TokenProvider(CREDENTIALS, { fetch: server.fetch, now: time.now });

    expect(await provider.getAccessToken()).toBe('fake-token-one');
    // One second inside the margin: still the cached token.
    time.advance((3600 - 61) * 1_000);
    expect(await provider.getAccessToken()).toBe('fake-token-one');
    expect(server.requests).toHaveLength(1);

    // One second past it: refreshed, well before Amazon would have refused it.
    time.advance(2_000);
    expect(await provider.getAccessToken()).toBe('fake-token-two');
    expect(server.requests).toHaveLength(2);
  });

  it('shares one refresh between concurrent callers', async () => {
    const server = createMockServer([
      {
        method: 'POST',
        match: '/auth/o2/token',
        responses: [{ status: 200, json: { access_token: 'fake-token-one', expires_in: 3600 } }],
      },
    ]);
    const provider = new TokenProvider(CREDENTIALS, { fetch: server.fetch, now: clock().now });

    const tokens = await Promise.all([
      provider.getAccessToken(),
      provider.getAccessToken(),
      provider.getAccessToken(),
    ]);

    expect(tokens).toEqual(['fake-token-one', 'fake-token-one', 'fake-token-one']);
    expect(server.requests).toHaveLength(1);
  });

  it('mints a new token on a forced refresh', async () => {
    const server = createMockServer([
      {
        method: 'POST',
        match: '/auth/o2/token',
        responses: [
          { status: 200, json: { access_token: 'fake-token-one', expires_in: 3600 } },
          { status: 200, json: { access_token: 'fake-token-two', expires_in: 3600 } },
        ],
      },
    ]);
    const provider = new TokenProvider(CREDENTIALS, { fetch: server.fetch, now: clock().now });

    expect(await provider.getAccessToken()).toBe('fake-token-one');
    expect(await provider.forceRefresh()).toBe('fake-token-two');
    expect(await provider.getAccessToken()).toBe('fake-token-two');
    expect(server.requests).toHaveLength(2);
  });

  it('sends the refresh grant Amazon expects', async () => {
    const server = createMockServer([
      {
        method: 'POST',
        match: '/auth/o2/token',
        responses: [{ status: 200, json: { access_token: 'fake-token-one', expires_in: 3600 } }],
      },
    ]);
    await refreshAccessToken(CREDENTIALS, { fetch: server.fetch });

    const form = new URLSearchParams(server.requests[0]?.body ?? '');
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe(CREDENTIALS.refreshToken);
    expect(form.get('client_id')).toBe(CREDENTIALS.clientId);
  });
});
