# WP-156 — Sponsored Brands creative pagination

## Goal

Remove the single-page activation blocker from the read-only Sponsored Brands
ad and Creative Asset Library probes. The Ads API client must return a complete,
count-reconciled result or fail closed. It must never present a truncated result
as complete.

This package owns only `packages/ads-api`. Worker promotion, persistence, web
surfaces, database changes, deployments, and live Amazon verification are out of
scope.

## Provider contracts

- Sponsored Brands v4 ads use `POST /sb/v4/ads/list`. Pagination carries the
  response `nextToken` into the next request while preserving the original
  filters and a maximum page size of 100.
- Creative Asset Library search uses `POST /assets/search`. Pagination carries
  the response `token` in `pageCriteria.identifier`, alongside the next page
  number, while preserving the original text, filters, sort, and page size.
- Creative Asset Library search uses the v3 response media type. Its maximum
  page size is 500.

The implementation remains a pure injected-fetch client. No live Amazon call or
credential is used by this work package.

## Safety invariants

1. Aggregate `sourceRows` must equal the exact number of parsed provider rows.
2. When the provider advertises a total, every page must agree on it and the
   final aggregate must match it exactly.
3. A repeated continuation token, an empty page with another token, or a token
   after the advertised total is complete is an error.
4. Sponsored Brands ad rows are never deduplicated. A repeated ad identifier is
   retained so downstream attribution can classify it as ambiguous.
5. Amazon Asset ID is authoritative creative identity. A duplicate Asset ID is
   rejected rather than silently collapsed.
6. Every page read is idempotent and uses the existing throttle-aware retry
   layer. No mutation endpoint is introduced or invoked.

## Change-impact map

| Boundary | Impact | Executable evidence |
|---|---|---|
| Ads probe callers | Existing method names and aggregate result shapes remain compatible; options are additive. | Package typecheck and workspace typecheck |
| Provider pagination | All pages are fetched with request parameters preserved. | Multi-page request-capture tests |
| Creative identity | Duplicate authoritative Asset IDs fail closed; duplicate ad rows remain visible. | Synthetic duplicate-identity tests |
| Count promotion gate | Truncation and provider-total drift cannot return a successful aggregate. | Exact-total and mismatch tests |
| Retry behavior | Throttled and transient reads are retried through the existing HTTP layer. | Synthetic 429/500 page-walk test |

The highest-risk assumption is that a successful aggregate cannot omit an
advertised provider row. The synthetic multi-page and mismatched-total tests
prove both the success and failure sides of that boundary.

## Acceptance checks

- [x] Multi-page Sponsored Brands ad result is complete and count-reconciled.
- [x] Multi-page Creative Asset Library result is complete and count-reconciled.
- [x] Empty exact results terminate after one page.
- [x] Filters, sort, page size, token, and page number propagate exactly.
- [x] Provider-total mismatches and changes fail closed.
- [x] Repeated tokens and empty-page stalls fail closed.
- [x] Duplicate Asset IDs fail; duplicate ad rows remain visible.
- [x] Throttled and transient reads retry without losing rows.
- [x] Synthetic tests invoke no Amazon mutation endpoint.

Final command and revision evidence is recorded in the pull request.
