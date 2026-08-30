# WP-124 — Multi-product campaign creation architecture

## Outcome

Define the contract and delivery sequence for operator-approved Sponsored Products, Sponsored
Brands, Sponsored Brands Video, and Sponsored Display creation. This package is specification
only. It does not add a write path, migration, credential access, deployment, or Amazon call.

The plan extends the guarded write contract in `AGENTS.md`: OpenSpell freezes an exact resource
graph, shows its irreversible create count, obtains a separate approval, and lets only the worker
dispatch the graph. New resources start paused wherever the provider supports it. Campaign
creation has no delete rollback; pause or archive is a separate reviewed change.

## Verified baseline

| Product | Current repository support | Missing operator path |
|---|---|---|
| Sponsored Products | Typed legacy create clients exist for campaigns, ad groups, product ads, keywords, targets, and negatives. The guided builder produces a preview and export. | Authoritative shared creation contract, persisted plan, worker executor, approval/apply UI, observation, and live proof. |
| Sponsored Brands Collections | Campaign and ad-group reads plus narrow creative seams. | Eligibility, brand and Store reads; complete campaign/ad-group/target/ad adapters; product and asset selection; executor and UI. |
| Sponsored Brands Store Spotlight | No creation implementation. | Accessible Store/page checks, exactly three eligible Store-page cards, logo Asset ID/version, format-specific ad adapter, executor and UI. |
| Sponsored Brands Video | Read-only observed ad-to-Asset-ID ingestion exists. | Current Asset Library integration, exact video Asset ID/version selection, complete parent campaign graph, format-specific ad creation, moderation observation, executor and UI. |
| Sponsored Display | Campaign and ad-group reads exist. | Authoritative product-ad/target/creative contracts, observation reads, adapters, executor and UI. Multi-row creation stays blocked until response correlation is proven. |

“Amazon publishes a contract” and “OpenSpell has verified a live end-to-end path” are separate
states. A client method or fixture is not a shipped operator capability.

## Current Asset Library boundary

Amazon's current documented asset lifecycle is:

1. request an upload through `POST /assets/upload`;
2. upload bytes to the returned presigned URL;
3. register the upload through `POST /assets/register`;
4. search or read the registered asset through `/assets/search` or `GET /assets`.

The repository's older Sponsored Brands media seam assumes different media and creative
endpoints. It must not be treated as the production Asset Library until it is replaced or verified
against an exact current contract. Campaign creation v1 selects an existing registered asset by
Amazon Asset ID and version. Asset preparation is a separate plan so upload failure or moderation
cannot silently mutate the campaign graph.

## Authoritative immutable plan

Add one cross-package contract in `packages/shared`; dependent packages import it rather than
creating local equivalents. A `CampaignCreationPlan` contains:

- schema version, plan ID, organization ID, profile ID, marketplace ID, ad product, API dialect,
  and generated/frozen/expiry times;
- an ordered set of typed dependency nodes;
- exact read-check and irreversible-create counts, reconciled by node kind;
- a canonical SHA-256 fingerprint covering the complete approval envelope and semantic graph;
- an explicit acknowledgement that creates have no rollback and that pause/archive is a separate
  reviewed action.

The node union covers eligibility checks, existing-asset checks, campaign creation, ad-group
creation, targeting, ad creation, and creative creation. Each node records a unique ID, product,
dependencies, semantic payload, fingerprint, effect, and rollback declaration.

A reference to a parent is either an existing Amazon ID or a prior plan node. Provider-assigned IDs
never mutate the frozen plan; the worker resolves them from append-only execution evidence.

Plan validation must prove:

- node IDs are unique, every dependency exists, and the graph is acyclic;
- parent references also appear as explicit dependencies;
- dependencies never cross profile, ad product, or API dialect;
- every create declares that rollback is unavailable;
- declared counts exactly reconcile with the graph;
- plan and node fingerprints recompute from canonical data;
- deterministic topological order is stable across replays.

The plan hash binds the schema version, plan ID, organization, profile, marketplace, ad product,
API dialect, generated/frozen/expiry times, deterministic ordered node fingerprints, exact counts,
and the no-rollback acknowledgement. Every node hash binds its node ID, product, dialect, sorted
dependencies, effect, rollback declaration, and schema-parsed semantic payload. Canonical
serialization uses fixed object-key order and JSON's normalized finite-number representation;
unordered identity sets are deduplicated and lexically sorted, while arrays whose order is
operator-visible or provider-semantic, such as Store cards, retain their declared order. An
approval binds the plan ID, exact plan hash, organization, profile, product, dialect, schema,
expiry, counts, and no-rollback acknowledgement. Changing any one requires a new freeze and
approval.

## Execution evidence

Provider results live outside the immutable plan. Each result records the plan/node/attempt,
provider call identity, node fingerprint, request position where supported, outcome, provider
entity ID, sanitized response evidence, and timing.

Operator approval, provider execution, observation, moderation, and delivery are separate
dimensions. `operatorApproved` only means the operator approved the exact frozen create count; it
never describes Amazon creative moderation.

During execution the create counts obey:

- `operatorApproved = pendingDispatch + attempted + refusedAtExecution + blockedByDependency`;
- `attempted = succeeded + failed + ambiguous`;
- `succeeded + ambiguous = observed + pendingObservation + observationConflict` once provider
  result classification is complete.

