# WP-196 architecture: exclusive recommendation claim custody

Status: selected for implementation on 2026-09-02.

Base: `origin/main` at `0a7f5c856d448f275be732ea36c8a12e6167cbe6`.

## Usage

The operator still uses the WP-195 Campaign Optimizer:

```text
Campaigns
  [x] select matching eligible campaigns

Preview scope
  ( ) All eligible campaigns
  (x) Selected campaigns

  Run preview
```

Before the recommendation lane is ready, `Run preview` is visibly unavailable and the POST route
refuses without creating a batch, run, scope row or queue job. Once an exact compatible worker owns
the lane, the same action creates only read-only recommendation proposals. It does not call Amazon,
export a bulk file or apply an advertising change.

The runtime is a dedicated database-only service:

```text
WORKER_DEPLOYMENT_ROLE=evo-recommendation-lane
WORKER_CLAIM_PROTOCOL=recommendation-fenced-v1
WORKER_JOB_TYPES=recommendations.run
WORKER_CLAIM_BATCH_SIZE=1
WORKER_MAX_CONCURRENT_JOBS=1
OPENSPELL_WORKER_REVISION=<exact full Git object id>
```

It receives the credential for a purpose-built recommendation database principal and operational
configuration only. That principal has no `service_role` membership, bypass-RLS, table DML or Vault
function authority. Its dependency closure and service environment contain no Ads API, SP-API,
Amazon application or write-gateway credential.

## Decision summary

WP-196 gives `recommendations.run` its own database authority, its own one-job-type claimant and its
own immutable staged release. A queue claim carries the existing opaque `ClaimRef` through
`startRun`, `succeedRun` and `failRun`; every recommendation mutation revalidates the exact running
job, worker and token in the same transaction. Database triggers serialize old direct mutations
with activation and, after fencing, permit execution writes only through claim-bound functions
called by the narrow recommendation principal.

The authority transition has three explicit states:

```text
legacy / legacy admission
    -> legacy / blocked admission
    -> fenced / blocked admission
    -> fenced / scoped admission
```

The first state preserves current valid claim and admission behavior when the source migration is
merely applied. The invalid generic SQL recommendation scheduler is excluded in every state because
it cannot mint a run id or immutable scope; the readiness-gated TypeScript producer owns that job
type. Blocking admission lets existing legacy work drain without accepting another old job. The fenced transition
atomically prevents both legacy claim overloads and the generic stale reaper from acquiring
recommendation jobs. Scoped admission then permits only complete WP-195 scope-version-1 work.

The report lane remains exactly four job types. The active mixed integration service remains
available for Keepa, rank, economics and SQP jobs. Database routing, rather than stopping that
service or trusting an environment allowlist, prevents its old binary from claiming recommendations.

## Grounded problem and rationale

WP-195 closed the campaign and policy input boundary, but not the executor boundary:

- `RecommendationRunExecutionContext` currently carries only a job id;
- `startRun` verifies the queue row is running but not its `claimed_by` or `claim_token`;
- `succeedRun` and `failRun` mutate the run without rechecking queue custody;
- Vercel's default and reduced claim sets both include `recommendations.run`;
- the live mixed worker also requests `recommendations.run` and has no revision-stamped health;
- the fenced Evo report lane deliberately owns only Creative and Reporting v3 jobs.

A stale executor could therefore continue writing after losing queue ownership, and enabling the
WP-195 web route could overlap two different recommendation consumers.

The load-bearing history is:

- PR #69 established disjoint report ownership while deliberately retaining recommendations on
  Vercel. This proves the report split was not intended to absorb optimization work.
- PR #119 made report custody provider-safe with a private one-way authority and an exact four-type
  claim surface. Widening it would break that reviewed contract.
- PR #121 added immutable WP-195 scope and exact queue-job identity, but explicitly deferred the
  compatible claimant and exclusive handoff to a later package.
- `docs/deploy/always-on-worker.md` records the shared queue and historically overlapping consumer
  topology. Process configuration alone is not durable exclusion.

The design therefore places the exclusive boundary in PostgreSQL, where every claimant already
serializes, and keeps recommendation execution separate from provider-sensitive report custody.

## Architecture candidates

### Candidate A: independent non-expiring fenced recommendation lane

