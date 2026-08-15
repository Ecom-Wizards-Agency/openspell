/**
 * Entity lists and the mapping into mirror rows.
 *
 * The assertion that matters in every one of these is the accounting one:
 * `items + skipped === raw`. A sync that lists 4 campaigns and mirrors 3
 * without saying so is the silent data-loss bug Rule 4 exists for, and it
 * looks exactly like success from the outside.
 */
import { describe, expect, it } from 'vitest';
import { AdsApiClient, type MappedListResult } from './client.js';
import { AdsApiParseError } from './errors.js';
import { createMockServer, lwaRoute } from './__fixtures__/server.js';
import {
  PROFILE_ID,
  SB_AD_GROUPS,
  SB_CAMPAIGNS,
  SD_AD_GROUPS,
  SD_CAMPAIGNS_PAGE_1,
  SD_CAMPAIGNS_PAGE_2,
  SP_AD_GROUPS,
  SP_CAMPAIGNS_PAGE_1,
  SP_CAMPAIGNS_PAGE_2,
  SP_CAMPAIGN_NEGATIVE_KEYWORDS,
  SP_KEYWORDS,
  SP_NEGATIVE_KEYWORDS,
  SP_NEGATIVE_TARGETS,
  SP_PRODUCT_ADS,
  SP_TARGETS,
} from './__fixtures__/payloads.js';

const CREDENTIALS = {
  clientId: 'amzn1.application-oa2-client.example',
  clientSecret: 'example-client-secret',
  refreshToken: 'fake-refresh-token',
};

function clientFor(routes: Parameters<typeof createMockServer>[0]) {
  const server = createMockServer([lwaRoute(), ...routes]);
  return {
    server,
    client: new AdsApiClient({
      credentials: CREDENTIALS,
      region: 'NA',
      fetch: server.fetch,
      sleep: async () => undefined,
    }),
  };
}

/** Every mapped list must account for every row Amazon sent. */
function expectAccountedFor<T>(result: MappedListResult<T>): void {
  expect(result.items.length + result.skipped.length).toBe(result.raw.length);
}

