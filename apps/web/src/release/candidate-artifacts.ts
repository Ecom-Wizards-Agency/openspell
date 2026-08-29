import {
  OPENSPELL_BRAND_MARK_ARTIFACT,
  RECOMMENDATION_REVIEW_ARTIFACT,
} from '../ui/artifact-markers';

export interface ReleaseArtifact {
  id: string;
  text: string;
}

export interface ReleaseRouteCheck {
  route: string;
  artifacts: readonly ReleaseArtifact[];
}

export interface ArtifactInspection {
  matched: boolean;
  missingArtifacts: readonly string[];
  rejectedBody: boolean;
}

const REJECTED_BODY = /role=["']alert["']|Application error|Internal Server Error|Login – Vercel/i;

/**
 * Every route remains GET-only. The grid and recommendations checks deliberately
 * include capability markers beyond their headings so a stale artifact cannot
 * pass merely because its navigation and page title still render.
 */
export const RELEASE_ROUTE_CHECKS: readonly ReleaseRouteCheck[] = [
  {
    route: '/brand/wizards-ai-icon.svg',
    artifacts: [
      {
        id: 'official-openspell-brand-icon',
        text: '<svg width="378" height="378" viewBox="0 0 378 378"',
      },
      {
        id: 'official-openspell-brand-palette',
        text: '<radialGradient id="paint0_radial_577_551"',
      },
    ],
  },
  { route: '/', artifacts: [{ id: 'dashboard-link', text: 'Open the dashboard' }] },
  { route: '/dashboard', artifacts: [{ id: 'dashboard-heading', text: 'Dashboard' }] },
  {
    route: '/grid?entity=campaigns',
    artifacts: [
      { id: 'grid-heading', text: 'Campaigns' },
      {
        id: 'active-account-context',
        text: 'aria-label="Active advertising account and reporting window"',
      },
      { id: 'date-range-picker', text: 'class="wa-date-range"' },
      {
        id: 'official-brand-mark-in-dom',
        text: `data-release-artifact="${OPENSPELL_BRAND_MARK_ARTIFACT}"`,
      },
    ],
  },
  { route: '/optimizer', artifacts: [{ id: 'optimizer-heading', text: 'Campaign Optimizer' }] },
  {
    route: '/optimizer/groups',
    artifacts: [{ id: 'groups-heading', text: 'Optimization Groups' }],
  },
  { route: '/creative', artifacts: [{ id: 'creative-heading', text: 'Creative Performance' }] },
  { route: '/campaigns', artifacts: [{ id: 'builder-heading', text: 'Campaign Builder' }] },
  {
    route: '/recommendations',
    artifacts: [
      { id: 'recommendations-heading', text: 'Recommendations' },
      {
        id: 'focused-review-workflow',
        text: `data-release-artifact="${RECOMMENDATION_REVIEW_ARTIFACT}"`,
      },
    ],
  },
  { route: '/tags', artifacts: [{ id: 'tags-heading', text: 'Tags' }] },
  { route: '/time-machine', artifacts: [{ id: 'time-machine-heading', text: 'Time Machine' }] },
  {
    route: '/settings/integrations',
    artifacts: [{ id: 'integrations-heading', text: 'Integrations' }],
  },
] as const;

export function inspectReleaseArtifact(
  responseBody: string,
  artifacts: readonly ReleaseArtifact[],
): ArtifactInspection {
  const missingArtifacts = artifacts
    .filter((artifact) => !responseBody.includes(artifact.text))
    .map((artifact) => artifact.id);
  const rejectedBody = REJECTED_BODY.test(responseBody);

  return {
    matched: missingArtifacts.length === 0 && !rejectedBody,
    missingArtifacts,
    rejectedBody,
  };
}

export function releaseResponsePassed(
  exitCode: number | null,
  status: number | null,
  inspection: ArtifactInspection,
): boolean {
  return exitCode === 0 && status === 200 && inspection.matched;
}
