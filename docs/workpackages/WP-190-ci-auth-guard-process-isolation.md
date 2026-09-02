# WP-190 — Authenticated guard process isolation

Owner: `apps/web` test harness.

Architecture: `docs/design/WP-190-ARCHITECTURE.md`.

## Objective

Restore first-attempt heap margin to the serial Playwright gate by running the anonymous and
signed-in 25-route guard sweeps in separate bounded Next development processes without changing,
retrying or skipping any assertion.

## Deliverables

1. One discriminated test-only manifest for the exact 25 guarded routes and every conditional
   signed-in expectation, with exact subset goldens.
2. Separate anonymous and signed-in guard specs with unchanged frame, route, artifact and count
   assertions.
3. Separate Playwright configs, databases, mocks, Next processes and artifact paths for both guard
   partitions.
4. A primary auth config that selects only its four Dashboard/Grid tests.
5. Eleven serial runner suites derived from one exact suite/config/project/spec registry.
6. Exact discovery evidence that all 69 test cases remain, including the unchanged five guard test
   titles and assertions under their intentionally new file/project identities and the one
   intentionally corrected Grid-performance project identity.
7. Crash-safe setup and best-effort teardown for every database create attempt, acquired mock and
   Next process, with actual orchestration fault-cut and readiness-cancellation tests.
8. Focused, full browser, repository and first-attempt hosted CI proof.

## Required behavior

- Both sweeps consume the same immutable 25-route manifest without copying or filtering it; exact
  goldens preserve the seven canonical routes, one complete redirect and seven headings.
- Anonymous routes all land on `/login`; signed-in routes land on the requested or explicitly
  redirected path and retain profile, heading and artifact checks.
- Each guard suite owns a fresh global setup/teardown lifecycle. Partial setup pre-owns an uncertain
  database-create outcome, observes early child failure, cancels readiness polling, and—like normal
  teardown—attempts every acquired-resource cleanup before propagating errors.
- The outer runner remains serial and runs later suites after an earlier failure.
  Thrown pre-Playwright setup failures are logged and recorded without suppressing later suites.
- Every config keeps `workers: 1`, `fullyParallel: false`, `retries: 0`, current timeouts, current
  browser artifacts, `next dev`, the cookie seam and the 4 GB heap cap.
- Direct suite selectors and forwarded Playwright arguments remain supported.
- Suite order and dispatch derive from one registry. Tests reject duplicate or wrong
  suite/config/project/spec ownership, not only missing keys.

## Non-goals

- No product, route, auth-policy, session, fixture-content or application behavior change.
- No heap increase, timeout increase, retry, skip, automatic rerun or pass-with-no-tests mode.
- No Playwright-project split inside one server lifecycle.
- No migration, hosted apply, deployment, service restart, provider call, queue handoff or Amazon
  mutation.
- No WP-191 token-fenced outbox design or runtime.

## Acceptance checks

```bash
pnpm --filter @wizard-ads/web typecheck
pnpm --filter @wizard-ads/web test
pnpm --filter @wizard-ads/web build
pnpm lint
pnpm hygiene
git diff --check
```

Additionally:

- use each named runner selector with forwarded `--list` and prove exact per-suite counts
  `32,1,1,3,2,3,4,5,7,8,3` and 69 total;
- compare normalized pre/post discovery by logical title, acknowledging the intentional five guard
  file/project identity changes and one Grid-performance project-label correction;
- prove the exact unique registry mapping, disjoint spec ownership and parser/dispatch derivation;
- prove exact guarded-route canonical, redirect and heading goldens with no orphan expectation;
- prove both new selectors forward `--grep` without selecting a test owned by the other process;
- inject setup, early-child, readiness and teardown failures through the real orchestration cuts;
  prove no poll survives, and all cleanup runs in reverse order with preserved or aggregated errors;
- run both guard suites alone and consecutively in both orders against disposable PostgreSQL;
- run the complete serial 69-test gate under the unchanged 4 GB limit;
- verify the changed path list contains only the architecture file map;
- require both hosted jobs on exact pushed head and exact merged main to pass on their first
  attempts.

## Independent review gates

- High: file selection, suite inventory, exact count conservation, runner selectors and routine
  regression review.
- Extra High: coverage non-loss, process/database/mock ownership, no hidden retry or timeout
  weakening, failure propagation and first-attempt CI go/no-go.

## Completion

WP-190 completes only after implementation merge and first-attempt exact-main CI. Handover and
status are updated only afterward. It does not deploy a user-visible feature or open any Amazon
write gate.
