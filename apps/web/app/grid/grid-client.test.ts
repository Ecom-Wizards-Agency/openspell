import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { columnsFor } from '@wizard-ads/ui';
import type { SavedView } from '@wizard-ads/ui';
import { GridWorkspace, withValidGrouping } from './grid-client';

function view(groupBy: readonly string[]): SavedView {
  return {
    id: 'synthetic-view',
    name: 'Synthetic hierarchy',
    entity: 'search_terms',
    columns: ['search_term', 'spend'],
    pinned: ['search_term'],
    widths: {},
    filter: { groups: [] },
    sort: [],
    groupBy,
    dateRange: null,
    updatedAt: '2026-08-29T00:00:00.000Z',
  };
}

describe('grid saved-view grouping', () => {
  it('renders the toolbar disabled until the saved layout is restored', () => {
    const markup = renderToStaticMarkup(
      createElement(GridWorkspace, {
        entity: 'campaigns',
        rows: [],
        currencyCode: 'USD',
        profileId: 'synthetic-profile',
        period: { start: '2026-08-01', end: '2026-08-29' },
        comparisonPeriod: { start: '2026-07-03', end: '2026-07-31' },
        freshness: {
          tone: 'muted',
          headline: 'Synthetic report state',
          details: [],
          staleTypes: [],
          lossyTypes: [],
          coversThrough: null,
        },
        campaignId: null,
      }),
    );

    expect(markup).toContain('data-testid="grid-workspace"');
    expect(markup).toContain('data-ready="false"');
    expect(markup).toContain('data-testid="grid-toolbar-readiness"');
    expect(markup).toContain('disabled=""');
  });

  it('preserves three valid levels in their saved order', () => {
    const normalized = withValidGrouping(
      view(['campaign_name', 'ad_group_name', 'match_type']),
      columnsFor('search_terms'),
    );
    expect(normalized.groupBy).toEqual(['campaign_name', 'ad_group_name', 'match_type']);
  });

  it('drops duplicates, unavailable dimensions and malformed legacy state', () => {
    const normalized = withValidGrouping(
      view(['campaign_name', 'campaign_name', 'not_a_column', 'match_type']),
      columnsFor('search_terms'),
    );
    expect(normalized.groupBy).toEqual(['campaign_name', 'match_type']);

    const malformed = { ...view([]), groupBy: undefined } as unknown as SavedView;
    expect(withValidGrouping(malformed, columnsFor('search_terms')).groupBy).toEqual([]);
  });
});
