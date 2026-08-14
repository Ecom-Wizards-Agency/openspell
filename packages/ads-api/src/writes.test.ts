/**
 * Recorded SP v3 write fixtures.
 *
 * Every resource is exercised through create, sparse update and batch archive.
 * Each 207 contains one success and one failure, proving that callers receive
 * both halves and that `items + errors === submitted` for every endpoint.
 */
import { describe, expect, it } from 'vitest';
import { createMockServer, lwaRoute, testEffects, type RecordedResponse } from './__fixtures__/server.js';
import { PROFILE_ID } from './__fixtures__/payloads.js';
import { AdsApiClient } from './client.js';
import { SP_WRITE_ENDPOINTS, type SpWriteKind } from './endpoints.js';
import {
  AdsApiHttpError,
  AdsApiNotImplementedError,
  AdsApiParseError,
  DuplicateWriteError,
} from './errors.js';
import type { SpBatchWriteResult } from './writes.js';

const CREDENTIALS = {
  clientId: 'amzn1.application-oa2-client.example',
  clientSecret: 'example-client-secret',
  refreshToken: 'fake-refresh-token',
};

const ID_1 = '100000000000001';
const ID_2 = '100000000000002';

function clientFor(routes: Parameters<typeof createMockServer>[0]) {
  const effects = testEffects();
  const server = createMockServer([lwaRoute(), ...routes]);
  return {
    server,
    effects,
    client: new AdsApiClient({
      credentials: CREDENTIALS,
      region: 'NA',
      fetch: server.fetch,
      sleep: effects.sleep,
      now: effects.now,
      random: effects.random,
    }),
  };
}

function partialResponse(kind: SpWriteKind, firstId = ID_1): unknown {
  const endpoint = SP_WRITE_ENDPOINTS[kind];
  return {
    [endpoint.responseKey]: {
      success: [{ index: 0, [endpoint.idKey]: firstId }],
      error: [
        {
          index: 1,
          errors: [{ errorType: 'INVALID_ARGUMENT', errorValue: { message: 'synthetic fixture rejection' } }],
        },
      ],
    },
  };
}

type RunWrite = (client: AdsApiClient) => Promise<SpBatchWriteResult>;

interface ResourceFixture {
  kind: SpWriteKind;
  create: RunWrite;
  update: RunWrite;
  archive: RunWrite;
}