Add one private authority, hardcode one job type in its claimant, bind `ClaimRef` to every run write,
resume an unresolved claim only for the same stable worker identity and exact revision, and require
attended recovery for a lost host.

This is the smallest design that closes both old-consumer overlap and stale-writer mutation. It
reuses the proven opaque token representation without importing the broad `SyncWorker` dependency
graph.

Decision: selected as the base, augmented with the narrow-principal and direct-mutation barrier
required by adversarial review.

### Candidate B: fenced lane plus an immutable attempt ledger

Persist a separate row per claim attempt and fingerprint every settlement request so response-loss
replay returns `already_settled` or `request_conflict`.

This makes settlement history more explicit, but queue attempts, the unique opaque token and the
immutable recommendation/audit rows already make the required result decidable. The additional
mutable ledger and recovery surface do not close a missing correctness boundary for this slice.

Decision: reject the extra table and request protocol; retain its crash-injection and exact replay
proofs.

### Candidate C: renewable leases and swappable claimant slots

Register active and standby claimant instances, renew short leases and atomically switch a database
route between slots. Expired computations become harmless because every write is token-fenced.

This improves unattended cross-host failover, but requires duration calibration, renewal traffic,
heartbeat semantics and automatic recovery authority. The current deployment is one host and the
work is preview-only; an attended blocked-state recovery is safer and materially smaller.

Decision: reject leases and slot registry for WP-196; retain its separate admission barrier, exact
revision checks and compatible-only rollback rule.

## Public types and deep boundaries

`ClaimRef` remains owned by `@wizard-ads/db`; it is not duplicated in the frozen shared package.

```ts
export type RecommendationClaimAuthority = Readonly<{
  protocol: 'legacy' | 'fenced';
  admission: 'legacy' | 'blocked' | 'scoped';
  epoch: number;
  authorizedRevision: string | null;
}>;

export interface RecommendationQueuePort {
  authority(): Promise<RecommendationClaimAuthority>;
  resumeOwned(identity: RecommendationWorkerIdentity): Promise<readonly ClaimedJob[]>;
  claim(identity: RecommendationWorkerIdentity, limit: number): Promise<readonly ClaimedJob[]>;
  finish(claim: ClaimRef, outcome: 'succeeded' | 'failed' | 'dead'): Promise<void>;
  defer(claim: ClaimRef, retryIn: string): Promise<void>;
}

export interface RecommendationRunExecutionContext {
  claim: ClaimRef;
}
```

The dedicated runtime owns polling, single-flight capacity, resume-before-claim ordering, retry
classification, shutdown drain and settlement ambiguity. The database adapter owns authority,
claim and settlement transactions. The recommendation store owns run/scope/proposal transactions.
These are substantive boundaries rather than pass-through wrappers.

The stable worker id and full revision identify a resumable service release. The opaque claim token
never appears in an error, log, audit payload, health response or deployment artifact.

## Database contract

The additive source-only migration is:

```text
20260901060000_recommendation_claim_custody.sql
```

It depends on WP-194's `sync_jobs.claim_token` and WP-195's immutable scope schema. It does not edit
either merged migration.

It adds an execution-lineage column to `recommendation_runs`. New queue-backed runs write `queue`;
the N-gram human proposal path writes `human` only for a jobless, unscoped, immediately succeeded
negative-proposal run. Historical null lineage is fail-safe queue lineage for execution-mutation
purposes. A row is exempt as human only when its stored shape, web/user audit provenance and absence
of every `recommendations.run` job all close; a caller-supplied label alone grants nothing.
A deferred lineage validator permits the human transaction's run and recommendation inserts before
its audit row exists, then checks at commit that every proposal is a negative-keyword proposal, the
single run is jobless/unscoped/succeeded, and the exact `recommendation.proposed` web/user audit
closes. Any partial or mixed lineage rolls the complete transaction back.

Private authority shape:

```sql
create table app.recommendation_claim_authority (
  singleton boolean primary key default true check (singleton),
  protocol text not null check (protocol in ('legacy', 'fenced')),
  admission text not null check (admission in ('legacy', 'blocked', 'scoped')),
  epoch bigint not null check (epoch >= 0),
  authorized_revision text,
  updated_at timestamptz not null default now(),
  check (
    (protocol = 'legacy' and authorized_revision is null)
    or (protocol = 'fenced' and authorized_revision is not null)
  ),
  check (protocol = 'legacy' or admission <> 'legacy')
);
```

