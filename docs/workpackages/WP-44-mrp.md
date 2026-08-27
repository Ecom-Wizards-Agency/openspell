# WP-44 — My Real Profit: MCP client + product economics ingestion

**Status:** open · **Owner:** Codex (gpt-5.6-sol) · **Branch:** `wp-44-mrp`

## Why

Per-ASIN profit economics (sale price, COGS, fees, margin, LTV) feed the real break-even
TACOS derivation (WP-45). MRP exposes a beta **MCP server** (personal access token; the
operator holds it — never in the repo). Foundations on main: WP-40 (provider 'mrp' +
`get_integration_secret`), WP-41 (`economics.sync` + `IntegrationHandlers.economicsSync`,
daily). MRP's founder offered direct DB access as a bulk fallback — document it as a gated
alternative only; do not build it.

## Scope

1. **`packages/mrp-api`**: hand-rolled MINIMAL MCP client — JSON-RPC 2.0 over injected
   fetch implementing `initialize`, `tools/list`, `tools/call` (+ MCP session header if
   the transport is Streamable HTTP; support both plain-POST and SSE-response parsing
   defensively). Do NOT add the MCP SDK (breaks the deps-exactly-`['@wizard-ads/shared']`
   purity rule). Same pattern set: purity test, choke point, injected effects, fixture
   server speaking JSON-RPC (sequences: init → tools/list → tools/call, auth failure,
   malformed result), synthetic goldens, eslint boundary. Since the beta's exact tool
   names are only in the operator's guide PDF, DISCOVER tools at runtime via `tools/list`
   and select by name patterns (products/economics/profit/ltv), with the resolved tool
   name recorded in the sync result; parse tool results with tolerant Zod (numbers-or-
   numeric-strings), recording unknown fields in `details`.
2. **Migration** (timestamp after 20260827150200): `product_economics` — id identity,
   org_id FK, profile_id FK, asin, captured_on date, sale_price, cogs, fba_fees,
   referral_fees, other_fees, margin numeric, ltv_revenue numeric, ltv_orders numeric,
   repeat_rate numeric, currency char check, source text default 'mrp', details jsonb,
   loaded_at; unique (profile_id, asin, captured_on); install_tenant_rls. Drizzle mirror +
   five-step loader + a `latestProductEconomics(handle, {orgId, profileId})` query helper
   (WP-45 consumes it — state its exact signature in your final message).
3. **Worker handler** `apps/worker/src/mrp.ts` implementing `economicsSync`: token via
   `get_integration_secret`; MCP endpoint from `integration_connections.config.url`
   (required — fail with operator-facing lastError if absent); map tool results to rows;
   load with count assertion; set last_synced_at.
4. **Tests**: JSON-RPC fixture suite, purity, mapper unit tests (tolerant parsing), loader
   grain, RLS, migrations list. `pnpm typecheck && pnpm lint && pnpm test` green.

## Constraints

- No `packages/shared` edits. Roadmap stays `in_progress`. Branch `wp-44-mrp`; commits
  `feat(wp-44): ...`; no push/merge.
- Final message: client surface + transport assumptions, the latest-economics helper
  signature for WP-45, migration notes (hosted apply), operator steps (enter MCP URL in
  config + token via /settings/integrations), test results.
