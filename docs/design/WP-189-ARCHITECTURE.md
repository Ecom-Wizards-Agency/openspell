# WP-189 architecture: worker claim-loop resilience

Status: approved for implementation on 2026-09-02.

Base: `origin/main` at `a9d09c0f9cf69cecba77dff9de60fa99204754bb`.

## Decision summary

The always-on `SyncWorker.start()` loop will contain only direct PostgreSQL query-cancellation
failures with SQLSTATE `57014`. It will leave already claimed work running, record a sanitized
failure category, wait with bounded equal-jitter backoff, and try the same exact claim capability
again. Shutdown interrupts both the idle wait and failure backoff. Any successful claim RPC,
including an empty result, resets the failure state.

Each worker instance is one-shot. Shutdown permanently prevents a later start. A claim RPC that
began before shutdown is not canceled: shutdown waits for the complete claim pass, registers any
returned jobs exactly once, and only then drains handlers. No later claim RPC may begin.

The one-shot `drainOnce()` path remains fail-fast. Every other claim error remains fatal. This work
adds no job type, queue schema, provider handler, Sponsored Products write import, configuration
switch, migration, schedule, deployment activation or live call.

Three consecutive contained claim failures make `/healthz` return a sanitized degraded response.
Health is also degraded before start, as soon as shutdown begins, after stop, and after a fatal loop
exit. This prevents a process that is alive but not a ready queue consumer from authorizing a
handoff.

## Grounded problem

The legacy worker exited after `claimSyncJobs` received PostgreSQL SQLSTATE `57014` for a statement
timeout. The error propagated through:

```text
claim_sync_jobs SQL
  -> packages/db claimSyncJobs
  -> PostgresWorkerStore.claim
  -> SyncWorker.claimAvailable
  -> SyncWorker.start
  -> top-level worker process rejection
```

Systemd restarted the unit after 30 seconds. No job had been returned by the failed atomic claim,
so the failure did not authorize or begin a handler. The restart could nevertheless terminate
unrelated in-flight jobs already owned by the process.

Current tests exercise `drainOnce()` heavily but do not prove the long-lived `start()` loop under
claim acquisition failure. The current health response reports the worker process and optional
Marketing Stream consumer but cannot distinguish a healthy empty queue from repeated claim
failure.

PR #24 does not solve this incident. Its `start()` loop also lets `claimAvailable()` reject. Its
claim-token and crash-cut ideas are useful evidence for a future mutation outbox, but its shared
contracts, provider wiring, persistence, migration, configuration and active job handlers are
superseded and cannot be transplanted.

## Hard boundaries

1. Split capacity calculation, the raw claim RPC, and post-return task registration. Catch failures
   only around the long-lived raw RPC. Handler registration, handler execution, finalization,
   idle-wait and unrelated process failures must not be mislabeled as claim failures.
2. Classify only an object with a direct string `code` equal to `57014`. Do not inspect error text,
   traverse `cause`, or treat arbitrary transport/database errors as retryable.
3. `drainOnce()` remains unchanged and rejects a claim failure after one attempt.
4. A failed claim starts no handler, consumes no job attempt, calls no provider, and invokes no
   queue release or finalization method.
5. Existing in-flight handler promises remain owned and continue while claim acquisition backs
   off.
6. Retry always waits. It is single-flight, capped and interruptible; no `setInterval`, detached
   promise or overlapping claim pass is permitted.
7. WP-189's contained-failure logs and health expose only fixed categories, counts, timestamps and
   delays. They never expose database messages, statements, parameters, connection details or
   worker identifiers. Unclassified errors still reject unchanged at the existing process boundary.
8. No shared, database, API-client or migration contract changes are part of WP-189.
9. No Sponsored Products write facade, adapter or provider becomes reachable from an application.
10. Shutdown must settle an already-started claim pass before inspecting the handler set. Existing
    timed release behavior after handlers are registered is not redesigned here.