The one initial row is `legacy`, `legacy`, epoch zero and no revision. The table has no direct grant,
including to `service_role`.

For rollout compatibility, the same exact human shape is recognized when an older web revision
omits the new lineage marker. The marker is descriptive, never authority: a null-lineage run is
exempt only when its engine is `ngram-explorer`, its jobless, unscoped, same-instant succeeded
shape closes, and its negative-only proposal set and single web/user N-gram audit close at deferred
validation. A null-lineage white-box run remains queue lineage.

The migration also creates two non-login, non-inheriting, non-superuser, non-bypass-RLS roles:

```text
openspell_recommendation_worker    externally provisioned login, EXECUTE-only runtime principal
openspell_recommendation_executor  NOLOGIN owner of the narrow SECURITY DEFINER functions
```

Source creates the runtime principal as `NOLOGIN`; enabling login and writing or rotating its
password is a later narrowly allowlisted credential operation. It is never a member of
`service_role`. The executor owns no schema and receives only the exact relation/sequence privileges
needed inside the reviewed functions. The runtime receives schema usage and execute grants on the
recommendation functions only. It cannot execute Ads, SP-API, integration-secret, SP-write, report
or general queue functions and cannot directly select or mutate their tables.

The executor receives exact role-targeted RLS policies on every relation touched by its functions:
queue select/update; scoped-run and scope select; scoped-run update; recommendation insert/select;
execution-audit insert; and read-only profile, strategy, group, campaign and fact inputs. It owns no
table, and neither the executor nor runtime bypasses RLS. The executor-only policies are safe because
the executor is NOLOGIN and no caller can `SET ROLE` to it; the SECURITY DEFINER functions remain the
only entry points and close tenant/profile/job identity before reading or writing. Catalog tests
enumerate the exact policies, and cross-tenant RPC tests prove no argument can cross the claim's
tenant/profile. Table ownership, `service_role` membership and BYPASSRLS are explicitly forbidden.

Attended service-role functions expose only authority transitions:

```text
get_recommendation_claim_authority()
block_recommendation_admission(expected_epoch)
activate_recommendation_fenced_claims(expected_epoch, exact_revision)
authorize_recommendation_scoped_admission(expected_epoch)
rebind_recommendation_fenced_revision(expected_epoch, old_revision, new_revision)
```

The narrow runtime principal can execute only:

```text
get_recommendation_claim_authority()
claim_recommendation_jobs_fenced(worker_id, exact_revision, limit)
resume_recommendation_jobs_fenced(worker_id, exact_revision, limit)
read_recommendation_run_inputs_fenced(job_id, worker_id, claim_token, ...)
start_recommendation_run_fenced(job_id, worker_id, claim_token, ...)
succeed_recommendation_run_fenced(job_id, worker_id, claim_token, completion)
fail_recommendation_run_fenced(job_id, worker_id, claim_token, error)
finish_recommendation_job_fenced(job_id, worker_id, claim_token, outcome, ...)
defer_recommendation_job_fenced(job_id, worker_id, claim_token, retry_in)
```

These functions hardcode `recommendations.run` and accept no type list. The result-writing functions
own count closure and audit insertion rather than granting table DML to the login role. Inputs and
completion payloads are bounded and schema-validated on both sides of the RPC.

Every narrow function identifies the runtime by the unforgeable direct-login `session_user`; no
caller-settable GUC is identity or custody evidence. `PUBLIC`, `service_role`, `authenticated` and
`anon` have execute revoked from the narrow runtime functions. Tests use effective
`has_function_privilege`, including privileges inherited from `PUBLIC`, rather than inspecting only
explicit ACL rows.

WP-196 owns private SQL fingerprint helpers for batch and run scope. They reproduce the Node
canonical bytes exactly: approved domain line, UTF-8 octet-length prefix, value, newline, and
`COLLATE "C"` ordering before SHA-256. Neither role receives direct execute authority on the generic
helper. Node-to-SQL goldens prove batch and run output, including non-ASCII ids and unassigned-group
semantics.

