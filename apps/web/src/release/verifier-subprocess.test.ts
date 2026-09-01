import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const LAUNCHER = 'apps/web/scripts/verify-release-candidate.sh';
const TSX_CLI = realFile('node_modules/tsx/dist/cli.mjs');
const REVISION = 'f'.repeat(40);
const CANDIDATE = 'https://wizard-synthetic-ecom-wizards.vercel.app';
const VERCEL_CONTEXT = ['synthetic', 'vercel', 'context'].join('-');

describe('release verifier subprocess boundary', () => {
  it('uses existing Vercel auth without a bypass secret and emits only a fixed failure', () => {
    const fixture = makeFixture();
    try {
      const result = fixtureRun(fixture, 'http://127.0.0.1:1', {
        NODE_ENV: 'test',
        DEBUG: '*',
        HTTPS_PROXY: 'https://127.0.0.1:9',
        SSL_CERT_FILE: join(fixture.root, 'synthetic-ca.pem'),
        DATABASE_URL: ['synthetic', 'database', 'value'].join('-'),
        ADS_REFRESH_TOKEN: ['synthetic', 'ads', 'value'].join('-'),
      });
      const output = `${result.stdout}${result.stderr}`;

      expect(output).toBe('OPENSPELL_RELEASE_ERROR:cdp_unavailable\n');
      expect(readFileSync(fixture.trace, 'utf8')).toBe(
        '/api/healthz\n/brand/wizards-ai-icon.svg\n',
      );
      for (const privateValue of [VERCEL_CONTEXT, CANDIDATE]) {
        expect(output).not.toContain(privateValue);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('the production launcher strips preload state before rejecting invalid input', () => {
    const fixture = makeFixture();
    const preloadMessage = ['preload', 'production', 'message'].join('-');
    const preload = join(fixture.root, 'preload.cjs');
    writeFileSync(preload, `process.stderr.write('${preloadMessage}')`);
    try {
      const result = spawnSync('bash', [LAUNCHER, 'https://invalid.example', REVISION], {
        cwd: ROOT,
        env: {
          ...process.env,
          PATH: `${fixture.bin}:${process.env['PATH'] ?? ''}`,
          HOME: fixture.root,
          XDG_DATA_HOME: join(fixture.root, 'xdg-data'),
          VERCEL_TOKEN: VERCEL_CONTEXT,
          NODE_OPTIONS: `--require=${preload}`,
        },
        encoding: 'utf8',
        timeout: 30_000,
      });
      const output = `${result.stdout}${result.stderr}`;

      expect(output).toBe('OPENSPELL_RELEASE_ERROR:candidate_invalid\n');
      expect(output).not.toContain(preloadMessage);
      expect(existsSync(fixture.trace)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects a remote CDP endpoint after public checks and before connection', () => {
    const fixture = makeFixture();
    try {
      const result = fixtureRun(fixture, 'https://remote.invalid:9222');

      expect(`${result.stdout}${result.stderr}`).toBe(
        'OPENSPELL_RELEASE_ERROR:cdp_unavailable\n',
      );
      expect(result.status).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });
});

function makeFixture(): {
  root: string;
  bin: string;
  entry: string;
  trace: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'openspell-release-process-'));
  const bin = join(root, 'bin');
  const vercel = join(bin, 'vercel');
  const trace = `${vercel}.trace`;
  const entry = join(root, 'verifier-entry.mts');
  const asset = join(ROOT, 'apps/web/public/brand/wizards-ai-icon.svg');
  mkdirSync(bin);
  writeFileSync(vercel, `#!/bin/sh
if [ "$#" -ne 8 ] || [ "$3" != '--deployment' ] || [ "$4" != '${CANDIDATE}' ] || [ "$5" != '--' ] || [ "$6" != '--disable' ] || [ "$7" != '--config' ] || [ "$8" != '-' ]; then exit 41; fi
if [ "$1" != 'curl' ] || { [ "$2" != '/api/healthz' ] && [ "$2" != '/brand/wizards-ai-icon.svg' ]; }; then exit 41; fi
if [ -n "\${NODE_OPTIONS+x}" ] || [ -n "\${DEBUG+x}" ] || [ -n "\${DATABASE_URL+x}" ] || [ -n "\${ADS_REFRESH_TOKEN+x}" ] || [ -n "\${OPENSPELL_CDP_URL+x}" ] || [ -n "\${OPENSPELL_TEST_VERCEL+x}" ] || [ -n "\${VERCEL_AUTOMATION_BYPASS_SECRET+x}" ] || [ -n "\${HTTPS_PROXY+x}" ] || [ -n "\${SSL_CERT_FILE+x}" ]; then exit 42; fi
if [ "\${VERCEL_TOKEN:-}" != '${VERCEL_CONTEXT}' ] || [ "\${VERCEL_TELEMETRY_DISABLED:-}" != '1' ] || [ "\${VERCEL_CLI_USE_NATIVE_BINARY:-}" != '0' ] || [ "\${PATH:-}" != '/usr/bin' ]; then exit 43; fi
case "$*" in *'${VERCEL_CONTEXT}'*) exit 44;; esac
input="$(sed -n '1,120p')"
case "$input" in *'Cookie:'*) exit 45;; esac
printf '%s\\n' "$2" >> "$0.trace"
if [ "$2" = '/api/healthz' ]; then
  printf '{"product":"Open%s","status":"%s",' 'Spell' 'ok'
  printf '"revision":"%s","revisionSource":"%s"}' '${REVISION}' 'vercel'
  printf '\\nOPEN%s_RESPONSE:200\\t' 'SPELL'
  printf '%s/api/healthz\\t' '${CANDIDATE}'
  printf '{"content-type":["application/json"]}'
else
  cat '${asset}'
  printf '\\nOPEN%s_RESPONSE:200\\t' 'SPELL'
  printf '%s/brand/wizards-ai-icon.svg\\t' '${CANDIDATE}'
  printf '{"content-type":["image/svg+xml"]}'
fi
`);
  chmodSync(vercel, 0o755);
  writeFileSync(entry, `
import { runReleaseCandidateCli } from ${JSON.stringify(pathToFileURL(join(
    ROOT,
    'apps/web/scripts/verify-release-candidate.ts',
  )).href)};
import { requestCandidateWithTestLauncher } from ${JSON.stringify(pathToFileURL(join(
    ROOT,
    'apps/web/src/release/candidate-transport.ts',
  )).href)};

const command = process.env['OPENSPELL_TEST_VERCEL'];
delete process.env['OPENSPELL_TEST_VERCEL'];
if (command === undefined) throw new Error('test launcher missing');
await runReleaseCandidateCli((input) => requestCandidateWithTestLauncher(input, {
  command,
  argumentsPrefix: [],
  systemPath: '/usr/bin',
}));
process.exit(process.exitCode ?? 0);
`);
  return {
    root,
    bin,
    entry,
    trace,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function fixtureRun(
  fixture: ReturnType<typeof makeFixture>,
  cdpUrl: string,
  additionalEnvironment: NodeJS.ProcessEnv = { NODE_ENV: 'test' },
) {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...additionalEnvironment,
    NODE_ENV: 'test',
    PATH: `${fixture.bin}:${process.env['PATH'] ?? ''}`,
    HOME: fixture.root,
    XDG_DATA_HOME: join(fixture.root, 'xdg-data'),
    VERCEL_TOKEN: VERCEL_CONTEXT,
    OPENSPELL_CDP_URL: cdpUrl,
    OPENSPELL_TEST_VERCEL: join(fixture.bin, 'vercel'),
  };
  // The production Bash launcher proves preload removal separately. This test
  // subprocess starts through Node directly so its fixture can inject a CLI by
  // function argument rather than a production environment seam.
  delete environment['NODE_OPTIONS'];
  return spawnSync(process.execPath, [TSX_CLI, fixture.entry, CANDIDATE, REVISION], {
    cwd: ROOT,
    env: environment,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function realFile(path: string): string {
  return fileURLToPath(pathToFileURL(join(ROOT, path)));
}
