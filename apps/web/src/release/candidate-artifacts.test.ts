import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OperatorContext } from '../ui/operator-context';
import {
  OPENSPELL_BRAND_MARK_ARTIFACT,
  RECOMMENDATION_REVIEW_ARTIFACT,
} from '../ui/artifact-markers';
import { ProfileAwareBrand } from '../ui/profile-aware-brand';
import {
  inspectReleaseArtifact,
  releaseResponsePassed,
  RELEASE_ROUTE_CHECKS,
} from './candidate-artifacts';

function routeCheck(route: string) {
  const check = RELEASE_ROUTE_CHECKS.find((candidate) => candidate.route === route);
  if (check === undefined) throw new Error(`Missing release route check for ${route}`);
  return check;
}

describe('release candidate artifact checks', () => {
  it('matches the tracked official brand icon and still requires a successful response', () => {
    const body = readFileSync(
      new URL('../../public/brand/wizards-ai-icon.svg', import.meta.url),
      'utf8',
    );
    const inspection = inspectReleaseArtifact(
      body,
      routeCheck('/brand/wizards-ai-icon.svg').artifacts,
    );

    expect(inspection).toEqual({ matched: true, missingArtifacts: [], rejectedBody: false });
    expect(releaseResponsePassed(0, 200, inspection)).toBe(true);
    expect(releaseResponsePassed(0, 404, inspection)).toBe(false);
  });

  it('rejects a successful non-SVG response at the official brand asset path', () => {
    const inspection = inspectReleaseArtifact(
      '<html><h1>Not found</h1></html>',
      routeCheck('/brand/wizards-ai-icon.svg').artifacts,
    );

    expect(releaseResponsePassed(0, 200, inspection)).toBe(false);
    expect(inspection.missingArtifacts).toEqual([
      'official-openspell-brand-icon',
      'official-openspell-brand-palette',
    ]);
  });

  it('rejects the stale grid artifact even when its old heading remains', () => {
    const inspection = inspectReleaseArtifact('<main><h1>Campaigns</h1></main>', routeCheck('/grid').artifacts);

    expect(inspection).toEqual({
      matched: false,
      missingArtifacts: [
        'active-account-context',
        'date-range-picker',
        'official-brand-mark-in-dom',
      ],
      rejectedBody: false,
    });
  });

  it('matches the operator context and date picker rendered by the current grid source', () => {
    const body = [
      '<h1>Campaigns</h1>',
      renderToStaticMarkup(createElement(ProfileAwareBrand)),
      renderToStaticMarkup(createElement(OperatorContext, {
        account: 'Synthetic account',
        marketplace: 'US',
        currencyCode: 'USD',
        timezone: 'America/Los_Angeles',
        path: '/grid',
        period: { start: '2026-08-01', end: '2026-08-28' },
        today: '2026-08-29',
        preserved: { profile: 'profile-synthetic', entity: 'campaigns' },
      })),
    ].join('');

    expect(inspectReleaseArtifact(body, routeCheck('/grid').artifacts)).toEqual({
      matched: true,
      missingArtifacts: [],
      rejectedBody: false,
    });
    expect(body).toContain(`data-release-artifact="${OPENSPELL_BRAND_MARK_ARTIFACT}"`);
  });

  it('rejects operator markup that falls back to text instead of the official mark', () => {
    const check = routeCheck('/grid');
    const body = check.artifacts
      .filter((artifact) => artifact.id !== 'official-brand-mark-in-dom')
      .map((artifact) => artifact.text)
      .join('');

    expect(inspectReleaseArtifact(body, check.artifacts)).toMatchObject({
      matched: false,
      missingArtifacts: ['official-brand-mark-in-dom'],
    });
  });

  it('requires the focused recommendations workflow even when the heading is present', () => {
    const stale = '<main><h1>Recommendations</h1></main>';
    const current = `<main data-release-artifact="${RECOMMENDATION_REVIEW_ARTIFACT}"><h1>Recommendations</h1></main>`;

    expect(inspectReleaseArtifact(stale, routeCheck('/recommendations').artifacts)).toMatchObject({
      matched: false,
      missingArtifacts: ['focused-review-workflow'],
    });
    expect(inspectReleaseArtifact(current, routeCheck('/recommendations').artifacts)).toMatchObject({
      matched: true,
      missingArtifacts: [],
    });
  });

  it('rejects an error surface even when every expected string is present', () => {
    const check = routeCheck('/grid');
    const body = `${check.artifacts.map((artifact) => artifact.text).join('')}<p role="alert">Unavailable</p>`;

    expect(inspectReleaseArtifact(body, check.artifacts)).toEqual({
      matched: false,
      missingArtifacts: [],
      rejectedBody: true,
    });
    expect(releaseResponsePassed(0, 200, inspectReleaseArtifact(body, check.artifacts))).toBe(false);
  });
});
