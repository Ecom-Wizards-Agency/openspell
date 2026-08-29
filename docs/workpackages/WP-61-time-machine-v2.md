# WP-61 — Time Machine v2

**Status:** review · **Owner:** Codex · **Branch:** `wp-61-time-machine-v2`

## Goal

Turn the existing read-only change timeline into an evidence-backed export and
reversion workflow. A reversion remains a staged file for operator review;
Wizard Ads never calls an Amazon write API.

## Implemented outcomes

- Recommendation exports now re-read and lock the synchronized entity mirror
  before recording their old value. A stale recommendation is refused instead
  of becoming a misleading snapshot.
- Each export records its timestamp, deterministic artifact fingerprint, total
  proposals, reversible update rows, and explicitly unsupported create rows.
- Apply rows carry profile and recommendation provenance. Composite foreign
  keys make cross-organisation profile, batch, row, and synchronization links
  unrepresentable.
- Newly synchronized entity changes link to an exact export row only when one
  row matches organisation, profile, entity, canonical field, old value, new
  value, and time ordering. Campaign-budget and ad-group-bid aliases use the
  same canonical mapping as current-state resolution. Repeated same-value
  exports remain ambiguous and blocked.
- A unique row-evidence constraint plus profile-scoped advisory locking makes
  concurrent/redelivered observations idempotent. Every worker entity pass also
  reconciles eligible orphaned evidence, so a linker failure after mirror
  promotion converges on retry even when no fresh diff is generated.
- Batches advance to Applied externally only after every reversible row has one
  unique synchronization event and the current mirror matches the full export.
  A fully synchronized inverse batch atomically marks its source Verified
  reverted; partial or conflicting evidence never advances the lifecycle.
- The batch preview shows original, exported, synchronized, current, and exact
  inverse values. Missing entities, stale mirrors, unsupported fields,
  ambiguous attribution, partial synchronization, mixed create/update batches,
  and later state conflicts fail closed.
- Reversion creation rechecks the complete preview inside a transaction, locks
  the source batch and current mirror rows, and writes a new immutable inverse
  batch plus an audit event. One active reversion export is allowed per source
  batch.
- The confirmation says **“Yes, export reversion”**, includes the exact change
  count and guardrails, and returns a download link while explicitly stating
  that Amazon was not updated.
- The old timeline no longer calls every staged export “Applied.” It distinguishes
  Exported, Applied externally, Reversion export, Verified reverted, Abandoned,
  and independently observed Sync entries.
- Export authorization now uses the central `exportBatches` capability for both
  recommendation and reversion exports.

## Verification

- Shared contract tests cover counted batch and row evidence.
- Database tests cover export-time drift, canonical worker-field aliases, exact
  per-row linking, redelivery ambiguity, retry reconciliation, lifecycle
  transitions, legacy and mixed-create blocks, current-state conflicts, tenant
  isolation, artifact counts, inverse rows, audit records, and duplicate-
  reversion refusal. The disposable PostgreSQL run passed 204 of 204 tests.
- Web route tests cover exact confirmation, stale preview counts, role refusal,
  tenant isolation, response counts, download linkage, and the explicit
  `amazonUpdated: false` result.
- The production-build Playwright operator suite exercises the complete review
  and inverse-export flow with synthetic data, including the no-Amazon-write
  wording. All 27 production-build and 27 authenticated-development workflows
  passed after the final evidence-linking changes.
- A visual snapshot was inspected at laptop width. The evidence table was
  tightened after the first pass so the reason remains usable without an
  unnecessary eighth column.

## Release gates

- The additive migration has only been exercised on disposable PostgreSQL. It
  has not been applied to hosted or shared Supabase.
- Existing legacy batches without an immutable artifact fingerprint remain
  visible but cannot produce a reversion export.
- The schema migration performs no unbounded history rewrite. Eligible orphaned
  sync evidence is reconciled by the worker in bounded recent-first batches;
  hash-less legacy exports remain deliberately outside that recovery path.
- Placement rows remain explicitly unsupported until their nested campaign
  placement fields have an authoritative current-state adapter and fixture.
- Applying an exported reversion remains an external/operator action. The next
  successful entity synchronization verifies the inverse and advances the
  source lifecycle automatically. Direct Amazon rollback stays behind the
  global write gate.
- Live evidence requires the hosted migration, a revision-stamped deployment,
  and a real post-export sync crosscheck. None is claimed by this package.

## Safety record

- No Amazon write API was invoked.
- No hosted/shared migration or seed was run.
- No credential, client data, doctrine threshold, private reference material,
  or machine-specific path was added to tracked files.
