# WP-166 — Dashboard operating-status query

## Outcome

Replace the Dashboard operating-status card's seven serialized database reads
with one bounded aggregate statement. Dedicated Strategy and Optimization Group
pages keep their complete data reads; the Dashboard loads only the counts and
latest staged export it renders.

## Boundaries

- Web query and Dashboard composition only.
- No schema, migration, worker, Amazon API, or deployment configuration change.
- Preserve exact organisation and profile predicates for every source table.
- Preserve the existing rendered states and read-only language.

## Acceptance evidence

- One query invocation returns campaign assignment, group, staged batch,
  observation, and stock-signal summaries.
- Output counts reconcile against synthetic source rows.
- A mismatched organisation/profile returns an empty model.
- The Dashboard no longer loads full optimization and strategy workspaces for
  its compact operating card.
- Typecheck, lint, tests, hygiene, and web build pass.
