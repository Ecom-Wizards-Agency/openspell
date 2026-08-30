# WP-140 — Bounded Time Machine history

## Outcome

Time Machine no longer renders up to 500 history entries and the latest full
reversion preview on the initial request. It renders 50 changes, keeps older and
newest filtered history reachable, and loads a reversion preview only after the
operator selects a batch. Stable `(observed_at, id)` cursors prevent a new sync
from shifting an operator's next history window.

## Acceptance checks

- The first history window contains at most 50 entries.
- Older/newest navigation preserves profile and active filters.
- An explicit batch selection is required before synchronized evidence and
  inverse rows are loaded.
- A production-build browser fixture with more than 50 history rows stays below
  the rendered-response byte ceiling and reaches the older window.
- Query windows remain ordered and non-overlapping when newer changes arrive
  between page requests.
- Malformed and impossible cursor timestamps are rejected before a database
  query and fall back to newest history.
- Typecheck, lint, tests, hygiene, production build, and diff checks pass.

An exhausted cursor provides a direct return to newest history. This package
changes no schema, Amazon API, credential, or tenant-strategy state.
