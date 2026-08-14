# WP-26 — Bid-corridor engine slice (pure core additions)

**Owner:** Codex (high effort) · **Phase:** v2 · **Depends on:** WP-05 (merged)

Pure-logic additions to `packages/core/src/bidding` — golden-tested, no DB, no browser, no new
deps (vitest already present). This is the engine half of the bid-corridor feature; the sync +
chart half is a separate Opus package.

## Read first

- `tools/recon/04-optimizer.md` §"Bid corridor" and §8 "Engine coverage" — the spec and the three
  named gaps.
- `packages/core/src/bidding/{ceilings.ts,placement.ts,types.ts,bid.ts}` and their tests; the
  parity/golden pattern in `packages/core/src/*.test.ts` + `fixtures/`.

## Scope (three gaps from recon §8, all pure)

1. **Suggested-bid ceiling candidate**: add a `suggested_bid` member to `CeilingName` (types.ts)
   and a candidate in `ceilingCandidates`/`applyCeilings` driven by an Amazon suggested-bid input
   (optional field on the engine input; when absent, no candidate). This also fixes the existing
   inconsistency: `apps/mcp` test + `packages/shared/src/recommendations.ts` reference a
   `suggested_bid` ceiling the engine can't currently produce — make the engine able to, and align
   the doc comment.
2. **Symmetric floor**: today the floor is a bare `settings.minBid`. Add `floorCandidates` /
   `applyFloors` / `FloorName` / `floorApplied` mirroring the ceiling structure (manual floor,
   data-based floor, suggested-bid-low floor as candidates; take the max; report which bound).
   Wire into `bid.ts` so a proposal reports both `ceilingApplied` and `floorApplied`.
3. **Max-potential-CPC composition**: `placement.ts` computes a modifier adjustment but never
   composes the plottable max-potential-CPC (base bid × combined placement/other modifiers).
   Add a pure function producing it from a bid + modifier set, for the corridor chart to consume.

## Constraints

- `packages/core` stays pure (zero I/O) — the purity test must still pass. No new deps.
- Do not change existing golden outputs unless a change is intended and the golden regenerated
  with justification; prefer additive (new optional inputs default to today's behavior, so
  existing WP-05 parity goldens stay green untouched).
- Add worked-example unit tests for each new piece (suggested-bid ceiling binds correctly; floor
  binds correctly; max-CPC matches a hand-computed example). Property tests: floor ≤ proposal ≤
  ceiling always.

## Acceptance

- `pnpm --filter @wizard-ads/core test` green incl. the untouched WP-05 parity suite; new unit +
  property tests green.
- `apps/mcp` `suggested_bid` inconsistency resolved (the engine can now produce it; update the
  shared doc comment; do not break mcp tests — coordinate the assertion if needed, but prefer
  making the engine honest so the original assertion becomes true).
- `pnpm check` green. Branch `wp-26-bidding-corridor`.
