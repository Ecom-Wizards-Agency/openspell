# WP-169 — N-gram Explorer filters

Status: independently reviewed and locally verified

## Outcome

Give the N-gram Explorer the same composable filter, column, grouping, and CSV
controls as the primary Data Grid. Filters run over the already-authorized,
in-memory aggregate rows; no new endpoint or Amazon call is introduced.

## Acceptance

- Gram text supports contains/equality filters.
- Count and performance columns expose numeric comparisons.
- Filtered counts, rendered rows, and CSV export use one `GridModel`.
- The browser workflow proves an exact gram filter narrows to one row and one
  exported row before any negative proposal is created.
- Existing proposal behavior remains review-only and invokes no Amazon write.
- Typecheck, lint, tests, hygiene, build, and Playwright pass.

## Verification

- `pnpm check`
- focused web and UI suites
- production Next.js build
- the authenticated synthetic N-gram Playwright workflow, including exact-row
  filter/count/export parity before a negative proposal is staged
- explicit source-boundary review: filtering and export operate only on the
  already-authorized in-memory aggregate rows and introduce no Amazon client
  call

Independent review additionally proved and locked the action-scope boundary:
changing a filter, grouping, scope, gram size, or click floor clears any
previously selected gram and search terms. The browser test reads the downloaded
CSV and asserts one provenance line, one header, and exactly one filtered data
row.
