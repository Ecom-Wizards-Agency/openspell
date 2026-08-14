# WP-22 — Worker ↔ Ads API integration + first live sync

**Owner:** Claude Opus · **Phase:** v0 close · **Depends on:** WP-02, WP-03 (merged)

## Goal

Close the one remaining `INTEGRATE(WP-02)` seam so the sync worker can actually talk to
Amazon, then prove the full pipeline against the hosted database on a small pilot set.

## The seam

`apps/worker/src/ads-api.ts` — `createAdsApiClientFromEnv()` throws. Replace it with a real
adapter implementing the worker's `AdsApiClient` interface (listEntities / createReport /
getReport / downloadReport / listProfiles) on top of `@wizard-ads/ads-api`'s `AdsApiClient`.

Requirements:
1. **Per-connection, per-region construction.** The worker's methods take an
   `AdsProfileContext` (has region + the amazon profile id + our profile/connection ids). The
   real client is per-(refreshToken, region). Build/cache a real client per connection+region:
   fetch the connection's refresh token via the db Vault RPC (`get_ads_refresh_token`, service
   role) — never log it — plus LWA client id/secret from env (`AMAZON_LWA_CLIENT_ID`,
   `AMAZON_LWA_CLIENT_SECRET`). Cache by connectionId+region; the underlying client already
   caches access tokens.
2. **Method mapping** (mechanical): listEntities → the client's entity list calls per level
   union (respect `full` for the tombstone-sweep gate WP-03 added); createReport →
   `createReport`; getReport → `getReport` (remember the live-verified per-entity Accept for
   exports if entity export is used for the name join); downloadReport → `downloadReport`
   (stream). Map the client's throttle/425/expired-url errors onto the worker's
   `AdsApiRetryableError` / `DownloadUrlExpiredError` so the queue's backoff fires.
3. **listProfiles(region)** → the client's `getProfiles()` filtered to that region's ids.
4. Unit-test the adapter with a mock underlying client + a mock Vault fetch (no network); the
   worker's existing integration tests keep using their fake `AdsApiClient` — don't disturb
   them.

## Live proof (operator-run, documented commands)

5. A `pnpm --filter @wizard-ads/worker start` path that runs the claim loop against a given
   `DATABASE_URL` + LWA env. Document the exact command. The manager runs it locally against
   the hosted DB for ≤2 pilot profiles (set `sync_enabled=true` on exactly those), watches:
   entity sync populates the mirror, a spCampaigns report goes request→poll→fetch, and
   `fact_*` rows land — then the dashboard shows numbers.
6. Deploy notes in `apps/worker/README.md`: the Fly.io path (Dockerfile + fly.toml exist),
   the three secrets (`DATABASE_URL` pooler string, `AMAZON_LWA_CLIENT_ID`,
   `AMAZON_LWA_CLIENT_SECRET`), and that pg_cron enqueue is already live on the hosted DB.

## Acceptance checks

- Adapter unit tests green (mock client + mock Vault); token never logged.
- `pnpm check` green; worker integration suite still green.
- Live: on a local run against hosted DB with 2 pilot profiles, `fact_sp_target_daily` (or
  `fact_profile_daily`) gains rows for a recent day, counts reconciled, and `/dashboard` for
  that profile renders real figures. (Manager executes; agent provides the commands + a
  verification query.)
- Branch `wp-22-worker-integration`; report per check + the exact operator run commands.
