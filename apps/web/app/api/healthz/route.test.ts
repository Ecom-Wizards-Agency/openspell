import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route.js';

describe('GET /api/healthz', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns public liveness with the exact sanitized build revision', async () => {
    vi.stubEnv('OPENSPELL_WEB_REVISION', '1234567890abcdef1234567890abcdef12345678');

    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      product: 'OpenSpell',
      revision: '1234567890abcdef1234567890abcdef12345678',
      revisionSource: 'explicit',
    });
  });

  it('reports Vercel authority and fails closed on an override conflict', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '1234567890abcdef1234567890abcdef12345678');
    vi.stubEnv('OPENSPELL_WEB_REVISION', 'abcdef1234567890abcdef1234567890abcdef12');

    await expect(GET().json()).resolves.toMatchObject({
      revision: 'unknown',
      revisionSource: 'unknown',
    });
  });
});
