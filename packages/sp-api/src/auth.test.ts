import { describe, expect, it } from 'vitest';
import { LwaRefreshTokenProvider, SpApiAuthError, SpApiClient } from './index.js';

const value = (kind: string): string => ['synthetic', kind, 'value'].join('-');

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('LwaRefreshTokenProvider', () => {
  it('shares and caches one exchange, then rereads custody after invalidation', async () => {
    let now = 1_000;
    let refreshReads = 0;
    const requests: Array<{ url: string; body: string }> = [];
    const provider = new LwaRefreshTokenProvider({
      clientId: value('app-id'),
      clientSecret: value('app-key'),
      refreshTokenProvider: async () => {
        refreshReads += 1;
        return value(`refresh-${refreshReads}`);
      },
      now: () => now,
      fetch: async (url, init) => {
        requests.push({ url, body: String(init?.body) });
        return response(200, {
          access_token: value(`access-${requests.length}`),
          expires_in: 3_600,
        });
      },
    });

    const first = await Promise.all([
      provider.getAccessToken(),
      provider.getAccessToken(),
      provider.getAccessToken(),
    ]);
    expect(first).toEqual(Array(3).fill(value('access-1')));
    expect(requests).toHaveLength(1);
    expect(refreshReads).toBe(1);
    expect(requests[0]?.url).toBe('https://api.amazon.com/auth/o2/token');
    expect(new URLSearchParams(requests[0]?.body).get('grant_type')).toBe('refresh_token');

    now += 1_000;
    expect(await provider.getAccessToken()).toBe(value('access-1'));
    provider.invalidate();
    expect(await provider.getAccessToken()).toBe(value('access-2'));
    expect(refreshReads).toBe(2);
  });

  it('does not leak application or refresh credentials through provider errors', async () => {
    const appId = value('private-app-id');
    const appKey = value('private-app-key');
    const refresh = value('private-refresh');
    const provider = new LwaRefreshTokenProvider({
      clientId: appId,
      clientSecret: appKey,
      refreshTokenProvider: async () => refresh,
      fetch: async () => response(400, {
        error: 'invalid_grant',
        error_description: `provider echoed ${refresh}`,
      }),
    });

    const error = await provider.getAccessToken().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SpApiAuthError);
    const rendered = `${String(error)} ${JSON.stringify(error)}`;
    expect(rendered).not.toContain(appId);
    expect(rendered).not.toContain(appKey);
    expect(rendered).not.toContain(refresh);
    expect(rendered).toContain('invalid_grant');
  });
});

describe('SP-API auth retry', () => {
  it('invalidates once on 401 and repeats only the same read-report operation', async () => {
    let invalidations = 0;
    let tokenReads = 0;
    const methods: string[] = [];
    const client = new SpApiClient({
      endpoint: 'https://sellingpartnerapi-na.example.test',
      userAgent: 'WizardAds/test (Language=TypeScript)',
      accessTokenProvider: {
        getAccessToken: async () => value(`access-${++tokenReads}`),
        invalidate: () => { invalidations += 1; },
      },
      maxRetries: 0,
      fetch: async (_url, init) => {
        methods.push(init?.method ?? 'GET');
        return methods.length === 1
          ? response(401, { errors: [{ code: 'Unauthorized' }] })
          : response(200, { reportId: 'synthetic-report-id' });
      },
    });

    await expect(client.createReport({
      reportType: 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
      marketplaceId: 'synthetic-marketplace',
      dataStartTime: '2026-08-16T00:00:00.000Z',
      dataEndTime: '2026-08-22T23:59:59.999Z',
    })).resolves.toEqual({ reportId: 'synthetic-report-id' });
    expect(invalidations).toBe(1);
    expect(methods).toEqual(['POST', 'POST']);
  });
});
