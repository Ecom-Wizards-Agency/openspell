import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProposalView } from '../../src/recommendations/view';
import { ReviewWorkspace } from './review';

function proposal(id: string, status: string, reason: string): ProposalView {
  return {
    id,
    runId: 'run-1',
    reason,
    reasonLabel: reason === 'high_acos' ? 'High ACOS' : 'Low visibility',
    changeReason:
      reason === 'high_acos'
        ? 'Efficiency is outside the resolved policy.'
        : 'Visibility can be tested.',
    limitReason: null,
    entityType: 'keyword',
    entityId: `entity-${id}`,
    entityLabel: `Synthetic keyword ${id}`,
    scope: 'Synthetic campaign',
    field: 'bid',
    currentValue: '0.91',
    proposedValue: '0.87',
    delta: -0.04,
    status,
    decisionNote: null,
    exportBatchTag: null,
    strategy: {
      objective: 'unassigned',
      objectiveLabel: 'Unassigned',
      targetAcos: null,
      explanation: 'No strategy snapshot was stored.',
      optGroup: null,
      category: 'other',
      source: 'unassigned',
      cutOnAcosAlone: false,
    },
    strategyLabel: 'Unassigned',
    provenance: [],
    exportable: true,
  };
}

describe('ReviewWorkspace operator queue', () => {
  it('groups by next decision, then reason, while keeping export explicitly read-only', () => {
    const markup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        proposals: [
          proposal('new', 'proposed', 'high_acos'),
          proposal('accepted', 'accepted', 'low_visibility'),
          proposal('done', 'exported', 'high_acos'),
        ],
        runId: 'run-1',
        profileId: 'profile-1',
        client: 'Synthetic profile',
        counts: { proposed: 1, accepted: 1, exported: 1 },
        role: 'owner',
        hasStrategySnapshot: false,
      }),
    );

    expect(markup).toContain('decision-lane-needs_review');
    expect(markup).toContain('decision-lane-ready_to_export');
    expect(markup).toContain('decision-lane-completed');
    expect(markup).toContain('reason-group-needs_review-high_acos');
    expect(markup).toContain('Yes, export changes');
    expect(markup).toContain('Wizard Ads does not update Amazon');
    expect(markup).toContain(
      'Selects caps from this run’s snapshot; it is not a persisted campaign assignment.',
    );
  });
});
