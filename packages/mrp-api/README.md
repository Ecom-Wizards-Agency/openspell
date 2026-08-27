# `@wizard-ads/mrp-api`

Minimal My Real Profit MCP client for the live product-metrics beta. It speaks
JSON-RPC 2.0 over an injected `fetch`, carries the MCP session id returned by the
server, and accepts plain JSON or SSE responses.

```ts
const client = new MrpClient({ endpoint, token, fetch });
const { sellers } = await client.fetchSellers();
const result = await client.fetchProductMetrics({
  asin,
  sellerIds: [sellerId],
  marketplaceIds: [marketplaceId],
  dateFrom,
  dateTo,
});
```

`fetchSellers()` calls the live `get_sellers` tool and parses its numbered prose
lines. `fetchProductMetrics()` calls `get_product_metrics` for exactly one ASIN
with the required seller, marketplace, and date arrays. The product tool's
stringified JSON `result` is parsed with a tolerant Zod boundary: compatible
sale-price, cost, fee, margin, LTV, repeat-rate, and currency values are normalized,
while the complete provider document remains in `details`.

The lower-level `initialize`, `listTools`, and `callTool` operations remain
available for a controlled smoke inspection. Transport and authentication failures
are typed separately from tool-call and payload errors so the worker can isolate
ordinary per-ASIN provider failures without hiding an unavailable server.

The direct-database bulk fallback offered by MRP is deliberately not implemented.
Adopting it requires an explicit operator decision, read-only database credentials,
schema review, and a separate work package. MCP remains the only runtime path.
