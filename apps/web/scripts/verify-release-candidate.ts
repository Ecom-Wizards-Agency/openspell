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
import {
  verifyBoundCandidateCapabilities,
  verifyPublicCandidateIdentity,
} from '../src/release/candidate-artifacts';
import {
  ReleaseTransportError,
  releaseFailure,
  requestCandidate,
} from '../src/release/candidate-transport';
import { serializeReleaseEvidence } from '../src/release/release-evidence';
import { webRevision } from '../src/revision';
import { periodFromParams, todayIso } from '../app/_lib/periods';

const PRODUCTION_ORIGIN = 'https://ads.ecomwizards.agency';
const CDP_URL = process.env['OPENSPELL_CDP_URL'] ?? 'http://127.0.0.1:9222';
const AUTH_COOKIE = /^sb-.*-auth-token(?:\.\d+)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANDIDATE_HOST = /^wizard-[a-z0-9]+-ecom-wizards\.vercel\.app$/;

type BrowserCookie = Awaited<ReturnType<BrowserContext['cookies']>>[number];

async function main(request: typeof requestCandidate): Promise<void> {
  const inputs = process.argv.slice(2).filter((argument) => argument !== '--');
  if (inputs.length !== 2) throw new ReleaseTransportError('arguments_invalid');
  const candidate = candidateOrigin(inputs[0]);
  const expectedRevision = requiredRevision(inputs[1]);
  const production = new URL(PRODUCTION_ORIGIN);
  clearSensitiveEnvironment();
  if (candidate.origin === production.origin) {
    throw new ReleaseTransportError('candidate_invalid');
  }

  const publicIdentity = await verifyPublicCandidateIdentity({
    candidate,
    expectedRevision,
    request: async (url) => request({ candidate, url }),
  });
  if (!publicIdentity.passed) {
    console.log(serializeReleaseEvidence({
      candidate,
      expectedRevision,
      observedRevision: publicIdentity.revision,
      checks: publicIdentity.checks,
    }));
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
  const sourceContext = productionBrowserContext(browser.contexts(), production);

  let browserCookies: Awaited<ReturnType<typeof sourceContext.cookies>>;
  try {
    browserCookies = await sourceContext.cookies(production.origin);
  } catch {
    throw new ReleaseTransportError('session_unavailable');
  }
  const sourceCookies = validatedAuthCookies(browserCookies, production);
  const profileCookie = validatedProfileCookie(browserCookies, production);
  const pageProfileIds = await selectedProfileIds(sourceContext, production);
  if (pageProfileIds.length > 1) throw new ReleaseTransportError('profile_unavailable');
  const pageProfileId = pageProfileIds[0] ?? null;
  const cookieProfileId = profileCookie?.value ?? null;
  if (pageProfileId !== null && cookieProfileId !== null && pageProfileId !== cookieProfileId) {
    throw new ReleaseTransportError('profile_unavailable');
  }
  const profileId = pageProfileId ?? cookieProfileId;
  if (profileId === null || !UUID.test(profileId)) {
    throw new ReleaseTransportError('profile_unavailable');
  }
  const orgCookie = validatedOrgCookie(browserCookies, production);
  const forwardedCookies = orgCookie === null
    ? sourceCookies
    : [...sourceCookies, orgCookie];
  const cookieHeader = forwardedCookies
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
  if (Buffer.byteLength(cookieHeader) > 16 * 1024) {
    throw new ReleaseTransportError('session_unavailable');
  }

  const period = periodFromParams({}, todayIso());
  const authenticatedChecks = await verifyBoundCandidateCapabilities({
    candidate: publicIdentity.candidate,
    expectedProfileId: profileId,
    period,
    request: async (url) => request({ candidate, url, cookieHeader }),
  });
  const checks = [...publicIdentity.checks, ...authenticatedChecks];
  const passed = checks.every((check) => check.verdict === 'pass');
  console.log(serializeReleaseEvidence({
    candidate,
    expectedRevision,
    observedRevision: publicIdentity.revision,
    checks,
  }));
  if (!passed) process.exitCode = 1;
}

async function selectedProfileIds(
  context: BrowserContext,
  production: URL,
): Promise<readonly string[]> {
  const observed = new Set<string>();
  const pages = context.pages().filter((page) => new URL(page.url()).origin === production.origin);
  for (const page of pages) {
    const candidates = await page.evaluate(activeProfileCandidatesInPage, PROFILE_COOKIE);
    for (const candidate of candidates) {
      if (candidate !== null && UUID.test(candidate)) observed.add(candidate);
    }
  }
  return Array.from(observed).sort();
}

/** Browser-side active state only. Navigation links may advertise other profiles. */
export function activeProfileCandidatesInPage(cookieName: string): readonly (string | null)[] {
  const values: Array<string | null> = [
    new URL(window.location.href).searchParams.get('profile'),
  ];
  for (const element of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
    'input[name="profile"], select[name="profile"]',
  )) {
    values.push(element.value);
  }
  const remembered = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`));
  if (remembered !== undefined) {
    try {
      values.push(decodeURIComponent(remembered.split('=').slice(1).join('=')));
    } catch {
      values.push(null);
    }
  }
  return values;
}

function productionBrowserContext(
  contexts: readonly BrowserContext[],
  production: URL,
): BrowserContext {
  const matches = contexts.filter((context) => context.pages().some((page) => {
    try {
      return new URL(page.url()).origin === production.origin;
    } catch {
      return false;
    }
  }));
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new ReleaseTransportError('session_unavailable');
  }
  return matches[0];
}

export function validatedAuthCookies(
  cookies: readonly BrowserCookie[],
  production: URL,
): readonly BrowserCookie[] {
  const auth = cookies.filter((cookie) => AUTH_COOKIE.test(cookie.name));
  if (auth.length === 0 || auth.length > 12) {
    throw new ReleaseTransportError('session_unavailable');
  }
  const names = new Set<string>();
  for (const cookie of auth) {
    if (names.has(cookie.name) || !safeProductionCookie(cookie, production)) {
      throw new ReleaseTransportError('session_unavailable');
    }
    names.add(cookie.name);
  }
  const families = new Set(auth.map((cookie) => cookie.name.replace(/\.\d+$/, '')));
  if (families.size !== 1) throw new ReleaseTransportError('session_unavailable');
  const family = families.values().next().value;
  if (family === undefined) throw new ReleaseTransportError('session_unavailable');
  const unchunked = auth.some((cookie) => cookie.name === family);
  const chunkNumbers = auth
    .filter((cookie) => cookie.name !== family)
    .map((cookie) => Number(cookie.name.slice(family.length + 1)))
    .sort((left, right) => left - right);
  if (
    (unchunked && auth.length !== 1)
    || (!unchunked && chunkNumbers.some((chunk, index) => chunk !== index))
  ) {
    throw new ReleaseTransportError('session_unavailable');
  }
  return [...auth].sort((left, right) => left.name.localeCompare(right.name));
}

export function validatedOrgCookie(
  cookies: readonly BrowserCookie[],
  production: URL,
): BrowserCookie | null {
  const org = cookies.filter((cookie) => cookie.name === ORG_COOKIE);
  if (org.length === 0) return null;
  if (
    org.length !== 1
    || org[0] === undefined
    || !UUID.test(org[0].value)
    || !safeProductionCookie(org[0], production)
  ) {
    throw new ReleaseTransportError('session_unavailable');
  }
  return org[0];
}

export function validatedProfileCookie(
  cookies: readonly BrowserCookie[],
  production: URL,
): BrowserCookie | null {
  const profile = cookies.filter((cookie) => cookie.name === PROFILE_COOKIE);
  if (profile.length === 0) return null;
  if (
    profile.length !== 1
    || profile[0] === undefined
    || !UUID.test(profile[0].value)
    || !safeProductionCookie(profile[0], production)
  ) {
    throw new ReleaseTransportError('profile_unavailable');
  }
  return profile[0];
}

function safeProductionCookie(cookie: BrowserCookie, production: URL): boolean {
  // Current Supabase and org-cookie writers do not set Secure. Provenance is
  // instead restricted to host-only cookies for the fixed HTTPS production
  // origin; the child sends them only to the validated HTTPS candidate.
  return cookie.domain === production.hostname
    && cookie.path === '/'
    && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(cookie.name)
    && !Array.from(cookie.value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f || character === ';';
    });
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

function requiredCdpEndpoint(input: string): string {
  try {
    const url = new URL(input);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    const httpDiscovery = url.protocol === 'http:' && url.pathname === '/';
    const websocket = url.protocol === 'ws:' && url.pathname.startsWith('/devtools/browser/');
    if (
      !loopback
      || (!httpDiscovery && !websocket)
      || url.username !== ''
      || url.password !== ''
      || url.port === ''
      || url.search !== ''
      || url.hash !== ''
    ) {
      throw new Error('invalid');
    }
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
    'OPENSPELL_PRODUCTION_ORIGIN',
    'VERCEL_AUTOMATION_BYPASS_SECRET',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ]) {
    delete process.env[name];
  }
}

export async function runReleaseCandidateCli(
  request: typeof requestCandidate = requestCandidate,
): Promise<void> {
  try {
    await main(request);
  } catch (error) {
    console.error(releaseFailure(error));
    process.exitCode = 1;
  }
}
