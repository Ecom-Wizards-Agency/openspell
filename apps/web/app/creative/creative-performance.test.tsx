import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CreativePerformanceAsset } from '@wizard-ads/db';
import { CreativePerformanceExplorer } from './creative-performance';

function asset(overrides: Partial<CreativePerformanceAsset> = {}): CreativePerformanceAsset {
  return {
    assetId: 'asset-synthetic-one',
    attributionState: 'mapped',
    name: 'Synthetic opening cut',
    assetType: 'video',
    thumbnailUrl: null,
    campaignTypes: ['SB'],
    mappingProvenances: ['current_sb_ad_snapshot'],
    campaignCount: 2,
    adGroupCount: 3,
    adCount: 4,
    placementCount: 5,
    impressions: 1_000,
    clicks: 25,
    ctr: 0.025,
    cost: 50,
    purchases: 5,
    sales: 200,
    acos: 0.25,
    roas: 4,
    videoFirstQuartileViews: 700,
    videoMidpointViews: 520,
    videoThirdQuartileViews: 400,
    videoCompleteViews: 300,
    drilldown: [],
    ...overrides,
  };
}

describe('CreativePerformanceExplorer', () => {
  it('renders every required asset metric and preserves non-authoritative attribution rows', () => {
    const markup = renderToStaticMarkup(
      <CreativePerformanceExplorer
        currencyCode="USD"
        rows={[
          asset(),
          asset({
            assetId: null,
            attributionState: 'legacy',
            name: null,
            thumbnailUrl: null,
            placementCount: 0,
            videoFirstQuartileViews: null,
            videoMidpointViews: null,
            videoThirdQuartileViews: null,
            videoCompleteViews: null,
          }),
        ]}
      />,
    );

    expect(markup).toContain('2 of 2 creative rows');
    expect(markup).toContain('Synthetic opening cut');
    expect(markup).toContain('asset-synthetic-one');
    expect(markup).toContain('No Amazon Asset ID');
    expect(markup).toContain('Legacy performance');
    expect(markup).toContain('Sponsored Brands');
    expect(markup).toContain('Observed current mapping');
    expect(markup).toContain('Placement not reported');

    for (const label of [
      'Reported placements',
      'Impressions',
      'Clicks',
      'CTR',
      '25%',
      '50%',
      '75%',
      'Complete',
      'Spend',
      'Ad sales',
      'Orders',
      'ACOS',
      'ROAS',
    ]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain('does not write changes to Amazon');
  });
});
