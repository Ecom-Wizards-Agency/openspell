# WP-89 — Data context and filtered bulk selection

## Outcome

Routine data freshness reads as compact page context rather than a full-width success alert.
Warning and failure states remain visually prominent. Operators can expand sync evidence through
an accessible information affordance.

Optimization-group campaign assignment provides `Select all` and `Deselect all`. Both actions
apply only to campaigns matching the current search filter and preserve selections outside that
filtered view.

## Boundaries

- Presentation and client selection state only.
- No schema, provider, worker, recommendation-math or Amazon API change.
- Saving a group remains an OpenSpell configuration write; no Amazon mutation is introduced.

## Acceptance

- Current freshness uses a neutral surface; warning/error tones remain semantic.
- Expanded details retain the report-ledger evidence and explain why fact dates are insufficient.
- Filtered select/deselect behavior has a stateful test, including preservation outside the filter.
- Light/dark and narrow viewport snapshots are reviewed.
- Typecheck, lint, tests and hygiene pass.
