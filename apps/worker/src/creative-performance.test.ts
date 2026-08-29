import { describe, expect, it } from 'vitest';
import type {
  AdCreativeAssetMapping,
  CreativeAsset,
  CreativeDailyFact,
} from '@wizard-ads/shared';
import {
  CreativePerformanceInputError,
  creativeMappingSourceKey,
  ingestCreativePerformanceBatch,
  stageCreativePerformanceBatch,
  type CreativePerformanceStore,
} from './creative-performance.js';

const ORG_ID = '58585858-5858-4858-8858-585858585858';
const PROFILE_ID = '59595959-5959-4959-8959-595959595959';

describe('SB Video creative staging', () => {
  it('keeps two assets in one ad group separate at the ad grain', () => {
    const firstMapping = mapping({ adId: 'ad-one', creativeId: 'creative-one', assetId: 'asset-one' });
    const secondMapping = mapping({ adId: 'ad-two', creativeId: 'creative-two', assetId: 'asset-two' });
    const staged = stageCreativePerformanceBatch({
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      assets: [asset('asset-one'), asset('asset-two')],
      mappings: [firstMapping, secondMapping],
      facts: [
        fact({ adId: 'ad-one', creativeId: 'creative-one', assetId: 'asset-one', cost: 4 }),
        fact({ adId: 'ad-two', creativeId: 'creative-two', assetId: 'asset-two', cost: 7 }),
      ],
    });

    expect(staged.refusals).toEqual([]);
    expect(staged.writeBatch.facts.map((row) => [row.adId, row.assetId, row.cost])).toEqual([
      ['ad-one', 'asset-one', 4],
      ['ad-two', 'asset-two', 7],
    ]);
    expect(staged.counts).toEqual({
      sourceAssets: 2,
      parsedRows: 2,
      mappedPlacements: 2,
      unsupportedRows: 0,
      refusedRows: 0,
      upserts: 0,
    });
  });

  it('refuses every candidate instead of choosing one asset for an ambiguous ad/creative mapping', () => {
    const common = { adId: 'ad-one', creativeId: 'creative-one' };
    const staged = stageCreativePerformanceBatch({
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      assets: [asset('asset-one'), asset('asset-two')],
      mappings: [
        mapping({ ...common, assetId: 'asset-one' }),
        mapping({ ...common, assetId: 'asset-two' }),
      ],
      facts: [fact({ ...common, assetId: 'asset-one' })],
    });

    expect(staged.writeBatch.mappings).toHaveLength(0);
    expect(staged.writeBatch.facts).toHaveLength(0);
    expect(staged.refusals.filter((row) => row.source === 'mapping')).toHaveLength(2);
    expect(staged.refusals.find((row) => row.source === 'fact')?.reason).toMatch(/no explicit/);
  });

  it('retains an explicit ambiguous row without attaching it to an asset', () => {
    const ambiguousMapping = mapping({
      creativeId: null,
      assetId: null,
      attributionState: 'ambiguous',
    });
    const staged = stageCreativePerformanceBatch({
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      assets: [],
      mappings: [ambiguousMapping],
      facts: [fact({ creativeId: null, assetId: null, attributionState: 'ambiguous' })],
    });

    expect(staged.refusals).toEqual([]);
    expect(staged.writeBatch.facts[0]).toMatchObject({
      attributionState: 'ambiguous',
      assetId: null,
    });
    expect(staged.counts.unsupportedRows).toBe(1);
  });

  it('refuses duplicated ad metrics across different creative IDs', () => {
    const staged = stageCreativePerformanceBatch({
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      assets: [asset('asset-one'), asset('asset-two')],
      mappings: [
        mapping({ creativeId: 'creative-one', assetId: 'asset-one' }),
        mapping({ creativeId: 'creative-two', assetId: 'asset-two' }),
      ],
      facts: [
        fact({ creativeId: 'creative-one', assetId: 'asset-one' }),
        fact({ creativeId: 'creative-two', assetId: 'asset-two' }),
      ],
    });

    expect(staged.writeBatch.facts).toHaveLength(0);
    expect(staged.refusals.filter((row) => row.source === 'fact')).toHaveLength(2);
    expect(staged.refusals[0]?.reason).toMatch(/multiple creatives/);
  });

  it('counts malformed, cross-product and non-video source rows as refusals', () => {
    const staged = stageCreativePerformanceBatch({
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      assets: [asset('asset-one'), asset('asset-image', { assetType: 'image' }), { invalid: true }],
      mappings: [mapping(), mapping({ adProduct: 'SP' })],
      facts: [fact(), { invalid: true }],
    });

    expect(staged.writeBatch.assets).toHaveLength(1);
    expect(staged.writeBatch.mappings).toHaveLength(1);
    expect(staged.writeBatch.facts).toHaveLength(1);
    expect(staged.counts).toMatchObject({
      sourceAssets: 3,
      parsedRows: 1,
      mappedPlacements: 1,
      refusedRows: 4,
    });
  });

  it('uses a stable source key across an observed asset revision', () => {
    const before = mapping({ assetId: 'asset-one' });
    const after = mapping({
      assetId: 'asset-two',
      creativeVersion: 'version_v2',
      observedAt: '2026-08-29T02:00:00Z',
    });
    expect(creativeMappingSourceKey(before)).toBe(creativeMappingSourceKey(after));
  });
});

