import { normalizePublicGitRevision } from './public-revision';

export type ReleaseVerifierErrorCode =
  | 'arguments_not_allowed'
  | 'candidate_missing'
  | 'invalid_candidate'
  | 'expected_revision_invalid'
  | 'production_origin_invalid'
  | 'candidate_is_production'
  | 'cdp_endpoint_invalid'
  | 'cdp_unavailable'
  | 'cdp_session_unavailable'
  | 'authentication_missing'
  | 'authentication_invalid'
  | 'vercel_cli_unavailable'
  | 'unexpected_failure';

export class ReleaseVerifierError extends Error {
  readonly code: ReleaseVerifierErrorCode;

  constructor(code: ReleaseVerifierErrorCode) {
    super(code);
    this.name = 'ReleaseVerifierError';
    this.code = code;
  }
}

export function publicReleaseFailure(error: unknown): string {
  const code = error instanceof ReleaseVerifierError ? error.code : 'unexpected_failure';
  return `OPENSPELL_RELEASE_ERROR:${code}`;
}

export function requiredCdpEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new ReleaseVerifierError('cdp_endpoint_invalid');
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol)) {
    throw new ReleaseVerifierError('cdp_endpoint_invalid');
  }
  return endpoint.href;
}

export async function connectToCdpSafely<Browser>(
  endpoint: string,
  connect: (validatedEndpoint: string) => Promise<Browser>,
): Promise<Browser> {
  const validatedEndpoint = requiredCdpEndpoint(endpoint);
  try {
    return await connect(validatedEndpoint);
  } catch {
    throw new ReleaseVerifierError('cdp_unavailable');
  }
}

export type RevisionCheckReason =
  | 'matched'
  | 'request_failed'
  | 'invalid_response'
  | 'missing_revision'
  | 'malformed_revision'
  | 'mismatched_revision';

export interface CandidateRevisionCheck {
  passed: boolean;
  reason: RevisionCheckReason;
  status: number | null;
  expectedRevision: string;
  observedRevision: string | null;
}

export interface RevisionFirstGateResult<RouteResult> {
  passed: boolean;
  revision: CandidateRevisionCheck;
  routes: readonly RouteResult[];
}

export function requiredExpectedRevision(value: string | undefined): string {
  const revision = normalizePublicGitRevision(value);
  if (revision === null) {
    throw new Error('Pass the expected full 40-character Git commit SHA as the second argument.');
  }
  return revision;
}

export function inspectCandidateRevision(
  exitCode: number | null,
  status: number | null,
  responseBody: string,
  expectedRevision: string,
): CandidateRevisionCheck {
  const base = { status, expectedRevision, observedRevision: null };
  if (exitCode !== 0 || status !== 200) {
    return { ...base, passed: false, reason: 'request_failed' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return { ...base, passed: false, reason: 'invalid_response' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...base, passed: false, reason: 'invalid_response' };
  }

  const health = parsed as Record<string, unknown>;
  if (health['product'] !== 'OpenSpell' || health['status'] !== 'ready') {
    return { ...base, passed: false, reason: 'invalid_response' };
  }
  const suppliedRevision = health['revision'];
  if (suppliedRevision === null || suppliedRevision === undefined || suppliedRevision === '') {
    return { ...base, passed: false, reason: 'missing_revision' };
  }
  if (typeof suppliedRevision !== 'string') {
    return { ...base, passed: false, reason: 'malformed_revision' };
  }

  const observedRevision = normalizePublicGitRevision(suppliedRevision);
  if (observedRevision === null) {
    return { ...base, passed: false, reason: 'malformed_revision' };
  }
  if (observedRevision !== expectedRevision) {
    return {
      ...base,
      passed: false,
      reason: 'mismatched_revision',
      observedRevision,
    };
  }

  return {
    ...base,
    passed: true,
    reason: 'matched',
    observedRevision,
  };
}

/**
 * Revision verification deliberately owns the control flow. A failed revision
 * check returns before the callback that opens Chrome or requests operator
 * routes, so a stale candidate cannot accidentally collect convincing QA.
 */
export async function runRevisionFirstGate<RouteResult>(input: {
  checkRevision: () => Promise<CandidateRevisionCheck>;
  checkRoutes: () => Promise<readonly RouteResult[]>;
  routePassed: (route: RouteResult) => boolean;
}): Promise<RevisionFirstGateResult<RouteResult>> {
  const revision = await input.checkRevision();
  if (!revision.passed) return { passed: false, revision, routes: [] };

  const routes = await input.checkRoutes();
  return {
    passed: routes.every(input.routePassed),
    revision,
    routes,
  };
}
