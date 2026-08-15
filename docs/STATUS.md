# wizard-ads — program status board

Manager: Fable. Update this file when a WP changes state.
States: `todo` · `in-progress` · `review` · `merged` · `gated`

| WP | Package | Owner | State | Notes |
|---|---|---|---|---|
| 00 | Scaffold + contracts | Opus | merged | merged 2026-08-13; contracts frozen (incl. Next 16, TS 6, ApplyRow wire serializer) |
| 01 | DB schema + RLS | Opus | merged | merged 2026-08-13 (44 tables, RLS on all tenant tables, partition automation, queue, Vault RPCs). Hosted-Supabase verification DONE 2026-08-14: all 13 migrations applied to the hosted project, counts match local, cron jobs live, security advisors clean after RPC grant hardening (migration 0013) |
| 02 | ads-api client | Opus | merged | merged 2026-08-14: full client (LWA, profiles, entities, exports, reporting v3, 429/Retry-After budget), 130 fixture tests, purity gate. Live smoke = operator step: fill _local/ads-api.config.json then `pnpm --filter @wizard-ads/ads-api smoke` |
| 03 | Worker + queue | Codex+Opus | merged | merged 2026-08-14. Live tests exposed and fixed 2 product bugs (timestamptz boundary; multi-campaign fact aggregation) + tombstone gating + in-process stale-claim reaper. Schedule-variant migration 0017 (applied hosted). crosscheck.ingest wired. INTEGRATE(WP-02) seam remains (1 function) |
| 04 | Web auth + OAuth | Opus | merged | merged 2026-08-14 via integration branch: login/orgs/roles, LWA OAuth (signed state, Vault custody, region-partial grants), settings + sync-status; 17 e2e green across two unified harnesses. Live OAuth awaits redirect-URI registration |
| 05 | core doctrine port | Opus | merged | merged 2026-08-13; 122 parity cases byte-equal to Python, bidding worked-examples green. Spawned WP-00.1 contract extension (merged 2026-08-13, 154/154 live-doc leaf coverage) |
| 06 | Grid + dashboard | Opus | merged | merged 2026-08-14: virtualized 50k-row grid (bounded DOM, perf-budget tests), dashboard, group-by sum/sum proven vs Postgres, freshness from report_requests, currency-mix guard. Shared saved views need a grid_views migration (follow-up) |
| 07 | Recs UI + export bridge | Opus | merged | merged 2026-08-14: review UI w/ full inputs provenance + strategy dimension (assignment-ready cascade), n-gram explorer, export = apply_batches record rendered as rows JSON (passes batches.py validate live) + bulksheets XLSX; preview-first enforced. Operator spot-check: upload one XLSX through campaign-builder |
| 08 | Tags + goto links | Codex+Opus | merged | merged 2026-08-14: nested tags, goto links, RLS negatives at DB+HTTP layers, 4 Playwright e2e green. Fixed the repo-wide web workspace-import blocker (webpack extensionAlias) + 2 db binding bugs. EntityTagFilter promotion to shared deferred |
| 09 | MCP server | Opus | merged | merged 2026-08-14: 10 read tools, scoped/hashed API keys (per-key profile allowlist — the AdLabs gap), full audit log, write stubs gated; 48 tests. mcp.api_keys migration applied hosted, advisors clean. Live Claude-client session vs staging = operator step |
| 10 | Crosscheck harness | Opus | merged | merged 2026-08-14: CLI, ingest handler (docs/handoffs-to-wp03.md), standalone /crosscheck route, export contract, exit-report generator; 59 tests green. Live-pilot verdict PENDING until real facts. KNOWN ISSUE found: repo-wide `next build` Turbopack blocker (.js specifiers) — manager fixes once, post-wave, before v0 close |
| 11 | AdLabs recon | Opus + Victor | merged | COMPLETE 2026-08-14: MCP half + session-3 UI verification (automations rule builder captured — alerting EXISTS on a hidden page; white-label stack exists; goto = live re-query with materialised ID filter; roles are Owner+Admin only; their optimizer can run unattended without preview — validates our approval-gated design). 13 screenshots, redaction verified |
| 12 | Staged-apply writes | Opus | gated | opens at v1 exit criterion |
| 14a | Campaign generation engine | Opus | merged | merged 2026-08-14: 101 parity tests byte-equal to Python, 542 property tests, XLSX passes the reference toolkit's own --validate 11/11; BMM dropped with live diagnostic. UI surface lands with WP-07 |
| 14b | Campaign creation via API | Opus | gated | opens after OAuth + entity sync live; paused-by-default, apply-batch audited |
| 13 | Headless analyst | Opus | merged | merged 2026-08-14: apps/analyst — MCP read-only, insights writer + markdown digest; audit_log proves zero write calls; 10 tests. Deterministic analyzer (LLM narrator layerable later); Slack via operator helper. Roadmap card SHIPPED |
| 15 | Feedback & roadmap | Opus | merged | merged 2026-08-14: form w/ page context, tracker, voting, roadmap columns + declined-with-note, column-level guard trigger, MCP submit_feedback; 12-item roadmap seeder (idempotent). Migration applied hosted, advisors clean |
| 17 | AI skills library | Opus | todo | brief ready 2026-08-14 (WP-17): public-safe skill pack against our MCP + /connect-claude key page; amazon-agent skills as spec sources. Launches in v1.x |
| 18 | AdLabs history backfill | Opus | merged | merged 2026-08-14: source-tagged loader + crosscheck isolation proven (backfilled rows unreadable by crosscheck, cent-exact 2-month verification). Local load done (4,453 profile-days, 14 profiles, up to ~25mo). HOSTED load pending DATABASE_URL; remaining ~1,790 Phase 1 pulls on demand |
| 19 | Experiments (A/B tracking) | Opus | todo | brief ready 2026-08-14 (WP-19); queued behind WP-07 (shares apps/web); on the in-app roadmap seed |
| 23 | Cron sync + profile UX | Opus | merged | merged+DEPLOYED 2026-08-14: Vercel cron /api/cron/sync (5-min pump, CRON_SECRET-gated, 401 verified live), profile roster sort-by-name/search/bulk-select/editable tz+hour, sticky timezone, active-profile default. Migration applied hosted. Cron live; awaits operator enabling ~15 profiles |
| 25 | Ads API write endpoints | Codex | merged | merged 2026-08-14: SP create/update/archive + placement/off-Amazon + SB v4 stubs; 167 tests. Codex built it but couldn't commit (sandbox git RO) — recovered from working tree/bundle. Unblocks WP-12/14b/off-Amazon/Creative-Hub |
| 26 | Bidding corridor engine slice | Opus | merged | merged 2026-08-14 (Opus redo after Codex git-lock refusal): suggested_bid ceiling + symmetric floor + max-potential-CPC; 214 core tests, parity untouched. Unblocks the corridor sync+chart Opus package |
| 24 | AdLabs-fidelity UI | Opus | merged | merged+DEPLOYED 2026-08-14: /optimizer campaign-level view, dense tables, top-right profile switcher, /connect-claude MCP-key page, AMC/SVC connect stubs, sidebar icons+collapse, chart D/W/M + KPI tiles, Feedback/Roadmap de-duped from Settings. Roadmap card SHIPPED. Opt-Group column deferred (packages/ui owned by WP-06) |
| 27 | ads-api suggested-bid + SB v4 | Codex | merged | merged 2026-08-14: SP keyword+target bid-recommendation reads + SB v4 media/creative endpoints; 182 tests. Codex bundle-recovered. Unblocks corridor charts (WP-28) + Creative Hub |
| 19 | Experiments (A/B tracking) | Opus | merged | merged+DEPLOYED 2026-08-14: /experiments CRUD, chart-window overlay, before/during/after comparison, entity-changes-in-window, MCP list/get, RLS both layers. Migration 0019 applied hosted. Roadmap card SHIPPED |
| 28 | Bid corridor charts | Opus | merged | merged+DEPLOYED 2026-08-14: bid_series_daily table (migration 0020, applied hosted), worker sync pass, corridor band chart on /optimizer, + Connect AI (MCP) rename w/ Claude+Codex snippets. Roadmap card SHIPPED |
| 29 | Live sync SB/SD fixes | Opus | in-progress | first live run 2026-08-14: SP works (profile facts landed), SB v4 list + SB/SD reports 400, entity.sync aborts on SB. Fixing request bodies + per-product isolation |
| 16 | AMC lane | Opus | gated | brief ready 2026-08-14 (docs/workpackages/WP-16-amc.md); opens at first provisioned AMC instance + AWS bucket. Visible on the in-app roadmap via WP-15 seed |