11. No-capacity is not a successful claim. It must wait without spinning and cannot reset a prior
    claim failure or its health evidence.

## Architecture candidates

### Candidate A: inline fixed-delay catch

Catch `57014` directly in `SyncWorker.start()`, log it, sleep for the ordinary poll interval, and
continue.

This is the smallest diff but has weak test seams, can log once per second during a sustained
outage, does not interrupt sleep promptly, and leaves health falsely ready.

Decision: rejected.

### Candidate B: worker-private claim-loop state machine

Add a small internal module that owns exact classification, backoff calculation, abortable delay
and sanitized claim-loop state. `SyncWorker` retains queue ownership, fresh capacity calculation,
allowlist and job execution. Health receives a fresh frozen snapshot and cannot mutate it.

This isolates policy from handlers, supports deterministic tests, bounds repeated database load,
and makes sustained claim failure observable without changing the queue contract.

Decision: selected.

### Candidate C: process-level supervisor

Wrap `worker.start()` in `main.ts`, catch its rejection, wait and restart the worker.

The supervisor cannot prove the rejection came from claim acquisition. It could retry a future
fatal start responsibility, races with `start()` resetting lifecycle state, and leaves queue
health outside the component that owns the claim.

Decision: rejected.

### Separate future boundary: Sponsored Products outbox supervisor

A mutation worker must not use the generic `sync_jobs` retry and release lifecycle. It needs a
dedicated operational delivery protocol with fresh claim tokens, exact-token acknowledge and
reschedule, database-clock eligibility, and a rule that a claim is never mutation authority. Only
a committed WP-188 dispatch ticket may authorize one WP-180 call; every uncertain post-reservation
state is reconciliation-only.

That protocol needs a separately reviewed, numbered database and worker package. WP-189 records the
requirement but implements none of it. WP-189 alone does not prove PR #24's remaining mutation
lifecycle behavior preserved and does not authorize closing it.

## Selected module contract

The worker-private module owns these concepts; it is imported by relative path and is not
re-exported from the application package:

```ts
type ClaimFailureKind = 'postgres_query_cancelled';

type ClaimLoopPhase =
  | 'not_started'
  | 'claiming'
  | 'idle_wait'
  | 'backing_off'
  | 'stopping'
  | 'stopped'
  | 'failed';

type ClaimLoopState = Readonly<{
  phase: ClaimLoopPhase;
  ready: boolean;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failureKind: ClaimFailureKind | null;
  retryInMs: number | null;
}>;

type ClaimLoopRuntime = {
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
  random(): number;
};

function claimRetryDelay(
  consecutiveFailures: number,
  pollIntervalMs: number,
  randomValue: number,
): number;
```

The controller accepts a runtime only in its internal constructor so its focused tests are
deterministic. `SyncWorkerOptions` gains no runtime or retry-policy field. Production uses an
abortable timer and `Math.random`; worker lifecycle tests use fake timers and a scoped random spy.
The existing injected `now()` clock supplies sanitized timestamps. `status()` returns a fresh,
frozen state object rather than the controller's live record.

The backoff window is:

```text
base   = clamp(pollIntervalMs, 1 second, 30 seconds)
window = min(30 seconds, base * 2^(consecutiveFailures - 1))
lower  = ceil(window / 2)
delay  = lower + round((window - lower) * normalizedRandom)
```

`consecutiveFailures` is truncated and clamped to at least one before exponentiation. A non-finite
or non-positive poll interval becomes one second. Finite random input is clamped to `[0, 1]`;
`NaN` and either infinity normalize to `0.5`. The formula returns integer endpoints exactly and
saturates at 30 seconds. Equal jitter keeps independent workers from retrying in lockstep while
guaranteeing a positive wait.

The current shared `claimAvailable()` responsibility is split before implementation:

```ts
private availableClaimBatchSize(maxJobs?: number): number;
private fetchClaimBatch(batchSize: number): Promise<readonly ClaimedJob[]>;
private startClaimedJobs(jobs: readonly ClaimedJob[]): void;

type LongLivedClaimPass =
  | { kind: 'no_capacity' }
  | { kind: 'rpc_success'; jobs: readonly ClaimedJob[] }
  | { kind: 'rpc_failure'; error: unknown };
```

Only the long-lived pass converts a rejection from `fetchClaimBatch()` into `rpc_failure` for exact
classification. It calls `startClaimedJobs()` outside that catch; a `57014`-shaped error there is
fatal. `drainOnce()` awaits `fetchClaimBatch()` raw and therefore retains fail-fast behavior.

The promise tracked as the active claim pass includes post-return registration. Shutdown awaits
that whole promise. A pass started before shutdown may return `[]`, return jobs which are registered
once, or reject; no pass starts after the phase becomes `stopping`.

## Lifecycle

```text
not_started
  -> start -> claiming
  -> shutdown -> stopped

claiming
  -> RPC success, rows -> reset failure state -> claiming
  -> RPC success, empty -> reset failure state -> idle_wait
  -> no capacity, no RPC -> preserve failure state -> idle_wait
  -> direct 57014 -> backing_off
  -> any other rejection or post-RPC failure -> failed; start rejects unchanged
  -> shutdown -> stopping; settle this claim pass first

backing_off
  -> abortable delay completes -> claiming
  -> shutdown aborts delay -> stopping -> stopped

idle_wait
  -> abortable delay completes -> claiming
  -> shutdown aborts delay -> stopping -> stopped

stopping
  -> active claim pass settles and returned jobs are registered once
  -> existing handler drain/timed-release contract completes -> stopped

stopped or failed
  -> start rejects; the instance cannot be resurrected
```

Only one `start()` call is permitted for a worker instance. Concurrent or sequential second starts
reject before another claim pass begins. Shutdown before start permanently moves the instance to
`stopped`.

### Exact state transitions

| Event | Phase | Counter | Failure kind / retry | Timestamps | Ready |
|---|---|---:|---|---|---|
| construction | `not_started` | 0 | null / null | both null | false |
| first start | `claiming` | unchanged | unchanged / null | unchanged | true when counter < 3 |
| contained RPC failure | `backing_off` | +1 | set / computed | failure set, success preserved | counter < 3 |
| backoff completes | `claiming` | preserved | preserved / null | preserved | counter < 3 |
| RPC success, rows or empty | `claiming` or `idle_wait` | 0 | null / null | success set, failure cleared | true |
| no capacity | `idle_wait` | preserved | preserved / null | preserved | counter < 3 |
| fatal loop error | `failed` | preserved | preserved / null | preserved | false |
| shutdown begins | `stopping` | preserved | preserved / null | preserved | false |
| shutdown completes | `stopped` | preserved | preserved / null | preserved | false |

## Health contract

`SyncWorker.status()` adds the claim-loop snapshot. `/healthz` publishes it under
`worker.claimLoop` without the internal worker ID.

Readiness is HTTP 200 only while the phase is `claiming`, `idle_wait` or `backing_off` and
`consecutiveFailures < 3`. `not_started`, `stopping`, `stopped` and `failed` are HTTP 503. A first or
second contained failure remains HTTP 200 but is visible in the body. An actual successful claim
RPC resets the counter and readiness immediately; a no-capacity pass does not. The existing
Marketing Stream degradation rule remains independent; either component can make the response 503.

No environment threshold is introduced. The three-failure rule follows the existing sustained
Marketing Stream health boundary and is reviewed as code, not deployment policy.

## PostgreSQL proof

The integration test uses independent database handles and a test-only trigger inside a disposable
migrated PostgreSQL database:

1. enqueue one synthetic job;
2. install a conditional `AFTER UPDATE` trigger for only that row; after the claim update begins,
   the trigger waits on a test advisory lock held by handle A;