### Serialization and legacy exclusion

Both legacy `claim_sync_jobs` overloads take a shared lock on the report authority and then the
recommendation authority. When the recommendation protocol is fenced they exclude
`recommendations.run` regardless of the caller's requested list. The stale reaper and tokenless
finisher follow the same exclusion. The existing report claimant and authority remain unchanged.

Authority mutations take the recommendation singleton exclusively. Therefore a racing legacy claim
or guarded mutation is wholly before or wholly after a state transition.

Fixed lock order is:

```text
report authority, when used
-> recommendation authority
-> sync_jobs row
-> recommendation_runs row
-> recommendation scope and result rows
```

The current run-first start transaction is changed to establish exact queue custody before locking
the run.

Three execution trigger surfaces close the old-binary gap. They always take a shared
recommendation-authority lock before an execution-state update to any non-human
`recommendation_runs` row, an insert into `recommendations` for such a parent, or an
execution-owned audit insert tied to such a run/recommendation. Queue lineage includes WP-195 scoped
runs, any run referenced by a current or settled `recommendations.run` payload, explicit `queue`
lineage, and every ambiguous historical null; it does not depend on the queue row still being active
or retained. Only the exact jobless human negative-proposal shape remains on its existing direct
path. In legacy mode the triggers preserve the existing service-role behavior. In fenced mode they
reject the direct service-role SQL used by old binaries and allow only the narrow runtime caller
inside the claim-bound executor functions. Migration installation itself takes the table locks
needed to ensure no pre-trigger mutation transaction survives unnoticed across installation.
Activation then waits behind every post-migration legacy execution transaction, including a
tokenless stale executor whose queue row was reaped and settled by somebody else.

### Admission closure

Admission uses two triggers. An immediate `BEFORE INSERT OR UPDATE OF
id, org_id, profile_id, job_type, payload` trigger on `sync_jobs` takes the authority shared lock
before the queue row is inserted or identity is changed and refuses blocked admission. A deferred
constraint trigger then validates the transaction-complete job/run/scope evidence at commit:

- `legacy` admission permits historical unscoped behavior and structurally complete WP-195 scoped
  work, including a producer revision that predates the lineage marker;
- `blocked` admission permits no new recommendation job;
- `scoped` admission requires exactly one tenant/profile-matching `recommendation_runs` row with
  explicit `execution_lineage = queue`, `scope_version = 1`, the exact `job_id`, valid scope
  count/fingerprint, strategy evidence and the complete WP-195 scope membership.

The distinction is deliberate: pre-marker WP-195 work remains valid while authority is legacy, but
the scoped gate accepts only the compatible producer revision. A still-running old web or mixed
worker therefore cannot create work after cutover even if its legacy weekly flag is enabled.

The trigger is deferred because WP-195 inserts the queue job before its run inside one transaction.
The immediate trigger retains the authority lock for the transaction, so the deferred validator
does not reverse the fixed lock order. It sees the complete transaction and prevents a late
pre-WP-195 producer from committing after the authority changes. Status, attempts, claim,
timestamps, retry and settlement updates do not invoke admission; they are governed by the claim
functions. The validator recomputes both run and parent-batch fingerprints with the private SQL
canonicalizer. It never truncates or silently repairs work.

Blocking admission refuses a new enqueue but does not alter an existing row. Fenced activation
requires zero queued/running recommendation jobs, zero token-bearing recommendation rows and no
scope/admission mismatch. Scoped admission is authorized only after exact worker health is proven.

## Attempt-bound recommendation execution and old-writer exclusion

The execution context carries the full `ClaimRef`. `startRun`, `succeedRun` and `failRun` each lock
and validate, in the same transaction:

1. the exact queue job id, type, tenant and profile;
2. `status = running`;
3. exact `claimed_by` and `claim_token`;
4. exact parsed payload and run/group identity;
5. the run's immutable scope, count, fingerprint, strategy and group snapshots.

No recommendation or audit row is written after a failed check. The TypeScript store no longer
issues direct execution DML; it calls the narrow start/succeed/fail functions and checks their exact
offered-versus-written result. Direct `service_role` execution DML acquires the authority lock and is
allowed only while protocol remains legacy. After fencing it fails before any run, recommendation or
audit change, even when an old tokenless process continues calculating after its queue row appears
drained.

