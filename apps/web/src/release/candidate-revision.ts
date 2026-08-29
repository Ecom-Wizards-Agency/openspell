import { normalizePublicGitRevision } from './public-revision';

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