Read-check nodes have their own requested/passed/refused/failed counts and never inflate the
irreversible-create count. HTTP request counts also never stand in for resource counts. A failed or
ambiguous parent moves every unattempted descendant into `blockedByDependency`; it does not leave
those nodes silently pending.

Batch states distinguish in-progress work from terminal `succeeded`, `partial_failed`,
`ambiguous`, `refused`, and `blocked` outcomes. A batch is successful only when every provider
success is observed in a fresh entity sync and no failed, ambiguous, refused, blocked, pending, or
observation-conflict node remains. Creative moderation is separately `not_applicable`, `pending`,
`approved`, or `rejected`, and delivery is separately `unknown`, `not_delivering`, or `delivering`.
Sponsored Brands can therefore be created and observed while still pending moderation, without
being presented as moderation-approved or delivering.

## Product execution order

### Sponsored Products

1. refresh product and marketplace eligibility;
2. create a paused campaign;
3. create a paused ad group;
4. create product ads;
5. create keywords, targets, and negatives;
6. observe returned IDs and resynchronize the mirror.

### Sponsored Brands and Sponsored Brands Video

1. refresh products, accessible brands, Stores/pages, and exact Asset ID/version state;
2. create a paused campaign;
3. create a paused ad group;
4. create targets;
5. create the format-specific ad last, because it starts creative moderation;
6. observe all resources and retain moderation as a separate state.

Format checks include the official product-count and Store-page rules, supported targeting for the
selected format, and exactly one eligible video Asset ID/version where video is required. Preview
URLs and names are display metadata, never asset identity.

### Sponsored Display

1. refresh product and asset eligibility;
2. create a paused campaign;
3. create a paused ad group;
4. create a product ad;
5. create targets;
6. create a custom creative only after exact association semantics are established;
7. observe all resources and resynchronize the mirror.

Sponsored Display creation remains blocked until OpenSpell has the missing observation reads and
an authoritative on-Amazon product-ad contract. Use one resource per provider request until exact,
lossless multi-status response correlation is proven.

## Ambiguous create recovery

- Persist a durable dispatch intent and request fingerprint before network I/O.
- Never retry a create automatically after a timeout, lost connection, ambiguous server error, or
  provider success followed by local persistence failure.
- Stop descendants of an ambiguous parent.
- Recover through read-only observation. Adopt one exact semantic match, keep observing when none
  exists, and require manual reconciliation when multiple matches exist.
- Names are not unique. Use a stable provider-supported request tag only where the exact contract
  documents it; do not invent an idempotency mechanism.
- Partial creation is never rolled back by deletion. Remediation is a new guarded pause/archive
  plan.

## Serialized implementation packages

The scalar Sponsored Products write gateway must stabilize first. Campaign creation is a separate,
non-reversible action class and must not be forced into an inverse-required mutation union.

1. **Creation contracts** — additive shared schemas, graph validation, counts, fingerprints, and
   job shapes.
2. **Provider reads** — product/brand/Store/Asset eligibility and missing SB/Display observation
   reads in `packages/ads-api`.
3. **Provider create adapters** — product- and dialect-specific wire envelopes and response
   parsers, kept distinct.
4. **Persistence** — immutable plans, approvals, attempts, calls, results, and count evidence in a
   new migration and `packages/db`.
5. **Pure plan projection** — guided inputs and current campaign recipes compile to the shared DAG
   in `packages/campaigns`.
6. **Worker executor** — gates, durable dispatch, dependency resolution, observation, and partial
   state handling.
7. **Web server layer** — freeze, approve, enqueue, and status endpoints without importing the Ads
   API client.
8. **Guided UI** — product and format selection, products, Store/pages, Asset-ID picker and preview,
   naming preview, validation, immutable review, exact confirmation, and progress. Raw JSON remains
   under Advanced.
9. **Evidence** — synthetic integration/E2E first, then separately authorized one-resource live
   checks per ad product.

Packages that touch shared contracts, database/migrations, worker, or common web files are
serialized. No package creates a shadow type to get ahead of the contract.

## Acceptance gates

- Every node and result count reconciles; descendants never run without resolved parents.
- Indexed multi-status responses have unique indices covering the full submitted range, and every
  success has one nonempty, correctly typed, unique Amazon ID.
- Non-indexed responses use request size one until correlation is authoritative.
- No failed, refused, or ambiguous node is hidden by a successful HTTP response.
- The operator confirmation names Amazon and the exact irreversible resource count.
- Web and MCP receive no Amazon credentials; MCP cannot approve its own plan.
- No production migration, deployment, or live creation occurs as part of this package.

## Official source anchors

- [Amazon Ads advanced tools repository](https://github.com/amzn/ads-advanced-tools-docs)
- [Unified campaign-management migration material](https://github.com/amzn/ads-advanced-tools-docs/tree/main/unified-campaign-management-migration-skills)
- [Unified Sponsored Products specification](https://github.com/amzn/ads-advanced-tools-docs/blob/main/unified-campaign-management-migration-skills/api-specs/unified-api-sp.json)
- [Unified Sponsored Brands specification](https://github.com/amzn/ads-advanced-tools-docs/blob/main/unified-campaign-management-migration-skills/api-specs/unified-api-sb.json)
- [Sponsored Brands Collections contract notes](https://github.com/amzn/ads-advanced-tools-docs/blob/main/unified-campaign-management-migration-skills/skills/amazon-ads-sb-collections/SKILL.md)
- [Sponsored Brands video specifications](https://advertising.amazon.com/resources/ad-specs/sponsored-brands-video)
