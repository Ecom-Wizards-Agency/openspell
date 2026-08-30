# WP-154 — CI route isolation

## Problem

The public-runner browser job passes the production, Grid-performance, and
first 33 authenticated assertions, then the single authenticated Next
development process reaches its four-gigabyte heap while compiling the final
strategy-to-dashboard route check. Rerunning the failed job reproduces the same
development-server failure after the same successful product tests.

## Change

Keep the real-session end-to-end boundary and its production refusal guard.
Move the three cross-route acceptance assertions into a fourth serial suite
with its own migrated database and fresh Next development process. The normal
auth suite explicitly ignores that file; the route-acceptance configuration
matches only that file. The standard runner still executes every suite and
returns the worst exit code.

This changes process lifetime only. It does not change a product assertion,
retry a failed test, increase the heap, weaken authentication, or skip a route.

## Acceptance

- Argument parsing selects all four suites and rejects unknown names.
- Listing the auth and route-acceptance configurations proves the spec belongs
  to exactly one suite.
- The isolated route-acceptance suite passes against a disposable migrated
  PostgreSQL database.
- The complete runner passes under the same bounded heap used by CI.
- Typecheck, lint, unit tests, hygiene, and build remain green.
