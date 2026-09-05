# Proposal revisions before Amazon approval

## Problem

Claude's table controls need an audited edit that survives export and refuses stale browser
state. The existing recommendation row belongs to an engine or human run whose insertion
and population are protected by custody triggers. Replacing that row would violate those
boundaries. Export also reads accepted proposals before locking them, and decision updates
currently commit separately from their audit records.

## Usage

```ts
const { rows, population } = await listRecommendationWindow(database, filters);
const receipt = await reviseRecommendation(database, sessionActor, {
  requestId, profileId, recommendationId: rows[0].id,
  expectedRevisionId: rows[0].proposalRevisionId,
  proposedValue: '0.8123', note: 'Reviewed proposed bid',
});
// Receipt describes the recorded edit; refresh the row before a subsequent decision.
await decideRecommendations(database, {
  orgId, actorId, ids: [receipt.recommendationId], decision: 'accepted',
  expectedRevisions: [{ recommendationId: receipt.recommendationId, revisionId: receipt.revisionId }],
});
const batch = await exportAcceptedRecommendations(database, {
  ...exportOptions,
  ids: [receipt.recommendationId],
  expectedRevisions: [{ recommendationId: receipt.recommendationId, revisionId: receipt.revisionId }],
});
// The existing immutable preview and separate Amazon confirmation follow this export.
```

The receipt is historical and idempotent, not an assertion that its revision is still current.
Retry the same edit request after a lost response. A later decision/export compares the chosen
revision with the current head. Proposal review creates no Amazon approval or provider call.

## Shape and synthesis

Keep the original recommendation identity, proposed value, current value, inputs and run
population. Add one nullable revision head and one immutable revision/receipt table. A revision
stores its predecessor, exact prior/new decimal, actor, request identity, note and database
timestamp. The loader returns the effective proposed value from that head, while retaining
the original engine proposal in its existing row. No new recommendation or run is inserted.

One new `reviseRecommendation(database, actor, request)` capability owns validation, scope,
locking, exact request replay, reset to `proposed`, receipt and audit. Reuse `SpWriteActor` for
the server-derived human identity rather than duplicating its shape. The initial action is an
SP keyword bid supported by the synchronized entity; other fields and human negative-create
proposals remain outside this edit operation. Editing budgets is a later extension.

The shared request uses canonical positive decimal text within the keyword mirror's
`numeric(12,4)` domain. The content revision is a nullable UUID: null is the original proposal.
Decision state changes do not manufacture content revisions. Changed content clears prior
acceptance/dismissal. Edited proposals require exact revision references for later decisions
and exports; missing references never mean the current head. Unedited legacy callers retain
their existing behavior.

This uses the immutable-base candidate's stable run identity, the small-surface candidate's
single edit receipt and content-only concurrency, and the atomic candidate's transaction and
numeric-export requirements. It rejects replacement recommendations, a generic command ledger,
another worker/orchestrator and separate native-only download semantics.

## Transaction and export invariants

- Enter edits through the authenticated actor transaction and a narrow database function.
  Check current membership/profile before returning even an existing receipt. Same actor and
  request identity with the same normalized command returns the original receipt; conflicting
  reuse refuses. The receipt remains immutable after another edit.
- Acquire parent locks before stable proposal row locks. Compare the expected content head
  while locked. Two editors from one head produce one successor and one conflict. Count one
  head change, one revision and one audit; any storage failure rolls them all back.
- Make decision and audit atomic. Preserve complete offered/changed/refused accounting,
  including missing IDs without exposing another tenant's rows. Move authenticated decision
  mutation through the guarded database operation so a direct table update cannot bypass the
  revised-content check; preserve worker INSERT custody and existing application capabilities.
- Export locks the exact requested recommendation population before reading effective values,
  then follows the existing mirror lock order. Explicit-ID export refuses missing, nonaccepted
  or stale rows as a whole. It never exports a silently reduced subset. Freeze revision
  references with the batch's existing audit/provenance in the same transaction.
