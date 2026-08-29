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
 *     pnpm --silent --filter @wizard-ads/web verify:release-candidate
 */
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import {
  inspectReleaseArtifact,
  releaseResponsePassed,
  RELEASE_ROUTE_CHECKS,
  type ReleaseRouteCheck,
} from '../src/release/candidate-artifacts';
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
interface RouteResult {
  route: string;
  status: number | null;
  checkDurationMs: number;
  passed: boolean;
  missingArtifacts: readonly string[];
  rejectedBody: boolean;
}

async function main(): Promise<void> {
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
  const result = await requestCandidate(candidate, check.route, cookieHeader);
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
): Promise<{ exitCode: number | null; status: number | null; responseBody: string }> {
  const args = [
    'curl',
    route,
    '--deployment',
    candidate.origin,
    '--',
    '--config',
    '-',
    '--silent',
    '--show-error',
    '--location',
    '--max-redirs',
    '5',
    '--write-out',
    `${STATUS_MARKER}%{http_code}`,
  ];

  const result = await spawnWithInput('vercel', args, curlConfig(cookieHeader));
  const markerIndex = result.stdout.lastIndexOf(STATUS_MARKER);
  const responseBody = markerIndex < 0 ? '' : result.stdout.slice(0, markerIndex);
  const statusMatch = markerIndex < 0
    ? null
    : result.stdout.slice(markerIndex).match(new RegExp(`${STATUS_MARKER}(\\d{3})`));
  const status = statusMatch?.[1] === undefined ? null : Number(statusMatch[1]);
  return {
    exitCode: result.exitCode,
    status,
    responseBody,
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

function spawnWithInput(
  command: string,
  args: readonly string[],
  input: string,
): Promise<{ exitCode: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: sanitizedChildEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    // Drain stderr without retaining it. Neither CLI diagnostics nor future
    // curl changes can accidentally echo a sensitive header into this report.
    child.stderr.resume();
    child.on('error', () => reject(new ReleaseVerifierError('vercel_cli_unavailable')));
    child.on('close', (exitCode) => resolve({ exitCode, stdout }));
    child.stdin.end(input);
  });
}

function sanitizedChildEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment['OPENSPELL_RELEASE_CANDIDATE_URL'];
  delete environment['OPENSPELL_RELEASE_EXPECTED_REVISION'];
  delete environment['OPENSPELL_CDP_URL'];
  delete environment['OPENSPELL_PRODUCTION_ORIGIN'];
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

void main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error: unknown) => {
    console.error(publicReleaseFailure(error));
    process.exit(1);
  });
