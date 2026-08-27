import { KeepaParseError } from './errors.js';
import type {
  CurrentProductValues,
  KeepaCoupon,
  KeepaProduct,
  ObservationPoint,
} from './types.js';

export const KEEPA_EPOCH_MS = Date.UTC(2011, 0, 1);
export const CSV_NEW_PRICE = 1;
export const CSV_SALES_RANK = 3;
export const CSV_LIGHTNING_DEAL = 8;
export const CSV_RATING = 16;
export const CSV_REVIEW_COUNT = 17;
export const CSV_BUY_BOX_PRICE = 18;

const SHIPPING_TRACKS = new Set([CSV_BUY_BOX_PRICE]);

export function keepaMinutesToDate(minutes: number): Date {
  return new Date(KEEPA_EPOCH_MS + Math.trunc(minutes) * 60_000);
}

/** Decode a csv history into domain units, dropping Keepa's `-1` no-data sentinel. */
export function decodeHistory(
  csv: unknown,
  index: number,
): ObservationPoint<number>[] {
  if (!Array.isArray(csv)) return [];
  const raw = csv[index];
  if (!Array.isArray(raw)) return [];
  const shipping = SHIPPING_TRACKS.has(index);
  const stride = shipping ? 3 : 2;
  const divisor = index === CSV_NEW_PRICE || index === CSV_BUY_BOX_PRICE ? 100 : 1;
  const ratingDivisor = index === CSV_RATING ? 10 : 1;
  const points: ObservationPoint<number>[] = [];

  for (let offset = 0; offset + stride <= raw.length; offset += stride) {
    const minutes = finiteNumber(raw[offset]);
    let value = finiteNumber(raw[offset + 1]);
    if (minutes === null || value === null || value < 0) continue;
    if (shipping) {
      const shippingValue = finiteNumber(raw[offset + 2]);
      if (shippingValue !== null && shippingValue > 0) value += shippingValue;
    }
    points.push({
      observedAt: keepaMinutesToDate(minutes),
      value: value / divisor / ratingDivisor,
    });
  }
  return points;
}

export function currentValue<T>(series: readonly ObservationPoint<T>[]): ObservationPoint<T> | null {
  return series.at(-1) ?? null;
}

export function parseProduct(raw: unknown, nowMs: number): KeepaProduct {
  if (!isRecord(raw)) throw new KeepaParseError('Keepa product is not an object');
  const asin = typeof raw['asin'] === 'string' ? raw['asin'].trim().toUpperCase() : '';
  if (!asin) throw new KeepaParseError('Keepa product has no ASIN');

  const csv = raw['csv'];
  const categoryId = finiteNumber(raw['salesRankReference']);
  const category = categoryId === null || categoryId < 0 ? '' : String(Math.trunc(categoryId));
  const categoryName = readCategoryName(raw['categoryTree'], category);
  const updatedMinutes = finiteNumber(raw['lastUpdate']);

  return {
    asin,
    category,
    categoryName,
    updatedAt: updatedMinutes === null || updatedMinutes < 0 ? null : keepaMinutesToDate(updatedMinutes),
    salesRank: decodeHistory(csv, CSV_SALES_RANK),
    newPrice: decodeHistory(csv, CSV_NEW_PRICE),
    buyBoxPrice: decodeHistory(csv, CSV_BUY_BOX_PRICE),
    rating: decodeHistory(csv, CSV_RATING),
    reviewCount: decodeHistory(csv, CSV_REVIEW_COUNT),
    lightningDeal: currentLightningDeal(csv, nowMs),
    coupon: parseCoupon(raw['coupon']),
  };
}

export function currentProductValues(product: KeepaProduct): CurrentProductValues {
  const rank = currentValue(product.salesRank);
  const price = currentValue(product.newPrice);
  const buyBoxPrice = currentValue(product.buyBoxPrice);
  const rating = currentValue(product.rating);
  const reviewCount = currentValue(product.reviewCount);
  const latest = [
    product.updatedAt,
    rank?.observedAt,
    price?.observedAt,
    buyBoxPrice?.observedAt,
    rating?.observedAt,
    reviewCount?.observedAt,
  ].filter((value): value is Date => value instanceof Date);

  return {
    asin: product.asin,
    category: product.category,
    observedAt: latest.length === 0
      ? null
      : new Date(Math.max(...latest.map((value) => value.getTime()))),
    bsr: rank?.value ?? null,
    price: price?.value ?? null,
    buyBoxPrice: buyBoxPrice?.value ?? null,
    rating: rating?.value ?? null,
    reviewCount: reviewCount?.value ?? null,
    lightningDeal: product.lightningDeal,
    coupon: product.coupon,
  };
}

function currentLightningDeal(csv: unknown, nowMs: number): boolean | null {
  if (!Array.isArray(csv)) return null;
  const raw = csv[CSV_LIGHTNING_DEAL];
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const events: { at: number; value: number }[] = [];
  for (let offset = 0; offset + 2 <= raw.length; offset += 2) {
    const minutes = finiteNumber(raw[offset]);
    const value = finiteNumber(raw[offset + 1]);
    if (minutes === null || value === null) continue;
    events.push({ at: keepaMinutesToDate(minutes).getTime(), value });
  }
  events.sort((left, right) => left.at - right.at);
  const current = events.filter((event) => event.at <= nowMs).at(-1);
  if (!current) {
    // A future sentinel announces an upcoming deal, which is known-not-active.
    return events.some((event) => event.at > nowMs && event.value < 0) ? false : null;
  }
  if (current.value < 0) return false;
  // Active histories carry a future -1 end marker. Without it the historical
  // positive price does not establish that a deal remains active today.
  return events.some((event) => event.at > nowMs && event.value < 0) ? true : null;
}

function parseCoupon(value: unknown): KeepaCoupon | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const oneTime = finiteNumber(value[0]);
  const subscribeAndSave = finiteNumber(value[1]);
  if (oneTime === null || subscribeAndSave === null) return null;
  return [Math.trunc(oneTime), Math.trunc(subscribeAndSave)];
}

function readCategoryName(value: unknown, category: string): string | null {
  if (!category || !Array.isArray(value)) return null;
  for (const node of value) {
    if (!isRecord(node) || String(node['catId']) !== category) continue;
    if (typeof node['name'] === 'string' && node['name'].trim()) return node['name'].trim();
  }
  return null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
