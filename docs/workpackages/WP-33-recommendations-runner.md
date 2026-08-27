# WP-33 — Recommendations runner

**Status:** open · **Owner:** Codex (gpt-5.6-sol) · **Branch:** `wp-33-recommendations-runner`

## Why

The doctrine engine (`packages/core/src/recommendations.ts::buildRecommendations`,
`packages/core/src/bidding/bid.ts::proposeBid`) is parity-tested and called from nowhere in
production. `apps/worker/src/worker.ts:205` handles `recommendations.run` with
`return { stub: true, ... }`. Live `/optimizer`, `/optimizer/groups`, `/recommendations`
render "No optimizer run yet" on every profile. This WP makes the runner real. It is the
single highest-leverage change in the wave.

## Scope

1. **New module `apps/worker/src/recommendations-run.ts`** mirroring the shape of
   `apps/worker/src/bid-series.ts` (store interface + Postgres store + orchestrator, so it
   tests against fakes).
   - Window: `lookbackDays` from the payload (default 7), last complete window in the
     profile's timezone (`ad_profiles.timezone`). Store window bounds on the run.
   - Inputs assembly, all reads scoped `(orgId, profileId)`:
     - Entities → engine `RawEntity[]`: aggregates of `fact_sp_target_daily` joined to the
       entity mirrors (campaigns / ad groups / keywords / targets) for names, states, match
       types, budgets; campaign-level rows from campaign facts. Campaign category comes from
       the engine's own `classifyCampaignCategory` on names.
     - Strategy: resolve via `packages/strategy` (`resolveStrategy`, `targetAcosFor`,
       `changeCapsFor`, ...). **Snapshot the resolved doctrine into
       `recommendation_runs.strategy_snapshot`** (column exists; `getRecommendationRun`
       reads it).
     - Bid corridor: latest suggested-bid bands per target from `bid_series_daily`
       (`packages/db/src/queries/bid-series.ts`) feeding `proposeBid` corridor clamping.
       Absent series ⇒ propose without corridor and record that in `inputs`.
     - Pacing: month-to-date `fact_profile_daily` + `ad_profiles.monthly_budget` through
       `packages/core/src/pacing.ts`.
     - Rank: pass null — the engine already notes absence. Do not fabricate.
   - Output mapping — **manager decision 2026-08-27 (resolves the reported contract
     gap)**: persist ONLY `proposeBid` results as `recommendations` rows (they carry real
     `EntityRef`s, current/proposed bid values, and White Box reasons mapping cleanly into
     the DB reason enum). The qualitative engine output (push/pauseOptimize/graduate/
     tests/notes prose) is stored on the RUN, not as rows — in the run's audit_log payload
     (and/or a details field the run insert already supports), so the UI can render it as
     run narrative without fabricating entity references. Do NOT fabricate entity IDs and
     do NOT extend `packages/shared`. `inputs` provenance NOT NULL per
     `RecommendationInputs`. Follow the write-path patterns of
     `packages/db/src/queries/recommendations.ts::createNegativeProposals` (run insert +
     rows + audit_log; `::text::jsonb` serialization rule). Count-assert writes.
2. **Replace the stub** at `apps/worker/src/worker.ts:205`: inject the runner as a
   `SyncWorker` constructor dependency (same pattern as `crosscheckIngest`), so BOTH the
   Vercel cron drain (`apps/web/app/api/cron/sync/route.ts` imports `SyncWorker`) and
   `apps/worker/src/main.ts` get it. Handler lifecycle: mark run `running` at start;
   `succeeded` + `finished_at` + proposal count at end; `failed` with the error recorded on
   throw. Empty facts ⇒ **succeeded run with 0 proposals** ("ran, nothing to propose" must
   be distinguishable from "no run" — the UI copy depends on it).
3. **Scheduling + on-demand**:
   - Weekly per-sync-enabled-profile schedule: extend `apps/worker/src/schedules.ts` and
     enqueue from the provisioner TypeScript side, minting the `recommendation_runs` row
     first to get `runId` (payload `RecommendationsRunJob` already requires it —
     `packages/shared/src/jobs.ts:85`). Avoid touching `enqueue_due_schedules()` SQL; no
     migration expected in this WP. Time it after the report-fetch schedules.
   - **"Run now" button on `/optimizer`** (`apps/web/app/optimizer/page.tsx` + a small
     server action or route handler, capability-gated `editTargets` or stricter): inserts
     the run row + enqueues. This is what makes the demo instant.
4. **Posture: preview-only.** The runner writes proposals with status `proposed`. It never
   touches Amazon; accept → export → staged-apply gating stays untouched.

## Tests

- Unit `apps/worker/src/recommendations-run.test.ts` vs a fake store: inputs assembly from
  fixture facts; enum mapping; failed-run status; empty-facts ⇒ succeeded w/ 0 proposals.
- Integration: extend `apps/worker/src/worker.integration.test.ts` — enqueue against seeded
  facts, assert run + proposal rows. (DB suites skip without a local Postgres; run them if
  the harness DB is available, otherwise ensure they compile and the unit suite passes.)
- Do NOT re-prove the engine math — `packages/core` parity tests own that.

## Constraints

- Program rules in /AGENTS.md bind. `packages/shared` and `packages/core` are NOT to be
  edited in this WP. If a contract shape is missing, stop and report in your final message.
- Roadmap/feedback items: do NOT set anything to `shipped` — anything you'd update stays
  `in_progress` pending Victor's approval.
- Work only on branch `wp-33-recommendations-runner`. Commit in logical chunks,
  `feat(wp-33): ...` style. Do not push. Do not merge.
- Verify before finishing: `pnpm typecheck && pnpm lint && pnpm test` (scoped filters fine
  for iteration, full pass at the end). Fix what you break.
- Final message: what you built, decisions taken (esp. the reason-enum mapping and any
  contract gaps found), test results, and anything left open.
