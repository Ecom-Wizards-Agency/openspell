import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { UiFeedbackItem } from '../../src/feedback/ui';
import { RoadmapBoardView } from './board.js';

const feature = (status: string): UiFeedbackItem => ({
  id: '20000000-0000-4000-8000-000000000001',
  type: 'feature',
  title: 'Bulk actions',
  body: 'Apply a reviewed set at once.',
  severity: null,
  status,
  adminNote: null,
  duplicateOf: null,
  votes: 3,
  viewerHasVoted: true,
  viewerIsAuthor: false,
  route: '/grid',
  profileId: null,
  createdAt: '2026-08-27T00:00:00.000Z',
});

describe('/roadmap board render', () => {
  it('renders intake, planned items, votes, and feature triage without duplicate controls', () => {
    const item = feature('new');
    const markup = renderToStaticMarkup(
      createElement(RoadmapBoardView, {
        planned: [item],
        inProgress: [],
        shipped: [],
        declined: [],
        canTriage: true,
      }),
    );

    expect(markup).toContain('Request a feature');
    expect(markup).toContain('Planned');
    expect(markup).toContain(`id="roadmap-${item.id}"`);
    expect(markup).toContain('data-testid="vote-count">3');
    expect(markup).toContain('data-testid="status-select"');
    expect(markup).not.toContain('data-testid="mark-duplicate"');
  });
});
