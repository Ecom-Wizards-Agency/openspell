# WP-44 My Real Profit design

## Problem

The worker needs per-ASIN economics from a beta MCP endpoint whose exact tool name
is not part of the repository. The implementation must discover that tool, tolerate
both JSON and SSE Streamable HTTP responses, keep the personal access token inside
the existing worker/Vault boundary, and persist an idempotent daily snapshot without
changing the frozen shared contracts. WP-41 already owns queue dispatch and schedule
selection; WP-40 owns connection metadata and secret custody.

## Usage (caller's view)

The always-on worker binds one handler and gives the generic queue no provider
knowledge:

```ts
const worker = new SyncWorker({
  workerId: config.workerId,
  store,
  integrations: {
    economicsSync: createMrpEconomicsSync(handle),
  },
});
```

The client can also be exercised at the MCP operations named by the protocol, while
the normal caller uses the one deep operation:

```ts
const client = new MrpClient({ endpoint, token, fetch });
await client.initialize();
const tools = await client.listTools();
const raw = await client.callTool(tools[0].name);

const syncClient = new MrpClient({ endpoint, token, fetch });
const sync = await syncClient.fetchProductEconomics();
// sync.toolName records the runtime-discovered tool; sync.products are domain rows.
```

WP-45 reads one newest row per ASIN without knowing the loader or MCP transport:

```ts
const rows = await latestProductEconomics(handle, { orgId, profileId });
```

## Shape

```ts
interface MrpClientOptions {
  endpoint: string;
  token: string;
  fetch?: FetchLike;
}

interface MrpProductEconomics {
  asin: string;
  capturedOn: string | null;
  salePrice: number | null;
  cogs: number | null;
  fbaFees: number | null;
  referralFees: number | null;
  otherFees: number | null;
  margin: number | null;
  ltvRevenue: number | null;
  ltvOrders: number | null;
  repeatRate: number | null;
  currency: string | null;
  details: Record<string, unknown>;
}

class MrpClient {
  initialize(): Promise<MrpInitializeResult>;
  listTools(): Promise<MrpTool[]>;
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  fetchProductEconomics(): Promise<MrpEconomicsResult>;
}

function selectEconomicsTool(tools: readonly MrpTool[]): MrpTool;
function parseProductEconomics(value: unknown): MrpProductEconomics[];
function upsertProductEconomics(
  handle: DbHandle,
  rows: readonly NewProductEconomics[],
): Promise<ProductEconomicsLoadCounts>;
function latestProductEconomics(
  handle: DbHandle,
  args: { orgId: string; profileId: string },
): Promise<ProductEconomicsRow[]>;
function createMrpEconomicsSync(handle: DbHandle):
  (payload: EconomicsSyncJob) => Promise<Record<string, unknown>>;
```

The MCP client is the transport choke point. It owns JSON-RPC ids, authorization,
session-header carry-forward, JSON/SSE decoding, protocol errors, discovery scoring,
and wire-to-domain validation. Transport envelopes never cross into the worker. Zod
validates provider data at that boundary, numeric strings become finite numbers, and
unrecognized product fields remain in `details`, per boundary-discipline.

The database loader follows the existing five-step fact pattern: empty-batch return,
whole-batch grain validation, bind-safe chunking, idempotent upsert on
`(profile_id, asin, captured_on)`, and offered-versus-written assertion. The newest
query selects one row per ASIN inside both org and profile predicates. The worker
resolves one active profile-compatible MRP connection, retrieves its token through
the worker-only RPC, defaults an absent provider capture date to the worker's current
UTC date, loads the rows, then records connection health. The public surfaces are
small relative to the protocol, parsing, and persistence policy they hide, per
interface depth.

## Synthesis decision

The smallest-surface candidate was the base: a single `fetchProductEconomics`
operation hides discovery and parsing. The testability-first candidate contributed
public protocol primitives plus exported pure tool selection and product parsing,
which let fixtures prove the exact initialize/list/call sequence without exposing
JSON-RPC envelopes. A swappable generic MCP transport object was rejected after the
red-flag screen: it was a shallow pass-through API that leaked wire types and made the
worker coordinate protocol stages.

## Tradeoffs accepted

- We accept a fresh MCP session per sync in exchange for stateless, retry-safe jobs.
- We accept heuristic tool selection in exchange for not committing beta-only tool
  names from an operator document.
- We accept nullable economics fields in exchange for preserving partial provider
  rows; ASIN and at least one economics metric remain mandatory at the parser edge.
- We accept UTC as the fallback capture day in exchange for a deterministic daily
  grain when MRP supplies no observation date.

## Alternatives considered

- A raw `McpTransport.request(method, params)` exposed protocol orchestration to every
  caller and hid almost no complexity, so it lost on interface depth.
- A worker-owned initialize/list/call sequence kept the client smaller but leaked
  session and discovery policy across package boundaries and produced a longer call
  chain.
- A hard-coded MRP tool name would be simpler locally but contradicts the explicit
  runtime-discovery requirement and would couple public code to a beta guide.

## Open questions and risks

- Does the live beta require tool arguments despite the current brief naming none?
  The first operator smoke call must verify the discovered tool's input schema.
- Does the beta use a capture date or timezone-specific business day? When present,
  its ISO date wins; otherwise the worker records the current UTC day.
- Which exact field aliases occur in the live product payload? Unknown fields are
  retained so a smoke result can extend the boundary parser without losing evidence.

## Next implementation step

Build the fixture-driven MCP client and lock its three-request sequence before adding
the database loader and worker shell.
