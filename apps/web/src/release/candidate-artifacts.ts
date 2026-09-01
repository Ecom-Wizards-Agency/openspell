import { JSDOM } from 'jsdom';
import { RELEASE_ARTIFACT } from '../ui/artifact-markers';
import { webRevision, type WebRevisionSource } from '../revision';
import {
  requestCandidateRoute,
  type CandidateHttpResponse,
  type CandidateRouteResponse,
} from './candidate-redirect';
import { isCompleteGridRowsEvidence } from './grid-server-timing';

const OFFICIAL_BRAND_PATH = '/brand/wizards-ai-icon.svg';
const OFFICIAL_BRAND_SHA256 =
  'sha256:ec87eb73689b1792fabd9c7098b03f7b7c86f4192ced9c9ad63a64ab85ed0a55';
const PROFILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REJECTED_TEXT = /Application error|Internal Server Error|Email me a sign-in link|Sign in with your work address|Choose an advertising profile|No advertising profiles yet|No profiles yet|cannot reach its database|DATABASE_URL is not set|not a member of any organisation/i;

export const CANDIDATE_CHECK_ORDER = [
  'hosted-revision',
  'official-brand-svg',
  'authenticated-routes',
  'campaign-grid',
  'recommendation-review',
  'complete-grid-rows',
] as const;

export type CandidateCheckId = (typeof CANDIDATE_CHECK_ORDER)[number];

export const CANDIDATE_FAILURE_REASONS = [
  'artifact_missing',
  'body_digest',
  'effective_url',
  'grid_incomplete',
  'health_identity',
  'http_status',
  'media_type',
  'redirect',
  'revision_mismatch',
  'revision_source',
  'route_identity',
] as const;

export type CandidateFailureReason = (typeof CANDIDATE_FAILURE_REASONS)[number];

export const CANDIDATE_ARTIFACT_IDS = [
  'active-account-context',
  'app-shell',
  'campaign-heading',
  'campaigns-builder-heading',
  'creative-heading',
  'dashboard-heading',
  'date-range-picker',
  'html-document',
  'integrations-heading',
  'official-brand-mark',
  'optimizer-groups-heading',
  'optimizer-heading',
  'recommendation-heading',
  'recommendation-review',
  'requested-date-range',
  'tags-heading',
  'time-machine-heading',
] as const;

export type CandidateArtifactId = (typeof CANDIDATE_ARTIFACT_IDS)[number];

export interface CandidateCheckResult {
  readonly id: CandidateCheckId;
  readonly verdict: 'pass' | 'fail' | 'not-run';
  readonly reason?: CandidateFailureReason;
  readonly missingArtifacts?: readonly CandidateArtifactId[];
}

export interface ObservedCandidateRevision {
  readonly observed: string;
  readonly source: WebRevisionSource;
}

const revisionBound = Symbol('openspell.revision-bound-candidate');
const revisionBoundCandidates = new WeakSet<object>();

export interface RevisionBoundCandidate {
  readonly origin: string;
  readonly expectedRevision: string;
  readonly [revisionBound]: true;
}

export type PublicCandidateIdentityResult =
  | {
      readonly passed: true;
      readonly candidate: RevisionBoundCandidate;
      readonly revision: ObservedCandidateRevision;
      readonly checks: readonly CandidateCheckResult[];
    }
  | {
      readonly passed: false;
      readonly candidate: null;
      readonly revision: ObservedCandidateRevision;
      readonly checks: readonly CandidateCheckResult[];
    };

type CandidateRequest = (url: URL) => Promise<CandidateHttpResponse>;

interface DocumentEvidence {
  readonly passed: boolean;
  readonly reason: CandidateFailureReason | null;
  readonly missingArtifacts: readonly CandidateArtifactId[];
}

const GENERIC_ROUTES = [
  { route: '/', heading: 'Dashboard', artifact: 'dashboard-heading' },
  { route: '/dashboard', heading: 'Dashboard', artifact: 'dashboard-heading' },
  { route: '/optimizer', heading: 'Campaign Optimizer', artifact: 'optimizer-heading' },
  {
    route: '/optimizer/groups',
    heading: 'Optimization Groups',
    artifact: 'optimizer-groups-heading',
  },
  { route: '/creative', heading: 'Creative Performance', artifact: 'creative-heading' },
  { route: '/campaigns', heading: 'Campaign Builder', artifact: 'campaigns-builder-heading' },
  { route: '/tags', heading: 'Tags', artifact: 'tags-heading' },
  { route: '/time-machine', heading: 'Time Machine', artifact: 'time-machine-heading' },
  {
    route: '/settings/integrations',
    heading: 'Integrations',
    artifact: 'integrations-heading',
  },
] as const satisfies readonly {
  route: string;
  heading: string;
  artifact: CandidateArtifactId;
}[];

