# OpenSpell repository overview for an external collaborator

Source snapshot: `560d5e2`, reviewed on 2026-09-05. Operational state below is reported
historical evidence from `docs/HANDOVER.md` and `docs/STATUS.md`, not a fresh production audit.
Appendix commands identify source inventories; WP-212 owns full reproducible table generation.
Do not infer hosted state from repository filenames. Review notes: `workpackages/REPLAN-2026-09-05-AUDIT.md`.

## 1. What OpenSpell is

OpenSpell is an in-house Amazon Advertising operator tool built by Ecom Wizards. It connects
to the Amazon Ads API, mirrors campaigns, ad groups, keywords, targets and negatives for every
advertising profile, ingests Reporting v3 daily reports into partitioned fact tables, and
produces bid and budget recommendations that show every input they used. On top of that it
adds what the commercial tools lack: search-query share versus paid share, rank tracking,
competitor price events, a creative asset view for Sponsored Brands Video, dayparting from
Marketing Stream, experiments, a change timeline with inverse exports, and a read-only MCP
server so an AI assistant can query the data.

It was built in three weeks, from 2026-08-13 to 2026-09-04, by AI agents working from written
work-package briefs under a manager agent, with a human operator approving each step.

| Measure | Value |
|---|---|
| Commits on main | 736 |
| Lines of TypeScript, SQL and Rust | 267233 |
| Unit and integration test files | 324 |
| Playwright specs / suites | 17 / 11 |
| SQL migrations | 46 (41 applied to the hosted database) |

## 2. What is live versus merged

Production runs an older revision than main. As of 2026-09-04 the web app serves a revision
from 2026-08-30, the MCP serves one from 2026-08-29, and the five newest migrations are merged
but not applied to the hosted database. Everything merged after 2026-08-30 is source only until
the re-plan in `docs/workpackages/REPLAN-2026-09-05.md` deploys it. When you read
`docs/STATUS.md`, "merged" never means "live".

Live today: login and invitations, Amazon OAuth and profile discovery, entity and report sync,
Dashboard, Data Grid, Recommendations preview and export, N-gram explorer, Tags, deep links,
Time Machine, Experiments, Optimization groups, Crosscheck, Sync status, Settings, Bugs and
Roadmap intake, the read-only MCP with 11 tools, Keepa, DataDive and product-economics
integrations.

Merged, not live: Creative Performance data, Query Intelligence with live SQP, Dayparting with
live Marketing Stream, weekday review schedules, campaign-scoped optimizer previews, the guarded
Amazon write path, campaign creation contracts.

The reviewed source has no application consumer of the SP write adapter/ledger and no direct
write HTTP route. Current apply paths produce exports. WP-214 will connect operator-approved
UI changes to the Amazon worker, independently of MCP; WP-217 later adds bounded MCP access.
A separate HTTP integration API for external scripts is out of scope. This source finding does not establish the complete history of live-account activity.

## 3. Stack and repository layout

pnpm workspaces with Turborepo, TypeScript strict everywhere, Next.js App Router on Vercel,
Supabase Postgres with Auth, Vault and pg_cron, Drizzle for typed queries over hand-written
SQL migrations, Zod contracts, Vitest and Playwright, a small always-on Node worker and the MCP
server on a Linux host behind a Cloudflare Tunnel. Two Rust crates exist under `tools/` for a
parked migration-supervisor program; they are not deployable and play no runtime role.

Dependency direction is enforced by ESLint:

```
shared  <-  core / strategy / ads-api / sp-api / db  <-  web / worker / mcp
```

`packages/shared` is the contract package and imports nothing of ours. `packages/core` is
pure and never touches a database or an API; that is what makes it replayable against the
committed golden fixtures. `apps/web` never imports `packages/ads-api`.

