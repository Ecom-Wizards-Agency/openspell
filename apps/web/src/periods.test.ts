import { describe, expect, it } from 'vitest';
import {
  settledComparisonWindows,
  type Period,
} from '../app/_lib/periods.js';

describe('settledComparisonWindows', () => {
  it('clips the default window before the 14-day attribution tail', () => {
    const selected: Period = { start: '2026-07-28', end: '2026-08-26' };
    expect(settledComparisonWindows(selected, '2026-08-27')).toEqual({
      current: { start: '2026-07-28', end: '2026-08-12' },
      comparison: { start: '2026-07-12', end: '2026-07-27' },
      settling: { start: '2026-08-13', end: '2026-08-26' },
    });
  });

  it('keeps an older selected window intact and compares the same number of days', () => {
    expect(
      settledComparisonWindows({ start: '2026-06-01', end: '2026-06-30' }, '2026-08-27'),
    ).toMatchObject({
      current: { start: '2026-06-01', end: '2026-06-30' },
      comparison: { start: '2026-05-02', end: '2026-05-31' },
    });
  });

  it('returns no KPI windows when the whole selection is still settling', () => {
    expect(
      settledComparisonWindows({ start: '2026-08-20', end: '2026-08-26' }, '2026-08-27'),
    ).toMatchObject({ current: null, comparison: null });
  });
});
