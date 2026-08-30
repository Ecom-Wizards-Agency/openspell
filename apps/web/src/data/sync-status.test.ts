import { describe, expect, it } from 'vitest';
import { reportAccountingLabel, syncFailureLabel } from './sync-status';

describe('sync failure labels', () => {
  it('never returns database statements or bind parameters', () => {
    const raw = [
      'Failed query: insert into fact_profile_daily (profile_id) values ($1)',
      'params: 00000000-0000-0000-0000-000000000001,private-value',
    ].join('\n');

    const label = syncFailureLabel(raw);

    expect(label).toBe('The data load failed before promotion. Review the private worker log.');
    expect(label).not.toContain('insert into');
    expect(label).not.toContain('private-value');
  });

  it('uses an allowlist of actionable provider categories', () => {
    expect(syncFailureLabel('HTTP 429: Too Many Requests')).toBe(
      'Amazon rate limit reached. The worker will retry within its retry policy.',
    );
    expect(syncFailureLabel('invalid_grant while refreshing token')).toBe(
      'Amazon authorization failed. Reconnect the integration before retrying.',
    );
    expect(syncFailureLabel('source row-count mismatch')).toBe(
      'Row-count reconciliation failed. The affected report was not promoted.',
    );
    expect(syncFailureLabel('opaque provider failure request-id=private')).toBe(
      'Sync failed. Review the private worker log for the underlying cause.',
    );
    expect(syncFailureLabel(null)).toBeNull();
  });
});

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