const RESOURCES: ResourceFixture[] = [
  {
    kind: 'campaigns',
    create: (client) => client.createSpCampaigns(PROFILE_ID, [
      { name: 'Synthetic campaign one', targetingType: 'MANUAL', state: 'ENABLED', budget: { budget: 10, budgetType: 'DAILY' } },
      { name: 'Synthetic campaign two', targetingType: 'AUTO', state: 'PAUSED', budget: { budget: 12, budgetType: 'DAILY' } },
    ]),
    update: (client) => client.updateSpCampaigns(PROFILE_ID, [
      { campaignId: ID_1, budget: { budget: 15, budgetType: 'DAILY' } },
      { campaignId: ID_2, state: 'PAUSED' },
    ]),
    archive: (client) => client.archiveSpCampaigns(PROFILE_ID, [ID_1, ID_2]),
  },
  {
    kind: 'adGroups',
    create: (client) => client.createSpAdGroups(PROFILE_ID, [
      { campaignId: ID_1, name: 'Synthetic ad group one', state: 'ENABLED', defaultBid: 0.75 },
      { campaignId: ID_1, name: 'Synthetic ad group two', state: 'PAUSED', defaultBid: 0.5 },
    ]),
    update: (client) => client.updateSpAdGroups(PROFILE_ID, [
      { adGroupId: ID_1, defaultBid: 0.8 },
      { adGroupId: ID_2, state: 'PAUSED' },
    ]),
    archive: (client) => client.archiveSpAdGroups(PROFILE_ID, [ID_1, ID_2]),
  },
  {
    kind: 'keywords',
    create: (client) => client.createSpKeywords(PROFILE_ID, [
      { campaignId: ID_1, adGroupId: ID_1, keywordText: 'synthetic one', matchType: 'EXACT', state: 'ENABLED', bid: 1.1 },
      { campaignId: ID_1, adGroupId: ID_1, keywordText: 'synthetic two', matchType: 'PHRASE', state: 'PAUSED' },
    ]),
    update: (client) => client.updateSpKeywords(PROFILE_ID, [
      { keywordId: ID_1, bid: 1.2 },
      { keywordId: ID_2, state: 'PAUSED' },
    ]),
    archive: (client) => client.archiveSpKeywords(PROFILE_ID, [ID_1, ID_2]),
  },
  {
    kind: 'targets',
    create: (client) => client.createSpTargets(PROFILE_ID, [
      { campaignId: ID_1, adGroupId: ID_1, expression: [{ type: 'ASIN_SAME_AS', value: 'B000000001' }], expressionType: 'MANUAL', state: 'ENABLED', bid: 0.8 },
      { campaignId: ID_1, adGroupId: ID_1, expression: [{ type: 'ASIN_SAME_AS', value: 'B000000002' }], expressionType: 'MANUAL', state: 'PAUSED' },
    ]),
    update: (client) => client.updateSpTargets(PROFILE_ID, [
      { targetId: ID_1, bid: 0.9 },
      { targetId: ID_2, state: 'PAUSED' },
    ]),
    archive: (client) => client.archiveSpTargets(PROFILE_ID, [ID_1, ID_2]),
  },
  {
    kind: 'negativeKeywords',
    create: (client) => client.createSpNegativeKeywords(PROFILE_ID, [
      { campaignId: ID_1, adGroupId: ID_1, keywordText: 'synthetic negative one', matchType: 'NEGATIVE_EXACT', state: 'ENABLED' },
      { campaignId: ID_1, adGroupId: ID_1, keywordText: 'synthetic negative two', matchType: 'NEGATIVE_PHRASE', state: 'PAUSED' },
    ]),
    update: (client) => client.updateSpNegativeKeywords(PROFILE_ID, [
      { keywordId: ID_1, state: 'PAUSED' },
      { keywordId: ID_2, state: 'ENABLED' },
    ]),
    archive: (client) => client.archiveSpNegativeKeywords(PROFILE_ID, [ID_1, ID_2]),
  },
  {
    kind: 'campaignNegativeKeywords',
    create: (client) => client.createSpCampaignNegativeKeywords(PROFILE_ID, [
      { campaignId: ID_1, keywordText: 'synthetic campaign negative one', matchType: 'NEGATIVE_EXACT', state: 'ENABLED' },
      { campaignId: ID_1, keywordText: 'synthetic campaign negative two', matchType: 'NEGATIVE_PHRASE', state: 'PAUSED' },
    ]),
    update: (client) => client.updateSpCampaignNegativeKeywords(PROFILE_ID, [
      { keywordId: ID_1, state: 'ENABLED' },
      { keywordId: ID_2, state: 'ENABLED' },
    ]),
    archive: (client) => client.archiveSpCampaignNegativeKeywords(PROFILE_ID, [ID_1, ID_2]),
  },
  {
    kind: 'negativeTargets',
    create: (client) => client.createSpNegativeTargets(PROFILE_ID, [
      { campaignId: ID_1, adGroupId: ID_1, expression: [{ type: 'ASIN_SAME_AS', value: 'B000000003' }], state: 'ENABLED' },
      { campaignId: ID_1, adGroupId: ID_1, expression: [{ type: 'ASIN_SAME_AS', value: 'B000000004' }], state: 'PAUSED' },
    ]),
    update: (client) => client.updateSpNegativeTargets(PROFILE_ID, [
      { targetId: ID_1, state: 'PAUSED' },
      { targetId: ID_2, state: 'ENABLED' },
    ]),
    archive: (client) => client.archiveSpNegativeTargets(PROFILE_ID, [ID_1, ID_2]),
  },
  {
    kind: 'campaignNegativeTargets',
    create: (client) => client.createSpCampaignNegativeTargets(PROFILE_ID, [
      { campaignId: ID_1, expression: [{ type: 'ASIN_SAME_AS', value: 'B000000005' }], state: 'ENABLED' },
      { campaignId: ID_1, expression: [{ type: 'ASIN_SAME_AS', value: 'B000000006' }], state: 'PAUSED' },
    ]),
    update: (client) => client.updateSpCampaignNegativeTargets(PROFILE_ID, [
      { targetId: ID_1, state: 'PAUSED' },
      { targetId: ID_2, state: 'ENABLED' },
    ]),
    archive: (client) => client.archiveSpCampaignNegativeTargets(PROFILE_ID, [ID_1, ID_2]),
  },
  {
    kind: 'productAds',
    create: (client) => client.createSpProductAds(PROFILE_ID, [
      { campaignId: ID_1, adGroupId: ID_1, sku: 'SYNTHETIC-SKU-1', state: 'ENABLED' },
      { campaignId: ID_1, adGroupId: ID_1, asin: 'B000000007', state: 'PAUSED' },
    ]),
    update: (client) => client.updateSpProductAds(PROFILE_ID, [
      { adId: ID_1, state: 'PAUSED' },
      { adId: ID_2, state: 'ENABLED' },
    ]),
    archive: (client) => client.archiveSpProductAds(PROFILE_ID, [ID_1, ID_2]),
  },
];

