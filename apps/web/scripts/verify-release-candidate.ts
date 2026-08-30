/**
 * Verify an immutable Vercel candidate before its public alias is promoted.
 *
 * Vercel protects immutable deployment URLs, so plain browser navigation lands
 * on Vercel's login screen. This gate lets the authenticated Vercel CLI resolve
 * the existing protection context and supplies the already authenticated
 * OpenSpell session to curl through stdin. Cookie names and values never enter
 * arguments, files, logs, or the candidate report, and the persistent Chrome
 * profile is never modified.
 *
 * Every check is a GET request. Keep this list free of endpoints that enqueue
 * jobs or mutate product data. After promotion, run the browser QA sweep too;
 * this preflight proves the protected server artifact before alias movement.
 *
 * Usage:
 *   bash apps/web/scripts/verify-release-candidate.sh https://candidate.example <full-git-sha>
 */
import type { BrowserContext } from '@playwright/test';
import { ORG_COOKIE, PROFILE_COOKIE } from '../src/cookies';
import { requestCandidateRoute } from '../src/release/candidate-redirect';
import {
  ReleaseTransportError,
  releaseFailure,
  requestCandidate,
} from '../src/release/candidate-transport';
import { webRevision } from '../src/revision';

const PRODUCTION_ORIGIN = process.env['OPENSPELL_PRODUCTION_ORIGIN']
  ?? 'https://ads.ecomwizards.agency';
