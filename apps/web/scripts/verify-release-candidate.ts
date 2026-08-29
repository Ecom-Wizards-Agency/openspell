import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectReleaseArtifact, releaseResponsePassed, RELEASE_ROUTE_CHECKS, type ReleaseRouteCheck } from '../src/release/candidate-artifacts';
import { inspectCandidateBinding } from '../src/release/candidate-binding';
import { requestAccountRouteWithRedirects, type CandidateHttpResponse } from '../src/release/candidate-redirect';
import { connectToCdpSafely, inspectCandidateRevision, publicReleaseFailure, ReleaseVerifierError, requiredExpectedRevision, runRevisionFirstGate } from '../src/release/candidate-revision';

const PROD = process.env['OPENSPELL_PRODUCTION_ORIGIN'] ?? 'https://ads.ecomwizards.agency';
const HOST = /^wizard-ads-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/;
const AUTH_COOKIE = /^sb-.*-auth-token(?:\.\d+)?$/;
const RESPONSE_MARKER = '\nOPENSPELL_STATUS:';
const CURL_WRITE_OUT = '\\nOPENSPELL_STATUS:%{http_code}';
const DIAGNOSTIC = ['DEBUG', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'PWDEBUG', 'NODE_OPTIONS', 'NODE_V8_COVERAGE'] as const;
type RouteResult = { route: string; status: number | null; checkDurationMs: number; passed: boolean; missingArtifacts: readonly string[]; rejectedBody: boolean };
type Inputs = { token: string; projectId: string; orgId: string; bypass: string };

async function main(): Promise<void> {
  clearDiagnostics();
  if (process.argv.slice(2).some((value) => value !== '--')) throw new ReleaseVerifierError('arguments_not_allowed');
  const candidate = candidateOrigin(process.env['OPENSPELL_RELEASE_CANDIDATE_URL']);
  const expected = expectedRevision(process.env['OPENSPELL_RELEASE_EXPECTED_REVISION']);
  const production = productionOrigin(PROD);
  const inputs = providerInputs();
  const cdp = process.env['OPENSPELL_CDP_URL'] ?? 'http://127.0.0.1:9222';
  deleteSensitiveEnvironment();
  if (candidate.origin === production.origin) throw new ReleaseVerifierError('candidate_is_production');

  const metadata = await requestMetadata(candidate, inputs);
  const binding = inspectCandidateBinding({ ...metadata, candidateHostname: candidate.hostname, projectId: inputs.projectId, orgId: inputs.orgId });
  if (!binding.passed) throw new ReleaseVerifierError(`candidate_binding_${binding.reason}`);

  const gate = await runRevisionFirstGate({
    checkRevision: async () => {
      const response = await requestCandidate(candidate, '/api/healthz', inputs.bypass);
      return inspectCandidateRevision(response.exitCode, response.status, response.responseBody, expected);
    },
    checkRoutes: async () => verifyRoutes(candidate, production, cdp, inputs.bypass),
    routePassed: (route) => route.passed,
  });
  console.log(JSON.stringify({ target: 'immutable-candidate', passed: gate.passed, revision: gate.revision, routes: gate.routes }, null, 2));
  if (!gate.passed) process.exitCode = 1;
}

async function requestMetadata(candidate: URL, input: Inputs): Promise<CandidateHttpResponse> {
  const url = new URL(`https://api.vercel.com/v13/deployments/${encodeURIComponent(candidate.hostname)}`);
  url.searchParams.set('teamId', input.orgId);
  return requestCurl(buildReleaseCurlConfig({ url: url.href, bearer: input.token }));
}

async function verifyRoutes(candidate: URL, production: URL, cdp: string, bypass: string): Promise<readonly RouteResult[]> {
  const { chromium } = await import('@playwright/test');
  const browser = await connectToCdpSafely(cdp, async (endpoint) => chromium.connectOverCDP(endpoint));
  const context = browser.contexts()[0];
  if (context === undefined) throw new ReleaseVerifierError('cdp_session_unavailable');
  let cookies: Awaited<ReturnType<typeof context.cookies>>;
  try { cookies = (await context.cookies(production.origin)).filter((cookie) => AUTH_COOKIE.test(cookie.name)); }
  catch { throw new ReleaseVerifierError('cdp_session_unavailable'); }
  if (cookies.length === 0) throw new ReleaseVerifierError('authentication_missing');
  const header = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
  const results: RouteResult[] = [];
  for (const check of RELEASE_ROUTE_CHECKS) results.push(await verifyRoute(candidate, check, bypass, header));
  return results;
}

