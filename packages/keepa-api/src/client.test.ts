import { describe, expect, it } from 'vitest';
import { productEnvelope } from './__fixtures__/payloads.js';
import { createFixtureServer } from './__fixtures__/server.js';
import { KeepaClient } from './client.js';
import { KeepaRetryableError } from './errors.js';
import { keepaMinutesToDate } from './parsers.js';

const apiKey = ['synthetic', 'keepa', 'key'].join('-');

describe('KeepaClient', () => {
  it('calls /product with normalized scope and accounts response tokens', async () => {
    const server = createFixtureServer([{ status: 200, json: productEnvelope(), gzip: true }]);
    const client = new KeepaClient({
      apiKey,
      fetch: server.fetch,
      now: () => keepaMinutesToDate(8_200_000).getTime(),
    });
    const result = await client.products(['b0test0001', 'B0TEST0001'], 'us');

    expect(result).toMatchObject({ requested: 1, returned: 1, missing: [] });
    expect(result.tokenState).toEqual({
      tokensLeft: 100,
      refillInMs: 42_000,
      refillRate: 10,
      tokensConsumed: 4,
      requestsMade: 1,
    });
    const request = server.requests[0];
    expect(request?.pathname).toBe('/product');
    expect(request?.searchParams.get('domain')).toBe('1');
    expect(request?.searchParams.get('asin')).toBe('B0TEST0001');
    expect(request?.searchParams.get('buybox')).toBe('1');
  });

  it('carries refill timing from a 429 and succeeds on the next worker attempt', async () => {
    const server = createFixtureServer([
      { status: 429, json: { tokensLeft: 0, refillIn: 12_500, refillRate: 5, tokensConsumed: 0 } },
      { status: 200, json: productEnvelope({ tokensLeft: 50, refillRate: 5 }) },
    ]);
    const client = new KeepaClient({ apiKey, fetch: server.fetch });

    await expect(client.products(['B0TEST0001'], 'US')).rejects.toMatchObject({
      name: 'KeepaRetryableError',
      retryAfterMs: 13_500,
      tokensLeft: 0,
    });
    // A queue retry constructs a fresh handler/client after the advertised
    // refill time. The fixture route keeps its response sequence across it.
    const retried = new KeepaClient({ apiKey, fetch: server.fetch });
    await expect(retried.products(['B0TEST0001'], 'US')).resolves.toMatchObject({ returned: 1 });
    expect(server.requests).toHaveLength(2);
  });

  it('fails before another call when the known bucket cannot fund the batch', async () => {
    const server = createFixtureServer([
      { status: 200, json: productEnvelope({ tokensLeft: 1, refillIn: 10_000, refillRate: 2 }) },
    ]);
    const client = new KeepaClient({ apiKey, fetch: server.fetch });
    await client.products(['B0TEST0001'], 'US');

    await expect(client.products(['B0TEST0002'], 'US')).rejects.toBeInstanceOf(KeepaRetryableError);
    expect(server.requests).toHaveLength(1);
  });

  it('keeps a bodyless 429 retryable with the conservative refill fallback', async () => {
    const fetch = async () => new Response('', { status: 429 });
    const client = new KeepaClient({ apiKey, fetch });
    await expect(client.products(['B0TEST0001'], 'US')).rejects.toMatchObject({
      name: 'KeepaRetryableError',
      retryAfterMs: 61_000,
    });
  });

  it('hard-fails unknown marketplaces before touching HTTP', async () => {
    const server = createFixtureServer([{ status: 200, json: productEnvelope() }]);
    const client = new KeepaClient({ apiKey, fetch: server.fetch });
    await expect(client.products(['B0TEST0001'], 'XX')).rejects.toThrow(/no Keepa domain/);
    expect(server.requests).toHaveLength(0);
  });
});
