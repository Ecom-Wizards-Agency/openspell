// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { columnsFor } from '@wizard-ads/ui';
import type { EntityLevel, GridRow, SavedView, ViewStore } from '@wizard-ads/ui';
import { GridWorkspace, withValidGrouping } from './grid-client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: Array<{ unmount: () => void }> = [];

afterEach(() => {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

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

function scopedView(
  entity: EntityLevel,
  options: Pick<SavedView, 'columns' | 'filter' | 'sort' | 'groupBy'>,
): SavedView {
  return {
    id: `saved-${entity}`,
    name: `Saved ${entity}`,
    entity,
    columns: options.columns,
    pinned: [],
    widths: {},
    filter: options.filter,
    sort: options.sort,
    groupBy: options.groupBy,
    dateRange: null,
    updatedAt: '2026-08-29T00:00:00.000Z',
  };
}

function row(entity: EntityLevel): GridRow {
  return {
    id: entity === 'campaigns' ? 'campaign:c-1' : 'target:kw-1',
    dimensions:
      entity === 'campaigns'
        ? {
            campaign_id: 'c-1',
            campaign_name: 'Synthetic campaign',
            campaign_state: 'enabled',
            ad_product: 'SP',
          }
        : {
            target_id: 'kw-1',
            targeting: 'synthetic target',
            target_state: 'enabled',
            match_type: 'exact',
          },
    totals: { impressions: 100, clicks: 12, spend: 9, sales: 30, orders: 2, units: 2 },
    comparison: null,
    currencyCode: 'USD',
  };
}

class DeferredViewStore implements ViewStore {
  readonly remembered: SavedView[] = [];
  private readonly pending = new Map<EntityLevel, (view: SavedView | null) => void>();

  async list(): Promise<SavedView[]> {
    return [];
  }

  async save(): Promise<void> {}

  async remove(): Promise<void> {}

  lastLayout(entity: EntityLevel): Promise<SavedView | null> {
    return new Promise((resolve) => this.pending.set(entity, resolve));
  }

  async rememberLayout(layout: SavedView): Promise<void> {
    this.remembered.push(layout);
  }

  restore(entity: EntityLevel, layout: SavedView | null): void {
    const resolve = this.pending.get(entity);
    if (resolve === undefined) throw new Error(`No pending restoration for ${entity}`);
    this.pending.delete(entity);
    resolve(layout);
  }
}

const freshness = {
  tone: 'muted' as const,
  headline: 'Synthetic report state',
  details: [],
  staleTypes: [],
  lossyTypes: [],
  coversThrough: null,
};

function workspaceProps(
  entity: EntityLevel,
  store: ViewStore | null,
): Parameters<typeof GridWorkspace>[0] {
  return {
    entity,
    rows: [row(entity)],
    currencyCode: 'USD',
    profileId: 'synthetic-profile',
    period: { start: '2026-08-01', end: '2026-08-29' },
    comparisonPeriod: { start: '2026-07-03', end: '2026-07-31' },
    freshness,
    campaignId: null,
    viewStore: store,
  };
}

describe('grid saved-view grouping', () => {
  it('renders no view-derived interaction until the saved layout is restored', () => {
    const markup = renderToStaticMarkup(
      createElement(GridWorkspace, {
        entity: 'campaigns',
        rows: [],
        currencyCode: 'USD',
        profileId: 'synthetic-profile',
        period: { start: '2026-08-01', end: '2026-08-29' },
        comparisonPeriod: { start: '2026-07-03', end: '2026-07-31' },
        freshness,
        campaignId: null,
        viewStore: null,
      }),
    );

    expect(markup).toContain('data-testid="grid-workspace"');
    expect(markup).toContain('data-ready="false"');
    expect(markup).toContain('data-testid="grid-toolbar-readiness"');
    expect(markup).toContain('data-testid="grid-layout-restoring"');
    expect(markup).not.toContain('data-testid="grid-start-experiment"');
    expect(markup).not.toContain('data-testid="grid-scroller"');
  });

  it('binds readiness to the current entity and restores scope before allowing interactions', async () => {
    const store = new DeferredViewStore();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);

    act(() => root.render(createElement(GridWorkspace, workspaceProps('campaigns', store))));
    expect(host.querySelector('[data-testid="grid-workspace"]')?.getAttribute('data-ready')).toBe('false');
    expect(host.querySelector('[data-testid="grid-scroller"]')).toBeNull();

    await act(async () => {
      store.restore(
        'campaigns',
        scopedView('campaigns', {
          columns: ['campaign_name', 'campaign_state', 'clicks', 'spend'],
          filter: {
            groups: [{ filters: [{ key: 'CAMPAIGN_ID', conditions: [{ operator: '=', values: ['c-1'] }] }] }],
          },
          sort: [{ columnId: 'clicks', direction: 'asc' }],
          groupBy: ['campaign_state'],
        }),
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="grid-workspace"]')?.getAttribute('data-ready')).toBe('true');
    expect(host.querySelector('[role="treegrid"]')).not.toBeNull();
    expect(host.querySelector('[role="columnheader"][aria-label="Clicks"]')?.getAttribute('aria-sort')).toBe('ascending');
    expect(host.querySelector<HTMLAnchorElement>('[data-testid="grid-start-experiment"]')?.getAttribute('href')).toContain('campaigns=c-1');

    // A prop-key change is synchronous. The old ready scope must never leak
    // through one render while the new target layout is still unresolved.
    act(() => root.render(createElement(GridWorkspace, workspaceProps('targets', store))));
    expect(host.querySelector('[data-testid="grid-workspace"]')?.getAttribute('data-ready')).toBe('false');
    expect(host.querySelector('[data-testid="grid-scroller"]')).toBeNull();
    expect(host.querySelector('[data-testid="grid-start-experiment"]')).toBeNull();

    await act(async () => {
      store.restore(
        'targets',
        scopedView('targets', {
          columns: ['targeting', 'match_type', 'spend'],
          filter: {
            groups: [{ filters: [{ key: 'TARGET_ID', conditions: [{ operator: '=', values: ['kw-1'] }] }] }],
          },
          sort: [{ columnId: 'spend', direction: 'desc' }],
          groupBy: ['match_type'],
        }),
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="grid-workspace"]')?.getAttribute('data-ready')).toBe('true');
    expect(host.querySelector<HTMLAnchorElement>('[data-testid="grid-start-experiment"]')?.getAttribute('href')).toContain('targets=kw-1');
    const spend = host.querySelector<HTMLElement>('[role="columnheader"][aria-label="Spend"]');
    expect(spend?.getAttribute('aria-sort')).toBe('descending');
    await act(async () => {
      spend?.click();
      await Promise.resolve();
    });
    expect(spend?.getAttribute('aria-sort')).toBe('ascending');
    expect(store.remembered.at(-1)?.sort).toEqual([{ columnId: 'spend', direction: 'asc' }]);
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
