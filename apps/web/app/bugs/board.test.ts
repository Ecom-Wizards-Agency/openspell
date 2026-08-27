import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { UiFeedbackItem } from '../../src/feedback/ui';
import { BugBoardView } from './board.js';

const item = (
  id: string,
  title: string,
  status: string,
  duplicateOf: string | null = null,
): UiFeedbackItem => ({
  id,
  type: 'bug',
  title,
  body: '',
  severity: 'medium',
  status,
  adminNote: duplicateOf === null ? null : `duplicate of #${duplicateOf}`,
  duplicateOf,
  votes: 0,
  viewerHasVoted: false,
  viewerIsAuthor: false,
  route: '/grid',
  profileId: null,
  createdAt: '2026-08-27T00:00:00.000Z',
});

describe('/bugs board render', () => {
  it('renders every status column and collapses a duplicate beneath its target', () => {
    const target = item('10000000-0000-4000-8000-000000000001', 'Export loses sort', 'new');
    const duplicate = item(
      '10000000-0000-4000-8000-000000000002',
      'Sort vanishes on export',
      'declined',
      target.id,
    );
    const markup = renderToStaticMarkup(
      createElement(BugBoardView, {
        open: [target],
        inProgress: [item('10000000-0000-4000-8000-000000000003', 'Grid freezes', 'planned')],
        fixed: [item('10000000-0000-4000-8000-000000000004', 'Old fixed bug', 'shipped')],
        declined: [item('10000000-0000-4000-8000-000000000005', 'Expected behaviour', 'declined')],
        duplicates: [duplicate],
      }),
    );

    expect(markup).toContain('Open');
    expect(markup).toContain('In progress');
    expect(markup).toContain('Fixed');
    expect(markup).toContain('Declined / duplicate (2)');
    expect(markup).toContain('Duplicates (1)');
    expect(markup).toContain(duplicate.title);
    expect(markup).toContain(`id="bug-${target.id}"`);
    expect(markup).toContain(`href="/feedback#feedback-${target.id}"`);
  });
});
