export const COMPETITOR_EVENT_KINDS = [
  'deal_start',
  'deal_end',
  'price_drop',
  'price_restore',
  'coupon_start',
  'coupon_end',
] as const;

export type CompetitorEventKind = (typeof COMPETITOR_EVENT_KINDS)[number];
export type MarketCoupon = readonly [number, number];

export interface MarketPricePoint {
  observedAt: Date;
  value: number;
}

export interface MarketObservation {
  asin: string;
  observedAt: Date;
  price: number | null;
  lightningDeal: boolean | null;
  coupon: MarketCoupon | null;
}

export interface CompetitorPriceEvent {
  asin: string;
  eventKind: CompetitorEventKind;
  detectedAt: Date;
  price: number | null;
  baselinePrice: number | null;
  details: Record<string, unknown>;
}

export interface DealDetectionInput {
  current: MarketObservation;
  previous: MarketObservation | null;
  /** Oldest first; the final point is the current price Keepa knows. */
  priceHistory: readonly MarketPricePoint[];
  baselinePoints?: number;
}

export const DEFAULT_BASELINE_POINTS = 30;

/** Median of the observations before the current price point. */
export function rollingPriceBaseline(
  history: readonly MarketPricePoint[],
  maxPoints = DEFAULT_BASELINE_POINTS,
): number | null {
  const prior = history
    .slice(0, -1)
    .map((point) => point.value)
    .filter((value) => Number.isFinite(value) && value > 0)
    .slice(-Math.max(1, Math.trunc(maxPoints)))
    .sort((left, right) => left - right);
  if (prior.length === 0) return null;
  const middle = Math.floor(prior.length / 2);
  const high = prior[middle];
  if (high === undefined) return null;
  if (prior.length % 2 === 1) return high;
  const low = prior[middle - 1];
  return low === undefined ? high : (low + high) / 2;
}

/**
 * Emit transitions only. Null is unknown, not false: a crawl gap cannot end a
 * deal, coupon, or price-drop state the prior observation established.
 */
export function detectCompetitorDeals(input: DealDetectionInput): CompetitorPriceEvent[] {
  const { current, previous } = input;
  const baseline = rollingPriceBaseline(input.priceHistory, input.baselinePoints);
  const events: CompetitorPriceEvent[] = [];

  transition(
    previous?.lightningDeal ?? null,
    current.lightningDeal,
    () => events.push(event(current, 'deal_start', baseline, { source: 'keepa_lightning_deal' })),
    () => events.push(event(current, 'deal_end', baseline, { source: 'keepa_lightning_deal' })),
  );

  transition(
    couponActive(previous?.coupon ?? null),
    couponActive(current.coupon),
    () => events.push(event(current, 'coupon_start', baseline, { coupon: current.coupon })),
    () => events.push(event(current, 'coupon_end', baseline, { previousCoupon: previous?.coupon ?? null })),
  );

  if (baseline !== null && current.price !== null && previous?.price !== null && previous?.price !== undefined) {
    const wasBelow = previous.price < baseline;
    const isBelow = current.price < baseline;
    if (!wasBelow && isBelow) {
      events.push(event(current, 'price_drop', baseline, { previousPrice: previous.price }));
    } else if (wasBelow && !isBelow) {
      events.push(event(current, 'price_restore', baseline, { previousPrice: previous.price }));
    }
  }
  return events;
}

function couponActive(coupon: MarketCoupon | null): boolean | null {
  if (coupon === null) return null;
  return coupon.some((value) => value !== 0);
}

function transition(
  previous: boolean | null,
  current: boolean | null,
  start: () => void,
  end: () => void,
): void {
  if (previous === null || current === null || previous === current) return;
  if (current) start();
  else end();
}

function event(
  current: MarketObservation,
  eventKind: CompetitorEventKind,
  baselinePrice: number | null,
  details: Record<string, unknown>,
): CompetitorPriceEvent {
  return {
    asin: current.asin,
    eventKind,
    detectedAt: current.observedAt,
    price: current.price,
    baselinePrice,
    details,
  };
}
