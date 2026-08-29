import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const LAUNCHER = 'apps/web/scripts/verify-release-candidate.sh';
const REVISION = 'f'.repeat(40);

describe('release verifier subprocess boundary', () => {
  it('runs the documented root launcher without echoing credentialed environment inputs', () => {
    const candidateUsername = ['candidate', 'user'].join('-');
    const candidatePassword = ['candidate', 'password'].join('-');
    const candidateHostname = `${['wizard', 'synthetic', 'ecom', 'wizards'].join('-')}.vercel.app`;
    const cdpUsername = ['cdp', 'user'].join('-');
    const cdpPassword = ['cdp', 'password'].join('-');
    const cdpHostname = `${['private', 'cdp', 'host'].join('-')}.test`;
    const candidateUrl = `https://${candidateUsername}:${candidatePassword}@${candidateHostname}`;
    const cdpUrl = `https://${cdpUsername}:${cdpPassword}@${cdpHostname}:9222`;

    const result = runLauncher({
      DEBUG: '*',
      NODE_DEBUG: 'child_process',
      NODE_DEBUG_NATIVE: 'HTTP',
      PWDEBUG: 'console',
      OPENSPELL_RELEASE_CANDIDATE_URL: candidateUrl,
      OPENSPELL_RELEASE_EXPECTED_REVISION: REVISION,
      OPENSPELL_CDP_URL: cdpUrl,
    });
    const output = combinedOutput(result);

    expect(result.status).toBe(1);
    expect(output).toBe('OPENSPELL_RELEASE_ERROR:invalid_candidate\n');
    expectNoSensitiveOutput(output, [
      candidateUrl,
      candidateUsername,
      candidatePassword,
      candidateHostname,
      cdpUrl,
      cdpUsername,
      cdpPassword,
      cdpHostname,
    ]);
  });

  it('isolates hostile curl config, strips unrelated secrets, then sanitizes Playwright failure', () => {
    const fixture = verifierFixture('health');
    const hostileCurlHome = join(fixture.root, 'hostile-curl-home');
    const hostileValue = ['hostile', 'curl', 'value'].join('-');
    const unrelatedValue = ['unrelated', 'runtime', 'secret'].join('-');
    const databaseValue = ['database', 'credential', 'value'].join('-');
    const adsValue = ['amazon', 'credential', 'value'].join('-');
    const cdpUsername = ['cdp', 'user'].join('-');
    const cdpPassword = ['cdp', 'password'].join('-');
    const cdpHostname = '127.0.0.1';
    mkdirSync(hostileCurlHome);
    writeFileSync(join(hostileCurlHome, '.curlrc'), `header = "X-Leak: ${hostileValue}"\n`);

    try {
      const result = runLauncher({
        PATH: `${fixture.bin}:${process.env['PATH'] ?? ''}`,
        CURL_HOME: hostileCurlHome,
        DEBUG: '*',
        NODE_DEBUG: 'child_process',
        NODE_DEBUG_NATIVE: 'HTTP',
        PWDEBUG: 'console',
        OPENSPELL_RELEASE_CANDIDATE_URL: fixture.candidateUrl,
        OPENSPELL_RELEASE_EXPECTED_REVISION: REVISION,
        OPENSPELL_CDP_URL: `http://${cdpUsername}:${cdpPassword}@${cdpHostname}:1`,
        UNRELATED_RELEASE_SECRET: unrelatedValue,
        DATABASE_URL: databaseValue,
        ADS_REFRESH_TOKEN: adsValue,
      });
      const output = combinedOutput(result);

      expect(result.status).toBe(1);
      expect(output).toBe('OPENSPELL_RELEASE_ERROR:cdp_unavailable\n');
      expect(readFileSync(fixture.sentinel, 'utf8')).toBe('isolated');
      expectNoSensitiveOutput(output, [
        hostileValue,
        unrelatedValue,
        databaseValue,
        adsValue,
        cdpUsername,
        cdpPassword,
        cdpHostname,
        fixture.candidateHostname,
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it('discards a Vercel child failure message instead of relaying it', () => {
    const fixture = verifierFixture('fail');
    const providerUsername = ['provider', 'user'].join('-');
    const providerPassword = ['provider', 'password'].join('-');
    const providerHostname = `${['private', 'provider', 'host'].join('-')}.test`;
    writeFileSync(
      fixture.vercel,
      `#!/bin/sh\nprintf '%s\\n' 'failed at https://${providerUsername}:${providerPassword}@${providerHostname}' >&2\nexit 23\n`,
    );
    chmodSync(fixture.vercel, 0o755);

    try {
      const result = runLauncher({
        PATH: `${fixture.bin}:${process.env['PATH'] ?? ''}`,
        OPENSPELL_RELEASE_CANDIDATE_URL: fixture.candidateUrl,
        OPENSPELL_RELEASE_EXPECTED_REVISION: REVISION,
      });
      const output = combinedOutput(result);

      expect(result.status).toBe(1);
      expect(output).toBe('OPENSPELL_RELEASE_ERROR:vercel_stream_failed\n');
      expectNoSensitiveOutput(output, [providerUsername, providerPassword, providerHostname]);
    } finally {
      fixture.cleanup();
    }
  });
});

function verifierFixture(mode: 'health' | 'fail') {
  const root = mkdtempSync(join(tmpdir(), 'openspell-verifier-test-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const sentinel = join(root, 'sentinel');
  const vercel = join(bin, 'vercel');
  const candidateHostname = `${['wizard', 'synthetic', 'ecom', 'wizards'].join('-')}.vercel.app`;
  const candidateUrl = `https://${candidateHostname}`;

  if (mode === 'health') {
    writeFileSync(vercel, `#!/bin/sh
sentinel="$(dirname "$0")/../sentinel"
if [ -n "\${DEBUG+x}" ] || [ -n "\${NODE_DEBUG+x}" ] || [ -n "\${NODE_DEBUG_NATIVE+x}" ] || [ -n "\${PWDEBUG+x}" ]; then
  printf '%s' 'debug-leak' > "$sentinel"
  exit 31
fi
if [ -n "\${UNRELATED_RELEASE_SECRET+x}" ] || [ -n "\${DATABASE_URL+x}" ] || [ -n "\${ADS_REFRESH_TOKEN+x}" ] || [ -n "\${OPENSPELL_RELEASE_CANDIDATE_URL+x}" ] || [ -n "\${OPENSPELL_CDP_URL+x}" ]; then
  printf '%s' 'environment-leak' > "$sentinel"
  exit 32
fi
case "\${CURL_HOME:-}" in
  */openspell-release-*) ;;
  *) printf '%s' 'curl-home-not-isolated' > "$sentinel"; exit 33 ;;
esac
if [ ! -f "$CURL_HOME/.curlrc" ] || [ -s "$CURL_HOME/.curlrc" ]; then
  printf '%s' 'curl-config-not-empty' > "$sentinel"
  exit 34
fi
seen_disable=0
for argument in "$@"; do
  case "$argument" in
    --disable) seen_disable=1 ;;
    --location|--max-redirs) printf '%s' 'automatic-redirect-enabled' > "$sentinel"; exit 35 ;;
  esac
done
if [ "$seen_disable" -ne 1 ]; then
  printf '%s' 'curl-config-not-disabled' > "$sentinel"
  exit 36
fi
printf '%s' 'isolated' > "$sentinel"
printf '%s' '{"product":"OpenSpell","status":"ready","revision":"${REVISION}"}OPENSPELL_STATUS:200OPENSPELL_REDIRECT:'
`);
  } else {
    writeFileSync(vercel, '#!/bin/sh\nexit 23\n');
  }
  chmodSync(vercel, 0o755);

  return {
    root,
    bin,
    sentinel,
    vercel,
    candidateHostname,
    candidateUrl,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runLauncher(environment: Record<string, string | undefined>) {
  return spawnSync('bash', [LAUNCHER], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...environment },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function combinedOutput(result: ReturnType<typeof runLauncher>): string {
  return `${result.stdout}${result.stderr}`;
}

function expectNoSensitiveOutput(output: string, values: readonly string[]): void {
  for (const value of values) expect(output).not.toContain(value);
}