/**
 * Prove public hosted identity before any production browser session or cookie
 * is acquired. Only the full conjunction creates the opaque bound candidate.
 */
export async function verifyPublicCandidateIdentity(input: {
  readonly candidate: URL;
  readonly expectedRevision: string;
  readonly request: CandidateRequest;
}): Promise<PublicCandidateIdentityResult> {
  const canonicalExpected = webRevision({ OPENSPELL_WEB_REVISION: input.expectedRevision });
  if (canonicalExpected === 'unknown' || canonicalExpected !== input.expectedRevision) {
    return {
      passed: false,
      candidate: null,
      revision: { observed: 'unknown', source: 'unknown' },
      checks: [
        failed('hosted-revision', 'revision_mismatch'),
        notRun('official-brand-svg'),
      ],
    };
  }
  const health = await input.request(new URL('/api/healthz', input.candidate));
  const revision = observedRevision(health);
  const revisionFailure = revisionFailureReason(health, revision, input.expectedRevision);
  const revisionCheck = revisionFailure === null
    ? passed('hosted-revision')
    : failed('hosted-revision', revisionFailure);
  if (revisionFailure !== null) {
    return {
      passed: false,
      candidate: null,
      revision,
      checks: [revisionCheck, notRun('official-brand-svg')],
    };
  }

  const asset = await input.request(new URL(OFFICIAL_BRAND_PATH, input.candidate));
  const assetFailure = officialBrandFailureReason(asset);
  const assetCheck = assetFailure === null
    ? passed('official-brand-svg')
    : failed('official-brand-svg', assetFailure);
  if (assetFailure !== null) {
    return {
      passed: false,
      candidate: null,
      revision,
      checks: [revisionCheck, assetCheck],
    };
  }

  const candidate = Object.freeze({
    origin: input.candidate.origin,
    expectedRevision: input.expectedRevision,
    [revisionBound]: true as const,
  });
  revisionBoundCandidates.add(candidate);
  return {
    passed: true,
    candidate,
    revision,
    checks: [revisionCheck, assetCheck],
  };
}

/** Run the complete authenticated policy serially against one revision-bound candidate. */
export async function verifyBoundCandidateCapabilities(input: {
  readonly candidate: RevisionBoundCandidate;
  readonly expectedProfileId: string;
  readonly period: { readonly start: string; readonly end: string };
  readonly request: CandidateRequest;
}): Promise<readonly CandidateCheckResult[]> {
  if (!revisionBoundCandidates.has(input.candidate)) {
    throw new Error('candidate_not_revision_bound');
  }
  if (!PROFILE.test(input.expectedProfileId)) throw new Error('invalid_expected_profile');
  const candidateOrigin = new URL(input.candidate.origin);

  const genericMissing = new Set<CandidateArtifactId>();
  let genericReason: CandidateFailureReason | null = null;
  for (const route of GENERIC_ROUTES) {
    const evidence = await verifyDocumentRoute({
      candidate: candidateOrigin,
      route: route.route,
      expectedProfileId: input.expectedProfileId,
      heading: route.heading,
      headingArtifact: route.artifact,
      request: input.request,
    });
    for (const artifact of evidence.missingArtifacts) genericMissing.add(artifact);
    if (!evidence.passed && genericReason === null) genericReason = evidence.reason;
  }
  const authenticatedRoutes = genericReason === null
    ? passed('authenticated-routes')
    : failed(
        'authenticated-routes',
        genericMissing.size > 0 ? 'artifact_missing' : genericReason,
        Array.from(genericMissing),
      );

  const gridUrl = new URL('/grid', candidateOrigin);
  gridUrl.searchParams.set('entity', 'campaigns');
  gridUrl.searchParams.set('from', input.period.start);
  gridUrl.searchParams.set('to', input.period.end);
  const gridRoute = `${gridUrl.pathname}${gridUrl.search}`;
  const campaignGridEvidence = await verifyDocumentRoute({
    candidate: candidateOrigin,
    route: gridRoute,
    expectedProfileId: input.expectedProfileId,
    heading: 'Campaigns',
    headingArtifact: 'campaign-heading',
    request: input.request,
    inspect(document) {
      const missing: CandidateArtifactId[] = [];
      const context = document.querySelector(
        '.wa-operator-context[aria-label="Active advertising account and reporting window"]',
      );
      if (context?.querySelector('strong')?.textContent?.trim() === '') {
        missing.push('active-account-context');
      } else if (context === null || context.querySelector('strong') === null) {
        missing.push('active-account-context');
      }
      const dateRange = context?.querySelector('.wa-date-range') ?? null;
      if (dateRange === null) missing.push('date-range-picker');
      const from = dateRange?.querySelector<HTMLInputElement>('input[name="from"][type="date"]');
      const to = dateRange?.querySelector<HTMLInputElement>('input[name="to"][type="date"]');
      if (from?.value !== input.period.start || to?.value !== input.period.end) {
        missing.push('requested-date-range');
      }
      if (document.querySelector(
        `a.wa-brand > span.wa-brand-mark[data-release-artifact="${RELEASE_ARTIFACT.brandMark}"]`,
      ) === null) {
        missing.push('official-brand-mark');
      }
      return missing;
    },
  });
  const campaignGrid = documentCheck('campaign-grid', campaignGridEvidence);

  const recommendationEvidence = await verifyDocumentRoute({
    candidate: candidateOrigin,
    route: '/recommendations',
    expectedProfileId: input.expectedProfileId,
    heading: 'Recommendations',
    headingArtifact: 'recommendation-heading',
    request: input.request,
    inspect(document) {
      return document.querySelector(
        `main[data-release-artifact="${RELEASE_ARTIFACT.recommendationReview}"]`,
      ) === null
        ? ['recommendation-review']
        : [];
    },
  });
  const recommendationReview = documentCheck(
    'recommendation-review',
    recommendationEvidence,
  );

  const gridRows = await verifyCompleteGridRows({
    candidate: candidateOrigin,
    expectedProfileId: input.expectedProfileId,
    period: input.period,
    request: input.request,
  });

  return [authenticatedRoutes, campaignGrid, recommendationReview, gridRows];
}