describe('Sponsored Products campaigns', () => {
  it('walks every page and maps what it can, refusing the rest by name', async () => {
    const { server, client } = clientFor([
      {
        method: 'POST',
        match: '/sp/campaigns/list',
        responses: [
          { status: 200, json: SP_CAMPAIGNS_PAGE_1 },
          { status: 200, json: SP_CAMPAIGNS_PAGE_2 },
        ],
      },
    ]);

    const result = await client.listSpCampaigns(PROFILE_ID);

    expect(result.pages).toBe(2);
    expect(result.raw).toHaveLength(4);
    expect(result.items).toHaveLength(3);
    expect(result.skipped).toEqual([
      { index: 3, id: '100000000000004', reason: 'no budget in payload' },
    ]);
    expectAccountedFor(result);
    expect(result.truncated).toBe(false);

    // Page two must carry the token page one handed back.
    const second = server.requestsFor('/sp/campaigns/list')[1];
    expect((second?.json as { nextToken?: string } | null)?.nextToken).toBe('page-two');
  });

  it('sends the versioned media type and the profile scope', async () => {
    const { server, client } = clientFor([
      { method: 'POST', match: '/sp/campaigns/list', responses: [{ status: 200, json: SP_CAMPAIGNS_PAGE_2 }] },
    ]);

    await client.listSpCampaigns(PROFILE_ID);

    const request = server.requestsFor('/sp/campaigns/list')[0];
    expect(request?.headers['content-type']).toBe('application/vnd.spCampaign.v3+json');
    expect(request?.headers['accept']).toBe('application/vnd.spCampaign.v3+json');
    expect(request?.headers['amazon-advertising-api-scope']).toBe(PROFILE_ID);
    // SP has no page ceiling: the default 500 must survive unclamped, or the SB
    // fix would have silently throttled SP paging.
    expect((request?.json as { maxResults: number }).maxResults).toBe(500);
  });

  it('maps budget, placement modifiers and the transient enabling state', async () => {
    const { client } = clientFor([
      { method: 'POST', match: '/sp/campaigns/list', responses: [{ status: 200, json: SP_CAMPAIGNS_PAGE_1 }] },
    ]);

    const result = await client.listSpCampaigns(PROFILE_ID, { maxPages: 1 });
    const [first, second] = result.items;

    expect(first).toMatchObject({
      entityType: 'campaign',
      amazonId: '100000000000001',
      adProduct: 'SP',
      name: 'Placeholder SP Exact',
      state: 'enabled',
      portfolioId: '900000001',
      budgetAmount: 42.5,
      budgetType: 'daily',
      targetingType: 'manual',
      biddingStrategy: 'auto_for_sales',
      startDate: '2026-01-01',
      endDate: null,
    });
    expect(first?.placementBidding).toEqual({ topOfSearch: 50, productPages: 0, restOfSearch: null });
    // `enabling` is a transient Amazon state and collapses into `enabled`.
    expect(second?.state).toBe('enabled');
    expect(second?.targetingType).toBe('auto');
  });

  it('stops at maxPages and says the walk was truncated', async () => {
    const { client } = clientFor([
      {
        method: 'POST',
        match: '/sp/campaigns/list',
        responses: [{ status: 200, json: SP_CAMPAIGNS_PAGE_1 }],
      },
    ]);

    const result = await client.listSpCampaigns(PROFILE_ID, { maxPages: 1 });

    expect(result.truncated).toBe(true);
    expect(result.nextToken).toBe('page-two');
    expect(result.pages).toBe(1);
  });

  it('passes state filters through in Amazon’s include form', async () => {
    const { server, client } = clientFor([
      { method: 'POST', match: '/sp/campaigns/list', responses: [{ status: 200, json: SP_CAMPAIGNS_PAGE_2 }] },
    ]);

    await client.listSpCampaigns(PROFILE_ID, { stateFilter: ['ENABLED', 'PAUSED'], maxResults: 100 });

    expect(server.requestsFor('/sp/campaigns/list')[0]?.json).toEqual({
      maxResults: 100,
      stateFilter: { include: ['ENABLED', 'PAUSED'] },
    });
  });
});

