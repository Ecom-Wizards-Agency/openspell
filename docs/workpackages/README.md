# OpenSpell work packages — implementer guide

These briefs describe work on **OpenSpell**. Read `AGENTS.md` first; it is authoritative.
Numbered packages are delivery records, not permanent owners. Active briefs declare exact file
scope, and concurrent work must use disjoint files.

For the September 5 re-plan, start with `REPLAN-2026-09-05.md` and its audit companion.
Claude Fable 5.1 owns frontend design. The operator expects to work with Claude on WP-207/D1
and WP-216/D2. The implementation agent owns the UI-driven Amazon write path and its later MCP
integration. Do not infer live authorization from a brief or from available credentials.

## Program rules (apply to every work package)

1. **Respect active file scope.** Coordinate shared files before editing. Cross-package shapes
   live in `packages/shared`; approved additive contracts land and are verified before consumers.
   Historical WP-00 ownership does not override the current `AGENTS.md` contract authority.
2. **Dependency direction (enforced):** `shared` ← `core`/`strategy`/`ads-api`/`db` ←
   `web`/`worker`/`mcp`. `packages/core` never imports `db` or `ads-api`. `apps/web` never
   imports `ads-api` (all Amazon calls live in the worker).
3. **This repo is public.** Never commit: credentials, client names, the profile roster,
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

## Historical package map

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
| 14 | `packages/campaigns` (+ its goldens in `fixtures/`) |

## Key facts every implementer should know

- Available credentials do not authorize live calls. Inject secrets from approved runtime
  storage; `_local/` holds bounded non-secret authorization/configuration, not real secrets.
  Live writes follow `AGENTS.md` and the exact operational scope granted for the task.
- Reporting v3 is async: request → poll (up to ~3h) → download GZIP_JSON. Throttling is
  HTTP 429 only (sometimes `Retry-After`, never quota headers) → exponential backoff + jitter.
- Reports omit zero-impression rows; sales restate for 14+ days; same-day data is provisional.
- Profiles span NA/EU/FE regions (separate hosts), multiple currencies and timezones.
- Full architecture: `docs/PLAN.md` (copy of the approved plan).
