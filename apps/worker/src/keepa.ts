import {
  KeepaClient,
  KeepaRetryableError,
  currentProductValues,
  normalizeAsins,
} from '@wizard-ads/keepa-api';
import type { KeepaProduct, KeepaProductsResult } from '@wizard-ads/keepa-api';
import { detectCompetitorDeals } from '@wizard-ads/core';
import type { CompetitorPriceEvent, MarketObservation } from '@wizard-ads/core';
import {
  activeKeepaConnection,
  latestKeepaObservations,
  loadKeepaBsrObservations,
  loadNewCompetitorPriceEvents,
  markKeepaConnectionSynced,
  resolveKeepaSyncScope,
  writeKeepaDealInsight,
} from '@wizard-ads/db';
import type {
  ActiveKeepaConnection,
  CompetitorEventLoadResult,
  DbHandle,
  IdentityLoadCounts,
  KeepaObservationRecord,
  KeepaSyncScope,
  NewCompetitorPriceEvent,
  NewKeepaBsrObservation,
} from '@wizard-ads/db';
import { getIntegrationSecret } from '@wizard-ads/db/worker';
import type { KeepaSyncJob } from '@wizard-ads/shared';
import { AdsApiRetryableError } from './ads-api.js';

interface KeepaProductClient {
  products(asins: readonly string[], marketplace: string): Promise<KeepaProductsResult>;
}

export interface KeepaSyncDeps {
  activeConnection(orgId: string): Promise<ActiveKeepaConnection | null>;
  secret(connectionId: string): Promise<string | null>;
  scope(input: { orgId: string; profileId: string; includeCompetitors: boolean }): Promise<KeepaSyncScope>;
  previous(orgId: string, asins: readonly string[]): Promise<KeepaObservationRecord[]>;
  loadObservations(rows: readonly NewKeepaBsrObservation[]): Promise<IdentityLoadCounts>;
  loadEvents(rows: readonly NewCompetitorPriceEvent[]): Promise<CompetitorEventLoadResult>;
  writeInsight(input: Parameters<typeof writeKeepaDealInsight>[1]): Promise<string>;
  markSynced(connectionId: string, at: Date): Promise<void>;
  createClient(apiKey: string): KeepaProductClient;
  now(): Date;
}

export function createKeepaSyncHandler(
  handle: DbHandle,
  overrides: Partial<KeepaSyncDeps> = {},
): (payload: KeepaSyncJob) => Promise<Record<string, unknown>> {
  const deps: KeepaSyncDeps = {
    activeConnection: (orgId) => activeKeepaConnection(handle, orgId),
    secret: (connectionId) => getIntegrationSecret(handle, connectionId),
    scope: (input) => resolveKeepaSyncScope(handle, input),
    previous: (orgId, asins) => latestKeepaObservations(handle, orgId, asins),
    loadObservations: (rows) => loadKeepaBsrObservations(handle, rows),
    loadEvents: (rows) => loadNewCompetitorPriceEvents(handle, rows),
    writeInsight: (input) => writeKeepaDealInsight(handle, input),
    markSynced: (connectionId, at) => markKeepaConnectionSynced(handle, connectionId, at),
    createClient: (apiKey) => new KeepaClient({ apiKey }),
    now: () => new Date(),
    ...overrides,
  };

  return async (payload) => runKeepaSync(deps, payload);
}