function observedRevision(response: CandidateHttpResponse): ObservedCandidateRevision {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(response.responseBody);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    // The fixed unknown identity below is the only retained parse failure.
  }
  const observed = webRevision({
    OPENSPELL_WEB_REVISION: typeof payload['revision'] === 'string' ? payload['revision'] : '',
  });
  const source = payload['revisionSource'];
  return {
    observed,
    source: source === 'vercel' || source === 'explicit' ? source : 'unknown',
  };
}

function revisionFailureReason(
  response: CandidateHttpResponse,
  revision: ObservedCandidateRevision,
  expectedRevision: string,
): CandidateFailureReason | null {
  const publicFailure = publicResponseFailure(response, 'application/json');
  if (publicFailure !== null) return publicFailure;
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(response.responseBody);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return 'health_identity';
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return 'health_identity';
  }
  if (payload['status'] !== 'ok' || payload['product'] !== 'OpenSpell') return 'health_identity';
  if (revision.source !== 'vercel') return 'revision_source';
  return revision.observed === expectedRevision ? null : 'revision_mismatch';
}

function officialBrandFailureReason(
  response: CandidateHttpResponse,
): CandidateFailureReason | null {
  const publicFailure = publicResponseFailure(response, 'image/svg+xml');
  if (publicFailure !== null) return publicFailure;
  return response.responseBodySha256 === OFFICIAL_BRAND_SHA256 ? null : 'body_digest';
}

function publicResponseFailure(
  response: CandidateHttpResponse,
  mediaType: 'application/json' | 'image/svg+xml',
): CandidateFailureReason | null {
  if (response.status !== 200) return 'http_status';
  if (response.rawLocation !== null) return 'redirect';
  if (!response.effectiveUrlMatched) return 'effective_url';
  return response.mediaType === mediaType ? null : 'media_type';
}

