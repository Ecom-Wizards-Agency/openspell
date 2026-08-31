# WP-182 — Contextual-negative review and immutable export

## Problem

Query Intelligence already generates tenant-scoped, ad-group contextual-negative
proposals and labels the surface as review/export only. The current page still
stops its database read at 250 rows, renders only the first 100, cannot record a
human decision, and cannot reproduce what an operator exported. A later SQP
refresh preserves a decided status while replacing the explanation, category,
and route the operator reviewed.

Stale PR #17 proved useful mechanics for this workflow, but its head predates
current main by 156 commits and its migration is not part of the authoritative
ledger. WP-182 rescues the distinct behavior as a fresh source-only package. It
does not rebase or merge that branch.

## Boundaries

- The workflow accepts, dismisses, or reopens proposals and creates evidence
  files. It never calls Amazon, queues an Amazon action, or claims a negative was
  applied.
- `packages/shared` remains frozen. Its `ContextualNegativeProposal` is the
  proposal contract; review and artifact metadata are database-local types.
- The package does not change taxonomy, proposal generation policy, worker
  dispatch, `ads-api`, generic recommendation apply batches, or Amazon bulk-file
  formatting.
- This package lands migration source and tests only. Applying that migration,
  deploying the dependent web revision, or enabling a hosted workflow requires
  separate authorization for the exact target and revision.

## Caller view

The server page loads the complete marketplace review scope and narrow export
summaries:

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

Every mutation carries a non-empty, bounded, explicit selection. Empty never
means all rows or all filtered rows.

```ts
await decideContextualNegativeProposals(database, {
  orgId,
  profileId,
  marketplaceId,
  proposals: selected.map((row) => ({
    id: row.id,
    expectedFingerprint: row.reviewFingerprint,
  })),
  decision: 'dismissed',
  actorId, // injected from the authenticated RequestActor, never request JSON
  note: 'Keep this query in its current route.',
});

const receipt = await exportAcceptedContextualNegatives(database, {
  orgId,
  profileId,
  marketplaceId,
  proposals: selectedAccepted.map((row) => ({
    id: row.id,
    expectedFingerprint: row.reviewFingerprint,
  })),
  actorId, // injected from the authenticated RequestActor, never request JSON
  note: 'Reviewed offline evidence export.',
});
```

Download callers retrieve stored bytes, not a rerendering of current proposal
rows:

```ts
const artifact = await getContextualNegativeExport(database, {
  orgId,
  exportId: receipt.exportId,
  format: 'csv',
});
```

## Shape

`packages/db/src/queries/contextual-negative-review.ts` owns the deep domain
interface: complete-scope reads, semantic fingerprints, decisions, canonical
locking, audit evidence, artifact creation, exact count checks, and replay.
Routes authenticate, enforce an existing capability, parse bounded input, call
one operation, and map stale state to HTTP 409.

One new table stores each immutable export as exact bytes:

```text
contextual_negative_exports
  id
  org_id, profile_id, marketplace_id
  note, row_count
  json_artifact bytea, json_sha256
  csv_artifact bytea, csv_sha256
  created_by, created_at
```

`created_by` retains the actor identifier as text rather than using an
`ON DELETE SET NULL` foreign key that would rewrite historical evidence. The
table has a composite foreign key to the exact organisation/profile pair,
tenant-read RLS, and service-only writes. Triggers reject updates and ordinary
deletes. A deliberate organisation purge must set the transaction-local
`app.contextual_negative_purge` guard before the existing cascade can delete an
artifact. No application route can set that guard. Database constraints require
a positive row count, non-empty artifacts, and lowercase 64-character SHA-256
values.

The JSON envelope contains the export id, scope, note, database timestamp, row
count, `amazonUpdated: false`, and canonical ordered proposal snapshots. The CSV
contains the same proposal fields and an explicit `amazon_updated=false` value.
SHA-256 values cover the exact stored bytes. The route returns the stored
`bytea` payload without converting it through a JavaScript string. Downloads
verify the requested payload's hash and the JSON row count before returning
either file.

Serialization is frozen as version 1 rather than delegated to incidental object
ordering. Fingerprints hash UTF-8 bytes for the domain prefix
`wizard-ads.contextual-negative-review-fingerprint.v1\n`, followed by one JSON
array in this exact order: organisation id, proposal id, profile id,
marketplace id, campaign id, ad-group id, search term, normalized query,
category, source-group role, match type, reason, and status, followed by LF.
`source_group_role` is the complete operator route; there is no separate route
field. Text is not normalized; `JSON.stringify`
escaping preserves the stored code points. Export rows use the same ordered
fields, sorted by lowercase UUID bytes. JSON uses fixed key order, two-space
indentation, UTF-8, no BOM, and one trailing LF. CSV uses the documented column
order, UTF-8, no BOM, LF record endings, doubled quotes, and one trailing LF.
Golden tests freeze all three encodings and prove that changing any semantic
field changes the fingerprint.

