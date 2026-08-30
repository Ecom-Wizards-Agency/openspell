import { describe, expect, it } from 'vitest';
import {
  periodFromParamsThroughToday,
  settledComparisonWindows,
  todayIsoInTimeZone,
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

describe('current-day evidence periods', () => {
  it('defaults to a rolling window through the profile current day', () => {
    expect(periodFromParamsThroughToday({}, '2026-08-29', 14)).toEqual({
      start: '2026-08-16',
      end: '2026-08-29',
    });
  });

  it('preserves a valid explicit range and repairs invalid parameters', () => {
    expect(periodFromParamsThroughToday(
      { from: '2026-08-01', to: '2026-08-14' },
      '2026-08-29',
    )).toEqual({ start: '2026-08-01', end: '2026-08-14' });
    expect(periodFromParamsThroughToday(
      { from: '2026-08-30', to: '2026-08-01' },
      '2026-08-29',
      7,
    )).toEqual({ start: '2026-08-23', end: '2026-08-29' });
  });

  it('derives today at the profile boundary rather than the server boundary', () => {
    const now = new Date('2026-08-29T18:30:00.000Z');
    expect(todayIsoInTimeZone('America/Los_Angeles', now)).toBe('2026-08-29');
    expect(todayIsoInTimeZone('Asia/Bangkok', now)).toBe('2026-08-30');
  });
});
