import { describe, expect, it } from 'vitest';
import { PROFILE_ID } from './__fixtures__/payloads.js';
import { createMockServer, lwaRoute, testEffects } from './__fixtures__/server.js';
import { AdsApiClient } from './client.js';
import { AdsApiParseError } from './errors.js';
import {
  CREATIVE_ASSET_SEARCH_MEDIA_TYPE,
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

function clientFor(
  server: ReturnType<typeof createMockServer>,
  effects: ReturnType<typeof testEffects>,
) {
  return new AdsApiClient({
    credentials: CREDENTIALS,
    region: 'NA',
    fetch: server.fetch,
    sleep: effects.sleep,
    now: effects.now,
    random: effects.random,
  });
}

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

describe('read-only SB ad/asset page walks', () => {
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
    const client = clientFor(server, effects);

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
    expect(assetRequest?.headers.accept).toBe(CREATIVE_ASSET_SEARCH_MEDIA_TYPE);
    expect(assetRequest?.json).toEqual({ pageCriteria: { size: 500 } });
    expect(server.requests).toHaveLength(3); // one LWA refresh and the two documented reads
  });

  it('walks every SB ad page, preserves duplicate rows, and propagates filters', async () => {
    const effects = testEffects();
    const secondAdId = '100000000000002';
    const server = createMockServer([
      lwaRoute(),
      {
        method: 'POST',
        match: SB_AD_LIST_PATH,
        responses: [
          {
            status: 200,
            json: { ads: [ad()], nextToken: 'ads-next', totalResults: 3 },
          },
          {
            status: 200,
            json: {
              ads: [ad(), ad({ adId: secondAdId })],
              nextToken: null,
              totalResults: 3,
            },
          },
        ],
      },
    ]);
    const client = clientFor(server, effects);

    const result = await client.probeSbAdsPage(PROFILE_ID, {
      maxResults: 7,
      stateFilter: ['ENABLED', 'PAUSED'],
      campaignIdFilter: [CAMPAIGN_ID],
      adGroupIdFilter: [AD_GROUP_ID],
      adIdFilter: [AD_ID],
      nameFilter: { include: ['Synthetic'], queryTermMatchType: 'BROAD_MATCH' },
    });

    expect(result).toMatchObject({ sourceRows: 3, totalResults: 3, nextToken: null });
    // A duplicate ad id is evidence for the worker's ambiguity handling, not a row to hide.
    expect(result.items.map((row) => row.adId)).toEqual([AD_ID, AD_ID, secondAdId]);
    expect(server.requestsFor(SB_AD_LIST_PATH).map((request) => request.json)).toEqual([
      {
        maxResults: 7,
        stateFilter: { include: ['ENABLED', 'PAUSED'] },
        campaignIdFilter: { include: [CAMPAIGN_ID] },
        adGroupIdFilter: { include: [AD_GROUP_ID] },
        adIdFilter: { include: [AD_ID] },
        nameFilter: { include: ['Synthetic'], queryTermMatchType: 'BROAD_MATCH' },
      },
      {
        maxResults: 7,
        stateFilter: { include: ['ENABLED', 'PAUSED'] },
        campaignIdFilter: { include: [CAMPAIGN_ID] },
        adGroupIdFilter: { include: [AD_GROUP_ID] },
        adIdFilter: { include: [AD_ID] },
        nameFilter: { include: ['Synthetic'], queryTermMatchType: 'BROAD_MATCH' },
        nextToken: 'ads-next',
      },
    ]);
  });

  it('walks every asset page and propagates search, filters, sort, size, and identifiers', async () => {
    const effects = testEffects();
    const secondAssetId = `${ASSET_ID}.second`;
    const filters = {
      valueFilters: [{ valueField: 'assetType', values: ['VIDEO'] }],
      rangeFilters: [{ rangeField: 'createdAt', range: [{ start: '2026-01-01', end: '2026-02-01' }] }],
    } as const;
    const sort = { field: 'createdAt', order: 'DESC' } as const;
    const server = createMockServer([
      lwaRoute(),
      {
        method: 'POST',
        match: CREATIVE_ASSET_SEARCH_PATH,
        responses: [
          {
            status: 200,
            json: { assetList: [asset()], token: 'asset-next', totalRecords: 2 },
          },
          {
            status: 200,
            json: {
              assetList: [asset({ assetId: secondAssetId })],
              token: null,
              totalRecords: 2,
            },
          },
        ],
      },
    ]);
    const client = clientFor(server, effects);

    const result = await client.probeCreativeAssetsPage(PROFILE_ID, {
      text: 'synthetic',
      filterCriteria: filters,
      sortCriteria: sort,
      pageSize: 17,
    });

    expect(result).toMatchObject({ sourceRows: 2, totalRecords: 2, nextToken: null });
    expect(result.items.map((row) => row.assetId)).toEqual([ASSET_ID, secondAssetId]);
    expect(server.requestsFor(CREATIVE_ASSET_SEARCH_PATH).map((request) => request.json)).toEqual([
      {
        text: 'synthetic',
        filterCriteria: filters,
        sortCriteria: sort,
        pageCriteria: { size: 17 },
      },
      {
        text: 'synthetic',
        filterCriteria: filters,
        sortCriteria: sort,
        pageCriteria: {
          size: 17,
          identifier: { pageNumber: 1, token: 'asset-next' },
        },
      },
    ]);
  });

  it('returns exact empty aggregates without requesting another page', async () => {
    const effects = testEffects();
    const server = createMockServer([
      lwaRoute(),
      {
        method: 'POST',
        match: SB_AD_LIST_PATH,
        responses: [{ status: 200, json: { ads: [], nextToken: null, totalResults: 0 } }],
      },
      {
        method: 'POST',
        match: CREATIVE_ASSET_SEARCH_PATH,
        responses: [{ status: 200, json: { assetList: [], token: null, totalRecords: 0 } }],
      },
    ]);
    const client = clientFor(server, effects);

    await expect(client.probeSbAdsPage(PROFILE_ID)).resolves.toMatchObject({
      items: [], sourceRows: 0, totalResults: 0, nextToken: null,
    });
    await expect(client.probeCreativeAssetsPage(PROFILE_ID)).resolves.toMatchObject({
      items: [], sourceRows: 0, totalRecords: 0, nextToken: null,
    });
    expect(server.requestsFor(SB_AD_LIST_PATH)).toHaveLength(1);
    expect(server.requestsFor(CREATIVE_ASSET_SEARCH_PATH)).toHaveLength(1);
  });

  it('refuses a final count that does not equal the advertised provider total', async () => {
    const effects = testEffects();
    const server = createMockServer([
      lwaRoute(),
      {
        method: 'POST',
        match: SB_AD_LIST_PATH,
        responses: [{
          status: 200,
          json: { ads: [ad()], nextToken: null, totalResults: 2 },
        }],
      },
      {
        method: 'POST',
        match: CREATIVE_ASSET_SEARCH_PATH,
        responses: [{
          status: 200,
          json: { assetList: [asset()], token: null, totalRecords: 2 },
        }],
      },
    ]);
    const client = clientFor(server, effects);

    await expect(client.probeSbAdsPage(PROFILE_ID)).rejects.toThrow(/row count.*totalResults/);
    await expect(client.probeCreativeAssetsPage(PROFILE_ID)).rejects.toThrow(
      /row count.*totalRecords/,
    );
  });

  it('refuses totals that change between pages', async () => {
    const effects = testEffects();
    const server = createMockServer([
      lwaRoute(),
      {
        method: 'POST',
        match: SB_AD_LIST_PATH,
        responses: [
          { status: 200, json: { ads: [ad()], nextToken: 'next', totalResults: 2 } },
          {
            status: 200,
            json: { ads: [ad({ adId: '100000000000002' })], nextToken: null, totalResults: 3 },
          },
        ],
      },
    ]);
    const client = clientFor(server, effects);

    await expect(client.probeSbAdsPage(PROFILE_ID)).rejects.toThrow(
      /changed totalResults during pagination/,
    );
  });

  it('detects repeated tokens and empty-page stalls', async () => {
    const effects = testEffects();
    const repeated = createMockServer([
      lwaRoute(),
      {
        method: 'POST',
        match: SB_AD_LIST_PATH,
        responses: [
          { status: 200, json: { ads: [ad()], nextToken: 'same' } },
          { status: 200, json: { ads: [ad()], nextToken: 'same' } },
        ],
      },
    ]);
    const stalled = createMockServer([
      lwaRoute(),
      {
        method: 'POST',
        match: CREATIVE_ASSET_SEARCH_PATH,
        responses: [{ status: 200, json: { assetList: [], token: 'still-more' } }],
      },
    ]);

    await expect(clientFor(repeated, effects).probeSbAdsPage(PROFILE_ID)).rejects.toThrow(
      /repeated a continuation token/,
    );
    await expect(
      clientFor(stalled, testEffects()).probeCreativeAssetsPage(PROFILE_ID),
    ).rejects.toThrow(/stalled on an empty page/);
  });

  it('refuses duplicate authoritative Asset IDs instead of silently deduplicating them', async () => {
    const effects = testEffects();
    const server = createMockServer([
      lwaRoute(),
      {
        method: 'POST',
        match: CREATIVE_ASSET_SEARCH_PATH,
        responses: [
          {
            status: 200,
            json: { assetList: [asset()], token: 'next', totalRecords: 2 },
          },
          {
            status: 200,
            json: { assetList: [asset()], token: null, totalRecords: 2 },
          },
        ],
      },
    ]);

    await expect(clientFor(server, effects).probeCreativeAssetsPage(PROFILE_ID)).rejects.toThrow(
      /duplicate authoritative assetId/,
    );
  });

  it('retries throttled and transient page reads without losing rows', async () => {
    const effects = testEffects();
    const secondAdId = '100000000000002';
    const server = createMockServer([
      lwaRoute(),
      {
        method: 'POST',
        match: SB_AD_LIST_PATH,
        responses: [
          { status: 429, headers: { 'retry-after': '1' }, json: { message: 'throttled' } },
          { status: 200, json: { ads: [ad()], nextToken: 'next', totalResults: 2 } },
          { status: 500, json: { message: 'transient' } },
          {
            status: 200,
            json: { ads: [ad({ adId: secondAdId })], nextToken: null, totalResults: 2 },
          },
        ],
      },
    ]);
    const client = clientFor(server, effects);

    const result = await client.probeSbAdsPage(PROFILE_ID);

    expect(result.items.map((row) => row.adId)).toEqual([AD_ID, secondAdId]);
    expect(result.sourceRows).toBe(2);
    expect(server.requestsFor(SB_AD_LIST_PATH)).toHaveLength(4);
    expect(effects.slept).toHaveLength(2);
    expect(client.throttleState.totalThrottles).toBe(1);
  });
});
