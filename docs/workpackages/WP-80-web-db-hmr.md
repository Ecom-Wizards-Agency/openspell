# WP-80 — HMR-stable web database pool

## Problem

The authenticated Playwright suite compiles many Next.js routes under the
development server. Hot module replacement can invalidate `src/data/db.ts`
without closing the module-local postgres.js pool. A prior hosted `main` run
eventually reached PostgreSQL's client limit and failed an otherwise healthy
Optimizer route.

## Outcome

Development and test runtimes keep the pool state on `globalThis`, so module
invalidation reuses one bounded pool. Production retains the existing
module-owned singleton. The reset seam clears and closes the shared state, and
a module-reload test proves one handle is created and closed exactly once.

## Boundary

This changes only web-process connection lifecycle. It does not change query
authorization, RLS, pool size, production credentials, schemas, migrations,
Amazon APIs, or the read-only product gate.

## Acceptance

- The module-reload test proves one handle survives repeated invalidation.
- Web typecheck, lint, unit tests, build and both serial Playwright suites pass.
- The exact `main` revision passes hosted CI after merge.