| Path | Role |
|---|---|
| `packages/shared` | Zod schemas and inferred types for every cross-package shape, including queue jobs, recommendations, campaign creation and Sponsored Products writes |
| `packages/db` | Drizzle schema mirror, typed queries, RLS test harness, seeders |
| `packages/ads-api` | Pure Amazon Ads API client: LWA tokens, profiles, entities, Exports, Reporting v3, budgets, Sponsored Products write endpoints, Unified Reporting |
| `packages/sp-api` | Selling Partner API report client for Brand Analytics SQP |
| `packages/core` | Doctrine engine: trend analysis, flags, pacing, weekly recommendation lists, White Box bidding math, n-grams, query-intelligence rules, optimizer observation |
| `packages/strategy` | Tenant strategy resolution; ships a template only, never threshold values |
| `packages/campaigns` | Pure campaign planner producing bulk-upload workbooks |
| `packages/ui` | Data Grid on TanStack Table and react-virtual, toolbar, chart and tile primitives |
| `packages/keepa-api`, `packages/datadive-api`, `packages/mrp-api` | Integration clients for BSR, rank and product economics |
| `apps/web` | Next.js operator app: pages, route handlers, auth, the five-minute cron tick |
| `apps/worker` | Sync, reports, schedules, integrations; the sanctioned Amazon caller |
| `apps/mcp` | Streamable HTTP MCP server with bearer keys and audit logging |
| `apps/analyst` | Headless daily analyst that reads through the MCP and writes insights |
| `supabase/` | Migrations, RLS, partitions, cron, a shim so plain Postgres can run the tests |
| `fixtures/` | Golden files replayed by `packages/core` tests |
| `tools/` | Crosscheck CLI, AdLabs backfill, hygiene linter, recon specs, migration tools |

## 4. The Amazon boundary as it actually is

The intended rule is that only the worker calls Amazon. The runtime reality is:

- The Vercel cron route `apps/web/app/api/cron/sync/route.ts` builds the Ads API client through
  `apps/worker/src/ads-api.ts` and runs `entity.sync`, and by default also the `report.*` jobs,
  inside a Vercel function every five minutes. The web deployment therefore holds the LWA client
  secret and reads refresh tokens through a Vault RPC.
- An environment flag moves report jobs to an always-on worker on the Linux host. A second
  always-on worker there runs the Keepa, DataDive, product-economics and SQP jobs.
- No web page, route or MCP tool writes to Amazon. The write contract in `AGENTS.md` describes
  how that will work: immutable preview, explicit confirmation naming Amazon and the exact count,
  idempotent worker execution, counts reconciled, audit, resynchronization.

The cron's credential access contradicts the current `AGENTS.md` boundary. Document it as an
existing exception requiring resolution; it does not authorize new web-hosted Amazon operations.
New write execution remains worker-only.

## 5. Data model

All tenant tables carry `org_id` with row-level security installed by one helper. Facts are
monthly range partitions. Money is Postgres `numeric`. The queue is a table (`sync_jobs`) with
`FOR UPDATE SKIP LOCKED` claim functions; there is no Redis and no external scheduler.

| Schema file (packages/db/src/schema) | Tables |
|---|---|
| analysis.ts | 6 |
| apply.ts | 3 |
| bid-series.ts | 1 |
| economics.ts | 1 |
| entities.ts | 8 |
| experiments.ts | 2 |
| facts.ts | 7 |
| integrations.ts | 1 |
| operator-intelligence.ts | 20 |
| seams.ts | 11 |
| sp-write-outbox.ts | 2 |
| sp-writes.ts | 28 |
| surface.ts | 5 |
| sync.ts | 6 |
| tenancy.ts | 6 |

Queue job types: `entity.sync`, `report.request`, `report.poll`, `report.fetch`, `crosscheck.ingest`, `recommendations.run`, `keepa.sync`, `rank.sync`, `economics.sync`, `sqp.categorize`, `creative.sync`, `sqp.request`, `history.bootstrap`, `report.promote`, `marketing_stream.normalize`, `report.unified.advance`.

Reporting v3 is split into request, poll and fetch jobs so a killed worker resumes. Every
ingest reconciles offered, parsed, refused, promoted and canonical row counts; a zero exit code
is never evidence.

## 6. Product surface

