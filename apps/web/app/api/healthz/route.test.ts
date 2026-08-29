import { afterEach, describe, expect, it } from 'vitest';
import { GET } from './route';

const REVISION = 'c'.repeat(40);
const ENV_NAMES = [
  'VERCEL_GIT_COMMIT_SHA',
  'OPENSPELL_APP_VERSION',
  'WIZARD_ADS_APP_VERSION',
] as const;
const SAVED_ENV = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of ENV_NAMES) {
    const saved = SAVED_ENV[name];
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
});

describe('GET /api/healthz', () => {
  it('returns a public normalized Vercel revision without caching', async () => {
    process.env['VERCEL_GIT_COMMIT_SHA'] = REVISION.toUpperCase();
    delete process.env['OPENSPELL_APP_VERSION'];
    delete process.env['WIZARD_ADS_APP_VERSION'];

    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
    expect(await response.json()).toEqual({
      product: 'OpenSpell',
      status: 'ready',
      revision: REVISION,
    });
  });

  it('returns a null revision when no valid public build revision exists', async () => {
    delete process.env['VERCEL_GIT_COMMIT_SHA'];
    process.env['OPENSPELL_APP_VERSION'] = 'not-a-git-revision';
    delete process.env['WIZARD_ADS_APP_VERSION'];

    expect(await GET().json()).toEqual({
      product: 'OpenSpell',
      status: 'ready',
      revision: null,
    });
  });
});
