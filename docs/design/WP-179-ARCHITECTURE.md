# WP-179 guarded Sponsored Products write contract rationale

## Problem

OpenSpell needs one cross-package contract for reversible Sponsored Products updates before the
database, worker, and web can implement the guarded Amazon write lifecycle. The current `ApplyRow`
is an export format with open field names and primitive values, so it cannot authorize a provider
request. The Ads client already supports typed SP updates, but its request envelopes and 207 bodies
belong to the HTTP package. PR #24 mixed those concerns with a large migration, active queue jobs,
and worker execution. This package replaces only the contract layer on current main.

The contract must cover the reversible updates that the current SP v3 client can express safely:
campaign budget, campaign state, complete placement bidding, ad-group default bid and state,
keyword bid and state, target bid and state, and product-ad state. Creation remains in WP-125.
Archive, negative-resource deletion, target-expression replacement, and other irreversible or
provider-immutable operations are separate reviewed actions.

## Usage from the caller's view

The preview boundary builds provider-semantic actions, freezes canonical fingerprints, and performs
no I/O:

```ts
import {
  SpWritePlan,
  orderSpWriteActions,
  serializeSpWriteActionFingerprint,
  serializeSpWritePlanFingerprint,
  verifySpWritePlanFingerprints,
} from '@wizard-ads/shared';

const actions = orderSpWriteActions(actionsWithFingerprints);
const plan = SpWritePlan.parse({ ...header, actions, counts, fingerprint });
const verifiedPlan = verifySpWritePlanFingerprints(plan, {
  algorithm: 'sha256',
  digest: sha256,
});
```

Two selected placement changes compile into one campaign action because Amazon replaces the whole
dynamic-bidding object. The operator confirms `plan.counts.logicalChanges`; provider response
accounting uses `plan.counts.providerRows`.

The approval request binds the exact plan, route counts, and confirmation version. It cannot supply
the actor, approval time, gate versions, execution generation, or lease:

```ts
const request = ApproveSpWritePlan.parse(await request.json());
const approved = verifySpWriteApprovalArtifacts(
  verifiedPlan,
  exactInversePlanOrNull,
  request,
  boundedAuthorizationOrNull,
  databaseNow,
  sha256Hasher,
);
```

The database issues the immutable receipt from authenticated facts. A manual receipt authorizes one
plan. A bounded live-test receipt may also bind one separately frozen exact inverse plan. A boolean
"rollback allowed" flag is not sufficient.

The future worker verifies the joined artifacts, reads the exact current provider state, and asks
the write ledger to reserve one call:

```ts
const candidate = verifySpWriteDispatchArtifacts(
  plan,
  receipt,
  job,
  currentEvidence,
  providerObservation,
  proposedIntent,
  databaseNow,
  sha256Hasher,
);

const reservation = await ledger.reserveProviderCall(candidate);
if (reservation.kind !== 'won') return reservation;

const providerResult = await adapter.executeExactlyOnce(reservation.ticket);
await ledger.appendProviderResult(providerResult);
```

`reserveProviderCall` is one future DB-clock transaction. It reloads and locks the current
environment gate, exact profile grant, approval, execution generation, route, and lease, then
inserts the complete unique intent and observation outbox. Only the committed winner receives a
dispatch ticket. Shared artifact verification is not live authority.

Post-write synchronization remains separate from provider acceptance:

```ts
const observation = verifySpWriteObservationArtifacts(
  plan,
  receipt,
  observeJob,
  currentEvidence,
  proposedObservation,
  databaseNow,
  sha256Hasher,
);
```

An accepted 207 position is not successful until a fresh synchronized read reproduces the requested
state. An ambiguous request observed at the requested state remains explicitly
`observed_after_ambiguous` rather than becoming a claimed provider acceptance.

## Shape

### Values and route identity

Executable money uses a canonical decimal string, not JavaScript `number` and not a fixed two-digit
minor-unit assumption:

```ts
type SpCanonicalDecimal = string; // 0, 1, 1.25; no exponent, leading zero, or trailing zero
type SpMoney = { amount: SpCanonicalDecimal; currencyCode: CurrencyCode };
```

The schema allows at most 12 integer and 6 fractional digits. The later Ads adapter validates the
marketplace-specific range and precision, converts to the provider number, and asserts an exact
decimal round trip.

Every plan binds this route:

```ts
type SpWriteProviderScope = {
  amazonProfileId: AmazonId;
  connectionId: Uuid;
  region: Region;
  marketplaceId: AmazonId;
  currencyCode: CurrencyCode;
  apiDialect: 'sp_v3';
};
```

