/** Recorded fixtures for both current Sponsored Products suggested-bid reads. */
import { describe, expect, it } from 'vitest';
import { PROFILE_ID } from './__fixtures__/payloads.js';
import { createMockServer, lwaRoute, testEffects } from './__fixtures__/server.js';
import { AdsApiClient } from './client.js';
import { AdsApiParseError } from './errors.js';
import {
  SP_BID_RECOMMENDATION_ENDPOINTS,
  type SpBidRecommendationKind,
} from './suggested-bids.js';

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

describe('SP suggested-bid reads', () => {
  for (const kind of ['keywords', 'targets'] as const satisfies readonly SpBidRecommendationKind[]) {
    const endpoint = SP_BID_RECOMMENDATION_ENDPOINTS[kind];

    it(`${kind} maps low/median/high/suggested, honors Retry-After, and preserves partial failure`, async () => {
      const { client, effects, server } = clientFor([
        {
          method: 'POST',
          match: endpoint.path,
          responses: [
            { status: 429, headers: { 'retry-after': '2' }, json: { message: 'slow down' } },
            {
              status: 207,
              json: {
                bidRecommendations: {
                  success: [{
                    index: 0,
                    [endpoint.idKey]: ID_1,
                    rangeStart: 0.45,
                    rangeMedian: 0.7,
                    rangeEnd: 1.05,
                    suggestedBid: 0.75,
                  }],
                  error: [{ index: 1, code: 'NOT_ELIGIBLE', details: 'synthetic fixture rejection' }],
                },
              },
            },
          ],
        },
      ]);

      const result = kind === 'keywords'
        ? await client.getSpKeywordBidRecommendations(PROFILE_ID, [ID_1, ID_2])
        : await client.getSpProductTargetBidRecommendations(PROFILE_ID, [ID_1, ID_2]);

      expect(result.items).toMatchObject([{
        kind,
        index: 0,
        targetId: ID_1,
        low: 0.45,
        median: 0.7,
        high: 1.05,
        suggestedBid: 0.75,
      }]);
      expect(result.errors).toMatchObject([{ kind, index: 1, targetId: ID_2, code: 'NOT_ELIGIBLE' }]);
      expect(result.items.length + result.errors.length).toBe(result.submitted);
      expect(result.submitted).toBe(2);
      expect(effects.slept).toEqual([2_000]);
      expect(server.requestsFor(endpoint.path)).toHaveLength(2);
      const request = server.requestsFor(endpoint.path)[1];
      expect(request?.json).toEqual({ [endpoint.requestKey]: [ID_1, ID_2] });
      expect(request?.headers['content-type']).toBe(endpoint.mediaType);
      expect(request?.headers['accept']).toBe(endpoint.mediaType);
      expect(request?.headers['amazon-advertising-api-scope']).toBe(PROFILE_ID);
    });
  }

  it('batches 101 keyword ids, restores global indexes, and loses no target', async () => {
    const endpoint = SP_BID_RECOMMENDATION_ENDPOINTS.keywords;
    const ids = Array.from({ length: 101 }, (_, index) => `keyword-${index}`);
    const first = ids.slice(0, 100).map((id, index) => ({
      index,
      keywordId: id,
      suggestedBid: 0.5,
      rangeStart: 0.3,
      rangeEnd: 0.8,
    }));
    const { client, server } = clientFor([{
      method: 'POST',
      match: endpoint.path,
      responses: [
        { status: 200, json: { bidRecommendations: { success: first, error: [] } } },
        { status: 200, json: { bidRecommendations: { success: [{ index: 0, keywordId: ids[100], suggestedBid: 0.6, rangeStart: 0.4, rangeEnd: 0.9 }], error: [] } } },
      ],
    }]);

    const result = await client.getSpKeywordBidRecommendations(PROFILE_ID, ids);

    expect(result.batches).toBe(2);
    expect(result.items).toHaveLength(101);
    expect(result.items[100]?.index).toBe(100);
    expect(result.items.length + result.errors.length).toBe(result.submitted);
    expect(server.requestsFor(endpoint.path)).toHaveLength(2);
  });

  it('rejects a partial response that silently omits a submitted target', async () => {
    const endpoint = SP_BID_RECOMMENDATION_ENDPOINTS.targets;
    const { client } = clientFor([{
      method: 'POST',
      match: endpoint.path,
      responses: [{ status: 200, json: {
        bidRecommendations: {
          success: [{ index: 0, targetId: ID_1, suggestedBid: 0.5, rangeStart: 0.3, rangeEnd: 0.8 }],
          error: [],
        },
      } }],
    }]);

    await expect(
      client.getSpTargetBidRecommendations(PROFILE_ID, [ID_1, ID_2]),
    ).rejects.toBeInstanceOf(AdsApiParseError);
  });
});
