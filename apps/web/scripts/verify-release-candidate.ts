/**
 * Verify an immutable Vercel candidate before its public alias is promoted.
 *
 * Vercel protects immutable deployment URLs, so plain browser navigation lands
 * on Vercel's login screen. This gate uses `vercel curl` for the protection
 * bypass and supplies the already authenticated OpenSpell session through
 * curl's stdin-only config. Cookie names and values never enter arguments,
 * files, logs, or the candidate report, and the persistent Chrome profile is
 * never modified.
 *
 * Every check is a GET request. Keep this list free of endpoints that enqueue
 * jobs or mutate product data. After promotion, run the browser QA sweep too;
 * this preflight proves the protected server artifact before alias movement.
 *
 * Usage:
 *   OPENSPELL_RELEASE_CANDIDATE_URL="$CANDIDATE_URL" \
 *   OPENSPELL_RELEASE_EXPECTED_REVISION="$RELEASE_REVISION" \
 *     bash apps/web/scripts/verify-release-candidate.sh
 */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import {
  inspectReleaseArtifact,
  releaseResponsePassed,
  RELEASE_ROUTE_CHECKS,
  type ReleaseRouteCheck,
} from '../src/release/candidate-artifacts';
import {
  requestAccountRouteWithRedirects,
  type CandidateHttpResponse,
} from '../src/release/candidate-redirect';
import {
  connectToCdpSafely,
  inspectCandidateRevision,
  publicReleaseFailure,
  ReleaseVerifierError,
  requiredExpectedRevision,
  runRevisionFirstGate,
} from '../src/release/candidate-revision';

const PRODUCTION_ORIGIN = process.env['OPENSPELL_PRODUCTION_ORIGIN']
  ?? 'https://ads.ecomwizards.agency';
const CDP_URL = process.env['OPENSPELL_CDP_URL'] ?? 'http://127.0.0.1:9222';
const AUTH_COOKIE = /^sb-.*-auth-token(?:\.\d+)?$/;
const CANDIDATE_HOST = /^wizard-[a-z0-9]+-ecom-wizards\.vercel\.app$/;
const STATUS_MARKER = 'OPENSPELL_STATUS:';
const REDIRECT_MARKER = 'OPENSPELL_REDIRECT:';
const CHILD_TIMEOUT_MS = 35_000;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
interface RouteResult {
  route: string;
  status: number | null;
  checkDurationMs: number;
  passed: boolean;
  missingArtifacts: readonly string[];
  rejectedBody: boolean;
}

async function main(): Promise<void> {
  clearDiagnosticEnvironment();
  if (process.argv.slice(2).some((argument) => argument !== '--')) {
    throw new ReleaseVerifierError('arguments_not_allowed');
  }
  const candidate = candidateOrigin(process.env['OPENSPELL_RELEASE_CANDIDATE_URL']);
  const expectedRevision = expectedReleaseRevision(
    process.env['OPENSPELL_RELEASE_EXPECTED_REVISION'],
  );
  const production = productionOrigin(PRODUCTION_ORIGIN);
  if (candidate.origin === production.origin) {
    throw new ReleaseVerifierError('candidate_is_production');
  }

  const gate = await runRevisionFirstGate({
    checkRevision: async () => verifyRevision(candidate, expectedRevision),
    checkRoutes: async () => verifyAuthenticatedRoutes(candidate, production, CDP_URL),
    routePassed: (route) => route.passed,
  });

  console.log(JSON.stringify({
    target: 'immutable-candidate',
    passed: gate.passed,
    revision: gate.revision,
    routes: gate.routes,
  }, null, 2));
  if (!gate.passed) process.exitCode = 1;
}

async function verifyRevision(candidate: URL, expectedRevision: string) {
  const response = await requestCandidate(candidate, '/api/healthz');
  return inspectCandidateRevision(
    response.exitCode,
    response.status,
    response.responseBody,
    expectedRevision,
  );
}

