# Guarded write application and history

## Problem

The SP ledger and provider adapter exist, but the UI and MCP cannot yet submit an Amazon
write through them. Both callers need one application boundary for immutable previews,
admission, status and inverses. Time Machine must show the same evidence, including pending
and failed changes and the key/user responsible for delegated writes.

The existing ledger owns execution truth. The application must preserve its claim custody,
single-use dispatch tickets, exact response accounting and immutable observations. Claude
owns D1/WP-207, D2/WP-216 and client presentation. This source branch is stacked on the reviewed
handoff at `0d764c4`; it does not register a worker or activate a hosted environment.

## Usage

```ts
// The session adapter supplies actor; request JSON cannot supply its user/org identity.
import {
  previewSpWrite, approveAndQueueSpWrite, readSpWriteOperation,
  previewSpWriteInverse,
} from '@wizard-ads/db/sp-write-application';

const preview = await previewSpWrite(database, actor, {
  requestId, profileId, applyBatchId,
});
// A separate request follows the exact-count Amazon confirmation in the UI.
const admission = await approveAndQueueSpWrite(database, actor, {
  profileId, approval: confirmedPlan,
});
const status = await readSpWriteOperation(database, actor, {
  profileId, ...admission.operation,
});
const inverse = await previewSpWriteInverse(database, actor, {
  requestId: inverseRequestId, profileId, original: status.operation,
});
// Inverse preview also requires a separate approval.
```

WP-217 adds a distinct `admitDelegatedSpWrite` operation. The verified MCP key context comes
from HTTP authentication. It binds an existing preview to an operator-issued delegation in
one database transaction. It does not impersonate the human confirmation above. MCP tool
discovery and calls use the existing authenticated Streamable HTTP server.

```ts
// Worker-only, inert until the separate activation slice registers it.
const loop = createSpWriteOutboxLoop({ database, providers, policy });
const counts = await loop.tick({ signal });
// Tests reconcile every claimed item as completed, deferred or unresolved.
await loop.stop();
```

## Shape and ownership

`packages/shared/src/sp-write-application.ts` defines strict request/response schemas. It
reuses the existing plan, binding, receipt and execution snapshot. An operation is identified
by **both `executionId` and `planId`**: native inverse approval reuses the original execution
cycle. `startExecution` returns an outbox id, while the execution id comes from the receipt.

| Module | Responsibility |
|---|---|
| Shared application contract and tests; explicit package export | Human actor context, preview commands, operation identity, admission outcomes and evidence DTOs |
| `packages/db/src/sp-write-application.ts` and package export | Small application surface for both transports; no provider dependency |
| `queries/sp-write-plan-builder.ts` and tests | Scoped source snapshots, exact decimals, canonical plan creation and replay |
| `queries/authenticated-actor.ts` and tests | One transaction with validated identity and local authenticated role/claims |
| `queries/sp-write-approval.ts` and tests | Human approval, exact request replay and recoverable execution admission |
| `queries/sp-write-operation-read.ts` and tests | Tenant-bound verified evidence, original/inverse links and status |
| `queries/sp-write-inverse-preview.ts` and application tests | Complete observed source, current mirror comparison, exact inverse and replay |
| `apps/web/src/writes/**`, `app/api/sp-writes/**` | Session authentication, HTTP validation and response adaptation |
| Apply preview server loader and Time Machine server loader | Data wiring and synthetic props for Claude's client work |
| `apps/worker/src/sp-write-outbox/**` | One-attempt dispatch, bounded observation, recovery and shutdown |

The existing persistence facade remains on its explicit subpath and keeps its root SQL tag
requirement. No caller casts a transaction into that facade. Application operations hide
source joins, replay, identity recovery and evidence interpretation; transports do not sequence
low-level ledger methods. The worker alone owns provider orchestration.

