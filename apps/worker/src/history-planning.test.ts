import { describe, expect, it } from 'vitest';
import { planHistoricalBootstrap, reconcileDailyCoverage } from './history-planning.js';

describe('historical bootstrap planning', () => {
  it('clamps to verified availability and makes newest-first contiguous windows', () => {
    const plan = planHistoricalBootstrap({
      capability: {
        source: 'amazon_unified_reporting',
        reportType: 'syntheticDaily',
        grain: 'daily',
        supported: true,
        availabilityStartDate: '2026-01-03',
        maximumRequestDays: 4,
      },
      desiredStartDate: '2025-12-01',
      latestCompleteDate: '2026-01-12',
    });

    expect(plan).toMatchObject({
      status: 'pending',
      requestedStartDate: '2026-01-03',
      requestedEndDate: '2026-01-12',
      truncatedByAvailability: true,
    });
    expect(plan.windows).toEqual([
      { startDate: '2026-01-09', endDate: '2026-01-12', days: 4, priority: 0 },
      { startDate: '2026-01-05', endDate: '2026-01-08', days: 4, priority: 1 },
      { startDate: '2026-01-03', endDate: '2026-01-04', days: 2, priority: 2 },
    ]);
    expect(plan.windows.every((window) => window.days <= 4)).toBe(true);
  });

  it('does not claim a history source is available before capability evidence exists', () => {
    expect(planHistoricalBootstrap({
      capability: {
        source: 'amazon_unified_reporting',
        reportType: 'syntheticDaily',
        grain: 'daily',
        supported: false,
        availabilityStartDate: null,
        maximumRequestDays: 5,
      },
      desiredStartDate: '2026-01-01',
      latestCompleteDate: '2026-01-10',
    })).toEqual({
      status: 'unavailable',
      requestedStartDate: null,
      requestedEndDate: null,
      availabilityStartDate: null,
      truncatedByAvailability: false,
      windows: [],
    });
  });
});

describe('daily coverage reconciliation', () => {
  it('deduplicates returned dates, retains gaps, and separates loaded from settled', () => {
    expect(reconcileDailyCoverage({
      requestedStartDate: '2026-01-01',
      requestedEndDate: '2026-01-05',
      returnedDates: ['2026-01-05', '2026-01-01', '2026-01-03', '2026-01-03'],
      settledThroughDate: '2026-01-03',
    })).toEqual({
      status: 'partial',
      expectedDates: 5,
      returnedDates: 3,
      earliestReturnedDate: '2026-01-01',
      latestLoadedDate: '2026-01-05',
      latestSettledDate: '2026-01-03',
      missingDates: ['2026-01-02', '2026-01-04'],
    });
  });

  it('rejects dates outside the exact request scope', () => {
    expect(() => reconcileDailyCoverage({
      requestedStartDate: '2026-01-01',
      requestedEndDate: '2026-01-02',
      returnedDates: ['2025-12-31'],
    })).toThrow(/outside the requested window/);
  });
});
