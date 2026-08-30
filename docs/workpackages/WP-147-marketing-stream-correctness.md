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
4. Provider event identity is independent of delivery-route provenance, so a
   redelivery after binding rotation deduplicates. The binding used at first
   receipt is still retained and protected by a composite foreign key.
5. Append and projection take the same profile advisory lock before projection
   takes sorted scope locks. Exact source-event fingerprints still reject a
   stale replacement.
6. One SQS poll is grouped by `(organization, profile)`. A failed group does not
   block another profile, and a delivery is deleted only after raw rows and its
   normalize job are durable or verified as duplicates.
7. Queue visibility is renewed before and throughout append, job enqueue, and
   acknowledgement. Heartbeats are cancelled in `finally`; renewal failure is
   recorded and leaves the delivery for redrive. Production queue startup
   fails closed without a bounded visibility timeout and SQS-managed DLQ
   policy; poison messages are never manually discarded.
8. Settling begins at the end of the UTC event hour. Late traffic/conversion
   evidence reopens the scope as revised for another configured window;
   budget-only updates do not reopen conversion maturity.
9. Missing tenant policy accumulates affected scopes in one durable profile
   block. At most one retry is queued per profile/hour, retries cap after 24
   attempts with an alert state, and the next successful profile job replays
   and clears every accumulated scope. Scope accumulation is capped at 4,096;
   overflow fails visibly without acknowledging the raw delivery. An operator
   can requeue any retained message for an alerted quiet profile; the handler
   always unions that message's scopes with the durable block.

## Local verification

The migration remains unapplied. Before an authorized production run, inspect
row counts and duplicate provider identities, estimate index-build volume, and
schedule for a low-ingestion window: the composite foreign key, validation
checks, and provider-identity unique index can lock or scan the events table.
Apply with an explicit lock timeout and abort rather than waiting behind live
ingestion; verify constraints and index validity before enabling the consumer.

- Shared, database, worker, and web typechecks.
- Signed/out-of-order correction and latest-budget unit tests.
- Strict offset, grouping, partial failure, redelivery, queue visibility, DLQ,
  and count-reconciliation tests.
- Real queued normalize-handler and aging-transition tests.
- Provider-native binding → raw ledger → durable job → normalization → aging
  transition integration with duplicate and later-lower budget observations.
- Disposable-Postgres migration, RLS, binding, identity-collision,
  append/projection lock, stale-write, and read-back tests.
- Repository hygiene and explicit no-Amazon-write assertion.
