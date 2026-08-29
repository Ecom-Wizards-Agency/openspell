# WP-56 — Operator-intelligence data foundations

## Boundary

This package owns only `packages/db`, `supabase`, and this brief. It adds local,
additive storage foundations for later worker and UI packages. It does not call
Amazon, add a write-capable product action, seed tenant doctrine, or apply a
migration to a hosted database.

## Delivered schema

- exact report coverage, historical-bootstrap progress, promotion watermarks,
  and append-only attribution observations;
- monotonic promotion guards and reconciled source/parsed/refused/promoted/
  canonical row counts;
- Amazon Asset-ID creative identity, explicit ad-to-asset mappings, and daily
  ad-grain creative facts without null-content-hash collapse;
- weekly SQP category fields, marketplace vocabulary and review/export-only
  contextual negative proposals;
- UUID-backed optimization groups, one group assignment per campaign, and
  synchronized recommendation evidence observations;
- idempotent Marketing Stream raw events, profile-local hourly facts, settling
  state, and review/export-only dayparting schedule proposals.

All new profile-scoped rows use composite `(org_id, profile_id)` foreign keys.
Relationships to creative assets and optimization groups carry the same tenant
and profile keys, so cross-tenant references are rejected by PostgreSQL rather
than hidden only by RLS.

## Safety and rollout

The migration repairs `creative_assets` identity by removing the old unique
`(org_id, content_hash) nulls not distinct` index. Amazon Asset ID is unique per
profile; content hash becomes a non-unique lookup. A `NOT VALID` composite
profile constraint protects every new creative-asset write without assuming
that unknown legacy rows are already clean. A production rollout must inspect
and validate those legacy rows before validating the constraint.

`report_request_id` in promotion watermarks is intentionally not a foreign key
to the legacy `report_requests` table. That table's enum cannot represent SQP,
unified reporting, or Marketing Stream. The UUID remains the stable feature
request identity until the worker package lands the generic feature-request
ledger.

## Acceptance evidence

- All migrations apply in chronological order to a fresh PostgreSQL 16
  database.
- The catalog-driven RLS suite has a synthetic row for both tenants in every
  new table and proves no cross-tenant visibility.
- Tests reject cross-tenant creative/group references, duplicate campaign
  assignments, duplicate stream revisions, duplicate attribution observation
  keys, stale promotion replacement, invalid count reconciliation, non-Sunday
  SQP weeks, and out-of-range shares.
- The current and next creative-fact partitions are created through the same
  managed partition registry as existing daily facts.
- No hosted migration or seed is part of this package.

The final disposable-PostgreSQL run passed 21 database test files and 171
tests, including the full migration, partition and catalog-driven RLS suites.

## Deliberate seams for later packages

- Feature-specific creative, SQP and stream ingestion batch-count ledgers are
  not guessed here. Their shared count contracts exist; WP-58, WP-59 and WP-62
  must persist and reconcile them when the corresponding worker transaction is
  implemented. Promotion watermarks already enforce report row reconciliation.
- Unified/SQP report request identity is not forced into the legacy Reporting
  v3 enum. The worker needs a generic feature-request ledger before the
  watermark UUID can become a foreign key.
- Marketing Stream raw and hourly tables are unpartitioned in this foundation
  so idempotency keys remain globally enforceable. WP-62 must benchmark real
  volume and choose a partition/retention scheme that preserves those keys.
- Existing creative rows are protected for new writes by a `NOT VALID`
  composite profile constraint. Production rollout must audit legacy rows and
  validate that constraint in a separately authorized maintenance step.
