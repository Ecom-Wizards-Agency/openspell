# WP-10 — Crosscheck harness vs AdLabs (`tools/crosscheck-cli` + job + UI panel)

**Owner:** Claude Opus · **Phase:** v1 (starts at v0 close, needs facts) · **Depends on:** WP-01/03/05

## Goal

The trust machine: nightly comparison of our synced facts against AdLabs' numbers, the verdict
dashboard, and the v1 exit-report generator. This gates all future write features.

## Read first

- `~/os/amazon-agent/tools/amazon-ads-monitor/crosscheck.py` — verdict model to port
  (verified/mismatch/no_data, tolerance 0.07, headline verdict, same-day-correction caveat).
- `~/os/amazon-agent/docs/ads-runtime-notes.md` — AdLabs export gotchas: `get_entity_data`
  returns ALL team profiles regardless of profile_id (filter post-fetch); `total_*` columns
  read 0 for the in-progress day (exclude the report day).
- `~/os/amazon-agent/skills/amazon-audit/references/source-adlabs.md` — AdLabs MCP mechanics.
- `docs/PLAN.md` — v1 exit criterion (your report generator's checklist).

## Spec

1. **Ingest:** `tools/crosscheck-cli` accepts AdLabs CSV exports (from AdLabs MCP
   `download_data`, pulled on schedule by an operator-side agent — you define the expected
   file naming + columns contract in a doc); parses profile-day and campaign-day grains into
   `crosscheck_results` staging.
2. **Compare** (`packages/core/src/crosscheck.ts` from WP-05): our `fact_profile_daily` +
   campaign aggregates vs AdLabs figures, ±7% tolerance, excluding the provisional latest day;
   verdicts per profile-day and campaign-week; headline verdict per profile.
3. **Job:** `crosscheck.ingest` handler in the worker (shell exists from WP-03) — watches an
   inbox dir/bucket for new CSVs, runs ingest+compare, writes results.
4. **UI panel** (dashboard chip + a crosscheck page): verdict history per profile, drill-down
   to mismatching campaigns/days with both values and delta.
5. **Exit-report generator:** CLI that evaluates the v1 exit criterion — (a) 14 consecutive
   verified profile-grain days, (b) campaign-grain within ±7% for ≥95% of spending campaigns
   over a week, (c) placeholder section for the optimizer parity spot-check — and emits a
   markdown report.

## Acceptance checks

- Deliberately corrupted fixture (one campaign 12% off) → `mismatch` verdict flagged on
  exactly that campaign; clean fixture → `verified`.
- Same-day rows excluded (test: provisional day mismatch does NOT fail the verdict).
- Live run on 1 pilot profile produces a verdict table the manager can eyeball against the
  AdLabs UI.
- Exit-report generator produces correct pass/fail on synthetic histories (both directions).
- Branch `wp-10-crosscheck`; report per acceptance check.
