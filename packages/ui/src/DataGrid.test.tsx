// @vitest-environment jsdom
/**
 * The end-to-end version of the no-jank property: mount the real grid over the
 * real 50k-row fixture and count the rows that actually reached the DOM.
 *
 * jsdom has no layout, so `@tanstack/react-virtual` is given an explicit
 * `initialRect` -- the one test seam on the component. Everything else here is
 * the production path: the production pipeline, the production column set, the
 * production renderer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { DataGrid } from './DataGrid.js';
import { columnsFor, defaultVisibleColumns } from './columns.js';
import { filterSetOf } from './filter.js';
import { syntheticSearchTermRows } from './fixtures.js';
import { buildGridModel } from './pipeline.js';

const VIEWPORT = { width: 1200, height: 600 };
const ROW_HEIGHT = 30;

// jsdom performs no layout: every element measures 0×0 and has no
// ResizeObserver, so the virtualizer would conclude the viewport is empty and
// render nothing. Give it one viewport-sized box to work against; everything
// downstream of the measurement is the real component.
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver;
// virtual-core sizes the scroller from `offsetWidth`/`offsetHeight`, which jsdom
// reports as 0 for every element.
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get: () => VIEWPORT.width,
});
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get: () => VIEWPORT.height,
});

const available = columnsFor('search_terms');
const visibleIds = defaultVisibleColumns('search_terms');
const visible = visibleIds
  .map((id) => available.find((column) => column.id === id))
  .filter((column): column is NonNullable<typeof column> => column !== undefined);
const groupedVisible = ['campaign_name', 'ad_group_name', 'match_type', 'spend', 'sales', 'acos']
  .map((id) => available.find((column) => column.id === id))
  .filter((column): column is NonNullable<typeof column> => column !== undefined);

function renderGrid(rowCount: number, options: { groupBy?: string[] } = {}) {
  const rows = syntheticSearchTermRows(rowCount, { seed: 20260814 });
  const model = buildGridModel(rows, {
    sort: [{ columnId: 'spend', direction: 'desc' }],
    ...(options.groupBy === undefined ? {} : { groupBy: options.groupBy }),
  });
  const view = render(
    <DataGrid
      model={model}
      columns={visible}
      currencyCode="USD"
      sort={[{ columnId: 'spend', direction: 'desc' }]}
      onSortChange={() => {}}
      height={VIEWPORT.height}
      rowHeight={ROW_HEIGHT}
      initialRect={VIEWPORT}
    />,
  );
  return { model, view };
}

afterEach(cleanup);

describe('DataGrid over 50k rows', () => {
  it('puts a bounded number of rows in the DOM, no matter how many are loaded', () => {
    const small = renderGrid(200);
    const smallRows = screen.getAllByTestId('grid-row').length;
    cleanup();

    const large = renderGrid(50_000);
    const largeRows = screen.getAllByTestId('grid-row').length;

    expect(large.model.rows).toHaveLength(50_000);
    expect(small.model.rows).toHaveLength(200);
    // 250× the data, the same DOM. This is the whole no-pagination bet.
    expect(largeRows).toBe(smallRows);
    expect(largeRows).toBeLessThan(60);
  });

  it('renders the totals row from the filtered set, above the body', () => {
    const { model } = renderGrid(1_000);
    expect(model.totalsRow).not.toBeNull();
    expect(screen.getByText(/^Total · 1,000 rows$/)).toBeTruthy();
  });

  it('prints the honest counts in the footer', () => {
    renderGrid(50_000);
    expect(screen.getByText('50,000 of 50,000 rows')).toBeTruthy();
  });

  it('marks caller-selected rows and paints them with indigo-soft selection', () => {
    const rows = syntheticSearchTermRows(20, { seed: 7 });
    const model = buildGridModel(rows);
    const selectedId = model.rows[0]?.id;
    expect(selectedId).toBeDefined();
    render(
      <DataGrid
        model={model}
        columns={visible}
        currencyCode="USD"
        sort={[]}
        onSortChange={() => {}}
        selectedRowIds={selectedId === undefined ? [] : [selectedId]}
        height={VIEWPORT.height}
        rowHeight={ROW_HEIGHT}
        initialRect={VIEWPORT}
      />,
    );

    const selected = screen.getAllByTestId('grid-row').find(
      (row) => row.getAttribute('aria-selected') === 'true',
    );
    expect(selected).toBeDefined();
    expect(selected?.getAttribute('style')).toContain('var(--wa-indigo-soft');
  });

  it('says out loud that a grouped view recomputed its ratios', () => {
    renderGrid(5_000, { groupBy: ['campaign_name'] });
    expect(
      screen.getByText(/Ratio metrics recomputed from summed bases, never averaged\./),
    ).toBeTruthy();
  });

  it('renders three hierarchy levels with accessible labels and truthful counts', () => {
    const rows = syntheticSearchTermRows(3_597, { seed: 44 });
    const model = buildGridModel(rows, {
      groupBy: ['campaign_name', 'ad_group_name', 'match_type'],
      sort: [{ columnId: 'spend', direction: 'desc' }],
    });
    render(
      <DataGrid
        model={model}
        columns={groupedVisible}
        currencyCode="USD"
        sort={[{ columnId: 'spend', direction: 'desc' }]}
        onSortChange={() => {}}
        height={VIEWPORT.height}
        rowHeight={ROW_HEIGHT}
        initialRect={VIEWPORT}
      />,
    );

    expect(
      screen.getByRole('treegrid', {
        name: 'Results grouped by campaign_name, ad_group_name, match_type',
      }),
    ).toBeTruthy();
    const rendered = screen.getAllByTestId('grid-row');
    expect(rendered.some((row) => row.getAttribute('aria-level') === '1')).toBe(true);
    expect(rendered.some((row) => row.getAttribute('aria-level') === '2')).toBe(true);
    expect(rendered.some((row) => row.getAttribute('aria-level') === '3')).toBe(true);
    expect(rendered.some((row) => row.getAttribute('aria-label')?.startsWith('Grouping level 2 of 3: Ad group '))).toBe(true);
    expect(screen.getByText('Total · 3,597 source rows')).toBeTruthy();
    expect(
      screen.getByText(
        `${model.shown} hierarchy rows · ${model.exported} deepest groups · 3,597 matched source rows of 3,597`,
      ),
    ).toBeTruthy();
  });

  it('collapses every descendant of a parent and restores them without changing model counts', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const rows = syntheticSearchTermRows(120, { seed: 51, campaigns: 1 });
    const model = buildGridModel(rows, {
      groupBy: ['campaign_name', 'ad_group_name', 'match_type'],
      sort: [{ columnId: 'spend', direction: 'desc' }],
    });
    const before = {
      shown: model.shown,
      exported: model.exported,
      matched: model.matched,
      spend: model.totalsRow?.totals.spend,
    };
    render(
      <DataGrid
        model={model}
        columns={groupedVisible}
        currencyCode="USD"
        sort={[{ columnId: 'spend', direction: 'desc' }]}
        onSortChange={() => {}}
        height={VIEWPORT.height}
        rowHeight={ROW_HEIGHT}
        initialRect={VIEWPORT}
      />,
    );

    const root = screen.getAllByTestId('grid-row').find(
      (row) => row.getAttribute('aria-level') === '1',
    );
    expect(root).toBeDefined();
    const collapse = within(root as HTMLElement).getByRole('button', { name: /Collapse Campaign/ });
    expect(collapse.tagName).toBe('BUTTON');
    expect(collapse.getAttribute('type')).toBe('button');
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    expect(root?.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[data-group-level="2"]')).not.toBeNull();
    expect(document.querySelector('[data-group-level="3"]')).not.toBeNull();

    fireEvent.click(collapse);

    const collapsedRoot = screen.getByTestId('grid-row');
    const expand = within(collapsedRoot).getByRole('button', { name: /Expand Campaign/ });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    expect(collapsedRoot.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-group-level="2"]')).toBeNull();
    expect(document.querySelector('[data-group-level="3"]')).toBeNull();
    expect(screen.getByText(
      `1 visible of ${model.shown} hierarchy rows · ${model.exported} deepest groups · 120 matched source rows of 120`,
    )).toBeTruthy();
    expect({
      shown: model.shown,
      exported: model.exported,
      matched: model.matched,
      spend: model.totalsRow?.totals.spend,
    }).toEqual(before);

    fireEvent.click(expand);

    expect(screen.getAllByTestId('grid-row')).toHaveLength(model.shown);
    expect(document.querySelector('[data-group-level="2"]')).not.toBeNull();
    expect(document.querySelector('[data-group-level="3"]')).not.toBeNull();
    const leaf = screen.getAllByTestId('grid-row').find(
      (row) => row.getAttribute('aria-level') === '3',
    );
    expect(leaf).toBeDefined();
    expect(within(leaf as HTMLElement).queryByRole('button', { name: /Collapse|Expand/ })).toBeNull();
  });

  it('clears collapse state when the grouping hierarchy changes', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const rows = syntheticSearchTermRows(120, { seed: 52, campaigns: 1 });
    const original = buildGridModel(rows, {
      groupBy: ['campaign_name', 'ad_group_name', 'match_type'],
    });
    // The root campaign ids are identical in both models; only a grouping-key
    // reset prevents the old collapse state leaking into the new hierarchy.
    const regrouped = buildGridModel(rows, { groupBy: ['campaign_name', 'match_type'] });
    const regroupedColumns = ['campaign_name', 'match_type', 'spend']
      .map((id) => available.find((column) => column.id === id))
      .filter((column): column is NonNullable<typeof column> => column !== undefined);
    const component = (model: typeof original, columns = groupedVisible) => (
      <DataGrid
        model={model}
        columns={columns}
        currencyCode="USD"
        sort={[]}
        onSortChange={() => {}}
        height={VIEWPORT.height}
        rowHeight={ROW_HEIGHT}
        initialRect={VIEWPORT}
      />
    );
    const view = render(component(original));
    fireEvent.click(screen.getByRole('button', { name: /Collapse Campaign/ }));
    expect(screen.getAllByTestId('grid-row')).toHaveLength(1);

    view.rerender(component(regrouped, regroupedColumns));
    view.rerender(component(original));

    expect(screen.getByRole('button', { name: /Collapse Campaign/ }).getAttribute('aria-expanded'))
      .toBe('true');
    expect(screen.getAllByTestId('grid-row')).toHaveLength(original.shown);
  });

  it('marks the sorted column for a screen reader and shows the direction', () => {
    renderGrid(500);
    const header = screen.getByRole('columnheader', { name: 'Spend' });
    expect(header.getAttribute('aria-sort')).toBe('descending');
  });

  it('shows totals beneath sorted additive and ratio metric headers', () => {
    const rows = syntheticSearchTermRows(100, { seed: 23 });
    const sort = [
      { columnId: 'spend', direction: 'desc' as const },
      { columnId: 'acos', direction: 'desc' as const },
    ];
    render(
      <DataGrid
        model={buildGridModel(rows, { sort })}
        columns={visible}
        currencyCode="USD"
        sort={sort}
        onSortChange={() => {}}
        height={VIEWPORT.height}
        rowHeight={ROW_HEIGHT}
        initialRect={VIEWPORT}
      />,
    );

    expect(screen.getByTestId('sorted-column-aggregate-spend').textContent).toMatch(/\$/);
    expect(screen.getByTestId('sorted-column-aggregate-acos').textContent).toMatch(/%/);
  });

  it('toggles sort on a header click, with shift appending a second key', async () => {
    const rows = syntheticSearchTermRows(100, { seed: 3 });
    const onSortChange = vi.fn();
    render(
      <DataGrid
        model={buildGridModel(rows)}
        columns={visible}
        currencyCode="USD"
        sort={[{ columnId: 'spend', direction: 'desc' }]}
        onSortChange={onSortChange}
        height={VIEWPORT.height}
        rowHeight={ROW_HEIGHT}
        initialRect={VIEWPORT}
      />,
    );

    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByRole('columnheader', { name: 'ACOS' }));
    expect(onSortChange).toHaveBeenCalledWith([{ columnId: 'acos', direction: 'desc' }]);

    fireEvent.click(screen.getByRole('columnheader', { name: 'ACOS' }), { shiftKey: true });
    expect(onSortChange).toHaveBeenLastCalledWith([
      { columnId: 'spend', direction: 'desc' },
      { columnId: 'acos', direction: 'desc' },
    ]);
  });

  it('renders money in the profile currency and an absent value as an em dash', () => {
    const rows = syntheticSearchTermRows(3, { seed: 5 });
    // No sales anywhere: ACOS is undefined on every row, and must not read 0%.
    const noSales = rows.map((row) => ({ ...row, totals: { ...row.totals, sales: 0, orders: 0 } }));
    render(
      <DataGrid
        model={buildGridModel(noSales)}
        columns={visible}
        currencyCode="EUR"
        sort={[]}
        onSortChange={() => {}}
        height={VIEWPORT.height}
        rowHeight={ROW_HEIGHT}
        initialRect={VIEWPORT}
      />,
    );

    const body = screen.getAllByTestId('grid-row')[0] as HTMLElement;
    expect(within(body).getAllByText('—').length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('€');
  });

  it('renders a suggested-bid median with its low–high range beneath it', () => {
    const targetColumns = columnsFor('targets').filter((column) => column.id === 'suggested_bid');
    const [base] = syntheticSearchTermRows(1, { seed: 48 });
    const target = {
      ...base,
      id: 'target-1',
      dimensions: {
        ...(base?.dimensions ?? {}),
        suggested_bid: 0.9,
        suggested_bid_low: 0.7,
        suggested_bid_high: 1.2,
      },
    } as NonNullable<typeof base>;
    render(
      <DataGrid
        model={buildGridModel([target])}
        columns={targetColumns}
        currencyCode="USD"
        sort={[]}
        onSortChange={() => {}}
        height={VIEWPORT.height}
        rowHeight={42}
        initialRect={VIEWPORT}
      />,
    );

    const cell = within(screen.getByTestId('grid-row')).getByTestId('suggested-bid-cell');
    expect(cell.textContent).toContain('$0.90');
    expect(cell.textContent).toContain('$0.70 – $1.20');
  });

  it('says nothing matched rather than showing an empty frame', () => {
    const rows = syntheticSearchTermRows(500, { seed: 6 });
    const model = buildGridModel(rows, {
      filter: filterSetOf({ key: 'CLICKS', conditions: [{ operator: '>', values: ['999999'] }] }),
    });
    render(
      <DataGrid
        model={model}
        columns={visible}
        currencyCode="USD"
        sort={[]}
        onSortChange={() => {}}
        height={VIEWPORT.height}
        rowHeight={ROW_HEIGHT}
        initialRect={VIEWPORT}
      />,
    );
    expect(screen.getByText('No rows match this filter.')).toBeTruthy();
    expect(screen.getByText('0 of 500 rows')).toBeTruthy();
  });
});
