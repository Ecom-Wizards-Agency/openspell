import { describe, expect, it } from 'vitest';
import { parseSbAdsReportProbe } from './sb-ads-report.js';

const BASE = {
  date: '2026-08-01',
  campaignId: '100000000000001',
  adGroupId: '200000000000001',
  adId: '300000000000001',
};

describe('Reporting v3 sbAds probe parser', () => {
  it('preserves explicit zero while keeping absent metrics unavailable', () => {
    const result = parseSbAdsReportProbe([{
      ...BASE,
      impressions: 0,
      clicks: 0,
      cost: 0,
      purchases: 0,
      sales: 0,
      videoFirstQuartileViews: 0,
      videoCompleteViews: 0,
    }]);

    expect(result).toMatchObject({ sourceRows: 1, parsedRows: 1, refusals: [] });
    expect(result.rows[0]).toMatchObject({
      identityState: 'ad_id',
      impressions: 0,
      clicks: 0,
      cost: 0,
      purchases: 0,
      sales: 0,
      videoFirstQuartileViews: 0,
      videoMidpointViews: null,
      videoThirdQuartileViews: null,
      videoCompleteViews: 0,
      viewableImpressions: null,
    });
  });

  it('retains documented legacy rows without inventing an ad id', () => {
    const result = parseSbAdsReportProbe([{ ...BASE, adId: undefined, impressions: 10 }]);
    expect(result.rows[0]).toMatchObject({ adId: null, identityState: 'legacy_no_ad_id' });
    expect(result.parsedRows + result.refusals.length).toBe(result.sourceRows);
  });

  it('counts every malformed source row as a refusal', () => {
    const result = parseSbAdsReportProbe([
      { ...BASE, impressions: 10, clicks: 11 },
      { ...BASE, videoCompleteViews: 1.5 },
      { ...BASE, campaignId: undefined },
      null,
      { ...BASE, adId: { changed: true } },
    ]);

    expect(result).toMatchObject({ sourceRows: 5, parsedRows: 0 });
    expect(result.refusals).toHaveLength(5);
    expect(result.refusals.map((refusal) => refusal.index)).toEqual([0, 1, 2, 3, 4]);
    expect(result.parsedRows + result.refusals.length).toBe(result.sourceRows);
  });

  it('refuses a non-array payload without claiming source rows', () => {
    const result = parseSbAdsReportProbe({ rows: [] });
    expect(result).toEqual({
      sourceRows: 0,
      parsedRows: 0,
      rows: [],
      refusals: [{ index: -1, reason: 'report payload is not an array' }],
    });
  });
});