Actions use stable semantic route keys such as `sp.v3.campaigns.update`. Literal paths, media
types, wire envelopes, headers, and response bodies remain private to `packages/ads-api`.

### Typed grouped actions

One action is one future Amazon indexed request position. A plan may contain at most one action for
one route and entity. Its nonempty `changes` object can group compatible logical changes:

```ts
type SpWriteAction =
  | SpCampaignUpdateAction
  | SpAdGroupUpdateAction
  | SpKeywordUpdateAction
  | SpTargetUpdateAction
  | SpProductAdUpdateAction;
```

Each logical change has one exact `expected` and `requested` pair and one provenance key. A forward
plan points to apply rows plus immutable guardrail and provenance snapshot fingerprints. An inverse
plan points to the original execution and action identities. The action and plan serializers bind
the full semantic content, not provider request JSON.

Placement is one grouped campaign change containing complete normalized expected and requested
bidding state:

```ts
type SpCompleteCampaignBiddingState = {
  strategy: BiddingStrategy;
  placements: {
    topOfSearch: number | null;
    productPages: number | null;
    restOfSearch: number | null;
    amazonBusiness: number | null;
  };
  shopperCohorts: readonly SpShopperCohort[];
  offAmazonBudgetControlStrategy: string | null;
};
```

Validation proves that only named placement keys differ. Strategy, shopper cohorts, off-Amazon
settings, and every unselected placement must stay equal. Unknown provider context blocks the
adapter before a plan can freeze; it is never discarded. Every actual placement difference has one
provenance row, and every selected placement row corresponds to a difference.

### Plans and exact inverses

```ts
type SpWritePlan = {
  schemaVersion: 'openspell.sp-write-plan.v1';
  id: Uuid;
  orgId: Uuid;
  profileId: Uuid;
  providerScope: SpWriteProviderScope;
  direction: 'forward' | 'inverse';
  source: SpForwardWriteSource | SpInverseWriteSource;
  generatedAt: IsoInstant;
  frozenAt: IsoInstant;
  expiresAt: IsoInstant;
  actions: readonly SpWriteAction[];
  counts: {
    logicalChanges: number;
    providerRows: number;
    uniqueEntities: number;
    byRoute: Record<SpWriteRouteKey, number>;
  };
  fingerprint: Sha256;
};
```

`inverseValue` does not appear in a forward action. A legal inverse is a second immutable plan.
Each inverse action identifies the original action and swaps every requested and expected value.
`verifySpWriteInversePair` proves exact scope, route, entity, change, provenance, and count pairing.
Manual rollback needs a fresh receipt. A bounded live test may preauthorize only the exact verified
inverse plan fingerprint.

### Bounded live-test authorization

The gitignored authorization schema contains no credentials or account labels. It names exact
provider scopes, entity/action/change keys, per-action bid or placement deltas, plan count caps,
expiry, a one-cycle cadence limit, one active mutation, and mandatory observation-before-inverse
and stop-on-conflict behavior. Its canonical fingerprint is bound into a bounded receipt.

The approval verifier proves the forward plan fits those bounds and joins one exact inverse. The
later DB transaction must still prove the authorization is current and unrevoked. A stored snapshot
records what authorized the decision; it does not keep authority alive after revocation.

### Approval receipts and inactive jobs

The approval request carries an idempotent request ID, plan binding, exact counts, confirmation
version, approval mode, and optional bounded/inverse bindings. The DB-issued receipt additionally
binds authenticated actor and time, receipt/execution/generation IDs, exact route, expiry, current
environment/profile gate versions, and a gate snapshot digest.

Future `sp_write.dispatch` and `sp_write.observe` schemas are exported separately. They stay absent
from `JobType`, `JobPayload`, database enums, queue code, and worker registration until matching
persistence and execution exist. Their payloads are fenced pointers, not grants of authority.

### Intent, results, observations, and accounting

One write-ahead call intent binds the plan, receipt, execution generation, route key, DB-issued
lease identity, fresh provider-observation fingerprint, whole-request digest, and the complete
zero-based request positions with action and per-position request fingerprints. One call contains
one route and at most 100 provider rows.

Every result accounts for every intended position as `accepted`, `authoritative_rejected`, or
`ambiguous`. Missing or duplicated indexes, malformed 207 bodies, transport loss, unclassified 5xx,
and crashes after intent become ambiguity. Once an intent exists, the current contract never
automatically sends that action again. A later write requires a new reviewed plan unless a future
provider contract proves non-application with stronger evidence.

