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
    });
  });
});
