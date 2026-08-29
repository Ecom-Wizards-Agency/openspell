import { describe, expect, it } from 'vitest';
import type { NewSpTargetFact } from '@wizard-ads/db';
import type { ParsedFactBatch } from './parsers.js';
import {
  UnsafeSponsoredProductsReport,
  prepareSponsoredProductsReportDates,
  stageParsedReportDates,
} from './report-promotion.js';

const ORG_ID = '63636363-6363-4363-8363-636363636363';
const PROFILE_ID = '64646464-6464-4464-8464-646464646464';
const REQUEST_ID = '65656565-6565-4565-8565-656565656565';

describe('parsed report date staging', () => {
  it('keeps exact per-date counts, including an explicitly empty complete day', () => {
    const batch: ParsedFactBatch = {
      kind: 'sp_target',
      sourceRows: 3,
      skipped: [],
      rows: [fact('2026-08-01', 'target-1'), fact('2026-08-01', 'target-2'), fact('2026-08-02', 'target-3')],
    };
    const staged = stageParsedReportDates({
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      reportType: 'spTargeting',
      source: 'amazon_reporting_v3',
      reportRequestId: REQUEST_ID,
      requestedAt: new Date('2026-08-04T01:00:00Z'),
      observedAt: new Date('2026-08-04T02:00:00Z'),
      attributionWindowDays: 7,
      batch,
      dates: [
        { reportDate: '2026-08-01', sourceRows: 2, parsedRows: 2, refusedRows: 0, eventDateAgeDays: 3 },
        { reportDate: '2026-08-02', sourceRows: 1, parsedRows: 1, refusedRows: 0, eventDateAgeDays: 2 },
        { reportDate: '2026-08-03', sourceRows: 0, parsedRows: 0, refusedRows: 0, eventDateAgeDays: 1 },
      ],
    });

    expect(staged.map((date) => ({
      date: date.reportDate,
      sourceRows: date.sourceRows,
      parsedRows: date.parsedRows,
      refusedRows: date.refusedRows,
      promotedRows: date.promotedRows,
    }))).toEqual([
      { date: '2026-08-01', sourceRows: 2, parsedRows: 2, refusedRows: 0, promotedRows: 2 },
      { date: '2026-08-02', sourceRows: 1, parsedRows: 1, refusedRows: 0, promotedRows: 1 },
      { date: '2026-08-03', sourceRows: 0, parsedRows: 0, refusedRows: 0, promotedRows: 0 },
    ]);
  });

  it('derives a complete profile-local window and retains dates with no activity', () => {
    const batch: ParsedFactBatch = {
      kind: 'sp_target',
      sourceRows: 2,
      skipped: [],
      rows: [fact('2026-08-01', 'target-1'), fact('2026-08-03', 'target-2')],
    };
    const staged = prepareSponsoredProductsReportDates({
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      reportType: 'spTargeting',
      source: 'amazon_reporting_v3',
      reportRequestId: REQUEST_ID,
      requestedAt: new Date('2026-08-04T01:00:00Z'),
      observedAt: new Date('2026-08-04T02:00:00Z'),
      attributionWindowDays: 7,
      profileTimeZone: 'UTC',
      startDate: '2026-08-01',
      endDate: '2026-08-03',
      rawRows: [{ date: '2026-08-01' }, { date: '2026-08-03' }],
      batch,
    });

    expect(staged.map((date) => [date.reportDate, date.sourceRows, date.promotedRows])).toEqual([
      ['2026-08-01', 1, 1],
      ['2026-08-02', 0, 0],
      ['2026-08-03', 1, 1],
    ]);
  });

  it('fails before staging when any source row was refused', () => {
    const batch: ParsedFactBatch = {
      kind: 'sp_target',
      sourceRows: 2,
      skipped: [{ index: 1, reason: 'synthetic refusal' }],
      rows: [fact('2026-08-01', 'target-1')],
    };
    expect(() => prepareSponsoredProductsReportDates({
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      reportType: 'spTargeting',
      source: 'amazon_reporting_v3',
      reportRequestId: REQUEST_ID,
      requestedAt: new Date('2026-08-02T01:00:00Z'),
      observedAt: new Date('2026-08-02T02:00:00Z'),
      attributionWindowDays: 7,
      profileTimeZone: 'UTC',
      startDate: '2026-08-01',
      endDate: '2026-08-01',
      rawRows: [{ date: '2026-08-01' }, { date: '2026-08-01' }],
      batch,
    })).toThrow(UnsafeSponsoredProductsReport);
  });

  it('refuses incomplete source accounting before a date can be promoted', () => {
    const batch: ParsedFactBatch = {
      kind: 'sp_target',
      sourceRows: 2,
      skipped: [{ index: 1, reason: 'synthetic refusal' }],
      rows: [fact('2026-08-01', 'target-1')],
    };
    expect(() => stageParsedReportDates({
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      reportType: 'spTargeting',
      source: 'amazon_reporting_v3',
      reportRequestId: REQUEST_ID,
      requestedAt: new Date('2026-08-02T01:00:00Z'),
      observedAt: new Date('2026-08-02T02:00:00Z'),
      attributionWindowDays: 7,
      batch,
      dates: [
        { reportDate: '2026-08-01', sourceRows: 1, parsedRows: 1, refusedRows: 0, eventDateAgeDays: 1 },
      ],
    })).toThrow(/source rows 1 do not match report total 2/);
  });
});

function fact(date: string, targetId: string): NewSpTargetFact {
  return {
    orgId: ORG_ID,
    profileId: PROFILE_ID,
    date,
    adProduct: 'SP',
    campaignId: 'campaign-synthetic',
    adGroupId: 'ad-group-synthetic',
    targetId,
    targetKind: 'keyword',
    matchType: 'exact',
    impressions: 100,
    clicks: 10,
    cost: 12,
    purchases1d: 1,
    purchases7d: 2,
    purchases14d: 2,
    purchases30d: 2,
    sales1d: 8,
    sales7d: 16,
    sales14d: 16,
    sales30d: 16,
    unitsSold7d: 2,
    topOfSearchImpressionShare: null,
    reportRequestId: REQUEST_ID,
  };
}