A crash after the run succeeds but before queue settlement leaves the same non-expiring claim in
the database. On a same-revision restart, `resumeOwned` returns only exact claims for that stable
worker id and revision. The runner observes the already-succeeded run and settles that same claim.
It does not issue a second recommendation set.

If the host is lost, recovery is attended: block admission, stop or prove the claimant absent,
inspect the exact run/job state, and recover only the named claim through a separately reviewed
operation. WP-196 adds no timer or lease that can overlap a slow live process.

Retryable calculation failure marks the run failed under the current claim and defers the queue row
with that token. A later attempt receives a new token and may restart the same immutable run.
Integrity failure becomes terminal. Custody loss or ambiguous settlement stops new claims, degrades
health and exits nonzero.

## Runtime and health

`RecommendationClaimant` is not an instance of the provider-capable `SyncWorker`. Its source and
release closure contain only configuration, DB connection, recommendation calculation/store,
claimant loop and health modules. It starts no scheduler, observer, report pass, stale reaper,
Marketing Stream consumer or Amazon client.

The principal is an executable part of that boundary, not a future hardening item. Catalog tests
prove it is NOLOGIN after migration, has no role memberships or direct table privileges, and is
denied every Vault getter/revoker, provider/integration secret function, general/report queue
function and SP-write/outbox function. The deployment credential writer changes only LOGIN/password
for this named principal and returns no secret to the repository or agent process.

The public health shape is capability-free:

```ts
interface RecommendationWorkerHealth {
  status: 'standby' | 'ok' | 'degraded' | 'stopping';
  deployment: {
    revision: string;
    role: 'evo-recommendation-lane';
    claimProtocol: 'recommendation-fenced-v1';
    jobTypes: readonly ['recommendations.run'];
  };
  authority: {
    protocol: 'legacy' | 'fenced';
    admission: 'legacy' | 'blocked' | 'scoped';
    epoch: number;
    revisionMatches: boolean;
  };
  claimant: {
    ready: boolean;
    inFlight: 0 | 1;
    settlementFailure: boolean;
  };
}
```

Before it has ever matched authority, a candidate revision reports healthy, non-claiming `standby`
when the database is reachable but still authorizes legacy or a different exact revision. This
prebind state proves its manifest, principal, DB connectivity and the expected mismatch; the claim
RPC still returns no work. Once a process has observed its own exact fenced authority, later
authority/revision loss is degraded, returns HTTP 503 and exits without another claim. Database
failure or custody ambiguity is always degraded/503.

## Web readiness

One resolver combines strictly parsed deployment intent with fresh capability-free database
evidence. `OPENSPELL_RECOMMENDATION_LANE_READY` must be absent, `0` or `1`; when it is `1`,
`OPENSPELL_RECOMMENDATION_LANE_REVISION` must be an exact full object id and must equal the authority's
authorized revision.

- absent or `0`: Vercel retains its existing recommendation claim set, the WP-195 POST refuses with
  a controlled unavailable response and new scoped scheduling is disabled;
- `1` plus `protocol=fenced`, `admission=scoped`, and the exact expected authority revision: Vercel
  excludes `recommendations.run`, the POST is enabled, and producers create only scope-version-1
  jobs;
- malformed intent, stale `1`, blocked/legacy authority, revision mismatch or database outage: the
  UI and POST report controlled unavailability and create zero artifacts.

The server-rendered optimizer uses the same resolver for the button state. Both optimizer producers,
`POST /api/optimizer/runs` and `POST /api/optimizer/groups/run`, recheck immediately before enqueue.
The web cron's scheduled recommendation producer uses the same decision before
`enqueueDueRecommendationRuns`; the dedicated claimant starts no producer. Presentation is not
treated as authorization, and each disabled entry point creates zero batch/run/scope/job artifacts.
The still-active mixed worker wraps its optional weekly producer in that same shared DB readiness
resolver; absent/malformed intent or non-matching fresh authority invokes no enqueue method.