describe('SB Video creative ingestion', () => {
  it('publishes reconciled upsert counts from the store', async () => {
    const store: CreativePerformanceStore = {
      persist: async (batch) => ({
        assetsUpserted: batch.assets.length,
        mappingsUpserted: batch.mappings.length,
        factsUpserted: batch.facts.length,
        totalUpserts: batch.assets.length + batch.mappings.length + batch.facts.length,
        assetsReadBack: batch.assets.length,
        mappingsReadBack: batch.mappings.length,
        factsReadBack: batch.facts.length,
        snapshotsUpserted: batch.snapshot === undefined ? 0 : 1,
        snapshotsReadBack: batch.snapshot === undefined ? 0 : 1,
      }),
    };
    const result = await ingestCreativePerformanceBatch(store, {
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      assets: [asset('asset-one')],
      mappings: [mapping()],
      facts: [fact()],
    });
    expect(result.counts.upserts).toBe(3);
    expect(result.persistence).toMatchObject({
      assetsReadBack: 1,
      mappingsReadBack: 1,
      factsReadBack: 1,
    });
  });

  it('fails when a store loses an offered upsert', async () => {
    const store: CreativePerformanceStore = {
      persist: async () => ({
        assetsUpserted: 1,
        mappingsUpserted: 1,
        factsUpserted: 0,
        totalUpserts: 2,
        assetsReadBack: 1,
        mappingsReadBack: 1,
        factsReadBack: 0,
        snapshotsUpserted: 0,
        snapshotsReadBack: 0,
      }),
    };
    await expect(ingestCreativePerformanceBatch(store, {
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      assets: [asset('asset-one')],
      mappings: [mapping()],
      facts: [fact()],
    })).rejects.toBeInstanceOf(CreativePerformanceInputError);
  });
});

function asset(assetId: string, overrides: Partial<CreativeAsset> = {}): CreativeAsset {
  return {
    profileId: PROFILE_ID,
    assetId,
    name: `Synthetic ${assetId}`,
    assetType: 'video',
    contentHash: null,
    thumbnailUrl: null,
    ...overrides,
  };
}

function mapping(overrides: Partial<AdCreativeAssetMapping> = {}): AdCreativeAssetMapping {
  return {
    profileId: PROFILE_ID,
    adProduct: 'SB',
    campaignId: 'campaign-one',
    adGroupId: 'ad-group-one',
    adId: 'ad-one',
    creativeId: 'creative-one',
    creativeVersion: null,
    assetId: 'asset-one',
    placement: 'top_of_search',
    attributionState: 'mapped',
    mappingProvenance: null,
    creativeSyncSnapshotId: null,
    observedAt: '2026-08-29T01:00:00Z',
    ...overrides,
  };
}

function fact(overrides: Partial<CreativeDailyFact> = {}): CreativeDailyFact {
  return {
    profileId: PROFILE_ID,
    date: '2026-08-29',
    adProduct: 'SB',
    campaignId: 'campaign-one',
    adGroupId: 'ad-group-one',
    adId: 'ad-one',
    creativeId: 'creative-one',
    creativeVersion: null,
    assetId: 'asset-one',
    placement: 'top_of_search',
    attributionState: 'mapped',
    mappingProvenance: null,
    creativeSyncSnapshotId: null,
    impressions: 100,
    clicks: 10,
    cost: 5,
    purchases: 2,
    sales: 20,
    videoFirstQuartileViews: 80,
    videoMidpointViews: 60,
    videoThirdQuartileViews: 40,
    videoCompleteViews: 20,
    ...overrides,
  };
}
