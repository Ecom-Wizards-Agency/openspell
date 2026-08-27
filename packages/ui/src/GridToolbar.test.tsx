// @vitest-environment jsdom
/**
 * The toolbar's one non-obvious invariant: it can never emit a filter it would
 * not accept back.
 *
 * The bug this exists to prevent was found by driving the real UI. Selecting a
 * text column left `draftOperator` holding `>` from a previous numeric column;
 * the `<select>` rendered `LIKE` because `>` was not among its options, and the
 * "Add" button then submitted `SEARCH_TERM > perf term 99`, which threw out of
 * a render and blanked the grid. Two things had to change and both are asserted
 * here: the operator is coerced when the column changes, and what the control
 * shows is what the state holds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GridToolbar } from './GridToolbar.js';
import { columnsFor, defaultVisibleColumns } from './columns.js';
import { syntheticSearchTermRows } from './fixtures.js';
import { buildGridModel } from './pipeline.js';
import type { FilterSet } from './filter.js';

const available = columnsFor('search_terms');
const model = buildGridModel(syntheticSearchTermRows(20, { seed: 2 }));

function renderToolbar(onFilterChange = vi.fn(), onExport?: () => void) {
  render(
    <GridToolbar
      entity="search_terms"
      available={available}
      visible={defaultVisibleColumns('search_terms')}
      onVisibleChange={() => {}}
      filter={{ groups: [] }}
      onFilterChange={onFilterChange}
      groupBy={[]}
      onGroupByChange={() => {}}
      model={model}
      {...(onExport === undefined ? {} : { onExport })}
    />,
  );
  return onFilterChange;
}

afterEach(cleanup);

describe('GridToolbar filter draft', () => {
  it('separates filters from right-aligned table controls and makes export primary', () => {
    renderToolbar(vi.fn(), vi.fn());
    const filterRow = document.querySelector('[data-toolbar-row="filters"]');
    const controlsRow = document.querySelector('[data-toolbar-row="table-controls"]');
    const exportButton = screen.getByRole('button', { name: /Export CSV/ });

    expect(filterRow?.contains(screen.getByLabelText('Filter column'))).toBe(true);
    expect(controlsRow?.contains(exportButton)).toBe(true);
    expect(exportButton.getAttribute('style')).toContain('var(--wa-accent-grad');
  });

  it('offers text operators for a text column and numeric ones for a metric', () => {
    renderToolbar();
    const column = screen.getByLabelText('Filter column');
    const operator = screen.getByLabelText('Filter operator') as HTMLSelectElement;

    fireEvent.change(column, { target: { value: 'SEARCH_TERM' } });
    expect([...operator.options].map((option) => option.value)).toContain('LIKE');
    expect([...operator.options].map((option) => option.value)).not.toContain('>');

    fireEvent.change(column, { target: { value: 'ACOS' } });
    expect([...operator.options].map((option) => option.value)).toContain('>');
    expect([...operator.options].map((option) => option.value)).not.toContain('LIKE');
  });

  it('coerces the draft operator when the column type changes', () => {
    renderToolbar();
    const column = screen.getByLabelText('Filter column');
    const operator = screen.getByLabelText('Filter operator') as HTMLSelectElement;

    fireEvent.change(column, { target: { value: 'ACOS' } });
    fireEvent.change(operator, { target: { value: '>' } });
    expect(operator.value).toBe('>');

    // Switching to a text column must not leave `>` in the state behind a
    // control that is displaying `LIKE`.
    fireEvent.change(column, { target: { value: 'SEARCH_TERM' } });
    expect(operator.value).toBe('LIKE');
  });

  it('emits a filter the evaluator accepts, after that switch', () => {
    const onFilterChange = renderToolbar();
    fireEvent.change(screen.getByLabelText('Filter column'), { target: { value: 'ACOS' } });
    fireEvent.change(screen.getByLabelText('Filter operator'), { target: { value: '>' } });
    fireEvent.change(screen.getByLabelText('Filter column'), { target: { value: 'SEARCH_TERM' } });
    fireEvent.change(screen.getByLabelText('Filter value'), { target: { value: 'widget' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    const emitted = onFilterChange.mock.calls[0]?.[0] as FilterSet;
    const filter = emitted.groups[0]?.filters[0];
    expect(filter?.key).toBe('SEARCH_TERM');
    expect(filter?.conditions[0]?.operator).toBe('LIKE');
    // And it survives the round trip it previously died on.
    expect(() => buildGridModel(model.rows, { filter: emitted })).not.toThrow();
  });

  it('refuses to add a filter with no column or no value', () => {
    const onFilterChange = renderToolbar();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.change(screen.getByLabelText('Filter value'), { target: { value: 'widget' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onFilterChange).not.toHaveBeenCalled();
  });
});
