# WP-194 architecture: fail-closed report claim custody

Status: selected for implementation on 2026-09-02.

Base: `origin/main` at `637ee09f7f3ad899dd88651c48acdff69daf26a6`.

## Usage

Runtime callers keep one queue service. The deployment role selects its custody protocol; handlers
never see SQL rows or decide whether a stale claim is safe to replay.

```ts
const store = new PostgresWorkerStore(handle, undefined, {
  claimProtocol: config.deploymentRole === 'evo-report-lane' ? 'fenced' : 'legacy',
});
const worker = new SyncWorker({ workerId, store, jobTypes, adsApi });

await worker.start();
```

Each claimed job carries one opaque capability. Every state transition presents the same capability,
and active work is keyed by the capability rather than the reusable job id.

```ts
const jobs = await store.claim(workerId, capacity, jobTypes);

for (const job of jobs) {
  running.set(claimKey(job), run(job).finally(() => running.delete(claimKey(job))));
}

await store.finish(job, 'succeeded', { result });
```

Deployment activation and rollback remain attended operations. They may switch a release only after
the current consumer is stopped and the database proves it owns no unresolved fenced claims.

## Decision summary

WP-194 adds a fresh random token to every claim made by the Evo report lane. Claim, defer, success,
retry and dead-letter transitions compare that token and the running state. Legacy completion and
timer-based stale recovery refuse token-bearing rows. A timed shutdown never releases fenced work;
elapsed time alone cannot prove that an Amazon request or report download stopped.

Reporting v3 create failures after dispatch may have reached Amazon. Transport failure, server
failure, response-decoding failure and a duplicate response without an adoptable provider id become
one sanitized permanent ambiguity. The request is quarantined and never automatically created again.
A 425 carrying a provider id is adopted. A response that proves refusal before acceptance retains the
ordinary retry/dead-letter policy.

Report downloads gain explicit compressed-byte, decompressed-byte, idle and total-time limits before
activation. Exceeding a limit aborts parsing without completing the report or releasing its claim.
The values must be justified against aggregate observed report sizes, never client data in source.

No `packages/shared` contract changes. The migration, hosted apply, reduced Vercel deploy, Evo stage,
activation and any attended recovery are separate gates.

## Grounded problem and rationale

The generic queue proves atomic acquisition but not continuing ownership:

- `claim_sync_jobs` records only worker id and time and increments `attempts`;
- finish, defer and dead-letter mutate by job id alone;
- `requeue_stale_sync_jobs` requeues every running row older than 30 minutes;
- both pg_cron and the Vercel tick invoke that reaper;
- `report.fetch` has no heartbeat and currently buffers an unbounded download;
- shutdown releases claims after 25 seconds even though the handler may still execute;
- active promises are keyed only by job id;
- rollback restarts the destination without first proving the source drained;
- `report.request` can lose the database before persisting Amazon's accepted report id.

The original stale reaper was added so a killed worker would not strand a job forever. Its history
supports eventual recovery but contains no evidence that 30 minutes proves a live provider handler
has stopped. WP-03 also requires kill-and-resume without duplicate fact rows. WP-189 explicitly left
timed shutdown release and finalization outside its scope, so its green CI does not establish this
custody guarantee.

The strongest correct v1 policy is therefore fail-closed: retain liveness for legacy idempotent work,
but trade automatic recovery for safety on provider-sensitive fenced work. An operator may later
recover a stranded claim only after proving the prior process and provider outcome.

## Architecture candidates

### Candidate A: timer exclusions without claim tokens

Exclude the four report-lane types from the stale reaper and stop releasing them on shutdown.

This closes the observed automatic replay path but a stale handler can still finish or defer a row
after attended recovery reassigns it. Job id, worker id and `attempts` are not capabilities:
`attempts` can be decremented by defer and worker ids may repeat.

Decision: rejected.

### Candidate B: opaque fenced claims with manual stale recovery

