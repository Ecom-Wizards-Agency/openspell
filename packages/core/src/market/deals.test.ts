import { describe, expect, it } from 'vitest';
import { detectCompetitorDeals, rollingPriceBaseline } from './deals.js';
import type { MarketObservation, MarketPricePoint } from './deals.js';

const at = (day: number) => new Date(Date.UTC(2026, 7, day));
const prices = (...values: number[]): MarketPricePoint[] =>
  values.map((value, index) => ({ observedAt: at(index + 1), value }));
const observation = (overrides: Partial<MarketObservation> = {}): MarketObservation => ({
  asin: 'B0TEST0002',
  observedAt: at(10),
  price: 80,
  lightningDeal: false,
  coupon: [0, 0],
  ...overrides,
});

describe('competitor deal detection', () => {
  it('uses the median of prior points as a rolling baseline', () => {
    expect(rollingPriceBaseline(prices(100, 102, 98, 80))).toBe(100);
  });

  it('emits price, lightning, and coupon starts once on known transitions', () => {
    const events = detectCompetitorDeals({
      previous: observation({ observedAt: at(9), price: 100 }),
      current: observation({ lightningDeal: true, coupon: [-10, 0] }),
      priceHistory: prices(100, 102, 98, 80),
    });
    expect(events.map((item) => item.eventKind)).toEqual([
      'deal_start',
      'coupon_start',
      'price_drop',
    ]);
    expect(events.every((item) => item.baselinePrice === 100)).toBe(true);
  });

  it('emits ends/restores when known state returns to baseline', () => {
    const events = detectCompetitorDeals({
      previous: observation({ observedAt: at(9), price: 80, lightningDeal: true, coupon: [-10, 0] }),
      current: observation({ price: 100 }),
      priceHistory: prices(100, 102, 98, 80, 100),
    });
    expect(events.map((item) => item.eventKind)).toEqual([
      'deal_end',
      'coupon_end',
      'price_restore',
    ]);
  });

  it('emits nothing when either side is unknown', () => {
    expect(detectCompetitorDeals({
      previous: observation({ price: null, lightningDeal: null, coupon: null }),
      current: observation({ price: null, lightningDeal: null, coupon: null }),
      priceHistory: prices(100, 80),
    })).toEqual([]);
    expect(detectCompetitorDeals({
      previous: null,
      current: observation({ lightningDeal: true, coupon: [-10, 0] }),
      priceHistory: prices(100, 80),
    })).toEqual([]);
  });
});
