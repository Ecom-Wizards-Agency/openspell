# WP-44B — Fit the MRP economics sync to the live beta server

**Status:** open · **Owner:** Codex (gpt-5.6-sol) · **Branch:** `wp-44b-mrp-live-fit`

## Live findings (verified against api.myrealprofit.com/mcp on 2026-08-27 — trust these)

- Transport works with our client as-is: initialize OK (protocol 2025-06-18 negotiated,
  SSE responses, mcp-session-id handled). No transport changes needed.
- Tools: `get_sellers`, `check_pending_orders`, `get_account_metrics`,
  `get_new_to_brand_customers`, `get_product_metrics`, `get_search_query_performance`,
  `get_zero_sales_search_terms`.
- `get_sellers({})` returns PROSE in `result`: lines like
  `1. <seller name> | Seller id: <numeric seller id> | Selling partner id: ... | Region:
  <region, e.g. North America> | Type: <seller type> | Access: <access level>`. Two sellers
  connected today (Client A and Client B), each with its own numeric seller id.
- `get_product_metrics` requires `{asin, seller_ids: int[], marketplace_ids: string[],
  date_from, date_to}` — SINGLE ASIN per call (additionalProperties: false). Calling it
  without an asin errors (this is why the current handler dies with MrpToolCallError →
  "unsupported MCP response").
- Its `result` is a STRINGIFIED JSON document (JSON.parse the string): keys seen —
  `account{name, seller_ids}`, `product{asin, child_asins, scope}`, `period{from, to,
  days, complete, data_available_through{orders, advertising, traffic},
  incomplete_sources, note}`, `comparison_period{...}`, and metric sections after that
  (inspect the full payload at runtime; parse tolerantly, keep unknowns in `details`).

## Scope

Rework `apps/worker/src/mrp.ts` economicsSync (and whatever in `packages/mrp-api`
supports it) to the live shape:

1. **Seller mapping**: call `get_sellers`, parse the prose lines (number, name, seller id,
   selling partner id, region, access) with a tolerant line parser + tests. Match sellers
   to our ad_profiles by normalized name (case/space-insensitive: Client A's seller name
   differs from its profile `account_name` only in letter case; Client B's two-word name
   matches exactly) within the connection's org,
   preferring sync-enabled profiles in the seller's region (North America → US/CA).
   `integration_connections.config.seller_map` (`{"<profileId>": <sellerId>}`) overrides
   auto-matching. Profiles without a matched seller are skipped WITH a recorded note, not
   an error.
2. **ASIN enumeration**: per matched profile, advertised ASINs from our synced mirror
   (product ads / listings — find the existing query; n-gram/audit code knows where ASINs
   live). Cap per run (config `max_asins`, default 25, ordered by recent ad spend) and
   record skipped counts.
3. **Per-ASIN calls**: `get_product_metrics(asin, seller_ids=[matched], marketplace_ids=
   [profile marketplace id], date_from/date_to = last complete day or small window)`.
   Marketplace id mapping: US→ATVPDKIKX0DER (extend the existing mapping table if one
   exists in the repo; add the majors). Respect `period.complete` /
   `data_available_through` — do not store days the provider marks unloaded.
4. **Parsing → product_economics rows**: JSON.parse the result string (fallback: treat as
   error with the provider's message); tolerant Zod; map whatever economics fields the
   payload carries (sales, profit, margin, ppc spend, fees if present) into the existing
   `product_economics` columns; unknowns into `details`. `captured_on` = the window end.
   Keep the five-step loader discipline.
5. **Error taxonomy**: per-ASIN failures are recorded and skipped (job proceeds); only
   auth/transport failures fail the job. `last_error` stays operator-readable.
6. **Fixtures/tests**: extend the JSON-RPC fixture server with the live shapes above
   (prose get_sellers, stringified-JSON product metrics, single-asin schema error);
   handler unit tests for mapping/enumeration/partial-period handling.

Do NOT build `get_search_query_performance` ingestion here — note it in the final message
as a discovered capability (SQP without SP-API!) for a follow-up WP.

## Constraints

- AGENTS.md rules; no `packages/shared` edits; roadmap stays in_progress.
- Branch `wp-44b-mrp-live-fit`; commits `fix(wp-44b): ...`; no push/merge.
- Verify: `pnpm typecheck && pnpm lint && pnpm test` green (serial if needed).
- Final message: seller-parse rules, field mapping actually implemented, caps/skips
  behavior, test results, and the SQP-capability note.
