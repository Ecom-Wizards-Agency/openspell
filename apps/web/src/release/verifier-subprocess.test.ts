import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const LAUNCHER = 'apps/web/scripts/verify-release-candidate.sh';
const REVISION = 'f'.repeat(40);
const HOST = 'wizard-ads-synthetic.vercel.app';

describe('release verifier subprocess boundary', () => {
  it('rejects credentialed candidates before starting transport and redacts every input', () => {
    const user = ['candidate', 'user'].join('-');
    const password = ['candidate', 'password'].join('-');
    const result = run({ OPENSPELL_RELEASE_CANDIDATE_URL: `https://${user}:${password}@${HOST}` });
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toBe('OPENSPELL_RELEASE_ERROR:invalid_candidate\n');
    for (const value of [user, password, HOST]) expect(output).not.toContain(value);
  });

  it('rejects an explicit default port before URL normalization or transport', () => {
    const result = run({ OPENSPELL_RELEASE_CANDIDATE_URL: `https://${HOST}:443/` });
    const output = `${result.stdout}${result.stderr}`;

    expect(output).toBe('OPENSPELL_RELEASE_ERROR:invalid_candidate\n');
    expect(output).not.toContain(HOST);
  });

  it('rejects a trailing line terminator before URL normalization or transport', () => {
    const result = run({ OPENSPELL_RELEASE_CANDIDATE_URL: `https://${HOST}\n` });
    const output = `${result.stdout}${result.stderr}`;

    expect(output).toBe('OPENSPELL_RELEASE_ERROR:invalid_candidate\n');
    expect(output).not.toContain(HOST);
  });

  it('uses static curl argv, isolated config, minimal env, binds metadata first, and strips diagnostic loaders', () => {
    const fixture = makeCurl('healthy');
    const preload = join(fixture.root, 'preload.cjs');
    const preloadSecret = ['node', 'preload', 'secret'].join('-');
    writeFileSync(preload, `process.stderr.write('${preloadSecret}')`);
    try {
      const result = run({
        PATH: `${fixture.bin}:${process.env['PATH'] ?? ''}`,
        OPENSPELL_RELEASE_CANDIDATE_URL: `https://${HOST}`,
        OPENSPELL_CDP_URL: 'http://127.0.0.1:1',
        NODE_OPTIONS: `--require=${preload}`,
        NODE_V8_COVERAGE: join(fixture.root, 'coverage'),
        DEBUG: '*', PWDEBUG: 'console', DATABASE_URL: 'database-secret', ADS_REFRESH_TOKEN: 'ads-secret',
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toBe('OPENSPELL_RELEASE_ERROR:cdp_unavailable\n');
      expect(readFileSync(fixture.sentinel, 'utf8')).toBe('ok');
      for (const value of [preloadSecret, 'database-secret', 'ads-secret', HOST, 'api-secret', 'bypass-secret']) expect(output).not.toContain(value);
    } finally { fixture.cleanup(); }
  });

  it.each([
    ['large-healthy', 'OPENSPELL_RELEASE_ERROR:cdp_unavailable\n'],
    ['mismatch', 'OPENSPELL_RELEASE_ERROR:candidate_binding_candidate_mismatch\n'],
    ['not-ready', 'OPENSPELL_RELEASE_ERROR:candidate_binding_not_ready\n'],
    ['wrong-target', 'OPENSPELL_RELEASE_ERROR:candidate_binding_target_mismatch\n'],
    ['redirect', 'OPENSPELL_RELEASE_ERROR:candidate_binding_request_failed\n'],
    ['fail', 'OPENSPELL_RELEASE_ERROR:curl_stream_failed\n'],
    ['oversize', 'OPENSPELL_RELEASE_ERROR:curl_output_exceeded\n'],
  ] as const)('returns a fixed diagnostic for %s metadata transport', (mode, expected) => {
    const fixture = makeCurl(mode);
    try {
      const result = run({
        PATH: `${fixture.bin}:${process.env['PATH'] ?? ''}`,
        OPENSPELL_RELEASE_CANDIDATE_URL: `https://${HOST}`,
        OPENSPELL_CDP_URL: 'http://127.0.0.1:1',
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toBe(expected);
      expect(output).not.toContain('provider-private-message');
    } finally { fixture.cleanup(); }
  });
});

function makeCurl(mode: 'healthy' | 'large-healthy' | 'mismatch' | 'not-ready' | 'wrong-target' | 'redirect' | 'fail' | 'oversize') {
  const root = mkdtempSync(join(tmpdir(), 'openspell-curl-test-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const curl = join(bin, 'curl');
  const sentinel = join(root, 'sentinel');
  const metadataHost = mode === 'mismatch' ? 'wizard-ads-other.vercel.app' : HOST;
  const ready = mode === 'not-ready' ? 'BUILDING' : 'READY';
  const target = mode === 'wrong-target' ? 'preview' : 'production';
  const metadataStatus = mode === 'redirect' ? '307' : '200';
  writeFileSync(curl, `#!/bin/sh
sentinel="$(dirname "$0")/../sentinel"
count_file="$(dirname "$0")/../count"
if [ "$#" -ne 3 ] || [ "$1" != '--disable' ] || [ "$2" != '--config' ] || [ "$3" != '-' ]; then exit 41; fi
if [ -n "\${NODE_OPTIONS+x}" ] || [ -n "\${NODE_V8_COVERAGE+x}" ] || [ -n "\${DEBUG+x}" ] || [ -n "\${DATABASE_URL+x}" ] || [ -n "\${ADS_REFRESH_TOKEN+x}" ] || [ -n "\${VERCEL_TOKEN+x}" ] || [ -n "\${OPENSPELL_RELEASE_CANDIDATE_URL+x}" ]; then exit 42; fi
case "\${CURL_HOME:-}" in */openspell-release-*) ;; *) exit 43 ;; esac
[ -f "$CURL_HOME/.curlrc" ] && [ ! -s "$CURL_HOME/.curlrc" ] || exit 44
input="$(sed -n '1,120p')"
n=0; [ -f "$count_file" ] && n="$(cat "$count_file")"; n=$((n+1)); printf '%s' "$n" > "$count_file"
if [ "$n" -eq 1 ]; then
  printf '%s' "$input" | grep -q 'url = "https://api.vercel.com/v13/deployments/' || exit 45
  printf '%s' "$input" | grep -q 'Authorization: Bearer api-secret' || exit 46
  ! printf '%s' "$input" | grep -q 'x-vercel-protection-bypass' || exit 47
  ${mode === 'fail' ? "printf '%s' 'provider-private-message' >&2; exit 23" : ':'}
  ${mode === 'oversize' ? "head -c 68157440 /dev/zero | tr '\\000' x; exit 0" : ':'}
  printf '%s' 'ok' > "$sentinel"
  printf 'HTTP/1.1 ${metadataStatus} Status\\r\\n\\r\\n{"url":"${metadataHost}","projectId":"project-synthetic","ownerId":"org-synthetic","readyState":"${ready}","target":"${target}"'
  printf '}\\nOPENSPELL_STATUS:${metadataStatus}'
else
  printf '%s' "$input" | grep -q 'url = "https://${HOST}/api/healthz"' || exit 48
  printf '%s' "$input" | grep -q 'x-vercel-protection-bypass: bypass-secret' || exit 49
  ! printf '%s' "$input" | grep -q 'Authorization: Bearer' || exit 50
  printf 'HTTP/1.1 200 OK\\r\\n\\r\\n{"product":"OpenSpell","status":"ready","revision":"${REVISION}"'
  ${mode === 'large-healthy' ? "printf ',\"padding\":\"'; head -c 3145728 /dev/zero | tr '\\000' x; printf '\"'" : ':'}
  printf '}\\nOPENSPELL_STATUS:200'
fi
`);
  chmodSync(curl, 0o755);
  return { root, bin, sentinel, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function run(extra: Record<string, string>) {
  return spawnSync('bash', [LAUNCHER], {
    cwd: ROOT,
    env: {
      ...process.env,
      OPENSPELL_RELEASE_EXPECTED_REVISION: REVISION,
      VERCEL_TOKEN: 'api-secret', VERCEL_PROJECT_ID: 'project-synthetic', VERCEL_ORG_ID: 'org-synthetic',
      VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass-secret',
      ...extra,
    },
    encoding: 'utf8', timeout: 30_000,
  });
}
