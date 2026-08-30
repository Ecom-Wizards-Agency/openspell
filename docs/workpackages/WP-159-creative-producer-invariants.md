# WP-159 — Gated Creative producer and terminal invariants

## Outcome

Add a deterministic database-only producer for one current Sponsored Brands
Video observation per sync-enabled profile and profile-local calendar day. The
source remains off after merge. No job is produced unless both the exclusive
Evo report lane and this producer are explicitly activated with the exact value
`1`.

Close the report lifecycle invariant at the same time. A request, poll, or fetch
that reaches a non-retryable failure or exhausts its retry budget fails the
tenant-scoped report ledger before its queue job becomes terminal. The existing
report-ledger trigger then moves a linked Creative snapshot from
`report_pending` to `blocked`, retaining its observation and count evidence.

This package changes source and tests only. It does not deploy a runtime, change
an environment value, run a migration, read a credential, or call Amazon.

## Caller usage

```ts
const jobTypes = cronSyncJobTypesFromEnv(env);
const producerReady = creativeSyncProducerEnabledFromEnv(env);

await runSyncTick({
  sql,
  store,
  worker: new SyncWorker({ jobTypes, ...workerDeps }),
  ...(producerReady
    ? { creativeSyncSchedules: () => enqueueDailyCreativeSyncJobs(handle) }
    : {}),
});
```

The callback only inserts queue rows. The reduced Vercel claim set excludes
`creative.sync` and all report lifecycle jobs; the exclusive Evo report runtime
is their only consumer.

## Design decision

Three boundaries were considered:

1. Add a normal `sync_schedules` row. This would reuse the SQL scheduler, but it
   requires a migration and cannot represent a profile-local date plus the
   report-pending deferral without widening the scheduler contract.
2. Start a timer inside the Evo report worker. This would couple production to
   the consumer process and contradict WP-158's queue-only role with background
   passes disabled.
3. Inject a database-only producer into the existing locked Vercel cron tick.
   This reuses its overlap lock, places enqueue before drain, and leaves queue
   consumption disjoint.

The third option adds the fewest exported functions and preserves ownership. The
database function derives org, profile, timezone, and enabled state directly
from `ad_profiles`; callers cannot supply a tenant roster. Its dedupe key is
`creative.sync:SB:<profile UUID>:<profile-local date>`, protected by the
existing `(org_id, dedupe_key)` unique index. It reconciles enabled, offered,
pending-deferred, inserted, deduplicated, and returned observation counts before
reporting success.

A profile with a `report_pending` Creative snapshot is deferred instead of
burning the next day's job retry budget against the one-pending-snapshot guard.
Once the prior report completes or is blocked, the next five-minute cron tick
can offer that same local day.

## Terminal behavior

- While attempts remain, request, poll, and fetch errors continue to retry and
  leave the report ledger pending.
- Before a non-retryable failure is dead-lettered, the worker fails an
  unfinished report ledger in the exact `(report id, org id, profile id)`
  scope.
- Before the last retryable attempt is finalized, it performs the same scoped
  ledger failure.
- The report error contains a sanitized terminal reason with a fixed length
  limit. The queue row retains the underlying error, also length-limited, as its
  audit trail.
- Existing completed or already-terminal ledgers are not rewritten.
- Queue success-finalization is outside the execution error handler. If that
  database write fails after successful report work, stale-claim recovery may
  replay the idempotent job, but the snapshot is not falsely blocked.
- The schema's existing trigger blocks the linked Creative snapshot. No new
  status, column, shared contract, or migration is required.

## Activation order

Activation is a separate attended deployment operation:

1. Merge and deploy this source with `OPENSPELL_CREATIVE_SYNC_PRODUCER_READY`
   absent. Verify no `creative.sync:SB:` queue key is produced by a cron tick.
2. Complete WP-158's handoff: deploy Vercel with
   `OPENSPELL_EVO_REPORT_LANE_READY=1`, start the Evo report worker with its
   exact four-type allowlist, and prove the two claim sets are disjoint.
3. Verify Evo health, queue age, report-ledger terminal behavior, and that no
   Creative snapshot is already stranded in `report_pending`.
4. Set `OPENSPELL_CREATIVE_SYNC_PRODUCER_READY=1` on Vercel and redeploy.
5. Invoke one authenticated cron tick. Reconcile `enabledProfiles` as
   `offeredProfiles + deferredPendingProfiles`, and `offeredProfiles` as
   `enqueuedJobs + deduplicatedJobs`.
6. Observe one test profile through `creative.sync` → `report.request` →
   `report.poll` → `report.fetch`, then verify snapshot and report counts before
   broadening observation.

## Rollback order

1. Set `OPENSPELL_CREATIVE_SYNC_PRODUCER_READY=0` (or remove it), redeploy
   Vercel, and verify a cron tick produces no new Creative jobs.
2. Leave Evo running long enough to drain already-queued Creative/report work;
   disabling the producer does not abandon in-flight evidence.
3. If the report-lane handoff must also be reversed, wait until its queue is
   empty, stop Evo, remove or zero `OPENSPELL_EVO_REPORT_LANE_READY`, redeploy
   Vercel, and verify the original five-type claim set before restarting work.

## Acceptance evidence

- Pure tests prove the producer is off when either opt-in is absent or zero and
  refuses malformed or premature activation before database/Amazon wiring.
- Migrated disposable-Postgres tests prove timezone/DST-aware local dates,
  same-day queue deduplication, disabled-profile exclusion, pending-report
  deferral, later same-day recovery, and count reconciliation.
- Worker unit tests execute request, poll, and fetch failure paths at the retry
  boundary and prove the tenant-scoped terminal ledger call; a non-terminal
  retry proves the ledger is left pending, and a queue-finalization failure
  proves successful report work is not reclassified as terminal.
- A migrated disposable-Postgres worker test proves the actual terminal fetch
  path changes the queue job to `dead`, the report to `failed`, and the linked
  snapshot to `blocked`, while retaining the underlying queue error.
- All provider clients in this package's tests are synthetic. The producer has
  no Ads API dependency, and the terminal integration proof asserts zero report
  creation calls. No Amazon write surface is invoked.
