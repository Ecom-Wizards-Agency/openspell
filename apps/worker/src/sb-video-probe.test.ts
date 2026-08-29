import { describe, expect, it, vi } from 'vitest';
import type {
  CreativeAssetProbePage,
  SbAdProbePage,
} from '@wizard-ads/ads-api';
import { parseSbAdsReportProbe } from '@wizard-ads/ads-api';
import type { AdsProfileContext, SbVideoContractProbeClient } from './ads-api.js';
import {
  probeSbVideoContract,
  reconcileSbVideoReportProbe,
  summarizeSbVideoContract,
} from './sb-video-probe.js';

const ASSET_ID = 'amzn1.assetlibrary.asset1.synthetic';
const profile: AdsProfileContext = {
  id: '00000000-0000-4000-8000-000000000001',
  orgId: '00000000-0000-4000-8000-000000000002',
  amazonProfileId: '900000000000001',
  region: 'NA',
  currencyCode: 'USD',
  timezone: 'America/Los_Angeles',
};

function adsPage(overrides: Partial<SbAdProbePage> = {}): SbAdProbePage {
  return {
    sourceRows: 1,
    totalResults: 1,
    nextToken: null,
    items: [{
      adId: '100000000000001',
      campaignId: '200000000000001',
      adGroupId: '300000000000001',
      creativePresent: true,
      creativeVersion: 'version_v1',
      creativeType: 'VIDEO',
      name: 'Synthetic video',
      state: 'ENABLED',
      videoAssets: [{
        referenceId: `${ASSET_ID}:version_v1`,
        assetId: ASSET_ID,
        version: 'version_v1',
        kind: 'asset_library',
      }],
      asins: ['B000000001'],
      raw: {},
    }],
    ...overrides,
  };
}

function assetsPage(overrides: Partial<CreativeAssetProbePage> = {}): CreativeAssetProbePage {
  return {
    sourceRows: 1,
    totalRecords: 1,
    nextToken: null,
    items: [{
      assetId: ASSET_ID,
      version: 'version_v1',
      assetType: 'VIDEO',
      name: 'Synthetic video',
      status: 'ACTIVE',
      contentHash: null,
      defaultUrl: null,
      thumbnailUrl: null,
      raw: {},
    }],
    ...overrides,
  };
}

