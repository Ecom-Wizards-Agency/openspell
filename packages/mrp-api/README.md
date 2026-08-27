# `@wizard-ads/mrp-api`

Minimal My Real Profit MCP client for product economics. It speaks JSON-RPC 2.0
over an injected `fetch`, carries an MCP session id when the server returns one,
and accepts either a normal JSON response or `text/event-stream` data events.

```ts
const client = new MrpClient({ endpoint, token, fetch });
const result = await client.fetchProductEconomics();
```

`fetchProductEconomics()` initializes a fresh session, discovers tools, selects
the strongest tool-name match across `products`, `economics`, `profit`, and
`ltv`, calls it with an empty argument object, and returns normalized rows plus
the resolved tool name. The lower-level `initialize`, `listTools`, and
`callTool` operations remain available for a controlled live smoke check.

## Transport assumptions to verify live

- The personal access token is an HTTP Bearer token.
- The endpoint accepts one JSON-RPC request per POST.
- The selected economics tool has no required arguments. Its advertised input
  schema is retained by `listTools()` so the operator can verify this before the
  first production sync.
- Product rows are returned in `structuredContent`, JSON text content, or a
  common rows/products/items/data/results wrapper. Numeric JSON strings are
  accepted; unmapped fields are retained in each row's `details`.

The direct-database bulk fallback offered by MRP is deliberately not
implemented. It is a gated alternative only: adopting it requires an explicit
operator decision, a read-only database credential and schema review, and a
separate work package. The MCP path remains the only runtime path here.
