import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { CandidateHttpResponse } from './candidate-redirect';

const RESPONSE_MARKER = '\nOPENSPELL_RESPONSE:';
const CURL_WRITE_OUT = '\\nOPENSPELL_RESPONSE:%{http_code}\\t%{redirect_url}';
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 256 * 1024;
const PROCESS_TIMEOUT_MS = 35_000;

export type ReleaseTransportErrorCode =
  | 'arguments_invalid'
  | 'candidate_invalid'
  | 'cdp_unavailable'
  | 'curl_failed'
  | 'curl_output_exceeded'
  | 'curl_stream_failed'
  | 'curl_timeout'
  | 'profile_unavailable'
  | 'session_unavailable'
  | 'transport_input_invalid'
  | 'unexpected_failure';

export class ReleaseTransportError extends Error {
  readonly code: ReleaseTransportErrorCode;

  constructor(code: ReleaseTransportErrorCode) {
    super(code);
    this.name = 'ReleaseTransportError';
    this.code = code;
  }
}

export function releaseFailure(error: unknown): string {
  const code = error instanceof ReleaseTransportError ? error.code : 'unexpected_failure';
  return `OPENSPELL_RELEASE_ERROR:${code}`;
}

export async function requestCandidate(input: {
  candidate: URL;
  url: URL;
  cookieHeader?: string;
}): Promise<CandidateHttpResponse> {
  const args = buildVercelCurlArgs(input.candidate, input.url);
  const stdout = await boundedVercelCurl(args, buildCurlConfig(input));
  return parseCurlResponse(stdout);
}

export function buildVercelCurlArgs(candidate: URL, url: URL): string[] {
  if (
    candidate.protocol !== 'https:'
    || candidate.username !== ''
    || candidate.password !== ''
    || candidate.pathname !== '/'
    || candidate.search !== ''
    || candidate.hash !== ''
    || url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.origin !== candidate.origin
    || hasControl(url.pathname)
  ) {
    throw new ReleaseTransportError('transport_input_invalid');
  }
  return [
    'curl',
    url.pathname,
    '--deployment',
    candidate.origin,
    '--',
    '--disable',
    '--config',
    '-',
  ];
}

export function buildCurlConfig(input: {
  url: URL;
  cookieHeader?: string;
}): string {
  if (input.url.protocol !== 'https:' || input.url.username !== '' || input.url.password !== '') {
    throw new ReleaseTransportError('transport_input_invalid');
  }
  const lines = [
    'request = "GET"',
    'silent',
    'show-error',
    'connect-timeout = 10',
    'max-time = 30',
    'max-redirs = 0',
    'proto = "=https"',
    `write-out = "${CURL_WRITE_OUT}"`,
  ];
  const query = input.url.search.slice(1);
  if (query !== '') lines.push(`url-query = "+${escapeConfig(query)}"`);
  if (input.cookieHeader !== undefined) {
    lines.push(`header = "Cookie: ${escapeConfig(input.cookieHeader)}"`);
  }
  return `${lines.join('\n')}\n`;
}

function parseCurlResponse(stdout: string): CandidateHttpResponse {
  const marker = stdout.lastIndexOf(RESPONSE_MARKER);
  if (marker < 0) throw new ReleaseTransportError('curl_failed');
  const metadata = stdout.slice(marker + RESPONSE_MARKER.length);
  const match = /^(\d{3})\t([^\r\n]*)$/.exec(metadata);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new ReleaseTransportError('curl_failed');
  }
  const status = Number(match[1]);
  const rawLocation = match[2] === '' ? null : match[2];
  if (rawLocation !== null && hasControl(rawLocation)) {
    throw new ReleaseTransportError('curl_failed');
  }
  return {
    status,
    responseBody: stdout.slice(0, marker),
    rawLocation,
  };
}

function boundedVercelCurl(args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('vercel', args, {
        // An unlinked working directory prevents `vercel curl` from creating
        // a project protection credential when a deployment has none. The CLI
        // may only reuse its already authenticated global context.
        cwd: tmpdir(),
        env: vercelEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      reject(new ReleaseTransportError('curl_failed'));
      return;
    }

    let stdout = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: ReleaseTransportError | null = null;
    let settled = false;
    const timer = setTimeout(() => fail('curl_timeout'), PROCESS_TIMEOUT_MS);

    function fail(code: 'curl_output_exceeded' | 'curl_stream_failed' | 'curl_timeout'): void {
      if (failure !== null || settled) return;
      failure = new ReleaseTransportError(code);
      child.kill('SIGKILL');
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_RESPONSE_BYTES) fail('curl_output_exceeded');
      else stdout += chunk.toString('utf8');
    });
    // Diagnostics are counted but never retained because the CLI or curl must
    // not echo an authenticated request boundary into the release report.
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_DIAGNOSTIC_BYTES) fail('curl_output_exceeded');
    });
    child.stdout.on('error', () => fail('curl_stream_failed'));
    child.stderr.on('error', () => fail('curl_stream_failed'));
    child.stdin.on('error', () => fail('curl_stream_failed'));
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ReleaseTransportError('curl_failed'));
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failure !== null) reject(failure);
      else if (exitCode !== 0) reject(new ReleaseTransportError('curl_failed'));
      else resolve(stdout);
    });
    try {
      child.stdin.end(input);
    } catch {
      fail('curl_stream_failed');
    }
  });
}

function vercelEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'VERCEL_TOKEN',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'TZ',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ] as const;
  const environment: NodeJS.ProcessEnv = {
    CI: '1',
    CURL_HOME: '/dev/null',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    NODE_ENV: 'production',
    VERCEL_TELEMETRY_DISABLED: '1',
  };
  for (const name of allowed) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

function escapeConfig(value: string): string {
  if (hasControl(value)) throw new ReleaseTransportError('transport_input_invalid');
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function hasControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}
