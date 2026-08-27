const point = (minutes: number, value: number): number[] => [minutes, value];

export const SYNTHETIC_PRODUCT = {
  asin: 'B0TEST0001',
  lastUpdate: 8_200_000,
  salesRankReference: 12345,
  categoryTree: [{ catId: 12345, name: 'Synthetic widgets' }],
  coupon: [-10, 0],
  csv: Array.from({ length: 19 }, () => null) as Array<number[] | null>,
};

SYNTHETIC_PRODUCT.csv[1] = [...point(8_199_000, 2499), ...point(8_200_000, 1999)];
SYNTHETIC_PRODUCT.csv[3] = [...point(8_199_000, 4200), ...point(8_200_000, 3100)];
SYNTHETIC_PRODUCT.csv[8] = [...point(8_199_900, 1799), ...point(8_200_100, -1)];
SYNTHETIC_PRODUCT.csv[16] = [...point(8_199_000, 44), ...point(8_200_000, 45)];
SYNTHETIC_PRODUCT.csv[17] = [...point(8_199_000, 80), ...point(8_200_000, 83)];
SYNTHETIC_PRODUCT.csv[18] = [8_199_000, 2399, 0, 8_200_000, 1899, 100];

export const productEnvelope = (overrides: Record<string, unknown> = {}) => ({
  tokensLeft: 100,
  refillIn: 42_000,
  refillRate: 10,
  tokensConsumed: 4,
  products: [SYNTHETIC_PRODUCT],
  ...overrides,
});