describe('the rest of the Sponsored Products entity surface', () => {
  it('maps ad groups', async () => {
    const { client } = clientFor([
      { method: 'POST', match: '/sp/adGroups/list', responses: [{ status: 200, json: SP_AD_GROUPS }] },
    ]);
    const result = await client.listSpAdGroups(PROFILE_ID);

    expectAccountedFor(result);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      entityType: 'ad_group',
      amazonId: '200000000000001',
      campaignId: '100000000000001',
      defaultBid: 0.75,
      state: 'enabled',
    });
  });

  it('maps keywords and refuses a match type it does not know', async () => {
    const { client } = clientFor([
      { method: 'POST', match: '/sp/keywords/list', responses: [{ status: 200, json: SP_KEYWORDS }] },
    ]);
    const result = await client.listSpKeywords(PROFILE_ID);

    expectAccountedFor(result);
    expect(result.items.map((row) => row.matchType)).toEqual(['exact', 'phrase']);
    expect(result.skipped[0]?.id).toBe('300000000000003');
  });

  it('reads targets from targetingClauses and maps the auto-targeting vocabulary', async () => {
    const { client } = clientFor([
      { method: 'POST', match: '/sp/targets/list', responses: [{ status: 200, json: SP_TARGETS }] },
    ]);
    const result = await client.listSpTargets(PROFILE_ID);

    expectAccountedFor(result);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.expression).toEqual([{ type: 'asin_same_as', value: 'B000000001' }]);
    expect(result.items[1]?.expression).toEqual([{ type: 'close_match', value: null }]);
    expect(result.items[0]?.resolvedExpression).toBe('ASIN_SAME_AS="B000000001"');
    expect(result.skipped[0]?.reason).toContain('expression');
  });

  it('scopes ad-group and campaign negatives differently', async () => {
    const { client } = clientFor([
      { method: 'POST', match: '/sp/negativeKeywords/list', responses: [{ status: 200, json: SP_NEGATIVE_KEYWORDS }] },
      {
        method: 'POST',
        match: '/sp/campaignNegativeKeywords/list',
        responses: [{ status: 200, json: SP_CAMPAIGN_NEGATIVE_KEYWORDS }],
      },
    ]);

    const adGroupScoped = await client.listSpNegativeKeywords(PROFILE_ID);
    const campaignScoped = await client.listSpCampaignNegativeKeywords(PROFILE_ID);

    expect(adGroupScoped.items[0]).toMatchObject({
      scope: 'ad_group',
      adGroupId: '200000000000001',
      matchType: 'negative_exact',
    });
    expect(campaignScoped.items[0]).toMatchObject({
      scope: 'campaign',
      adGroupId: null,
      matchType: 'negative_phrase',
    });
  });

  it('maps negative product targets onto the same mirror row', async () => {
    const { client } = clientFor([
      { method: 'POST', match: '/sp/negativeTargets/list', responses: [{ status: 200, json: SP_NEGATIVE_TARGETS }] },
    ]);
    const result = await client.listSpNegativeTargets(PROFILE_ID);

    expectAccountedFor(result);
    expect(result.items[0]).toMatchObject({
      entityType: 'negative',
      keywordText: null,
      matchType: 'asin_same_as',
      scope: 'ad_group',
    });
  });

  it('maps product ads and falls back from ASIN to SKU for the name', async () => {
    const { client } = clientFor([
      { method: 'POST', match: '/sp/productAds/list', responses: [{ status: 200, json: SP_PRODUCT_ADS }] },
    ]);
    const result = await client.listSpProductAds(PROFILE_ID);

    expectAccountedFor(result);
    expect(result.items[0]).toMatchObject({ asin: 'B000000001', sku: 'PLACEHOLDER-SKU-1', name: 'B000000001' });
    expect(result.items[1]).toMatchObject({ asin: null, sku: null, name: null, state: 'archived' });
  });
});

describe('Sponsored Brands v4', () => {
  it('reads a flat budget and tags the rows as SB', async () => {
    const { server, client } = clientFor([
      { method: 'POST', match: '/sb/v4/campaigns/list', responses: [{ status: 200, json: SB_CAMPAIGNS }] },
      { method: 'POST', match: '/sb/v4/adGroups/list', responses: [{ status: 200, json: SB_AD_GROUPS }] },
    ]);

    const campaigns = await client.listSbCampaigns(PROFILE_ID);
    const adGroups = await client.listSbAdGroups(PROFILE_ID);

    expect(campaigns.items[0]).toMatchObject({ adProduct: 'SB', budgetAmount: 75, budgetType: 'daily' });
    expect(adGroups.items[0]).toMatchObject({ adProduct: 'SB', campaignId: '700000000000001' });
    expect(server.requestsFor('/sb/v4/campaigns/list')[0]?.headers['accept']).toBe(
      'application/vnd.sbcampaignresource.v4+json',
    );
  });

  it('caps maxResults at 100 by default: SB v4 400s on the shared 500-row page', async () => {
    const { server, client } = clientFor([
      { method: 'POST', match: '/sb/v4/campaigns/list', responses: [{ status: 200, json: SB_CAMPAIGNS }] },
      { method: 'POST', match: '/sb/v4/adGroups/list', responses: [{ status: 200, json: SB_AD_GROUPS }] },
    ]);

    // No options -> the client would otherwise send DEFAULT_PAGE_SIZE (500),
    // which is the exact request that aborted the first live entity sync.
    await client.listSbCampaigns(PROFILE_ID);
    await client.listSbAdGroups(PROFILE_ID);

    const campaignBody = server.requestsFor('/sb/v4/campaigns/list')[0]?.json as { maxResults: number };
    const adGroupBody = server.requestsFor('/sb/v4/adGroups/list')[0]?.json as { maxResults: number };
    expect(campaignBody.maxResults).toBe(100);
    expect(adGroupBody.maxResults).toBe(100);
  });

  it('clamps an over-large explicit maxResults down to the SB ceiling', async () => {
    const { server, client } = clientFor([
      { method: 'POST', match: '/sb/v4/campaigns/list', responses: [{ status: 200, json: SB_CAMPAIGNS }] },
    ]);

    await client.listSbCampaigns(PROFILE_ID, { maxResults: 500 });

    const body = server.requestsFor('/sb/v4/campaigns/list')[0]?.json as { maxResults: number };
    expect(body.maxResults).toBe(100);
  });
});

