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

  it('says out loud that a grouped view recomputed its ratios', () => {
    renderGrid(5_000, { groupBy: ['campaign_name'] });
    expect(
      screen.getByText(/Ratio metrics recomputed from summed bases, never averaged\./),
    ).toBeTruthy();
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
