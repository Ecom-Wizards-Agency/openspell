# WP-86 — Query Intelligence review and immutable export

## Problem

Query Intelligence already stores review-only contextual negative proposals and
shows them beside weekly SQP evidence. The page currently reads at most 250
proposals, cannot record a human decision, and has no durable export artifact.
Refreshing a generated proposal also preserves its status while replacing the
reason, category, and route that the operator originally reviewed. This package
adds a tenant-scoped decision and export path without changing taxonomy,
scheduling reports, calling Amazon, or turning an export into an Amazon write.

## Usage (caller's view)

The page loads the complete marketplace queue and recent export history:

```ts
const proposals = await listContextualNegativeProposals(database, {
  orgId,
  profileId,
  marketplaceId,
});
const exports = await listContextualNegativeExports(database, {
  orgId,
  profileId,
  marketplaceId,
});
```

An analyst accepts, dismisses with a required note, or re-opens selected rows:

```ts
await decideContextualNegativeProposals(database, {
  orgId,
  profileId,
  marketplaceId,
  proposalIds,
  decision: 'dismissed',
  actorId,
  note: 'Keep this query routed to the launch ad group.',
});
```

An owner or admin confirms an export. One transaction locks the accepted set,
stores exact snapshots, marks exactly those proposals exported, and reconciles
every count before returning download URLs:

```ts
const record = await exportAcceptedContextualNegatives(database, {
  orgId,
  profileId,
  marketplaceId,
  proposalIds: selectedIds,
  actorId,
  note: 'Reviewed ad-group negatives for offline bulk upload.',
});

const artifact = await getContextualNegativeExport(database, {
  orgId,
  exportId: record.exportId,
});
```

CSV and JSON downloads are pure renderings of the immutable stored items.

## Shape

`packages/db/src/queries/contextual-negative-review.ts` owns the complete
decision/export invariant. Shared `ContextualNegativeProposal` remains the
authoritative proposal shape; database records only enrich it with review and
export metadata. The migration adds decision metadata to the proposal row plus
an export header and item ledger. Each item stores the exact search term,
category, optimization-group route, match type, and reason that left Wizard
Ads. Export rows cannot be updated, and application roles receive no direct
write grant to the ledger.

The decision function locks the in-scope rows, refuses terminal exported rows,
requires a dismissal note, changes the status, and writes one audit event per
changed proposal. The export function locks the requested accepted rows,
creates one header, inserts one ordered snapshot per proposal, updates the same
count of proposals, and reads the ledger back before committing. Routes add
capability checks but do not repeat database policy.

This is a deep interface: callers express a decision or export once while the
module hides row locking, tenant scoping, snapshotting, hashing, audit writes,
and count reconciliation. It deliberately exposes only exact counts and the
stored artifact needed by the operator.

## Synthesis decision

The selected design is the dedicated review/export ledger because it keeps the
Query Intelligence domain distinct while providing the strongest audit and
replay guarantees. The smaller web-only SQL candidate was rejected because it
would leak storage and transaction policy into every route. Reusing
`apply_batches` was rejected because those rows model bid/budget state changes
and cannot represent an ad-group negative without weakening their contract.
The selected design borrows the existing recommendation flow's useful split:
record the export once, then render any download format from stored rows.

## Tradeoffs accepted

- We accept two small ledger tables in exchange for reproducible CSV and JSON
  downloads that never re-read mutable proposal data.
- We keep the complete proposal queue in the server response in exchange for
  exact counts and bulk review without the existing 250-row blind spot.
- We keep decision notes in the central append-only audit log in exchange for a
  single agency-wide audit history instead of a last-writer-wins note column.
- We make exported proposals terminal in exchange for an unambiguous record of
  what the operator actually exported.

## Alternatives considered

- Web-owned raw SQL had fewer files but exposed locks, status transitions, audit
  writes, and count reconciliation to HTTP callers, making a shallow interface.
- `apply_batches` hid export storage but forced contextual negatives into a
  bid/budget apply contract that has no safe negative-target representation.

## Open questions and risks

- Production remains unable to use this workflow until the exact migration and
  target are separately authorized.
- Amazon bulk-file formatting is intentionally outside this package; these
  artifacts are reviewed proposal evidence for an operator-controlled next
  step, not a disguised Amazon write.

## Next implementation step

Add the migration and typed database module, prove its transaction and RLS
invariants with synthetic PostgreSQL tests, then wire the thin routes and queue.
