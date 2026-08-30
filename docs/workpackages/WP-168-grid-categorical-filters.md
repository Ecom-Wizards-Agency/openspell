# WP-168 — Categorical Grid filters

**Status:** in progress · **Owner:** Codex · **Branch:** `wp-168-grid-categorical-filters`

## Outcome

Replace the Grid's one-value imitation of `IN` / `NOT_IN` with a real searchable
checkbox picker. Enumerated fields expose exact multi-select filtering; measurements
remain numeric; free-form terms and identifiers remain textual. The operator can select
all current search results, clear the draft, see the selected count, save the view, and
restore every selected value.

## Boundaries

- Options come only from the complete, already-authorized Grid payload. There is no new
  endpoint, authorization path, database query, migration, or persistence table.
- Active filters never remove valid choices from the picker.
- Case variants deduplicate under the same semantics used by `IN` / `NOT_IN`.
- The picker renders a bounded number of checkboxes; Select all still operates over every
  matching option.
- Existing saved-view version and filter contracts remain unchanged.
- No Amazon API is called and no Amazon state can change.

## Verification

- Column metadata and operator matrix tests.
- Pure option derivation/search/select-all/toggle tests.
- Toolbar interaction, exact multi-value filter, hidden-option and saved-view tests.
- Synthetic 3,597-row p95 target below 150 ms, plus 50,000-row and high-cardinality
  regression fixtures.
- Playwright selection, exact count, reload restoration, and numeric/text operator checks.
- Full typecheck, lint, tests, hygiene, production build, and hosted CI before merge.
