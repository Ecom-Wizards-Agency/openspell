# WP-175 — E2E isolation and exact date preset identity

## Outcome

Keep the browser acceptance gate reliable and preserve the operator's explicit
date-preset choice when two presets resolve to the same dates.

## Scope

- Run the account-context navigation specification in a fresh authenticated
  Next process so accumulated route graphs do not exhaust the bounded CI heap.
- Preserve the optimizer `preset` query parameter through its operator context.
- Keep all existing route, tenant-scope, and date-range assertions intact.

## Acceptance

- The optimizer labels the exact selected preset, including when its dates
  equal another preset at a calendar boundary.
- The account-context browser specification runs in its own named suite.
- Typecheck, lint, tests, hygiene, and the complete browser suite pass.

## Boundaries


- No database, worker, Amazon API, deployment, or production-data change.
- No weaker assertion, retry, or increased heap limit is used to hide a failure.
