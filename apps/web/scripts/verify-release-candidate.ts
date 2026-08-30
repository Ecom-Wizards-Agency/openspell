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
 *   pnpm --filter @wizard-ads/web verify:release-candidate -- https://candidate.example <full-sha>
 */
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { exactRevision } from '../src/performance/events';
import { parseRevisionMetadata } from '../src/performance/revision';

const PRODUCTION_ORIGIN = process.env['OPENSPELL_PRODUCTION_ORIGIN']
  ?? 'https://ads.ecomwizards.agency';
const CDP_URL = process.env['OPENSPELL_CDP_URL'] ?? 'http://127.0.0.1:9222';
const AUTH_COOKIE = /^sb-.*-auth-token(?:\.\d+)?$/;
const CANDIDATE_HOST = /^wizard-[a-z0-9]+-ecom-wizards\.vercel\.app$/;
const STATUS_MARKER = 'OPENSPELL_STATUS:';
const REJECTED_BODY = /role=["']alert["']|Application error|Internal Server Error|Login – Vercel/i;

const ROUTES = [
  { route: '/', expectedText: 'Open the dashboard' },
  { route: '/dashboard', expectedText: 'Dashboard' },
  { route: '/grid', expectedText: 'Campaigns' },
  { route: '/optimizer', expectedText: 'Campaign Optimizer' },
  { route: '/optimizer/groups', expectedText: 'Optimization Groups' },
  { route: '/creative', expectedText: 'Creative Performance' },
  { route: '/campaigns', expectedText: 'Campaign Builder' },
  { route: '/recommendations', expectedText: 'Recommendations' },
  { route: '/tags', expectedText: 'Tags' },
  { route: '/time-machine', expectedText: 'Time Machine' },
  { route: '/settings/integrations', expectedText: 'Integrations' },
] as const;

interface RouteResult {
  route: string;
  status: number | null;
  checkDurationMs: number;
  passed: boolean;
}

interface RevisionResult {
  expected: string;
  deployed: string | null;
  passed: boolean;
}

async function main(): Promise<void> {
  const supplied = process.argv.slice(2).filter((argument) => argument !== '--');
  if (supplied.length !== 2) {
    throw new Error('Pass the immutable candidate URL and its expected full Git commit SHA.');
  }
  const candidate = candidateOrigin(supplied[0]);
  const expectedRevision = requiredRevision(supplied[1]);
  const production = new URL(PRODUCTION_ORIGIN);
  if (candidate.origin === production.origin) {
    throw new Error('Candidate must be an immutable deployment URL, not the production alias.');
  }

  // Performance evidence is attributable only when the running server proves
  // the exact candidate revision. Fail before reading browser authentication
  // or accepting any route duration when the metadata is absent or different.
  const revision = await verifyRevision(candidate, expectedRevision);
  if (!revision.passed) {
    console.log(JSON.stringify({ candidate: candidate.origin, passed: false, revision, routes: [] }, null, 2));
    process.exitCode = 1;
    return;
  }

  const browser = await chromium.connectOverCDP(CDP_URL);
  const sourceContext = browser.contexts()[0];
  if (sourceContext === undefined) {
    throw new Error('No Chrome context is available through CDP.');
  }

  const sourceCookies = (await sourceContext.cookies(production.origin))
    .filter((cookie) => AUTH_COOKIE.test(cookie.name));
  if (sourceCookies.length === 0) {
    throw new Error('The Chrome session has no reusable OpenSpell authentication cookies.');
  }
  const cookieHeader = sourceCookies
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');

  const results: RouteResult[] = [];
  for (const check of ROUTES) {
    results.push(await verifyRoute(candidate, check, cookieHeader));
  }

  const passed = results.every((result) => result.passed);
  console.log(JSON.stringify({ candidate: candidate.origin, passed, revision, routes: results }, null, 2));
  if (!passed) process.exitCode = 1;
}

async function verifyRevision(candidate: URL, expected: string): Promise<RevisionResult> {
  const result = await requestCandidate(candidate, '/api/performance');
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(result.responseBody);
  } catch {
    // Invalid metadata is a closed failure below.
  }
  const deployed = parseRevisionMetadata(parsed)?.revision ?? null;
  return {
    expected,
    deployed,
    passed: result.exitCode === 0 && result.status === 200 && deployed === expected,
  };
}

async function verifyRoute(
  candidate: URL,
  check: { route: string; expectedText: string },
  cookieHeader: string,
): Promise<RouteResult> {
  const startedAt = performance.now();
  const result = await requestCandidate(candidate, check.route, cookieHeader);
  const artifactMatched = result.responseBody.includes(check.expectedText)
    && !REJECTED_BODY.test(result.responseBody);
  return {
    route: check.route,
    status: result.status,
    checkDurationMs: Math.round(performance.now() - startedAt),
    passed: result.exitCode === 0 && result.status === 200 && artifactMatched,
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
    throw new Error('Authentication cookie shape is invalid.');
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
      env: process.env,
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
    child.on('error', () => reject(new Error('Could not start the Vercel candidate check.')));
    child.on('close', (exitCode) => resolve({ exitCode, stdout }));
    child.stdin.end(input);
  });
}

function candidateOrigin(input: string | undefined): URL {
  if (input === undefined) {
    throw new Error('Pass the immutable candidate deployment URL as the first argument.');
  }
  const candidate = new URL(input);
  if (candidate.protocol !== 'https:') {
    throw new Error('Candidate deployment URL must use HTTPS.');
  }
  if (
    !CANDIDATE_HOST.test(candidate.hostname)
    || candidate.username !== ''
    || candidate.password !== ''
    || candidate.port !== ''
  ) {
    throw new Error('Candidate must be an immutable deployment owned by the OpenSpell project.');
  }
  return candidate;
}

function requiredRevision(input: string | undefined): string {
  const revision = exactRevision(input);
  if (revision === null) throw new Error('Expected revision must be a full lowercase Git commit SHA.');
  return revision;
}

void main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Release candidate verification failed.');
    process.exit(1);
  });
