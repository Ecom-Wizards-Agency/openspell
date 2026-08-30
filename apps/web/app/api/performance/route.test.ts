import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';

const REVISION = 'e'.repeat(40);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('performance endpoint', () => {
  it('returns only sanitized, non-cacheable revision metadata', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', REVISION);
    const response = GET();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-openspell-performance-evidence')).toBe('diagnostic-only');
    await expect(response.json()).resolves.toEqual({
      revision: REVISION,
      rum_evidence: 'diagnostic_only',
    });
  });

  it('logs an exact-revision event and no request metadata', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', REVISION);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const event = {
      event: 'openspell.route_ready',
      evidence: 'diagnostic_only',
      pathname: '/grid',
      revision: REVISION,
      duration_ms: 125,
      navigation_type: 'spa',
    };
    const response = await POST(new Request('https://example.test/api/performance', {
      method: 'POST',
      headers: { cookie: 'private-cookie=private-value', 'content-type': 'application/json' },
      body: JSON.stringify(event),
    }));

    expect(response.status).toBe(204);
    expect(info).toHaveBeenCalledWith(JSON.stringify(event));
    expect(String(info.mock.calls[0]?.[0])).not.toContain('private-cookie');
  });

  it('refuses stale revisions and malformed payloads without logging', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', REVISION);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const stale = await POST(new Request('https://example.test/api/performance', {
      method: 'POST',
      body: JSON.stringify({
        event: 'openspell.route_ready',
        evidence: 'diagnostic_only',
        pathname: '/grid',
        revision: 'f'.repeat(40),
        duration_ms: 10,
        navigation_type: 'spa',
      }),
    }));
    const malformed = await POST(new Request('https://example.test/api/performance', {
      method: 'POST',
      body: JSON.stringify({ ...validVital(), value: 'not numeric' }),
    }));

    expect(stale.status).toBe(409);
    expect(malformed.status).toBe(400);
    expect(info).not.toHaveBeenCalled();
  });
});

function validVital() {
  return {
    event: 'openspell.web_vital',
    evidence: 'diagnostic_only',
    pathname: '/dashboard',
    revision: REVISION,
    metric: 'LCP',
    value: 100,
    rating: 'good',
    navigation_type: 'navigate',
  };
}
