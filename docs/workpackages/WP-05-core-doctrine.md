# WP-05 — Doctrine engine port + White Box bidding (`packages/core`, `packages/strategy`, `fixtures/`)

**Owner:** Claude Opus · **Phase:** v0→v1 · **Depends on:** WP-00 contracts only (fully parallel-safe) · **Blocks:** WP-07, recommendations.run

## Goal

Port the battle-tested Python analysis/recommendation doctrine to pure TypeScript, byte-exact
against the Python selftests, and implement the AdLabs White Box bidding engine. Pure
functions, ZERO I/O.

## Read first (these ARE the spec)

- `~/os/amazon-agent/tools/amazon-ads-monitor/analyze.py` (deltas/trends),
  `flags.py` (severity + goal-lens flags incl. the suppressed-flags contract),
  `pacing.py` (MTD run-rate vs budget, fixed cut order waste→discovery→profit→rank),
  `recommendations.py` (PUSH / PAUSE-OPTIMIZE / TEST engine + threshold table),
  `crosscheck.py` (verdict model: verified/mismatch/no_data, ±7%, same-day caveat),
  `selftest.py` (every scenario = a golden fixture),
  `datasource.py` `classify_campaign_category()` (Rank/Discovery/Profit/Shield from names).
- `~/os/amazon-agent/AdLabs Help/articles/000-formula-summary.md` through
  `004-bid-optimization-guide.md` — the White Box formulas.
- `~/os/amazon-agent/_local/ads-strategy/strategy.json` — SHAPE only for `packages/strategy`
  defaults/merge; values stay out of the repo (per-tenant DB config).

## Spec

1. **Ports** (`packages/core/src`): `analyze.ts`, `flags.ts`, `pacing.ts`,
   `recommendations.ts`, `crosscheck.ts`, `classify.ts`, `ngram.ts` (uni/bi/tri-gram
   aggregation over search terms with spend/sales/CVR per gram + negative candidates).
   Same input/output semantics as Python; types from shared.
2. **White Box bidding engine** (`src/bidding/`) — new code from the public formulas:
   - Bid = RPC × Target ACOS; four reasons: High ACOS (RPC formula), High Spend no sales
     (Target CPA = Target ACOS × AOV; CVR benchmarks), Low ACOS (raise to ceiling),
     Low Visibility (clicks below campaign avg clicks-to-conversion → raise).
   - Data Confidence Hierarchy: AOV/CVR fallback keyword→ad group→campaign→profile; record
     which level was used in `inputs.cvrSourceLevel`.
   - Ceilings: manual, max-affordable (RPC × target ACOS), data-based per level, budget
     constraint (100% of budget; **50% for SD**). Change caps as CLAMPS, never steps:
     −25%/−50% down, +33% placement up.
   - Placement Adjustment = (Target ACOS / Current ACOS) − 1, computed separately, ≥30d
     windows only.
   - Doctrine overlays: Rank/SKW targets never cut on ACOS alone (suppression), goal lenses
     honored, caps-are-ceilings.
   - Every proposal carries full `inputs` provenance (Recommendation type from shared).
3. **`packages/strategy`:** TenantStrategy defaults + merge order (neutral defaults ← goal
   lens ← tenant/profile config) + loader interface (DB loading itself lives in db/worker).
   Ship `strategy.TEMPLATE.json` only.
4. **Parity harness** (`fixtures/`): Python scripts in `fixtures/generate/` that import the
   real amazon-agent modules, run every selftest scenario (SYNTHETIC data only), dump
   `{input, expected}` JSON goldens into `fixtures/golden/`. Vitest replays every golden
   against your TS ports, deep-equal to 6dp. Regenerating goldens is operator-run (Python env
   lives in amazon-agent); committed goldens make CI self-contained.
5. Bidding engine tests: reproduce every worked example in the AdLabs articles (e.g. $20 AOV /
   10-clicks-per-order cases) + property tests (caps always clamp, ceilings never exceeded,
   SD 50% budget cap).

## Acceptance checks

- Parity suite green: TS byte-equals Python goldens for EVERY selftest scenario, including
  goal-lens divergence and suppressed-flag cases.
- Worked-example bidding tests pass; property tests pass.
- `packages/core` has zero imports from db/ads-api/apps (grep in CI).
- Branch `wp-05-core`; report per acceptance check + a table of any Python behaviors you
  had to interpret (ambiguities), for manager review.
