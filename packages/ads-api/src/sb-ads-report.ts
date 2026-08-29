/** Strict, non-persisting parser for Amazon Reporting v3 `sbAds` rows. */
import { IsoDate, type AmazonId } from '@wizard-ads/shared';
import { isRecord, readId, readNumber } from './read.js';

export interface SbAdsReportProbeRow {
  date: string;
  campaignId: AmazonId;
  adGroupId: AmazonId;
  adId: AmazonId | null;
  identityState: 'ad_id' | 'legacy_no_ad_id';
  impressions: number | null;
  clicks: number | null;
  cost: number | null;
  purchases: number | null;
  sales: number | null;
  unitsSold: number | null;
  videoFirstQuartileViews: number | null;
  videoMidpointViews: number | null;
  videoThirdQuartileViews: number | null;
  videoCompleteViews: number | null;
  viewableImpressions: number | null;
}

export interface SbAdsReportProbeRefusal {
  index: number;
  reason: string;
}

export interface SbAdsReportProbeParseResult {
  sourceRows: number;
  parsedRows: number;
  rows: SbAdsReportProbeRow[];
  refusals: SbAdsReportProbeRefusal[];
}

const COUNT_COLUMNS = [
  'impressions',
  'clicks',
  'purchases',
  'unitsSold',
  'videoFirstQuartileViews',
  'videoMidpointViews',
  'videoThirdQuartileViews',
  'videoCompleteViews',
  'viewableImpressions',
] as const;

const MONEY_COLUMNS = ['cost', 'sales'] as const;

function optionalMetric(
  row: Record<string, unknown>,
  key: string,
  integer: boolean,
): number | null | 'invalid' {
  if (row[key] === undefined || row[key] === null) return null;
  const value = readNumber(row, key);
  if (value === null || value < 0 || (integer && !Number.isInteger(value))) return 'invalid';
  return value;
}

/**
 * Keep absent metrics unavailable rather than silently turning them into zero.
 * Every source row is either parsed or appears once in `refusals`.
 */
export function parseSbAdsReportProbe(raw: unknown): SbAdsReportProbeParseResult {
  if (!Array.isArray(raw)) {
    return {
      sourceRows: 0,
      parsedRows: 0,
      rows: [],
      refusals: [{ index: -1, reason: 'report payload is not an array' }],
    };
  }
  const rows: SbAdsReportProbeRow[] = [];
  const refusals: SbAdsReportProbeRefusal[] = [];
  raw.forEach((value, index) => {
    if (!isRecord(value)) {
      refusals.push({ index, reason: 'row is not an object' });
      return;
    }
    const dateResult = IsoDate.safeParse(value['date']);
    const campaignId = readId(value, 'campaignId');
    const adGroupId = readId(value, 'adGroupId');
    if (!dateResult.success || campaignId === null || adGroupId === null) {
      refusals.push({ index, reason: 'row is missing date, campaignId, or adGroupId' });
      return;
    }

    const metrics = new Map<string, number | null>();
    for (const key of COUNT_COLUMNS) {
      const metric = optionalMetric(value, key, true);
      if (metric === 'invalid') {
        refusals.push({ index, reason: `row has an invalid ${key}` });
        return;
      }
      metrics.set(key, metric);
    }
    for (const key of MONEY_COLUMNS) {
      const metric = optionalMetric(value, key, false);
      if (metric === 'invalid') {
        refusals.push({ index, reason: `row has an invalid ${key}` });
        return;
      }
      metrics.set(key, metric);
    }
    const impressions = metrics.get('impressions') ?? null;
    const clicks = metrics.get('clicks') ?? null;
    if (impressions !== null && clicks !== null && clicks > impressions) {
      refusals.push({ index, reason: 'row has more clicks than impressions' });
      return;
    }
    const adId = value['adId'] === undefined ? null : readId(value, 'adId');
    if (value['adId'] !== undefined && adId === null) {
      refusals.push({ index, reason: 'row has an invalid adId' });
      return;
    }
    rows.push({
      date: dateResult.data,
      campaignId,
      adGroupId,
      adId,
      identityState: adId === null ? 'legacy_no_ad_id' : 'ad_id',
      impressions,
      clicks,
      cost: metrics.get('cost') ?? null,
      purchases: metrics.get('purchases') ?? null,
      sales: metrics.get('sales') ?? null,
      unitsSold: metrics.get('unitsSold') ?? null,
      videoFirstQuartileViews: metrics.get('videoFirstQuartileViews') ?? null,
      videoMidpointViews: metrics.get('videoMidpointViews') ?? null,
      videoThirdQuartileViews: metrics.get('videoThirdQuartileViews') ?? null,
      videoCompleteViews: metrics.get('videoCompleteViews') ?? null,
      viewableImpressions: metrics.get('viewableImpressions') ?? null,
    });
  });
  return { sourceRows: raw.length, parsedRows: rows.length, rows, refusals };
}