describe('SB Video contract probe', () => {
  it('returns only reconciled counts when one page proves the identity path', () => {
    const result = summarizeSbVideoContract(adsPage(), assetsPage());

    expect(result).toEqual({
      status: 'ready_for_report_probe',
      ads: {
        sourceRows: 1,
        parsedRows: 1,
        advertisedTotalResults: 1,
        videoRows: 1,
        videoRowsWithAdId: 1,
        singleAssetVideoRows: 1,
        assetReferences: 1,
        distinctAssetReferences: 1,
        assetLibraryReferences: 1,
        legacyMediaReferences: 0,
      },
      assets: {
        sourceRows: 1,
        parsedRows: 1,
        advertisedTotalRecords: 1,
        videoRows: 1,
      },
      reconciliation: {
        matchedDistinctAssets: 1,
        missingDistinctAssets: 0,
        nonVideoDistinctAssets: 0,
      },
      reasons: [],
      persistedRows: 0,
      amazonWriteCalls: 0,
    });
    expect(JSON.stringify(result)).not.toContain(ASSET_ID);
    expect(JSON.stringify(result)).not.toContain(profile.amazonProfileId);
  });

  it('holds when pagination, creative identity, or one-to-one attribution is incomplete', () => {
    const current = adsPage();
    const ad = current.items[0]!;
    const result = summarizeSbVideoContract(
      adsPage({
        nextToken: 'another-page',
        items: [{
          ...ad,
          adId: null,
          videoAssets: [
            ...ad.videoAssets,
            {
              referenceId: `${ASSET_ID}.missing`,
              assetId: `${ASSET_ID}.missing`,
              version: null,
              kind: 'asset_library',
            },
          ],
        }],
      }),
      assetsPage({ nextToken: 'another-page', totalRecords: 4 }),
    );

    expect(result.status).toBe('identity_contract_incomplete');
    expect(result.reasons).toEqual([
      'ads_response_paginated',
      'asset_catalog_count_exceeds_page',
      'asset_response_paginated',
      'missing_ad_id',
      'missing_asset_records',
      'multiple_video_assets',
    ]);
    expect(result.persistedRows).toBe(0);
  });

  it('runs the two reads sequentially and never calls a write capability', async () => {
    const order: string[] = [];
    const client: SbVideoContractProbeClient = {
      probeSbAdsPage: vi.fn(async () => {
        order.push('ads');
        return adsPage();
      }),
      probeCreativeAssetsPage: vi.fn(async () => {
        order.push('assets');
        return assetsPage();
      }),
    };

    const result = await probeSbVideoContract(client, profile);

    expect(order).toEqual(['ads', 'assets']);
    expect(client.probeSbAdsPage).toHaveBeenCalledOnce();
    expect(client.probeCreativeAssetsPage).toHaveBeenCalledOnce();
    expect(result.amazonWriteCalls).toBe(0);
  });

  it('does not declare an empty profile ready for a report probe', () => {
    const result = summarizeSbVideoContract(
      adsPage({ sourceRows: 0, totalResults: 0, items: [] }),
      assetsPage({ sourceRows: 0, totalRecords: 0, items: [] }),
    );
    expect(result).toMatchObject({
      status: 'identity_contract_incomplete',
      reasons: ['no_video_ads'],
      persistedRows: 0,
      amazonWriteCalls: 0,
    });
  });

  it('joins ad-level report rows only by exact ad id and keeps the result sanitized', () => {
    const report = parseSbAdsReportProbe([{
      date: '2026-08-01',
      campaignId: '200000000000001',
      adGroupId: '300000000000001',
      adId: '100000000000001',
      impressions: 100,
      clicks: 4,
      cost: 3.21,
      purchases: 1,
      sales: 20,
      videoFirstQuartileViews: 80,
      videoMidpointViews: 60,
      videoThirdQuartileViews: 40,
      videoCompleteViews: 20,
    }]);

    const result = reconcileSbVideoReportProbe(adsPage(), report);

    expect(result).toEqual({
      status: 'ready_for_persistence_model_review',
      listing: {
        sourceRows: 1,
        parsedRows: 1,
        advertisedTotalResults: 1,
        rowsWithAdId: 1,
        rowsWithoutAdId: 0,
        duplicateAdIds: 0,
      },
      report: {
        sourceRows: 1,
        parsedRows: 1,
        refusedRows: 0,
        rowsWithAdId: 1,
        legacyRowsWithoutAdId: 0,
        duplicateAdDateRows: 0,
      },
      reconciliation: {
        matchedAdRows: 1,
        matchedVideoRows: 1,
        unmatchedAdRows: 0,
        nonVideoRows: 0,
        matchedVideoRowsWithAllQuartiles: 1,
      },
      reasons: [],
      persistedRows: 0,
      amazonWriteCalls: 0,
    });
    expect(JSON.stringify(result)).not.toContain('100000000000001');
    expect(JSON.stringify(result)).not.toContain('3.21');
  });

  it('holds duplicated, legacy, unmatched, and incomplete report evidence', () => {
    const report = parseSbAdsReportProbe([
      {
        date: '2026-08-01', campaignId: '1', adGroupId: '2', adId: '100000000000001',
        videoFirstQuartileViews: 1,
      },
      {
        date: '2026-08-01', campaignId: '1', adGroupId: '2', adId: '100000000000001',
      },
      { date: '2026-08-01', campaignId: '1', adGroupId: '2' },
      { date: '2026-08-01', campaignId: '1', adGroupId: '2', adId: '999' },
      { date: 'not-a-date', campaignId: '1', adGroupId: '2', adId: '998' },
    ]);

    const result = reconcileSbVideoReportProbe(adsPage(), report);

    expect(result.status).toBe('report_contract_incomplete');
    expect(result.reasons).toEqual([
      'duplicate_ad_date_rows',
      'legacy_report_rows',
      'missing_video_metrics',
      'refused_report_rows',
      'unmatched_ad_rows',
    ]);
    expect(result.report).toMatchObject({
      sourceRows: 5,
      parsedRows: 4,
      refusedRows: 1,
      legacyRowsWithoutAdId: 1,
      duplicateAdDateRows: 1,
    });
    expect(result.amazonWriteCalls).toBe(0);
  });

  it('cannot declare readiness from a partial or ambiguous ad listing', () => {
    const basePage = adsPage();
    const ad = basePage.items[0]!;
    const report = parseSbAdsReportProbe([{
      date: '2026-08-01',
      campaignId: ad.campaignId,
      adGroupId: ad.adGroupId,
      adId: ad.adId,
      videoFirstQuartileViews: 4,
      videoMidpointViews: 3,
      videoThirdQuartileViews: 2,
      videoCompleteViews: 1,
    }]);
    const result = reconcileSbVideoReportProbe({
      sourceRows: 4,
      totalResults: 5,
      nextToken: 'next-page',
      items: [ad, { ...ad }, { ...ad, adId: null }],
    }, report);

    expect(result.status).toBe('report_contract_incomplete');
    expect(result.listing).toEqual({
      sourceRows: 4,
      parsedRows: 3,
      advertisedTotalResults: 5,
      rowsWithAdId: 2,
      rowsWithoutAdId: 1,
      duplicateAdIds: 1,
    });
    expect(result.reasons).toEqual(expect.arrayContaining([
      'ad_list_count_mismatch',
      'ad_list_paginated',
      'ad_list_total_exceeds_page',
      'duplicate_ad_ids',
      'listing_rows_without_ad_id',
      'no_matched_video_rows',
      'unmatched_ad_rows',
    ]));
  });
});