The report and recommendation gates are independent. Tests cover all four combinations, including
`entity.sync` remaining on Vercel and the report lane remaining exactly four types. The environment
gate controls feature presentation and modern callers; the database authority remains the durable
barrier against delayed old invocations.

## Module map

- `supabase/migrations/20260901060000_recommendation_claim_custody.sql`
- `packages/db/src/queries/recommendation-jobs.ts`, the RPC-backed run facade and focused tests
- focused custody changes in `apps/worker/src/recommendations-run.ts`
- `apps/worker/src/recommendation-lane/` for identity, queue adapter, claimant, health and main
- `apps/worker/src/deployment-role.ts` and web sync ownership resolution
- optimizer POST/UI readiness guard and focused tests
- dedicated `docs/deploy/` recommendation-worker contract, immutable installer, activator,
  verifier, rollback, readiness and fake-systemd tests
- `public.get_recommendation_cutover_evidence()`, a narrow read-only pre/postflight RPC covering
  authority, active queue counts and exact scope closure, plus the separate guarded scoped-admission
  script

No `packages/shared`, Ads API, SP-API, Amazon write, report authority or earlier migration file is
owned by this package.

## Staging, activation and rollback

Source merge, hosted migration, runtime credential provisioning, artifact staging, service
activation, web promotion, scoped admission and live QA are separate actions.

The installer stages an exact immutable revision only. It does not change `current`, install or
reload a unit, enable a service, or change service state.

Initial activation is:

1. under hosted-apply authorization, prove the ledger contains WP-187, WP-192, WP-194, WP-195 and
   WP-196 in exact order, apply, and prove the new principal remains NOLOGIN and source-inert;
2. under credential authorization, enable/rotate only the narrow principal through the guarded
   writer, then prove its deny matrix without exposing its credential;
3. under staging authorization, prove the immutable artifact, dependency closure and full revision;
4. under activation authorization, block recommendation admission with epoch compare-and-set;
5. let legacy work drain and prove zero queued/running/token-bearing rows while the mutation triggers
   prove no legacy execution transaction overlaps the authority lock;
6. install/start the dedicated service in standby and verify exact role, protocol, job set, narrow
   principal and revision;
7. activate fenced claims for that exact revision, then verify exclusive authority and healthy
   single-flight claimant while admission stays blocked;
8. under web-promotion authorization, deploy and verify the compatible web revision and set Vercel's
   claim intent while database admission remains blocked; the UI and POST must still be unavailable;
9. under scoped-admission authorization, compare-and-set admission to scoped only after exact web,
   worker and database evidence agrees, using
   `authorize-recommendation-scoped-admission-evo.sh --revision <full-live-revision>`;
10. under bounded-QA authorization, run one preview-only check and reconcile batch, child, scope,
    queue and proposal counts.

The mixed integration service stays active throughout. Its existing binary may continue asking for
recommendations, but PostgreSQL returns none after fencing.

After fenced activation, protocol never returns to legacy. Rollback may select only a revision that
implements `recommendation-fenced-v1`. A pre-WP-196 web revision is safe only with admission blocked
and is not a functional rollback. A failed activation re-blocks admission and leaves old claimers
excluded; it never restores legacy recommendation custody.

Fenced-to-fenced upgrade or rollback uses
`rebind_recommendation_fenced_revision(expected_epoch, old_revision, new_revision)`. The RPC permits
it only with admission blocked and zero running or token-bearing recommendation rows. The deployment
verifier separately proves the old service stopped before it calls the RPC. Queued scoped jobs remain
queued. The destination starts in explicit never-authorized candidate standby and proves the expected
old-authority mismatch before rebind. Under the exclusive authority lock, the exact revision and
epoch change atomically. A database refusal or proven rollback leaves the old revision authoritative
and admission blocked; the old compatible service may then restart. The destination must become
normal `ok` after a committed rebind and before admission reopens.

Activation and rebind transport errors are `unknown`, never ordinary failures. The runner stops both
claimant paths and performs bounded readback of protocol, admission, epoch and authorized revision.
Exactly the old tuple means the transition did not commit and the old path may be restored; exactly
the expected new tuple means it committed and only the new path may proceed. Any other tuple or
unavailable readback leaves admission blocked, both claimant paths stopped and requires attended
reconciliation. Retrying a CAS blindly or restarting the old service after a lost response is
forbidden.

