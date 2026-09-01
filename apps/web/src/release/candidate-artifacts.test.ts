import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RELEASE_ARTIFACT } from '../ui/artifact-markers';
import type { CandidateHttpResponse } from './candidate-redirect';
import type { GridServerTimingDurations } from './grid-server-timing';
import {
  verifyBoundCandidateCapabilities,
  verifyPublicCandidateIdentity,
} from './candidate-artifacts';

const CANDIDATE = new URL('https://wizard-synthetic-ecom-wizards.vercel.app');
const REVISION = '1234567890abcdef1234567890abcdef12345678';
const PROFILE = '10000000-0000-4000-8000-000000000001';
const PERIOD = { start: '2026-08-01', end: '2026-08-30' };
const SVG = readFileSync(
  new URL('../../public/brand/wizards-ai-icon.svg', import.meta.url),
  'utf8',
);
const TIMING: GridServerTimingDurations = {
  actor: 1,
  role: 1,
  profile: 1,
  rows: 1,
  serialize: 1,
  close: 1,
  total: 7,
};
type SvgOverride = {
  readonly body?: string;
  readonly status?: number;
  readonly rawLocation?: string;
  readonly mediaType?: CandidateHttpResponse['mediaType'];
  readonly effectiveUrlMatched?: boolean;
};
const SVG_FAILURES: ReadonlyArray<readonly [string, SvgOverride]> = [
  ['changed bytes', { body: `${SVG} ` }],
  ['wrong status', { status: 500 }],
  ['wrong media type', { mediaType: 'other' }],
  ['redirect', { status: 307, rawLocation: '/brand/wizards-ai-icon.svg' }],
  ['wrong effective URL', { effectiveUrlMatched: false }],
];

describe('public release candidate identity', () => {
  it('binds only after exact Vercel revision and real tracked SVG evidence', async () => {
    const paths: string[] = [];
    const result = await verifyPublicCandidateIdentity({
      candidate: CANDIDATE,
      expectedRevision: REVISION,
      request: async (url) => {
        paths.push(url.pathname);
        return url.pathname === '/api/healthz'
          ? response(url, healthBody())
          : response(url, SVG, { mediaType: 'image/svg+xml' });
      },
    });

    expect(result.passed).toBe(true);
    expect(paths).toEqual(['/api/healthz', '/brand/wizards-ai-icon.svg']);
    expect(result.checks).toEqual([
      { id: 'hosted-revision', verdict: 'pass' },
      { id: 'official-brand-svg', verdict: 'pass' },
    ]);
  });

  it('does not request the SVG after a non-Vercel or mismatched revision', async () => {
    for (const body of [
      healthBody({ revisionSource: 'explicit' }),
      healthBody({ revision: 'abcdef1234567890abcdef1234567890abcdef12' }),
      healthBody({ revision: 'malformed' }),
    ]) {
      let requests = 0;
      const result = await verifyPublicCandidateIdentity({
        candidate: CANDIDATE,
        expectedRevision: REVISION,
        request: async (url) => {
          requests += 1;
          return response(url, body);
        },
      });

      expect(result.passed).toBe(false);
      expect(requests).toBe(1);
      expect(result.checks[1]).toEqual({ id: 'official-brand-svg', verdict: 'not-run' });
    }
  });

  it.each([
    ['wrong status', { status: 500 }],
    ['redirect', { rawLocation: '/api/healthz' }],
    ['wrong effective URL', { effectiveUrlMatched: false }],
    ['wrong media type', { mediaType: 'text/html' as const }],
    ['wrong product', { body: healthBody().replace('OpenSpell', 'Other') }],
    ['not ready', { body: healthBody({ status: 'starting' }) }],
  ])('stops before the SVG on a health response with %s', async (_label, override) => {
    let requests = 0;
    const result = await verifyPublicCandidateIdentity({
      candidate: CANDIDATE,
      expectedRevision: REVISION,
      request: async (url) => {
        requests += 1;
        return response(url, 'body' in override ? override.body : healthBody(), {
          ...('status' in override ? { status: override.status } : {}),
          ...('rawLocation' in override ? { rawLocation: override.rawLocation } : {}),
          ...('effectiveUrlMatched' in override
            ? { effectiveUrlMatched: override.effectiveUrlMatched }
            : {}),
          ...('mediaType' in override ? { mediaType: override.mediaType } : {}),
        });
      },
    });

    expect(result.passed).toBe(false);
    expect(requests).toBe(1);
  });

  it.each(SVG_FAILURES)('rejects an official SVG with %s', async (_label, override) => {
    const result = await verifyPublicCandidateIdentity({
      candidate: CANDIDATE,
      expectedRevision: REVISION,
      request: async (url) => url.pathname === '/api/healthz'
        ? response(url, healthBody())
        : response(url, override.body ?? SVG, {
            ...(override.status === undefined ? {} : { status: override.status }),
            ...(override.rawLocation === undefined
              ? {}
              : { rawLocation: override.rawLocation }),
            mediaType: override.mediaType ?? 'image/svg+xml',
            ...(override.effectiveUrlMatched === undefined
              ? {}
              : { effectiveUrlMatched: override.effectiveUrlMatched }),
          }),
    });

    expect(result.passed).toBe(false);
    expect(result.checks[1]).toMatchObject({ id: 'official-brand-svg', verdict: 'fail' });
  });

  it('rejects a malformed expected revision before any request', async () => {
    let requests = 0;
    const result = await verifyPublicCandidateIdentity({
      candidate: CANDIDATE,
      expectedRevision: 'unknown',
      request: async (url) => {
        requests += 1;
        return response(url, healthBody());
      },
    });

    expect(result.passed).toBe(false);
    expect(requests).toBe(0);
  });
});