Web pages: `/`, `/auth/mfa/challenge`, `/bugs`, `/campaigns`, `/connect-claude`, `/creative`, `/crosscheck`, `/dashboard`, `/dayparting`, `/experiments`, `/experiments/[experimentId]`, `/experiments/new`, `/feedback`, `/feedback/new`, `/forgot-password`, `/grid`, `/invite/[token]`, `/login`, `/ngrams`, `/optimizer`, `/optimizer/groups`, `/query-intelligence`, `/recommendations`, `/recover-password`, `/roadmap`, `/settings`, `/settings/account`, `/settings/connections`, `/settings/integrations`, `/settings/members`, `/settings/profiles`, `/strategy`, `/sync-status`, `/tags`, `/time-machine`.

MCP tools: `list_experiments`, `get_experiment`, `list_profiles`, `get_sync_status`, `get_entity_data`, `query`, `group_by`, `download_data`, `get_recommendations`, `get_flags`, `get_pacing`. Keys are read-only, profile-scoped, expiring, and every call is audit-logged.

Route handlers are listed in the appendix.

## 7. Doctrine engine

`packages/core` is a TypeScript port of the agency's Python tooling. Thresholds are never in
source; they arrive as arguments from per-tenant database rows seeded from a gitignored file.
The bidding math follows the public AdLabs White Box: bid equals revenue per click times target
ACOS, four recommendation reasons, a data-confidence hierarchy from keyword to ad group to
campaign to profile, layered ceilings, and change caps applied as clamps. Ratios such as ACOS
are always computed from sums, never averaged.

## 8. Running it locally

```bash
corepack enable && pnpm install
supabase start && supabase db reset          # or plain Postgres plus supabase/tests/supabase-platform-shim.sql
pnpm --filter @wizard-ads/db seed:dev        # synthetic org, profiles, 60 days of facts; refuses non-localhost
# Inspect apps/web/env.TEMPLATE; inject local synthetic configuration into the process.
# Real credentials belong in the approved secret manager/runtime, never a local .env file.
pnpm --filter @wizard-ads/web dev
pnpm --filter @wizard-ads/worker start       # optional
pnpm --filter @wizard-ads/mcp start          # optional; mint a key with pnpm --filter @wizard-ads/mcp keys
pnpm check                                   # typecheck, lint, test, hygiene, skill lint
```

Accounts needed for live data: a Supabase project, an Amazon Ads LWA application with a
registered redirect URI, optionally an SP-API application, Keepa, DataDive and product-economics
credentials entered through the settings page into Vault, an AWS SQS queue for Marketing Stream,
a Vercel project, and a Linux host with systemd and a Cloudflare Tunnel.

Environment variable names, values never in Git:

