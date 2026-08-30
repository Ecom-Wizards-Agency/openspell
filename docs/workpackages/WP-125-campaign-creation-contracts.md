# WP-125 — Campaign creation contracts

## Outcome

Add the authoritative provider-neutral contract for immutable Sponsored Products, Sponsored
Brands, Sponsored Brands Video, and Sponsored Display creation plans. This is a stacked package on
the reviewed scalar-write gateway because both packages extend `packages/shared`.

No database, migration, provider client, worker executor, web route, deployment, credential, or
Amazon call belongs to this package.

## Files

- `packages/shared/src/campaign-creation.ts`
- `packages/shared/src/campaign-creation.test.ts`
- `packages/shared/src/index.ts`
- `docs/design/WP-125-ARCHITECTURE.md`
- this brief

## Contract

- One immutable plan covers exactly one organization, profile, marketplace, ad product, and API
  dialect.
- Typed flat-DAG nodes distinguish read checks from irreversible creates.
- New resources refer to prior nodes without putting provider-assigned IDs into the frozen plan.
- Product, brand, Store, and Asset-ID/version usage must resolve through explicit preflight nodes.
- Campaign, ad-group, ad, target, and creative creates are paused and declare no rollback.
- SP, SB formats, SB Video, and Sponsored Display use semantic payloads; Amazon wire envelopes stay
  private to future adapters.
- Node order, references, dependencies, product/dialect scope, Store pages, asset purposes,
  targeting constraints, dates, and exact counts are validated before freeze.
- Canonical serializers expose stable SHA-256 preimages without adding a crypto/runtime dependency
  to shared.
- Approval binds tenant, plan identity/hash, marketplace, product, dialect, expiry, exact counts,
  and the no-rollback acknowledgement.
- Provider result, fresh resource observation, Amazon creative moderation, and delivery are
  separate evidence dimensions.
- Accounting is closed across pending dispatch, provider outcomes, runtime refusal, dependency
  blocking, observation, conflicts, and read checks.
- Future creation job shapes are exported but deliberately absent from the current `JobPayload`;
  the queue cannot claim them before the matching migration and worker executor land together.

## Acceptance

- Every product-facing schema uses synthetic fixtures only.
- At least one complete SP graph and one SB Store Spotlight graph round-trip.
- Invalid counts, dependency order, cycles, missing dependencies, scope drift, enabled resources,
  keyword polarity, Store pages, and asset purposes are refused.
- Canonical node and plan preimages change when bound semantics or approval-envelope fields change.
- Successful provider and observation evidence requires an Amazon resource identity.
- Operator, provider, observation, and read-check counts reconcile exactly.
- Current workers reject the reserved future creation jobs.
- Typecheck, lint, tests, hygiene, skill-lint, and diff checks pass.

## Deferred by design

The provider dialect decision, current Asset Library client, eligibility/brand/Store reads, create
adapters, persistence, executor, guided UI, production migration, and live one-resource checks are
separate serialized packages. Creation cannot be presented as live until those paths and their
counts are verified end to end.
