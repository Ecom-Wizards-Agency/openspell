import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lockedVercelCliLaunch } from './vercel-cli-runtime';

const WEB_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

afterEach(() => vi.unstubAllEnvs());

describe('locked Vercel CLI runtime', () => {
  it('ignores an ambient PATH executable and runs the integrity-locked package through Node', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'openspell-vercel-path-'));
    const injected = join(fixture, 'vercel');
    const trace = join(fixture, 'executed');
    writeFileSync(injected, `#!/bin/sh\nprintf used > '${trace}'\nprintf '59.5.0\\n'\n`);
    chmodSync(injected, 0o755);
    vi.stubEnv('PATH', `${fixture}:${process.env['PATH'] ?? ''}`);
    try {
      const launch = lockedVercelCliLaunch();
      expect(launch.command).toBe(realpathSync(process.execPath));
      expect(launch.argumentsPrefix).toEqual([
        realpathSync(join(WEB_ROOT, 'node_modules/vercel/dist/vc.js')),
      ]);
      expect(launch.systemPath).toBe(dirname(realpathSync('/usr/bin/curl')));
      expect(launch.systemPath).not.toContain(fixture);

      const version = spawnSync(
        launch.command,
        [...launch.argumentsPrefix, '--version'],
        {
          encoding: 'utf8',
          env: {
            CI: '1',
            HOME: fixture,
            NODE_ENV: 'production',
            PATH: launch.systemPath,
            VERCEL_CLI_USE_NATIVE_BINARY: '0',
            VERCEL_TELEMETRY_DISABLED: '1',
            XDG_CONFIG_HOME: fixture,
            XDG_DATA_HOME: fixture,
          },
          timeout: 5_000,
        },
      );
      expect(version.error).toBeUndefined();
      expect(version.status).toBe(0);
      expect(version.stdout.trim()).toBe('59.5.0');
      expect(existsSync(trace)).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('records the exact package version and registry integrity in the workspace lock', () => {
    const lock = readFileSync(join(REPOSITORY_ROOT, 'pnpm-lock.yaml'), 'utf8');
    expect(lock).toContain("vercel:\n        specifier: 59.5.0\n        version: 59.5.0(");
    expect(lock).toMatch(/vercel@59\.5\.0:\n\s+resolution: \{integrity: sha512-[A-Za-z0-9+/=]+\}/);
  });
});
