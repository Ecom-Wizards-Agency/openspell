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

Deployment activation and rollback remain attended operations. A private database singleton is the
one-way authority for the four-type report lane. They may switch a release only after the current
consumer is stopped, custody is drained and that authority is atomically fenced against every later
legacy claim.

## Decision summary

WP-194 adds a fresh random token to every claim made by the Evo report lane. Claim, defer, success,
retry and dead-letter transitions compare that token and the running state. Legacy completion and
timer-based stale recovery refuse token-bearing rows. A timed shutdown never releases fenced work;
elapsed time alone cannot prove that an Amazon request or report download stopped.

The migration starts with report-lane authority set to `legacy`. Both legacy claim overloads and the
fenced claimer lock the same private singleton. Activation takes the exclusive lock, refuses any
running or token-bearing report job, and flips authority once to `fenced`. After the flip, legacy
claimers and the legacy reaper cannot acquire the four report types. There is deliberately no reverse
RPC. This database barrier makes a late dormant Vercel invocation harmless instead of trusting a
command-line handoff assertion as the only ownership boundary.

Reporting v3 create failures after dispatch may have reached Amazon. Transport failure, server
failure, response-decoding failure and a duplicate response without an adoptable provider id become
one sanitized permanent ambiguity. The request is quarantined and never automatically created again.
A 425 carrying a provider id is adopted. A response that proves refusal before acceptance retains the
ordinary retry/dead-letter policy.

Receiving a provider id is not enough: the worker persists it with tenant scope, immutable-id CAS and
the exact queue claim while locking that queue row. It then reads the id back through the same claim
fence even when the write reports an error. A committed write whose reply was lost continues safely;
a pre-commit failure, conflicting id, replaced claim or unavailable readback strands fenced custody
for attended reconciliation and admits no poll.

Report downloads gain explicit compressed-byte, decompressed-byte, parsed-row, idle and total-time
limits before activation. The outer transport is aborted as soon as a local limit fires. Its
iterator/cancel operation must then finish inside a bounded cancellation deadline; an unproved cancel
is itself a custody failure. JSON parsing runs in a terminable worker thread with a heap ceiling and
returns acknowledged row chunks instead of cloning a complete provider document into the parent.
Both source rows and normalized parent accumulation have hard ceilings. Deployment restricts the lane
to one claim and one active job. Exceeding any limit aborts parsing without completing the report or
releasing its claim. The process exits with a non-restarting custody code, and startup refuses a
stranded claim. Values are justified against aggregate observed report sizes, never client data in
source.

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

public.get_report_worker_claim_authority()
  returns table (protocol text, epoch bigint);

public.activate_report_worker_fenced_claims()
  returns table (decision text, epoch bigint, unresolved integer);
```

Transition decisions are exactly `settled | stale_claim` and `deferred | stale_claim`. A stale decision
changes no row. Successful settlement clears claimant and token fields when it queues a retry, and
clears the token for terminal evidence. Successful defer retains current no-attempt-consumption
semantics and clears claimant and token fields.

The existing legacy finisher requires running tokenless custody. Legacy direct defer and release
updates include `claim_token is null`. `requeue_stale_sync_jobs` includes the same condition and, once
authority is fenced, excludes the exact report lane even from tokenless recovery. The fenced claim
function requires the complete four-type allowlist and is the only production path that sets a token.
Authenticated access is changed from table-wide `sync_jobs` SELECT to an explicit safe-column grant
that excludes `claim_token`; only service-role code can receive that capability.

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
custody. A quarantined claim remains in separate unresolved evidence even after its handler promise
ends, so a signal racing the fatal path cannot turn a custody failure into a clean exit.

The fenced deployment policy is exactly `creative.sync`, `report.request`, `report.poll` and
`report.fetch`. Configuration and creative preflight reject the existing five-type Unified Reporting
variant before startup; WP-194 does not silently widen the database authority contract.

An unknown report-create outcome is terminal queue evidence, not a retry. The corresponding report
ledger admits no poll job without a claim-confirmed durable provider id. Under fenced custody the
queue row remains running rather than being marked dead: dead-lettering would clear the capability and
make an uncertain provider effect replayable. Existing unfinished and dead report rows are not
automatically adopted or changed.

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
6. Stage Evo in standby. The transition helper independently hashes the nine trusted SQL function
   bodies and verifies their owner, language, volatility, leakproof/security mode, search path and
   exact ACL. It also verifies the authority table's exact named constraint types, columns and
   normalized definitions; a release-provided helper cannot certify itself.
7. Activation takes the database authority barrier after the drained snapshot, accepts only
   `activated | already_fenced` with zero unresolved custody, re-proves authority and custody, and
   then starts the single-flight consumer. Authority is never automatically reverted.
8. Candidate failure first proves the process inactive. It restores exact absence or a prior fenced
   release only when custody snapshots are unchanged. Ambiguous custody keeps the service stopped.
9. Rollback destinations must advertise the fenced protocol. Stop the source, prove it owns zero
   token-bearing claims, then switch. The invoking transition helper must be a clean checkout pinned
   to the exact live source revision before it may probe the database or custody; a clean stale helper
   is not authority. A pre-WP-194 release is not a compatible automatic destination.

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
- Provider-id persistence proves failure-before-commit, commit-before-reply recovery, conflicting-id
  refusal and stale/replaced-claim refusal under a real queue-row lock.
- Compressed bytes, decompressed bytes, parsed-row chunks, normalized parent accumulation, idle time
  and total time are bounded. Every limit promptly aborts the source, proves cancellation inside a
  bounded deadline or raises a stronger cancellation failure, settles no fenced transition and
  leaves custody for attended reconciliation.
- Report input, parsed, refused, promoted and loaded counts still reconcile exactly.
- Activation and rollback refuse unresolved claims, mutated SQL bodies/catalog metadata and
  incompatible revisions before switching.
- Readiness rejects count-preserving authority-constraint changes to a name, type, column, order or
  normalized definition before activation.
- Rollback rejects a clean transition-helper checkout whose revision differs from the exact live
  source revision before readiness, custody inspection or a release switch.
- First-activation failure restores exact service absence only while no fenced claim exists.
- Launcher restart refuses non-fenced authority or stranded custody with the systemd non-restart exit.
- Configuration and preflight reject any fenced claim set other than the exact four-type report lane.
- Quarantined completed handlers remain visible as unresolved shutdown evidence and force exit 78.
- Rejected, synchronously thrown, non-completing and non-terminal source cancellation all become the
  closed `source_cancellation` outcome; none can fall through to ordinary fenced retry settlement.
- After bounded health, database and worker shutdown completes, fatal and signal paths await one
  fixed-schema sanitized final audit write, including stream drain under backpressure, with its own
  deadline. Fatal custody then explicitly terminates with exit 78 even when an unproved transport or
  output stream leaves a referenced event-loop handle. A one-shot defensive stream-error observer
  remains installed through forced termination so a callback failure followed by an emitted error
  cannot replace custody exit 78 with an uncaught exit 1.
- Migration replay preserves every existing queue and report row and creates no automatic recovery work.
- ACL tests prove only `service_role` can call the fenced functions and authenticated callers cannot
  select `claim_token` while retaining the complete safe queue view.

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
