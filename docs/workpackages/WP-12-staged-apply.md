# WP-12 — Staged-apply write engine (v1.x) — GATED

**Owner:** Claude Opus · **Phase:** v1.x · **GATE: do not start until the v1 exit criterion
passes (14 verified crosscheck days etc. — see docs/PLAN.md). The manager opens this gate
explicitly.**

## Goal (summary now; full brief written at gate-open)

Real writes to Amazon with every safety from the battle-tested operator flow: preview →
approve → apply via Ads API, snapshot/revert, 7-day entity cooldown, caps-are-ceilings
validation, per-batch scoring. Plus harvesting via campaign maps with destination
auto-creation (the AdLabs limitation we beat).

## Spec sources (already fixed)

- `~/os/amazon-agent/tools/amazon-ppc-management/batches.py` — port EVERY safety: batch =
  one opt-group, cooldown conflicts, revert emits old values as update payload, scoring.
  Do not "simplify" any of it: this is client money.
- `~/os/amazon-agent/tools/amazon-campaign-builder/campaign_model.py` — naming + campaign
  type matrix (SKW/Halo/BMM/Phrase/Auto/PAT) for destination auto-creation.
- `apply_batches`/`apply_rows`/`campaign_maps` tables (WP-01, already in schema).
- WP-02 write endpoints (typed stubs to be completed here).

## Acceptance checks (preview)

- Cooldown conflict blocks a staged batch (test).
- Revert restores exact old values on a sandbox campaign (live, operator-supervised).
- Over-cap delta rejected with the caps-are-ceilings message.
- Every MCP/UI write creates an apply_batch (no direct-write path exists).
