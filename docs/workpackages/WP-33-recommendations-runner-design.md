# WP-33 recommendations runner — design

## Problem

The worker must turn profile-scoped facts and tenant doctrine into preview-only bid
proposals, while preserving four boundaries: `packages/core` stays pure, the frozen
shared contract remains unchanged, every database read carries `(orgId, profileId)`,
and a scheduled or replayed job cannot duplicate recommendation rows. The same module
also has to mint run/job pairs for weekly and on-demand execution without sending the
generic SQL scheduler a payload that lacks its required `runId`.

## Usage (caller's view)

The queue worker receives one injected function and does not coordinate its stages:

```ts
const recommendationRuns = new PostgresRecommendationRunStore(handle);
const worker = new SyncWorker({
  workerId,
  store,
  adsApi,
  recommendationsRun: createRecommendationsRunner(recommendationRuns),
});
```

The periodic provisioner and Vercel tick call the same weekly scheduler seam:

```ts
const enqueued = await recommendationRuns.enqueueDueRecommendationRuns();
```

The optimizer's server action uses the same atomic run/job minting operation, without
the weekly due gate:

```ts
await recommendationRuns.enqueueRecommendationRun({
  orgId,
  profileId,
  lookbackDays: 7,
  source: 'web',
});
```

## Shape

```ts
interface RecommendationRunStore {
  startRun(scope: RunScope): Promise<StartRunResult>;
  loadProfile(scope: ProfileScope): Promise<RecommendationProfile>;
  loadInputs(scope: ProfileScope, window: DateWindow): Promise<RecommendationRunInputs>;
  succeedRun(completion: RunCompletion): Promise<number>;
  failRun(scope: RunScope, error: string): Promise<void>;
}

interface RecommendationScheduleStore {
  enqueueDueRecommendationRuns(now?: Date): Promise<number>;
  enqueueRecommendationRun(input: QueueRunInput): Promise<QueuedRun>;
}

type RecommendationsRun = (job: RecommendationsRunJob) => Promise<RunResult>;
```

`runRecommendations` owns in-memory domain assembly: profile-local window arithmetic,
category/opt-group resolution, confidence-level aggregation, pacing, calls to
`buildRecommendations` and `proposeBid`, and the exhaustive White Box reason mapping.
The store owns SQL representations and atomicity: scoped joins, strategy documents,
latest corridors, lifecycle transitions, bulk proposal insert, audit narrative,
run/job minting, and all offered-versus-written assertions. Only `proposal` outcomes
become rows; `none` and `suppressed` outcomes join the qualitative engine output in the
run-level audit narrative.

This is a deep interface: five runner methods hide all storage protocol and one input
bundle prevents query representations from leaking into the doctrine assembly. The
scheduler is a separate capability because the web action needs run/job minting but
must not gain permission to mutate a running recommendation.

## Synthesis decision

Candidate A exposed separate `loadStrategy`, `loadTargets`, `loadCampaigns`,
`loadCorridors`, `loadPacing`, `insertRows`, and `updateRun` calls. It optimized each
query for isolated testing, but failed the shallow-module and temporal-decomposition
screens: callers had to know database execution order and preserve transaction policy.

Candidate B used the bundled input and lifecycle interfaces above. It became the base
because it keeps SQL and count invariants behind one boundary. From Candidate A it
retains pure exported helpers for window calculation and reason mapping, so edge cases
remain unit-testable without widening the store.

## Tradeoffs accepted

- We accept one comparatively rich input bundle in exchange for one scoped database
  read boundary that fake stores can reproduce exactly.
- We accept run-level audit JSON as the narrative store in exchange for preserving the
  frozen action-oriented recommendation contract.
- We accept a TypeScript weekly scheduler in exchange for minting `runId` atomically
  before enqueue without changing `enqueue_due_schedules()` SQL.
- We stamp the engine version when the run is queued, so weekly gating and the optimizer
  surface can distinguish White Box runs from n-gram proposal runs that share the table.

## Alternatives considered

- A query-by-query store lost because it exposed storage sequencing and transaction
  knowledge to every caller while hiding little.
- Putting recommendation schedules into `sync_schedules` lost because the unchanged SQL
  enqueuer would race the TypeScript provisioner and can only create a malformed
  `recommendations.run` payload without a minted `runId`.

## Open questions and risks

- The frozen `RecommendationInputs` records which corridor bound a bid but has no field
  that distinguishes an absent corridor from a present non-binding one. The audit
  narrative therefore records corridor coverage without changing or misusing the shared
  contract.
- Reporting can take hours, so scheduled recommendation jobs use a lower queue priority
  and a delay after report requests; on-demand jobs remain immediate.
