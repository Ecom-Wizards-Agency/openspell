# WP-43 — DataDive: client package + rank sync

**Status:** open · **Owner:** Codex (gpt-5.6-sol) · **Branch:** `wp-43-datadive`

## Why

Organic rank per keyword×ASIN from DataDive Rank Radars into `rank_observations`
(seam table, migrated, empty). NOT SP-API-gated. Foundations on main: WP-40
(`integration_connections`, provider 'datadive', `get_integration_secret`) and WP-41
(`rank.sync` job type, `IntegrationHandlers.rankSync`, daily schedule provisioning).
Read both briefs + design docs first.

## Scope

1. **`packages/datadive-api`** cloning the `packages/ads-api` pattern (purity test, deps
   exactly `['@wizard-ads/shared']`, single HTTP choke point w/ 429+Retry-After, injected
   effects, fixture server, synthetic goldens, eslint boundary). DataDive is a plain REST
   API with an API key header; endpoints to cover: list rank radars, get rank radar data
   (keyword×ASIN daily ranks), get quota (budget guard). Model the client on what those
   endpoints actually return — if exact response shapes are unverifiable offline, define
   conservative Zod parsers with passthrough details and mark assumptions in the README
   for live-smoke verification (the operator runs one live call later; do NOT invent
   fields silently).
2. **Worker handler** `apps/worker/src/datadive.ts` implementing `rankSync`: resolve the
   org's datadive connection + key; radar-id scope from `sync_schedules.payload` /
   `integration_connections.config.radar_ids`; **validate radar marketplace against the
   designated profile's marketplace and fail loudly on mismatch** (a DE config fed an IT
   radar scores the wrong country silently — documented SUPA-project failure); upsert
   `rank_observations` (source stays 'rank_radar'; unique key
   org+asin+keyword+observed_on+source) via the five-step loader pattern; respect quota
   (skip + record when exhausted, retryable).
3. **Migration**: only if the real payload demands a column (e.g. `search_volume`) — amend
   `rank_observations` additively; otherwise none.
4. **Out of scope** (state in README): impression/click share — that is SQP (WP-46);
   no DataDive workaround.
5. **Tests**: fixture suite (auth header, 429, quota), purity, marketplace-mismatch
   failure test, loader grain, queue integration. `pnpm typecheck && pnpm lint &&
   pnpm test` green.

## Constraints

- No `packages/shared` edits. Roadmap stays `in_progress`. Branch `wp-43-datadive`;
  commits `feat(wp-43): ...`; no push/merge.
- Final message: client surface, assumptions needing live-smoke, handler wiring, operator
  steps (key entry, radar-id config), test results.
