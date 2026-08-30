# WP-125 campaign-creation contract rationale

## Problem

OpenSpell needs one immutable, cross-package representation for operator-approved campaign
creation across Sponsored Products, Sponsored Brands, Sponsored Brands Video, and Sponsored
Display. The existing `packages/campaigns` plan is intentionally package-local and shaped for an
SP bulksheet, while the guarded scalar-write contracts assume reversible numeric updates. Creation
is different: it produces provider IDs in dependency order, provider timeouts can be ambiguous,
and a successful create has no delete rollback. The shared package must encode those invariants
without leaking Amazon wire envelopes, database rows, or worker execution details.

## Usage (caller's view)

The pure campaign compiler builds semantic nodes, orders them deterministically, computes each
canonical preimage with the shared serializer, and freezes the resulting plan fingerprint in its
own Node-capable boundary:

```ts
import {
  CampaignCreationPlan,
  orderCampaignCreationNodes,
  serializeCampaignCreationNodeFingerprint,
  serializeCampaignCreationPlanFingerprint,
} from '@wizard-ads/shared';

const nodes = orderCampaignCreationNodes(semanticNodesWithFingerprints);
const plan = CampaignCreationPlan.parse({ ...header, nodes, counts, fingerprint });
```

Persistence stores the parsed plan as an immutable artifact. The worker loads the same schema,
recomputes SHA-256 over the canonical serializers, resolves `plan_node` references only from prior
append-only node results, and writes a `CampaignCreationProviderResult` for every attempted node.

```ts
const plan = CampaignCreationPlan.parse(row.plan_json);
const evidence = CampaignCreationProviderResult.parse(providerResult);
const accounting = CampaignCreationAccounting.parse(snapshot);
```

The future queue integration imports `CampaignCreationJobPayload`, but the main `JobPayload` union
does not register those job types until a worker executor exists. This makes unsupported creation
jobs impossible to enqueue through the current queue contract.

## Shape

The public surface is one discriminated node union, one plan schema, append-only provider and
observation records, one closed current-evidence bundle, deterministic ordering/canonical
serialization helpers, and an unregistered future job union. The plan is provider-semantic rather
than provider-wire-shaped: adapters own Amazon media types, envelope differences, request batch
limits, and response parsing.

Every create reference points to an explicit plan preflight or earlier create node and names the
expected resource kind. Existing Amazon resources therefore enter a plan through scoped product,
brand, Store, or Asset-ID/version requirement nodes instead of unverified inline IDs. Provider IDs
are never written back into the frozen plan. Validation proves node and provider-resource
uniqueness, dependency existence, acyclicity, strictly forward stage ordering, stable topological
order, parent-reference dependency coverage, expected referenced resource kinds, single
profile/product/dialect scope, effect/rollback correctness, and exact count reconciliation.

Requirement nodes are read checks. Create nodes are irreversible effects. Every create node says
`rollback: "none"`; the plan-level acknowledgement names a separately reviewed pause/archive as
the only compensating action. Newly created campaign, ad-group, ad, target, and creative resources
are paused in the semantic contract.

Sponsored Brands payloads follow the current unified Amazon contract rather than projecting the
legacy v4 creative shape onto Collections. Automatic Collections carry shared brand identity,
optional logo and exclusions; Amazon generates their title and landing experience. Manual
Collections carry 3–10 products, shared brand identity, optional logo/title and an ASIN-list or
checked Store landing. Store Spotlight carries one checked logo plus exactly three unique
Store-page/product cards; the Store page supplies the card imagery. The contract uses a
conservative 100-exclusion ceiling while Amazon's current guide and OpenAPI disagree.

Canonical serializers deliberately produce preimages rather than hashes. `packages/shared`
depends only on Zod and stays runtime-neutral; Node-capable persistence and worker boundaries own
SHA-256 and compare the stored hash with the recomputed preimage. This concentrates canonical
ordering knowledge in shared without introducing a platform crypto dependency.

The interface is intentionally deep: callers supply or consume one validated graph and do not
coordinate product-specific execution stages. Product-specific provider complexity stays behind
future adapters, while graph and evidence invariants stay centralized here.

## Synthesis decision

The chosen design starts from the typed flat-DAG candidate because it maps partial provider
results and dependency blocking to stable node identities. It takes the product-specific payload
precision of the nested-plan candidate, but keeps those payloads behind one node union instead of
exposing four unrelated plan APIs. It also takes the generic candidate's single executor surface,
while rejecting untyped payload records.

## Tradeoffs accepted

- We accept a larger discriminated union in exchange for compile-time product and format
  visibility without Amazon wire leakage.
- We accept SHA-256 computation outside shared in exchange for keeping shared platform-neutral and
dependency-pure.

The current-evidence bundle closes every approved create into exactly one provider result or
non-provider disposition, closes every successful or ambiguous provider result into exactly one
current observation, and rejects duplicate provider call positions. Its snapshot is recomputed
from the node-level evidence, including explicit `not_found` observations; callers cannot declare
an execution successful, refused, or blocked while contradictory evidence exists.
- We accept a future job union that is not yet part of `JobPayload` in exchange for making it
  impossible for the current worker to claim an unsupported creation job.
- We accept one-resource dispatch for unproven non-indexed provider responses in exchange for
  lossless result correlation.
- We accept that create cannot be reverted in exchange for truthful recovery: any pause/archive is
  a new guarded mutation.

## Alternatives considered

### Generic nodes with arbitrary payloads

One shallow schema could expose `{ kind, payload: unknown }`. It would hide little: every compiler,
worker, UI, and test would need to rediscover the product rules and cast the same payload. That is
information leakage and was rejected.

### Product-specific nested plans

Separate SP, SB, video, and Display trees would be comfortable for form rendering, but partial
execution would require every persistence and worker caller to flatten the trees, invent temporary
identity rules, and reconcile counts differently. The interface exposes execution sequencing and
was rejected as temporal decomposition.

### Stage arrays

A plan containing ordered arrays such as `preflight`, `campaigns`, `adGroups`, and `ads` makes the
happy path obvious, but cross-stage references and ambiguous recovery become positional. It also
hard-codes today's execution order into every caller. The flat DAG hides more policy behind a
smaller executor surface.

## Open questions and risks

- Which entitled profiles should use unified campaign management versus legacy product endpoints?
- Which exact Asset Library approval and moderation states are sufficient for each SB/Display
  format in each marketplace?
- Does Amazon publish an idempotency key or exact semantic query suitable for ambiguous-create
  recovery for every product?
- Which Sponsored Display on-Amazon product-ad shape and response-correlation guarantee is
  authoritative?
- Which SB moderation states are terminal, and which read endpoint proves delivery readiness?

These questions block adapters or live execution, not the provider-neutral graph.

## Next implementation step

Implement verified provider reads and dialect-specific adapters without changing the current queue
union. Persistence, worker execution, web approval and deployment remain later serialized packages.
