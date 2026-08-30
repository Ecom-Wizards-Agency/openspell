# WP-142 — Grid data boundary

## Problem

The Grid intentionally filters, groups, totals, and exports the complete selected
dataset in the browser, but `/grid` currently serializes those rows into the initial
React Server Component document. The known 3,597-row fixture makes that document
roughly 2.17 MB before the Grid is usable. The change must remove that serialization
without introducing server pagination, partial totals, cross-tenant reads, or a second
Grid model.

## Usage

The server page renders the authenticated profile, date controls, freshness context,
and an empty `GridWorkspace`. The workspace requests one complete payload for its
profile, entity, and selected period:

```text
GET /api/grid/rows?profile=<profile>&entity=search_terms&from=2026-06-30&to=2026-06-30
  -> { rows, rowCount, truncated }
```

The toolbar and export controls appear only after the counted payload is valid. A
profile, entity, or period change aborts the old request and makes any late response
ineligible to render. A failed request leaves freshness context visible and offers an
explicit retry.

## Shape

- `loadGridRows(handle, level, options)` remains the only row-query module. Its handle
  is narrowed to the SQL-only capability both page and route database handles share.
- `GET /api/grid/rows` authenticates the request, verifies organization membership,
  resolves the profile and currency under the actor's organization, validates real
  ordered ISO dates and a supported entity, derives the comparison period server-side,
  and returns the complete capped payload.
- `GridWorkspace` owns a `loading | ready | error` transport state. The ready branch
  invokes the unchanged `buildGridModelSafely` and `toCsv` pipeline over all returned
  rows.
- The response is private and non-cacheable. Foreign and unknown profiles are the same
  `404`; unexpected failures are sanitized.
- No shared contract or database schema changes. The wire shape is app-local because
  both producer and consumer belong to `apps/web`.

This is a deep boundary with one public operation: ask for the complete, authorized
Grid dataset. It hides identity, tenant, currency, comparison-window, cap, and query
policy from the browser rather than exposing a sequence the caller must coordinate.

## Synthesis decision

The chosen design starts from the smallest public surface: one same-origin read route
and the existing full-row client model. It adds the testability candidate's explicit
payload validator and race-resistant state machine. A suspended row promise was
rejected because its eventual value still enters the RSC stream. Server pagination was
rejected because callers would need to reconstruct global filtering, grouping, totals,
and export, creating a second and observably different Grid.

## Tradeoffs accepted

- We accept one post-shell HTTP request in exchange for removing the row array from the
  initial document and retaining exact all-row operator behavior.
- We accept holding the complete capped dataset in browser memory in exchange for
  truthful global grouping, totals, and export.
- We accept a redundant `rowCount` field in exchange for a loud source-to-transport
  assertion before rows become actionable.
- We retain the 50,000-row cap and visible truncation warning in exchange for bounded
  browser memory and response size.

## Acceptance checks

- The authenticated browser HTML/RSC contains no fixture row marker, is at most 256 KiB
  decoded, and is at least 85% smaller than the observed 2.17 MB response; a production
  build separately proves the boundary compiles in the deployed mode.
- The separate response and ready Grid contain exactly 3,597 synthetic rows, and the
  database, response `rowCount`, client model, and CSV counts reconcile.
- Filtering, three-level grouping, totals, and export remain byte-for-byte equivalent
  after JSON transport; p95 pipeline response remains below 150 ms on the reference
  fixture.
- Exactly one settled row request is made per Grid scope. Loading exposes no actionable
  toolbar or export, and error, retry, malformed-count, abort, and late-response paths
  are covered.
- Requests require authentication and organization membership. Foreign and unknown
  profiles return the same `404`; browser-supplied tenant or currency data is ignored.
- The encoded 3,597-row response remains below 4 MB, leaving headroom under the hosting
  platform's 4.5 MB response limit.
- Typecheck, lint, tests, hygiene, production build, Playwright, and an explicit
  no-Amazon-call source assertion pass.

## Out of scope

This package performs no migration, production write, Amazon call, server-side Grid
pagination, saved-view redesign, or shared-contract change.
