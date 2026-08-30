import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const LAUNCHER = 'apps/web/scripts/verify-release-candidate.sh';
const REVISION = 'f'.repeat(40);
const CANDIDATE = 'https://wizard-synthetic-ecom-wizards.vercel.app';
const VERCEL_CONTEXT = ['synthetic', 'vercel', 'context'].join('-');

describe('release verifier subprocess boundary', () => {
  it('uses existing Vercel auth without a bypass secret and emits only a fixed failure', () => {
    const fixture = makeFixture();
    const preloadMessage = ['preload', 'private', 'message'].join('-');
    const preload = join(fixture.root, 'preload.cjs');
    writeFileSync(preload, `process.stderr.write('${preloadMessage}')`);
    try {
      const result = spawnSync('bash', [LAUNCHER, CANDIDATE, REVISION], {
        cwd: ROOT,
        env: {
          ...process.env,
          PATH: `${fixture.bin}:${process.env['PATH'] ?? ''}`,
          HOME: fixture.root,
          XDG_DATA_HOME: join(fixture.root, 'xdg-data'),
          VERCEL_TOKEN: VERCEL_CONTEXT,
          OPENSPELL_CDP_URL: 'http://127.0.0.1:1',
          NODE_OPTIONS: `--require=${preload}`,
          DEBUG: '*',
          DATABASE_URL: ['synthetic', 'database', 'value'].join('-'),
          ADS_REFRESH_TOKEN: ['synthetic', 'ads', 'value'].join('-'),
        },
        encoding: 'utf8',
        timeout: 30_000,
      });
      const output = `${result.stdout}${result.stderr}`;

      expect(output).toBe('OPENSPELL_RELEASE_ERROR:cdp_unavailable\n');
      for (const privateValue of [preloadMessage, VERCEL_CONTEXT, CANDIDATE]) {
        expect(output).not.toContain(privateValue);
      }
    } finally {
      fixture.cleanup();
    }
  });
});

function makeFixture(): { root: string; bin: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'openspell-release-process-'));
  const bin = join(root, 'bin');
  const vercel = join(bin, 'vercel');
  mkdirSync(bin);
  writeFileSync(vercel, `#!/bin/sh
if [ "$#" -ne 8 ] || [ "$1" != 'curl' ] || [ "$2" != '/api/healthz' ] || [ "$3" != '--deployment' ] || [ "$4" != '${CANDIDATE}' ] || [ "$5" != '--' ] || [ "$6" != '--disable' ] || [ "$7" != '--config' ] || [ "$8" != '-' ]; then exit 41; fi
if [ -n "\${NODE_OPTIONS+x}" ] || [ -n "\${DEBUG+x}" ] || [ -n "\${DATABASE_URL+x}" ] || [ -n "\${ADS_REFRESH_TOKEN+x}" ] || [ -n "\${OPENSPELL_CDP_URL+x}" ] || [ -n "\${VERCEL_AUTOMATION_BYPASS_SECRET+x}" ]; then exit 42; fi
if [ "\${VERCEL_TOKEN:-}" != '${VERCEL_CONTEXT}' ] || [ "\${VERCEL_TELEMETRY_DISABLED:-}" != '1' ]; then exit 43; fi
case "$*" in *'${VERCEL_CONTEXT}'*) exit 44;; esac
input="$(sed -n '1,120p')"
printf '{"product":"OpenSpell","status":"ok","revision":"${REVISION}"}\\nOPENSPELL_RESPONSE:200\\t\\t'
`);
  chmodSync(vercel, 0o755);
  return {
    root,
    bin,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
