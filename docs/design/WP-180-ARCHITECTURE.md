# WP-180 — inert Sponsored Products provider adapter architecture

Status: synthesized 2026-08-31. This design follows merged WP-179 and does not activate a write
job, worker handler, migration, deployment, or Amazon mutation.

## Problem

WP-179 froze semantic Sponsored Products update plans, observations, write-ahead intents, and
closed provider results. `packages/ads-api` already has low-level SP v3 mutation methods, but those
methods batch, retry 429 responses, replay after an authentication response, expose raw provider
rows, and cannot read the complete replacement-sensitive campaign bidding state. Wrapping them
would violate the new contract. WP-180 needs an opt-in provider boundary that compiles exact wire
rows before an intent is reserved, reads current state without losing context, and makes at most one
mutation attempt after the durable intent exists.

The provider sources captured for this design are Amazon's live
[Sponsored Products v3 OpenAPI document](https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json)
(`sha256:fec774c5ba95e860bd732f1f56d4e5a401ffeb76d500b3a2e059f4eb51c198c3`)
and [marketplace bid and budget limits](https://advertising.amazon.com/API/docs/en-us/concepts/limits)
(`sha256:a96b137e1be218889b76ebf2677ee5a9263df20945be2cc68386d43b9e86693f`),
read on 2026-08-31. The OpenAPI schema restricts create/update campaign budget type to `DAILY`,
while campaign reads can report `DAILY` or legacy `OTHER`.

## Usage (caller's view)

The future worker imports an explicit capability. The existing root client does not gain a method.

```ts
import {
  createSpWriteAdapter,
  type SpWritePreparedCall,
} from '@wizard-ads/ads-api/sp-write-adapter';

const adapter = createSpWriteAdapter(clientOptions, {
  hasher: sha256Hasher,
});

const preparedCalls: readonly SpWritePreparedCall[] = adapter.preparePlan(plan);
```

`preparePlan` validates the plan and deterministically groups its canonical actions by route in
batches of at most 100. It exposes only the route and intent positions. Provider paths, media types,
wire rows, envelopes, decimal numbers, and credentials remain private.

Before the database reserves a provider call, the caller obtains exact current values:

```ts
const observedItems = await adapter.observeCurrent({
  plan,
  call: preparedCalls[0],
}, { signal });

// A later persistence package freezes the observation and atomically commits
// the unique write-ahead intent. The adapter does not own that transaction.
const reservation = await ledger.reserveProviderCall({
  observedItems,
  routeKey: preparedCalls[0].routeKey,
  positions: preparedCalls[0].positions,
});
```

Only the committed winner may request the mutation attempt:

```ts
if (reservation.kind === 'won') {
  const result = await adapter.executeOneAttempt({
    plan,
    intent: reservation.intent,
    resultId: reservation.resultId,
  }, { signal });

  await ledger.appendProviderResult(result);
}
```

`executeOneAttempt` means one provider mutation `fetch` at most. Distributed exactly-once remains
the responsibility of the later unique-intent ledger and worker recovery protocol.

## Shape

### Public interface

Only `@wizard-ads/ads-api/sp-write-adapter` exports the capability:

```ts
export type SpWritePreparedCall = Readonly<{
  routeKey: SpWriteProviderCallIntent['routeKey'];
  positions: SpWriteProviderCallIntent['positions'];
}>;

export type SpWriteAdapterOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

export interface SpWriteAdapter {
  preparePlan(plan: SpWritePlan): readonly SpWritePreparedCall[];

  observeCurrent(
    input: { plan: SpWritePlan; call: SpWritePreparedCall },
    options?: SpWriteAdapterOptions,
  ): Promise<readonly SpWriteObservedAction[]>;

  executeOneAttempt(
    input: {
      plan: SpWritePlan;
      intent: SpWriteProviderCallIntent;
      resultId: string;
    },
    options?: SpWriteAdapterOptions,
  ): Promise<SpWriteProviderResult>;
}

export function createSpWriteAdapter(
  options: AdsApiClientOptions,
  dependencies: {
    hasher: SpWriteSha256Hasher;
    now?: () => number;
  },
): SpWriteAdapter;
```

The interface is small. It hides action grouping, provider vocabulary, money policy,
targeted pagination, strict parsing, ambiguity classification, sanitization, result construction,
and hashing. Callers still see the prepared positions because the database must persist those exact
bindings before I/O. This is the minimum unavoidable seam, per interface-depth.

### Module map

```text
@wizard-ads/ads-api/sp-write-adapter
  packages/ads-api/src/sp-write-adapter.ts
    authenticated observation and one-attempt mutation shell
    validates plan/intent bindings and constructs closed shared results
            |
            v
  packages/ads-api/src/sp-write-codec.ts
    private route table, canonical grouping, money policy, wire compilation,
    action-request fingerprints, strict observations and indexed 207 parser
            |
            v
  packages/ads-api/src/http.ts
    one-attempt transport primitive with deadline, cancellation, response bound,
    and redirect refusal; existing retrying httpRequest keeps its old behavior
```

The codec owns provider knowledge even though compilation, observation parsing, and response
parsing occur at different times. Splitting them by execution stage would leak the same route and
wire decisions across modules, per temporal-decomposition.

### Preparation and request identity

`preparePlan` reuses `verifySpWritePlanFingerprints`, then walks the already canonical plan once.
It groups actions by `routeKey` and chunks each group at 100. A call has one route, 1–100 unique
actions and unique Amazon entity IDs, with request indices exactly `0..n-1`.

Every route codec consumes the whole action variant and emits one canonical provider row. It maps
the shared product-ad identity `productAdId` to provider `adId` explicitly. The private action
request preimage is domain-separated and contains the provider scope, semantic route, action and
entity bindings, and exact canonical wire-row JSON. Hashing that preimage produces the
`actionRequestFingerprint` exposed in the prepared position. Callers never receive the row.

Before mutation, the adapter independently recompiles actions selected by the intent. It verifies:

- plan and action fingerprints;
- plan, route, profile scope, action, entity, index, and position equality;
- every recomputed `actionRequestFingerprint`;
- the shared ordered `requestFingerprint` and intent fingerprint;
- one canonical route group of no more than 100 actions.

No provider call occurs if any binding differs.

### Exact money conversion

A private immutable table keyed by Amazon marketplace ID records expected region, currency, currency
scale, SP bid minimum/maximum, and SP daily-budget minimum/maximum from the captured provider limit
document. An unknown marketplace, region/currency mismatch, unsupported scale, or out-of-range
amount is a compile refusal.

Range and scale checks use decimal strings and integer arithmetic. Only after they pass may a value
be converted to a JavaScript number. The codec then requires the JSON numeric token produced by
that number to equal the canonical input decimal exactly. Rounding, exponent notation, overflow,
and lexical changes are refused. No provider amount is rounded.

Campaign budget rows carry `{ budget, budgetType: 'DAILY' }`, the only update enum in the captured
v3 schema. A targeted campaign observation must itself report `DAILY`; a legacy `OTHER`, missing,
or unknown type is a hard refusal before an intent can be prepared for dispatch.

### Exact current-state reads

Observation uses the route-specific list endpoint and entity-ID filter, follows idempotent
pagination to completion with repeated-token and page-count bounds, and reconciles the returned
identity multiset against the requested positions. Missing, extra, duplicate, malformed, skipped,
or truncated rows fail the whole observation. Transient or archived states never normalize to
`enabled` or `paused`.

For ordinary state and bid actions the codec parses only the fields represented by the shared
observed-action contract. Placement actions use a dedicated strict campaign parser. It preserves:

- bidding strategy;
- top-of-search, product-page, rest-of-search, and Amazon Business placements;
- the complete shopper-cohort and audience-segment collections in canonical order;
- the off-Amazon budget-control strategy.

Unknown keys in replacement-sensitive objects, unknown enums, duplicate placements/cohorts,
invalid percentages, ambiguous omission/null semantics, or values outside the current OpenAPI
shape block the observation. Placement writes serialize the complete requested state; unchanged
strategy, cohorts, off-Amazon control, and unselected placements are never dropped.

### One-attempt transport and ambiguity

The adapter does not call `AdsApiClient.mutateSp` or the retrying `httpRequest` for a mutation.
`http.ts` exposes an internal one-attempt primitive used by both the existing retry loop and the new
adapter. The adapter invokes it once with `redirect: 'error'`, an external cancellation signal, a
finite default deadline, and a bounded response body. The signal covers credential resolution,
fetch, and body consumption. A pre-aborted or expired request cannot issue a late fetch.

Only one structurally complete HTTP 207 response can produce terminal positional claims. The
strict parser requires every index exactly once, ignores response array order, and checks every
success entity ID against the intended entity. Indexed successes become `accepted`; indexed errors
become `authoritative_rejected` with bounded sanitized diagnostics.

Transport loss, cancellation, timeout, redirect, body-read failure, oversized body, malformed JSON,
unexpected success status, non-207 status, 425, 429, 5xx, missing/duplicate/out-of-range indexes,
mixed error envelopes, or wrong entity identity produces `ambiguous` for every intended position.
There is no retry or partial trust. Once a structurally valid committed intent reaches execution,
operational failures return closed positional evidence instead of throwing. Invalid plan or intent
identity is refused before I/O because no trustworthy result can reference it.

The result copies position identity only from the verified intent. It contains no provider body,
headers, request row, URL query, error object, credential, or arbitrary nested provider value.
Diagnostics remove control characters, compact whitespace, redact token-shaped strings, and cap
codes at 160 characters and messages at 512. The adapter sets `completedAt`, calculates the shared
result fingerprint, and returns a value that parses as `SpWriteProviderResult`.

### Inert boundary

WP-180 changes only `packages/ads-api` plus its design and work-package documents. It adds no import
to `apps/worker`, no current `JobPayload` member, no queue registration, no DB table or migration,
no environment/profile grant, no deployment configuration, and no live smoke test. The existing
root barrel does not export the adapter. Capability therefore remains opt-in and unreachable from
the current runtime.

## Synthesis decision

The current-client High candidate supplied the two-module codec/provider split, exact subpath, and
full shared-result construction. The stale-PR High candidate contributed targeted entity filters,
strict body members, cancellation across delayed credentials, and the tests worth rescuing without
cherry-picking the monolithic branch. The Extra-High candidate supplied the strongest mutation
boundary: no retrying client beneath the adapter, domain-separated exact row fingerprints,
all-ambiguous treatment of any non-indexed outcome, bounded bodies, redirect refusal, and recursive
leak tests.

The synthesized design replaces a retry-mode flag with a distinct one-attempt transport primitive.
That makes the safety property structural while avoiding a second authentication and fetch stack.
It also chooses deterministic whole-plan grouping over caller-selected action IDs, hiding route and
chunk policy behind the adapter.

Red-flag screening rejected:

- methods added to `AdsApiClient`, a shallow interface that would make the capability broadly
  reachable and inherit unrelated mutation behavior;
- a facade over current `updateSp*`, which leaks batching, retries, raw results, and incomplete
  placement context;
- public compile/send/parse helpers or a caller-owned HTTP port, which expose provider protocol and
  force callers to coordinate the invariant;
- one `execute(plan)` call before a durable intent, which hides the required write-ahead boundary;
- copying PR #24's DB client, shared types, migration, jobs, or worker activation, which crosses
  ownership and superseded contracts.

No surviving shape is a pass-through method, and the public methods each hide distinct provider
policy rather than mirroring transport stages.

## Tradeoffs accepted

- We accept an explicit prepare/observe/reserve/execute choreography in exchange for preserving the
  durable write-ahead boundary.
- We accept duplicate pure compilation before execution in exchange for making a stale or forged
  prepared description useless.
- We accept conservative all-position ambiguity in exchange for never claiming a provider outcome
  that an indexed response did not prove.
- We accept package-owned, source-dated marketplace policy in exchange for refusing unknown money
  semantics before provider I/O.
- We accept refusing legacy `OTHER` campaign budgets in exchange for never silently changing budget
  type when the update schema permits only `DAILY`.
- We accept a focused internal HTTP refactor in exchange for encoding one mutation attempt as a
  separate callable primitive rather than a mutable retry option.

## Alternatives considered

- Extend the generic client: simpler implementation, but a much wider interface that exposes
  callers to batching, retry and raw-response policy; it hides too little complexity.
- Store provider rows in a DB ticket: execution would be simple, but wire protocol would leak into
  the persistence contract and become stale when Amazon changes schemas.
- Have the adapter own reservation and persistence: a deeper single call, but it reverses package
  dependencies and mixes provider knowledge with tenant/RLS/transaction authority.
- Emit canonical JSON manually from decimals: it can preserve arbitrary decimal tokens, but it
  adds a second JSON serializer. Exact Number-to-token equality plus strict bounds is the smaller
  verifiable shape for the current provider ranges.

## Open questions and risks

- Will Amazon change the live SP v3 enums or marketplace limits before activation? Re-capture and
  compare both provider-source hashes during the later live-readiness package; drift fails closed.
- Does an authorized profile contain a legacy `OTHER` budget? The adapter will refuse it; changing
  that behavior requires new provider evidence and, if type preservation becomes necessary, a
  reviewed shared-contract amendment.
- Do real list responses omit optional empty replacement collections exactly as the OpenAPI permits?
  Synthetic tests cover the documented forms, but activation still requires a non-mutating live
  read fixture reviewed without client data entering Git.
- Can a provider return a valid indexed 207 with a new error envelope member? Version 1 refuses the
  response as ambiguous until the codec and tests are deliberately updated.

## Next implementation step

Implement the private route/money codec and its pure fixtures first, then add the one-attempt
transport shell and fake-provider integration tests without importing the adapter anywhere else.
