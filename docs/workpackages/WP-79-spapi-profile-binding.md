# WP-79 — SP-API profile binding and weekly SQP runtime

## Problem

The durable SQP workflow can plan, request, poll, parse, promote, classify, join,
and checkpoint Amazon Brand Analytics reports, but the production worker has no
authoritative way to choose an SP-API authorization for an Ads profile. It also
has no weekly producer for `sqp.request`. The seam must keep the refresh
credential in Vault, bind exactly one marketplace to a profile, count every
advertised-ASIN input, and remain inert until an operator supplies credentials
and applies the additive migration.

## Usage (caller's view)

At worker startup, the existing database handle and deployment-owned LWA app
credentials construct one tenant-scoped runtime:

```ts
const sqpRequest = createSpApiSqpRequestHandler({
  handle,
  lwaClientId: config.spApiClientId,
  lwaClientSecret: config.spApiClientSecret,
});

const sqpSchedules = new PostgresWeeklySqpScheduler({ handle, store });

new SyncWorker({
  integrations: { sqpRequest },
});

new ScheduleProvisioner(store, undefined, console, recommendationRuns, sqpSchedules);
```

The scheduler is called repeatedly and remains idempotent. It derives the last
complete Sunday–Saturday week in each profile's timezone, deduplicates active
advertised ASINs, and enqueues at most one job for a profile, marketplace, and
week. The job handler resolves the same exact binding again before every Amazon
call sequence, so disabling or revoking a connection takes effect before a
cached access token can be used.

## Shape

`spapi_profile_bindings` is the normalized ownership seam. Its unique
`profile_id` encodes one SP-API assignment per Ads profile; its explicit
`marketplace_id` prevents a profile-wide credential from making a request in an
unapproved marketplace. A database trigger rejects cross-tenant profile and
connection pairs. Dedicated service-role Vault functions store, read, rotate,
and revoke the refresh credential without exposing it to the browser.

`packages/sp-api` owns LWA access-token exchange and caching behind the existing
`SpApiAccessTokenProvider` interface. It knows HTTP and token expiry, but knows
nothing about Postgres, organisations, or profiles. `packages/db` owns the
tenant-scoped binding and advertised-ASIN queries. `apps/worker` composes those
two deep modules into a per-connection client pool and the weekly producer.

No new shared payload is needed: `SqpRequestJob` is already authoritative. The
worker receives only binding metadata and count summaries from the database;
the refresh credential crosses one service-role function boundary and is never
returned by a list/query surface. The worker composes two explicit surfaces—the
request handler and the schedule producer—while hiding token refresh, endpoint
selection, tenant checks, date calculation, batching, deduplication, and queue
identity.

## Synthesis decision

The explicit binding table is the base because it gives Postgres enforceable
identity and keeps provider metadata out of JSON. The small runtime façade from
the minimal-surface candidate was retained, and the independently testable LWA
provider from the isolation candidate was grafted into `packages/sp-api`.

Two alternatives were rejected:

- Adding `spapi` to generic `integration_connections` would encode profile and
  marketplace identity inside provider config JSON. Every caller would need to
  understand that representation, and Postgres could not enforce one assignment
  per profile.
- Adding SP-API columns directly to `ad_profiles` would be smaller today, but it
  couples the Ads mirror to a Seller/Vendor authorization that can serve several
  marketplaces and profiles. It makes future connection rotation and ownership
  harder rather than hiding that complexity.

## Tradeoffs accepted

- We accept one binding per Ads profile in exchange for unambiguous SQP/PPC
  attribution. Multi-market Seller Central authorizations reuse one connection
  through several binding rows.
- We accept active advertised ASINs as the initial scheduler's product set in
  exchange for a source already synchronized and attributable to the profile.
  Catalog-complete ASIN coverage remains a later, separately verified source.
- We accept an operator-applied migration and deployment-owned LWA app
  credentials in exchange for keeping production and shared Supabase unchanged
  during implementation.

## Open questions and risks

- Does the registered SP-API application already hold the Brand Analytics role
  in every intended marketplace?
- Which operator flow will create the first connection and binding: a later
  Seller Central OAuth screen or a one-time service-role onboarding command?
- How many advertised ASINs return no Brand Analytics data, and should a later
  catalog source narrow the request set before live scheduling expands?

## Production activation gate

An operator must authorize the exact migration target, complete the SP-API OAuth
grant with the required Brand Analytics role, store the rotated refresh
credential through the service-role custody function, bind each Ads profile to
its exact marketplace, and configure the worker deployment. Until then the new
runtime remains inert and no production or shared database is changed.
