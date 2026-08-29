import { describe, expect, it } from 'vitest';
import { reportAccountingLabel } from './sync-status';

describe('report accounting labels', () => {
  it('distinguishes complete partial attribution from silent row loss', () => {
    expect(reportAccountingLabel({
      sourceRows: 3,
      rowsParsed: 2,
      refusedRows: 1,
      promotedRows: 1,
      unpromotedRows: 1,
      rowsLoaded: 1,
      countsMatch: false,
      accountingComplete: true,
    })).toBe(
      'complete attribution accounting: 3 source = 2 parsed + 1 refused; 2 parsed = 1 promoted + 1 unpromoted; 1 canonical',
    );
  });

  it('preserves base-report exact and mismatch labels', () => {
    const base = {
      sourceRows: null,
      rowsParsed: 2,
      refusedRows: null,
      promotedRows: null,
      unpromotedRows: null,
      rowsLoaded: 2,
      accountingComplete: null,
    };
    expect(reportAccountingLabel({ ...base, countsMatch: true })).toBe('yes · exact row counts');
    expect(reportAccountingLabel({ ...base, rowsLoaded: 1, countsMatch: false }))
      .toBe('no · row-count mismatch');
  });
});
