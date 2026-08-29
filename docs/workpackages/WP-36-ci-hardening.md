# WP-36 — CI hardening (Postgres + e2e in CI)

**Status:** open · **Owner:** Codex (gpt-5.6-sol) · **Branch:** `wp-36-ci-hardening`

## Why

`.github/workflows/ci.yml` runs typecheck → lint → `pnpm test` → hygiene with **no
Postgres service and no Playwright step**. Every DB/RLS suite self-skips in CI and zero
e2e specs run. Every other work package in this wave depends on CI actually proving what
it claims. Land this early.

## Scope

1. **Postgres service** on the test job: `services: postgres` (pin the major to what
   `supabase/config.toml` uses), health-check, export `DATABASE_URL` to the test step, and
   apply migrations before tests. Find how the DB test harness applies migrations
   (`packages/db/src/testing/harness.ts`, `packages/db/src/migrations.test.ts`) and reuse
   that entrypoint. Verify the suites' skip condition (grep how tests detect a DB) so the
   env var actually un-skips them. Note STATUS.md documents two tests that flake under
   parallel DB load (auth admin-toggle e2e; worker schedule integration) — if the DB
   suites need serialization, configure it rather than skipping.
2. **Playwright e2e job**: separate job — Postgres service + migrations +
   `pnpm exec playwright install --with-deps chromium` + build `apps/web` +
   `pnpm run test:e2e` (harness: `apps/web/e2e/run.ts`, `global-setup.ts`). Run serially
   (documented flake). Upload the Playwright report as an artifact on failure.
3. **Guards list**: `apps/web/e2e/guards.spec.ts` `GUARDED` — add `/optimizer`,
   `/optimizer/groups`, `/experiments`, `/connect-claude`. (Do NOT add
   `/settings/members` — that route lands in WP-39; leave a comment placeholder.)
4. **Authenticated artifact smoke**: the original standalone
   `apps/web/e2e/smoke.spec.ts` was consolidated into the authenticated half of
   `apps/web/e2e/guards.spec.ts` in WP-102. The guarded-route loop now asserts the
   primary data-backed pages render their expected headings while it already visits
   them. This preserves the artifact check without compiling and rendering the same
   large route set a third time in one `next dev` process, which exhausted the CI
   runner heap as the product surface grew.

## Constraints

- Program rules in /AGENTS.md bind. No production code changes beyond test files and CI
  config; if a suite fails under the newly-running CI because of a real product bug,
  REPORT it in your final message, do not fix it here (unless it is a test-only defect).
- Roadmap/feedback items: never set `shipped`; keep `in_progress` pending Victor.
- Branch `wp-36-ci-hardening`; commits `ci(wp-36): ...`; no push, no merge.
- Verify locally as far as possible: `pnpm typecheck && pnpm lint && pnpm test` (with a
  local Postgres if available: the repo's supabase local stack or a docker PG). e2e:
  ensure the suite passes locally before claiming the job config works; if e2e cannot run
  in this environment, say so explicitly in the final message with the exact blocker.
- Final message: what CI now covers vs before, suites un-skipped (counts), any real
  product failures the new coverage exposed (list, don't fix).