async function verifyRoute(candidate: URL, check: ReleaseRouteCheck, bypass: string, cookie: string): Promise<RouteResult> {
  const started = performance.now();
  const response = check.route === '/brand/wizards-ai-icon.svg'
    ? await requestCandidate(candidate, check.route, bypass, cookie)
    : await requestAccountRouteWithRedirects({ candidate, route: check.route, request: (route) => requestCandidate(candidate, route, bypass, cookie) });
  const inspection = inspectReleaseArtifact(response.responseBody, check.artifacts);
  return { route: check.route, status: response.status, checkDurationMs: Math.round(performance.now() - started), passed: releaseResponsePassed(response.exitCode, response.status, inspection), missingArtifacts: inspection.missingArtifacts, rejectedBody: inspection.rejectedBody };
}

function requestCandidate(candidate: URL, route: string, bypass: string, cookie?: string): Promise<CandidateHttpResponse> {
  const target = new URL(route, candidate.origin);
  if (target.origin !== candidate.origin) throw new ReleaseVerifierError('invalid_candidate_route');
  return requestCurl(buildReleaseCurlConfig({ url: target.href, bypass, cookie }));
}

export function buildReleaseCurlConfig(input: { url: string; bearer?: string; bypass?: string; cookie?: string }): string {
  const lines = [`url = "${escape(input.url)}"`, 'silent', 'show-error', 'max-time = 30', 'max-redirs = 0', 'dump-header = "-"', `write-out = "${CURL_WRITE_OUT}"`];
  if (input.bearer !== undefined) lines.push(`header = "Authorization: Bearer ${escape(input.bearer)}"`);
  if (input.bypass !== undefined) lines.push(`header = "x-vercel-protection-bypass: ${escape(input.bypass)}"`);
  if (input.cookie !== undefined) lines.push(`header = "Cookie: ${escape(input.cookie)}"`);
  return `${lines.join('\n')}\n`;
}

function escape(value: string): string {
  if (hasControl(value)) throw new ReleaseVerifierError('transport_input_invalid');
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

async function requestCurl(stdin: string): Promise<CandidateHttpResponse> {
  const result = await isolatedCurl(stdin);
  const marker = result.stdout.lastIndexOf(RESPONSE_MARKER);
  if (marker < 0) return { exitCode: result.exitCode, status: null, responseBody: '', rawLocation: null };
  const statusText = result.stdout.slice(marker + RESPONSE_MARKER.length);
  const status = /^\d{3}$/.test(statusText) ? Number(statusText) : null;
  const payload = result.stdout.slice(0, marker);
  const separator = payload.indexOf('\r\n\r\n');
  if (separator < 0) return { exitCode: result.exitCode, status: null, responseBody: '', rawLocation: null };
  const headers = payload.slice(0, separator);
  if (!/^HTTP\/\d(?:\.\d)? \d{3}/.test(headers)) return { exitCode: result.exitCode, status: null, responseBody: '', rawLocation: null };
  const locations = headers.split('\r\n').filter((line) => /^location:/i.test(line));
  const locationValue = locations.length === 1 ? locations[0]!.slice(locations[0]!.indexOf(':') + 1) : null;
  const rawLocation = locationValue?.startsWith(' ') === true && !locationValue.startsWith('  ')
    ? locationValue.slice(1)
    : locationValue === null ? null : '';
  if (locations.length > 1 || (rawLocation !== null && hasControl(rawLocation))) return { exitCode: result.exitCode, status: null, responseBody: '', rawLocation: null };
  return { exitCode: result.exitCode, status, responseBody: payload.slice(separator + 4), rawLocation };
}

async function isolatedCurl(stdin: string): Promise<{ exitCode: number | null; stdout: string }> {
  let home: string | null = null;
  try {
    home = await mkdtemp(join(tmpdir(), 'openspell-release-'));
    await chmod(home, 0o700);
    await writeFile(join(home, '.curlrc'), '', { mode: 0o600 });
    return await boundedSpawn('curl', ['--disable', '--config', '-'], stdin, home);
  } catch (error) {
    if (error instanceof ReleaseVerifierError) throw error;
    throw new ReleaseVerifierError('transport_isolation_failed');
  } finally { if (home !== null) await rm(home, { recursive: true, force: true }).catch(() => undefined); }
}

function boundedSpawn(command: string, args: readonly string[], input: string, curlHome: string): Promise<{ exitCode: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(command, args, { cwd: process.cwd(), env: childEnvironment(curlHome), stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { reject(new ReleaseVerifierError('curl_unavailable')); return; }
    let stdout = '', stdoutBytes = 0, stderrBytes = 0, failure: ReleaseVerifierError | null = null, settled = false;
    const timeout = setTimeout(() => fail('curl_timeout'), 35_000);
    function fail(code: 'curl_timeout' | 'curl_output_exceeded' | 'curl_stream_failed') { if (failure !== null || settled) return; failure = new ReleaseVerifierError(code); child.kill('SIGKILL'); }
    child.stdout.on('data', (chunk: Buffer) => { stdoutBytes += chunk.byteLength; if (stdoutBytes > 2 * 1024 * 1024) fail('curl_output_exceeded'); else stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.byteLength; if (stderrBytes > 256 * 1024) fail('curl_output_exceeded'); });
    child.stdout.on('error', () => fail('curl_stream_failed')); child.stderr.on('error', () => fail('curl_stream_failed')); child.stdin.on('error', () => fail('curl_stream_failed'));
    child.on('error', () => { if (settled) return; settled = true; clearTimeout(timeout); reject(new ReleaseVerifierError('curl_unavailable')); });
    child.on('close', (exitCode) => { if (settled) return; settled = true; clearTimeout(timeout); if (failure !== null) reject(failure); else if (exitCode !== 0) reject(new ReleaseVerifierError('curl_stream_failed')); else resolve({ exitCode, stdout }); });
    try { child.stdin.end(input); } catch { fail('curl_stream_failed'); }
  });
}

const CHILD_ENV = ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR'] as const;
function childEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: '1', CURL_HOME: home, FORCE_COLOR: '0', NO_COLOR: '1', NODE_ENV: 'production' };
  for (const name of CHILD_ENV) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

