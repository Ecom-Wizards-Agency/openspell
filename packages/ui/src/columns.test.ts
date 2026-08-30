import { describe, expect, it } from 'vitest';
import { columnsFor, defaultVisibleColumns, filterKindForColumn } from './columns.js';

describe('target bid-fidelity columns', () => {
  it('offers the latest bid corridor, position and RPC classification', () => {
    const columns = columnsFor('targets');
    expect(columns.find((column) => column.id === 'suggested_bid')).toMatchObject({
      scale: 'money',
      cell: 'suggested_bid',
    });
    expect(columns.find((column) => column.id === 'max_potential_cpc')?.scale).toBe('money');
    expect(columns.find((column) => column.id === 'bid_corridor_position')?.scale).toBe('text');
    expect(columns.find((column) => column.id === 'diff_from_suggested_bid')?.scale).toBe('money');
    expect(columns.find((column) => column.id === 'rpc_category')?.scale).toBe('text');
  });

  it('puts the fidelity quick wins in the default targets view', () => {
    const visible = defaultVisibleColumns('targets');
    expect(visible).toEqual(
      expect.arrayContaining([
        'suggested_bid',
        'bid_corridor_position',
        'max_potential_cpc',
        'diff_from_suggested_bid',
        'rpc_category',
      ]),
    );
  });
});

describe('filter control metadata', () => {
  it('keeps identifiers and free-form terms textual, enumerations categorical and metrics numeric', () => {
    const searchTerms = columnsFor('search_terms');
    expect(filterKindForColumn(searchTerms.find((column) => column.id === 'search_term')!)).toBe('text');
    expect(filterKindForColumn(searchTerms.find((column) => column.id === 'match_type')!)).toBe('categorical');
    expect(filterKindForColumn(searchTerms.find((column) => column.id === 'campaign_name')!)).toBe('categorical');
    expect(filterKindForColumn(searchTerms.find((column) => column.id === 'spend')!)).toBe('numeric');
  });

  it('marks every entity state/ad-type enumeration as categorical', () => {
    for (const level of ['campaigns', 'ad_groups', 'targets', 'search_terms', 'placements'] as const) {
      for (const column of columnsFor(level).filter((candidate) =>
        candidate.id.endsWith('_state') || candidate.id === 'ad_product')) {
        expect(filterKindForColumn(column), `${level}.${column.id}`).toBe('categorical');
      }
    }
  });
});