Decision history remains in the existing service-written audit log. The
migration adds guards that reject updates or deletes of `query_negative.*`
events unless the same explicit tenant-purge context is active. Authenticated
roles retain no audit write grant. Each
transition event stores the complete reviewed before-state, target status, and
note, so historical review evidence does not depend on later mutable proposal
columns. Existing non-proposed rows without such an event remain visible as
legacy decisions; the migration does not invent an actor or timestamp.

## Data flow and invariants

1. The route derives `orgId` only from the authenticated actor; request bodies
   never supply it. Every query and lock requires that org plus the exact profile
   and marketplace tuple, and the profile must belong to that org. There is no
   separate marketplace registry, so marketplace isolation is enforced by the
   stored proposal scope rather than inferred from a client label.
2. The page counts rows and review-field bytes, then fetches them in one
   read-only, repeatable-read transaction under a five-second statement timeout.
   A scope above 5,000 rows or 8 MiB returns an explicit `capacity_exceeded`
   state and loads no proposal bodies. Fetch-side count and byte assertions
   repeat the ceilings before return. Within both ceilings, the UI paginates the
   complete set in memory so every row remains reachable without rendering an
   unbounded DOM. Keyset pagination must replace this path before any oversized
   scope can be enabled; silent truncation is never used. Exact status counts
   and rows come from the same snapshot.
3. The browser may select only rows it has rendered. Selection is explicit,
   remains visible in a tray, clears when profile or marketplace changes, and is
   capped at 500 rows per command.
4. A proposal fingerprint is the frozen version-1 encoding described above. It
   covers the complete org/profile/marketplace scope, ids, query fields,
   category, `source_group_role` route, match type, reason, and status. It
   excludes `updated_at`, actor time, and other incidental touch noise.
5. Refresh, decision, reopen, and export take the same transaction-scoped
   advisory lock for each org/profile/marketplace scope. The lock key is the
   64-bit PostgreSQL hash of a fixed domain prefix plus the three scope ids;
   collisions only over-serialize unrelated scopes and cannot weaken mutual
   exclusion. Multi-marketplace refreshes acquire scope keys in bytewise order.
   A five-second local lock timeout fails closed so a request or worker job can
   retry. Explicit proposal rows are then locked in ASCII UUID order. Code
   search shows `persistContextualNegativeProposals` is the only production
   generator writer, and it must acquire this lock before any upsert.
6. Missing, foreign-scope, duplicated, stale, oversized, or terminal selected
   rows fail the whole command. Cross-tenant ids are indistinguishable from
   missing or stale ids.
7. Dismissal requires a note. Export requires a note, owner/admin capability,
   explicit confirmation at the route, and every selected row still being
   accepted. Mixed selections fail; nothing is silently skipped.
8. Exported is terminal. Accept, dismiss, and reopen write one audit row per
   changed proposal. Repeating an already-current decision is counted as
   unchanged and does not fabricate a second transition. Routes derive both org
   and actor ids from `RequestActor`; body fields cannot override either value.
9. A classifier refresh may replace fields only while the stored status is
   `proposed`. Accepted, dismissed, and exported proposal content remains the
   exact reviewed content. The audit event preserves that content even after a
   later reopen and refresh.
10. Export creation gets its id and timestamp from PostgreSQL, builds deterministic
   JSON and CSV bytes from the locked accepted rows, stores one immutable record,
   stamps exactly those proposals exported, writes one export audit event, and
   reads the record back before commit.
11. The export audit payload binds the export id, exact scope, ordered proposal
    ids and pre-export fingerprints, row count, and both exact-byte hashes. This
    makes audit-to-artifact provenance independently checkable without storing a
    second item table.
12. A successful decision proves `offered = matched = updated + unchanged` and
    `updated = audit rows`. A successful export proves
    `offered = matched = accepted = stamped = stored JSON rows = row_count`.
13. CSV cells beginning with `=`, `+`, `-`, or `@` after whitespace, control, or
    Unicode formatting characters are forced to literal text. JSON preserves the
    authoritative text. Creation and every download run a strict CSV record
    counter that understands quoted CR/LF and assert one header plus exactly
    `row_count` records; JSON is parsed and checked against the same count.
14. No module in this flow imports `ads-api`, writes an Amazon entity, creates an
    apply batch, or reports Amazon-applied state.

## Web authorization

- Analysts, admins, and owners may accept, dismiss, and reopen through the
  existing `editTargets` capability.
- Only admins and owners may create artifacts through `exportBatches`.
- Authenticated tenant members may download artifacts in their active org.
- Direct authenticated inserts, updates, and deletes on proposal or artifact
  storage are revoked. `orgId` always comes from the authenticated actor. The
  service-backed, capability-checked routes are the only review mutation
  surface.
- Request JSON cannot provide `orgId` or `actorId`; both come from the active
  `RequestActor`. Contextual-negative audit rows are service-only and guarded
  against update/delete outside the explicit tenant-purge transaction.

