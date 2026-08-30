import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ReleaseTransportError,
  buildCurlConfig,
  buildVercelCurlArgs,
  releaseFailure,
  requestCandidate,
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
    try {
      const result = await requestCandidate({
        candidate: CANDIDATE_ORIGIN,
        url: CANDIDATE_ROUTE,
        cookieHeader: SYNTHETIC_COOKIE,
      });

      expect(result).toEqual({
        status: 200,
        responseBody: '{"status":"ok"}',
        rawLocation: null,
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
      await expect(requestCandidate({
        candidate: CANDIDATE_ORIGIN,
        url: new URL('/api/healthz', CANDIDATE_ORIGIN),
      })).rejects.toMatchObject({ code: 'curl_output_exceeded' });
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

function fakeVercel(mode: 'healthy' | 'oversize'): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'openspell-release-vercel-'));
  const executable = join(root, 'vercel');
  const expectedPath = mode === 'healthy' ? '/dashboard' : '/api/healthz';
  writeFileSync(executable, `#!/bin/sh
if [ "$#" -ne 8 ] || [ "$1" != 'curl' ] || [ "$2" != '${expectedPath}' ] || [ "$3" != '--deployment' ] || [ "$4" != '${CANDIDATE_ORIGIN.origin}' ] || [ "$5" != '--' ] || [ "$6" != '--disable' ] || [ "$7" != '--config' ] || [ "$8" != '-' ]; then exit 41; fi
if [ -n "\${DATABASE_URL+x}" ] || [ -n "\${ADS_REFRESH_TOKEN+x}" ] || [ -n "\${VERCEL_AUTOMATION_BYPASS_SECRET+x}" ]; then exit 42; fi
if [ "\${VERCEL_TELEMETRY_DISABLED:-}" != '1' ] || [ "\${CURL_HOME:-}" != '/dev/null' ]; then exit 43; fi
case "$*" in *'${SYNTHETIC_PROFILE}'*|*'${SYNTHETIC_COOKIE}'*|*'${SYNTHETIC_VERCEL_TOKEN}'*) exit 44;; esac
input="$(sed -n '1,120p')"
${mode === 'healthy' ? `if [ "\${VERCEL_TOKEN:-}" != '${SYNTHETIC_VERCEL_TOKEN}' ]; then exit 45; fi
printf '%s' "$input" | grep -q 'url-query = "+profile=${SYNTHETIC_PROFILE}"' || exit 46
printf '%s' "$input" | grep -q 'Cookie: ${SYNTHETIC_COOKIE}' || exit 47
printf '{"status":"ok"}\\nOPENSPELL_RESPONSE:200\\t\\t'` : `head -c 68157441 /dev/zero | tr '\\000' x`}
`);
  chmodSync(executable, 0o755);
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
