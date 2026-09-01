import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CandidateHttpResponse, CandidateMediaType } from './candidate-redirect';
import { parseGridServerTiming } from './grid-server-timing';
import { lockedVercelCliLaunch } from './vercel-cli-runtime';
import type { VercelCliLaunch } from './vercel-cli-runtime';

const RESPONSE_MARKER = '\nOPENSPELL_RESPONSE:';
const CURL_WRITE_OUT = [
  '\\nOPENSPELL_RESPONSE:',
  '%{http_code}',
  '\\t%{url_effective}',
  '\\t%{header_json}',
].join('');
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 256 * 1024;
const PROCESS_TIMEOUT_MS = 35_000;
// The launcher is Bash/Unix-only. Ignore caller-controlled TMPDIR so a linked
// checkout cannot become Vercel's project context.
const RELEASE_TEMP_ROOT = '/tmp';

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
  let launcher: VercelCliLaunch;
  try {
    launcher = lockedVercelCliLaunch();
  } catch {
    throw new ReleaseTransportError('curl_failed');
  }
  const stdout = await boundedVercelCurl(
    args,
    buildCurlConfig(input),
    launcher,
  );
  return parseCurlResponse(stdout, input.url);
}

/** @internal Test processes inject a synthetic CLI without an environment-controlled runtime seam. */
export async function requestCandidateWithTestLauncher(
  input: {
    candidate: URL;
    url: URL;
    cookieHeader?: string;
  },
  launcher: VercelCliLaunch,
): Promise<CandidateHttpResponse> {
  if (process.env['NODE_ENV'] !== 'test') {
    throw new ReleaseTransportError('curl_failed');
  }
  const args = buildVercelCurlArgs(input.candidate, input.url);
  const stdout = await boundedVercelCurl(args, buildCurlConfig(input), launcher);
  return parseCurlResponse(stdout, input.url);
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

function parseCurlResponse(stdout: Buffer, requestedUrl: URL): CandidateHttpResponse {
  const markerBytes = Buffer.from(RESPONSE_MARKER, 'utf8');
  const marker = stdout.lastIndexOf(markerBytes);
  if (marker < 0) throw new ReleaseTransportError('curl_failed');
  const body = stdout.subarray(0, marker);
  let metadata: string;
  let responseBody: string;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    metadata = decoder.decode(stdout.subarray(marker + markerBytes.byteLength));
    responseBody = decoder.decode(body);
  } catch {
    throw new ReleaseTransportError('curl_failed');
  }
  const firstSeparator = metadata.indexOf('\t');
  const secondSeparator = metadata.indexOf('\t', firstSeparator + 1);
  if (firstSeparator < 0 || secondSeparator < 0) {
    throw new ReleaseTransportError('curl_failed');
  }
  const statusText = metadata.slice(0, firstSeparator);
  const effectiveUrl = metadata.slice(firstSeparator + 1, secondSeparator);
  const rawHeaders = metadata.slice(secondSeparator + 1);
  if (!/^\d{3}$/.test(statusText) || hasControl(effectiveUrl)) {
    throw new ReleaseTransportError('curl_failed');
  }
  const headers = policyHeaders(rawHeaders);
  const status = Number(statusText);
  const rawLocation = headers.location;
  if (rawLocation !== null && hasControl(rawLocation)) {
    throw new ReleaseTransportError('curl_failed');
  }
  return {
    status,
    responseBody,
    responseBodySha256: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    rawLocation,
    mediaType: candidateMediaType(headers.contentType ?? ''),
    effectiveUrlMatched: effectiveUrlMatches(effectiveUrl, requestedUrl),
    serverTiming: parseGridServerTiming(headers.serverTiming ?? ''),
  };
}

function policyHeaders(raw: string): {
  readonly contentType: string | null;
  readonly location: string | null;
  readonly serverTiming: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ReleaseTransportError('curl_failed');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ReleaseTransportError('curl_failed');
  }
  const headers = parsed as Record<string, unknown>;
  return {
    contentType: singlePolicyHeader(headers, 'content-type'),
    location: singlePolicyHeader(headers, 'location'),
    serverTiming: singlePolicyHeader(headers, 'server-timing'),
  };
}

