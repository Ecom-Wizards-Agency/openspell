# WP-04 — Web auth, orgs, LWA OAuth, connections UI (`apps/web`)

**Owner:** Codex · **Phase:** v0 · **Depends on:** WP-00, WP-01 · **Blocks:** first real profile sync

## Goal

Login + org context, and the "Connect Amazon Ads" flow that lands the agency's advertiser
profiles in the DB — the tool's authorization happens through this webpage.

## Read first

- `docs/PLAN.md` — "Sync architecture" → OAuth paragraph (your spec)
- `~/os/amazon-agent/tools/ads-auth/callback-worker/src/index.ts` — the existing, working LWA
  redirect worker. Reuse its signed-state pattern (HMAC state, 15-min expiry). wizard-ads gets
  its own redirect URI; the worker stays untouched for CLI flows.
- `~/os/amazon-agent/tools/ads-auth/exchange_token.py` — code-exchange + 3-region profiles
  smoke reference.
- WP-01's Vault RPCs (`store_ads_refresh_token`).

## Spec

1. **Auth:** Supabase Auth (email magic link + Google). Org switcher; membership/roles from
   `org_members`. No public signup — users are invited/seeded (internal-first).
2. **OAuth flow:**
   - `GET /api/amazon/oauth/start` (admin+ role): builds LWA authorize URL with
     `scope=advertising::campaign_management`, signed `state` bound to org + session, 15-min
     expiry.
   - `GET /api/amazon/oauth/callback`: validate state (reject tampering/expiry), exchange code
     server-side (client secret only in server env), store refresh token via Vault RPC, insert
     `ads_connections`, then fetch `/v2/profiles` for all three regions and upsert
     `ad_profiles` (~211 expected for the agency grant). Show a results page: N profiles per
     region.
   - Amazon API calls here go through `packages/ads-api` — this is the ONE allowed
     `ads-api` import in web (server route only). Everything else uses the worker.
3. **Connections & profiles UI** (settings area): connection status + reconnect;
   profile roster (search/filter by region/country/name) with per-profile `sync_enabled`
   toggle and editable targets: target ACOS, target total ACOS, goal lens, monthly budget.
   Roles: viewer read-only; analyst edits targets; admin+ toggles sync and connects.
4. Sync-status page v0: `sync_jobs` + `report_requests` per profile (status, freshness,
   errors) — read-only table, no styling polish yet (WP-06 owns look & feel).

## Out of scope

Dashboard/grid (WP-06), any Amazon calls beyond the OAuth routes, token use (worker's job).

## Acceptance checks

- Playwright: login → connect flow with mocked LWA → profiles appear with region counts;
  `sync_enabled` toggle + target edits persist and respect roles.
- State tampering and expired state are rejected (tests for both).
- Refresh token retrievable only via service-role RPC — anon/user session attempt fails (test).
- No `ads-api` import outside the two OAuth route files (lint/grep in CI).
- Branch `wp-04-web-auth`; report per acceptance check. Flag to the operator: the new
  redirect URI must be added to the LWA app's Allowed Return URLs before live testing.
