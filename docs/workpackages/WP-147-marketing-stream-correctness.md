# WP-147 — Marketing Stream correctness

## Outcome

Turn the recovered provider adapter into a replayable, tenant-safe Marketing
Stream runtime. Provider deliveries are raw-ledger-first, grouped by internal
profile, and followed by one durable normalization job. The job replays the
complete affected UTC-hour scopes and schedules later settling transitions.

## Boundaries

- No live AWS or Amazon calls in verification.
- No production or shared-database migration run.
- No Amazon Ads mutation client in the Stream ingress or projection path.
- Provider tenancy comes only from an active subscription binding. Campaign
  identifiers never select an organization or profile.
- Existing internal-envelope ledger rows remain supported.

## Correctness invariants

1. Traffic and conversion provider records are immutable signed
   contributions. Individual negative corrections are accepted; only the
   complete campaign/hour aggregate must be non-negative and internally
   consistent.
2. Budget usage is point-in-time state. The latest provider observation wins,
   even when it is lower than an older observation.
3. Provider timestamps must carry `Z` or an explicit numeric offset before
   they are normalized to UTC.
4. Provider identity is unique within its exact subscription binding and is
   retained on every raw event. A binding's provider fields are protected by a
   composite foreign key.
5. Append and projection take the same profile advisory lock before projection
   takes sorted scope locks. Exact source-event fingerprints still reject a
   stale replacement.
6. One SQS poll is grouped by `(organization, profile)`. A failed group does not
   block another profile, and a delivery is deleted only after raw rows and its
   normalize job are durable or verified as duplicates.
7. Queue visibility is extended before processing. Production queue startup
   fails closed without a valid visibility timeout and SQS-managed DLQ redrive
   policy; poison messages are never manually discarded.
8. Settling begins at the end of the UTC event hour. Late traffic/conversion
   evidence reopens the scope as revised for another configured window;
   budget-only updates do not reopen conversion maturity.

## Local verification

- Shared, database, worker, and web typechecks.
- Signed/out-of-order correction and latest-budget unit tests.
- Strict offset, grouping, partial failure, redelivery, queue visibility, DLQ,
  and count-reconciliation tests.
- Real queued normalize-handler and aging-transition tests.
- Disposable-Postgres migration, RLS, binding, identity-collision,
  append/projection lock, stale-write, and read-back tests.
- Repository hygiene and explicit no-Amazon-write assertion.