- web: `AMAZON_ADS_HOST_EU`, `AMAZON_ADS_HOST_FE`, `AMAZON_ADS_HOST_NA`, `AMAZON_LWA_AUTHORIZE_URL`, `AMAZON_LWA_CLIENT_ID`, `AMAZON_LWA_CLIENT_SECRET`, `AMAZON_LWA_TOKEN_URL`, `AMAZON_OAUTH_REDIRECT_URI`, `AMAZON_OAUTH_STATE_KEY`, `DATABASE_URL`, `GOTO_LINK_SIGNING_SECRET`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WIZARD_ADS_APP_URL`, `WIZARD_ADS_AUTH_BRIDGE_SECRET`, `WIZARD_ADS_E2E_AUTH`, `WIZARD_ADS_E2E_AUTH_BRIDGE`, `WIZARD_ADS_GOOGLE_LOGIN`, `WIZARD_ADS_MCP_URL`, `WIZARD_ADS_PASSKEYS`, `WIZARD_ADS_PASSWORD_LOGIN`, `WIZARD_ADS_PASSWORD_RECOVERY`, `WIZARD_ADS_SECURE_COOKIES`, `WIZARD_ADS_TOTP_POLICY`
- worker: `CROSSCHECK_INBOX_DIR`, `MARKETING_STREAM_SQS_QUEUE_URL`, `OPENSPELL_CREATIVE_SYNC_PRODUCER_READY`, `OPENSPELL_CREATIVE_SYNC_PROFILE_ALLOWLIST`, `OPENSPELL_EVO_REPORT_LANE_READY`, `OPENSPELL_UNIFIED_REPORTING_DUAL_RUN_READY`, `OPENSPELL_UNIFIED_REPORTING_PROFILE_ALLOWLIST`, `OPENSPELL_WORKER_REVISION`, `SP_API_LWA_CLIENT_ID`, `SP_API_LWA_CLIENT_SECRET`, `SP_API_REPORT_MIN_INTERVAL_MS`, `WORKER_AUTH_HEALTHCHECK_MINUTES`, `WORKER_CLAIM_BATCH_SIZE`, `WORKER_DEPLOYMENT_ROLE`, `WORKER_HEALTH_HOST`, `WORKER_ID`, `WORKER_JOB_TYPES`, `WORKER_MAX_CONCURRENT_JOBS`, `WORKER_POLL_INTERVAL_MS`, `WORKER_STALE_CLAIM_AFTER`
- mcp: `DATABASE_URL`, `WIZARD_ADS_MCP_DATABASE_URL`, `WIZARD_ADS_MCP_HOST`, `WIZARD_ADS_MCP_MAX_DOWNLOAD_BYTES`, `WIZARD_ADS_MCP_MAX_ROWS`, `WIZARD_ADS_MCP_POOL_SIZE`, `WIZARD_ADS_MCP_PORT`, `WIZARD_ADS_MCP_REVISION`, `WIZARD_ADS_MCP_STATEMENT_TIMEOUT`, `WIZARD_ADS_WEB_BASE_URL`

## 9. Tests and CI

`pnpm check` runs typecheck, lint, every Vitest suite, the hygiene linter and the skill linter.
Database suites apply the real migrations to a throwaway Postgres and include row-level
security negative tests. Playwright runs 11 serial suites, each with its own database.
CI's `check` job currently runs typecheck, lint, test and hygiene, plus dedicated deployment
and migration checks; it does not invoke skill lint. Playwright has a separate job. Workflows
are `ci.yml` and `trusted-kernel-proof.yml`; moving the latter to manual dispatch is planned
under Claude-owned WP-207 and has not been done by this review.

## 10. Public-repository rules you inherit

The repository is public. `pnpm hygiene` scans tracked files and fails on absolute home paths,
credential-shaped strings, and any term in the operator's gitignored denylist. Beyond the linter:
no client names, no profile roster, no doctrine threshold values, no real data in fixtures.
Tests assemble forbidden strings from fragments at runtime. Before your first push, copy the
templates in `_local/` and keep every tenant-specific value there.

## 11. Merging your work into OpenSpell

The plan is to bring your features and the frontend parts that work well into this monorepo.
Where an incoming piece lands:

- a cross-package shape becomes a Zod schema in `packages/shared` first;
- a query becomes a typed function in `packages/db` with `org_id` scoping and a test against
  the real migrations;
- pure logic goes to `packages/core` with fixture-driven tests and no I/O;
- a page goes under `apps/web/app` as a server component that loads through `packages/db` and
  renders with `packages/ui` primitives; tables must use the Data Grid;
- anything that calls Amazon goes to `apps/worker` as a job type, never to a route handler;
- anything that changes Amazon must go through the write contract in `AGENTS.md`.

Hazards to plan for:

1. The queue is custom Postgres with two schedulers, pg_cron and the Vercel tick. A BullMQ or
   Redis queue would be a second system; port jobs into `sync_jobs` instead.
2. The web tier connects with a service-role database URL and enforces roles in application
   code. Service-role connections bypass RLS, so explicit org scoping and authorization are
   mandatory on every such query. Authenticated-role connections, including the planned human
   approval transport, are subject to their own RLS and function grants.
3. Supabase specifics in use: Vault for refresh tokens and integration secrets, pg_cron, and
   `auth.uid()` in RLS policies. A shim exists so CI runs on plain Postgres.
4. Workspace packages ship raw `.ts` with `.js` import specifiers; Next builds with webpack and
   an extension alias. An incoming package must follow the same convention or the build fails
   silently with empty barrels.
5. Golden fixtures for `packages/core` come from a private Python repository; treat the
   committed goldens as the frozen spec.
6. Money must stay decimal-exact end to end; the write contract requires canonical decimal
   strings.
7. The Sponsored Products write ledger under `sp_write_*` is large and specific. Merge into it,
   do not bypass it.

## 12. What we need from you

Please return the same kind of document for your codebase, covering:

1. Feature list with one screenshot each and the data it depends on.
2. External APIs and scopes used, and how credentials are stored.
3. Data model: tables or collections with a one-line purpose each.
4. Background work: queue or scheduler, job list, retry and idempotency approach.
5. Auth model: users, roles, tenancy.
6. Frontend: framework, component library, the three or four screens you consider best.
7. Deployment: hosts, environments, how a release is verified.
8. Tests: what exists and how it runs.
9. Anything that writes to Amazon today, and how it is approved and logged.

## Appendix A. Workspace packages

Source discovery: `rg --files apps packages tools -g package.json -g '!node_modules'`.
The initial table below was source-reviewed; WP-212 will supply the command that emits its
path/name Markdown verbatim rather than claiming a names-only command reproduces it.

| Path | Package |
|---|---|
| apps/analyst | @wizard-ads/analyst |
| apps/mcp | @wizard-ads/mcp |
| apps/web | @wizard-ads/web |
| apps/worker | @wizard-ads/worker |
| packages/ads-api | @wizard-ads/ads-api |
| packages/campaigns | @wizard-ads/campaigns |
| packages/core | @wizard-ads/core |
| packages/datadive-api | @wizard-ads/datadive-api |
| packages/db | @wizard-ads/db |
| packages/keepa-api | @wizard-ads/keepa-api |
| packages/mrp-api | @wizard-ads/mrp-api |
| packages/shared | @wizard-ads/shared |
| packages/sp-api | @wizard-ads/sp-api |
| packages/strategy | @wizard-ads/strategy |
| packages/ui | @wizard-ads/ui |
| tools/adlabs-backfill | @wizard-ads/adlabs-backfill |
| tools/crosscheck-cli | @wizard-ads/crosscheck-cli |
| tools/hosted-migration-bundle | @wizard-ads/hosted-migration-bundle |
| tools/hosted-migration-conformance | @wizard-ads/hosted-migration-conformance |
| tools/hosted-migration-root-authority | @wizard-ads/hosted-migration-root-authority |
| tools/hosted-migration-runtime-proof | @wizard-ads/hosted-migration-runtime-proof |
| tools/hygiene-lint | @wizard-ads/hygiene-lint |

## Appendix B. Migrations

Source inventory: `rg --files supabase/migrations -g '*.sql' | sort`. Coverage is the reported
2026-09-04 schema snapshot, not output of that command. The first 30 actual hosted version
numbers differ from these canonical repository filenames. Refresh the private ledger mapping
before applying anything; never push canonical history directly to the hosted project.

| Canonical repository migration | Reported schema coverage |
|---|---|
| 20260813120000_platform.sql | present in reported prefix |
| 20260813120100_tenancy.sql | present in reported prefix |
| 20260813120200_entity_mirror.sql | present in reported prefix |
| 20260813120300_facts.sql | present in reported prefix |
| 20260813120400_partition_automation.sql | present in reported prefix |
| 20260813120500_sync.sql | present in reported prefix |
| 20260813120600_analysis.sql | present in reported prefix |
| 20260813120700_writes.sql | present in reported prefix |
| 20260813120800_product_surface.sql | present in reported prefix |
| 20260813120900_vault_rpcs.sql | present in reported prefix |
| 20260813121000_cron.sql | present in reported prefix |
| 20260813121100_reserved_seams.sql | present in reported prefix |
| 20260814070000_rpc_grants_hardening.sql | present in reported prefix |
| 20260814120000_mcp_api_keys.sql | present in reported prefix |
| 20260814130000_profile_target_total_acos.sql | present in reported prefix |
| 20260814140000_sync_schedule_variant.sql | present in reported prefix |
| 20260814150000_feedback.sql | present in reported prefix |
| 20260814160000_report_request_source.sql | present in reported prefix |
| 20260814170000_profile_sync_schedule_prefs.sql | present in reported prefix |
| 20260814180000_experiments.sql | present in reported prefix |
| 20260814190000_bid_series.sql | present in reported prefix |
| 20260827120000_invitations.sql | present in reported prefix |
| 20260827130000_feedback_dedup.sql | present in reported prefix |
| 20260827140000_integration_connections.sql | present in reported prefix |
| 20260827150000_sync_job_types.sql | present in reported prefix |
| 20260827150100_filtered_job_claims.sql | present in reported prefix |
| 20260827150200_sqp_schedule_payload.sql | present in reported prefix |
| 20260827150300_product_economics.sql | present in reported prefix |
| 20260827150400_keepa_market.sql | present in reported prefix |
| 20260827150500_comparison_report_windows.sql | present in reported prefix |
| 20260829120000_operator_intelligence_foundations.sql | present in reported prefix |
| 20260829130000_time_machine_v2.sql | present in reported prefix |
| 20260829140000_feature_job_types.sql | present in reported prefix |
| 20260829150000_spapi_profile_bindings.sql | present in reported prefix |
| 20260829160000_sb_video_report_type.sql | present in reported prefix |
| 20260829160100_sb_video_observed_ingestion.sql | present in reported prefix |
| 20260830170000_marketing_stream_correctness.sql | present in reported prefix |
| 20260830180000_optimization_weekday_schedules.sql | present in reported prefix |
| 20260831100000_unified_reporting_dual_run.sql | present in reported prefix |
| 20260901000000_contextual_negative_review_exports.sql | present in reported prefix |
| 20260901010000_authenticated_relation_privilege_hardening.sql | present in reported prefix |
| 20260901020000_sp_write_persistence_ledger.sql | pending in reported snapshot |
| 20260901030000_sp_write_outbox_delivery.sql | pending in reported snapshot |
| 20260901040000_fenced_sync_claims.sql | pending in reported snapshot |
| 20260901050000_recommendation_preview_scopes.sql | pending in reported snapshot |
| 20260901060000_recommendation_claim_custody.sql | pending in reported snapshot |

## Appendix C. Route handlers

Command: `rg --files apps/web/app -g route.ts | sort | sed 's#^apps/web/app#- `#; s#/route.ts$#`#'`

- `/api/amazon/oauth/callback`
- `/api/amazon/oauth/start`
- `/api/bid-history`
- `/api/campaigns/build`
- `/api/cron/sync`
- `/api/dayparting/export`
- `/api/experiments`
- `/api/experiments/[experimentId]`
- `/api/experiments/scope-options`
- `/api/feedback`
- `/api/feedback/[itemId]`
- `/api/feedback/[itemId]/vote`
- `/api/feedback/similar`
- `/api/goto`
- `/api/grid/rows`
- `/api/healthz`
- `/api/mcp-keys`
- `/api/mcp-keys/[keyId]/revoke`
- `/api/ngrams/negatives`
- `/api/optimizer/groups`
- `/api/optimizer/groups/run`
- `/api/optimizer/runs`
- `/api/optimizer/runs/[batchId]`
- `/api/query-intelligence/negatives/decide`
- `/api/query-intelligence/negatives/export`
- `/api/query-intelligence/negatives/export/[exportId]`
- `/api/recommendations/decide`
- `/api/recommendations/export`
- `/api/recommendations/export/[batchId]`
- `/api/tags`
- `/api/tags/[tagId]`
- `/api/tags/[tagId]/assign`
- `/api/time-machine/reversion`
- `/auth/callback`
- `/auth/continue`
- `/auth/recovery/callback`
- `/auth/signout`
- `/go/[token]`

## Appendix D. Reproduction commands

- Pages: `rg --files apps/web/app -g page.tsx | sort`
- Job types: `sed -n '/JobType = z.enum/,/\]/p' packages/shared/src/jobs.ts`
- MCP tools, including multiline calls: `rg -U -o "registerTool\(\s*'[a-z_]+'" apps/mcp/src/server.ts`
- Table counts: `rg -c 'pgTable\(|\.table\(' packages/db/src/schema -g '*.ts'`
- Selected env-name sources: `apps/web/env.TEMPLATE`, `apps/worker/src/config.ts`,
  `apps/mcp/src/config.ts`. These do not cover every imported runtime module or feature flag;
  the preceding env-name lists are not a complete deployment manifest.