const CDP_URL = process.env['OPENSPELL_CDP_URL'] ?? 'http://127.0.0.1:9222';
const AUTH_COOKIE = /^sb-.*-auth-token(?:\.\d+)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANDIDATE_HOST = /^wizard-[a-z0-9]+-ecom-wizards\.vercel\.app$/;
const REJECTED_BODY = /role=["']alert["']|Application error|Internal Server Error|Login – Vercel/i;

const ROUTES = [
  { route: '/', expectedText: 'Dashboard' },
  { route: '/dashboard', expectedText: 'Dashboard' },
  // The complete Grid hydrates after the server document arrives. Its default
  // entity heading is server-rendered; the scroller test id is not.
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
  gateBlockedFound: boolean;
  redirectsFollowed: number;
  redirectRejected: boolean;
  passed: boolean;
}

interface RevisionResult {
  expected: string;
  observed: string;
  status: number | null;
  passed: boolean;
}

async function main(): Promise<void> {
  const inputs = process.argv.slice(2).filter((argument) => argument !== '--');
  if (inputs.length !== 2) throw new ReleaseTransportError('arguments_invalid');
  const candidate = candidateOrigin(inputs[0]);
  const expectedRevision = requiredRevision(inputs[1]);
  const production = productionOrigin(PRODUCTION_ORIGIN);
  clearSensitiveEnvironment();
  if (candidate.origin === production.origin) {
    throw new ReleaseTransportError('candidate_invalid');
  }

  const revision = await verifyRevision(candidate, expectedRevision);
  if (!revision.passed) {
    console.log(JSON.stringify({ target: 'immutable-candidate', passed: false, revision, routes: [] }, null, 2));
    process.exitCode = 1;
    return;
  }

  const { chromium } = await import('@playwright/test');
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
  try {
    browser = await chromium.connectOverCDP(requiredCdpEndpoint(CDP_URL));
  } catch {
    throw new ReleaseTransportError('cdp_unavailable');
  }
  const sourceContext = browser.contexts()[0];
  if (sourceContext === undefined) {
    throw new ReleaseTransportError('session_unavailable');
  }

  let browserCookies: Awaited<ReturnType<typeof sourceContext.cookies>>;
  try {
    browserCookies = await sourceContext.cookies(production.origin);
  } catch {
    throw new ReleaseTransportError('session_unavailable');
  }
  const sourceCookies = browserCookies.filter((cookie) => AUTH_COOKIE.test(cookie.name));
  if (sourceCookies.length === 0) {
    throw new ReleaseTransportError('session_unavailable');
  }
  const profileCookie = browserCookies.find((cookie) => cookie.name === PROFILE_COOKIE);
  const pageProfileId = await selectedProfileId(sourceContext, production);
  const profileId = pageProfileId
    ?? (profileCookie !== undefined && UUID.test(profileCookie.value) ? profileCookie.value : null);
  if (profileId === null || !UUID.test(profileId)) {
    throw new ReleaseTransportError('profile_unavailable');
  }
  const orgCookie = browserCookies.find(
    (cookie) => cookie.name === ORG_COOKIE && UUID.test(cookie.value),
  );
  const forwardedCookies = orgCookie === undefined ? sourceCookies : [...sourceCookies, orgCookie];
  const cookieHeader = forwardedCookies
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');

  // Keep database-backed route checks serial. A concurrent sweep can consume
  // the production session pool and manufacture 500s that real navigation
  // would never create.
  const results: RouteResult[] = [];
  for (const check of ROUTES) {
    results.push(await verifyRoute(
      candidate,
      check,
      cookieHeader,
      profileId,
    ));
  }

  const passed = results.every((result) => result.passed);
  console.log(JSON.stringify({ target: 'immutable-candidate', passed, revision, routes: results }, null, 2));
  if (!passed) process.exitCode = 1;
}

async function verifyRevision(
  candidate: URL,
  expected: string,
): Promise<RevisionResult> {
  const response = await requestCandidate({
    candidate,
    url: new URL('/api/healthz', candidate),
  });

  let observed = 'unknown';
  let healthy: boolean;
  try {
    const payload = JSON.parse(response.responseBody) as Record<string, unknown>;
    observed = webRevision({ OPENSPELL_WEB_REVISION: String(payload['revision'] ?? '') });
    healthy = payload['status'] === 'ok' && payload['product'] === 'OpenSpell';
  } catch {
    healthy = false;
  }

  return {
    expected,
    observed,
    status: response.status,
    passed:
      response.status === 200
      && healthy
      && observed === expected,
  };
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
      for (const element of document.querySelectorAll<HTMLElement>(
        'input[name="profile"], select[name*="profile" i]',
      )) {
        values.push(
          element instanceof HTMLInputElement || element instanceof HTMLSelectElement
            ? element.value
            : null,
        );
      }
      for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href*="profile="]')) {
        values.push(new URL(anchor.href, window.location.href).searchParams.get('profile'));
      }
      const remembered = document.cookie
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${cookieName}=`));
      if (remembered !== undefined) {
        values.push(decodeURIComponent(remembered.split('=').slice(1).join('=')));
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
  const response = await requestCandidateRoute({
    candidate,
    route: check.route,
    expectedProfileId: profileId,
    request: async (url) => requestCandidate({
      candidate,
      url,
      cookieHeader,
    }),
  });
  const responseBody = response.responseBody;
  const finalUrl = response.finalUrl;
  const finalPath = finalUrl?.pathname ?? null;
  const expectedTextFound = responseBody.includes(check.expectedText);
  const rejectedBodyFound = REJECTED_BODY.test(responseBody);
  const htmlDocumentFound = /<!DOCTYPE html>/i.test(responseBody);
  const appShellFound = responseBody.includes('data-testid="app-nav"');
  const nextRedirectFound = responseBody.includes('NEXT_REDIRECT');
  const loginPageFound = /Email me a sign-in link|Sign in with your work address/.test(responseBody);
  const noProfileFound = /Choose an advertising profile|No advertising profiles yet|No profiles yet/.test(
    responseBody,
  );
  const gateBlockedFound = /cannot reach its database|DATABASE_URL is not set|not a member of any organisation/.test(
    responseBody,
  );
  const expectedFinalPath = check.route === '/'
    ? '/dashboard'
    : new URL(check.route, candidate).pathname;
  return {
    route: check.route,
    status: response.status,
    finalPath,
    finalProfileMatched: finalUrl?.searchParams.get('profile') === profileId,
    checkDurationMs: Math.round(performance.now() - startedAt),
    responseBytes: Buffer.byteLength(responseBody),
    htmlDocumentFound,
    appShellFound,
    nextRedirectFound,
    expectedTextFound,
    rejectedBodyFound,
    loginPageFound,
    noProfileFound,
    gateBlockedFound,
    redirectsFollowed: response.redirectsFollowed,
    redirectRejected: response.redirectRejected,
    passed:
      response.status === 200
      && !response.redirectRejected
      && finalUrl?.origin === candidate.origin
      && finalPath === expectedFinalPath
      && finalUrl?.searchParams.get('profile') === profileId
      && htmlDocumentFound
      && appShellFound
      && !nextRedirectFound
      && expectedTextFound
      && !rejectedBodyFound
      && !loginPageFound
      && !noProfileFound
      && !gateBlockedFound,
  };
}

function candidateOrigin(input: string | undefined): URL {
  if (input === undefined || /[\r\n]/.test(input)) {
    throw new ReleaseTransportError('candidate_invalid');
  }
  let candidate: URL;
  try {
    candidate = new URL(input);
  } catch {
    throw new ReleaseTransportError('candidate_invalid');
  }
  if (
    candidate.protocol !== 'https:'
    || !CANDIDATE_HOST.test(candidate.hostname)
    || candidate.username !== ''
    || candidate.password !== ''
    || candidate.port !== ''
    || candidate.pathname !== '/'
    || candidate.search !== ''
    || candidate.hash !== ''
  ) {
    throw new ReleaseTransportError('candidate_invalid');
  }
  return candidate;
}

function requiredRevision(input: string | undefined): string {
  const revision = webRevision({ OPENSPELL_WEB_REVISION: input ?? '' });
  if (revision === 'unknown') {
    throw new ReleaseTransportError('arguments_invalid');
  }
  return revision;
}

function productionOrigin(input: string): URL {
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
      throw new Error('invalid');
    }
    return url;
  } catch {
    throw new ReleaseTransportError('arguments_invalid');
  }
}

function requiredCdpEndpoint(input: string): string {
  try {
    const url = new URL(input);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw new Error('invalid');
    return url.href;
  } catch {
    throw new ReleaseTransportError('cdp_unavailable');
  }
}

function clearSensitiveEnvironment(): void {
  for (const name of [
    'DEBUG',
    'NODE_DEBUG',
    'NODE_DEBUG_NATIVE',
    'NODE_OPTIONS',
    'NODE_V8_COVERAGE',
    'PWDEBUG',
    'OPENSPELL_CDP_URL',
    'VERCEL_AUTOMATION_BYPASS_SECRET',
  ]) {
    delete process.env[name];
  }
}

export async function runReleaseCandidateCli(): Promise<void> {
  try {
    await main();
  } catch (error) {
    console.error(releaseFailure(error));
    process.exitCode = 1;
  }
}
