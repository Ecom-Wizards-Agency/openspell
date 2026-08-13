# WP-02 — Amazon Ads API client (`packages/ads-api`)

**Owner:** Codex · **Phase:** v0 · **Depends on:** WP-00 contracts · **Blocks:** WP-03

## Goal

A typed, pure Amazon Ads API client: LWA token handling, profiles, entity list endpoints,
Exports API, Reporting v3 (request/poll/download), budgets — with correct regional hosts,
retry/backoff, and recorded-fixture tests. No DB imports, no side effects beyond HTTP.

## Read first

- `~/os/amazon-agent/tools/amazon-ads-monitor/datasource.py` lines ~731–1030
  (`SPAdsApiDataSource`) — the live-verified reference. Port its verified behavior 1:1:
  LWA refresh at `https://api.amazon.com/auth/o2/token` (refresh 60s early), regional hosts
  `advertising-api{,-eu,-fe}.amazon.com`, Reporting v3 flow (`POST /reporting/reports` with
  `reportTypeId: spCampaigns`, `format: GZIP_JSON` → poll → download S3 URL → gunzip → parse).
  Its docstring documents known gaps you close: campaign-name join via Exports API; budget
  usage via Budgets endpoints.
- `~/os/amazon-agent/tools/ads-auth/exchange_token.py` — LWA code-exchange reference.
- `~/os/amazon-agent/Amazon Ads Help/` — offline API docs library (entity endpoints, SB v4,
  SD, Exports, report types). SB campaign management is **v4 only** (v3 was shut off 2024).

## Spec

1. `AdsApiClient` constructed with `{clientId, clientSecret, refreshToken, region}` (types
   from shared); all methods typed. Zero `any`.
2. Surface (v1 needs): `getProfiles()` (v2 profiles); entity lists with pagination —
   campaigns/adGroups/keywords/targets/negatives/productAds for SP, campaigns/adGroups for
   SB (v4) + SD; `createExport`/`getExport`/`downloadExport` (entity bulk + name joins);
   `createReport`/`getReport`/`downloadReport` (Reporting v3) with per-ad-product typed row
   parsers (SP target, SP search term, SP placement-grouped, SB, SD — schemas differ, one
   typed parser each, never generic); budgets + budget usage endpoints.
3. **Throttle/retry:** exponential backoff + jitter on 429 (honor `Retry-After` when present),
   retry idempotent GETs on 5xx, single retry on token expiry after forced refresh. Backoff
   state surfaced to the caller (worker owns pacing policy; client owns per-request retry).
4. Handle gzip and already-decompressed bodies (datasource.py tolerance), report statuses
   PENDING/PROCESSING/COMPLETED/FAILURE, 425 duplicate-report responses.
5. Tests: msw-recorded fixtures for every endpoint including 429/Retry-After, 425, PENDING→
   COMPLETED sequences, gzip handling, token refresh. No live calls in CI.
6. **Live smoke script** `packages/ads-api/scripts/smoke.ts` (operator-run, reads config from
   `_local/ads-api.config.json`, template committed): gets profiles, creates one spCampaigns
   report for a given profile + day, polls to completion, downloads, prints row count and
   parsed-vs-downloaded byte/row stats. Also: one Exports call to verify the campaign-name
   join contract (this is UNVERIFIED live — flag surprises in your report).

## Out of scope

Queue/scheduling (WP-03), token storage (WP-04/Vault), write endpoints beyond typed stubs
(v1.x), Marketing Stream, AMC.

## Acceptance checks

- Fixture suite green incl. all failure paths listed above.
- Live smoke (operator runs it): full request→poll→download on 1 real profile prints row
  count; Exports smoke returns campaign id→name mapping; deviations documented.
- `packages/ads-api` imports nothing from `db`/`core`/apps; grep proves it.
- Branch `wp-02-ads-api`; report per acceptance check.
