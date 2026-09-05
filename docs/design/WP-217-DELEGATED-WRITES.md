# Bounded MCP writes and durable history

## Problem

MCP must submit keyword bid changes without a browser confirmation for each batch, within a
separately operator-issued delegation. The SP ledger already owns execution, observations and
inverse history. Its human confirmation and recommendation provenance must retain their meaning.
Grounding used the current HTTP/key, application, SQL reservation and Time Machine paths at
`2ad012e`, and the source rationale in `WP-214-APPLICATION-ARCHITECTURE.md` at `5aa18d8`.

## Usage

```ts
// The HTTP authenticator supplies the key context; inputs cannot name an actor.
const preview = await previewMcpBidChanges(db, credential, {
  requestId, profileId,
  source: { kind: 'keyword_proposals', note, rows: [
    { keywordId, expectedBid: '0.8', requestedBid: '0.9' },
  ] },
});
const admission = await applyMcpBidChanges(db, credential, {
  requestId: applyRequestId, profileId, planId: preview.preview.plan.id,
  planFingerprint: preview.preview.plan.fingerprint,
});
// This also recovers a lost apply response before executionId was received.
const status = await readMcpWriteStatus(db, credential, {
  profileId, lookup: { kind: 'apply_request', requestId: applyRequestId },
});
const inverse = await previewMcpBidChanges(db, credential, {
  requestId: inverseRequestId, profileId,
  source: { kind: 'inverse', original: admission.operation },
});
// Applying the inverse is a separate call with fresh limits and budget checks.
```

The source union also accepts an existing `apply_batch`. MCP tools expose these three domain
operations through authenticated Streamable HTTP. There is no new separate REST service.
Operator issuance stays in the web server and is never an MCP tool.

## Shape and synthesis

Three independent candidates compared a separate MCP facade, an authority-aware shared
application kernel, and receipt models with or without legacy common approver fields.
The separate facade is the base: it hides staging, permission checks, replay, audit and enqueue
behind three calls while preserving working UI orchestration. The shared-kernel alternative
would relocate both UI and MCP orchestration and introduce authority ports/internal insertion
helpers; its larger refactor provides little immediate benefit. Do not create a second executor.

Adopt the database candidate's atomic admission and immutable admission charges, and the
history candidate's separate version, request-ID recovery and preserved history after revocation.
Keep `approvedBy`/`approvedAt` as common receipt fields for compatibility with the existing
ledger, but define them explicitly for delegated receipts as issuer and admission time. A v2
receipt's mode and delegation snapshot determine its actor; UI copy must never imply that the
issuer clicked that batch. An alternative with `authorizedAt` and no common approver field
makes the distinction stronger in naming but forces unrelated ledger consumers to adapt. The
explicit version/mode, human-only input and receipt-derived actor enforce it without that churn.

`ApproveSpWritePlan` remains human/bounded-test only. The old receipt object, schema version
and bytes remain intact. Add a strict delegated v2 receipt and a parser union. The delegated
receipt contains its full immutable delegation, request identity, exact plan binding, MCP gate
version and UTC admission reservation. Human receipt verification rejects the delegated branch;
a separate pure verifier checks its fingerprints, exact scope, caps and receipt agreement.

Delegation is immutable and one per key. It records key ID, label snapshot, org, owning issuer,
version, issue/expiry times, explicit sorted profiles and profile currencies, keyword-bid action,
per-call row maximum, per-UTC-day rows, absolute delta by currency and relative delta ratio.
Changes require a newly issued key. Existing keys cannot gain write authority in place.
The issuer must still be an owner/admin at admission and provider reservation.

Absolute delta is `abs(new - old) <= currency limit`; relative delta is
`abs(new - old) <= old * ratio`, with exact decimal arithmetic. Both values must fit the keyword
mirror without rounding, and zero/no-op values refuse. The limits apply to the whole plan,
not each provider chunk. Every inverse pays a fresh charge and uses the inverse direction's
current value: reversing a large reduction can exceed the same relative cap. A current operator
may instead preview and approve an eligible inverse through the existing UI.

Admission is one SQL transaction: authenticate current authority, check exact saved preview,
lock key, sum UTC-day immutable charges, reserve rows, record request/receipt/audit and enqueue.
An exact retry returns the same operation and charge; a changed request or new identity for an
already admitted plan refuses. No automatic refunds in v1, including failed/refused/ambiguous
execution. Status derives attempted, accepted, observed and refused counts from the SP ledger;
reserved capacity never means applied. An absent request lookup reports unresolved, not proof
that nothing changed. The write transport cannot use the current post-handler read-audit wrapper.

