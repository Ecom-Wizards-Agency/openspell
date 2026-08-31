# WP-180 — inert Sponsored Products write provider adapter

Owner: WP-02 (`packages/ads-api`). Depends on merged WP-179. Runtime state: gated and unreachable.

## Outcome

Add an explicit, pure-client Sponsored Products v3 adapter that converts verified WP-179 plans into
exact provider observations, write-ahead position descriptions, and one-attempt closed results. It
must remain absent from the current worker and must not make a live provider call in this package.

Architecture: `docs/design/WP-180-ARCHITECTURE.md`.

## Owned files

- `packages/ads-api/src/sp-write-adapter.ts`
- `packages/ads-api/src/sp-write-adapter.test.ts`
- `packages/ads-api/src/sp-write-codec.ts`
- `packages/ads-api/src/sp-write-codec.test.ts`
- narrow changes to `packages/ads-api/src/http.ts` and `http.test.ts`
- narrow cancellation propagation in `packages/ads-api/src/auth.ts`, `context.ts`, and `headers.ts`
- `packages/ads-api/package.json`
- this brief and the WP-180 architecture document

Do not edit `packages/shared`, `packages/db`, `supabase`, `apps/worker`, `apps/web`, `apps/mcp`,
current job unions, deployment configuration, authorization configuration, or the Ads API root
barrel. Do not revive or cherry-pick PR #24 wholesale.

## Provider evidence

Implementation is pinned to the 2026-08-31 captures recorded in the architecture:

- Sponsored Products v3 OpenAPI SHA-256
  `fec774c5ba95e860bd732f1f56d4e5a401ffeb76d500b3a2e059f4eb51c198c3`;
- Amazon Ads marketplace limits SHA-256
  `a96b137e1be218889b76ebf2677ee5a9263df20945be2cc68386d43b9e86693f`.

The code may contain public provider enums, marketplace IDs, currencies, and documented limits. It
must not contain a profile roster, client data, credentials, or tenant doctrine values.

## Required behavior

1. Export the adapter only from `@wizard-ads/ads-api/sp-write-adapter`.
2. Verify plan and action fingerprints, then deterministically group one route and at most 100
   positions per prepared call.
3. Compile all five WP-179 update routes without accepting caller-supplied paths, media types,
   envelope keys, provider IDs, or numeric wire values.
4. Bind every canonical wire row to a domain-separated `actionRequestFingerprint`; independently
   recompile and compare every intent binding before mutation.
5. Validate marketplace, region, currency, scale, bid/budget bounds, and exact decimal-to-JSON
   number equality without rounding.
6. Send campaign budget updates as `DAILY` only and refuse observations of `OTHER` or unknown budget
   types.
7. Read current entities through exact route-specific ID filters, exhaust bounded pagination, and
   reconcile requested, returned, duplicate, missing, extra, malformed, and truncated counts.
8. Parse complete replacement-sensitive campaign bidding state. Preserve all four placements,
   strategy, shopper cohorts, audience segments, and off-Amazon settings; refuse unknown context.
9. Make at most one mutation fetch after a valid intent. Never batch, follow redirects, retry 429,
   replay after 401/403, retry 425/5xx, or resend after transport uncertainty.
10. Apply cancellation and a finite deadline across credential resolution, fetch, and bounded body
    consumption. A pre-aborted request must never issue a late fetch.
11. Accept terminal provider positions only from a structurally complete indexed 207. Any malformed,
    non-indexed, non-207, transport, timeout, cancellation, redirect, or identity failure closes all
    intent positions as `ambiguous`.
12. Return a fully fingerprinted `SpWriteProviderResult` with exact ordered positions and no raw
    provider body, headers, request row, URL query, arbitrary error value, or credential-shaped text.
13. Leave the current low-level SP mutation methods and their established retry behavior unchanged.
14. Add no runtime consumer, job registration, migration, environment grant, deployment, or live
    smoke action.

## Test matrix

### Pure codec

- all five routes and every supported grouped change combination;
- product-ad `productAdId` to provider `adId` mapping;
- empty, 101-row, mixed-route, duplicate-entity, duplicate-action, noncanonical-order, unknown-action,
  and tampered-plan refusals before provider I/O;
- official marketplace/region/currency mapping, bid and budget min/max boundaries, currency-scale
  boundaries, unknown markets, exponent/round-trip loss, and large unsafe decimals;
- exact request-row fingerprint stability and drift on any scope, identity, or wire-field change;
- four placements, absent and populated cohorts, audience segments, off-Amazon values, canonical
  ordering, duplicate/unknown enums, malformed percentages, unknown sibling keys, and omission/null
  semantics;
- strict observations for enabled/paused state, explicit money, legacy `OTHER` budget, missing,
  extra, duplicate, malformed, and paginated entities;
- strict reordered 207 success/error parsing, missing/duplicate/out-of-range indexes, dual error
  arrays, wrong entity IDs, and malformed members.

### Transport and adapter

- independent stateful fake provider checks exact request bytes and applies mutations without using
  production serializers or parsers;
- one mutation fetch for 1 and 100 positions;
- queued 207 after 429, 401, 425, redirect, and 5xx is never consumed;
- faults before fetch, after capture, during body reading, and on a hanging abort-aware response;
- delayed credential resolution plus early abort results in zero late fetches;
- read retries remain idempotent while mutation attempts remain exactly one;
- valid mixed 207 produces exact accepted/rejected positions in request-index order;
- every ambiguous case produces all positions exactly once;
- synthetic secrets seeded in bodies, headers, thrown causes, nested errors, and oversized text do
  not appear in returned objects, thrown public errors, or captured logs;
- returned results parse under `SpWriteProviderResult` and have valid fingerprints;
- package self-reference resolves the explicit subpath while the root namespace omits the adapter;
- static repository checks find no current worker import, SP-write `JobPayload` member, handler,
  registration, migration, deployment variable, or live-smoke reference.

### Regression and blast radius

- the existing Ads API suite remains green;
- existing retry/backoff, profiles, entity lists, reports, exports, budgets, and low-level writes keep
  their behavior;
- `pnpm --filter @wizard-ads/ads-api typecheck` and package tests pass;
- `pnpm check` passes from the repository root;
- production web build and Playwright pass before merge;
- `pnpm hygiene` scans the tracked tree cleanly.

## Acceptance

- [x] Architecture is committed before implementation.
- [x] The explicit subpath compiles and the root barrel remains unchanged.
- [x] Every preparation and observation refusal proves zero mutation calls.
- [x] Every execution outcome proves at most one mutation fetch and exact position closure.
- [x] Marketplace money and complete placement behavior are executable, not prose-only.
- [x] High correctness review reports no unresolved blocker/high finding.
- [x] Extra-High adversarial safety review reports no unresolved blocker/high finding.
- [x] Package tests, full repository checks, build, Playwright, and hygiene pass.
- [x] PR exact-head CI passes both jobs before merge.
- [x] Handover/status update only after merge and continues with the persistence slice.

## Deliberately deferred

- DB schema, RLS, write-ahead reservation, result persistence, outbox, and recovery;
- worker job membership, handler registration, orchestration, retry fencing, and observation jobs;
- environment/profile grants, bounded live-test authorization, deployment, and one-entity proof;
- any Amazon write or hosted schema action.
