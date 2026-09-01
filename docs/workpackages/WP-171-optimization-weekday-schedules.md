# WP-171 — Optimization weekday schedules

## Problem

An interval such as “7 days” does not tell an operator which day a group runs, and adding elapsed
UTC days drifts away from a profile-local calendar across daylight-saving transitions. The existing
system already indexes `next_run_at`, stores a profile IANA timezone and preferred local sync hour,
and gates scheduled recommendation previews behind an environment flag. The replacement must keep
those operational properties, preserve historical group snapshots, and must not make automatic
Amazon application possible.

This package supersedes the implementation outline in WP-90. The older brief remains historical.

## Usage (caller’s view)

The web caller sends one canonical, non-empty weekday list:

```ts
await saveOptimizationGroup(database, {
  orgId,
  profileId,
  actorId,
  settings: {
    ...policy,
    reviewSchedule: { version: 2, weekdays: ['monday', 'thursday'] },
  },
  campaignIds,
});
```

The worker asks only for due groups. PostgreSQL resolves and advances `next_run_at`; the worker
stores the returned group policy and this immutable context on the run:

```ts
{
  version: 2,
  trigger: 'scheduled',
  profileTimezone: 'Europe/Berlin',
  weekdays: ['monday', 'thursday'],
  localHour: 4,
  dueAt: '2026-09-03T02:00:00.000Z',
  evaluatedAt: '2026-09-03T02:00:01.000Z',
}
```

A manual preview records `trigger: 'manual'` and remains available regardless of the current
weekday. The existing policy, stock, open-run and observation gates still apply.

## Shape

- `OptimizationGroup` remains the unchanged v1 interval contract for additive compatibility.
  `ScheduledOptimizationGroup` is the current version-2 mutable contract and contains a version-2
  review schedule. `OptimizationGroupSnapshot` is the explicit current-or-legacy history union.
- `normalizeOptimizationGroupSnapshot` is the one decoder for persisted history. Callers do not
  infer versions from arbitrary fields.
- The database stores canonical ISO weekday integers (`1` Monday through `7` Sunday), while the
  public contract uses readable weekday names. Shared conversion functions own that boundary.
- `app.next_optimization_review_at` is the only next-due authority. It constructs local calendar
  candidates in the profile IANA timezone, then converts those candidates to instants. The worker
  never adds an interval to UTC.
- The profile’s existing `preferred_sync_hour`, with a 04:00 local fallback, is also the review
  hour. A profile timezone or preferred-hour change recomputes all enabled group schedules.
- `next_run_at` remains the indexed due cursor. The legacy `cadence` column remains dormant for
  rollback and is not read by version-2 scheduling.
- `recommendation_runs.schedule_context` is nullable only for historical rows. Every version-2
  group run requires it when decoded.
- The worker’s scheduled-run environment gate remains default-off. This package creates
  recommendation previews only and invokes no Amazon mutation path.

This is a deep interface: callers choose weekdays or ask for due work; PostgreSQL hides calendar,
timezone, DST, retry advancement and profile-change recomputation.

## Synthesis decision

The selected design keeps an indexed materialized instant with a database-owned calendar function.
It combines the smallest caller surface (weekday names only) with replayable run context and a
versioned historical decoder. It rejects both a worker-owned clock, which would duplicate DST rules,
and a JSON-only group schedule, which would weaken constraints and indexing.

## Migration and evidence

- Legacy daily-or-faster intervals become all seven weekdays.
- Longer intervals anchor to the existing `next_run_at` weekday in the profile timezone.
- Intervals longer than one day but not exactly seven days are inherently ambiguous under a
  weekday model. The migration retains a per-organisation `ambiguousIntervals` count in the audit
  log for operator review instead of silently claiming semantic parity.
- Existing group snapshots without a version or schedule remain valid legacy snapshots.
- No hosted migration is part of this package. Production application requires a separate exact
  target-and-file authorization.

## Tradeoffs accepted

- We accept sharing the profile sync hour in exchange for avoiding a second time-of-day setting and
  an additional source of schedule drift.
- We accept retaining the unused interval column in exchange for a reversible schema rollout.
- We accept one nullable context column for historical rows in exchange for decoding old evidence
  without fabricating schedule facts.

## Alternatives considered

- Compute due weekdays in the worker: rejected because every worker replica would need identical
  DST logic and profile edits could leave the indexed cursor stale.
- Store a cron expression: rejected because it exposes provider syntax to the UI and makes canonical
  validation, migration explanation and operator comprehension worse.
- Derive due state at query time without `next_run_at`: rejected because it removes the bounded due
  index and makes concurrent `skip locked` scheduling more expensive.

## Acceptance evidence

- Shared tests cover canonical weekday ordering, ISO conversion and legacy snapshot decoding.
- Migration tests cover schema, immutable clock authority, profile-trigger wiring, DST boundaries,
  canonical constraints and RLS isolation.
- Worker integration tests cover due selection, immutable scheduled context, retry idempotency,
  next-occurrence advancement, manual weekday bypass and disabled-group exclusion. Deterministic
  two-connection tests also prove the profile-before-group lock order against manual previews,
  optimization-group saves and profile schedule edits.
- Web tests cover native weekday controls, non-empty selection, timezone/hour/next-due copy and
  viewer restrictions.
- The optimization-group browser workflow owns a fresh authenticated Next process. Adding its
  route graph to the already broad auth suite exhausted the shared runner's four-gigabyte heap;
  the isolated suite keeps that infrastructure failure separate from product assertions.
- Account-scope navigation owns another fresh process because it deliberately compiles every
  operator route. This keeps its same-document proof independent of the broad auth route graph.
- The optimizer preserves an explicit preset id. Calendar and rolling presets can resolve to the
  same dates at a month boundary; identical dates must not silently relabel “Month to date” as
  “Last 30 days.”
- Full typecheck, lint, tests, hygiene and web build must pass before merge.

## Production gate

Apply `20260830180000_optimization_weekday_schedules.sql` to a named hosted project only after the
operator approves that exact target and file. The migration keeps a transaction-scoped five-second
lock timeout through Supabase's ledger write and aborts behind live contention. Before application,
preview the daily-or-faster, anchored and ambiguous counts. From the start of the migration, freeze
optimizer-group edits and all manual or scheduled recommendation-job creation. The pre-weekday web
revision remains read-compatible with the additive columns, but its legacy write path omits
`review_weekdays` and cannot preserve an operator's intended cadence under the new model. A
pre-weekday worker also cannot decode a version-2 group snapshot. After the schema postflight,
deploy and prove the exact weekday-aware revision on every job-claiming worker, then deploy the
weekday-aware web revision, and only then remove the freeze. Do not deploy either weekday-aware
consumer before the migration because its reads require the new columns. Automatic scheduled
recommendation execution remains disabled until its existing environment gate is deliberately
enabled; Amazon apply cadence is a separate guarded system.