Add one nullable claim token and fenced claim/transition functions. Legacy transition and reaper paths
cannot touch a non-null token. Fenced claims never expire automatically. Keep one queue and one report
workflow, and make deployment switching prove quiescence.

This is the smallest surface that invalidates stale owners across reclaim, restart and identical worker
ids. It preserves the current queue, report ledger, schedules, web cron and integration worker.

Decision: selected.

### Candidate C: leased claim-attempt ledger

Add a separate attempt table, opaque tokens, claim epochs, database-clock leases, heartbeat renewal and
fenced settlement. This makes long work automatically recoverable after a demonstrably expired lease,
but still cannot prove a paused provider request stopped. It adds renewal failure and expiry races to an
already live generic queue.

Decision: rejected for this slice. A future workflow may add attended recovery evidence without
weakening Candidate B.

### Candidate D: dedicated report workflow lane

Replace the four queue job types with private workflow heads, immutable events, deployment epochs and a
permanent one-send report-create effect ledger. This gives the strongest structural separation and the
cleanest long-term ownership model.

Decision: deferred. It changes admission, scheduling, create/poll/fetch continuation and deployment
authority together. WP-194 must first make the already staged runtime safe without migrating or
adopting hundreds of unresolved legacy ledger rows.

## Selected contracts

```ts
declare const claimTokenBrand: unique symbol;
type ClaimToken = string & { readonly [claimTokenBrand]: true };

type ClaimRef = Readonly<{
  jobId: string;
  workerId: string;
  token: ClaimToken;
}>;

type ClaimedJob = Readonly<{
  // existing queue fields
  claim: ClaimRef | null;
}>;

type ClaimProtocol = 'legacy' | 'fenced';
```

`claim` returns a non-null `claim` only in fenced mode. The token is accepted only as a dedicated SQL
parameter and is absent from logs, errors, job results and health. The database package brands and
validates it; application code can pass the capability but cannot mint one.

The database surface is additive:

```sql
alter table public.sync_jobs add column claim_token uuid;

public.claim_sync_jobs_fenced(
  p_worker_id text,
  p_limit integer,
  p_job_types public.sync_job_type[]
) returns setof public.sync_jobs;

public.finish_sync_job_fenced(
  p_job_id uuid,
  p_claim_token uuid,
  p_status public.sync_job_status,
  p_error text default null,
  p_result jsonb default null,
  p_retry_in interval default null
) returns table (decision text, status public.sync_job_status, attempts integer);

public.defer_sync_job_fenced(
  p_job_id uuid,
  p_claim_token uuid,
  p_retry_in interval
) returns table (decision text, status public.sync_job_status, attempts integer);
```

Transition decisions are exactly `settled | stale_claim` and `deferred | stale_claim`. A stale decision
changes no row. Successful settlement clears claimant and token fields when it queues a retry, and
clears the token for terminal evidence. Successful defer retains current no-attempt-consumption
semantics and clears claimant and token fields.

The existing legacy finisher refuses any row whose token is non-null. Legacy direct defer and release
updates include `claim_token is null`. `requeue_stale_sync_jobs` includes the same condition. The fenced
claim function is the only production path that sets a token.

## Runtime lifecycle

```text
queued, token null
  -> fenced claim -> running, fresh token

running, token T
  -> success/dead(T) -> terminal, token null
  -> retry/defer(T) -> queued, token null
  -> wrong/stale token -> unchanged
  -> elapsed time -> unchanged
  -> timed shutdown -> unchanged and quarantined
```

The running map key is `token` for fenced work and job id for legacy work. Starting a second attempt
for the same job therefore cannot overwrite the first promise. After shutdown begins, no new claim
starts. A graceful completion may settle normally. If the drain deadline expires, legacy work retains
its current release behavior while fenced work remains running and makes shutdown report unresolved
custody.

An unknown report-create outcome is terminal queue evidence, not a retry. The corresponding report
ledger records a fixed sanitized reconciliation marker and no poll job is admitted without a durable
provider id. Existing unfinished and dead report rows are not automatically adopted or changed.

