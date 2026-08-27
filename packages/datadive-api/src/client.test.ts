import { describe, expect, it } from 'vitest';
import { DataDiveClient } from './client.js';
import { DataDiveParseError } from './errors.js';
import { QUOTA, RADAR_ONE, RADAR_TWO, RANK_DATA } from './__fixtures__/payloads.js';
import { createMockServer, testEffects } from './__fixtures__/server.js';

const BASE_URL = 'https://datadive.invalid';
const TEST_CREDENTIAL = 'fake-api-key';

function client(server: ReturnType<typeof createMockServer>): DataDiveClient {
  const effects = testEffects();
  return new DataDiveClient({
    apiKey: TEST_CREDENTIAL,
    baseUrl: BASE_URL,
    fetch: server.fetch,
    sleep: effects.sleep,
    now: effects.now,
    random: effects.random,
  });
}

describe('DataDiveClient', () => {
  it('walks every Rank Radar page and authenticates each request', async () => {
    const server = createMockServer([{
      method: 'GET',
      match: '/v1/niches/rank-radars',
      responses: [
        { status: 200, json: { currentPage: 1, pageSize: 50, hasNext: true, hasPrev: false, lastPage: 2, total: 2, data: [RADAR_ONE] } },
        { status: 200, json: { currentPage: 2, pageSize: 50, hasNext: false, hasPrev: true, lastPage: 2, total: 2, data: [RADAR_TWO] } },
      ],
    }]);

    const result = await client(server).listRankRadars();

    expect(result).toMatchObject({ pages: 2, total: 2 });
    expect(result.items.map((radar) => radar.id)).toEqual(['radar-synthetic-1', 'radar-synthetic-2']);
    expect(server.requests.map((request) => request.query.get('currentPage'))).toEqual(['1', '2']);
    expect(server.requests.every((request) => request.headers['x-api-key'] === TEST_CREDENTIAL)).toBe(true);
    expect(server.requests.every((request) => request.headers['accept'] === 'application/json')).toBe(true);
  });

  it('refuses a list whose declared total does not match the artifact', async () => {
    const server = createMockServer([{
      method: 'GET', match: '/v1/niches/rank-radars', responses: [
        { status: 200, json: { currentPage: 1, pageSize: 50, hasNext: false, hasPrev: false, lastPage: 1, total: 2, data: [RADAR_ONE] } },
      ],
    }]);
    await expect(client(server).listRankRadars()).rejects.toThrow(DataDiveParseError);
  });

  it('requests the exact rank date range and retains unmodeled response details', async () => {
    const server = createMockServer([{
      method: 'GET', match: '/v1/niches/rank-radars/radar-synthetic-1', responses: [
        { status: 200, json: RANK_DATA },
      ],
    }]);
    const result = await client(server).getRankRadarData('radar-synthetic-1', {
      startDate: '2026-08-26', endDate: '2026-08-27',
    });

    expect(result.keywords).toHaveLength(2);
    expect(result.keywords[0]?.ranks[0]).toMatchObject({ date: '2026-08-26', organicRank: 19 });
    expect(result.keywords[0]?.ranks[0]?.details).toEqual({ impressionRank: 4 });
    expect(result.keywords[1]?.details).toHaveProperty('highlights');
    expect(server.requests[0]?.query.get('startDate')).toBe('2026-08-26');
    expect(server.requests[0]?.query.get('endDate')).toBe('2026-08-27');
  });

  it('gets the Rank Radar quota budget guard', async () => {
    const server = createMockServer([{
      method: 'GET', match: '/v1/quota', responses: [{ status: 200, json: QUOTA }],
    }]);
    const quota = await client(server).getQuota();
    expect(quota.features.RANK_RADAR_KEYWORDS).toMatchObject({ used: 3, capacity: 500 });
    expect(quota.nextRefreshDate).toBe('2026-09-01T00:00:00.000Z');
  });
});
