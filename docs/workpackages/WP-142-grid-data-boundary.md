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
  and returns the complete capped payload when its raw serialized body fits the
  response budget.
- The serialization boundary has a deterministic 4.0 MB raw-body budget, preserving
  0.5 MB of headroom below the hosting limit. If necessary it returns the largest safe
  contiguous prefix with an exact count and `truncated: true`; the existing visible
  warning then makes clear that on-screen totals cover only those rows.
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
- We retain the 50,000-row database cap, add a 4.0 MB raw-response cap, and show one
  truthful truncation warning for either boundary in exchange for bounded serverless
  response and browser memory.

## Acceptance checks

- After a one-time route warm-up in the repository's authenticated development-browser
  harness, the HTML/RSC contains no fixture row marker, is at most 256 KiB decoded, and
  is at least 85% smaller than the observed 2.17 MB response. That timing is development
  evidence, not a production-latency claim; a production build separately proves the
  boundary compiles in deployed mode, and deployed latency remains a release check.
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
- The raw (not compressed-transfer) 3,597-row response remains exact and below 4.0 MB.
  A representative 50,000-row payload is valid JSON truncated to its largest safe
  prefix, with raw bytes at or below 4.0 MB and count equal to returned rows.
- Typecheck, lint, tests, hygiene, production build, Playwright, and an explicit
  no-Amazon-call source assertion pass.

## Verification evidence

The authenticated browser harness runs the 3,597-row performance proof in a
dedicated Next development process between the tag/navigation suite and the full
auth/role suite. This preserves the real session-cookie and data-loading boundary
while releasing the large fixture and compiled Grid route before unrelated routes
are exercised.

- Reference development run: 1,530.97 ms to usable, 79,968-byte initial document,
  1,287,413-byte row response, exactly 3,597 rows, one settled row request, and an
  exact 3,597-row CSV export.
- The complete local sequence passed 31 tag/navigation checks, the isolated Grid
  performance check, and 29 auth/role checks in separate processes without a server
  restart or out-of-memory failure.
- The product target remains under 2,000 ms on the reference development machine.
  Shared CI runners use a separate 4,000 ms regression ceiling because they are not
  the reference hardware; all count, byte, request, and export assertions are
  identical in both environments.

Hosted CI and deployed production latency remain release gates for the exact merged
revision; local evidence is not presented as a live-performance claim.

## Out of scope

This package performs no migration, production write, Amazon call, server-side Grid
pagination, saved-view redesign, or shared-contract change.