describe('authenticated candidate capabilities', () => {
  it('runs the complete route and Grid proof serially with exact context', async () => {
    const publicIdentity = await boundCandidate();
    const fixture = authenticatedFixture();
    const checks = await verifyBoundCandidateCapabilities({
      candidate: publicIdentity,
      expectedProfileId: PROFILE,
      period: PERIOD,
      request: fixture.request,
    });

    expect(checks).toEqual([
      { id: 'authenticated-routes', verdict: 'pass' },
      { id: 'campaign-grid', verdict: 'pass' },
      { id: 'recommendation-review', verdict: 'pass' },
      { id: 'complete-grid-rows', verdict: 'pass' },
    ]);
    expect(fixture.maximumConcurrency()).toBe(1);
    const gridDocument = fixture.urls.find(
      (url) => url.pathname === '/grid' && url.searchParams.get('entity') === 'campaigns',
    );
    expect(gridDocument?.searchParams.get('profile')).toBe(PROFILE);
    expect(gridDocument?.searchParams.get('from')).toBe(PERIOD.start);
    expect(gridDocument?.searchParams.get('to')).toBe(PERIOD.end);
    const gridRows = fixture.urls.find((url) => url.pathname === '/api/grid/rows');
    expect(gridRows?.searchParams.get('entity')).toBe('campaigns');
    expect(gridRows?.searchParams.get('profile')).toBe(PROFILE);
    expect(gridRows?.searchParams.get('from')).toBe(PERIOD.start);
    expect(gridRows?.searchParams.get('to')).toBe(PERIOD.end);
    const serializedChecks = JSON.stringify(checks);
    expect(serializedChecks).not.toContain(PROFILE);
    expect(serializedChecks).not.toContain('Synthetic account');
  });

  it('rejects a heading-only Grid and reports the exact public artifacts', async () => {
    const fixture = authenticatedFixture({ grid: 'heading-only' });
    const checks = await verifyBoundCandidateCapabilities({
      candidate: await boundCandidate(),
      expectedProfileId: PROFILE,
      period: PERIOD,
      request: fixture.request,
    });

    expect(checks[1]).toEqual({
      id: 'campaign-grid',
      verdict: 'fail',
      reason: 'artifact_missing',
      missingArtifacts: [
        'active-account-context',
        'date-range-picker',
        'official-brand-mark',
        'requested-date-range',
      ],
    });
  });

  it.each([
    ['empty active account', 'empty-account'],
    ['defaulted date range', 'defaulted-date'],
    ['scattered lookalike elements', 'scattered'],
  ] as const)('rejects Grid identity with %s', async (_label, grid) => {
    const fixture = authenticatedFixture({ grid });
    const checks = await verifyBoundCandidateCapabilities({
      candidate: await boundCandidate(),
      expectedProfileId: PROFILE,
      period: PERIOD,
      request: fixture.request,
    });

    expect(checks[1]?.verdict).toBe('fail');
  });

  it.each([
    ['anonymous navigation', 'anonymous-nav'],
    ['login content', 'login'],
    ['wrong final route', 'wrong-final-route'],
  ] as const)('rejects generic route identity with %s', async (_label, generic) => {
    const fixture = authenticatedFixture({ generic });
    const checks = await verifyBoundCandidateCapabilities({
      candidate: await boundCandidate(),
      expectedProfileId: PROFILE,
      period: PERIOD,
      request: fixture.request,
    });

    expect(checks[0]?.verdict).toBe('fail');
  });

  it('does not treat Recommendations marker text in a script as a real element', async () => {
    const fixture = authenticatedFixture({ recommendations: 'script-only' });
    const checks = await verifyBoundCandidateCapabilities({
      candidate: await boundCandidate(),
      expectedProfileId: PROFILE,
      period: PERIOD,
      request: fixture.request,
    });

    expect(checks[2]).toEqual({
      id: 'recommendation-review',
      verdict: 'fail',
      reason: 'artifact_missing',
      missingArtifacts: ['recommendation-review'],
    });
  });

  it('rejects an error surface even when it contains the real marker element', async () => {
    const fixture = authenticatedFixture({ recommendations: 'marked-error' });
    const checks = await verifyBoundCandidateCapabilities({
      candidate: await boundCandidate(),
      expectedProfileId: PROFILE,
      period: PERIOD,
      request: fixture.request,
    });

    expect(checks[2]).toEqual({
      id: 'recommendation-review',
      verdict: 'fail',
      reason: 'route_identity',
    });
  });

  it('retains the existing NEXT_REDIRECT rejection even with valid-looking elements', async () => {
    const fixture = authenticatedFixture({ recommendations: 'next-redirect' });
    const checks = await verifyBoundCandidateCapabilities({
      candidate: await boundCandidate(),
      expectedProfileId: PROFILE,
      period: PERIOD,
      request: fixture.request,
    });

    expect(checks[2]).toEqual({
      id: 'recommendation-review',
      verdict: 'fail',
      reason: 'route_identity',
    });
  });

  it('reduces different complete private Grid measurements to identical public checks', async () => {
    const outputs: string[] = [];
    for (const rows of [[], [{ id: 1 }, { id: 2 }, { id: 3 }]]) {
      const fixture = authenticatedFixture({
        gridRows: { rows, rowCount: rows.length, truncated: false, timing: TIMING },
      });
      const checks = await verifyBoundCandidateCapabilities({
        candidate: await boundCandidate(),
        expectedProfileId: PROFILE,
        period: PERIOD,
        request: fixture.request,
      });
      outputs.push(JSON.stringify(checks));
    }

    expect(outputs[0]).toBe(outputs[1]);
  });

  it('rejects Grid count drift, truncation, unsafe counts, and missing timing', async () => {
    for (const gridRows of [
      { rows: [{}], rowCount: 2, truncated: false, timing: TIMING },
      { rows: [{}], rowCount: 1, truncated: true, timing: TIMING },
      { rows: [{}], rowCount: Number.MAX_SAFE_INTEGER + 1, truncated: false, timing: TIMING },
      { rows: [{}], rowCount: 1, truncated: false, timing: null },
    ]) {
      const fixture = authenticatedFixture({ gridRows });
      const checks = await verifyBoundCandidateCapabilities({
        candidate: await boundCandidate(),
        expectedProfileId: PROFILE,
        period: PERIOD,
        request: fixture.request,
      });
      expect(checks[3]).toEqual({
        id: 'complete-grid-rows',
        verdict: 'fail',
        reason: 'grid_incomplete',
      });
    }
  });

  it('rejects malformed Grid JSON', async () => {
    const fixture = authenticatedFixture({ gridRowsBody: '{malformed' });
    const checks = await verifyBoundCandidateCapabilities({
      candidate: await boundCandidate(),
      expectedProfileId: PROFILE,
      period: PERIOD,
      request: fixture.request,
    });

    expect(checks[3]).toEqual({
      id: 'complete-grid-rows',
      verdict: 'fail',
      reason: 'grid_incomplete',
    });
  });

  it('rejects fabricated or copied capabilities before any authenticated request', async () => {
    let calls = 0;
    const request = async (): Promise<CandidateHttpResponse> => {
      calls += 1;
      throw new Error('request_must_not_run');
    };
    const fabricated = { origin: CANDIDATE.origin, expectedRevision: REVISION };
    await expect(verifyBoundCandidateCapabilities({
      candidate: fabricated as never,
      expectedProfileId: PROFILE,
      period: PERIOD,
      request,
    })).rejects.toThrow('candidate_not_revision_bound');

    const bound = await boundCandidate();
    expect(typeof bound.origin).toBe('string');
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Reflect.set(bound, 'origin', 'https://different.invalid')).toBe(false);
    await expect(verifyBoundCandidateCapabilities({
      candidate: { ...bound },
      expectedProfileId: PROFILE,
      period: PERIOD,
      request,
    })).rejects.toThrow('candidate_not_revision_bound');
    expect(calls).toBe(0);
  });
});

