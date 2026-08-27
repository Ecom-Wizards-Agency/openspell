# WP-42 Keepa design

## Problem

Keepa must supply current and historical market observations without leaking its API
key or wire format beyond a pure client package. A daily queue job then has to join the
designated profile to its own advertised ASINs and linked competitors, persist identity
logs idempotently, and create transition events only when the previous and current states
are both known. The existing queue payload and integration credential contracts are
frozen, the web tier may not import a provider client, and a depleted Keepa token bucket
must reschedule the job rather than wait inside a worker claim.

## Usage (caller's view)

The worker constructs one client from the Vault-owned value and delegates one normalized
scope. The client owns domain mapping, batches of 100, request parameters, response
decoding, token accounting, and transport retry:

```ts
const client = new KeepaClient({ apiKey, fetch, now, sleep, random });
const result = await client.products(scope.asins, scope.marketplace);

await loadKeepaBsrObservations(handle, toObservationRows(result.products));
const events = detectCompetitorDeals({ current, previous, priceHistory });
await loadNewCompetitorPriceEvents(handle, events);
```

A parser caller can test Keepa history independently of HTTP:

```ts
const points = decodeHistory(csv, CSV_BUY_BOX_PRICE);
const current = currentProductValues(parseProduct(payload), now);
```

The integrations page uses tenant-scoped database helpers and the existing analyst-level
`editTargets` capability:

```ts
const links = await listCompetitorLinks(handle, orgId);
await createCompetitorLink(handle, { orgId, profileId, ourAsin, competitorAsin });
await removeCompetitorLink(handle, { orgId, id });
```

## Shape

```ts
interface KeepaClientOptions {
  apiKey: string;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

interface KeepaTokenState {
  tokensLeft: number | null;
  refillInMs: number | null;
  refillRate: number | null;
  tokensConsumed: number;
  requests: number;
}

class KeepaRetryableError extends Error {
  readonly retryAfterMs: number;
}

class KeepaClient {
  constructor(options: KeepaClientOptions);
  get tokenState(): KeepaTokenState;
  products(
    asins: readonly string[],
    marketplace: string,
    options?: ProductRequestOptions,
  ): Promise<KeepaProductsResult>;
}

interface MarketObservation {
  asin: string;
  observedAt: Date;
  price: number | null;
  lightningDeal: boolean | null;
  coupon: readonly [number, number] | null;
}

function detectCompetitorDeals(input: {
  current: MarketObservation;
  previous: MarketObservation | null;
  priceHistory: readonly PricePoint[];
}): CompetitorPriceEvent[];
```

`packages/keepa-api` validates external JSON once and returns domain objects. It deliberately
exports no raw response type. A nullable deal flag means Keepa did not establish the state;
`false` means it established absence. The client throws before a batch when known tokens
cannot cover its estimated cost, and on HTTP 429, carrying the calculated refill delay.
Transient transport and 5xx retries use injected effects through one HTTP function.

`packages/core/src/market/deals.ts` owns price-baseline and transition knowledge as pure
functions. It emits no start/end transition from an unknown prior or current state.
`packages/db` owns tenant-scoped scope reads, identity-grain duplicate checks, new-key
diffing, inserts, and count assertions. The worker is a short shell that maps these
capabilities and converts `KeepaRetryableError` to the queue's existing retry surface.

This is a deep interface: the public client call hides query construction, gzip handling,
batching, token cost, token state, retry, validation, and parsing. Callers still see token
state and typed exhaustion because worker scheduling needs that policy result.

## Synthesis decision

The base is the smallest-public-surface candidate: one stateful client and one product
operation. The isolation-first candidate contributed exported pure decoders and current
value helpers. The worker-service candidate contributed a single database-owned scope
read and loader diff, but its provider-plus-persistence facade was rejected because it
would make a client package depend on database policy and obscure the existing
`IntegrationHandlers` boundary.

## Tradeoffs accepted

- We accept per-client mutable token accounting in exchange for keeping bucket knowledge
  out of every call site.
- We accept nullable deal state in exchange for never reporting missing/stale Keepa data
  as a confirmed deal end.
- We accept a deterministic rolling median over prior price points in exchange for a
  baseline that is robust to one promotional observation without adding tenant doctrine.
- We accept one designated profile on each competitor link in exchange for preventing a
  competitor ASIN from being queried against the wrong marketplace.

## Alternatives considered

- Stateless `fetchProducts(request, tokenState)` functions expose batching and bucket
  coordination to every caller, so their interface hides too little.
- A `KeepaSyncService` that owns HTTP, SQL, and insights makes the worker call short but
  collapses pure transport and tenant persistence into one shallow, untestable boundary.
- A generic provider handler map was already rejected by WP-41 because it loses exact
  payload typing; WP-42 implements the named `keepaSync` port.

## Open questions and risks

- Will production Keepa credentials return freshly updated coupons through the existing
  buy-box request, or will the operator later choose the higher-token `offers` mode? The
  parser preserves explicit unknowns so the initial live smoke can answer this safely.
- Will competitor links ever need marketplace scope independent of an advertising
  profile? The current queue contract is profile-based, so profile ownership remains the
  only honest marketplace join in WP-42.

## Next implementation step

Build the pure Keepa package and parser fixture suite first, then implement persistence
against those stable domain types.
