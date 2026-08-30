# WP-165 — Bounded Creative pilot gate

## Outcome

Keep the daily Sponsored Brands Video Creative producer fully inert after a
source merge, while making a later attended pilot incapable of expanding from
the approved cohort to every connected profile.

This package changes source and tests only. It does not change an environment
value, deploy a service, run or apply a migration, read a credential, enqueue a
production job, or call Amazon.

## Caller usage

```ts
const pilot = creativeSyncPilotFromEnv(env);

await runSyncTick({
  sql,
  store,
  worker,
  ...(pilot.enabled
    ? {
        creativeSyncSchedules: () =>
          enqueueDailyCreativeSyncJobs(handle, pilot.profileIds),
      }
    : {}),
});
```

The route result reports requested, eligible, ineligible, pending-deferred,
enqueued, and deduplicated counts. The database query retains tenant-scoped
observations for its own reconciliation, but the HTTP response never includes
an organization id, profile id, queue id, or dedupe key.

## Design decision

Three shapes were considered:

1. Store a pilot cohort in a new database table. This provides an operator UI
   later, but it requires a migration and production write before a bounded
   source-only pilot can run.
2. Move the daily producer into the Evo worker. This couples queue production
   to consumption and violates the exclusive report role's queue-only contract.
3. Parse a deployment-only cohort at the existing Vercel cron boundary and pass
   it into the database-only producer.

The third shape preserves the existing ownership seam and adds no persistent
configuration. `OPENSPELL_CREATIVE_SYNC_PRODUCER_READY` must be exactly `1`,
`OPENSPELL_EVO_REPORT_LANE_READY` must already be exactly `1`, and
`OPENSPELL_CREATIVE_SYNC_PROFILE_ALLOWLIST` must contain at least one unique,
valid UUID. Missing or `0` producer values stay inert and do not inspect the
cohort. Malformed and duplicate identifiers fail before database or Amazon
wiring, without echoing the rejected value.

The producer joins the requested UUID set to `ad_profiles`; it never starts
from the complete profile table. Its accounting invariants are:

```text
requested = eligible + pending-deferred + ineligible
eligible = enqueued + deduplicated = internal observations
```

Unknown and sync-disabled requested profiles are counted as ineligible. They do
not fall through to another profile and are not silently removed from the
request count.

## Sanitized worker identity

The always-on worker health document exposes:

- a validated Git object id from `OPENSPELL_WORKER_REVISION`;
- deployment role;
- effective queue claim set;
- stopping and in-flight counters;
- existing sanitized Marketing Stream counters.

Health does not expose the worker identifier, host, environment values,
credentials, tenant identifiers, or profile identifiers. A local worker may
report revision `unknown`, but the pilot preflight rejects that value.

## Read-only preflight

`creative:preflight` takes an unauthenticated `/healthz` URL and the approved
Git revision. It reads the deployment cohort and database connection from the
runtime environment, then:

1. verifies the required Creative and queue tables and columns;
2. verifies the authoritative Creative attribution enum exactly, plus the
   required report/Creative job and Sponsored Brands enum values;
3. counts requested, existing, and sync-enabled cohort profiles;
4. counts `report_pending` Creative snapshots for the cohort and across the
   database;
5. requires the exact worker revision, `evo-report-lane` role, and four-type
   Creative/report claim set;
6. refuses readiness when a requested profile is missing or disabled, or a
   cohort snapshot is already pending.

The preflight API has no provider-client parameter. Its output records
`amazonApiCalls: 0`, `amazonWriteCalls: 0`, and `migrationsApplied: 0`. Database
tests additionally compare the relevant table counts before and after the real
catalog inspection.

## Attended activation order

This source does not perform these steps:

1. Deploy one exact revision with all activation flags absent or `0`.
2. Configure the Evo worker's exact revision, role, and four-type claim set;
   keep the producer off.
3. Configure the bounded profile cohort without printing or committing it.
4. Run `creative:preflight`; require `ready: true` and zero cohort-pending
   snapshots.
5. Complete the exclusive report-lane handoff and independently verify the two
   consumer claim sets are disjoint.
6. Set the producer gate to `1`, redeploy the exact revision, and invoke one
   authenticated cron tick.
7. Reconcile safe producer counts and observe the cohort through the complete
   Creative/report lifecycle before considering any wider cohort.

## Rollback order

1. Set the producer gate to `0` or remove it and redeploy.
2. Verify a cron tick emits no Creative producer accounting and offers no new
   Creative job.
3. Let already queued Creative/report jobs reach a terminal state.
4. Only after the report queue is empty, stop Evo and reverse the report-lane
   handoff if needed.

Disabling the producer does not abandon or delete existing evidence.

## Acceptance evidence

- Pure tests prove absent/zero gates are inert and enabled gates require a
  non-empty, unique UUID cohort.
- Route tests prove unsafe activation fails before database or Amazon wiring.
- Migrated disposable-Postgres tests prove cohort-only offers, profile-local
  dates, deduplication, pending deferral, unknown/disabled accounting, and exact
  count reconciliation.
- Migrated disposable-Postgres tests prove the preflight finds the actual schema
  and does not change queue, snapshot, asset, mapping, or fact row counts.
- Worker tests prove health omits the worker id and preflight rejects revision,
  role, claim-set, stopped-worker, schema, cohort, and pending-snapshot drift.
- Synthetic clients only; the producer and preflight assert zero Amazon write
  calls.
- Typecheck, lint, tests, public-repository hygiene, and the full repository
  check must pass before merge.
