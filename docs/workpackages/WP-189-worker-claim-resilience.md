# WP-189 — Worker claim-loop resilience

Owner: `apps/worker`

Depends on: current merged worker queue and health contracts.

Architecture: `docs/design/WP-189-ARCHITECTURE.md`.

## Objective

Keep the always-on worker alive when the atomic PostgreSQL claim statement is canceled with direct
SQLSTATE `57014`, without spinning, dropping existing in-flight work, weakening one-shot failure
semantics, or expanding any Amazon write runtime.

## Deliverables

1. A worker-private claim-loop state module with exact failure classification, capped equal-jitter
   backoff, abortable waits, fresh frozen status and deterministic module-level tests.
2. A single-flight `SyncWorker.start()` loop that contains only direct `57014` claim failures.
3. One-shot lifecycle and active-claim tracking so shutdown settles a claim pass and registers any
   returned jobs exactly once before draining handlers.
4. Sanitized claim-loop status and truthful pre-start, sustained-failure, stopping, stopped and
   fatal health degradation.
5. Focused unit tests for classification, timing, reset, fatal preservation, in-flight isolation,
   unchanged allowlists, one-shot behavior and shutdown.
6. A disposable-PostgreSQL post-update trigger proof that statement timeout rolls back the claim
   completely and the same worker can later complete the job exactly once.
7. A blast-radius proof that no shared/database/API/migration/job/config/main/deployment or SP-write
   activation surface changed.
8. Operator documentation for retry and health behavior.

## Required behavior

- `start()` catches only direct `error.code === '57014'` from the claim RPC.
- `drainOnce()` catches nothing and retries nothing.
- A failed claim calls no handler, provider, finish, defer, dead-letter or release method.
- Backoff is awaited, equal-jittered, positive, capped at 30 seconds and interruptible.
- A successful claim RPC resets the failure state even when it returns no rows.
- A no-capacity pass makes no RPC, preserves prior failure state and waits without spinning.
- Existing running tasks continue through claim backoff and retain their original lifecycle.
- Shutdown interrupts idle/backoff waits, awaits the full active claim pass, registers any returned
  jobs once, drains handlers and prevents later claims.
- Shutdown before start, concurrent start and sequential restart cannot resurrect the instance.
- Any unclassified claim failure rejects `start()` unchanged.
- Contained-failure logs and health never include the raw database error, SQL, parameters or
  connection detail; unclassified errors retain the existing fatal propagation.
- Pre-start, stopping, stopped and fatal states degrade health. Three consecutive contained
  failures degrade health; an actual successful claim RPC restores it.
- Repeated retries preserve the worker ID, configured cap and exact job-type allowlist while
  recomputing current available capacity.

## Non-goals

- No `sync_jobs` schema, claim token or queue ownership migration.
- No Sponsored Products outbox claimant or worker coordinator.
- No import of `@wizard-ads/db/sp-write-persistence` or
  `@wizard-ads/ads-api/sp-write-adapter` from an application.
- No new shared job type, enum, payload, schedule, route, config or environment switch.
- No migration, hosted apply, deployment, service restart, provider call or Amazon mutation.
- No containment of `40P01`, `40001`, `55P03`, `08xxx`, code-less transport failures or unknown
  application errors.
- No redesign of generic handler finalization or timed shutdown release.

## Acceptance checks

```bash
pnpm --filter @wizard-ads/worker typecheck
pnpm --filter @wizard-ads/worker test
pnpm lint
pnpm hygiene
git diff --check
```

Run the worker integration suite with `WIZARD_ADS_TEST_DATABASE_URL` against disposable
PostgreSQL. Use a conditional test-only `AFTER UPDATE` trigger blocked on an advisory lock, prove
the claim reached that trigger before timeout, then assert rollback leaves one queued row, zero
attempts and no claimant. Release the lock and assert the same real `start()` loop performs one
later claim and one successful completion. Remove the trigger and helper function in `finally`.

Run repository CI serially using the same package ordering and worker limits as `.github/workflows`
before relying on full-tree results. The exact pushed head must pass both hosted jobs before merge,
and the merge revision must pass exact-main CI.

## Independent review gates

- High: classifier/test completeness, state transitions, logging sanitization and routine worker
  regression review.
- Extra High: queue ownership, retry storm, shutdown/in-flight behavior, health truthfulness,
  PostgreSQL rollback proof and SP-write blast-radius review.

## Completion

WP-189 completes only after implementation merge and exact-main CI. It does not by itself authorize
closing PR #24: a separately numbered token-fenced SP outbox successor must first be accepted as
archival preservation or merged runtime. Handover and status updates remain a separate post-merge
closeout.
