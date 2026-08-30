# WP-155 — Authenticated CI process isolation

## Problem

The authenticated Playwright process compiled both the full operator route
graph and the settings-heavy role matrix. On the bounded hosted runner, the
role assertions passed until the retained Next development graphs reached the
heap limit; the final Sync Status navigation then failed because the server had
already exited. Retrying or increasing the heap would conceal that lifecycle.

## Change

- Keep OAuth, guards, members, dashboard, Grid, and account-context coverage in
  the existing authenticated process.
- Run the unchanged settings role matrix through the same guarded test session
  and isolated database setup in a fresh process.
- Preserve one worker, zero retries, existing timeouts, and every assertion.
- Keep reports separate so a failure identifies the owning process.

## Acceptance evidence

- E2E argument tests prove the five-suite default order and exact selector.
- The primary authenticated config does not select `roles.spec.ts`.
- The role config selects only `roles.spec.ts` and inherits the guarded auth
  lifecycle.
- Hosted Playwright completes every suite without a heap failure.
- Typecheck, lint, unit tests, hygiene, and migration verification remain green.