Post-write observations bind the exact intent, request and action fingerprints, source sync job,
route, synchronized value, and DB receipt time. The evidence bundle derives these equations:

```text
approvedRows = pendingDispatch + refusedBeforeDispatch + intentCommitted
intentCommitted = accepted + authoritativeRejected + ambiguous
accepted + ambiguous = observedRequested + observedExpectedAfterAmbiguous
                     + observationConflict + observationMissing + pendingObservation
```

An intent without a result counts as ambiguous. Status and accounting are derived from exact
evidence and cannot be selected by a caller. `succeeded` requires provider acceptance and requested
state observation for every row. Requested state observed after an ambiguous call has its own
truthful status.

### Interface depth

The public capability is small: order/fingerprint a plan, verify approval artifacts, verify a
dispatch candidate, verify result evidence, and verify observation evidence. Those functions hide
canonical ordering, grouping, inverse pairing, cross-artifact identity, retry refusal, count
closure, and status derivation. Provider wire types and storage rows stay out of the contract.

The implementation starts as one `packages/shared/src/sp-writes.ts` module plus focused tests. This
matches the package's existing flat layout and keeps cross-artifact invariants in one place. Split
it by owned concepts only if implementation produces repeated friction; do not split by execution
stage.

## Synthesis decision

Candidate C is the base because it models the full reversible SP update set, groups provider rows
truthfully, uses exact decimal values, and gives every later package one lifecycle contract.
Candidate A contributes the compact single-module boundary, separate exact inverse plans, and the
rule that current `ApplyRow`, `EntityRow`, jobs, DB, worker, and Ads client stay unchanged here.
Candidate B contributes the load-bearing same-transaction reservation invariant, exact route and
gate revision binding, DB-issued approval facts, no retry after intent, ambiguity recovery, and
closed evidence equations.

The stale PR's local `inversePreapproved` boolean, floating-point currency check, partial campaign
mirror, active queue types, worker-memory authority, and queue-protocol migration are rejected. A
generic `{ entity, field, old, new }` engine is also rejected because every downstream caller would
need to reconstruct provider grouping and replacement semantics.

## Tradeoffs accepted

- We accept a larger inert shared contract in exchange for avoiding incompatible lifecycle types in
  the DB, worker, web, and Ads client.
- We accept canonical decimal strings in exchange for exact fingerprints and database comparison.
- We accept unavailable placement previews when complete provider state cannot be read in exchange
  for never erasing sibling bidding settings.
- We accept separate logical-change and provider-row counts in exchange for truthful confirmation
  and 207 accounting.
- We accept a new reviewed plan after any ambiguous intent in exchange for prohibiting duplicate
  Amazon mutations without proof of non-application.
- We accept that pure artifact verifiers cannot establish current authority. The later persistence
  slice must prove the one-transaction gate and unique-intent invariant with concurrency tests.

## Alternatives considered

### Action-only schemas

Small schemas for old/new values hide only field validation. Every dependent package would invent
approval, intent, result, observation, inverse, and count rules. The interface is shallow and was
rejected.

### A generic mutation engine

An open `{ entity, field, old, new }` shape resembles executable `ApplyRow`. It exposes route choice,
compatible-field grouping, placement replacement, and rollback legality to every caller. It was
rejected for information leakage.

### Reusing campaign-creation evidence

WP-125 has strong trust boundaries, but its DAG, irreversible-create effects, provider-ID
dependencies, and no-delete rollback do not fit reversible grouped updates. Reuse the trust pattern,
not the creation data model.

### Rescuing PR #24 wholesale

The branch combines 58 files, active jobs, a 1,045-line migration, queue protocol changes, HTTP
client changes, and worker execution. It also treats process-memory gate checks as current database
authority. Current-main serialized packages hide more complexity with less activation risk.

## Open questions and risks

- Which current profile metadata revision will bind plan currency and marketplace in the DB slice?
- Can the SP campaign read return complete shopper-cohort and off-Amazon state? Placement remains
  unavailable until the adapter can prove that completeness.
- Does Amazon document a mutation response that proves non-application strongly enough for a safe
  same-execution retry? Version 1 assumes no.
- Which durable DB revisions represent the environment gate and exact profile grant? The receipt
  reserves both fields, while the migration must define their storage and revocation behavior.
- Which reversible route classes should receive nonempty production profile grants first? Contract
  support does not imply live enablement.

## Next implementation step

Implement and test the inert `packages/shared/src/sp-writes.ts` contract without registering jobs or
touching persistence, worker, web, migrations, or provider code.
