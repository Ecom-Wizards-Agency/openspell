/**
 * Budget usage.
 *
 * Amazon reports per-campaign failures *inside* a 200 response, which is the
 * trap this endpoint sets: read `success` and nothing else and campaigns
 * disappear from the pacing view with no error anywhere. Both halves are kept
 * and both are counted against what was asked for.
 */
import { describe, expect, it } from 'vitest';
import { AdsApiClient } from './client.js';
import { batchCampaignIds, parseBudgetUsageResponse } from './budgets.js';
import { createMockServer, lwaRoute } from './__fixtures__/server.js';
import { BUDGET_USAGE_RESPONSE, PROFILE_ID } from './__fixtures__/payloads.js';

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

describe('batching', () => {
  it('splits at Amazon’s documented limit and loses nothing', () => {
    const ids = Array.from({ length: 250 }, (_, index) => `campaign-${index}`);
    const batches = batchCampaignIds(ids);

    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(ids);
  });

  it('produces no batch at all for no ids', () => {
    expect(batchCampaignIds([])).toEqual([]);
  });
});

describe('response parsing', () => {
  it('keeps the per-campaign failures Amazon hides inside a 200', () => {
    const parsed = parseBudgetUsageResponse(BUDGET_USAGE_RESPONSE);

    expect(parsed.usage).toHaveLength(2);
    expect(parsed.failures).toEqual([
      { campaignId: '100000000000003', code: 'NOT_FOUND', details: 'campaign not found' },
    ]);
    expect(parsed.usage[0]).toEqual({
      campaignId: '100000000000001',
      budget: 42.5,
      budgetUsagePercent: 87.3,
      usageUpdatedTimestamp: '2026-08-14T09:00:00Z',
    });
  });

  it('reads the plural error key too, because both spellings appear', () => {
    const parsed = parseBudgetUsageResponse({
      success: [],
      errors: [{ campaignId: '1', code: 'THROTTLED', message: 'try later' }],
    });
    expect(parsed.failures[0]).toEqual({ campaignId: '1', code: 'THROTTLED', details: 'try later' });
  });
});

describe('client.getBudgetUsage', () => {
  it('accounts for every campaign it asked about', async () => {
    const { server, client } = clientFor([
      { method: 'POST', match: '/budgets/usage/campaigns', responses: [{ status: 200, json: BUDGET_USAGE_RESPONSE }] },
    ]);

    const result = await client.getBudgetUsage(PROFILE_ID, 'SP', [
      '100000000000001',
      '100000000000002',
      '100000000000003',
    ]);

    expect(result.requested).toBe(3);
    expect(result.usage.length + result.failures.length).toBe(result.requested);

    const request = server.requestsFor('/budgets/usage/campaigns')[0];
    expect(request?.headers['content-type']).toBe('application/vnd.budgetusage.v1+json');
    expect(request?.json).toEqual({
      adProduct: 'SPONSORED_PRODUCTS',
      campaignIds: ['100000000000001', '100000000000002', '100000000000003'],
    });
  });

  it('sends one request per batch and merges the answers', async () => {
    const { server, client } = clientFor([
      {
        method: 'POST',
        match: '/budgets/usage/campaigns',
        responses: [{ status: 200, json: { success: [{ campaignId: 'x', budget: 1, budgetUsagePercent: 5 }] } }],
      },
    ]);

    const ids = Array.from({ length: 201 }, (_, index) => `campaign-${index}`);
    const result = await client.getBudgetUsage(PROFILE_ID, 'SD', ids);

    expect(server.requestsFor('/budgets/usage/campaigns')).toHaveLength(3);
    expect(result.usage).toHaveLength(3);
    expect(result.requested).toBe(201);
    expect(server.requestsFor('/budgets/usage/campaigns')[0]?.json).toMatchObject({
      adProduct: 'SPONSORED_DISPLAY',
    });
  });

  it('makes no call at all when there is nothing to ask about', async () => {
    const { server, client } = clientFor([
      { method: 'POST', match: '/budgets/usage/campaigns', responses: [{ status: 200, json: { success: [] } }] },
    ]);

    const result = await client.getBudgetUsage(PROFILE_ID, 'SP', []);

    expect(server.requestsFor('/budgets/usage/campaigns')).toHaveLength(0);
    expect(result).toEqual({ usage: [], failures: [], requested: 0 });
  });
});
