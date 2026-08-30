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
 *   pnpm --filter @wizard-ads/web verify:release-candidate -- https://candidate.example
 */
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { PROFILE_COOKIE } from '../src/cookies';

const PRODUCTION_ORIGIN = process.env['OPENSPELL_PRODUCTION_ORIGIN']
  ?? 'https://ads.ecomwizards.agency';
const CDP_URL = process.env['OPENSPELL_CDP_URL'] ?? 'http://127.0.0.1:9222';
const AUTH_COOKIE = /^sb-.*-auth-token(?:\.\d+)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANDIDATE_HOST = /^wizard-[a-z0-9]+-ecom-wizards\.vercel\.app$/;
const STATUS_MARKER = 'OPENSPELL_STATUS:';
const FINAL_URL_MARKER = 'OPENSPELL_FINAL_URL:';
const REJECTED_BODY = /role=["']alert["']|Application error|Internal Server Error|Login – Vercel/i;

const ROUTES = [
  { route: '/', expectedText: 'Dashboard' },
  { route: '/dashboard', expectedText: 'Dashboard' },
  { route: '/grid', expectedText: 'Search terms' },
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
  finalPath: string | null;
  finalProfileMatched: boolean;
  checkDurationMs: number;
  responseBytes: number;
  htmlDocumentFound: boolean;
  appShellFound: boolean;
  nextRedirectFound: boolean;
  expectedTextFound: boolean;
  rejectedBodyFound: boolean;
  loginPageFound: boolean;
  noProfileFound: boolean;
  passed: boolean;
}

async function main(): Promise<void> {
  const candidate = candidateOrigin(process.argv.slice(2).find((argument) => argument !== '--'));
  const production = new URL(PRODUCTION_ORIGIN);
  if (candidate.origin === production.origin) {
    throw new Error('Candidate must be an immutable deployment URL, not the production alias.');
  }

  const browser = await chromium.connectOverCDP(CDP_URL);
  const sourceContext = browser.contexts()[0];
  if (sourceContext === undefined) {
    throw new Error('No Chrome context is available through CDP.');
  }

  const browserCookies = await sourceContext.cookies(production.origin);
  const sourceCookies = browserCookies.filter((cookie) => AUTH_COOKIE.test(cookie.name));
  if (sourceCookies.length === 0) {
    throw new Error('The Chrome session has no reusable OpenSpell authentication cookies.');
  }
  const profileCookie = browserCookies.find((cookie) => cookie.name === PROFILE_COOKIE);
  const profileId = profileCookie?.value ?? await selectedProfileId(sourceContext, production);
  if (profileId === null || !UUID.test(profileId)) {
    throw new Error('The Chrome session has no reusable active OpenSpell profile selection.');
  }
  const cookieHeader = sourceCookies
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');

  // Supabase access tokens can cross their expiry boundary during a serial
  // sweep. Evaluate the immutable artifact concurrently against one captured
  // auth state so later routes cannot become false login failures merely
  // because earlier read-only checks consumed the remaining token lifetime.
  const results = await Promise.all(
    ROUTES.map((check) => verifyRoute(candidate, check, cookieHeader, profileId)),
  );

  const passed = results.every((result) => result.passed);
  console.log(JSON.stringify({ candidate: candidate.origin, passed, routes: results }, null, 2));
  if (!passed) process.exitCode = 1;
}

async function selectedProfileId(
  context: BrowserContext,
  production: URL,
): Promise<string | null> {
  const pages = context.pages().filter((page) => new URL(page.url()).origin === production.origin);
  for (const page of pages) {
    const candidates = await page.evaluate((cookieName) => {
      const values: Array<string | null> = [
        new URL(window.location.href).searchParams.get('profile'),
      ];
      const remembered = document.cookie
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${cookieName}=`));
      if (remembered !== undefined) values.push(decodeURIComponent(remembered.split('=').slice(1).join('=')));
      for (const element of document.querySelectorAll<HTMLElement>(
        '[data-profile-id], input[name="profile"], input[name="profileId"], select[name*="profile" i]',
      )) {
        values.push(
          element.dataset['profileId']
          ?? (element instanceof HTMLInputElement || element instanceof HTMLSelectElement
            ? element.value
            : null),
        );
      }
      for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href*="profile="]')) {
        values.push(new URL(anchor.href, window.location.href).searchParams.get('profile'));
      }
      return values;
    }, PROFILE_COOKIE);
    const profile = candidates.find((candidate) => candidate !== null && UUID.test(candidate));
    if (profile !== undefined) return profile;
  }
  return null;
}

async function verifyRoute(
  candidate: URL,
  check: { route: string; expectedText: string },
  cookieHeader: string,
  profileId: string,
): Promise<RouteResult> {
  const startedAt = performance.now();
  const args = [
    'curl',
    check.route,
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
    `${STATUS_MARKER}%{http_code}\n${FINAL_URL_MARKER}%{url_effective}`,
  ];

  const result = await spawnWithInput('vercel', args, curlConfig(cookieHeader, profileId));
  const markerIndex = result.stdout.lastIndexOf(STATUS_MARKER);
  const responseBody = markerIndex < 0 ? '' : result.stdout.slice(0, markerIndex);
  const statusMatch = markerIndex < 0
    ? null
    : result.stdout.slice(markerIndex).match(new RegExp(`${STATUS_MARKER}(\\d{3})`));
  const status = statusMatch?.[1] === undefined ? null : Number(statusMatch[1]);
  const finalUrlMatch = markerIndex < 0
    ? null
    : result.stdout.slice(markerIndex).match(new RegExp(`${FINAL_URL_MARKER}([^\\s]+)`));
  const finalUrl = finalUrlMatch?.[1] === undefined ? null : new URL(finalUrlMatch[1]);
  const finalPath = finalUrl?.pathname ?? null;
  const expectedTextFound = responseBody.includes(check.expectedText);
  const rejectedBodyFound = REJECTED_BODY.test(responseBody);
  const loginPageFound = responseBody.includes('Email me a sign-in link');
  const noProfileFound = responseBody.includes('Choose an advertising profile');
  const expectedFinalPath = check.route === '/' ? '/dashboard' : check.route;
  return {
    route: check.route,
    status,
    finalPath,
    finalProfileMatched: finalUrl?.searchParams.get('profile') === profileId,
    checkDurationMs: Math.round(performance.now() - startedAt),
    responseBytes: Buffer.byteLength(responseBody),
    htmlDocumentFound: /<!DOCTYPE html>/i.test(responseBody),
    appShellFound: responseBody.includes('data-testid="app-nav"'),
    nextRedirectFound: responseBody.includes('NEXT_REDIRECT'),
    expectedTextFound,
    rejectedBodyFound,
    loginPageFound,
    noProfileFound,
    passed:
      result.exitCode === 0
      && status === 200
      && finalPath === expectedFinalPath
      && finalUrl?.searchParams.get('profile') === profileId
      && !responseBody.includes('NEXT_REDIRECT')
      && expectedTextFound
      && !rejectedBodyFound,
  };
}

function curlConfig(cookieHeader: string, profileId: string): string {
  // curl config uses double-quoted values. Auth cookie values are URL-safe, but
  // escaping both special characters keeps this stdin boundary correct.
  if (/[\r\n]/.test(cookieHeader)) {
    throw new Error('Authentication cookie shape is invalid.');
  }
  const escaped = cookieHeader.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const profileQuery = new URLSearchParams({ profile: profileId }).toString();
  return `header = "Cookie: ${escaped}"\nurl-query = "${profileQuery}"\nmax-time = 30\n`;
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

void main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Release candidate verification failed.');
    process.exit(1);
  });
