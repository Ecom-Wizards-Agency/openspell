import { describe, expect, it } from 'vitest';
import { DataDiveClient } from './client.js';
import { DataDiveThrottleError } from './errors.js';
import { parseRetryAfter } from './http.js';
import { QUOTA } from './__fixtures__/payloads.js';
import { createMockServer, testEffects } from './__fixtures__/server.js';

describe('DataDive HTTP retry', () => {
  it('honours Retry-After on 429 before succeeding', async () => {
    const server = createMockServer([{
      method: 'GET', match: '/v1/quota', responses: [
        { status: 429, headers: { 'retry-after': '5' }, json: { message: 'busy' } },
        { status: 200, json: QUOTA },
      ],
    }]);
    const effects = testEffects();
    const client = new DataDiveClient({
      apiKey: 'fake-api-key', baseUrl: 'https://datadive.invalid', fetch: server.fetch,
      sleep: effects.sleep, now: effects.now, random: effects.random,
    });

    await client.getQuota();
    expect(effects.slept).toEqual([5_000]);
    expect(server.requests).toHaveLength(2);
  });

  it('throws a typed throttle after bounded attempts', async () => {
    const server = createMockServer([{
      method: 'GET', match: '/v1/quota', responses: [
        { status: 429, headers: { 'retry-after': '2' }, json: { message: 'busy' } },
      ],
    }]);
    const effects = testEffects();
    const client = new DataDiveClient({
      apiKey: 'fake-api-key', baseUrl: 'https://datadive.invalid', fetch: server.fetch,
      sleep: effects.sleep, now: effects.now, random: effects.random,
    });
    const error = await client.getQuota().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DataDiveThrottleError);
    expect((error as DataDiveThrottleError).retryAfterMs).toBe(2_000);
    expect(server.requests).toHaveLength(4);
    expect(effects.slept).toEqual([2_000, 2_000, 2_000]);
  });

  it('parses both legal Retry-After forms', () => {
    const now = Date.parse('2026-08-27T00:00:00Z');
    expect(parseRetryAfter('3', now)).toBe(3_000);
    expect(parseRetryAfter('Thu, 27 Aug 2026 00:00:05 GMT', now)).toBe(5_000);
    expect(parseRetryAfter('later', now)).toBeNull();
  });
});
