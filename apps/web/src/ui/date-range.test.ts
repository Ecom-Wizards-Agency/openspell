import { describe, expect, it } from 'vitest';
import { dateRangeHref, dateRangePresets, selectedDateRangeLabel } from './date-range';

describe('date range presets', () => {
  it('ends rolling presets on the last complete day and builds calendar presets', () => {
    const presets = dateRangePresets('2026-08-29');
    expect(presets.find((preset) => preset.id === 'last_14')?.period).toEqual({
      start: '2026-08-15',
      end: '2026-08-28',
    });
    expect(presets.find((preset) => preset.id === 'month_to_date')?.period).toEqual({
      start: '2026-08-01',
      end: '2026-08-28',
    });
    expect(presets.find((preset) => preset.id === 'previous_month')?.period).toEqual({
      start: '2026-07-01',
      end: '2026-07-31',
    });
  });

  it('recognizes presets and labels a custom range with complete dates', () => {
    expect(selectedDateRangeLabel({ start: '2026-07-30', end: '2026-08-28' }, '2026-08-29'))
      .toBe('Last 30 days');
    expect(selectedDateRangeLabel({ start: '2026-07-02', end: '2026-08-11' }, '2026-08-29'))
      .toBe('Jul 2, 2026 – Aug 11, 2026');
  });

  it('preserves route scope while replacing only from and to', () => {
    const scope = {
      profile: 'profile-synthetic',
      entity: 'campaigns',
      from: 'old',
      to: 'old',
    };
    const expected = new URLSearchParams({
      profile: scope.profile,
      entity: scope.entity,
      from: '2026-08-15',
      to: '2026-08-28',
    });
    expect(dateRangeHref('/grid', { start: '2026-08-15', end: '2026-08-28' }, scope))
      .toBe(`/grid?${expected.toString()}`);
  });
});