async function verifyDocumentRoute(input: {
  readonly candidate: URL;
  readonly route: string;
  readonly expectedProfileId: string;
  readonly heading: string;
  readonly headingArtifact: CandidateArtifactId;
  readonly request: CandidateRequest;
  readonly inspect?: (document: Document) => readonly CandidateArtifactId[];
}): Promise<DocumentEvidence> {
  const response = await requestCandidateRoute({
    candidate: input.candidate,
    route: input.route,
    expectedProfileId: input.expectedProfileId,
    request: input.request,
  });
  const expectedPath = input.route === '/'
    ? '/dashboard'
    : new URL(input.route, input.candidate).pathname;
  if (!validDocumentResponse(response, input.candidate, expectedPath, input.expectedProfileId)) {
    return { passed: false, reason: 'route_identity', missingArtifacts: [] };
  }
  if (!/<!doctype html>/i.test(response.responseBody)) {
    return {
      passed: false,
      reason: 'artifact_missing',
      missingArtifacts: ['html-document'],
    };
  }
  if (response.responseBody.includes('NEXT_REDIRECT')) {
    return { passed: false, reason: 'route_identity', missingArtifacts: [] };
  }

  const dom = new JSDOM(response.responseBody);
  try {
    const document = dom.window.document;
    if (document.querySelector('[role="alert"]') !== null || REJECTED_TEXT.test(visibleText(document))) {
      return { passed: false, reason: 'route_identity', missingArtifacts: [] };
    }
    const missing: CandidateArtifactId[] = [];
    if (
      document.querySelector(
        '[data-testid="app-nav"][data-auth-state="authenticated"]',
      ) === null
    ) {
      missing.push('app-shell');
    }
    const headingFound = Array.from(document.querySelectorAll('h1')).some(
      (element) => element.textContent?.trim() === input.heading,
    );
    if (!headingFound) missing.push(input.headingArtifact);
    if (input.inspect !== undefined) missing.push(...input.inspect(document));
    return missing.length === 0
      ? { passed: true, reason: null, missingArtifacts: [] }
      : { passed: false, reason: 'artifact_missing', missingArtifacts: unique(missing) };
  } finally {
    dom.window.close();
  }
}

function validDocumentResponse(
  response: CandidateRouteResponse,
  candidate: URL,
  expectedPath: string,
  expectedProfileId: string,
): boolean {
  return response.status === 200
    && response.rawLocation === null
    && response.mediaType === 'text/html'
    && response.effectiveUrlMatched
    && !response.redirectRejected
    && response.finalUrl?.origin === candidate.origin
    && response.finalUrl.pathname === expectedPath
    && response.finalUrl.searchParams.get('profile') === expectedProfileId;
}

function visibleText(document: Document): string {
  const clone = document.body.cloneNode(true) as HTMLElement;
  for (const element of clone.querySelectorAll('script, style, template, noscript')) element.remove();
  return clone.textContent ?? '';
}

async function verifyCompleteGridRows(input: {
  readonly candidate: URL;
  readonly expectedProfileId: string;
  readonly period: { readonly start: string; readonly end: string };
  readonly request: CandidateRequest;
}): Promise<CandidateCheckResult> {
  const url = new URL('/api/grid/rows', input.candidate);
  url.searchParams.set('profile', input.expectedProfileId);
  url.searchParams.set('entity', 'campaigns');
  url.searchParams.set('from', input.period.start);
  url.searchParams.set('to', input.period.end);
  const response = await input.request(url);
  if (
    response.status !== 200
    || response.rawLocation !== null
    || response.mediaType !== 'application/json'
    || !response.effectiveUrlMatched
  ) {
    return failed('complete-grid-rows', 'route_identity');
  }

  let rowCount: number | null = null;
  let returnedRows: number | null = null;
  let truncated: boolean | null = null;
  try {
    const payload = JSON.parse(response.responseBody) as Record<string, unknown>;
    rowCount = Number.isSafeInteger(payload['rowCount']) && Number(payload['rowCount']) >= 0
      ? Number(payload['rowCount'])
      : null;
    returnedRows = Array.isArray(payload['rows']) ? payload['rows'].length : null;
    truncated = typeof payload['truncated'] === 'boolean' ? payload['truncated'] : null;
  } catch {
    // Exact private values are deliberately reduced to the result below.
  }

  return isCompleteGridRowsEvidence({
    status: response.status,
    rowCount,
    returnedRows,
    truncated,
    serverTiming: response.serverTiming,
  })
    ? passed('complete-grid-rows')
    : failed('complete-grid-rows', 'grid_incomplete');
}

function documentCheck(id: CandidateCheckId, evidence: DocumentEvidence): CandidateCheckResult {
  if (evidence.passed) return passed(id);
  return failed(
    id,
    evidence.missingArtifacts.length > 0 ? 'artifact_missing' : evidence.reason ?? 'route_identity',
    evidence.missingArtifacts,
  );
}

function passed(id: CandidateCheckId): CandidateCheckResult {
  return { id, verdict: 'pass' };
}

function notRun(id: CandidateCheckId): CandidateCheckResult {
  return { id, verdict: 'not-run' };
}

function failed(
  id: CandidateCheckId,
  reason: CandidateFailureReason,
  missingArtifacts: readonly CandidateArtifactId[] = [],
): CandidateCheckResult {
  return missingArtifacts.length === 0
    ? { id, verdict: 'fail', reason }
    : { id, verdict: 'fail', reason, missingArtifacts: unique(missingArtifacts) };
}

function unique(values: readonly CandidateArtifactId[]): readonly CandidateArtifactId[] {
  return Array.from(new Set(values)).sort();
}