function singlePolicyHeader(headers: Record<string, unknown>, name: string): string | null {
  const value = headers[name];
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'string') {
    throw new ReleaseTransportError('curl_failed');
  }
  return value[0];
}

function boundedVercelCurl(
  args: string[],
  input: string,
  launcher: VercelCliLaunch,
): Promise<Buffer> {
  let workingDirectory: string | null = null;
  try {
    workingDirectory = isolatedVercelWorkingDirectory();
  } catch {
    if (workingDirectory !== null) removeWorkingDirectory(workingDirectory);
    return Promise.reject(new ReleaseTransportError('curl_failed'));
  }
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launcher.command, [...launcher.argumentsPrefix, ...args], {
        // Vercel may create a deployment-protection token when its cwd resolves
        // to the target project. A fresh directory with an exact-cwd empty repo
        // boundary prevents ancestor links from granting that provider-write
        // authority.
        cwd: workingDirectory,
        env: vercelEnvironment(workingDirectory, launcher.systemPath),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      removeWorkingDirectory(workingDirectory);
      reject(new ReleaseTransportError('curl_failed'));
      return;
    }

    const stdout: Buffer[] = [];
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
      else stdout.push(chunk);
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
      removeWorkingDirectory(workingDirectory);
      reject(new ReleaseTransportError('curl_failed'));
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const cleaned = removeWorkingDirectory(workingDirectory);
      if (!cleaned) reject(new ReleaseTransportError('curl_failed'));
      else if (failure !== null) reject(failure);
      else if (exitCode !== 0) reject(new ReleaseTransportError('curl_failed'));
      else resolve(Buffer.concat(stdout, stdoutBytes));
    });
    try {
      child.stdin.end(input);
    } catch {
      fail('curl_stream_failed');
    }
  });
}

function isolatedVercelWorkingDirectory(): string {
  const directory = mkdtempSync(join(RELEASE_TEMP_ROOT, 'openspell-vercel-curl-'));
  try {
    // Vercel searches ancestor repo.json files before it consults Git roots.
    // An empty repo boundary at the exact private cwd ends that search without
    // linking any project, even if a writable ancestor contains stale metadata.
    const vercelDirectory = join(directory, '.vercel');
    mkdirSync(vercelDirectory, { mode: 0o700 });
    writeFileSync(join(vercelDirectory, 'repo.json'), '{"projects":[]}\n', {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return directory;
  } catch (error) {
    removeWorkingDirectory(directory);
    throw error;
  }
}

function removeWorkingDirectory(directory: string): boolean {
  try {
    rmSync(directory, { force: true, recursive: true });
    return true;
  } catch {
    return false;
  }
}

function vercelEnvironment(workingDirectory: string, systemPath: string): NodeJS.ProcessEnv {
  const allowed = [
    'HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'VERCEL_TOKEN',
    'LANG',
    'LC_ALL',
    'TZ',
  ] as const;
  const environment: NodeJS.ProcessEnv = {
    CI: '1',
    CURL_HOME: '/dev/null',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    NODE_ENV: 'production',
    PATH: systemPath,
    TEMP: workingDirectory,
    TMP: workingDirectory,
    TMPDIR: workingDirectory,
    VERCEL_TELEMETRY_DISABLED: '1',
    VERCEL_CLI_USE_NATIVE_BINARY: '0',
  };
  for (const name of allowed) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

function candidateMediaType(raw: string): CandidateMediaType {
  const normalized = raw.trim().toLowerCase();
  if (normalized === '') return 'missing';
  if (normalized === 'image/svg+xml') return 'image/svg+xml';
  if (/^application\/json(?:\s*;\s*charset=utf-8)?$/.test(normalized)) {
    return 'application/json';
  }
  if (/^text\/html(?:\s*;\s*charset=utf-8)?$/.test(normalized)) return 'text/html';
  return 'other';
}

function effectiveUrlMatches(raw: string, requestedUrl: URL): boolean {
  if (raw === '' || hasControl(raw)) return false;
  try {
    const effective = new URL(raw);
    return effective.protocol === 'https:'
      && effective.username === ''
      && effective.password === ''
      && effective.href === requestedUrl.href;
  } catch {
    return false;
  }
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
