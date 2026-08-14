# worker

Owned by **WP-03**. The always-on process that does everything Amazon-facing: entity sync, the
three-pass Reporting v3 pipeline, the recommendation runs, and the crosscheck ingest. Nothing else
in the repo talks to the Amazon Ads API — `apps/web` reads the database the worker fills.

## The shape of it

| Module | What it is |
|---|---|
| `worker.ts` | The claim loop, the job handlers, the retry policy, and the two periodic passes. |
| `store.ts` | Every database call the worker makes, behind `WorkerStore` so a handler can be tested without one. |
| `parsers.ts` | Gunzip + the typed per-report-type row parsers, and the grain each one lands on. |
| `region-token-buckets.ts` | Per-region concurrency caps. NA/EU/FE are separate hosts and separate limits. |
| `crosscheck.ts` | The seam WP-10's `runCrosscheckIngest` is called through, plus the retry classification. |
| `schedules.ts` | The default cadences, as rows rather than as a comment. |
| `ads-api.ts` | The narrow client interface the worker needs. **WP-02 is not integrated yet** — `createAdsApiClientFromEnv` throws. |
| `main.ts` | Process entry: config, health server, the two passes, graceful shutdown. |

## The job pipeline

Reporting v3 is asynchronous and slow — a report can take hours — so it is three jobs, not one long
one. A worker killed halfway through loses at most one short step:

```
report.request  create the report, write report_requests, enqueue a poll for +5min
report.poll     PENDING → reschedule 5→10→20→30min (capped), give up at 4h
                COMPLETED → enqueue report.fetch
report.fetch    stream, gunzip, parse, upsert into the fact partition, assert parsed == loaded
```

`entity.sync` diffs a listing against the entity mirror and writes `entity_changes` rows for the
fields that moved. **Only a `full` pass tombstones.** A delta pass has no way to tell "absent
because deleted" from "absent because this pass did not list that type", so sweeping on one would
tombstone every keyword the moment a campaign-only pass ran.

`crosscheck.ingest` calls `runCrosscheckIngest` from `@wizard-ads/crosscheck-cli` (WP-10). A
`mismatch` headline is a **success** — the verdict is the job's product. Only a throw fails it, and
two throws skip the retries entirely (see below).

## Counting, because exit codes lie

Every list-driven step counts its outputs against its inputs and fails when they disagree:

- `entity.sync` asserts entities listed against rows upserted.
- `report.fetch` asserts fact rows parsed against fact rows loaded, and `report_requests` carries
  both plus a generated `counts_match`.
- `crosscheck.ingest` logs rows parsed against rows kept, and verdicts written against findings.

`spCampaigns` is the one place these numbers legitimately differ: Amazon sends one row per campaign
per day and `fact_profile_daily` holds one row per profile per day, so the parser sums by date. The
job result reports `reportRows` (what Amazon sent) alongside `parsed`/`loaded` (fact rows).

## Retry policy

| Situation | What happens |
|---|---|
| Any handler throws | `attempts++`, requeued with exponential backoff, `dead` after `max_attempts` |
| `AdsApiRetryableError` with `Retry-After` | requeued with exactly that delay |
| `PermanentJobError`, `ExportContractError`, `ProfileNotFound` | straight to `dead`, attempts unspent |
| Worker SIGKILLed mid-job | the job sits in `running` until a sweep requeues it |

That last row is why `StaleClaimReaper` exists. `claim_sync_jobs` only ever sees `queued`, so
without a sweep a killed worker's job is lost. pg_cron runs `requeue_stale_sync_jobs()` every 15
minutes on Supabase; the reaper runs the same function in-process so a deployment against a plain
Postgres — or one where the cron extension is unavailable — is not silently missing it. Both are
idempotent, so running both costs nothing.

## The auth healthcheck is not a queue job — deliberately

