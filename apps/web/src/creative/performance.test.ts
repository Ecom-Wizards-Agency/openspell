import { describe, expect, it } from 'vitest';
import type { CreativePerformanceAsset } from '@wizard-ads/db';
import {
  campaignTypeOptions,
  filterAndSortCreativePerformance,
  summarizeCreativePerformance,
} from './performance';

function asset(overrides: Partial<CreativePerformanceAsset> = {}): CreativePerformanceAsset {
  return {
    assetId: 'asset-video-one',
    attributionState: 'mapped',
    name: 'Opening benefit',
    assetType: 'video',
    thumbnailUrl: null,
    campaignTypes: ['SB'],
    campaignCount: 2,
    adGroupCount: 3,
    adCount: 4,
    placementCount: 5,
    impressions: 1_000,
    clicks: 20,
    ctr: 0.02,
    cost: 40,
    purchases: 4,
    sales: 160,
    acos: 0.25,
    roas: 4,
    videoFirstQuartileViews: 700,
    videoMidpointViews: 500,
    videoThirdQuartileViews: 350,
    videoCompleteViews: 250,
    drilldown: [],
    ...overrides,
  };
}

describe('Creative Performance view model', () => {
  it('counts each authoritative Amazon Asset ID once and keeps unknown video totals honest', () => {
    const summary = summarizeCreativePerformance([
      asset(),
      asset({ assetId: 'asset-video-two', cost: 10, sales: 30, purchases: 1, placementCount: 2 }),
      asset({
        assetId: null,
        attributionState: 'unsupported',
        cost: 3,
        sales: 0,
        purchases: 0,
        placementCount: 1,
        videoCompleteViews: null,
      }),
    ]);

    expect(summary).toEqual({
      mappedAssets: 2,
      placementCount: 8,
      cost: 53,
      sales: 190,
      purchases: 5,
      videoCompleteViews: 500,
      incompleteVideoMetrics: true,
    });
  });

  it('filters by Asset ID, campaign type and explicit attribution state before sorting', () => {
    const rows = [
      asset({ assetId: 'asset-video-low', name: 'Benefit cut', cost: 10 }),
      asset({ assetId: 'asset-video-high', name: 'Proof cut', cost: 80 }),
      asset({
        assetId: null,
        attributionState: 'legacy',
        name: null,
        campaignTypes: ['SB'],
        cost: 100,
      }),
    ];

    const result = filterAndSortCreativePerformance(rows, {
      query: 'asset-video',
      campaignType: 'SB',
      attributionState: 'mapped',
      sort: 'spend_desc',
    });

    expect(result).toHaveLength(2);
    expect(result.map((row) => row.assetId)).toEqual(['asset-video-high', 'asset-video-low']);
    expect(campaignTypeOptions(rows)).toEqual(['SB']);
  });

  it('sorts by creative and campaign type with deterministic creative tie-breaks', () => {
    const rows = [
      asset({ name: 'Zulu', campaignTypes: ['SP'] }),
      asset({ assetId: 'asset-beta', name: 'Beta', campaignTypes: ['SB'] }),
      asset({ assetId: 'asset-alpha', name: 'Alpha', campaignTypes: ['SB'] }),
    ];

    expect(filterAndSortCreativePerformance(rows, {
      query: '',
      campaignType: 'all',
      attributionState: 'all',
      sort: 'creative_asc',
    }).map((row) => row.name)).toEqual(['Alpha', 'Beta', 'Zulu']);

    expect(filterAndSortCreativePerformance(rows, {
      query: '',
      campaignType: 'all',
      attributionState: 'all',
      sort: 'campaign_type_asc',
    }).map((row) => row.name)).toEqual(['Alpha', 'Beta', 'Zulu']);
  });
});
