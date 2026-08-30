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
import { describeFilter, GridToolbar } from './GridToolbar.js';
import { columnsFor, defaultVisibleColumns } from './columns.js';
import { syntheticSearchTermRows } from './fixtures.js';
import { buildGridModel } from './pipeline.js';
import type { FilterSet } from './filter.js';

const available = columnsFor('search_terms');
const model = buildGridModel(syntheticSearchTermRows(20, { seed: 2 }));

function renderToolbar(
  onFilterChange = vi.fn(),
  onExport?: () => void,
  options: { groupBy?: readonly string[]; onGroupByChange?: (levels: string[]) => void } = {},
) {
  render(
    <GridToolbar
      entity="search_terms"
      available={available}
      visible={defaultVisibleColumns('search_terms')}
      onVisibleChange={() => {}}
      filter={{ groups: [] }}
      onFilterChange={onFilterChange}
      groupBy={options.groupBy ?? []}
      onGroupByChange={options.onGroupByChange ?? (() => {})}
      model={model}
      optionRows={model.rows}
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
    expect([...operator.options].find((option) => option.value === 'LIKE')?.text).toBe('contains');
    expect([...operator.options].map((option) => option.value)).not.toContain('>');
    expect(screen.getByPlaceholderText('Search term')).toBeTruthy();

    fireEvent.change(column, { target: { value: 'ACOS' } });
    expect([...operator.options].map((option) => option.value)).toContain('>');
    expect([...operator.options].find((option) => option.value === '=')?.text).toBe('equals');
    expect([...operator.options].map((option) => option.value)).not.toContain('LIKE');
    expect(screen.getByPlaceholderText('ACOS')).toBeTruthy();
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

  it('offers exact multi-select operators for categorical columns only', () => {
    renderToolbar();
    const column = screen.getByLabelText('Filter column');
    const operator = screen.getByLabelText('Filter operator') as HTMLSelectElement;

    fireEvent.change(column, { target: { value: 'MATCH_TYPE' } });
    expect([...operator.options].map((option) => option.value)).toEqual(['IN', 'NOT_IN']);
    expect(screen.getByLabelText('Filter values')).toBeTruthy();
    expect(screen.queryByLabelText('Filter value')).toBeNull();

    fireEvent.change(column, { target: { value: 'SPEND' } });
    expect([...operator.options].map((option) => option.value)).not.toContain('IN');
    expect(screen.getByLabelText('Filter value')).toBeTruthy();
  });

  it('searches, selects all matching values, clears, and emits an exact multi-value filter', () => {
    const onFilterChange = renderToolbar();
    fireEvent.change(screen.getByLabelText('Filter column'), { target: { value: 'MATCH_TYPE' } });
    fireEvent.click(screen.getByLabelText('Filter values'));

    fireEvent.change(screen.getByLabelText('Search filter values'), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: /Select all/ }));
    expect(screen.getByLabelText('Filter values').textContent).toContain('3 selected');

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByLabelText('Filter values').textContent).toContain('Choose match');

    fireEvent.click(screen.getByLabelText('exact'));
    fireEvent.click(screen.getByLabelText('phrase'));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    const emitted = onFilterChange.mock.calls[0]?.[0] as FilterSet;
    expect(emitted.groups[0]?.filters[0]).toEqual({
      key: 'MATCH_TYPE',
      conditions: [{ operator: 'IN', values: ['exact', 'phrase'] }],
    });
    expect(buildGridModel(model.rows, { filter: emitted }).matched).toBeGreaterThan(0);
  });

  it('moves focus into the value picker and returns it to the trigger on Escape', () => {
    renderToolbar();
    fireEvent.change(screen.getByLabelText('Filter column'), { target: { value: 'MATCH_TYPE' } });
    const trigger = screen.getByLabelText('Filter values');
    fireEvent.click(trigger);

    const search = screen.getByLabelText('Search filter values');
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Match values' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps options that another active filter hid from the model', () => {
    const allRows = model.rows;
    const filteredModel = buildGridModel(allRows, {
      filter: {
        groups: [{ filters: [{ key: 'MATCH_TYPE', conditions: [{ operator: 'IN', values: ['exact'] }] }] }],
      },
    });
    render(
      <GridToolbar
        entity="search_terms"
        available={available}
        visible={defaultVisibleColumns('search_terms')}
        onVisibleChange={() => {}}
        filter={{ groups: [] }}
        onFilterChange={() => {}}
        groupBy={[]}
        onGroupByChange={() => {}}
        model={filteredModel}
        optionRows={allRows}
      />,
    );
    fireEvent.change(screen.getByLabelText('Filter column'), { target: { value: 'MATCH_TYPE' } });
    fireEvent.click(screen.getByLabelText('Filter values'));
    expect(screen.getByLabelText('exact')).toBeTruthy();
    expect(screen.getByLabelText('phrase')).toBeTruthy();
    expect(screen.getByLabelText('broad')).toBeTruthy();
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
    expect(describeFilter(filter as NonNullable<typeof filter>, available)).toBe(
      'Search term contains widget',
    );
  });

  it('refuses to add a filter with no column or no value', () => {
    const onFilterChange = renderToolbar();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.change(screen.getByLabelText('Filter value'), { target: { value: 'widget' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onFilterChange).not.toHaveBeenCalled();
  });

  it('adds only unused dimensions as ordered grouping levels', () => {
    const onGroupByChange = vi.fn();
    renderToolbar(vi.fn(), undefined, {
      groupBy: ['campaign_name', 'ad_group_name'],
      onGroupByChange,
    });
    const add = screen.getByLabelText('Add grouping level') as HTMLSelectElement;
    expect([...add.options].some((option) => option.value === 'campaign_name')).toBe(false);
    expect([...add.options].some((option) => option.value === 'ad_group_name')).toBe(false);

    fireEvent.change(add, { target: { value: 'match_type' } });
    expect(onGroupByChange).toHaveBeenCalledWith([
      'campaign_name',
      'ad_group_name',
      'match_type',
    ]);
  });

  it('shows accessible move and remove controls for every grouping level', () => {
    const onGroupByChange = vi.fn();
    renderToolbar(vi.fn(), undefined, {
      groupBy: ['campaign_name', 'ad_group_name', 'match_type'],
      onGroupByChange,
    });

    expect(screen.getByRole('list', { name: 'Ordered grouping levels' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move Ad group up' }));
    expect(onGroupByChange).toHaveBeenCalledWith([
      'ad_group_name',
      'campaign_name',
      'match_type',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Remove grouping level Match' }));
    expect(onGroupByChange).toHaveBeenLastCalledWith(['campaign_name', 'ad_group_name']);
    expect(screen.getByRole('button', { name: 'Move Campaign up' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Move Match down' }).hasAttribute('disabled')).toBe(true);
  });

  it('states that a grouped export contains deepest groups, not hierarchy rows', () => {
    const groupedModel = buildGridModel(syntheticSearchTermRows(100, { seed: 14 }), {
      groupBy: ['campaign_name', 'ad_group_name', 'match_type'],
    });
    render(
      <GridToolbar
        entity="search_terms"
        available={available}
        visible={defaultVisibleColumns('search_terms')}
        onVisibleChange={() => {}}
        filter={{ groups: [] }}
        onFilterChange={() => {}}
        groupBy={groupedModel.groupBy}
        onGroupByChange={() => {}}
        model={groupedModel}
        optionRows={groupedModel.rows}
        onExport={() => {}}
      />,
    );
    expect(
      screen.getByRole('button', { name: `Export CSV (${groupedModel.exported} deepest groups)` }),
    ).toBeTruthy();
  });
});