Direct proposals get real `apply_batches` and `apply_rows` with null recommendation lineage,
plus immutable MCP request provenance and a distinct preview-evidence version. The proposal
artifact uses exact decimal strings and its own schema; it does not claim to be an optimizer
export validated by the legacy Python path. Existing recommendation evidence bytes and SQL
assertions remain intact. Null recommendation IDs alone never identify an MCP proposal.
The immutable preview mapping binds each key/request to its exact plan for all source variants.

## Database locks and migration sequence

The current claim wrapper locks org then delivery head before canonical reservation. Retain
that prefix. Admission and reservation then use compatible authority order: org/member share,
existing environment then profile grant, MCP gate, profile/connection, key/delegation, and
existing child/receipt/lease/entity locks. Human and MCP admission share the per-plan approval
advisory lock before global authority. New admission never waits on an existing delivery head;
replay returns stored admission without starting it again. Key revocation does not take gates
or worker custody after locking a key. Last-use updates finish before entering this transaction.
Prove the detailed partial order with forced two-connection tests before accepting implementation.

Put the final delegated check inside canonical provider reservation so direct RPC cannot bypass
it. A closed gate or revoked/expired/downgraded authority produces durable counted refusals for
unattempted rows. Already reserved calls may finish and be observed; no kill switch retracts a
committed intent or an in-flight HTTP request. Reconciliation remains available after revocation.
Sample database UTC day after acquiring locks; crossing midnight does not charge a queued row twice.

The first two additive migrations isolate enum setup and key issuance:
`20260906000000_mcp_write_delegation_mode.sql` adds the mode enum label only;
`20260906010000_mcp_write_delegations.sql` adds immutable operator-issued key authority and
audited revocation. Admission/capacity and distinct proposal evidence follow in separately
declared migrations. Any enum consumer must run after the first migration commits.
Every file uses the five-second lock timeout and advisory DDL lock. None belongs to Claude's original WP-207 window.
No key, grant, enabled gate or runtime worker registration is seeded.

## File scope and delivery

1. Policy/contracts: coordinated `AGENTS.md`; shared `sp-writes.ts`, new `mcp-writes.ts`,
   `time-machine-writes.ts`, the existing recommendation bid schema alias, explicit package exports and associated tests. Foundational
   delegation stays in `sp-writes.ts` to avoid a plan/receipt import cycle. Commit and verify first.
2. Source evidence contracts: `sp-write-preview-evidence.ts` and tests, then application preview
   consumers; preserve old serializer bytes and introduce truthful MCP evidence separately.
3. Persistence: new migrations; DB schema/enums, `queries/mcp-writes.ts`, `mcp-writes.ts`,
   current SP application/worker queries and explicit exports; migration/RLS/boundary tests.
   Inventory exact helper changes before implementation. No provider imports in DB.
4. Transport: `apps/mcp/src/{keys,http,server,config,instructions,audit}.ts`, new write adapter/tests;
   web `src/data/mcp-keys.ts`, `app/api/mcp-keys/**`, shared server JSON helper and issuance fixtures.
   No key-management client components. Worker execution uses existing outbox composition.
5. History: DB Time Machine projection, server timeline labels and synthetic fixtures must derive
   key/issuer from receipt. No live-key join may erase old history. Original and inverse each retain
   their own actor/state and reciprocal operation links.
6. Activation remains separate: worker/config registration, every ordinary sync mirror owner,
   immutable release artifacts and a later scoped runbook. No hosted/Amazon action is authorized
   by this source design. Keep the main replan and audit current throughout.

## Verification obligations

Contracts: preserve old bytes, reject delegated human requests, exact decimal cap boundaries,
invalid/cross-scope receipt bindings, key/issuer actor spoofing, UTC reservation counts and expiry.
Database: direct-RPC refusal; rollback on receipt/audit/outbox failure; concurrent final-budget row;
request replay; revoke/member/gate/grant races at both reservation entrypoints; no duplicate intents.
Transport: actual MCP HTTP discovery and forward/status/inverse with disposable DB and fake provider,
no browser cookies; read keys remain read-only; lost response recovers by request identity.
History: mixed UI/MCP inverses, revoked-key retention, exact sync deduplication, partial failures and
conflicts remain visible. Live proof awaits reviewed source, deployed schema and exact authorization.