describe('every Sponsored Products write endpoint', () => {
  for (const resource of RESOURCES) {
    const endpoint = SP_WRITE_ENDPOINTS[resource.kind];
    for (const operation of ['create', 'update', 'archive'] as const) {
      it(`${operation} ${resource.kind} preserves partial failures and accounts for the batch`, async () => {
        const path = operation === 'archive' ? `${endpoint.path}/delete` : endpoint.path;
        const method = operation === 'update' ? 'PUT' : 'POST';
        const { server, client } = clientFor([
          { method, match: path, responses: [{ status: 207, json: partialResponse(resource.kind) }] },
        ]);

        const result = await resource[operation](client);

        expect(result.items).toHaveLength(1);
        expect(result.errors).toHaveLength(1);
        expect(result.items.length + result.errors.length).toBe(result.submitted);
        expect(result.submitted).toBe(2);
        expect(result.errors[0]).toMatchObject({ index: 1, code: 'INVALID_ARGUMENT' });

        const request = server.requestsFor(path)[0];
        expect(request?.method).toBe(method);
        expect(request?.headers['content-type']).toBe(endpoint.mediaType);
        expect(request?.headers['accept']).toBe(endpoint.mediaType);
        expect(request?.headers['amazon-advertising-api-scope']).toBe(PROFILE_ID);
        if (operation === 'archive') {
          expect(request?.json).toEqual({ [endpoint.idFilterKey]: { include: [ID_1, ID_2] } });
        } else {
          expect((request?.json as Record<string, unknown>)[endpoint.requestKey]).toHaveLength(2);
        }
      });
    }
  }
});

describe('campaign placement and off-Amazon settings', () => {
  it('sends placement bid adjustments and the off-Amazon serving attribute in a sparse campaign update', async () => {
    const endpoint = SP_WRITE_ENDPOINTS.campaigns;
    const { server, client } = clientFor([
      { method: 'PUT', match: endpoint.path, responses: [{ status: 207, json: {
        campaigns: { success: [{ index: 0, campaignId: ID_1 }], error: [] },
      } }] },
    ]);

    await client.updateSpCampaignPlacementBidding(PROFILE_ID, [{
      campaignId: ID_1,
      strategy: 'AUTO_FOR_SALES',
      placementBidding: [
        { placement: 'PLACEMENT_TOP', percentage: 50 },
        { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 20 },
      ],
      offAmazonSettings: { offAmazonBudgetControlStrategy: 'LIMIT_OFF_AMAZON_SPEND' },
    }]);

    expect(server.requestsFor(endpoint.path)[0]?.json).toEqual({
      campaigns: [{
        campaignId: ID_1,
        dynamicBidding: {
          strategy: 'AUTO_FOR_SALES',
          placementBidding: [
            { placement: 'PLACEMENT_TOP', percentage: 50 },
            { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 20 },
          ],
        },
        offAmazonSettings: { offAmazonBudgetControlStrategy: 'LIMIT_OFF_AMAZON_SPEND' },
      }],
    });
  });
});

