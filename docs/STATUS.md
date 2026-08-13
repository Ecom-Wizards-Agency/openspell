# wizard-ads — program status board

Manager: Fable. Update this file when a WP changes state.
States: `todo` · `in-progress` · `review` · `merged` · `gated`

| WP | Package | Owner | State | Notes |
|---|---|---|---|---|
| 00 | Scaffold + contracts | Opus | merged | merged 2026-08-13; contracts frozen (incl. Next 16, TS 6, ApplyRow wire serializer) |
| 01 | DB schema + RLS | Opus | in-progress | launched 2026-08-13 after WP-00 merge |
| 02 | ads-api client | Codex | todo | GATE OPEN (WP-00 merged) — run HANDOFFS.md block in Codex |
| 03 | Worker + queue | Codex | todo | GATE OPEN (WP-00 merged) — run HANDOFFS.md block in Codex |
| 04 | Web auth + OAuth | Codex | todo | GATE OPEN (WP-00 merged) — run HANDOFFS.md block; LWA redirect URI still needed before live test |
| 05 | core doctrine port | Opus | merged | merged 2026-08-13; 122 parity cases byte-equal to Python, bidding worked-examples green. Spawned WP-00.1 contract extension |
| 06 | Grid + dashboard | Codex | todo | shell after WP-00; columns wait for recon |
| 07 | Recs UI + export bridge | Codex | todo | GATE OPEN (WP-05 merged) — after WP-06 grid shell |
| 08 | Tags + goto links | Codex | todo | after WP-00/01 |
| 09 | MCP server | Opus | todo | v0 close |
| 10 | Crosscheck harness | Opus | todo | v0 close (needs facts) |
| 11 | AdLabs recon | Opus + Victor | review | MCP half done (13 specs, exact contracts). UI pass blocked twice: extension installed/enabled/permissioned but NOT PAIRED to the claude.ai account — operator pairing check needed, then session 3 (automations first). See tools/recon/BLOCKED.md |
| 12 | Staged-apply writes | Opus | gated | opens at v1 exit criterion |
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
