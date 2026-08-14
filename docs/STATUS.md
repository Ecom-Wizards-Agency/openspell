# wizard-ads — program status board

Manager: Fable. Update this file when a WP changes state.
States: `todo` · `in-progress` · `review` · `merged` · `gated`

| WP | Package | Owner | State | Notes |
|---|---|---|---|---|
| 00 | Scaffold + contracts | Opus | merged | merged 2026-08-13; contracts frozen (incl. Next 16, TS 6, ApplyRow wire serializer) |
| 01 | DB schema + RLS | Opus | merged | merged 2026-08-13 (44 tables, RLS on all tenant tables, partition automation, queue, Vault RPCs). Hosted-Supabase verification DONE 2026-08-14: all 13 migrations applied to the hosted project, counts match local, cron jobs live, security advisors clean after RPC grant hardening (migration 0013) |
| 02 | ads-api client | Opus | in-progress | Codex run failed on env (worktree lifecycle + sandbox); relaunched fresh on Opus 2026-08-14 |
| 03 | Worker + queue | Codex+Opus | in-progress | Codex implemented (bundle salvaged, commit ae5d553) but DB tests never ran in its sandbox; Opus completing on the same branch: run tests, schedule-variant migration, crosscheck ingest wiring |
| 04 | Web auth + OAuth | Opus | in-progress | Codex stopped at real gaps (target_total_acos missing, lint conflict) — both fixed on main (migration 0016 + OAuth-route lint carve-out); relaunched fresh on Opus |
| 05 | core doctrine port | Opus | merged | merged 2026-08-13; 122 parity cases byte-equal to Python, bidding worked-examples green. Spawned WP-00.1 contract extension (merged 2026-08-13, 154/154 live-doc leaf coverage) |
| 06 | Grid + dashboard | Opus | in-progress | Codex session never started; relaunched fresh on Opus 2026-08-14 |
| 07 | Recs UI + export bridge | Codex | todo | GATE OPEN (WP-05 merged) — after WP-06 grid shell |
| 08 | Tags + goto links | Codex+Opus | in-progress | Codex implemented (bundle salvaged, f0cf4ec) but DB/RLS tests skipped in its sandbox; Opus completing: run tests + Playwright |
| 09 | MCP server | Opus | merged | merged 2026-08-14: 10 read tools, scoped/hashed API keys (per-key profile allowlist — the AdLabs gap), full audit log, write stubs gated; 48 tests. mcp.api_keys migration applied hosted, advisors clean. Live Claude-client session vs staging = operator step |
| 10 | Crosscheck harness | Opus | merged | merged 2026-08-14: CLI, ingest handler (docs/handoffs-to-wp03.md), standalone /crosscheck route, export contract, exit-report generator; 59 tests green. Live-pilot verdict PENDING until real facts. KNOWN ISSUE found: repo-wide `next build` Turbopack blocker (.js specifiers) — manager fixes once, post-wave, before v0 close |
| 11 | AdLabs recon | Opus + Victor | review | MCP half done (13 specs, exact contracts). UI pass blocked twice: extension installed/enabled/permissioned but NOT PAIRED to the claude.ai account — operator pairing check needed, then session 3 (automations first). See tools/recon/BLOCKED.md |
| 12 | Staged-apply writes | Opus | gated | opens at v1 exit criterion |
| 14a | Campaign generation engine | Opus | merged | merged 2026-08-14: 101 parity tests byte-equal to Python, 542 property tests, XLSX passes the reference toolkit's own --validate 11/11; BMM dropped with live diagnostic. UI surface lands with WP-07 |
| 14b | Campaign creation via API | Opus | gated | opens after OAuth + entity sync live; paused-by-default, apply-batch audited |
| 13 | Headless analyst | Opus | gated | opens when WP-09 stable |

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
- [ ] Add wizard-ads redirect URI to the LWA app Allowed Return URLs (before WP-04 live test).
- [ ] Place `_local/ads-api.config.json` for the WP-02 live smoke (copy shape from template).
- [ ] Approve Supabase Pro (~$25/mo) at v0 close; Fly.io worker (~$5/mo) at WP-03 deploy.
