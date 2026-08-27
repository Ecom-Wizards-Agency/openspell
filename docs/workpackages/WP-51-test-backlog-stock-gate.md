# WP-51 — Test-backlog recommender + stock gate

## Goal

Two ports from `~/os/amazon-agent/tools/amazon-ads-monitor/recommendations.py`
(771 lines — read it first):

1. **Test backlog** (`DEFAULT_TEST_BACKLOG` ~line 542, `select_tests` ~line
   613): a vetted backlog of PPC experiments filtered by requirement tags
   (brand tags + account signals). Returns `[]` rather than filler when
   nothing qualifies — port that behaviour exactly; an empty proposal list is
   a result, not a bug.
2. **Stock gate**: never bid-optimize an out-of-stock ASIN. Becomes a
   precondition in the recommendations engine.

## Where things live

- Engine: `packages/core/src/` — the recommendations engine lives here
  (see `recommendations/` and how `analyze`/`evaluate`/`classify` are
  structured: pure functions, exhaustive unit tests, no I/O).
- Port `DEFAULT_TEST_BACKLOG` + `select_tests` to
  `packages/core/src/experiments/backlog.ts` with the requirement-tag gating
  intact. Add golden-parity tests against the Python (fixtures pattern:
  see existing parity tests in packages/core; `python3` is available).
- Doctrine constraints to encode as engine preconditions (these come from the
  same reference file and the agency doctrine — they are non-negotiable):
  - never cut a Rank/SKW target on ACOS alone;
  - never cut a keyword whose organic rank is improving;
  - if rank data is absent, the recommendation must carry an explicit note
    saying it was made without rank visibility.
- Stock signal: product economics/inventory tables landed with WP-44
  (`packages/db/src/queries/` — look for economics; DataDive inventory
  distribution may also carry stock state). If no reliable stock source is
  synced yet for a profile, the gate must fail OPEN with a stated note
  ("stock unknown"), never silently block or silently pass as in-stock —
  the note is the point.
- UI: `/experiments` gains a "Proposed tests" section fed by `select_tests`
  over the profile's signals. Proposals only — creating an experiment stays
  the existing manual flow.

## Verify (merge gate)

- `pnpm typecheck && pnpm lint`
- `WIZARD_ADS_TEST_DATABASE_URL=postgres://postgres:testpg@127.0.0.1:54329/postgres pnpm -r --workspace-concurrency 1 test`
- Parity fixtures for select_tests green; engine tests for the stock gate
  cover: in-stock, out-of-stock, unknown-stock (note emitted).
