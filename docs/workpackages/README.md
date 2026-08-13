# wizard-ads work packages — implementer guide

You are an implementation agent (Codex or Claude Opus) building **wizard-ads**, Ecom Wizards'
in-house Amazon Advertising tool (AdLabs clone + differentiators). A manager agent (Fable)
planned the build and reviews your work. Each `WP-XX-*.md` file in this directory is a
self-contained handover brief: read it, implement it, report against its acceptance checks.

## Program rules (apply to every work package)

1. **Own your package only.** Each WP owns specific directories. Never edit files owned by
   another WP. Cross-package shapes live in `packages/shared` — if you need a contract change,
   STOP and report it; only WP-00's owner changes contracts, with manager sign-off.
2. **Dependency direction (enforced):** `shared` ← `core`/`strategy`/`ads-api`/`db` ←
   `web`/`worker`/`mcp`. `packages/core` never imports `db` or `ads-api`. `apps/web` never
   imports `ads-api` (all Amazon calls live in the worker).
3. **This repo will be public.** Never commit: credentials, client names, the profile roster,
   doctrine threshold values, or absolute `/Users/` paths. Tenant-specific values are DB data
   or gitignored `_local/` files; only `*.TEMPLATE.json` is tracked.
4. **Verify the artifact, not the exit code.** Any list-driven operation must count outputs
   against inputs (rows parsed vs loaded, entities listed vs upserted) as test assertions.
5. **Reference code is spec, not dependency.** The Python tools in
   `~/os/amazon-agent/tools/` are read-only ground truth. Port logic; never import, modify, or
   copy files wholesale from that repo. Its selftests define correct behavior.
6. **TypeScript strict everywhere.** pnpm workspaces + Turborepo. Tests with Vitest
   (Playwright for e2e). Every WP lands with its tests green via `pnpm turbo test`.
7. **Work on a branch** named `wp-XX-short-name`; commit in logical units. The manager reviews
   against the brief's acceptance checks before merge to `main`.
8. **Report format:** when done, summarize per acceptance check: what you ran, what proved it,
   plus anything you consciously deviated on and why. Unresolved blockers go at the top.

## Package ownership map

| WP | Owns |
|---|---|
| 00 | repo root configs, `packages/shared`, CI, `AGENTS.md`, hygiene lint |
| 01 | `supabase/migrations`, `packages/db` |
| 02 | `packages/ads-api` |
| 03 | `apps/worker`, pg_cron enqueue SQL (via migration handoff to WP-01) |
| 04 | `apps/web` auth/oauth/settings routes, Vault RPC migration (handoff to WP-01) |
| 05 | `packages/core`, `packages/strategy`, `fixtures/` |
| 06 | `packages/ui`, `apps/web` dashboard + grid routes |
| 07 | `apps/web` recommendations/ngram routes, export bridge |
| 08 | `apps/web` tags + `/go/[token]` routes, related queries in `packages/db` (coordinate) |
| 09 | `apps/mcp` |
| 10 | `tools/crosscheck-cli`, crosscheck job handler (handoff to WP-03), results UI panel |
| 11 | `tools/recon/` (specs only, no code) |
| 12 | staged-apply engine (v1.x — gated) |
| 13 | headless analyst (v1.x — gated) |

## Key facts every implementer should know

- Amazon Ads API access is LIVE (LWA app with `advertising::campaign_management`; refresh
  token exists operator-side). Live smoke tests read creds from gitignored `_local/` config —
  ask the operator to place it; never hardcode.
- Reporting v3 is async: request → poll (up to ~3h) → download GZIP_JSON. Throttling is
  HTTP 429 only (sometimes `Retry-After`, never quota headers) → exponential backoff + jitter.
- Reports omit zero-impression rows; sales restate for 14+ days; same-day data is provisional.
- Profiles span NA/EU/FE regions (separate hosts), multiple currencies and timezones.
- Full architecture: `docs/PLAN.md` (copy of the approved plan).
