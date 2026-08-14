# WP-18 — AdLabs history backfill (Phases 0+1)

**Owner:** Claude Opus · **Phase:** v1 · **Depends on:** WP-01/03/10 (merged) ·
**Source:** docs/research/adlabs-backfill-feasibility.md (read it first — it is the spec's
evidence base; samples in gitignored _local/backfill-samples/)

## Goal

Land the deep AdLabs-held history (up to ~25 months ads, ~31 months seller totals vs the
API's 60–95 days) in our database — Phase 0 and Phase 1 only. Phase 2 (the ~55k-call daily
walk) is EXPLICITLY GATED on an operator decision (ToS/contract question + the
attribution-window resolution) and is out of scope here.

## Spec

1. **Crosscheck-poisoning fix FIRST** (the research doc's risk 3): additive migration adding
   `source text not null default 'amazon_api'` to `report_requests`; crosscheck's fact reads
   (`tools/crosscheck-cli/src/facts.ts`) exclude backfilled sources; a test proves an
   AdLabs-sourced fact row cannot produce a `verified` verdict. Also implement risk 4's
   structural fix: backfill archives live under `_local/backfill/` with an `adlabsbf_`
   prefix that the crosscheck inbox pattern cannot match (test).
2. **Phase 0 — profile grain, full depth**: loader (`tools/adlabs-backfill/` CLI) ingesting
   the profile-timeline CSV export (per the research doc's mechanics; re-pull live rather
   than relying on the sample file) into `fact_profile_daily` via a `report_requests` ledger
   row with `source='adlabs_backfill'` per profile; rows_loaded vs parsed counted; excludes
   any date already covered by an API-sourced row (API wins); excludes the in-progress day.
3. **Phase 1 — monthly rollups at campaign/target/placement/search-term grain** into
   `fact_monthly_rollup` (it already carries a `source` column): monthly windowed
   `get_entity_data`/`download_data` pulls, filtered `impressions>0 OR spend>0 OR clicks>0`,
   loaded with source tagging and count reconciliation.
4. **Run it for real** against the hosted Supabase project for all profiles with AdLabs
   data (the research doc's call estimate: ~1,800 calls, under half an hour; respect the
   observed politeness — sequential per profile, no hammering). AdLabs MCP is strictly
   read-only throughout.
5. Document in `tools/adlabs-backfill/README.md`: what was loaded, depth per profile
   (relative dates, no client names), the source-tagging rule, and the Phase 2 gate.

## Acceptance checks

- Crosscheck cannot read backfilled rows (test + live spot-check on one profile-day).
- Phase 0: every profile's fact_profile_daily depth equals the research doc's measured
  depth; counts reconciled; API-sourced days untouched.
- Phase 1: rollup months match AdLabs-side sums for 2 sampled months to the cent.
- Hygiene clean; nothing about clients in tracked files; branch `wp-18-backfill`.
