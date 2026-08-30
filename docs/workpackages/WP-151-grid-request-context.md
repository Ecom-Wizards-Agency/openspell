# WP-151 — Grid request context

## Problem

The complete Grid rows endpoint authenticates through the shared page-oriented
request context, opens a second database connection for the route, repeats the
membership lookup, and then resolves the selected profile in another statement.
On the hosted application those serial steps dominate the route before the Grid
facts query begins. They also create a correctness hazard: tenant identity,
profile ownership, and currency are assembled by separate reads.

## Usage

`GET /api/grid/rows` needs one read grant before it can call `loadGridRows`:

- a verified Supabase subject, or the isolated end-to-end bridge subject;
- one active organization in which that subject is currently a member;
- a requested profile owned by that same organization; and
- the profile's server-owned currency.

The route must preserve the externally observable refusal order: missing or
invalid identity is `401`, no membership is `403`, malformed Grid input is
`400`, and both unknown and foreign profiles are the same `404`. Error
responses do not expose timing details.

## Shape

The Grid owns one narrow, deep request authorization operation. It verifies
only the subject at the auth boundary, reads the untrusted active-org cookie
without accepting it as authority, opens the route database, and resolves a
`GridReadReceipt` with one SQL statement. It returns that receipt together with
the same raw `RequestDatabase` that the facts query must use. The statement:

1. enumerates the subject's memberships;
2. uses the bridge organization only when it is an exact membership;
3. otherwise prefers a valid active-org cookie and falls back to the same
   deterministic organization-name ordering as the application shell; and
4. joins the requested profile inside the selected organization to obtain its
   currency.

The resulting grant is the only source of `orgId`, `profileId`, and
`currencyCode` passed to `loadGridRows`. No caller can assemble or override
those fields independently.

Production subject verification uses Supabase `getClaims()`. The installed
library verifies asymmetric sessions locally when possible and falls back to
its authoritative user lookup when the token or runtime requires it. The
existing `currentUser()` path remains unchanged for pages that need user email
or its established cache semantics. The end-to-end bridge remains mutually
exclusive with configured Supabase Auth, requires its constant-time secret
check, and requests exactly the organization named by its guarded headers.

## Synthesis

Use one request authorizer, one request database, and one authorization-receipt query. This combines the
strong part of the receipt design—an unforgeable, membership-fenced input to the
facts query—with the existing raw database handle's small serverless bundle and
explicit serializer behavior. Keep the Grid optimization local rather than
changing authentication or database lifecycle for every route.

Identity, database acquisition, and receipt resolution are implementation
details of that one operation rather than a temporal sequence the route can
reorder. Identity and receipt adapters exist only as construction-time test
seams. If identity fails no database opens; if receipt resolution fails the
operation closes its own handle; after success the route owns one close.

The route parses query input into a non-throwing attempt before authorization.
That lets the receipt query use a nullable candidate profile while retaining
the required `401` then `403` then `400` then `404` precedence. On success,
fixed identifier-free timing spans remain `actor`, `role`, `profile`, `rows`,
`serialize`, and `close`. `actor` is the verified-identity boundary, `role`
owns the combined authorization SQL duration, and `profile` is only local
interpretation of the nullable receipt; no custom labels are accepted.

## Tradeoffs

- The receipt query is denser than three independent helpers, but it makes the
  security invariant executable and removes serial database round trips.
- `getClaims()` improves the common asymmetric-key path but cannot promise a
  local-only check for every Supabase configuration; the library's fallback is
  intentionally retained.
- The route still creates and closes its raw database handle. Reusing a global
  one-connection pool could remove setup cost, but would couple concurrent
  requests and revive lifecycle failures already observed in server rendering.
- This package does not remove the browser's hydration delay before the API
  request. That is a separate transport optimization after hosted remeasurement.

## Alternatives

- **Reuse the application-wide database and current actor helpers.** Smaller
  diff, but keeps duplicate membership/profile reads and couples the API to a
  process-global single-connection pool.
- **Resolve identity, membership, and profile through several shallow helper
  calls.** Easy to read individually, but preserves latency and allows tenant
  facts to drift between statements.
- **Move all route authentication to `getClaims()`.** Potentially broader
  improvement, but changes email, caching, and session behavior outside Grid
  without evidence that those routes share the same bottleneck.

## Risks

- A malformed cookie must never override membership fallback.
- A bridge organization must never fall back to another membership.
- An unknown role label must remain read-only (`viewer`).
- An invalid query must not bypass authentication or reveal membership/profile
  existence.
- A foreign profile and a nonexistent profile must remain indistinguishable.
- The authorization and facts reads must use the same request database, and it
  must close exactly once on both success and refusal.

## Next step

Implement the Grid-local subject verifier and receipt resolver, exercise the
security and count invariants against a disposable migrated PostgreSQL database,
then deploy a revision-stamped candidate and compare hosted `Server-Timing`
before considering hydration or connection-pool changes.