The HTTP slice adds `applyAmazonChanges` to `apps/web/src/auth/roles.ts` and its tests for the
existing owner/admin policy. It uses the shared session/assurance gate, strict shared requests,
fixed-origin POST checks and bounded JSON reads. The four paths are `/api/sp-writes/preview`,
`approve`, `inverse-preview` (POST) and `status` (GET). Errors expose controlled codes and
preserve unknown admission outcomes; responses disable caching. No Amazon client or MCP server
is loaded by these routes. Client confirmation design remains with Claude.
The HTTP proof uses the real request database (without Drizzle's serializer overrides).
It also covers the two serialized-JSON parameters in `queries/sp-write-persistence.ts`;
bind their text before casting to JSONB so both database client configurations preserve the
same proof arrays. Apply the same rule to preview persistence and inverse reads.
`20260905020000_sp_write_application_entry.sql` gives HTTP admission the versioned
`app.approve_sp_write_preview_v1` entry. Missing application SQL fails before receipt recovery
or enqueue, even when an older database has an existing approval. This prevents an older
same-name approval implementation from substituting for the new source checks.
Recovery calls that same versioned, idempotent entry with the same confirmation identity. It
does not reconstruct permission through unversioned receipt reads: a connection failure can
hide the older database's missing-function error. Definite refusals are not retried internally.

### Preview and human approval

Implementation review found that export rows remain editable and the SP plan retains only
guardrail/provenance digests. Add a contract/persistence slice before the builder is accepted:
`packages/shared/src/sp-write-preview-evidence.ts`, its explicit export and tests;
`supabase/migrations/20260905000000_sp_write_preview_evidence.sql`; the matching DB schema,
query and PostgreSQL tests; and synthetic tenant-fixture coverage. This migration identifier
was unused when declared. Update only the exact inert-migration allowances and latest-migration
assertion in the two persistence blast tests and migration suite.

The slice stores immutable source and policy preimages alongside the plan in one transaction.
It binds the actual export artifact, ordered source rows, current grant/version, recommendation
run strategy, goal and group snapshot. Missing required source evidence refuses. Reconstruct
and verify the legacy export digest; a syntax-valid hash is insufficient. Monetary values for
the plan still come from SQL text. Compatibility serialization may reproduce the old numeric
export representation only after proving a lossless decimal text round trip; it never supplies
the plan's money. Exact decimal strings support values that the old numeric representation
cannot preserve. Approval requires this evidence and rejects a changed source revision.

Use the preview request UUID as the stable plan UUID. Replays return the recorded plan only
when tenant, profile and source identity match. On concurrent insertion, reload the committed
winner and verify that binding. Never rebuild a preview with different timestamps under an
existing identity. Read stored JSON scalar values and mirror numeric values as SQL text;
canonicalize decimal strings without converting through JavaScript numbers.

Count every source row. Refuse empty, oversized, unsupported or incomplete batches rather than
dropping rows. The initial builder supports SP keyword bid changes. Provider scope comes from
the current profile grant and must agree with the mirrored profile/connection. The grant owns
the marketplace binding absent from `ad_profiles`. Guardrail and provenance fingerprints derive
from actual frozen source, strategy and grant facts, with no constant or caller-provided hash.

Human approval runs the existing authenticated RPC under transaction-local claims and role.
The additive `20260905010000_sp_write_preview_approval.sql` migration wraps that RPC and
revokes direct access to its former implementation. This makes source revalidation, actor-bound
request replay and one admission per immutable plan database rules, including direct RPC callers.
It reuses the preview migration's private source checker; inverse approval verifies the complete
source cycle, exact inverse pair and current keyword mirror. No worker is registered by this slice.
The WP-188 facade integration fixtures predate source exports and mirrored entities. Pin their
database at the immediately preceding migration; keep every lifecycle/custody assertion. Add the
current source-backed approval and execution proof in `queries/sp-write-approval.test.ts`, using
`testing/sp-write-synthetic-execution.ts` for fake provider evidence through the real ledger.
Serialize admission per plan and recover the exact prior approval request; a new request must
not open another execution for an already approved immutable plan. Approval and enqueue are
two durable stages in WP-214. Return `approved_pending_start` if approval is known but enqueue
is not yet established. Retry recovers the same receipt. Once an execution request exists,
return its identity even if the approval has since expired; this is a read of earlier admission.

### Worker and recovery

The inert worker source slice owns `apps/worker/src/sp-write-outbox/{artifacts,providers,loop}.ts`
and their tests. Add `packages/db/src/sp-write-worker.ts` as an explicit subpath over
`queries/sp-write-worker.ts`: read candidate plans, current dispatch authority, database time
and deadline-qualified recovery results. These reads return existing shared artifacts and
primitive values; they expose no custody tokens and do not grant execution authority. Test
the real loop against disposable PostgreSQL with a fake provider. Declare exact source imports
in the two blast tests while retaining their worker-entrypoint and deployment prohibitions.

Candidate preparation resolves refresh credentials before claiming. Provider observation warms
the access token before reservation. Use a bounded observation read, and calculate the dispatch
budget conservatively from a monotonic timestamp taken before the reservation round trip.
Current dispatch gates are checked before any provider access and again by SQL reservation.
Closed gates leave an undispatched wake recoverable; no fabricated provider observation is used
to manufacture a terminal refusal. Recovery remains available when dispatch is disabled.

The ledger can refuse only the stale rows of a provider call. The original adapter compiled
fixed whole-plan chunks, which would strand the remaining rows after that refusal. Declare
`packages/ads-api/src/sp-write-{adapter,codec}.ts` and their existing tests for exact action
selection: verify the entire immutable plan, then compile a canonical, unique subset of its
unchanged actions. Observation and execution must reproduce those exact selected positions.
The worker selects only unresolved action IDs from verified ledger evidence. SQL still prevents
any resolved row from obtaining a second intent. No plan fingerprint or approved value changes.

Claim one wake per tick and keep the loop single-flight. Profile allowlisting and runtime
enablement fail closed. Warm provider credentials before reservation; the global claim API
does not select by profile, so an unowned claim is deferred without provider access. Only a
committed `dispatch_once` ticket permits the adapter's single mutation attempt. Respect its
database-issued deadline using a monotonic elapsed budget anchored to readback. Unknown
reservation outcomes never authorize an attempt or automatic retry.

After an attempt, persist result and observe accepted/ambiguous positions. Recovery waits for
both provider-attempt and dispatch-lease deadlines and records an ambiguous result through the
existing ledger. A failed read is not a missing entity. Since observations are immutable, defer
transient reads within a declared observation window before recording terminal conflict/missing.
Dispatch disablement must still permit reconciliation of already attempted work.

### Time Machine and inverse persistence slice

Declare `packages/shared/src/time-machine-writes.ts` and its tests, a write projection query,
`queries/time-machine.ts` and tests, and server data/cursor wiring. Native history references
operation/action/change identities and reads ledger values/status; it adds no mutable status
table. A native forward entry carries its apply-row provenance instead of also emitting a
duplicate plain export entry. Old export history remains available.

The existing schema cannot explicitly link an inverse observation to an entity diff. Before
dependent history/sync code, add and test a narrow migration for tenant-bound observation to
mirror evidence links, with its exact filename declared after checking migration identity.
A scoped fact writer validates the observation, locks current mirror state, records the actual
diff and its observation link, and promotes the observed value atomically. Replays reconcile
counts. Matching bid values or timestamps alone never justify suppressing an external event.
Provider observation and mirror resynchronization are separate facts in the status contract.

Each inverse has its own plan/approval and history entry linked to the original operation.
Preserve the current full-plan inverse contract: all forward actions must be observed at their
requested values and still match current state. Partial, ambiguous or conflicting plans remain
visible and cannot use a subset inverse. A failed inverse never marks the original restored.
An ambiguous provider response whose every requested value was subsequently observed is eligible:
the existing `observed_after_ambiguous` state provides the observation evidence required by the
shared dispatch verifier. Unresolved ambiguous rows remain ineligible.

### Delegated admission slice

WP-217 first lands the coordinated policy/shared authorization amendment, then a new additive
migration with immutable key ownership, versioned bounds, UTC budget-day reservations and
atomic admission/audit/enqueue. Do not edit previously applied migrations or promote read keys.
Use one SQL admission capability for current key/membership/profile/action/expiry checks, exact
plan binding, capacity reservation, receipt, durable audit and outbox insertion. Exact retries
return the previous operation and reserve no additional budget. Conflicting request reuse
refuses. Attempted or ambiguous work gets no automatic refund.

Recheck the same database-backed delegation and kill switch at provider reservation. Revocation
blocks undispatched work but cannot erase history or prevent attempted-call reconciliation.
MCP mutations bypass the old handler-then-audit wrapper: a lost response reports an operation
identity or an explicit unknown outcome recoverable by request id, never an assurance of no change.

## Synthesis decision

Use candidate A's small application boundary over the existing facade. Adopt candidate C's
operation/action history projection and explicit observation linkage. Keep database-owned atomic
delegated admission from candidate B. The manual path retains the existing two-stage receipt
and enqueue semantics; the delegated path requires a single transaction. A second command bus,
execution ledger or mutable history status would duplicate authority and is rejected.

## Tradeoffs and verification

We accept recoverable manual admission in exchange for preserving the current authority boundary.
We accept full-plan inverse eligibility and one focused history-link migration in exchange for
exact reversion and attribution. We retain the verified evidence loader before considering query
optimizations; callers must not receive accounting and action values from different snapshots.

Test contracts first, then decimal/source replay and actor isolation against disposable PostgreSQL
17. Exercise authenticated HTTP and MCP lifecycles with a fake provider, including concurrent
admission, wrong counts, stale state, revoked scope, lost responses, partial results, inverse
links and exact history counts. Source-phase blast tests allow only declared inert consumers;
worker registration, immutable deployment scripts and closed-by-default configuration belong to
the separate activation slice. Hosted migration/deployment and live proof remain gated by their
exact authorization and Claude-owned prerequisites.

The architecture checkpoint is satisfied by the user's explicit request to continue building
autonomously. Implementation starts with shared application contracts and the authenticated actor
transaction helper. Revisit the design if repeated workarounds undermine these boundaries.
