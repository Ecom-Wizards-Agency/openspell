/**
 * Product-specific campaign budget-usage reads and exact response accounting.
 */
import { describe, expect, it } from 'vitest';
import { AdsApiClient } from './client.js';
import {
  BUDGET_USAGE_ENDPOINTS,
  batchCampaignIds,
  buildBudgetUsageBody,
  parseBudgetUsageResponse,
} from './budgets.js';
import { createMockServer, lwaRoute, type RecordedResponse } from './__fixtures__/server.js';
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

function successResponse(campaignIds: readonly string[]): RecordedResponse {
  return {
    status: 200,
    json: {
      error: [],
      success: campaignIds.map((campaignId, index) => ({
        index,
        campaignId,
        budget: 10 + index,
        budgetUsagePercent: index,
        usageUpdatedTimestamp: '2026-08-14T09:00:00Z',
      })),
    },
  };
}

describe('budget usage request metadata', () => {
  it('uses the three official product-specific paths', () => {
    expect(BUDGET_USAGE_ENDPOINTS).toEqual({
      SP: {
        path: '/sp/campaigns/budget/usage',
        accept: 'application/vnd.spcampaignbudgetusage.v1+json',
        contentType: 'application/json',
      },
      SB: {
        path: '/sb/campaigns/budget/usage',
        accept: 'application/json',
        contentType: 'application/json',
      },
      SD: {
        path: '/sd/campaigns/budget/usage',
        accept: 'application/json',
        contentType: 'application/json',
      },
    });
  });

  it('sends only campaignIds, without an invented adProduct discriminator', () => {
    expect(buildBudgetUsageBody(['one', 'two'])).toEqual({ campaignIds: ['one', 'two'] });
  });
});

describe('batching', () => {
  it('uses the conservative local bound and loses nothing', () => {
    const ids = Array.from({ length: 250 }, (_, index) => `campaign-${index}`);
    const batches = batchCampaignIds(ids);

    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(ids);
  });

  it('produces no batch at all for no ids', () => {
    expect(batchCampaignIds([])).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid batch size %s', (size) => {
    expect(() => batchCampaignIds(['one'], size)).toThrow('positive integer');
  });
});

describe('response parsing', () => {
  const requested = ['100000000000001', '100000000000002', '100000000000003'];

  it('keeps every success and failure and binds them by exact request index', () => {
    const parsed = parseBudgetUsageResponse(BUDGET_USAGE_RESPONSE, requested);

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
    expect(parsed.usage.length + parsed.failures.length).toBe(requested.length);
  });

  it('derives a failed campaign id from the request and reads nested errors', () => {
    const parsed = parseBudgetUsageResponse(
      {
        success: [],
        error: [{ index: 0, errors: [{ code: 'THROTTLED', message: 'try later' }] }],
      },
      ['requested-campaign'],
    );
    expect(parsed.failures).toEqual([
      { campaignId: 'requested-campaign', code: 'THROTTLED', details: 'try later' },
    ]);
  });

  it.each([
    ['non-object body', null, ['one']],
    ['missing success array', { error: [] }, []],
    ['missing error array', { success: [] }, []],
    ['non-object success row', { success: [null], error: [] }, ['one']],
    [
      'out-of-range index',
      {
        success: [
          {
            index: 1,
            campaignId: 'one',
            budget: 1,
            budgetUsagePercent: 2,
            usageUpdatedTimestamp: '2026-08-14T09:00:00Z',
          },
        ],
        error: [],
      },
      ['one'],
    ],
    [
      'mismatched success id',
      {
        success: [
          {
            index: 0,
            campaignId: 'wrong',
            budget: 1,
            budgetUsagePercent: 2,
            usageUpdatedTimestamp: '2026-08-14T09:00:00Z',
          },
        ],
        error: [],
      },
      ['one'],
    ],
    [
      'missing success metric',
      {
        success: [
          {
            index: 0,
            campaignId: 'one',
            budget: 1,
            usageUpdatedTimestamp: '2026-08-14T09:00:00Z',
          },
        ],
        error: [],
      },
      ['one'],
    ],
    [
      'duplicate index',
      {
        success: [
          {
            index: 0,
            campaignId: 'one',
            budget: 1,
            budgetUsagePercent: 2,
            usageUpdatedTimestamp: '2026-08-14T09:00:00Z',
          },
        ],
        error: [{ index: 0, campaignId: 'one', code: 'ALSO_FAILED' }],
      },
      ['one'],
    ],
    ['missing output index', { success: [], error: [] }, ['one']],
    [
      'mismatched failure id',
      { success: [], error: [{ index: 0, campaignId: 'wrong', code: 'NOT_FOUND' }] },
      ['one'],
    ],
  ] as const)('fails closed for %s', (_label, body, ids) => {
    expect(() => parseBudgetUsageResponse(body, ids)).toThrow(/budget usage/);
  });
});