The brief called for "an hourly `auth.healthcheck` job hitting `/v2/profiles` per region". It is
implemented as an in-process timer (`AuthHealthMonitor`) rather than a row in `sync_jobs`, and the
manager accepted that.

The reason is that a liveness probe which depends on the subsystem it monitors cannot report the
failure that matters most. If the queue stops draining — a stuck claim, a wedged pool, a worker
that is up but not working — a queued `auth.healthcheck` never runs, and the silence looks exactly
like health. Running it on its own timer means the probe still fires and still logs when the queue
itself is the broken thing.

The secondary reasons all point the same way: the probe is not scoped to a profile, so it does not
fit the `(org, profile)` shape every `sync_jobs` row has; it needs no dedupe slot, no backoff and
no ledger entry; and it is per-worker-process rather than per-account, so a second worker should
run its own rather than contend for one row.

`WORKER_AUTH_HEALTHCHECK_MINUTES` changes the interval. Failures are logged loudly; Slack alerting
is wired by the operator downstream of the logs.

## Schedules

`enqueue_due_schedules()` (WP-01) runs on pg_cron every five minutes and turns due `sync_schedules`
rows into jobs. `schedules.ts` holds the defaults per profile:

| Variant | Job | Cadence | Window |
|---|---|---|---|
| `default` | `entity.sync` (full) | daily | — |
| `default` | `report.request` | daily | trailing 3 days |
| `restatement` | `report.request` | weekly | trailing 35 days |

The restatement pass exists because Amazon restates sales for 14+ days after the fact. The window
is in the *profile's* timezone, which is the only calendar Amazon's report dates mean anything in.

`ScheduleProvisioner` installs these for any sync-enabled profile that has **no** schedule rows, so
a newly connected profile starts syncing without an onboarding step somebody forgets. It only ever
fills an empty set: a profile whose schedules an operator pruned stays pruned.

`variant` is a column added by `supabase/migrations/20260814140000_sync_schedule_variant.sql`. The
original uniqueness key was `(profile_id, job_type, report_type)`, which made the daily and weekly
schedules for one report type mutually exclusive — the restatement pass could not be scheduled at
all. `variant` joins the key; existing rows default to `default` and keep the uniqueness they had.

## Configuration

| Variable | Default | What it is |
|---|---|---|
| `DATABASE_URL` | — | Service-role connection string. Required. |
| `WORKER_ID` | `worker-<pid>` | Identifies the claimer in `sync_jobs.claimed_by`. |
| `PORT` | `3000` | `/healthz`. |
| `WORKER_POLL_INTERVAL_MS` | `1000` | Idle sleep between empty claims. |
| `WORKER_CLAIM_BATCH_SIZE` | `10` | Jobs per `claim_sync_jobs` call. |
| `WORKER_MAX_CONCURRENT_JOBS` | `10` | In-flight cap for this process. |
| `WORKER_AUTH_HEALTHCHECK_MINUTES` | `60` | Auth probe interval. |
| `WORKER_STALE_CLAIM_AFTER` | `30 minutes` | How long a `running` claim may go quiet. |
| `CROSSCHECK_INBOX_DIR` | unset | Root of the AdLabs export inbox. Never a tracked default. |

Region concurrency is capped in code at 2 concurrent report creates per region (NA/EU/FE
independently), which is the conservative starting point the plan asks for.

## Tests

```
WIZARD_ADS_TEST_DATABASE_URL=postgres://…  pnpm --filter @wizard-ads/worker test
```

The DB-backed suite skips itself when no Postgres is reachable, so `pnpm check` stays honest on a
machine without one — which also means **a green run on such a machine has not tested the worker**.
Point it at a database.

## Not done yet

`createAdsApiClientFromEnv` throws: WP-02's client is not wired in. Everything above is exercised
against `AdsApiClient` fakes and a real database. The `INTEGRATE(WP-02)` comment in `ads-api.ts`
marks the one function that has to change.

`recommendations.run` returns a stub result pending WP-05's engine.