describe('batching and write failure mapping', () => {
  it('splits at 100, restores global indexes, and loses no item', async () => {
    const endpoint = SP_WRITE_ENDPOINTS.keywords;
    const firstSuccess = Array.from({ length: 100 }, (_, index) => ({ index, keywordId: `keyword-${index}` }));
    const { server, client } = clientFor([
      { method: 'PUT', match: endpoint.path, responses: [
        { status: 207, json: { keywords: { success: firstSuccess, error: [] } } },
        { status: 207, json: { keywords: { success: [{ index: 0, keywordId: 'keyword-100' }], error: [] } } },
      ] },
    ]);
    const updates = Array.from({ length: 101 }, (_, index) => ({ keywordId: `keyword-${index}`, bid: 0.5 }));

    const result = await client.updateSpKeywords(PROFILE_ID, updates);

    expect(result.batches).toBe(2);
    expect(server.requestsFor(endpoint.path)).toHaveLength(2);
    expect(result.items).toHaveLength(101);
    expect(result.items[100]?.index).toBe(100);
    expect(result.items.length + result.errors.length).toBe(result.submitted);
  });

  it('retries a write only on 429 and honors Retry-After', async () => {
    const endpoint = SP_WRITE_ENDPOINTS.campaigns;
    const responses: RecordedResponse[] = [
      { status: 429, headers: { 'retry-after': '3' }, json: { message: 'slow down' } },
      { status: 207, json: { campaigns: { success: [{ index: 0, campaignId: ID_1 }], error: [] } } },
    ];
    const { server, effects, client } = clientFor([
      { method: 'PUT', match: endpoint.path, responses },
    ]);

    const result = await client.updateSpCampaigns(PROFILE_ID, [{ campaignId: ID_1, state: 'PAUSED' }]);

    expect(result.items).toHaveLength(1);
    expect(server.requestsFor(endpoint.path)).toHaveLength(2);
    expect(effects.slept).toEqual([3_000]);
    expect(client.throttleState.totalThrottles).toBe(1);
  });

  it('maps 425 to a typed duplicate-write error and does not retry it', async () => {
    const endpoint = SP_WRITE_ENDPOINTS.productAds;
    const { server, client } = clientFor([
      { method: 'POST', match: endpoint.path, responses: [{ status: 425, json: { detail: 'duplicate batch' } }] },
    ]);

    const error = await client.createSpProductAds(PROFILE_ID, [
      { campaignId: ID_1, adGroupId: ID_1, sku: 'SYNTHETIC-SKU-1', state: 'ENABLED' },
    ]).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(DuplicateWriteError);
    expect(error).toMatchObject({ operation: 'create', path: endpoint.path, attempts: 1 });
    expect(server.requestsFor(endpoint.path)).toHaveLength(1);
  });

  it('surfaces a 4xx as non-retryable', async () => {
    const endpoint = SP_WRITE_ENDPOINTS.adGroups;
    const { server, client } = clientFor([
      { method: 'PUT', match: endpoint.path, responses: [{ status: 400, json: { message: 'invalid' } }] },
    ]);

    const error = await client.updateSpAdGroups(PROFILE_ID, [{ adGroupId: ID_1, defaultBid: -1 }])
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AdsApiHttpError);
    expect(error).toMatchObject({ status: 400, attempts: 1 });
    expect(server.requestsFor(endpoint.path)).toHaveLength(1);
  });

  it('rejects a response that does not account for every submitted item', async () => {
    const endpoint = SP_WRITE_ENDPOINTS.targets;
    const { client } = clientFor([
      { method: 'PUT', match: endpoint.path, responses: [{ status: 207, json: {
        targetingClauses: { success: [{ index: 0, targetId: ID_1 }], error: [] },
      } }] },
    ]);

    await expect(client.updateSpTargets(PROFILE_ID, [
      { targetId: ID_1, bid: 0.6 },
      { targetId: ID_2, bid: 0.7 },
    ])).rejects.toBeInstanceOf(AdsApiParseError);
  });

  it('makes no HTTP call for an empty batch', async () => {
    const { server, client } = clientFor([]);
    const result = await client.archiveSpCampaigns(PROFILE_ID, []);
    expect(result).toEqual({ items: [], errors: [], submitted: 0, batches: 0 });
    expect(server.requests).toHaveLength(0);
  });
});

describe('Sponsored Brands v4 media/creative stubs', () => {
  it('exposes typed methods that all throw not implemented without making HTTP calls', async () => {
    const { server, client } = clientFor([]);
    const calls: Array<() => Promise<unknown>> = [
      () => client.uploadSbMedia(PROFILE_ID, { name: 'Synthetic', mediaType: 'IMAGE', contentType: 'image/png', fileName: 'synthetic.png', bytes: new Uint8Array() }),
      () => client.getSbMedia(PROFILE_ID, ID_1),
      () => client.createSbCreative(PROFILE_ID, { adGroupId: ID_1, creativeType: 'VIDEO', assets: [{ assetId: ID_1, role: 'VIDEO' }] }),
      () => client.updateSbCreative(PROFILE_ID, { creativeId: ID_1, state: 'PAUSED' }),
      () => client.archiveSbCreative(PROFILE_ID, ID_1),
    ];

    for (const call of calls) {
      await expect(Promise.resolve().then(call)).rejects.toBeInstanceOf(AdsApiNotImplementedError);
    }
    expect(server.requests).toHaveLength(0);
  });
});