async function verifyAuthenticatedRoutes(
  candidate: URL,
  production: URL,
  cdpEndpoint: string,
): Promise<readonly RouteResult[]> {
  const browser = await connectToCdpSafely(
    cdpEndpoint,
    async (validatedEndpoint) => chromium.connectOverCDP(validatedEndpoint),
  );
  const sourceContext = browser.contexts()[0];
  if (sourceContext === undefined) {
    throw new ReleaseVerifierError('cdp_session_unavailable');
  }

  let sourceCookies: Awaited<ReturnType<typeof sourceContext.cookies>>;
  try {
    sourceCookies = (await sourceContext.cookies(production.origin))
      .filter((cookie) => AUTH_COOKIE.test(cookie.name));
  } catch {
    throw new ReleaseVerifierError('cdp_session_unavailable');
  }
  if (sourceCookies.length === 0) {
    throw new ReleaseVerifierError('authentication_missing');
  }
  const cookieHeader = sourceCookies
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');

  const results: RouteResult[] = [];
  for (const check of RELEASE_ROUTE_CHECKS) {
    results.push(await verifyRoute(candidate, check, cookieHeader));
  }
  return results;
}

async function verifyRoute(
  candidate: URL,
  check: ReleaseRouteCheck,
  cookieHeader: string,
): Promise<RouteResult> {
  const startedAt = performance.now();
  const result = check.route === '/brand/wizards-ai-icon.svg'
    ? await requestCandidate(candidate, check.route, cookieHeader)
    : await requestAccountRouteWithRedirects({
      candidate,
      route: check.route,
      request: async (route) => requestCandidate(candidate, route, cookieHeader),
    });
  const inspection = inspectReleaseArtifact(result.responseBody, check.artifacts);
  return {
    route: check.route,
    status: result.status,
    checkDurationMs: Math.round(performance.now() - startedAt),
    passed: releaseResponsePassed(result.exitCode, result.status, inspection),
    missingArtifacts: inspection.missingArtifacts,
    rejectedBody: inspection.rejectedBody,
  };
}

async function requestCandidate(
  candidate: URL,
  route: string,
  cookieHeader?: string,
): Promise<CandidateHttpResponse> {
  const args = [
    'curl',
    route,
    '--deployment',
    candidate.origin,
    '--',
    '--disable',
    '--config',
    '-',
    '--silent',
    '--show-error',
    '--write-out',
    `${STATUS_MARKER}%{http_code}${REDIRECT_MARKER}%{redirect_url}`,
  ];

  const result = await spawnWithInput('vercel', args, curlConfig(cookieHeader));
  const markerIndex = result.stdout.lastIndexOf(STATUS_MARKER);
  const responseBody = markerIndex < 0 ? '' : result.stdout.slice(0, markerIndex);
  const metadata = markerIndex < 0 ? '' : result.stdout.slice(markerIndex);
  const statusMatch = metadata.match(new RegExp(
    `^${STATUS_MARKER}(\\d{3})${REDIRECT_MARKER}`,
  ));
  const status = statusMatch?.[1] === undefined ? null : Number(statusMatch[1]);
  const redirectMarkerIndex = metadata.indexOf(REDIRECT_MARKER);
  const redirectUrl = redirectMarkerIndex < 0
    ? null
    : metadata.slice(redirectMarkerIndex + REDIRECT_MARKER.length) || null;
  return {
    exitCode: result.exitCode,
    status,
    responseBody,
    redirectUrl,
  };
}

function curlConfig(cookieHeader?: string): string {
  if (cookieHeader === undefined) return 'max-time = 30\n';
  // curl config uses double-quoted values. Auth cookie values are URL-safe, but
  // escaping both special characters keeps this stdin boundary correct.
  if (/[\r\n]/.test(cookieHeader)) {
    throw new ReleaseVerifierError('authentication_invalid');
  }
  const escaped = cookieHeader.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `header = "Cookie: ${escaped}"\nmax-time = 30\n`;
}

