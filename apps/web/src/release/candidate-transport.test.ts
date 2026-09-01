import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ReleaseTransportError,
  buildCurlConfig,
  buildVercelCurlArgs,
  releaseFailure,
  requestCandidateWithTestLauncher,
} from './candidate-transport';
import { isCompleteGridRowsEvidence, parseGridServerTiming } from './grid-server-timing';

const CANDIDATE_ORIGIN = new URL('https://wizard-synthetic-ecom-wizards.vercel.app');
const SYNTHETIC_PROFILE = '11111111-1111-4111-8111-111111111111';
const CANDIDATE_ROUTE = new URL(`/dashboard?profile=${SYNTHETIC_PROFILE}`, CANDIDATE_ORIGIN);
const SYNTHETIC_COOKIE = [
  ['sb', 'synthetic', 'auth', 'token'].join('-'),
  ['synthetic', 'session', 'value'].join('-'),
].join('=');
const SYNTHETIC_VERCEL_TOKEN = ['synthetic', 'vercel', 'context'].join('-');

afterEach(() => vi.unstubAllEnvs());

describe('release candidate Vercel transport', () => {
  it('places only the immutable host and static path in Vercel argv', () => {
    const args = buildVercelCurlArgs(CANDIDATE_ORIGIN, CANDIDATE_ROUTE);
    const config = buildCurlConfig({
      url: CANDIDATE_ROUTE,
      cookieHeader: SYNTHETIC_COOKIE,
    });

    expect(args).toEqual([
      'curl',
      '/dashboard',
      '--deployment',
      CANDIDATE_ORIGIN.origin,
      '--',
      '--disable',
      '--config',
      '-',
    ]);
    expect(args.join(' ')).not.toContain(SYNTHETIC_PROFILE);
    expect(args.join(' ')).not.toContain(SYNTHETIC_COOKIE);
    expect(config).toContain(`url-query = "+profile=${SYNTHETIC_PROFILE}"`);
    expect(config).toContain(`Cookie: ${SYNTHETIC_COOKIE}`);
    expect(config).toContain('max-redirs = 0');
    expect(config).toContain('max-time = 30');
  });

  it('produces stdin configuration accepted by the installed system curl', () => {
    const config = buildCurlConfig({
      url: new URL('https://127.0.0.1:1/healthz'),
    });
    const result = spawnSync(
      'curl',
      ['--disable', '--url', 'https://127.0.0.1:1/healthz', '--config', '-'],
      {
        input: config,
        encoding: 'utf8',
        timeout: 5_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain('\nOPENSPELL_RESPONSE:000\t');
    expect(result.status).not.toBe(2);
  });

  it('rejects cross-origin and control-character transport inputs with fixed diagnostics', () => {
    expect(() => buildVercelCurlArgs(
      CANDIDATE_ORIGIN,
      new URL('https://different.example/dashboard'),
    )).toThrow(ReleaseTransportError);
    expect(() => buildCurlConfig({
      url: CANDIDATE_ROUTE,
      cookieHeader: `${SYNTHETIC_COOKIE}\nInjected: value`,
    })).toThrow(ReleaseTransportError);
    const sensitive = ['private', 'dependency', 'message'].join('-');
    expect(releaseFailure(new Error(sensitive))).toBe(
      'OPENSPELL_RELEASE_ERROR:unexpected_failure',
    );
    expect(releaseFailure(new Error(sensitive))).not.toContain(sensitive);
  });

  it('works without a bypass secret and isolates the existing CLI auth context', async () => {
    const fixture = fakeVercel('healthy');
    vi.stubEnv('PATH', `${fixture.root}:${process.env['PATH'] ?? ''}`);
    vi.stubEnv('HOME', fixture.root);
    vi.stubEnv('XDG_DATA_HOME', join(fixture.root, 'xdg-data'));
    vi.stubEnv('VERCEL_TOKEN', SYNTHETIC_VERCEL_TOKEN);
    vi.stubEnv('DATABASE_URL', ['synthetic', 'database', 'value'].join('-'));
    vi.stubEnv('ADS_REFRESH_TOKEN', ['synthetic', 'ads', 'value'].join('-'));
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', ['must', 'not', 'cross'].join('-'));
    vi.stubEnv('HTTPS_PROXY', 'https://127.0.0.1:9');
    vi.stubEnv('SSL_CERT_FILE', join(fixture.root, 'synthetic-ca.pem'));
    try {
      const result = await fixture.request({
        candidate: CANDIDATE_ORIGIN,
        url: CANDIDATE_ROUTE,
        cookieHeader: SYNTHETIC_COOKIE,
      });

      expect(result).toEqual({
        status: 200,
        responseBody: '{"status":"ok"}',
        responseBodySha256: `sha256:${createHash('sha256').update('{"status":"ok"}').digest('hex')}`,
        rawLocation: null,
        mediaType: 'application/json',
        effectiveUrlMatched: true,
        serverTiming: null,
      });
    } finally {
      fixture.cleanup();
    }
  });

  it('terminates a response that crosses the production output ceiling', async () => {
    const fixture = fakeVercel('oversize');
    vi.stubEnv('PATH', `${fixture.root}:${process.env['PATH'] ?? ''}`);
    vi.stubEnv('HOME', fixture.root);
    try {
      await expect(fixture.request({
        candidate: CANDIDATE_ORIGIN,
        url: new URL('/api/healthz', CANDIDATE_ORIGIN),
      })).rejects.toMatchObject({ code: 'curl_output_exceeded' });
    } finally {
      fixture.cleanup();
    }
  });

  it('reduces parameterized SVG types and mismatched effective URLs to closed evidence', async () => {
    const wrongUrl = fakeVercel('wrong-effective');
    vi.stubEnv('PATH', `${wrongUrl.root}:${process.env['PATH'] ?? ''}`);
    vi.stubEnv('HOME', wrongUrl.root);
    try {
      await expect(wrongUrl.request({
        candidate: CANDIDATE_ORIGIN,
        url: CANDIDATE_ROUTE,
      })).resolves.toMatchObject({
        mediaType: 'application/json',
        effectiveUrlMatched: false,
      });
    } finally {
      wrongUrl.cleanup();
    }

    const parameterized = fakeVercel('svg-parameterized');
    vi.stubEnv('PATH', `${parameterized.root}:${process.env['PATH'] ?? ''}`);
    vi.stubEnv('HOME', parameterized.root);
    const assetUrl = new URL('/brand/wizards-ai-icon.svg', CANDIDATE_ORIGIN);
    try {
      await expect(parameterized.request({
        candidate: CANDIDATE_ORIGIN,
        url: assetUrl,
      })).resolves.toMatchObject({
        mediaType: 'other',
        effectiveUrlMatched: true,
      });
    } finally {
      parameterized.cleanup();
    }
  });

  it.each([
    'duplicate-content-type',
    'duplicate-location',
    'duplicate-server-timing',
  ] as const)('rejects ambiguous %s response headers', async (mode) => {
    const fixture = fakeVercel(mode);
    vi.stubEnv('PATH', `${fixture.root}:${process.env['PATH'] ?? ''}`);
    vi.stubEnv('HOME', fixture.root);
    try {
      await expect(fixture.request({
        candidate: CANDIDATE_ORIGIN,
        url: CANDIDATE_ROUTE,
      })).rejects.toMatchObject({ code: 'curl_failed' });
    } finally {
      fixture.cleanup();
    }
  });

  it('uses a fresh unlinked cwd even when TMPDIR itself is Vercel-linked', async () => {
    const fixture = fakeVercel('linked-temp-parent');
    vi.stubEnv('PATH', `${fixture.root}:${process.env['PATH'] ?? ''}`);
    vi.stubEnv('HOME', fixture.root);
    vi.stubEnv('TMPDIR', fixture.root);
    vi.stubEnv('VERCEL_TOKEN', SYNTHETIC_VERCEL_TOKEN);
    try {
      await expect(fixture.request({
        candidate: CANDIDATE_ORIGIN,
        url: CANDIDATE_ROUTE,
        cookieHeader: SYNTHETIC_COOKIE,
      })).resolves.toMatchObject({ status: 200, effectiveUrlMatched: true });
      expect(readFileSync(`${fixture.root}/vercel.exit`, 'utf8')).toBe('0');
      const childCwd = readFileSync(`${fixture.root}/vercel.cwd`, 'utf8');
      expect(existsSync(childCwd)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it('removes the isolated cwd after a failed Vercel child', async () => {
    const fixture = fakeVercel('linked-temp-parent-failure');
    vi.stubEnv('PATH', `${fixture.root}:${process.env['PATH'] ?? ''}`);
    vi.stubEnv('HOME', fixture.root);
    vi.stubEnv('TMPDIR', fixture.root);
    vi.stubEnv('VERCEL_TOKEN', SYNTHETIC_VERCEL_TOKEN);
    try {
      await expect(fixture.request({
        candidate: CANDIDATE_ORIGIN,
        url: CANDIDATE_ROUTE,
        cookieHeader: SYNTHETIC_COOKIE,
      })).rejects.toMatchObject({ code: 'curl_failed' });
      expect(readFileSync(`${fixture.root}/vercel.exit`, 'utf8')).toBe('53');
      const childCwd = readFileSync(`${fixture.root}/vercel.cwd`, 'utf8');
      expect(existsSync(childCwd)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

});

describe('release Grid timing sanitizer', () => {
  it('retains only the exact fixed spans and numeric durations', () => {
    expect(parseGridServerTiming(
      'actor;dur=12.35, role;dur=7.66, profile;dur=0.01, rows;dur=104.50, ' +
      'serialize;dur=5.00, close;dur=0.50, total;dur=130.02',
    )).toEqual({
      actor: 12.35,
      role: 7.66,
      profile: 0.01,
      rows: 104.5,
      serialize: 5,
      close: 0.5,
      total: 130.02,
    });
  });

  it('rejects missing, reordered, described, or identifier-bearing spans', () => {
    expect(parseGridServerTiming('actor;dur=1, total;dur=1')).toBeNull();
    expect(parseGridServerTiming(
      'role;dur=1, actor;dur=1, profile;dur=1, rows;dur=1, serialize;dur=1, close;dur=1, total;dur=7',
    )).toBeNull();
    expect(parseGridServerTiming(
      'actor;dur=1;desc="tenant", role;dur=1, profile;dur=1, rows;dur=1, ' +
      'serialize;dur=1, close;dur=1, total;dur=7',
    )).toBeNull();
  });

  it('requires exact counts and an explicitly untruncated response', () => {
    const serverTiming = parseGridServerTiming(
      'actor;dur=1, role;dur=1, profile;dur=1, rows;dur=1, ' +
      'serialize;dur=1, close;dur=1, total;dur=7',
    );
    const complete = {
      status: 200,
      rowCount: 3,
      returnedRows: 3,
      truncated: false,
      serverTiming,
    };

    expect(isCompleteGridRowsEvidence(complete)).toBe(true);
    expect(isCompleteGridRowsEvidence({ ...complete, returnedRows: 2 })).toBe(false);
    expect(isCompleteGridRowsEvidence({ ...complete, truncated: true })).toBe(false);
    expect(isCompleteGridRowsEvidence({ ...complete, truncated: null })).toBe(false);
  });
});

function fakeVercel(
  mode:
    | 'duplicate-content-type'
    | 'duplicate-location'
    | 'duplicate-server-timing'
    | 'healthy'
    | 'linked-temp-parent'
    | 'linked-temp-parent-failure'
    | 'oversize'
    | 'svg-parameterized'
    | 'wrong-effective',
): {
  root: string;
  request: (input: {
    candidate: URL;
    url: URL;
    cookieHeader?: string;
  }) => ReturnType<typeof requestCandidateWithTestLauncher>;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'openspell-release-vercel-'));
  const executable = join(root, 'vercel');
  const expectedPath = mode === 'oversize'
    ? '/api/healthz'
    : mode === 'svg-parameterized'
      ? '/brand/wizards-ai-icon.svg'
      : '/dashboard';
  const response = mode === 'oversize'
    ? `head -c 68157441 /dev/zero | tr '\\000' x`
    : mode === 'svg-parameterized'
      ? `printf '<svg/>\\nOPEN%s_RESPONSE:200\\t' 'SPELL'
printf '%s/brand/wizards-ai-icon.svg\\t' '${CANDIDATE_ORIGIN.origin}'
printf '{"content-type":["%s"]}' 'image/svg+xml; charset=utf-8'`
      : mode === 'wrong-effective'
        ? `printf '{"status":"%s"}\\nOPEN%s_RESPONSE:200\\t' 'ok' 'SPELL'
printf '%s/different\\t' '${CANDIDATE_ORIGIN.origin}'
printf '{"content-type":["%s"]}' 'application/json'`
        : mode === 'duplicate-content-type'
          ? `printf '{}\\nOPEN%s_RESPONSE:200\\t' 'SPELL'
printf '%s\\t' '${CANDIDATE_ROUTE.href}'
printf '{"content-type":["%s","%s"]}' 'application/json' 'text/html'`
          : mode === 'duplicate-location'
            ? `printf '{}\\nOPEN%s_RESPONSE:307\\t' 'SPELL'
printf '%s\\t' '${CANDIDATE_ROUTE.href}'
printf '{"location":["%s","%s"]}' '/one' '/two'`
            : mode === 'duplicate-server-timing'
              ? `printf '{}\\nOPEN%s_RESPONSE:200\\t' 'SPELL'
printf '%s\\t' '${CANDIDATE_ROUTE.href}'
printf '{"server-timing":["%s","%s"]}' 'total;dur=1' 'total;dur=2'`
              : `if [ "\${VERCEL_TOKEN:-}" != '${SYNTHETIC_VERCEL_TOKEN}' ]; then exit 45; fi
printf '%s' "$input" | grep -q 'url-query = "+profile=${SYNTHETIC_PROFILE}"' || exit 46
printf '%s' "$input" | grep -q 'Cookie: ${SYNTHETIC_COOKIE}' || exit 47
if [ '${mode}' = 'linked-temp-parent' ] || [ '${mode}' = 'linked-temp-parent-failure' ]; then
  printf '%s' "$PWD" > "$0.cwd"
  [ "$PWD" != '${root}' ] || exit 48
  [ "$(stat -c '%a' "$PWD")" = '700' ] || exit 49
  search="$PWD"
  while [ "$search" != '/' ]; do
    if [ -f "$search/.vercel/repo.json" ]; then break; fi
    search="$(dirname "$search")"
  done
  [ "$search" = "$PWD" ] || exit 50
  grep -Fqx '{"projects":[]}' "$PWD/.vercel/repo.json" || exit 51
  [ ! -e "$PWD/.vercel/project.json" ] || exit 52
  [ '${mode}' != 'linked-temp-parent-failure' ] || exit 53
fi
printf '{"status":"%s"}\\nOPEN%s_RESPONSE:200\\t' 'ok' 'SPELL'
printf '%s\\t' '${CANDIDATE_ROUTE.href}'
printf '{"content-type":["%s"]}' 'application/json'`;
  if (mode === 'linked-temp-parent' || mode === 'linked-temp-parent-failure') {
    const linked = join(root, '.vercel');
    mkdirSync(linked);
    writeFileSync(join(linked, 'project.json'), '{"projectId":"synthetic","orgId":"synthetic"}');
  }
  writeFileSync(executable, `#!/bin/sh
trap 'status=$?; printf "%s" "$status" > "$0.exit"; exit "$status"' EXIT
if [ "$#" -ne 8 ] || [ "$1" != 'curl' ] || [ "$2" != '${expectedPath}' ] || [ "$3" != '--deployment' ] || [ "$4" != '${CANDIDATE_ORIGIN.origin}' ] || [ "$5" != '--' ] || [ "$6" != '--disable' ] || [ "$7" != '--config' ] || [ "$8" != '-' ]; then exit 41; fi
if [ -n "\${DATABASE_URL+x}" ] || [ -n "\${ADS_REFRESH_TOKEN+x}" ] || [ -n "\${VERCEL_AUTOMATION_BYPASS_SECRET+x}" ] || [ -n "\${HTTPS_PROXY+x}" ] || [ -n "\${SSL_CERT_FILE+x}" ]; then exit 42; fi
if [ "\${VERCEL_TELEMETRY_DISABLED:-}" != '1' ] || [ "\${VERCEL_CLI_USE_NATIVE_BINARY:-}" != '0' ] || [ "\${CURL_HOME:-}" != '/dev/null' ] || [ "\${PATH:-}" != '/usr/bin' ]; then exit 43; fi
case "$*" in *'${SYNTHETIC_PROFILE}'*|*'${SYNTHETIC_COOKIE}'*|*'${SYNTHETIC_VERCEL_TOKEN}'*) exit 44;; esac
input="$(sed -n '1,120p')"
${response}
`);
  chmodSync(executable, 0o755);
  return {
    root,
    request: (input) => requestCandidateWithTestLauncher(input, {
      command: executable,
      argumentsPrefix: [],
      systemPath: '/usr/bin',
    }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
