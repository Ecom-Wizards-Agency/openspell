import { describe, expect, it } from 'vitest';
import { PROFILE_ID } from './__fixtures__/payloads.js';
import { createMockServer, lwaRoute, testEffects } from './__fixtures__/server.js';
import { AdsApiClient } from './client.js';
import { AdsApiParseError } from './errors.js';
import {
  CREATIVE_ASSET_SEARCH_PATH,
  SB_AD_LIST_PATH,
  SB_AD_MEDIA_TYPE,
  parseCreativeAssetProbePage,
  parseSbAdProbePage,
  parseSbAssetReference,
} from './sb-ad-assets.js';

const CREDENTIALS = {
  clientId: 'amzn1.application-oa2-client.example',
  clientSecret: 'example-client-secret',
  refreshToken: 'fake-refresh-token',
};
const AD_ID = '100000000000001';
const CAMPAIGN_ID = '200000000000001';
const AD_GROUP_ID = '300000000000001';
const ASSET_ID = 'amzn1.assetlibrary.asset1.synthetic';

function ad(overrides: Record<string, unknown> = {}) {
  return {
    adId: AD_ID,
    campaignId: CAMPAIGN_ID,
    adGroupId: AD_GROUP_ID,
    name: 'Synthetic video ad',
    state: 'ENABLED',
    creative: {
      type: 'VIDEO',
      asins: ['B000000001'],
      videoAssetIds: [`${ASSET_ID}:version_v2`],
    },
    ...overrides,
  };
}

function asset(overrides: Record<string, unknown> = {}) {
  return {
    assetId: ASSET_ID,
    version: 'version_v2',
    assetType: 'VIDEO',
    name: 'Synthetic video',
    status: 'ACTIVE',
    fileMetadata: { contentHash: null },
    storageLocationUrls: {
      defaultUrl: 'https://example.invalid/video',
      processedUrls: { VIDEO_DEFAULT_OPTIMIZED: 'https://example.invalid/preview' },
    },
    ...overrides,
  };
}

describe('Sponsored Brands ad probe parser', () => {
  it('keeps ad identity separate from the nested creative and normalizes only version suffixes', () => {
    const page = parseSbAdProbePage({ ads: [ad()], nextToken: 'next-page' });

    expect(page).toMatchObject({ sourceRows: 1, totalResults: null, nextToken: 'next-page' });
    expect(page.items[0]).toMatchObject({
      adId: AD_ID,
      campaignId: CAMPAIGN_ID,
      adGroupId: AD_GROUP_ID,
      creativePresent: true,
      creativeVersion: null,
      creativeType: 'VIDEO',
      videoAssets: [{
        referenceId: `${ASSET_ID}:version_v2`,
        assetId: ASSET_ID,
        version: 'version_v2',
        kind: 'asset_library',
      }],
    });
  });

  it('does not split arbitrary colons and fails closed on missing identity', () => {
    expect(parseSbAssetReference(`${ASSET_ID}:custom`)).toEqual({
      referenceId: `${ASSET_ID}:custom`,
      assetId: `${ASSET_ID}:custom`,
      version: null,
      kind: 'asset_library',
    });
    expect(parseSbAdProbePage({ ads: [ad({ adId: undefined, creative: undefined })] }).items[0])
      .toMatchObject({ adId: null, creativePresent: false, videoAssets: [] });
    expect(() => parseSbAdProbePage({ ads: [ad({ adId: { changed: true } })] }))
      .toThrow(AdsApiParseError);
    expect(() => parseSbAdProbePage({ ads: [ad({ creative: null })] }))
      .toThrow(AdsApiParseError);
    expect(() => parseSbAdProbePage({ ads: [ad({ campaignId: undefined })] }))
      .toThrow(AdsApiParseError);
    expect(() => parseSbAdProbePage({ creatives: [ad()] })).toThrow(AdsApiParseError);
  });
});

describe('Creative Asset Library probe parser', () => {
  it('preserves null content hashes without using them as identity', () => {
    const page = parseCreativeAssetProbePage({
      assetList: [asset(), asset({ assetId: `${ASSET_ID}.second`, name: null })],
      token: null,
      totalRecords: 2,
    });

    expect(page).toMatchObject({ sourceRows: 2, totalRecords: 2, nextToken: null });
    expect(page.items.map((row) => row.assetId)).toEqual([ASSET_ID, `${ASSET_ID}.second`]);
    expect(page.items[0]).toMatchObject({
      contentHash: null,
      thumbnailUrl: 'https://example.invalid/preview',
    });
  });

  it('refuses impossible source counts and malformed rows', () => {
    expect(() => parseCreativeAssetProbePage({ assetList: [asset()], totalRecords: 0 }))
      .toThrow(AdsApiParseError);
    expect(() => parseCreativeAssetProbePage({ assetList: [asset({ assetType: undefined })] }))
      .toThrow(AdsApiParseError);
  });
});

describe('read-only SB ad/asset page calls', () => {
  it('uses the documented read endpoints, scope headers, and no mutation route', async () => {
    const effects = testEffects();
    const server = createMockServer([
      lwaRoute(),
      {
        method: 'POST',
        match: SB_AD_LIST_PATH,
        responses: [{ status: 200, json: { ads: [ad()], nextToken: null } }],
      },
      {
        method: 'POST',
        match: CREATIVE_ASSET_SEARCH_PATH,
        responses: [{
          status: 200,
          json: { assetList: [asset()], token: null, totalRecords: 1 },
        }],
      },
    ]);
    const client = new AdsApiClient({
      credentials: CREDENTIALS,
      region: 'NA',
      fetch: server.fetch,
      sleep: effects.sleep,
      now: effects.now,
      random: effects.random,
    });

    const ads = await client.probeSbAdsPage(PROFILE_ID);
    const assets = await client.probeCreativeAssetsPage(PROFILE_ID);

    expect(ads.sourceRows).toBe(1);
    expect(assets.sourceRows).toBe(1);
    const adRequest = server.requestsFor(SB_AD_LIST_PATH)[0];
    expect(adRequest?.headers['amazon-advertising-api-scope']).toBe(PROFILE_ID);
    expect(adRequest?.headers['content-type']).toBe(SB_AD_MEDIA_TYPE);
    expect(adRequest?.json).toEqual({ maxResults: 100 });
    const assetRequest = server.requestsFor(CREATIVE_ASSET_SEARCH_PATH)[0];
    expect(assetRequest?.headers['amazon-advertising-api-scope']).toBe(PROFILE_ID);
    expect(assetRequest?.json).toEqual({});
    expect(server.requests).toHaveLength(3); // one LWA refresh and the two documented reads
  });
});