async function boundCandidate() {
  const result = await verifyPublicCandidateIdentity({
    candidate: CANDIDATE,
    expectedRevision: REVISION,
    request: async (url) => url.pathname === '/api/healthz'
      ? response(url, healthBody())
      : response(url, SVG, { mediaType: 'image/svg+xml' }),
  });
  if (!result.passed) throw new Error('synthetic_public_identity_failed');
  return result.candidate;
}

function authenticatedFixture(options: {
  generic?: 'anonymous-nav' | 'complete' | 'login' | 'wrong-final-route';
  grid?: 'complete' | 'defaulted-date' | 'empty-account' | 'heading-only' | 'scattered';
  recommendations?: 'complete' | 'marked-error' | 'next-redirect' | 'script-only';
  gridRowsBody?: string;
  gridRows?: {
    rows: readonly unknown[];
    rowCount: number;
    truncated: boolean;
    timing: GridServerTimingDurations | null;
  };
} = {}) {
  const urls: URL[] = [];
  let active = 0;
  let maximum = 0;
  const request = async (url: URL): Promise<CandidateHttpResponse> => {
    active += 1;
    maximum = Math.max(maximum, active);
    urls.push(new URL(url.href));
    await Promise.resolve();
    try {
      if (url.pathname === '/') {
        return response(url, '', {
          status: 307,
          rawLocation: new URL(
            options.generic === 'wrong-final-route'
              ? `/optimizer?profile=${PROFILE}`
              : `/dashboard?profile=${PROFILE}`,
            CANDIDATE,
          ).href,
          mediaType: 'text/html',
        });
      }
      if (url.pathname === '/api/grid/rows') {
        const gridRows = options.gridRows ?? {
          rows: [{ id: 1 }, { id: 2 }],
          rowCount: 2,
          truncated: false,
          timing: TIMING,
        };
        return response(url, options.gridRowsBody ?? JSON.stringify({
          rows: gridRows.rows,
          rowCount: gridRows.rowCount,
          truncated: gridRows.truncated,
        }), { serverTiming: gridRows.timing });
      }
      if (url.pathname === '/grid') {
        return response(url, gridHtml(options.grid ?? 'complete'));
      }
      if (url.pathname === '/recommendations') {
        return response(url, options.recommendations === 'script-only'
          ? scriptOnlyRecommendationsHtml()
          : options.recommendations === 'marked-error'
            ? markedErrorRecommendationsHtml()
            : options.recommendations === 'next-redirect'
              ? `${recommendationsHtml()}NEXT_REDIRECT`
              : recommendationsHtml());
      }
      return response(url, documentHtml(
        headingFor(url.pathname),
        options.generic === 'login' ? '<p>Sign in with your work address</p>' : '',
        '',
        options.generic === 'anonymous-nav' ? 'anonymous' : 'authenticated',
      ));
    } finally {
      active -= 1;
    }
  };
  return { request, urls, maximumConcurrency: () => maximum };
}

