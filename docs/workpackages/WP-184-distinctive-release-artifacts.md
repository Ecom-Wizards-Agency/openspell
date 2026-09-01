# WP-184, distinctive release evidence

Owner: WP-04 (`apps/web`). Runtime state: verifier only; no deployment or promotion.

## Outcome

The immutable-candidate verifier proves the exact hosted OpenSpell revision, official SVG bytes,
Campaign Grid account/date/brand context, Recommendations review identity, all existing route
guards, and complete Grid rows. It emits one deterministic privacy-safe evidence document that
explicitly grants no promotion authority.

Architecture rationale: `docs/design/WP-184-ARCHITECTURE.md`.

## Scope

This package may edit:

- web revision identity and `/api/healthz`;
- the release candidate transport, redirect response shape, capability verifier, evidence
  projection, launcher, and their tests;
- the shared web UI artifact-marker constants, real brand element, and collected source test;
- the Recommendations page and its existing browser proof;
- this brief and architecture rationale;
- rolling handover/status prose only after merge verification.

It must not edit shared contracts, database code, migrations, worker code, Ads clients, deployment
configuration, provider state, or Amazon state. It must not deploy or promote a candidate.

## Required invariants

1. The candidate remains an immutable HTTPS Vercel deployment URL distinct from the fixed
   production origin, and the expected revision remains one full Git object id.
2. Vercel's build SHA is authoritative. A malformed value or disagreement with an explicit local
   value fails closed. A local fallback can never prove a Vercel candidate.
3. Health and official SVG requests run before CDP access and never receive cookies.
4. Only exact public health and SVG evidence creates the opaque candidate capability accepted by
   authenticated checks.
5. The official SVG requires exact status, redirect absence, effective URL, media type, and raw
   body digest.
6. Authenticated requests remain GET-only, bounded, manual-redirected, same-origin, exact-profile,
   serialized, and supplied through stdin rather than arguments, files, or logs.
7. The child that receives cookies inherits no proxy, custom-CA, database, Amazon, preload,
   diagnostic, bypass, or unrelated OpenSpell environment values. CDP is loopback-only.
8. Campaign Grid uses the campaigns entity and explicit dates. The server DOM must contain the
   real heading, nonempty active-account context, real date control values, and versioned brand
   element.
9. Recommendations carries one versioned review marker on every authenticated non-error data
   state. A heading alone, login, alert, or error document fails.
10. Grid rows use the same campaign/profile/date context and require exact safe counts, no
    truncation, and complete closed timing evidence.
11. The public evidence schema is fixed and deterministic. It contains a domain-separated origin
    digest, public revision identity, fixed check ids, fixed reason codes, and public missing-
    artifact ids only.
12. Evidence contains no hostname, URL, cookies, profile id, account label, body fragment, row or
    account count, response size, raw timing, header value, or provider identifier.
13. Evidence says `purpose: verification-only` and `authorization: none`. No code converts it to
    deployment or promotion authority.
14. Existing browser QA, exact-head CI, exact-main CI, and attended promotion remain separate gates.

## Acceptance checks

- Revision tests cover Vercel authority, equal values, conflicts, malformed present values, local
  fallback, missing values, normalization, and health source output.
- The real tracked SVG hash is asserted from its bytes, and CSS still maps `.wa-brand-mark` to that
  asset.
- Public-identity tests reject wrong status, redirect, effective URL, media type, hash, product,
  readiness, source, and revision without running the SVG or authenticated request out of order.
- DOM tests reject heading-only Grid and Recommendations documents, marker strings outside real
  elements, empty account context, defaulted dates, login/error surfaces, and wrong final routes.
- A complete synthetic route sweep records maximum request concurrency of one.
- Grid tests reject count mismatch, truncation, malformed or unsafe JSON counts, missing timing,
  and mismatched campaign/profile/date requests.
- Transport tests prove exact argv/stdin separation, raw-body digest, closed media types, effective
  URL matching, bounded output, fixed errors, and environment removal.
- A subprocess test proves public checks precede CDP, no cookie reaches public requests, malicious
  inherited diagnostic/proxy/custom-CA/database/Amazon values are absent, and output contains none
  of the supplied canaries.
- The existing Recommendations browser suite asserts both the versioned marker and real review
  controls on the successful state.
- New source tests use the collected `.test.ts` suffix; no new `.test.tsx` test is added.
- Focused release tests, web typecheck, web build, full `pnpm check`, `git diff --check`, staged
  hygiene, exact-head PR CI, and exact-main CI pass.
- Static diff review proves no migration, deployment, promotion, database mutation, provider
  write, or Amazon call was introduced.

## Later release work

After this package merges, close PR #35 because its distinct requirements are preserved. A later
authorized release may deploy an exact revision to an immutable production-target candidate, run
this verifier and attended browser QA, then promote the alias. WP-184 itself performs none of those
actions.
