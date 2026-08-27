# WP-44 My Real Profit design

## Problem

The live beta does not expose a bulk product-economics operation. A sync must first
parse a prose seller roster, map one seller to an in-org ads profile, enumerate that
profile's advertised ASINs, and call `get_product_metrics` once per ASIN with a seller,
marketplace, and date window. The provider returns a stringified JSON document whose
metric sections can grow independently of wizard-ads. The worker must retain those
unknowns, reject unloaded periods, isolate ordinary per-ASIN failures, and still prove
that every accepted row reached the existing idempotent loader. Shared contracts and
the database schema remain frozen.

## Usage (caller's view)

The queue still binds one provider handler and remains unaware of seller or ASIN
orchestration:

```ts
const worker = new SyncWorker({
  workerId: config.workerId,
  store,
  integrations: {
    economicsSync: createMrpEconomicsSync(handle),
  },
});
```

The worker sees two domain operations rather than MCP envelopes:

```ts
const client = new MrpClient({ endpoint, token, fetch });
const { sellers } = await client.fetchSellers();
const metrics = await client.fetchProductMetrics({
  asin,
  sellerIds: [seller.sellerId],
  marketplaceIds: [marketplaceId],
  dateFrom: capturedOn,
  dateTo: capturedOn,
});
```

The pure decisions are independently testable without a database or transport:

```ts
const matches = matchMrpSellersToProfiles(sellers, profiles, sellerMap);
const row = mapMrpProductMetrics({ orgId, profileId, capturedOn, loadedAt }, metrics);
```

WP-45 continues to read the existing persistence seam unchanged:

```ts
const rows = await latestProductEconomics(handle, { orgId, profileId });
```

## Shape

```ts
interface MrpSeller {
  number: number;
  name: string;
  sellerId: number;
  sellingPartnerId: string | null;
  region: string | null;
  access: string | null;
}

interface MrpProductMetricsInput {
  asin: string;
  sellerIds: number[];
  marketplaceIds: string[];
  dateFrom: string;
  dateTo: string;
}

interface MrpProductMetrics {
  product: MrpProductEconomics;
  period: {
    from: string;
    to: string;
    complete: boolean | null;
    dataAvailableThrough: Record<string, string | null>;
    incompleteSources: string[];
    note: string | null;
  };
}

class MrpClient {
  initialize(): Promise<MrpInitializeResult>;
  listTools(): Promise<MrpTool[]>;
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  fetchSellers(): Promise<MrpSellersResult>;
  fetchProductMetrics(input: MrpProductMetricsInput): Promise<MrpProductMetricsResult>;
}

interface MrpEconomicsSyncStore {
  scope(payload: EconomicsSyncJob): Promise<MrpSyncScope | null>;
  secret(connectionId: string): Promise<string | null>;
  advertisedAsins(args: { orgId: string; profileId: string; limit: number }):
    Promise<MrpAsinSelection>;
  load(rows: readonly NewProductEconomics[]): Promise<ProductEconomicsLoadCounts>;
  succeeded(args: { connectionId: string; syncedAt: Date; note: string | null }): Promise<void>;
  failed(args: { connectionId: string; lastError: string; disable: boolean }): Promise<void>;
}
```

`mrp-api` owns all MCP and provider-wire knowledge: lazy initialization, exact live
tool names, prose/result unwrapping, stringified JSON parsing, tolerant Zod boundary
validation, metric aliases, and preservation of the full provider document in
`details`. The worker owns tenant policy: explicit seller-map precedence, normalized
name matching, region/sync preference, country-to-marketplace mapping, the ASIN cap,
last-complete-profile-day selection, availability gating, per-ASIN isolation, and the
five-step loader count assertion. This keeps both interfaces deep and the call chain
short, per boundary-discipline and interface depth.

The database adapter queries the existing `product_ads` mirror. It ranks distinct
ASINs by a 30-day Sponsored Products ad-group spend proxy, then by ASIN, and returns
both selected and total counts so cap skips are observable. It does not introduce a
new database query module or change another package's schema.

## Synthesis decision

The smallest-public-surface candidate is the base: two live MRP domain calls hide the
protocol and provider payload. The isolation-first candidate contributed exported
pure seller matching, availability gating, marketplace lookup, and row mapping so the
behavior can be tested without widening the store into temporal load/parse stages. A
generic runtime-swappable MCP transport was rejected because it exposed wire types and
forced the worker to coordinate initialize/call/result parsing. A staged planner
object was also rejected as a shallow temporal decomposition: its caller still had to
know every stage in order.

## Tradeoffs accepted

- We accept one provider call per selected ASIN in exchange for obeying the live schema
  and isolating individual product failures.
- We accept ad-group spend as an ordering proxy in exchange for using the existing
  mirror and facts without a new product-ad fact grain.
- We accept the full provider document in `details` in exchange for lossless tolerance
  while the beta metric sections evolve; mapped columns deliberately retain their
  existing semantics.
- We accept skipping a whole one-day aggregate when any advertised availability date
  trails that day in exchange for never persisting provider-declared unloaded data.

## Alternatives considered

- A generic `request(method, params)` client hid only HTTP mechanics and leaked MCP
  orchestration and wire parsing to the worker, so it lost on interface depth.
- A worker pipeline with separate discover, match, enumerate, fetch, parse, and load
  service methods enlarged the public surface without hiding policy; pure decision
  functions plus one orchestration handler are easier to trace.
- A new ASIN/spend query in `packages/db` would create a reusable-looking seam for a
  provider-specific cap and cross a package ownership boundary; the worker adapter is
  the only current caller and therefore owns that query.

## Open questions and risks

- Which additional metric aliases will the beta add after the verified payload? The
  complete document remains in `details`, so extending a column mapping is additive.
- Will an organisation need one regional seller mapped to multiple marketplace
  profiles? Explicit `config.seller_map` already supports that even though automatic
  matching chooses the single best profile per seller.
- Does a future product-ad report provide true ASIN-grain spend? If so, can it replace
  the current ad-group proxy without changing the store interface?

## Next implementation step

Replace the old bulk economics parser and client operation with fixture-driven live
seller and single-ASIN product-metrics boundaries.
