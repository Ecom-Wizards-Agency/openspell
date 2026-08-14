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
| 07 | Recs UI + export bridge | Codex | todo | GATE OPEN (WP-05 merged) — after WP-06 grid shell |
| 08 | Tags + goto links | Codex+Opus | merged | merged 2026-08-14: nested tags, goto links, RLS negatives at DB+HTTP layers, 4 Playwright e2e green. Fixed the repo-wide web workspace-import blocker (webpack extensionAlias) + 2 db binding bugs. EntityTagFilter promotion to shared deferred |
| 09 | MCP server | Opus | merged | merged 2026-08-14: 10 read tools, scoped/hashed API keys (per-key profile allowlist — the AdLabs gap), full audit log, write stubs gated; 48 tests. mcp.api_keys migration applied hosted, advisors clean. Live Claude-client session vs staging = operator step |
| 10 | Crosscheck harness | Opus | merged | merged 2026-08-14: CLI, ingest handler (docs/handoffs-to-wp03.md), standalone /crosscheck route, export contract, exit-report generator; 59 tests green. Live-pilot verdict PENDING until real facts. KNOWN ISSUE found: repo-wide `next build` Turbopack blocker (.js specifiers) — manager fixes once, post-wave, before v0 close |
| 11 | AdLabs recon | Opus + Victor | merged | COMPLETE 2026-08-14: MCP half + session-3 UI verification (automations rule builder captured — alerting EXISTS on a hidden page; white-label stack exists; goto = live re-query with materialised ID filter; roles are Owner+Admin only; their optimizer can run unattended without preview — validates our approval-gated design). 13 screenshots, redaction verified |
| 12 | Staged-apply writes | Opus | gated | opens at v1 exit criterion |
| 14a | Campaign generation engine | Opus | merged | merged 2026-08-14: 101 parity tests byte-equal to Python, 542 property tests, XLSX passes the reference toolkit's own --validate 11/11; BMM dropped with live diagnostic. UI surface lands with WP-07 |
| 14b | Campaign creation via API | Opus | gated | opens after OAuth + entity sync live; paused-by-default, apply-batch audited |
| 13 | Headless analyst | Opus | gated | opens when WP-09 stable |
| 15 | Feedback & roadmap | Opus | in-progress | launched 2026-08-14; scope addition: seeded roadmap items (AMC, SP-API/SUPA, DataDive, Keepa, Creative Hub, off-Amazon, dayparting, writes, harvesting, campaign API, analyst) |
| 17 | AI skills library | Opus | todo | brief ready 2026-08-14 (WP-17): public-safe skill pack against our MCP + /connect-claude key page; amazon-agent skills as spec sources. Launches in v1.x |
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

- [ ] Fix Claude-in-Chrome connection for the recon UI follow-up (see tools/recon/BLOCKED.md):
      extension enabled + Chrome restarted, same claude.ai account as Claude Code, site
      permission for `dashboard.adlabs.app`, then open it logged in.
- [x] Supabase project created 2026-08-13 (free tier, eu-central-1; ref recorded in the
      operator's private project note — infra identifiers stay out of this repo).
- [ ] Add `https://ads.ecomwizards.agency/api/amazon/oauth/callback` to the LWA app Allowed
      Return URLs, and point the `ads` subdomain at the Vercel deployment (before WP-04 live test).
- [ ] Place `_local/ads-api.config.json` for the WP-02 live smoke (copy shape from template).
- [ ] Approve Supabase Pro (~$25/mo) at v0 close; Fly.io worker (~$5/mo) at WP-03 deploy.

## Manager follow-ups (post-wave)

- [ ] CI: add a Postgres service to ci.yml so DB/RLS suites run there (today they skip), and wire test:e2e.
- [ ] Decide Turbopack return path (extensionless imports) vs staying on webpack for apps/web.
- [ ] Close the worker INTEGRATE(WP-02) seam (one function) + operator runs the ads-api live smoke.
- [ ] Promote EntityTagFilter (and SB/SD fact rows when needed) into packages/shared in one batch.
