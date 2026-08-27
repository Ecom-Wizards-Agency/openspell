# WP-41 queue contract design

## Problem

Four integration jobs must join the frozen queue contract without changing the
existing Amazon pipeline. The same atomic Postgres queue will be drained by two
runtimes: Vercel cron for Amazon work and an always-on host for integrations. The
claim policy therefore has to be explicit at the worker boundary, integration
handlers must not pull provider dependencies into the generic worker, and schedule
provisioning must tolerate WP-40's connection table not existing yet.

## Usage (caller's view)

An integration package supplies only the handlers it deploys:

```ts
const worker = new SyncWorker({
  workerId: config.workerId,
  store,
  jobTypes: config.jobTypes,
  integrations: {
    keepaSync: async (payload) => keepa.sync(payload),
    rankSync: async (payload) => dataDive.syncRanks(payload),
  },
});
```

The Vercel cron supplies an explicit allowlist for Amazon queue work and
recommendations. The always-on process parses `WORKER_JOB_TYPES`; when its list has
no Amazon jobs it neither constructs an Ads client nor starts Amazon-only periodic
passes.

Both runtimes reconcile integration schedules through one idempotent store call:

```ts
const changed = await store.ensureIntegrationSchedules();
```

## Shape

```ts
type IntegrationHandler<T extends JobPayload> =
  (payload: T) => Promise<Record<string, unknown>>;

interface IntegrationHandlers {
  keepaSync?: IntegrationHandler<KeepaSyncJob>;
  rankSync?: IntegrationHandler<RankSyncJob>;
  economicsSync?: IntegrationHandler<EconomicsSyncJob>;
  sqpCategorize?: IntegrationHandler<SqpCategorizeJob>;
}

interface SyncWorkerOptions {
  workerId: string;
  store: WorkerStore;
  adsApi?: AdsApiClient;
  jobTypes?: readonly JobType[];
  integrations?: IntegrationHandlers;
}

interface WorkerStore {
  claim(workerId: string, limit: number, jobTypes?: readonly JobType[]): Promise<ClaimedJob[]>;
  ensureIntegrationSchedules(): Promise<number>;
}
```

`packages/shared` owns payload validation. `packages/db` owns the filtered atomic
claim function and enum mirror. `apps/worker` owns dispatch, environment parsing,
schedule reconciliation, and conditional Ads wiring. `apps/web` owns the cron's
explicit complementary allowlist and deadline. The named handler port hides provider
clients and persistence from the queue shell; the worker exposes only dispatch
capability, not integration internals.

Schedule reconciliation reads active `integration_connections` only after a
table-existence check. It selects the first sync-enabled profile per org and country,
unless a connection's `config.profile_id` names a valid sync-enabled profile. It
disables stale integration schedules and inserts or repairs the expected enabled
ones. Due SQP jobs derive the Sunday `weekStart` at enqueue time in the profile's
timezone.

## Synthesis decision

The base is the smallest-public-surface candidate: one allowlist option, one handler
port, and one reconciliation method. From the isolation-first candidate it takes the
database-owned predicate and the table-existence seam. A handler map keyed by job type
was rejected because it weakens the exact payload type at each provider boundary; a
filter hidden in the store constructor was rejected because the worker caller could
not see what it is allowed to claim.

## Tradeoffs accepted

- We accept an optional Ads client in exchange for an integration-only runtime that
  has no Ads credentials.
- We accept country code as the current marketplace key in exchange for using the
  profile data the schema actually owns.
- We accept a guarded raw query for connection reconciliation in exchange for landing
  independently of WP-40's Drizzle schema.

## Alternatives considered

- A generic `Partial<Record<JobType, Handler>>` hides less: every provider implementer
  must recover its payload subtype, so it lost to the named typed port.
- A job filter stored only in `PostgresWorkerStore` shortens the claim call but leaks
  runtime policy into persistence construction and makes fake-store verification
  weaker.

## Open questions and risks

- Will a later marketplace-id column replace `ad_profiles.country_code` as the
  designation key? If so, only the reconciliation query changes.
- Should a future provider support more than one active credential per marketplace?
  The current payload contract deliberately identifies the org/profile, not a
  connection, so handlers must resolve the active credential behind their port.

## Next implementation step

Extend and test the shared payload union, then add the enum migration before any SQL
function refers to the new labels.
