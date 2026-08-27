import { describe, expect, it, vi } from 'vitest';
import { KeepaRetryableError, keepaMinutesToDate, parseProduct } from '@wizard-ads/keepa-api';
import type { KeepaProductsResult } from '@wizard-ads/keepa-api';
import type { NewCompetitorPriceEvent } from '@wizard-ads/db';
import { AdsApiRetryableError } from './ads-api.js';
import { runKeepaSync } from './keepa.js';
import type { KeepaSyncDeps } from './keepa.js';

const orgId = '11111111-1111-4111-8111-111111111111';
const profileId = '22222222-2222-4222-8222-222222222222';
const connectionId = '33333333-3333-4333-8333-333333333333';
const observedAt = keepaMinutesToDate(8_200_000);
const raw = (asin: string, price: number, lightning = false, coupon: [number, number] = [0, 0]) => {
  const csv = Array.from({ length: 19 }, () => null) as Array<number[] | null>;
  csv[1] = [8_199_000, 10000, 8_200_000, price * 100];
  csv[3] = [8_200_000, 1000];
  csv[8] = lightning ? [8_199_900, price * 100, 8_200_100, -1] : [8_199_900, -1];
  csv[18] = [8_199_000, 10000, 0, 8_200_000, price * 100, 0];
  return parseProduct({ asin, lastUpdate: 8_200_000, salesRankReference: 123, coupon, csv }, observedAt.getTime());
};

function deps(result: KeepaProductsResult): KeepaSyncDeps {
  return {
    activeConnection: vi.fn().mockResolvedValue({ id: connectionId, config: {} }),
    readCredential: vi.fn().mockResolvedValue('synthetic-key'),
    scope: vi.fn().mockResolvedValue({
      marketplace: 'US',
      ownAsins: ['B0TEST0001'],
      competitorLinks: [{
        id: 'link-1', orgId, profileId, profileLabel: 'Profile', marketplace: 'US',
        ourAsin: 'B0TEST0001', competitorAsin: 'B0TEST0002', enabled: true, createdAt: observedAt,
      }],
    }),
    previous: vi.fn().mockResolvedValue([{
      asin: 'B0TEST0002', observedAt: keepaMinutesToDate(8_199_000), category: '123',
      price: 100, buyBoxPrice: 100, lightningDeal: false, coupon: [0, 0],
    }]),
    loadObservations: vi.fn().mockResolvedValue({ offered: 2, existing: 0, written: 2 }),
    loadEvents: vi.fn(async (rows: readonly NewCompetitorPriceEvent[]) => ({
      offered: rows.length,
      existing: 0,
      written: rows.length,
      inserted: rows.map((row) => ({ asin: row.asin, eventKind: row.eventKind, detectedAt: row.detectedAt })),
    })),
    writeInsight: vi.fn().mockResolvedValue('insight-1'),
    markSynced: vi.fn().mockResolvedValue(undefined),
    createClient: vi.fn().mockReturnValue({ products: vi.fn().mockResolvedValue(result) }),
    now: () => observedAt,
  };
}

describe('Keepa sync handler', () => {
  it('loads all accounted observations, new competitor transitions, and a deal-start insight', async () => {
    const products = [raw('B0TEST0001', 95), raw('B0TEST0002', 80, true, [-10, 0])];
    const state = deps({
      requested: 2, returned: 2, missing: [], products,
      tokenState: { tokensLeft: 50, refillInMs: 1_000, refillRate: 10, tokensConsumed: 8, requestsMade: 1 },
    });
    const result = await runKeepaSync(state, {
      type: 'keepa.sync', orgId, profileId, includeCompetitors: true,
    });

    expect(result).toMatchObject({ observationsWritten: 2, eventsWritten: 3, insights: 1 });
    expect(state.loadEvents).toHaveBeenCalledBefore(state.loadObservations as ReturnType<typeof vi.fn>);
    expect(state.writeInsight).toHaveBeenCalledWith(expect.objectContaining({
      asin: 'B0TEST0002', linkedOurAsins: ['B0TEST0001'],
    }));
    expect(state.markSynced).toHaveBeenCalledWith(connectionId, observedAt);
  });

  it('rejects an explicit ASIN outside advertised/link scope', async () => {
    const state = deps({
      requested: 0, returned: 0, missing: [], products: [],
      tokenState: { tokensLeft: null, refillInMs: null, refillRate: null, tokensConsumed: 0, requestsMade: 0 },
    });
    await expect(runKeepaSync(state, {
      type: 'keepa.sync', orgId, profileId, includeCompetitors: true, asins: ['B0TEST9999'],
    })).rejects.toThrow(/outside.*scope/i);
    expect(state.createClient).not.toHaveBeenCalled();
  });

  it('maps token exhaustion onto the worker retry delay', async () => {
    const state = deps({
      requested: 0, returned: 0, missing: [], products: [],
      tokenState: { tokensLeft: null, refillInMs: null, refillRate: null, tokensConsumed: 0, requestsMade: 0 },
    });
    state.createClient = vi.fn().mockReturnValue({
      products: vi.fn().mockRejectedValue(new KeepaRetryableError('refill', 12_500, 0, 4)),
    });
    await expect(runKeepaSync(state, {
      type: 'keepa.sync', orgId, profileId, includeCompetitors: true,
    })).rejects.toMatchObject({ name: 'AdsApiRetryableError', retryAfterSeconds: 13 });
    await runKeepaSync(state, {
      type: 'keepa.sync', orgId, profileId, includeCompetitors: true,
    }).catch((error: unknown) => expect(error).toBeInstanceOf(AdsApiRetryableError));
  });
});
