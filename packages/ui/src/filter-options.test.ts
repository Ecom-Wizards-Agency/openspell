import { describe, expect, it } from 'vitest';
import {
  buildCategoricalOptions,
  searchFilterOptions,
  selectAllFilterOptions,
  toggleFilterOption,
} from './filter-options.js';
import type { GridRow } from './rows.js';

const totals = { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0, units: 0 };

function row(id: string, value: string | boolean | null): GridRow {
  return {
    id,
    dimensions: { state: value },
    totals,
    comparison: null,
    currencyCode: 'USD',
  };
}

describe('categorical filter options', () => {
  it('deduplicates case-insensitively, omits nulls and sorts deterministically', () => {
    const options = buildCategoricalOptions(
      [row('1', 'Paused'), row('2', 'enabled'), row('3', 'ENABLED'), row('4', null)],
      'state',
    );
    expect(options).toEqual([
      { value: 'enabled', label: 'enabled' },
      { value: 'Paused', label: 'Paused' },
    ]);
  });

  it('gives booleans useful labels without changing their filter values', () => {
    expect(buildCategoricalOptions([row('1', true), row('2', false)], 'state')).toEqual([
      { value: 'false', label: 'No' },
      { value: 'true', label: 'Yes' },
    ]);
  });

  it('searches all options and Select all unions every match exactly once', () => {
    const options = [
      { value: 'Discovery', label: 'Discovery' },
      { value: 'Profit', label: 'Profit' },
      { value: 'Rank', label: 'Rank' },
    ];
    const matching = searchFilterOptions(options, 'r');
    expect(matching.map((option) => option.value)).toEqual(['Discovery', 'Profit', 'Rank']);
    expect(selectAllFilterOptions(['profit'], matching)).toEqual(['profit', 'Discovery', 'Rank']);
  });

  it('toggles using the same case-insensitive identity as the evaluator', () => {
    expect(toggleFilterOption(['Enabled'], 'enabled')).toEqual([]);
    expect(toggleFilterOption(['Enabled'], 'Paused')).toEqual(['Enabled', 'Paused']);
  });
});
