export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface KeepaClientOptions {
  apiKey: string;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
}

export interface ProductRequestOptions {
  history?: boolean;
  rating?: boolean;
  buyBox?: boolean;
  updateHours?: number | null;
}

export interface ObservationPoint<T> {
  observedAt: Date;
  value: T;
}

/** `[one-time coupon, Subscribe & Save first-order coupon]`, exactly as Keepa sends it. */
export type KeepaCoupon = readonly [number, number];

export interface KeepaProduct {
  asin: string;
  /** Stable Keepa/Amazon category id. Empty means Keepa did not establish one. */
  category: string;
  categoryName: string | null;
  updatedAt: Date | null;
  salesRank: readonly ObservationPoint<number>[];
  newPrice: readonly ObservationPoint<number>[];
  buyBoxPrice: readonly ObservationPoint<number>[];
  rating: readonly ObservationPoint<number>[];
  reviewCount: readonly ObservationPoint<number>[];
  lightningDeal: boolean | null;
  coupon: KeepaCoupon | null;
}

export interface CurrentProductValues {
  asin: string;
  category: string;
  observedAt: Date | null;
  bsr: number | null;
  price: number | null;
  buyBoxPrice: number | null;
  rating: number | null;
  reviewCount: number | null;
  lightningDeal: boolean | null;
  coupon: KeepaCoupon | null;
}

export interface KeepaTokenState {
  tokensLeft: number | null;
  refillInMs: number | null;
  refillRate: number | null;
  tokensConsumed: number;
  requestsMade: number;
}

export interface KeepaProductsResult {
  requested: number;
  returned: number;
  missing: string[];
  products: KeepaProduct[];
  tokenState: KeepaTokenState;
}
