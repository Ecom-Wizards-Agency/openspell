import { describe, expect, it } from 'vitest';
import { MAX_REPORT_RANGE_DAYS } from '@wizard-ads/ads-api';
import { defaultSchedules } from './schedules.js';

describe('defaultSchedules comparison coverage', () => {
  it('uses two contiguous legal-size blocks for current and comparison facts', () => {
    const reports = defaultSchedules(['spCampaigns']).filter(
      (schedule) => schedule.jobType === 'report.request',
    );
    expect(reports.map((schedule) => ({
      variant: schedule.variant,
      lookbackDays: schedule.lookbackDays,
      windowOffsetDays: schedule.windowOffsetDays,
    }))).toEqual([
      { variant: 'default', lookbackDays: 3, windowOffsetDays: 0 },
      { variant: 'restatement', lookbackDays: 32, windowOffsetDays: 0 },
      { variant: 'comparison', lookbackDays: 32, windowOffsetDays: 32 },
    ]);
    for (const schedule of reports) {
      expect((schedule.lookbackDays ?? 1) - 1).toBeLessThanOrEqual(MAX_REPORT_RANGE_DAYS);
    }
  });
});
