import { describe, expect, it } from 'vitest';
import { MrpParseError, MrpToolCallError } from './errors.js';
import { parseProductMetrics, parseSellerLine, parseSellers } from './parser.js';
import {
  SYNTHETIC_PRODUCT_METRICS,
  SYNTHETIC_SELLERS_PROSE,
} from './__fixtures__/payloads.js';

describe('MRP seller prose parser', () => {
  it('parses numbered lines tolerantly and ignores unknown fields and headings', () => {
    const parsed = parseSellers({ result: SYNTHETIC_SELLERS_PROSE });
    expect(parsed).toEqual({
      ignoredLines: 1,
      sellers: [
        {
          number: 1,
          name: 'Example Labs',
          sellerId: 123450001,
          sellingPartnerId: 'PARTNER-ONE',
          region: 'North America',
          access: 'owned',
        },
        {
          number: 2,
          name: 'Sample Island',
          sellerId: 123450002,
          sellingPartnerId: 'PARTNER-TWO',
          region: 'Europe',
          access: 'shared',
        },
      ],
    });
  });

  it('accepts spacing/case variation in labels and skips malformed lines', () => {
    expect(parseSellerLine(
      ' 7.  Spaced Seller | SELLER ID : 9001 | Region: North America | Extra: retained nowhere ',
    )).toMatchObject({
      number: 7,
      name: 'Spaced Seller',
      sellerId: 9001,
      sellingPartnerId: null,
      access: null,
    });
    expect(parseSellerLine('seller id: 9001')).toBeNull();
    expect(parseSellerLine('8. Missing id | Region: Europe')).toBeNull();
    expect(() => parseSellers({ result: 'No sellers connected' })).toThrow(MrpParseError);
  });
});

describe('MRP live product-metrics parser', () => {
  it('JSON-parses result, maps compatible fields, and retains sales/profit/PPC details', () => {
    const metrics = parseProductMetrics({
      result: JSON.stringify(SYNTHETIC_PRODUCT_METRICS),
    }, 'B0TEST4401');

    expect(metrics.period).toEqual({
      from: '2026-08-26',
      to: '2026-08-26',
      days: 1,
      complete: true,
      dataAvailableThrough: {
        orders: '2026-08-26',
        advertising: '2026-08-26',
        traffic: '2026-08-26',
      },
      incompleteSources: [],
      note: null,
    });
    expect(metrics.product).toMatchObject({
      asin: 'B0TEST4401',
      salePrice: 39.99,
      cogs: 11.25,
      fbaFees: 4.75,
      referralFees: 6,
      otherFees: 1.25,
      margin: 0.4185,
      currency: 'USD',
      details: {
        sales: { revenue: 399.9, units: 10 },
        profitability: { profit: 16.74, profit_margin: '0.4185' },
        advertising: { ppc_spend: 42.5 },
      },
    });
    expect(metrics.product.margin).not.toBe(0.99);
  });

  it('accepts partial-period metadata for the worker to gate', () => {
    const metrics = parseProductMetrics({
      result: JSON.stringify({
        ...SYNTHETIC_PRODUCT_METRICS,
        period: {
          ...SYNTHETIC_PRODUCT_METRICS.period,
          complete: false,
          data_available_through: { orders: '2026-08-25', advertising: null },
          incomplete_sources: ['orders', 'advertising'],
          note: 'Still loading',
        },
      }),
    });
    expect(metrics.period).toMatchObject({
      complete: false,
      dataAvailableThrough: { orders: '2026-08-25', advertising: null },
      incompleteSources: ['orders', 'advertising'],
      note: 'Still loading',
    });
  });

  it('turns a non-JSON provider result into a readable tool error', () => {
    expect(() => parseProductMetrics({ result: 'No metrics available for this ASIN yet' }))
      .toThrow(MrpToolCallError);
    expect(() => parseProductMetrics({ result: '{}' })).toThrow(/product\/period/);
  });
});