describe('client.getBudgetUsage', () => {
  it.each([
    ['SP', '/sp/campaigns/budget/usage', 'application/vnd.spcampaignbudgetusage.v1+json'],
    ['SB', '/sb/campaigns/budget/usage', 'application/json'],
    ['SD', '/sd/campaigns/budget/usage', 'application/json'],
  ] as const)('uses the exact %s endpoint, headers, and body', async (product, path, accept) => {
    const { server, client } = clientFor([
      { method: 'POST', match: path, responses: [successResponse(['campaign-one'])] },
    ]);

    const result = await client.getBudgetUsage(PROFILE_ID, product, ['campaign-one']);

    expect(result).toMatchObject({ requested: 1 });
    expect(result.usage).toHaveLength(1);
    expect(result.failures).toHaveLength(0);
    const request = server.requestsFor(path)[0];
    expect(request?.headers['accept']).toBe(accept);
    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.json).toEqual({ campaignIds: ['campaign-one'] });
  });

  it('sends one request per local batch and accounts for every answer', async () => {
    const ids = Array.from({ length: 201 }, (_, index) => `campaign-${index}`);
    const batches = batchCampaignIds(ids);
    const path = '/sd/campaigns/budget/usage';
    const { server, client } = clientFor([
      { method: 'POST', match: path, responses: batches.map(successResponse) },
    ]);

    const result = await client.getBudgetUsage(PROFILE_ID, 'SD', ids);

    expect(server.requestsFor(path)).toHaveLength(3);
    expect(result.usage).toHaveLength(201);
    expect(result.failures).toHaveLength(0);
    expect(result.requested).toBe(201);
    expect(result.usage.length + result.failures.length).toBe(result.requested);
  });

  it.each([429, 503])('retries the POST read after HTTP %s', async (status) => {
    const path = '/sp/campaigns/budget/usage';
    const { server, client } = clientFor([
      {
        method: 'POST',
        match: path,
        responses: [{ status, json: { code: 'RETRY' } }, successResponse(['campaign-one'])],
      },
    ]);

    const result = await client.getBudgetUsage(PROFILE_ID, 'SP', ['campaign-one']);

    expect(result.usage).toHaveLength(1);
    expect(server.requestsFor(path)).toHaveLength(2);
  });

  it('propagates response-accounting failures instead of returning partial evidence', async () => {
    const path = '/sb/campaigns/budget/usage';
    const { client } = clientFor([
      { method: 'POST', match: path, responses: [{ status: 200, json: { success: [], error: [] } }] },
    ]);

    await expect(client.getBudgetUsage(PROFILE_ID, 'SB', ['campaign-one'])).rejects.toThrow(
      'accounted for 0 of 1',
    );
  });

  it('makes no call at all when there is nothing to ask about', async () => {
    const path = '/sp/campaigns/budget/usage';
    const { server, client } = clientFor([
      { method: 'POST', match: path, responses: [successResponse([])] },
    ]);

    const result = await client.getBudgetUsage(PROFILE_ID, 'SP', []);

    expect(server.requestsFor(path)).toHaveLength(0);
    expect(result).toEqual({ usage: [], failures: [], requested: 0 });
  });
});