function headingFor(pathname: string): string {
  const headings: Record<string, string> = {
    '/dashboard': 'Dashboard',
    '/optimizer': 'Campaign Optimizer',
    '/optimizer/groups': 'Optimization Groups',
    '/creative': 'Creative Performance',
    '/campaigns': 'Campaign Builder',
    '/tags': 'Tags',
    '/time-machine': 'Time Machine',
    '/settings/integrations': 'Integrations',
  };
  return headings[pathname] ?? 'Unknown';
}

function documentHtml(
  heading: string,
  content = '',
  mainAttributes = '',
  authState: 'anonymous' | 'authenticated' = 'authenticated',
): string {
  return `<!DOCTYPE html><html><body><div data-testid="app-nav" data-auth-state="${authState}"></div><main ${mainAttributes}><h1>${heading}</h1>${content}</main></body></html>`;
}

function gridHtml(
  mode: 'complete' | 'defaulted-date' | 'empty-account' | 'heading-only' | 'scattered',
): string {
  if (mode === 'heading-only') return documentHtml('Campaigns');
  const account = mode === 'empty-account' ? '   ' : 'Synthetic account';
  const from = mode === 'defaulted-date' ? '2026-07-01' : PERIOD.start;
  const to = mode === 'defaulted-date' ? '2026-07-30' : PERIOD.end;
  const dateRange = `
    <details class="wa-date-range">
      <input name="from" type="date" value="${from}">
      <input name="to" type="date" value="${to}">
    </details>`;
  if (mode === 'scattered') {
    return documentHtml('Campaigns', `
      <section class="wa-operator-context" aria-label="Active advertising account and reporting window">
        <strong>${account}</strong>
      </section>
      ${dateRange}
      <span class="wa-brand-mark" data-release-artifact="${RELEASE_ARTIFACT.brandMark}"></span>
    `);
  }
  return documentHtml('Campaigns', `
    <section class="wa-operator-context" aria-label="Active advertising account and reporting window">
      <strong>${account}</strong>
      ${dateRange}
    </section>
    <a class="wa-brand" href="/">
      <span class="wa-brand-mark" data-release-artifact="${RELEASE_ARTIFACT.brandMark}"></span>
    </a>
  `);
}

