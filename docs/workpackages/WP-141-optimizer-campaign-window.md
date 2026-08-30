# WP-141 — Optimizer campaign window

## Outcome

The Campaign Optimizer keeps its complete filtered campaign set available but
renders at most 25 campaign rows at once. Operators can move between clearly
labelled pages, and changing or clearing any filter returns to the first page.

This targets client rendering and table interaction after the measured live page
rendered every synced campaign at once. It does not claim to reduce the optimizer's
server query or serialized React payload; those require a separate data-boundary
package.

## Acceptance checks

- A 56-campaign fixture initially renders exactly 25 campaign rows.
- Next and previous controls expose all matching campaigns without changing filters.
- Search, group, state, and clear-filter actions reset the page window.
- Profile and date-context changes cannot retain a page from the prior account
  or evidence window.
- Visible-range and page-count copy are accurate.
- Typecheck, lint, tests, hygiene, production build, and browser regression checks
  pass.

No database, Amazon API, credential, tenant-strategy, or shared-contract behavior
changes in this package.