describe('Sponsored Display', () => {
  it('pages by offset over a bare array and normalises lower-case states', async () => {
    const { server, client } = clientFor([
      {
        method: 'GET',
        match: '/sd/campaigns',
        responses: [
          { status: 200, json: SD_CAMPAIGNS_PAGE_1 },
          { status: 200, json: SD_CAMPAIGNS_PAGE_2 },
        ],
      },
    ]);

    const result = await client.listSdCampaigns(PROFILE_ID, { maxResults: 2, stateFilter: ['ENABLED'] });

    expect(result.pages).toBe(2);
    expect(result.raw).toHaveLength(3);
    expectAccountedFor(result);
    expect(result.items.map((row) => row.state)).toEqual(['enabled', 'paused', 'archived']);
    expect(result.items.every((row) => row.adProduct === 'SD')).toBe(true);

    const requests = server.requestsFor('/sd/campaigns');
    expect(new URL(requests[0]?.url ?? '').searchParams.get('startIndex')).toBe('0');
    expect(new URL(requests[1]?.url ?? '').searchParams.get('startIndex')).toBe('2');
    // Sponsored Display wants lower-case states in the query string.
    expect(new URL(requests[0]?.url ?? '').searchParams.get('stateFilter')).toBe('enabled');
  });

  it('maps ad groups', async () => {
    const { client } = clientFor([
      { method: 'GET', match: '/sd/adGroups', responses: [{ status: 200, json: SD_AD_GROUPS }] },
    ]);
    const result = await client.listSdAdGroups(PROFILE_ID, { maxResults: 500 });

    expect(result.items[0]).toMatchObject({ adProduct: 'SD', defaultBid: 0.55 });
  });
});

describe('response envelopes', () => {
  it('refuses a page whose array key is missing rather than reporting zero rows', async () => {
    const { client } = clientFor([
      { method: 'POST', match: '/sp/campaigns/list', responses: [{ status: 200, json: { items: [], nextToken: null } }] },
    ]);

    await expect(client.listSpCampaigns(PROFILE_ID)).rejects.toBeInstanceOf(AdsApiParseError);
  });

  it('refuses a nextToken that repeats, instead of paging forever', async () => {
    const { client } = clientFor([
      {
        method: 'POST',
        match: '/sp/campaigns/list',
        // The same page, with the same token, for as long as anyone asks.
        responses: [{ status: 200, json: SP_CAMPAIGNS_PAGE_1 }],
      },
    ]);

    await expect(client.listSpCampaigns(PROFILE_ID)).rejects.toThrow(/same nextToken twice/);
  });

  it('stops when a token comes back with an empty page, instead of looping', async () => {
    const { client } = clientFor([
      {
        method: 'POST',
        match: '/sp/campaigns/list',
        responses: [{ status: 200, json: { campaigns: [], nextToken: 'never-ends' } }],
      },
    ]);

    const result = await client.listSpCampaigns(PROFILE_ID);
    expect(result.pages).toBe(1);
    expect(result.items).toHaveLength(0);
  });
});
