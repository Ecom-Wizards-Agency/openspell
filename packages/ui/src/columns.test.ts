import { describe, expect, it } from 'vitest';
import { columnsFor, defaultVisibleColumns } from './columns.js';

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