function recommendationsHtml(): string {
  return documentHtml(
    'Recommendations',
    '',
    `data-release-artifact="${RELEASE_ARTIFACT.recommendationReview}"`,
  );
}

function scriptOnlyRecommendationsHtml(): string {
  return documentHtml('Recommendations', `
    <script>const marker = '${RELEASE_ARTIFACT.recommendationReview}'</script>
  `);
}

function markedErrorRecommendationsHtml(): string {
  return documentHtml(
    'Recommendations',
    '<p role="alert">Application error</p>',
    `data-release-artifact="${RELEASE_ARTIFACT.recommendationReview}"`,
  );
}

function healthBody(overrides: {
  revision?: string;
  revisionSource?: string;
  status?: string;
} = {}): string {
  return JSON.stringify({
    status: overrides.status ?? 'ok',
    product: 'OpenSpell',
    revision: overrides.revision ?? REVISION,
    revisionSource: overrides.revisionSource ?? 'vercel',
  });
}

function response(
  url: URL,
  body: string,
  options: {
    status?: number;
    rawLocation?: string | null;
    mediaType?: CandidateHttpResponse['mediaType'];
    effectiveUrlMatched?: boolean;
    serverTiming?: GridServerTimingDurations | null;
  } = {},
): CandidateHttpResponse {
  return {
    status: options.status ?? 200,
    responseBody: body,
    responseBodySha256: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    rawLocation: options.rawLocation ?? null,
    mediaType: options.mediaType ?? (url.pathname.startsWith('/api/')
      ? 'application/json'
      : 'text/html'),
    effectiveUrlMatched: options.effectiveUrlMatched ?? true,
    serverTiming: options.serverTiming ?? null,
  };
}
