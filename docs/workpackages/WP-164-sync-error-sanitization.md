# WP-164 — Operator-safe operational failures

## Outcome

Prevent raw database, provider, and worker error messages from crossing into
authenticated OpenSpell HTML or OAuth feedback. Operators still receive a
bounded, actionable category for authorization, throttling, connectivity,
reconciliation, and data-load failures.

The underlying error remains in the private operational ledger and worker log.
This package changes presentation boundaries only; it does not rewrite stored
evidence, alter a job, retry work, or call an external provider.

## Trigger

Deployed read-only QA found that a historical failed job contained a database
driver message with the statement and bind-parameter dump. Sync Status rendered
that field verbatim. A stored integration-health error also contained an
internal profile identifier and was rendered verbatim.

## Boundary

`operatorFailureLabel` is intentionally allowlist-based:

- recognized categories return fixed operator guidance;
- no source substring, provider detail, request identifier, SQL fragment, or
  parameter is interpolated;
- unknown errors return one fixed private-log instruction;
- empty errors remain empty.

The boundary is applied to Sync Status jobs and reports, Amazon connection
health, external integration health, and OAuth error feedback.

## Acceptance evidence

- Synthetic tests pass a SQL statement, UUID-shaped bind parameter, opaque
  provider detail, authorization failure, throttle, reconciliation failure, and
  known-safe OAuth state guidance through the boundary.
- Tests assert that the SQL and bind content are absent from the output.
- Web typecheck and tests, repository lint, hygiene, and diff checks pass.
- No database, worker, migration, secret, deployment, or Amazon state changes.
