# WP-42 — Keepa: client package, BSR/price sync, deal detection

**Status:** open · **Owner:** Codex (gpt-5.6-sol) · **Branch:** `wp-42-keepa`

## Why

Track our ASINs' and competitors' BSR, and competitor prices/deals, so the operator knows
when a main competitor runs a promotion. Keepa is NOT SP-API-gated. Foundations: WP-40
(`integration_connections` + `get_integration_secret`) and WP-41 (`keepa.sync` job type +
`IntegrationHandlers.keepaSync` port + schedules) are on main — read both briefs and their
design docs first.

## Scope

1. **`packages/keepa-api`** cloning the `packages/ads-api` pattern exactly: purity test
   (no process.env, creds as arguments, deps exactly `['@wizard-ads/shared']`, no
   fs/pg/db imports), single HTTP choke point, injected effects (fetch/clock/sleep/
   random), fixture server with response sequences, synthetic-only goldens, eslint
   boundary added in `eslint.config.js` (web must not import it).
   - Rate limiting: Keepa is a token bucket. Track `tokensLeft`/`refillIn` from response
     bodies; on exhaustion throw a typed retryable error carrying the refill delay. Port
     the semantics from the reference client `~/os/wizards-ai/keepa_client.py`
     (read-only ground truth: token accounting, /product cost ~2-4 tokens per ASIN,
     keepa-minutes epoch 2011-01-01, DOMAINS map with unknown-marketplace hard failure).
   - Parsers for the /product response: decode the csv[] history arrays for sales rank,
     buy-box/new price, rating, review count into observation points; current-values
     helpers. Fixture-test against synthetic payloads.
2. **Migration** (timestamp after 20260827150200): amend `keepa_bsr_observations` with
   `buy_box_price numeric(14,4)` and deal flags (`lightning_deal boolean`, `coupon
   jsonb`) as the payload dictates; make `category text not null default ''` (verify the
   unique key stays honest). NEW `competitor_price_events`: id identity, org_id FK,
   asin, event_kind text check in ('deal_start','deal_end','price_drop','price_restore',
   'coupon_start','coupon_end'), detected_at timestamptz, price, baseline_price,
   details jsonb, created_at; unique (org_id, asin, event_kind, detected_at);
   install_tenant_rls. Drizzle mirrors + loaders per the five-step pattern
   (`packages/db/src/queries/facts.ts` conventions; these are identity logs — follow the
   existing keepa_bsr_observations mirror in schema/seams.ts).
3. **Worker handler** `apps/worker/src/keepa.ts` implementing
   `IntegrationHandlers.keepaSync`: resolve the org's keepa connection + secret via the
   WP-40 RPCs; ASIN scope = own advertised ASINs (from the entity mirror / product ads)
   + enabled `competitor_links` rows; batch /product calls within the token budget; load
   observations; then **pure deal detection** in `packages/core/src/market/deals.ts`
   (price vs a rolling baseline + Keepa deal flags → events; explicit-unknown posture) —
   write only NEW `competitor_price_events` (diff on the unique key) and an `insights`
   row when a deal starts on a linked competitor. Convert token-exhaustion into the
   worker's retry mechanism with run_after = refill time (see how AdsApiRetryableError
   is honored in worker.ts).
4. **`competitor_links` CRUD**: minimal section (add/remove our_asin↔competitor_asin
   pairs) — put it on `/settings/integrations` under the Keepa row (WP-40's page),
   analyst-editable per the table's RLS. Keepa sync is useless without it.
5. **Tests**: keepa-api fixture suite (token accounting incl. 429/refill sequence,
   parser goldens), purity, deals unit tests, loader grain tests, RLS for
   competitor_price_events, migrations list. `pnpm typecheck && pnpm lint && pnpm test`
   green.

## Constraints

- No `packages/shared` edits (contract landed in WP-41). Roadmap items stay
  `in_progress`. Branch `wp-42-keepa`; commits `feat(wp-42): ...`; no push/merge.
- Final message: client API surface, migration notes (hosted-apply), handler wiring, what
  the operator must enter (Keepa key + competitor ASINs), test results.
