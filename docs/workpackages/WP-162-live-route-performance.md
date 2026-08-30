# WP-162 — Live route performance boundary

## Outcome

Remove one proven duplicate render from the root entry route and make future
Grid performance decisions depend on closed, count-checked timing evidence.
Authentication, organization membership, profile ownership, complete-result
loading, date semantics, and Grid response limits remain unchanged.

## Evidence before the change

An immutable, revision-stamped candidate was measured serially through the
existing protected release transport:

| Boundary | Wall time |
|---|---:|
| `/` through its redirect to Dashboard | 12,221 ms |
| `/dashboard` | 7,218 ms |
| `/grid` server document | 4,151 ms |
| complete Grid rows request | 5,653 ms |

The root and direct Dashboard requests returned the same final Dashboard
artifact. The roughly five-second difference was therefore the discarded root
application render plus its transport boundary, not useful product work.

The Grid request already emitted fixed `Server-Timing` spans, but the release
verifier discarded response headers. A closed parser now retains only the exact
ordered names `actor`, `role`, `profile`, `rows`, `serialize`, `close`, and
`total`, each with a finite non-negative duration. Everything else is refused.
The unchanged candidate measured:

| Grid server span | Duration |
|---|---:|
| actor | 672.52 ms |
| role | 669.38 ms |
| profile | 0.01 ms |
| rows | 1,192.00 ms |
| serialize | 61.30 ms |
| close | 101.95 ms |
| total | 2,697.16 ms |

The verifier also reconciled the response `rowCount` against the returned array
length and confirmed that the operator-sized result was complete and
untruncated. The count itself is runtime evidence and is not copied into this
public brief.

This trace clears teardown and serialization as the dominant cause. It does
not justify weakening session verification, reusing one request connection
across concurrent calls, paginating the Grid, or changing its fact query
without a query-plan proof.

## Change

- Next's pre-filesystem redirect sends `/` to `/dashboard` with a temporary
  `307`. Next preserves the original query string, including one explicit
  profile value.
- The existing Dashboard gate remains the only authority for session,
  membership, active organization, and profile selection.
- The immutable-candidate verifier performs one additional read-only Grid rows
  request. It reports only status, wall time, response bytes, reconciled counts,
  truncation state, and the closed timing durations.
- Candidate transport never retains arbitrary response headers, descriptions,
  identifiers, cookies, or query values.

## Executable safety evidence

The key safety fact is that the new redirect changes only where the entry alias
is resolved; it does not bypass the guarded destination.

- A production build returned `307` and the exact location
  `/dashboard?profile=<synthetic UUID>` before rendering the root application.
- The authenticated Playwright database suite created a disposable synthetic
  tenant, proved that an anonymous root visit still reaches Login, proved that
  an authenticated root visit reaches the canonical org-scoped Dashboard, and
  then dropped the database.
- Twenty-five warm production-server requests compared the same exact revision
  before and after the routing change. Root redirect time moved from a 6.511 ms
  median / 6.913 ms p95 to 0.689 ms median / 0.923 ms p95. This local result
  proves the render boundary was removed; it is not represented as hosted
  latency.
- The release transport tests reject missing, reordered, described, or
  identifier-bearing timing spans.
- The unchanged hosted candidate passed the expanded verifier with an exact
  row-count reconciliation before runtime behavior was changed.

## Verification and next gate

- Web typecheck, focused release/timing tests, production build, and the two
  root authentication Playwright cases pass.
- The full repository check must pass on the final rebased head before merge.
- After deployment, rerun the immutable-candidate verifier. Hosted root latency
  is not claimed improved until that exact candidate passes and is measured.
- The next Grid optimization, if still needed, must start from the new span
  report. Actor, receipt/database acquisition, and fact aggregation are separate
  candidates; this package changes none of them.

No Amazon client, write, migration, production database change, credential, or
real account fixture is introduced.
