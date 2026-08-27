# WP-40 — Integration connections: Vault custody + /settings/integrations

**Status:** open · **Owner:** Codex (gpt-5.6-sol) · **Branch:** `wp-40-integration-connections`

## Why

Keepa, DataDive, and MyRealProfit integrations (WP-42/43/44) all need per-org API
credentials entered once in the web UI and held in Supabase Vault. This WP builds the ONE
generic foundation they share. No external API calls happen here.

## Design decisions (made — implement)

- ONE generic table `integration_connections` with a provider enum, not per-provider
  tables. Provider-specific knobs live in `config jsonb`.
- Secrets go to Vault via security-definer RPCs, service-role only — copy the exact shape
  of the `vault_rpcs` migration (20260813120900) and the `spapi_connections` table shape
  (`reserved_seams` migration, 20260813121100, line 18).
- The web tier stores a key ONCE and never reads it back; only the worker (service role)
  retrieves it.

## Scope

1. **Migration `supabase/migrations/<timestamp>_integration_connections.sql`** (use a
   timestamp AFTER 20260827130000 — two WP-38/35 migrations already occupy 2026-08-27
   12:00/13:00 slots):
   - `create type public.integration_provider as enum ('keepa', 'datadive', 'mrp')`.
   - `public.integration_connections`: id uuid pk; org_id FK; provider
     integration_provider not null; label text not null; `vault_secret_id uuid` (pointer
     only); `config jsonb not null default '{}'`; `status public.connection_status
     default 'pending'`; connected_by FK auth.users set null; connected_at;
     last_synced_at; last_error; created_at/updated_at + touch trigger;
     `unique (org_id, provider, label)`. `select app.install_tenant_rls(
     'public.integration_connections', array['owner','admin'])` (check the helper's exact
     signature in `20260813120000_platform.sql` before use).
   - Three RPCs modelled byte-for-byte on `vault_rpcs.sql` custody rules
     (`app.assert_service_role`, EXECUTE revoked from public/anon/authenticated, granted
     to service_role): `store_integration_secret(p_connection_id uuid, p_token text)`
     (vault name `wizard-ads:integration-connection:<id>`, sets status 'active'),
     `get_integration_secret(p_connection_id uuid)`, `revoke_integration_secret(
     p_connection_id uuid)` (deletes Vault row, sets status 'revoked').
2. **Drizzle mirror**: new `packages/db/src/schema/integrations.ts` (+ enum in
   `schema/enums.ts` if that's the convention — check), exported from `schema/index.ts`.
   Query helpers `packages/db/src/queries/integrations.ts`: list by org, create, set
   status/error, plus TS wrappers for the three RPCs following
   `packages/db/src/queries/tokens.ts`.
3. **Web UI `/settings/integrations`** (`apps/web/app/settings/integrations/page.tsx` +
   actions): follow `/settings/connections` structure and gate on `manageConnection`.
   Per provider (Keepa, DataDive, My Real Profit): status row (label, status,
   connected_at, last_error, revoke) + "connect" form (label optional, one secret input;
   posts to a server action that creates the row then calls store RPC; the input is never
   echoed back). Masked display = provider + label + status only. Add to the settings tab
   bar (Connections · Profiles · Members? · Sync status — WP-39 may be adding Members in
   parallel; touch ONLY your own tab entry and keep the edit minimal to avoid conflicts).
4. **Tests**: RLS case for `integration_connections` (fixture row in
   `supabase/tests/tenant-fixture.sql` + `packages/db/src/rls.test.ts` — note whether
   install_tenant_rls tables are auto-walked; follow what WP-38 did for org_invitations);
   Vault RPC round-trip tests mirroring the existing `vault` tests (store/get/revoke,
   empty-token refusal, non-service-role refusal); migrations test picks up the file —
   run it.

## Constraints

- Program rules in /AGENTS.md bind. NO `packages/shared` edits (job types come in WP-41).
  No worker changes.
- Roadmap/feedback items: never set `shipped`; keep `in_progress` pending Victor.
- Branch `wp-40-integration-connections`; commits `feat(wp-40): ...`; no push, no merge.
- Verify: `pnpm typecheck && pnpm lint && pnpm test` green; state exactly which DB suites
  ran or skipped.
- Final message: schema decisions, RPC custody notes, operator steps (hosted apply; key
  entry), and the exact interface WP-42/43/44 should consume (function signatures).
