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
- Unified SB Collections follow Amazon's current contract: shared brand identity, optional logo and
  Amazon-generated title/landing for automatic collections, 3–10 products plus Store/ASIN-list
  landing for manual collections, and a conservative local supported-subset maximum of 100
  automatic exclusions. The pinned OpenAPI says 1000 while Amazon's own migration skill contains
  both 100 and 1000; the local cap is not a claim about the provider's maximum.
- Unified Store Spotlight uses exactly three unique Store-page/product cards. Card images come from
  the checked Store page; they are not represented as independently selected Asset IDs.
- Unified SB targeting has distinct keyword, product, product-category, and theme variants. Unified
  SB video is one named product-video shape with exactly one checked Asset ID/version; every other
  `productVideoSettings` creative input remains optional.
- Node order, references, dependencies, product/dialect scope, Store pages, asset purposes,
  targeting constraints, dates, and exact counts are validated before freeze.
- Canonical serializers expose stable SHA-256 preimages without adding a crypto/runtime dependency
  to shared, and an explicitly SHA-256 caller-supplied hashing boundary must recompute every stored
  node and plan digest before the artifact is trusted.
- Approval binds tenant, plan identity/hash, marketplace, product, dialect, expiry, exact counts,
  and the no-rollback acknowledgement. The immutable authorization receipt also binds execution,
  authenticated actor/time, confirmation version, approval-time gate snapshot, and claim
  generation.
- Provider result, fresh resource observation, Amazon creative moderation, and delivery are
  separate evidence dimensions. Every observation binds the exact authorization, generation,
  attempt, provider call, and whole/per-node request digests. Only the identity from a conclusive
  successful result may be marked observed; intent-only reconciliation cannot unlock descendants.
- Every irreversible provider call has a complete, zero-based write-ahead intent committed before
  network I/O. Each create node can appear in only one intent; a result without that exact intent is
  refused, whole-request and per-node request digests must match, and an intent without a conclusive
  result remains ambiguous.
- The pre-I/O verifier consumes the validated current execution evidence, refuses any node already
  claimed by an intent or result, and requires every dependency to be satisfied before the
  prospective intent can be committed. Prior intents/results must belong to the same receipt
  window, and no evidence may be ahead of the verification clock. The future persistence slice must
  enforce the same `(executionId, nodeId)` uniqueness atomically.
- Accounting is closed across pending dispatch, provider outcomes, runtime refusal, dependency
  blocking, observation, conflicts, and read checks. Evidence additionally reconciles planned
  preflight identities/versions, unique created identities, dependency outcomes, canonical order,
  provider-call positions, and intent/execution/observation time order. `not_found` never proves
  that an ambiguous create did not happen and remains non-terminal. Execution status is derived
  deterministically from the closed accounting rather than selected by a caller.
- Future creation job shapes are exported but deliberately absent from the current `JobPayload`;
  the queue cannot claim them before the matching migration and worker executor land together.
  Those inactive shapes bind authorization, plan fingerprint, and execution generation.
- Pure compound artifact verifiers join the recomputed plan, immutable receipt, inactive job
  pointer, generation, current time, current evidence, dispatch intent, and observation. Separately
  valid artifacts cannot be mixed. They do not establish current write authority. Expiry refuses
  dispatch but does not prevent a correctly bound observation job from continuing reconciliation.
- Activation requires a DB-clock transaction that verifies the current environment gate, profile
  allowlist, active/unrevoked authorization, exact generation, and owned lease before atomically
  inserting the unique `(executionId, nodeId)` intent. Only the transaction winner may invoke
  Amazon; every refusal test must prove zero provider calls.

## Acceptance

- Every product-facing schema uses synthetic fixtures only.
- At least one complete SP graph and one SB Store Spotlight graph round-trip.
- Invalid counts, dependency order, cycles, missing dependencies, scope drift, enabled resources,
  keyword polarity, Collection semantics, Store pages/products, and asset purposes are refused.
- Canonical node and plan preimages change when bound semantics or approval-envelope fields change.
- Stored node and plan fingerprints are recomputed and tampering is rejected.
- The SHA-256 adapter passes a published known vector; receipt, job, generation, expiry, and intent
  mismatches are refused at the compound trust boundary.
- Successful provider and observation evidence requires an Amazon resource identity.
- The current execution evidence bundle rejects missing/duplicate node results, duplicate provider
  intents or positions, results without prior intent, repeated create attempts, fingerprint drift,
  request-digest drift, invalid or duplicate observations, and snapshot/accounting/status drift;
  an absent first observation is derived as pending.
- Multi-position provider batches reconcile every zero-based node position and its request digest.
- A recorded intent without a conclusive result is quarantined as ambiguous; `not_found` remains
  awaiting observation and cannot become a retryable failure. The immediate crash-after-intent and
  response-before-first-observation windows are valid pending-observation states.
- Operator, provider, `not_found`, observation, and read-check counts reconcile exactly.
- Current workers reject the reserved future creation jobs.
- Typecheck, lint, tests, hygiene, skill-lint, and diff checks pass.

## Deferred by design

Per-profile dialect capability probing, the current Asset Library client,
eligibility/brand/Store reads, create adapters, persistence, executor, guided UI, production
migration, and live one-resource checks are separate serialized packages. Creation cannot be
presented as live until those paths and their counts are verified end to end.
