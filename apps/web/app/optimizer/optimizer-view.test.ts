import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OptimizationGroup } from '../../src/optimizer/view';
import type { ProposalView } from '../../src/recommendations/view';
import { OptimizerGroupTable } from './optimizer-view';

function proposal(entityType: string, id: string): ProposalView {
  return {
    id,
    entityType,
    entityId: `${entityType}-1`,
    entityLabel: `${entityType} row`,
    scope: 'SP | Rank | Widget',
    field: 'bid',
    currentValue: '1',
    proposedValue: '1.1',
    delta: 0.1,
    reasonLabel: 'Low visibility',
    changeReason: 'Low visibility',
    limitReason: null,
    status: 'proposed',
  } as ProposalView;
}

describe('OptimizerGroupTable bid-history attach point', () => {
  it('offers target and keyword history without offering campaign history', () => {
    const group: OptimizationGroup = {
      key: 'campaign-1',
      label: 'SP | Rank | Widget',
      targetAcos: 0.3,
      objective: 'Balanced',
      proposals: [proposal('keyword', 'kw'), proposal('target', 'target'), proposal('campaign', 'campaign')],
      reasons: [{ label: 'Low visibility', count: 3 }],
    };
    const markup = renderToStaticMarkup(
      createElement(OptimizerGroupTable, {
        group,
        bidHistoryContext: {
          profileId: '00000000-0000-4000-8000-000000000001',
          window: { start: '2026-08-01', end: '2026-08-14' },
          currencyCode: 'USD',
        },
      }),
    );
    expect(markup.match(/view bid history/g)).toHaveLength(2);
    expect(markup).toContain('view-bid-history-kw');
    expect(markup).toContain('view-bid-history-target');
    expect(markup).not.toContain('view-bid-history-campaign');
  });
});
