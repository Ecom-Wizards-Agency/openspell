# WP-76 — Grid cold-start path

## Outcome

Reduce the operator grid's cold critical path without pagination or partial
totals. The complete result set remains the unit of filtering, grouping and
export.

## Changes

- Removed the independent crosscheck query from the row-delivery `Promise.all`.
  Its chip now streams into the freshness banner without delaying the grid.
- Added an immediate, non-interactive route loading state. It says that the
  complete result set is loading and never presents partial controls as usable.
- Replaced the per-result correlated harvested-keyword lookup with one
  profile-scoped, deduplicated normalized vocabulary joined to the aggregated
  search-term rows.
- Kept deleted keywords out of harvested status and preserved case-insensitive
  matching without duplicating performance rows.

## Verification

- The disposable PostgreSQL suite represented exactly 3,597 added search-term
  rows, retained every row, and marked every matching term harvested.
- Cold server query plus row mapping completed in 1,895 ms on the reference
  development machine.
- The grid loading state has no button, input or select while `aria-busy` is
  true.
- Web typecheck, lint, hygiene, database tests and diff checks pass.

This package does not change a schema, call Amazon, paginate data, apply a
hosted migration, or invoke an advertising write.

## Remaining evidence gate

The server result now meets the two-second reference budget, but a deployed
browser-level cold-navigation trace is still required to separate network,
React Server Component transfer and hydration costs before the full route can
be claimed under two seconds.