async function spawnWithInput(
  command: string,
  args: readonly string[],
  input: string,
): Promise<{ exitCode: number | null; stdout: string }> {
  let curlHome: string | null = null;
  try {
    curlHome = await mkdtemp(join(tmpdir(), 'openspell-release-'));
    await chmod(curlHome, 0o700);
    await writeFile(join(curlHome, '.curlrc'), '', { encoding: 'utf8', mode: 0o600 });
  } catch {
    if (curlHome !== null) {
      await rm(curlHome, { recursive: true, force: true }).catch(() => undefined);
    }
    throw new ReleaseVerifierError('transport_isolation_failed');
  }

  try {
    return await spawnBounded(command, args, input, curlHome);
  } finally {
    await rm(curlHome, { recursive: true, force: true }).catch(() => undefined);
  }
}

function spawnBounded(
  command: string,
  args: readonly string[],
  input: string,
  curlHome: string,
): Promise<{ exitCode: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, {
        cwd: process.cwd(),
        env: minimalChildEnvironment(curlHome),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      reject(new ReleaseVerifierError('vercel_cli_unavailable'));
      return;
    }
    let stdout = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: ReleaseVerifierError | null = null;
    let settled = false;
    const timeout = setTimeout(() => fail('vercel_cli_timeout'), CHILD_TIMEOUT_MS);

    function fail(code: 'vercel_cli_timeout' | 'vercel_output_exceeded' | 'vercel_stream_failed') {
      if (failure !== null || settled) return;
      failure = new ReleaseVerifierError(code);
      child.kill('SIGKILL');
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        fail('vercel_output_exceeded');
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_STDERR_BYTES) fail('vercel_output_exceeded');
    });
    child.stdout.on('error', () => fail('vercel_stream_failed'));
    child.stderr.on('error', () => fail('vercel_stream_failed'));
    child.stdin.on('error', () => fail('vercel_stream_failed'));
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new ReleaseVerifierError('vercel_cli_unavailable'));
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (failure !== null) reject(failure);
      else resolve({ exitCode, stdout });
    });
    try {
      child.stdin.end(input);
    } catch {
      fail('vercel_stream_failed');
    }
  });
}

const CHILD_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'XDG_CONFIG_HOME',
  'VERCEL_TOKEN',
  'VERCEL_ORG_ID',
  'VERCEL_PROJECT_ID',
  'VERCEL_SCOPE',
  'VERCEL_TELEMETRY_DISABLED',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;

function minimalChildEnvironment(curlHome: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    CI: '1',
    CURL_HOME: curlHome,
    FORCE_COLOR: '0',
    NODE_ENV: process.env['NODE_ENV'] ?? 'production',
    NO_COLOR: '1',
  };
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function candidateOrigin(input: string | undefined): URL {
  if (input === undefined) {
    throw new ReleaseVerifierError('candidate_missing');
  }
  let candidate: URL;
  try {
    candidate = new URL(input);
  } catch {
    throw new ReleaseVerifierError('invalid_candidate');
  }
  if (candidate.protocol !== 'https:') {
    throw new ReleaseVerifierError('invalid_candidate');
  }
  if (
    !CANDIDATE_HOST.test(candidate.hostname)
    || candidate.username !== ''
    || candidate.password !== ''
    || candidate.port !== ''
    || candidate.pathname !== '/'
    || candidate.search !== ''
    || candidate.hash !== ''
  ) {
    throw new ReleaseVerifierError('invalid_candidate');
  }
  return candidate;
}

function expectedReleaseRevision(input: string | undefined): string {
  try {
    return requiredExpectedRevision(input);
  } catch {
    throw new ReleaseVerifierError('expected_revision_invalid');
  }
}

function productionOrigin(input: string): URL {
  let production: URL;
  try {
    production = new URL(input);
  } catch {
    throw new ReleaseVerifierError('production_origin_invalid');
  }
  if (
    !['http:', 'https:'].includes(production.protocol)
    || production.username !== ''
    || production.password !== ''
  ) {
    throw new ReleaseVerifierError('production_origin_invalid');
  }
  return production;
}

export async function runReleaseCandidateCli(): Promise<void> {
  try {
    await main();
  } catch (error) {
    console.error(publicReleaseFailure(error));
    process.exitCode = 1;
  }
}

function clearDiagnosticEnvironment(): void {
  for (const name of ['DEBUG', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'PWDEBUG']) {
    delete process.env[name];
  }
}
