import { describe, expect, it } from 'vitest';
import { SYNTHETIC_PRODUCT } from './__fixtures__/payloads.js';
import {
  CSV_BUY_BOX_PRICE,
  currentProductValues,
  decodeHistory,
  keepaMinutesToDate,
  parseProduct,
} from './parsers.js';

describe('Keepa product parsing', () => {
  it('uses the 2011 epoch and decodes shipping-bearing prices with the right stride', () => {
    expect(keepaMinutesToDate(0).toISOString()).toBe('2011-01-01T00:00:00.000Z');
    expect(decodeHistory(SYNTHETIC_PRODUCT.csv, CSV_BUY_BOX_PRICE).map((point) => point.value))
      .toEqual([23.99, 19.99]);
  });

  it('maps synthetic history and current values without treating sentinels as zero', () => {
    const now = keepaMinutesToDate(8_200_000).getTime();
    const product = parseProduct(SYNTHETIC_PRODUCT, now);
    expect(product).toMatchObject({
      asin: 'B0TEST0001',
      category: '12345',
      categoryName: 'Synthetic widgets',
      coupon: [-10, 0],
      lightningDeal: true,
    });
    expect(currentProductValues(product)).toMatchObject({
      bsr: 3100,
      price: 19.99,
      buyBoxPrice: 19.99,
      rating: 4.5,
      reviewCount: 83,
    });
  });

  it('keeps missing deal flags explicitly unknown', () => {
    const product = parseProduct({ asin: 'B0TEST0002', csv: [] }, Date.now());
    expect(product.lightningDeal).toBeNull();
    expect(product.coupon).toBeNull();
  });
});