- Store the selected revision identity on the exact `apply_rows` source row as well. Preview
  evidence includes that identity in its provenance preimage for edited proposals; older
  evidence omits the additive field and keeps its original fingerprint bytes.
- Exported, applied and superseded proposals cannot be edited. Freeze source fields and the
  selected revision once exported. An edit before export invalidates the old reviewed
  selection; an attempted edit afterward cannot change any existing preview/approval/history.
  There is no need for an approval-revocation subsystem for unexported proposals.

## Decimal compatibility

The legacy Python bridge performs cap arithmetic only on numeric old/new values. Decimal
strings therefore cannot silently become ordinary downloadable bid rows. At export, convert
supported edited money through a checked boundary: serialize the candidate JSON number and
require its canonical decimal text to equal the stored exact amount. Refuse any loss; never
round an edit into eligibility. Validate the old value against exact mirror text as well.
Retain canonical strings in revision receipts and freeze the checked numeric values in
`apply_rows`, so existing numeric cap checks and workbook consumers continue to see numbers.

A local probe confirmed four representative boundaries, including the smallest scale and
largest mirror amount, survive the existing serializer exactly. Implementation must prove
edit → decision → export → preview bytes/counts and the real download path. This is a checked
decimal JSON round trip, not a claim that binary floating-point arithmetic is exact.

## Exact file scope and implementation order

1. Shared: new `packages/shared/src/recommendation-revisions.ts`, its test and explicit
   package export; additive provenance identity in `sp-write-preview-evidence.ts` and its
   tests. Land and verify request, receipt and revision-reference contracts first.
2. Persistence: new `20260905040000_recommendation_proposal_revisions.sql` and typed schema
   additions in `packages/db/src/schema/analysis.ts` and `schema/apply.ts`; new
   `packages/db/src/queries/recommendation-revisions.ts` and PostgreSQL tests. Reuse the
   existing authenticated actor helper. Add the capability to `packages/db/src/index.ts`.
3. Integrate effective values/revision checks in `queries/recommendations.ts`, its focused
   tests and the existing export test. Extend `queries/apply-state.ts` only for exact monetary
   scalar text if needed; do not change unrelated state equality or mirror ownership.
   Extend `queries/sp-write-plan-builder.ts` and its tests to retain and verify the frozen
   revision identity in preview provenance.
4. Server: new `apps/web/app/api/recommendations/revise/route.ts` and
   `apps/web/src/recommendations/revisions-http.test.ts`; existing decide/export routes and
   `src/recs-route.test.ts`. Narrow changes in `src/recommendations/export.ts` and its tests
   may enforce the checked money boundary. Claude owns client/page components throughout.
   Share the existing bounded JSON parser through `src/server/json-mutation.ts`, with a narrow
   import change in `src/writes/http.ts`; update the server fixture in `src/recommendations/view.test.ts`.
5. Run current custody/RLS, export, race and HTTP regressions. Update WP-214, the main replan
   and its audit with the actual migration inventory and verification results.
   Persistence verification includes `packages/db/src/rls.test.ts`, `migrations.test.ts`,
   `sp-write-persistence-blast.test.ts` and `sp-write-persistence.test.ts` for the new schema inventory;
   preserve the existing worker-registration prohibitions in those checks.

The migration is a fifth additional WP-214 source migration, beyond the four previously
committed. Its implementation is in progress and is not part of Claude's original five-file
WP-207 window. It retains the five-second lock timeout/advisory DDL lock and must receive its
own rehearsal/review before inclusion in the later source deployment window. Existing
custody migrations, Claude's protected files and parked supervisor work remain outside scope.

The operator's instruction to continue building supplies the implementation checkpoint. Revisit
this design if the privilege/lock proof requires bypassing existing run custody or if decimal
compatibility cannot be proved within the existing bounded monetary domain.
