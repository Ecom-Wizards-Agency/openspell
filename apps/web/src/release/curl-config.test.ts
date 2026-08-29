import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildReleaseCurlConfig } from '../../scripts/verify-release-candidate';

describe('release curl config', () => {
  it('is accepted by real system curl and emits the response marker', () => {
    const result = spawnSync('curl', ['--disable', '--config', '-'], {
      input: buildReleaseCurlConfig({ url: 'file:///dev/null' }),
      encoding: 'utf8',
      timeout: 5_000,
      env: { PATH: process.env['PATH'], NODE_ENV: 'test' },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.endsWith('\nOPENSPELL_STATUS:000')).toBe(true);
  });
});