export async function runKeepaSync(
  deps: KeepaSyncDeps,
  payload: KeepaSyncJob,
): Promise<Record<string, unknown>> {
  const connection = await deps.activeConnection(payload.orgId);
  if (!connection) throw new Error('No active Keepa integration connection for this organisation');
  const apiKey = await deps.secret(connection.id);
  if (!apiKey) throw new Error('The active Keepa integration has no stored API key');

  const scope = await deps.scope({
    orgId: payload.orgId,
    profileId: payload.profileId,
    includeCompetitors: payload.includeCompetitors,
  });
  const competitorAsins = new Set(scope.competitorLinks.map((link) => link.competitorAsin));
  const allowed = normalizeAsins([...scope.ownAsins, ...competitorAsins]);
  const requested = payload.asins === undefined ? allowed : normalizeAsins(payload.asins);
  const allowedSet = new Set(allowed);
  const outsideScope = requested.filter((asin) => !allowedSet.has(asin));
  if (outsideScope.length > 0) {
    throw new Error(`Keepa job requested ${outsideScope.length} ASIN(s) outside the profile/link scope`);
  }

  const previousRows = await deps.previous(
    payload.orgId,
    requested.filter((asin) => competitorAsins.has(asin)),
  );
  const previous = new Map(previousRows.map((row) => [row.asin, row]));
  const syncedAt = deps.now();
  let fetched: KeepaProductsResult;
  try {
    fetched = await deps.createClient(apiKey).products(requested, scope.marketplace);
  } catch (error) {
    if (error instanceof KeepaRetryableError) {
      throw new AdsApiRetryableError(error.message, Math.max(1, Math.ceil(error.retryAfterMs / 1_000)));
    }
    throw error;
  }
  if (fetched.requested !== fetched.returned + fetched.missing.length) {
    throw new Error(
      `Keepa returned/accounted ${fetched.returned + fetched.missing.length} of ${fetched.requested} requested ASINs`,
    );
  }

  const observationRows = fetched.products.map((product) => observationRow(payload.orgId, product, syncedAt));
  const detected = fetched.products.flatMap((product) => {
    if (!competitorAsins.has(product.asin)) return [];
    return detectForProduct(product, previous.get(product.asin) ?? null, syncedAt);
  });

  // Events first: if the worker dies between the two identity loads, the deal
  // is retained. A rerun diffs it on the event key before writing an insight.
  const eventLoad = await deps.loadEvents(detected.map((event) => ({ ...event, orgId: payload.orgId })));
  const observationLoad = await deps.loadObservations(observationRows);
  let insights = 0;
  for (const inserted of eventLoad.inserted.filter((event) => event.eventKind === 'deal_start')) {
    const source = detected.find((event) =>
      event.asin === inserted.asin
      && event.eventKind === inserted.eventKind
      && event.detectedAt.getTime() === inserted.detectedAt.getTime());
    if (!source) continue;
    const linkedOurAsins = scope.competitorLinks
      .filter((link) => link.competitorAsin === inserted.asin)
      .map((link) => link.ourAsin);
    await deps.writeInsight({
      orgId: payload.orgId,
      profileId: payload.profileId,
      asin: inserted.asin,
      detectedAt: inserted.detectedAt,
      price: source.price,
      baselinePrice: source.baselinePrice,
      linkedOurAsins,
    });
    insights += 1;
  }
  await deps.markSynced(connection.id, syncedAt);

  return {
    requested: fetched.requested,
    returned: fetched.returned,
    missing: fetched.missing,
    observationsWritten: observationLoad.written,
    observationsExisting: observationLoad.existing,
    eventsWritten: eventLoad.written,
    eventsExisting: eventLoad.existing,
    insights,
    tokensConsumed: fetched.tokenState.tokensConsumed,
    tokensLeft: fetched.tokenState.tokensLeft,
  };
}

function observationRow(
  orgId: string,
  product: KeepaProduct,
  fallbackAt: Date,
): NewKeepaBsrObservation {
  const current = currentProductValues(product);
  return {
    orgId,
    asin: current.asin,
    observedAt: current.observedAt ?? fallbackAt,
    category: current.category,
    bsr: current.bsr,
    price: current.price,
    buyBoxPrice: current.buyBoxPrice,
    rating: current.rating,
    reviewCount: current.reviewCount,
    lightningDeal: current.lightningDeal,
    coupon: current.coupon,
  };
}

function detectForProduct(
  product: KeepaProduct,
  previous: KeepaObservationRecord | null,
  fallbackAt: Date,
): CompetitorPriceEvent[] {
  const current = currentProductValues(product);
  const price = current.buyBoxPrice ?? current.price;
  const currentObservation: MarketObservation = {
    asin: product.asin,
    observedAt: current.observedAt ?? fallbackAt,
    price,
    lightningDeal: current.lightningDeal,
    coupon: current.coupon,
  };
  const previousObservation: MarketObservation | null = previous === null ? null : {
    asin: previous.asin,
    observedAt: previous.observedAt,
    price: previous.buyBoxPrice ?? previous.price,
    lightningDeal: previous.lightningDeal,
    coupon: previous.coupon,
  };
  const history = product.buyBoxPrice.length > 0 ? product.buyBoxPrice : product.newPrice;
  return detectCompetitorDeals({ current: currentObservation, previous: previousObservation, priceHistory: history });
}
