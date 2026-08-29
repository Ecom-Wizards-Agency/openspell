# WP-90 — Optimization-group weekday schedule

## Outcome

Replace the ambiguous numeric `Cadence` editor with a `Review schedule` that lets an operator
choose Monday through Sunday in the profile's local timezone. The chosen days determine when a
group becomes due for a new recommendation preview.

## Required behavior

- Persist a non-empty, deduplicated weekday set per optimization group.
- Display the profile timezone beside the weekday control.
- Preserve a safe migration path for existing interval-only groups.
- Evaluate only groups due on a selected local weekday; a manual preview remains available.
- Recompute the next due instant atomically with group configuration and assignments.
- Explain that this review schedule creates previews. A separate, explicitly enabled apply
  cadence is required before OpenSpell may send unattended changes through the guarded worker
  gateway; without it, no scheduled Amazon write is allowed.
- Record schedule context on the recommendation run for later replay and Time Machine evidence.

## Boundaries

- Additive shared contract, database migration/query, worker due-evaluation and group UI work.
- No Amazon write tool or automatic apply in this package.
- No hosted migration without exact authorization of the target and migration set.

## Acceptance

- DST-aware synthetic timezone cases cover weekday boundaries.
- Monday-only, multiple-day, manual-run and disabled-group cases pass.
- Rename/schedule/assignment edits remain atomic.
- Migration/RLS, worker retry/idempotency, Playwright and no-Amazon-write assertions pass for
  this preview-only package.
