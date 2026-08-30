import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface VercelConfig {
  $schema?: unknown;
  regions?: unknown;
  crons?: unknown;
}

function readVercelConfig(): VercelConfig {
  const configUrl = new URL('../../vercel.json', import.meta.url);
  return JSON.parse(readFileSync(configUrl, 'utf8')) as VercelConfig;
}

describe('Vercel function region', () => {
  it('keeps all server work in the single Frankfurt data-source region', () => {
    const config = readVercelConfig();

    expect(config.$schema).toBe('https://openapi.vercel.sh/vercel.json');
    expect(config.regions).toEqual(['fra1']);
  });

  it('preserves the existing synchronization schedule', () => {
    const config = readVercelConfig();

    expect(config.crons).toEqual([
      {
        path: '/api/cron/sync',
        schedule: '*/5 * * * *',
      },
    ]);
  });
});