## Deployment protocol

1. Merge source and exact-main CI. Do not apply a migration or deploy.
2. Reconcile hosted migration history. Production currently ends at `20260901010000`; WP-187
   `20260901020000` and WP-192 `20260901030000` are source-only predecessors.
3. Separately authorize and apply only the reviewed ordered migration set. Readiness proves the exact
   claim-token column, fenced signatures, grants and legacy guards.
4. Deploy an immutable Vercel revision whose report ownership can be reduced, record its deployment
   identity, reduce ownership, and wait until every pre-cutover invocation ends.
5. Stop the current report consumer and prove zero legacy running report claims and zero ambiguous
   in-flight create outcomes. The integration-only worker must have immutable disjoint provenance or
   remain retired for first activation.
6. Stage Evo in standby. Activation proves exact artifact, database contract, queue state and
   credential syntax before starting the fenced consumer.
7. Activation failure restores the exact prior state only before any fenced claim is acquired. Once a
   claim exists, both consumers stay stopped for attended recovery.
8. Rollback destinations must advertise the fenced protocol. Stop the source, prove it owns zero
   token-bearing claims, then switch. A pre-WP-194 release is not a compatible automatic destination.

The command-line confirmation flag is only an attended assertion. It never substitutes for database,
process and exact-deployment evidence gathered by the activator.

## Safety proofs and tests

- Two concurrent fenced claimers receive disjoint jobs and unique non-null tokens.
- Wrong, old and replaced tokens cannot finish, retry, defer or dead-letter.
- Manual attended requeue followed by reclaim invalidates the old token, even for the same worker id.
- Legacy finish, defer, release, Vercel sweep and pg_cron sweep cannot mutate token-bearing rows.
- The stale reaper retains its existing behavior for tokenless integration and web work.
- Active bookkeeping can represent two attempts for one job without overwriting either promise.
- Shutdown begins no later claim; timed shutdown never releases fenced custody.
- A create transport, server or decoding ambiguity produces no automatic second provider call.
- A 425 with an id is adopted once; a 425 without one is quarantined.
- Compressed bytes, decompressed bytes, idle time and total time are bounded and abortable.
- Report input, parsed, refused, promoted and loaded counts still reconcile exactly.
- Activation and rollback refuse unresolved claims and incompatible revisions before switching.
- First-activation failure restores exact service absence only while no fenced claim exists.
- Migration replay preserves every existing queue and report row and creates no automatic recovery work.
- ACL tests prove only `service_role` can call the fenced functions.

## Red-flag screening

- **Shallow module:** pass. Claim and transition methods hide atomic acquisition, token issuance,
  ownership checks, retry/dead policy and legacy coexistence.
- **Information leakage:** pass. Tokens, SQL rows and deployment internals do not cross into provider
  handlers, logs, health or shared contracts.
- **Temporal decomposition:** pass. One queue-custody boundary owns claim through settlement; download
  bounds stay with the transport/parser boundary.
- **Pass-through methods:** pass if the store converts closed SQL decisions into success or a sanitized
  `ClaimOwnershipLost`. A same-shape forwarding wrapper must be removed.

Reject implementation that adds tokenless settlement for fenced jobs, timer-based fenced recovery,
automatic adoption of legacy unfinished ledgers, blind report-create retry, unbounded download
buffering, process-clock ownership, or restart-based rollback without a drain proof.

## Tradeoffs accepted

- Fenced claims can remain stranded until attended recovery; safety wins over automatic liveness.
- Report creation may be falsely quarantined when Amazon never received it; no duplicate send wins over
  availability.
- The generic queue temporarily exposes legacy and fenced protocols; compatibility wins over a
  simultaneous replacement of scheduling and workflow storage.
- Recovery tooling remains a later separately reviewed operation; this slice proves ordinary runtime
  code cannot guess that a provider effect stopped.
