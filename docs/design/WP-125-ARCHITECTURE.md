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
  CampaignCreationAuthorizationReceipt,
  CampaignCreationPlan,
  CampaignCreationProviderCallIntent,
  orderCampaignCreationNodes,
  serializeCampaignCreationNodeFingerprint,
  serializeCampaignCreationPlanFingerprint,
  verifyCampaignCreationJobArtifacts,
  verifyCampaignCreationObservationArtifacts,
  verifyCampaignCreationPlanFingerprints,
  verifyCampaignCreationProviderCallArtifacts,
} from '@wizard-ads/shared';

const nodes = orderCampaignCreationNodes(semanticNodesWithFingerprints);
const plan = CampaignCreationPlan.parse({ ...header, nodes, counts, fingerprint });

// Every persisted artifact is untrusted until a Node-capable boundary
// recomputes each canonical SHA-256 digest.
const verifiedPlan = verifyCampaignCreationPlanFingerprints(plan, {
  algorithm: 'sha256',
  digest: sha256,
});
```

Persistence stores the verified plan as an immutable artifact. Approval produces a
`CampaignCreationAuthorizationReceipt` that binds the authenticated actor and approval time to the
exact plan fingerprint, execution, generation, confirmation version, gate snapshot, scope, expiry,
and counts.
The worker loads and re-verifies those artifacts, resolves `plan_node` references only from prior
append-only evidence, and commits a `CampaignCreationProviderCallIntent` before any irreversible
provider request.

```ts
const artifacts = verifyCampaignCreationJobArtifacts(
  row.plan_json,
  row.authorization_json,
  job.payload,
  now,
  { algorithm: 'sha256', digest: sha256 },
);
const callArtifacts = verifyCampaignCreationProviderCallArtifacts(
  artifacts.plan,
  artifacts.authorization,
  artifacts.job,
  row.current_evidence_json,
  row.call_intent_json,
  now,
  { algorithm: 'sha256', digest: sha256 },
);
const observationArtifacts = verifyCampaignCreationObservationArtifacts(
  artifacts.plan,
  artifacts.authorization,
  observeJob.payload,
  row.current_evidence_json,
  row.observation_json,
  now,
  { algorithm: 'sha256', digest: sha256 },
);
const evidence = CampaignCreationProviderResult.parse(providerResult);
const accounting = CampaignCreationAccounting.parse(snapshot);
```

The future queue integration imports `CampaignCreationJobPayload`, but the main `JobPayload` union
does not register those job types until a worker executor exists. This makes unsupported creation
jobs impossible to enqueue through the current queue contract. Its inactive pointer shape already
binds the authorization ID, plan fingerprint, and execution generation so a future queue row cannot
act as authority or revive a stale claim.

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

Irreversible provider calls have write-ahead evidence. An intent binds the exact plan and execution,
authorization, generation, attempt, whole-request digest, and complete zero-based node positions
with per-node request digests. Each create result must carry both matching digests, so a provider
response cannot be attached to a different prepared request or batch position. Each create node
may appear in at most one intent. A result without its exact intent is invalid, and an
intent without a result is conservatively ambiguous rather than silently absent. Current
evidence can represent the crash window immediately after intent persistence without inventing an
observation; the missing first observation is derived as pending. Current observations may resolve
delivery state after a conclusive provider result, but v1 observations cannot resolve an ambiguous
or open call. Every observation binds the exact authorization, generation, attempt, provider call,
whole-request digest, and per-node request digest. Only a successful provider result supplies an
identity that an `observed` record may exactly reproduce. An intent-only `not_found`, `pending`, or
`conflict` record never supplies a parent identity: the node stays quarantined and descendants do
not run. A successful provider response alone also does not unlock descendants: the current
source-synchronized observation for that parent must be exactly `observed`; missing, `pending`,
`not_found`, and `conflict` observations keep the dependency gated. A later source-pinned
unique-lookup capability requires a new reviewed contract version.

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
conservative local supported-subset ceiling of 100 automatic exclusions. This is not represented
as Amazon's provider maximum: the pinned unified SB OpenAPI publishes `maxItems: 1000` at
[`unified-api-sb.json` lines 2822–2841](https://github.com/amzn/ads-advanced-tools-docs/blob/5c1c432c3dbe676a571780aa0c4d0217659a5f3a/unified-campaign-management-migration-skills/api-specs/unified-api-sb.json#L2822-L2841),
while Amazon's pinned Collections migration skill says 100 in its summary, optional-field notes,
and FAQ at
[`SKILL.md` lines 16–25](https://github.com/amzn/ads-advanced-tools-docs/blob/5c1c432c3dbe676a571780aa0c4d0217659a5f3a/unified-campaign-management-migration-skills/skills/amazon-ads-sb-collections/SKILL.md#L16-L25),
[`lines 167–169`](https://github.com/amzn/ads-advanced-tools-docs/blob/5c1c432c3dbe676a571780aa0c4d0217659a5f3a/unified-campaign-management-migration-skills/skills/amazon-ads-sb-collections/SKILL.md#L167-L169),
and [`lines 797–799`](https://github.com/amzn/ads-advanced-tools-docs/blob/5c1c432c3dbe676a571780aa0c4d0217659a5f3a/unified-campaign-management-migration-skills/skills/amazon-ads-sb-collections/SKILL.md#L797-L799),
but also says 1000 in its comparison table at
[`SKILL.md` lines 600–603](https://github.com/amzn/ads-advanced-tools-docs/blob/5c1c432c3dbe676a571780aa0c4d0217659a5f3a/unified-campaign-management-migration-skills/skills/amazon-ads-sb-collections/SKILL.md#L600-L603).

Unified SB targets use four semantic `targetDetails` variants—keyword, product,
product-category refinement, and theme—and never reuse the legacy SP/SD expression envelope, as
enumerated by the pinned
[`SBCreateTargetDetails`](https://github.com/amzn/ads-advanced-tools-docs/blob/5c1c432c3dbe676a571780aa0c4d0217659a5f3a/unified-campaign-management-migration-skills/api-specs/unified-api-sb.json#L3779-L3828)
schema.
Unified SB ads carry their required name. Product video is one shape matching
`productVideoSettings`: exactly one checked video Asset ID/version is required; brand, logo,
headline, landing page, auto-translation preference, and zero to three products are optional. Those
cardinalities come from pinned
[`SBCreateProductVideoSettings`](https://github.com/amzn/ads-advanced-tools-docs/blob/5c1c432c3dbe676a571780aa0c4d0217659a5f3a/unified-campaign-management-migration-skills/api-specs/unified-api-sb.json#L3531-L3579),
and the ad name is required by pinned
[`SBAdCreate`](https://github.com/amzn/ads-advanced-tools-docs/blob/5c1c432c3dbe676a571780aa0c4d0217659a5f3a/unified-campaign-management-migration-skills/api-specs/unified-api-sb.json#L385-L425).

Canonical serializers deliberately produce preimages rather than hashes. `packages/shared`
depends only on Zod and stays runtime-neutral; Node-capable persistence and worker boundaries own
SHA-256 and compare the stored hash with the recomputed preimage. The hashing boundary explicitly
declares `algorithm: "sha256"`; tests use Node's SHA-256 implementation and a published known
vector rather than a digest-shaped substitute. This concentrates canonical ordering knowledge in
shared without introducing a platform crypto dependency.

The interface is intentionally deep: callers supply or consume one validated graph and do not
coordinate product-specific execution stages. Product-specific provider complexity stays behind
future adapters, while graph and evidence invariants stay centralized here.

## Synthesis decision

The chosen design keeps the reviewed typed flat DAG because it maps partial provider results and
dependency blocking to stable node identities. A plan-only candidate was rejected because WP-124
requires fingerprint, approval, evidence, and future-job contracts in this serialized package. A
cross-package event-kernel rewrite was also rejected here because provider capabilities,
persistence, and worker execution belong to later packages. The retained contract therefore adds
only the safety facts those future owners need: trust-boundary fingerprint verification, an
immutable authorization receipt, write-ahead call intents, non-terminal `not_found`, and fenced
inactive job pointers. Product payloads remain behind one node union rather than four plan APIs.

## Tradeoffs accepted

- We accept a larger discriminated union in exchange for compile-time product and format
  visibility without Amazon wire leakage.
- We accept SHA-256 computation outside shared in exchange for keeping shared platform-neutral and
  dependency-pure.
- We accept a conservative ambiguous state after a recorded intent without conclusive evidence in
  exchange for prohibiting duplicate non-idempotent creates.

The current-evidence bundle closes every approved create into exactly one provider-call intent or
non-provider disposition, closes every conclusive or ambiguous result into one explicit current
observation or a derived pending-first-observation state, and preserves unresolved intents as
ambiguous attempted positions. Provider intents,
results, dispositions, and observations use canonical plan order. Preflight outcomes must reproduce
the planned provider identity and exact Asset version; created provider identities are unique per
resource kind. An intent may be recorded only after every read dependency passes and every create
dependency is exactly observed in synchronized state. Its record, result, and observation times
cannot predate the corresponding dependency/intent/result or observation completion.
Its accounting is recomputed from exact evidence, and status is then derived by one deterministic
precedence function: queued, in-flight, and unresolved observation states remain nonterminal, while
a terminal observation conflict outranks mixed provider failure. Callers cannot select a more
favorable status while contradictory or unresolved evidence exists.
- We accept a future job union that is not yet part of `JobPayload` in exchange for making it
  impossible for the current worker to claim an unsupported creation job.
- We accept a separate immutable authorization receipt and gate digest in exchange for making the
  future queue message a fenced wake-up pointer rather than a grant of authority. The compound
  verifier reloads and joins plan, receipt, job, generation, expiry, current execution evidence, and
  the prospective write-ahead intent before provider I/O. It refuses an already-claimed node or an
  unsatisfied dependency, and rejects prior evidence outside the receipt's authority window or
  ahead of the verifier's clock; independently parseable artifacts do not establish authority.
  Persistence must atomically enforce uniqueness for `(executionId, nodeId)` when it commits that
  verified intent.
  Expiry refuses new dispatch, while a bound observation job may continue afterward so ambiguity
  cannot be abandoned.
- These functions verify artifact cohesion; they are deliberately not a live-write authority gate.
  Before activation, the DB/worker slice must use the database clock and one transaction to verify
  the current environment write gate, profile allowlist, active/unrevoked authorization, exact
  execution generation, and owned lease, then commit the unique intent. Only that transaction's
  winner may invoke Amazon, and every refused path must prove zero provider calls.
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
- Which fresh Store read resolves an approved page ID to Amazon's required canonical landing-page
  URL without introducing an unapproved execution-time substitute?
- Which Sponsored Display on-Amazon product-ad shape and response-correlation guarantee is
  authoritative?
- Which SB moderation states are terminal, and which read endpoint proves delivery readiness?

These questions block adapters or live execution, not the provider-neutral graph.

## Next implementation step

Implement verified provider reads and dialect-specific adapters without changing the current queue
union. Persistence, worker execution, web approval and deployment remain later serialized packages.