3. set a short `statement_timeout` and record the backend PID on single-connection handle B;
4. start the real `SyncWorker.start()` path and observe handle B waiting on the advisory lock,
   proving execution reached the post-update trigger;
5. let statement timeout cancel the claim and assert the controller records direct SQLSTATE
   `57014` without starting a handler;
6. assert the row rolled back to queued with `attempts = 0`, no claimant and unchanged payload;
7. release the advisory lock, let the same worker retry, and assert one claim, one handler and one
   successful completion;
8. remove the test trigger/function and close both handles in `finally` cleanup.

This proves PostgreSQL rolled back a canceled claim after the row update had begun and proves the
real driver-to-controller retry integration. A relation-lock timeout or mock-only classifier is not
enough.

## Acceptance matrix

| Proof | Required result |
|---|---|
| Exact classification | direct `57014` from the raw RPC is contained; nested, message-only, post-RPC `57014`, `42501`, `40P01`, `08xxx` and unknown errors are fatal |
| One-shot preservation | `drainOnce()` rejects after exactly one failed claim and schedules no retry |
| Backoff | positive equal-jitter delays grow and cap at 30 seconds; no overlapping claim calls |
| Reset | any successful claim RPC, including `[]`, clears failure kind, failure timestamp, delay and counter; no-capacity does not |
| In-flight isolation | a later claim timeout does not cancel, release, repeat or suppress an already running job |
| Ownership | every retry uses the same worker ID, unchanged configured cap, freshly recomputed available capacity and exact job-type allowlist |
| Active claim | shutdown waits a pending claim returning empty, jobs, `57014` or fatal error; returned jobs register once and no later claim starts |
| Shutdown | idle/backoff waits abort promptly; shutdown-before-start and later/concurrent starts cannot resurrect the instance |
| Fatal path | an unclassified error rejects `start()` and is not sanitized into a retry |
| Logging | fixed category/count/delay only; raw error message and cause are absent |
| Health | pre-start/stop/fatal states degrade; failure 1–2 remains visible/ready; failure 3 degrades; actual RPC success restores readiness |
| PostgreSQL rollback | canceled claim leaves offered, claimed and attempt counts unchanged; later claim completes once |
| Blast radius | no shared/db/API/migration/main/config/deploy/job/schedule/SP-write activation change |
| Regression | existing two-worker 100-job no-double-claim and stale-recovery proofs stay green |

## Files and ownership

Implementation may change only:

- `apps/worker/src/claim-loop.ts` and its focused tests;
- `apps/worker/src/worker.ts` and lifecycle tests;
- `apps/worker/src/health.ts` and health tests;
- `apps/worker/src/worker.integration.test.ts` for the real rollback proof;
- `apps/worker/README.md` for operator-visible behavior;
- WP-189 design and work-package documents.

`packages/shared`, `packages/db`, `packages/ads-api`, `supabase/`, `apps/web`, `apps/mcp`, worker
configuration, `main.ts`, deployment scripts and root manifests are outside this package.

## PR #24 retention rule

WP-189 preserves the generic claim-resilience lesson but not PR #24's remaining claimant-fenced
mutation runtime. After WP-189 merges:

1. verify WP-179, WP-180, WP-187 and WP-188 still cover its contract, adapter, ledger and DB facade;
2. link this architecture as the durable home for generic claim-loop resilience;
3. create a separately numbered architecture-first successor for token-fenced SP outbox delivery,
   with the crash barriers and database acceptance proofs recorded above;
4. do not close PR #24 merely because WP-189 merged. Close it without merge only when the tracked
   successor contract is accepted as archival preservation or its runtime is merged.

## Activation statement

WP-189 is source hardening for an existing generic claim loop. It does not deploy or restart a
service, change queue ownership, apply a migration, host the WP-187 ledger, create an SP write job,
construct the WP-180 adapter, retrieve a credential, call Amazon, or authorize a mutation.
