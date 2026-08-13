# wizard-ads — program status board

Manager: Fable. Update this file when a WP changes state.
States: `todo` · `in-progress` · `review` · `merged` · `gated`

| WP | Package | Owner | State | Notes |
|---|---|---|---|---|
| 00 | Scaffold + contracts | Opus | in-progress | kicked off 2026-08-13 |
| 01 | DB schema + RLS | Opus | todo | starts after WP-00 contracts |
| 02 | ads-api client | Codex | todo | starts after WP-00 contracts |
| 03 | Worker + queue | Codex | todo | starts after WP-00; mock ads-api until WP-02 |
| 04 | Web auth + OAuth | Codex | todo | needs LWA redirect URI added before live test |
| 05 | core doctrine port | Opus | todo | fully parallel-safe after WP-00 |
| 06 | Grid + dashboard | Codex | todo | shell after WP-00; columns wait for recon |
| 07 | Recs UI + export bridge | Codex | todo | after WP-05 types |
| 08 | Tags + goto links | Codex | todo | after WP-00/01 |
| 09 | MCP server | Opus | todo | v0 close |
| 10 | Crosscheck harness | Opus | todo | v0 close (needs facts) |
| 11 | AdLabs recon | Opus + Victor | todo | schedule login session with Victor |
| 12 | Staged-apply writes | Opus | gated | opens at v1 exit criterion |
| 13 | Headless analyst | Opus | gated | opens when WP-09 stable |

## Milestone gates

- **v0 close:** OAuth live w/ profiles listed · entity sync + spCampaigns facts for 2 pilot
  profiles · minimal grid · goldens generated · recon specs done → decide Supabase Pro.
- **v1 exit (gates WP-12):** 14 consecutive verified crosscheck days on ≥5 pilot profiles ·
  campaign-grain ±7% for ≥95% spending campaigns over a week · optimizer parity spot-check
  explained.

## Operator action items (Victor)

- [ ] Schedule the AdLabs recon session (WP-11) — you log in, Opus walks the UI.
- [ ] Add wizard-ads redirect URI to the LWA app Allowed Return URLs (before WP-04 live test).
- [ ] Place `_local/ads-api.config.json` for the WP-02 live smoke (copy shape from template).
- [ ] Approve Supabase Pro (~$25/mo) at v0 close; Fly.io worker (~$5/mo) at WP-03 deploy.