The UI uses compact status pages rather than the stale branch's four large
lanes. There is no implicit “export every accepted row” action and no invisible
“select all filtered” behavior. Every success message and download response
states that Amazon was not updated.

## Architecture synthesis

Three independent candidates were compared against current main:

1. A single immutable artifact row with audit-backed decisions.
2. The stale branch's normalized export header/item ledger.
3. A revision/event/command ledger with six new tables and stored renderer
   versions.

The first design is selected. It retains explicit stale-state checks, canonical
locking, complete counts, frozen reviewed content, immutable replay, capability
separation, and CSV hardening while removing nullable decision backfills and a
second artifact table. Exact stored CSV and JSON bytes strengthen replay beyond
the old render-on-download design.

The normalized two-table design remains valid if later reporting needs to query
individual historical export items. No current caller does. The revision/event
design handles evidence drift and retry idempotency comprehensively, but adds
six tables and a new event model before this internal review workflow has usage
evidence. That is not justified by the present rescue.

Server-side keyset pagination was also evaluated. It gives the best asymptotic
queue behavior but adds a read API, cursor/filter contract, cross-page state,
and count queries. WP-182 instead removes the current silent 250/100-row loss,
keeps the DOM bounded, and fails closed at the explicit 5,000-row, 8-MiB, or
five-second boundary. Keyset pagination is mandatory before an oversized scope
can be enabled; silent truncation is never an acceptable fallback.

## Files and ownership

- this work-package brief
- one new current-dated migration under `supabase/migrations/`
- `supabase/tests/tenant-fixture.sql`
- `packages/db/src/schema/operator-intelligence.ts`
- `packages/db/src/queries/contextual-negative-review.ts` and tests
- `packages/db/src/queries/sqp.ts` and focused refresh tests
- `packages/db/src/index.ts` and `packages/db/src/migrations.test.ts`
- Query Intelligence page, review component, local CSS, routes, and tests under
  `apps/web`

No `packages/shared`, `packages/core`, `packages/ads-api`, `apps/worker`, or
generic apply-ledger file changes.

## Acceptance evidence

- A 302-row synthetic scope loads with exact status counts and no 250-row loss;
  5,001 rows, more than 8 MiB of review fields, and a forced query timeout each
  return the explicit capacity state without loading proposal bodies.
- The component can reach every row while rendering only one compact page at a
  time; profile/marketplace changes clear selection.
- Disposable-PostgreSQL tests prove tenant/profile isolation, direct-write
  denial, mismatched org/profile/marketplace refusal, semantic stale conflicts,
  canonical concurrent locking, all-or-nothing transitions, terminal exports,
  audit linkage, authenticated and ordinary-service audit tampering refusal,
  ordinary-delete refusal, guarded tenant purge, artifact immutability,
  exact-byte hash replay, strict CSV/JSON row counts, and preservation across
  refresh.
- Route tests prove the role matrix, explicit confirmation, non-empty and
  bounded selections, ignored body-supplied org/actor ids, 409 reload guidance,
  tenant-hidden downloads, and `amazonUpdated: false`.
- Pure artifact tests cover every fingerprint field, frozen UTF-8 encodings,
  commas, quotes, line breaks, Unicode, CSV formula prefixes, deterministic
  UUID order, exact JSON bytes, hashes, and row counts.
- Focused DB/web suites, production web build, `pnpm check`, and hygiene pass on
  the exact source revision.

## Rollout gates

1. Prove the new migration on a fresh disposable database and a disposable copy
   representing existing proposal statuses. Reconcile row counts before and
   after.
2. Reconcile the authorized hosted target and migration ledger read-only.
3. Verify that the currently deployed web revision performs no direct proposal
   mutation and remains read-compatible after grant revocation. The migration
   creates additive storage first and revokes authenticated proposal writes last
   in one transaction.
4. Obtain separate authorization for the exact migration and target.
5. Apply it attended and verify columns, table, update/delete guards, grants,
   RLS, composite scope constraints, indexes, and proposal counts.
6. Deploy the exact dependent web revision only after the schema is ready.
7. Exercise one bounded, explicitly authorized tenant/profile scope and verify
   decision counts, artifact hashes, audit evidence, and the absence of Amazon
   calls before broader rollout.

## Open risks

- Full-scope loading is confined to the documented row, byte, and time ceilings.
  Queue size and response latency must be captured before broad rollout; an
  oversized scope stays unavailable until keyset pagination lands.
- JSON and CSV are evidence artifacts, not an Amazon Bulk Operations workbook.
  Bulk-sheet generation remains a separate future package.
- Hosted migration and existing proposal status truth are unverified in this
  runtime because no authenticated 1Password service-account session is
  available. WP-182 performs no hosted action.

## Next implementation step

Add the current-dated migration and DB-local module, prove the storage and
concurrency invariants against disposable PostgreSQL, then wire the bounded UI
and thin routes. Scrap and re-sketch if implementation evidence shows that one
artifact row cannot preserve exact replay or that complete-scope loading exceeds
the release budget.