## Executable proof plan

Disposable PostgreSQL proofs cover:

- migration replay on empty and populated state with exact row/policy/privilege conservation;
- both legacy claim overloads and the stale reaper excluding only recommendations after fencing;
- report claims remaining exactly four types;
- enqueue-versus-block and legacy-claim-versus-activate races having only serialized outcomes;
- activation refusing every queued, running, token-bearing or scope-mismatched recommendation row;
- blocked and wrong-revision claims returning none;
- concurrent fenced claimants producing one job and one fresh opaque token;
- immediate-gate/deferred-validation ordering accepting a complete WP-195 transaction and
  atomically rejecting late legacy, missing, extra, foreign or tampered scope evidence;
- Node-to-SQL batch/run fingerprint goldens proving bytewise UTF-8 canonical equivalence;
- stale token, worker, tenant, profile, run, group, payload, scope or fingerprint mismatch failing
  before recommendation or audit writes;
- reaped-and-successor-settled tokenless jobs whose original old executors write to scoped WP-195 or
  unscoped pre-WP-195 runs after activation being rejected by the database mutation barrier;
- unscoped human-requested negative proposals remaining writable and unchanged after fencing;
- incomplete, mixed or job-linked `human` lineage failing atomically at deferred validation;
- crash injection after claim, run start, proposal commit and lost settlement response preserving
  exact run/job/proposal counts; ambiguous start and success responses reconcile through an
  exact-claim failure/readback before queue settlement;
- same-revision resume settling the original token while a different identity or revision refuses;
- fenced-to-fenced rebind preserving queued work, refusing live claims and leaving the old revision
  authoritative on failure;
- commit-before-response-loss on initial activation and revision rebind reconciling exclusively to
  the database tuple without overlapping or blind retry;

Runtime and deployment proofs cover:

- one-job parsing, single flight, bounded polling, retry/dead classification and shutdown drain;
- no token in logs, health, errors or artifacts;
- no Ads API, SP-API, provider, export, apply or write-gateway dependency in the runtime closure;
- the runtime principal's exact NOLOGIN/membership/ACL/function deny matrix, including every Vault,
  integration-secret and SP-write surface;
- exact executor-only RLS policy catalog and cross-tenant denial through every narrow RPC;
- staging changing no current link, unit, enablement or service state;
- activation refusing the wrong manifest, revision, role, protocol, job set, authority epoch or
  health response;
- the legacy integration and report services remaining independent and available;
- every report/recommendation web gate combination preserving exact disjoint ownership;
- both optimizer POST routes and scheduled enqueue producing zero artifacts when readiness is false;
- compatible-only rollback and fail-closed recovery.

Full repository typecheck, lint, tests and hygiene then prove the source blast radius. No hosted
apply, staging, activation, deployment, provider call or Amazon mutation is part of this package.

## Tradeoffs and open risks

- A dedicated service, principal and authority add operational surface, but keep one-job custody and
  database authority separate from broad provider runtimes.
- Non-expiring claims trade unattended lost-host recovery for no stale-process overlap. Recovery is
  intentionally attended until live duration and failure evidence justify a lease protocol.
- A legacy job present at cutover can delay activation. The transition refuses rather than deleting,
  failing or adopting it.
- The RPC facade is larger than direct SQL, but makes narrow privilege, exact count closure and old
  service-role exclusion executable rather than aspirational.
- WP-195 and all earlier pending migrations are hard prerequisites; source availability is not live
  schema evidence.

## Red-flag screen

- Shallow module: pass. Admission, queue custody, run mutation and release verification each own a
  complete invariant.
- Information leakage: pass. The opaque token stays between database adapter, claimant and run
  store; public health is sanitized.
- Temporal decomposition: pass. Files follow authority/runtime/deployment boundaries, not rollout
  phases.
- Pass-through layering: pass. The claimant owns resume, claim, retry, shutdown and ambiguity policy;
  the adapters own transactional closure.
- Cross-boundary coupling: pass. Shared remains frozen, web has no provider import, report custody is
  unchanged and the new runtime is DB-only.
- Premature recovery machinery: pass after rejecting the attempt ledger, leases and claimant-slot
  registry from the larger candidates.