## Milestone gates

- **v0 close:** OAuth live w/ profiles listed · entity sync + spCampaigns facts for 2 pilot
  profiles · minimal grid · goldens generated · recon specs done → decide Supabase Pro.
- **v1 exit (gates WP-12):** 14 consecutive verified crosscheck days on ≥5 pilot profiles ·
  campaign-grain ±7% for ≥95% spending campaigns over a week · optimizer parity spot-check
  explained.

## Operator action items (Victor)

- [ ] Before the GitHub push: rewrite commit authors (early commits carry a machine-derived
      email; repo-local identity fixed 2026-08-13 for new commits).

- [x] Claude-in-Chrome pairing fixed; recon session 3 completed 2026-08-14.
- [x] Supabase project created 2026-08-13 (free tier, eu-central-1; ref recorded in the
      operator's private project note — infra identifiers stay out of this repo).
- [x] LWA Allowed Return URL added 2026-08-14 (ads.ecomwizards.agency callback). DNS →
      Vercel still pending at deploy time.
- [x] Smoke config placed 2026-08-14 (first NA pilot profile); live smoke launched.
- [x] Supabase Pro upgraded 2026-08-14 (org-level; auto-pause risk gone, storage headroom for
      backfill). Fly.io worker (~$5/mo) still pending at WP-03 deploy.

## Live sync status (2026-08-14)

- 18 profiles sync-enabled (operator's ~15 + 3 pilot). First live run: SP reporting WORKS
  (fact_profile_daily populated); SB v4 + SB/SD reports return 400 (WP-29 fixing). Cron
  maxDuration raised 60->300s. CRON_SECRET rotated (value in operator's session only).

## Manager follow-ups (post-wave)

- [ ] CI: add a Postgres service to ci.yml so DB/RLS suites run there (today they skip), and wire test:e2e.
- [ ] Decide Turbopack return path (extensionless imports) vs staying on webpack for apps/web.
- [ ] Close the worker INTEGRATE(WP-02) seam (one function) + operator runs the ads-api live smoke.
- [ ] Promote EntityTagFilter (and SB/SD fact rows when needed) into packages/shared in one batch;
      promote WP-07's exportBatch role constant into roles.ts capabilities.
- [ ] WP-06 dashboard: mark/aggregate backfilled history distinctly (reads fact_profile_daily with no source filter — WP-18 handoff).
- [ ] Flake hardening: auth e2e admin-toggle spec + worker schedule integration test both fail
      under parallel DB load only (each green in isolation). Serialize DB-heavy suites or
      per-suite databases.
