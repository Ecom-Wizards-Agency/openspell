# WP-68 — Outstanding capabilities design

## Problem

The operator-upgrade release put the shared contracts, additive schema, pure
engines, counted persistence, dashboard, grid, guided campaign builder and Time
Machine v2 on `main`. The remaining gap is not missing branch work. It is the
application layer between those foundations and an operator: persisted
optimization groups, group-scoped recommendation runs, Creative Performance,
Query Intelligence, Dayparting and Strategy surfaces, plus the live read-side
adapters that can populate them.

The design must keep Amazon read-only, keep credentials in worker deployment
configuration, keep tenant numeric doctrine in database rows, and avoid making
an empty table look like a working integration.

## Usage — caller's view

The web tier uses deep, tenant-scoped database operations. It does not assemble
storage transactions or provider workflows itself.

```ts
const workspace = await readOptimizationWorkspace(database, { orgId, profileId });

await saveOptimizationGroup(database, {
  orgId,
  profileId,
  actorId,
  group: submittedGroup,
  campaignIds: submittedCampaignIds,
});

await enqueueOptimizationGroupRun(database, {
  orgId,
  profileId,
  groupId,
  source: 'web',
});
```

The recommendation worker receives one group context per job. The stored run
snapshot is authoritative for that run, and only campaigns assigned to that
group are read.

```ts
await runRecommendations(store, {
  type: 'recommendations.run',
  orgId,
  profileId,
  runId,
  groupId,
  lookbackDays,
});
```

Read-only product routes consume existing domain reads rather than recreating
facts locally.

```ts
await readCreativePerformance(database, filter);
await readQueryIntelligence(database, scope);
await readDaypartingWorkspace(database, scope);
```

## Candidate A — domain workspaces with thin routes

Each capability owns one deep query/orchestration module. A route asks for a
complete workspace or invokes one atomic operator action. Provider acquisition
stays in the worker. The UI never coordinates partial persistence stages.

- `packages/db`: tenant-scoped workspace reads and atomic internal writes.
- `packages/core`: pure classification, evidence and proposal calculations.
- `apps/worker`: provider adapters, resumable jobs and promotion.
- `apps/web`: presentation, validation at the HTTP boundary and export-only
  review interactions.

This hides transaction order, count reconciliation and provider state behind a
small interface. It also lets an unavailable provider render an honest empty or
blocked state without disabling the rest of the workspace.

## Candidate B — one Strategy workspace backend-for-frontend

A single web-side service would join groups, recommendations, creative, SQP,
dayparting and history into one response. This makes the first screen convenient
but exposes every domain's cadence and partial-data rules to one module. It also
turns a failure in one source into a failure of the entire operator workspace
and creates a wide interface that every new feature must change.

Rejected: the implementation is locally simple but the public surface is
shallow and the domains leak their timing rules into one coordinator.

## Candidate C — materialized operator cockpit

Every ingestion or recommendation event would update a materialized cockpit
document which the web tier reads in one query. Reads would be fast, but the
document would duplicate canonical facts and require invalidation across
different attribution and settling windows. Replays and partial failures could
leave the cockpit out of sync with the authoritative tables.

Rejected: it makes freshness a distributed invariant before the live adapters
and observation windows are stable.

## Synthesis decision

Use Candidate A. Keep one deep module per domain and add a small Strategy
Overview composer only after the component reads are stable. Borrow Candidate
C's performance goal by querying bounded, indexed scopes and measuring them,
not by adding a second canonical store.

The load-bearing choices are:

1. One recommendation run represents one optimization group. The existing
   `recommendation_runs.group_id`, role and snapshot columns become active.
2. Group settings and the full campaign assignment set are saved in one
   transaction. A rename cannot leave cadence or assignments behind.
3. Scheduled recommendation work selects enabled groups whose `next_run_at` is
   due. Profiles without groups retain the legacy profile-run path during the
   migration period.
4. Group runs read assigned campaigns only and use the immutable group snapshot
   for target ACOS, bid bounds and change caps.
5. Creative, SQP and Stream views read their authoritative fact tables. Missing
   live adapters appear as explicit data-source gates, not demo data.
6. Feature job types join the production queue only through one additive queue
   migration and dispatcher change. That shared lane is serialized after the
   product reads, and the migration is previewed before any hosted application.
7. Provider acknowledgement follows durable persistence and count
   reconciliation. Unknown creative joins, SQP rows or Stream payloads fail
   closed.

## Module map

```text
packages/shared
  existing optimization / creative / query / dayparting contracts

packages/db
  queries/optimization-groups.ts   atomic group + assignment operations
  queries/creative-performance.ts  existing Asset-ID read model
  queries/sqp.ts                   existing facts and vocabulary operations
  queries/dayparting.ts            existing hourly fact operations

packages/core
  optimization/*                   existing evidence and non-round logic
  query-intelligence/*             existing taxonomy / joins / proposals
  dayparting/*                     pure heatmap and proposal presentation helpers

apps/worker
  recommendations-run.ts           group-scoped runs and due scheduling
  sqp.ts                            existing resumable workflow; later queue adapter
  dayparting.ts                     existing normalizer; later SQS adapter
  creative-performance.ts          existing strict seam; later verified Ads adapter

apps/web
  optimizer/groups                 real settings and assignments
  creative-performance             Asset-ID table and drill-down
  query-intelligence               taxonomy, shares, vocabulary review and negatives
  dayparting                       heatmap, confidence and export-only schedules
  strategy                         stock, pacing, batches, groups and next decisions
```

## Work sequence

| WP | Scope | Shared file lane |
|---|---|---|
| 68 | Reconcile current release and fix status/design evidence | docs only |
| 69 | Optimization-group DB operations, group-scoped worker and UI | DB → worker → web |
| 70 | Creative, Query, Dayparting and Strategy read surfaces | DB/core → web |
| 71 | Feature-report queue/checkpoint migration and SQP dispatcher | shared/DB → worker |
| 72 | Marketing Stream SQS receiver, acknowledgement and settling scheduler | worker/deploy |
| 73 | Live-verified SB Video ad-to-asset adapter | ads-api → worker |
| 74 | Integrated performance, RLS, Playwright, deployed and provider crosschecks | verification |

## Tradeoffs accepted

- We accept several bounded route reads in exchange for keeping canonical data
  in its owning table.
- We accept a temporary legacy profile recommendation path in exchange for
  migrating accounts to groups without stopping existing schedules.
- We accept honest empty Creative, SQP and Dayparting screens until provider
  evidence arrives in exchange for never presenting synthetic or ambiguous
  rows as live performance.
- We accept serialized worker integration in exchange for one authoritative
  queue contract and no competing checkpoint models.

## Open gates and risks

- Which live Amazon SB report and creative-list combination proves a stable
  ad-to-creative-to-Asset-ID mapping on a real profile?
- Does the available SP-API connection include Brand Analytics report access in
  every intended marketplace?
- What Marketing Stream subscription and SQS queue are authorized for the first
  read-only profile?
- The queue-widening migration and any hosted data changes require an exact
  migration preview and operator authorization before application.

## Next implementation step

Implement the atomic optimization-group workspace and activate group-scoped
recommendation runs without adding a new migration.