function providerInputs(): Inputs {
  const values = { token: process.env['VERCEL_TOKEN'], projectId: process.env['VERCEL_PROJECT_ID'], orgId: process.env['VERCEL_ORG_ID'], bypass: process.env['VERCEL_AUTOMATION_BYPASS_SECRET'] };
  if (Object.values(values).some((value) => value === undefined || value === '' || hasControl(value))) throw new ReleaseVerifierError('provider_environment_missing');
  return values as Inputs;
}
function candidateOrigin(value: string | undefined): URL {
  if (value === undefined) throw new ReleaseVerifierError('candidate_missing');
  let url: URL; try { url = new URL(value); } catch { throw new ReleaseVerifierError('invalid_candidate'); }
  if (url.protocol !== 'https:' || !HOST.test(url.hostname) || url.hostname.split('.')[0]!.length > 63 || url.username !== '' || url.password !== '' || url.port !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') throw new ReleaseVerifierError('invalid_candidate');
  return url;
}
function expectedRevision(value: string | undefined): string { try { return requiredExpectedRevision(value); } catch { throw new ReleaseVerifierError('expected_revision_invalid'); } }
function productionOrigin(value: string): URL { let url: URL; try { url = new URL(value); } catch { throw new ReleaseVerifierError('production_origin_invalid'); } if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') throw new ReleaseVerifierError('production_origin_invalid'); return url; }
function clearDiagnostics(): void { for (const name of DIAGNOSTIC) delete process.env[name]; }
function hasControl(value: string): boolean { return Array.from(value).some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f); }
function deleteSensitiveEnvironment(): void { for (const name of [...DIAGNOSTIC, 'OPENSPELL_RELEASE_CANDIDATE_URL', 'OPENSPELL_RELEASE_EXPECTED_REVISION', 'OPENSPELL_CDP_URL', 'VERCEL_TOKEN', 'VERCEL_PROJECT_ID', 'VERCEL_ORG_ID', 'VERCEL_AUTOMATION_BYPASS_SECRET']) delete process.env[name]; }
export async function runReleaseCandidateCli(): Promise<void> { try { await main(); } catch (error) { console.error(publicReleaseFailure(error)); process.exitCode = 1; } }
