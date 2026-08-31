# WP-181 — inert Unified Reporting dual-run architecture

Status: synthesized 2026-08-31. This design follows merged WP-173 and does not apply a hosted
migration, change a deployment, configure an advertiser binding, call Amazon, download a report,
or promote Unified data.

## Problem

Reporting v3 is OpenSpell's production report spine. A `report.request` job creates one
`report_requests` row, obtains an Amazon report id, and schedules polling and fetching. The fetch
path alone parses and promotes facts. Unified Reporting has a different account scope, query
model, batch response, and lifecycle. Its create call is non-idempotent and can be ambiguous after
a transport, server, or decoding failure.

Putting a Unified create directly into `report.request` is unsafe. A process can die after Amazon
accepts the request and before the id is stored; replaying the v3 job would then create a duplicate.
Letting a Unified persistence failure escape through the existing job handler can also fail the v3
ledger after its own report and poll job are already durable.

The current primary fixture is Amazon's pinned
[Unified API Postman collection](https://github.com/amzn/ads-advanced-tools-docs/blob/5c1c432c3dbe676a571780aa0c4d0217659a5f3a/postman/Amazon_Ads_Unified_API.postman_collection.json)
(collection blob `5e82aa48c4435d1ef96663442bf2efe1f2745093`). It proves create and retrieve
requests, indexed `207` outcomes, `PENDING` metadata, and `completedReportParts: null`. It does not
prove a completed-part shape, download contract, full status vocabulary, hourly period shape,
history limit, create idempotency key, or lookup that could reconcile an ambiguous create.

## Caller view

The v3 handler finishes its existing durable work first. The optional coordinator only admits a
separate sidecar; it never performs provider I/O in the v3 job.

```ts
const v3 = await requestAndScheduleReportingV3(jobId, profile, payload);

const unified = await unifiedDualRun?.admit({
  v3ReportRequestId: v3.reportRequestId,
  profile,
  reportType: payload.reportType,
  startDate: payload.startDate,
  endDate: payload.endDate,
});

return { ...v3, unified: unified ?? { kind: 'disabled' } };
```

Admission is a single database transaction that inserts a run, its first operation, and a queue
job. Failure to admit is caught and reported without changing the successful v3 result. No Amazon
call has happened at that point.

The new queue payload carries only durable identities:

```ts
type UnifiedReportAdvanceJob = {
  type: 'report.unified.advance';
  orgId: string;
  profileId: string;
  runId: string;
  operationId: string;
};
```

The worker dispatches it through one deep interface:

```ts
interface UnifiedDualRun {
  admit(input: UnifiedAdmission): Promise<UnifiedAdmissionResult>;
  advance(input: {
    jobId: string;
    attempts: number;
    profile: AdsProfileContext;
    payload: UnifiedReportAdvanceJob;
  }): Promise<Record<string, unknown>>;
  failTerminal(input: UnifiedReportAdvanceJob, reason: string): Promise<void>;
}
```

`advance` owns create fencing, retrieval, recovery, accounting, and successor scheduling. The v3
handler never sequences those stages.

## Selected shape

### One sidecar, one item

One eligible v3 `spCampaigns` request admits one Unified report definition for the same date
window, one advertiser account, and one provider batch item. The source-defined
`campaign-observation-v1` template uses only fields present in Amazon's create example:

```text
format: CSV
fields:
  advertiserAccount.id
  campaign.id
  campaign.name
  dateRange.value
  budgetCurrency.value
  metric.impressions
  metric.clicks
  metric.totalCost
  metric.purchases
  metric.sales
```

The package does not claim semantic parity with v3. The first dual run measures request
acceptance and metadata lifecycle only. Other report types are unsupported rather than mapped by
guesswork. A later template gets a new version; an existing version never changes meaning.

The worker adapter exposes a separate capability so the established v3 test doubles do not grow:

```ts
interface UnifiedReportingClient {
  createUnifiedReport(input: {
    profile: AdsProfileContext;
    advertiserAccountId: string;
    definition: UnifiedReportDefinition;
  }): Promise<
    | { kind: 'created'; metadata: UnifiedReportMetadata }
    | { kind: 'refused'; codes: readonly (string | null)[] }
  >;

  retrieveUnifiedReport(input: {
    profile: AdsProfileContext;
    reportId: string;
  }): Promise<
    | { kind: 'observed'; metadata: UnifiedReportMetadata }
    | { kind: 'refused'; codes: readonly (string | null)[] }
  >;
}
```

Each method invokes WP-173 with exactly one input and asserts `submittedCount === 1`, one outcome,
and index zero. Wire buckets and provider messages remain private. The adapter preserves
`UnifiedReportCreateAmbiguousError`; no worker layer converts it into a retryable create.

### Separate storage

`report_requests` remains unchanged. It retains its existing source constraint and remains the
only report ledger that can lead to facts or promotion.

WP-181 adds three tenant-scoped tables:

- `unified_reporting_bindings`: one explicit Unified advertiser-account id per profile, disabled
  by default. It is never inferred from `amazon_profile_id` or `amazon_account_id`.
- `unified_report_runs`: one immutable request and binding snapshot per v3 report request, with a
  local state, provider report id when known, opaque provider status, and observation horizon.
- `unified_report_operations`: one create operation and numbered retrieve operations. Every row
  has one input. A settled row has exactly one closed local disposition and one accounted result.

The closed local states distinguish `create_ready`, `create_dispatching`, `observing`,
`create_refused`, `create_ambiguous`, `retrieve_refused`, `provider_status_observed`,
`contract_blocked`, `observation_horizon_reached`, `paused`, and `local_failed`. Provider status is
stored separately as an opaque bounded string; it is not cast into this state vocabulary.

Operation dispositions distinguish provider success, indexed refusal, create ambiguity,
transport failure, invalid response, local refusal, and interrupted dispatch. Raw response bodies,
raw provider messages, tokens, and account rosters never enter logs or fixtures. An account-
mismatched create stores only the invalid-response class; its foreign report id and status are
discarded.

### Module map

```text
packages/shared/src/jobs.ts + unified-reporting.ts
  queue payload, durable state and accounting contracts
            |
            v
packages/ads-api/src/unified-reporting.ts
  existing provider-native codecs and ambiguity classification
            |
            v
apps/worker/src/ads-api.ts
  profile/connection routing and exact one-item adaptation
            |
            v
apps/worker/src/unified-reporting.ts
  feature admission, template choice, state machine, recovery policy
            |
            v
apps/worker/src/unified-reporting-store.ts
  invariant-completing transactions and successor queue insertion
            |
            v
packages/db/src/schema + one additive Supabase migration
  bindings, runs, operations, enum label, RLS and checks
```

Provider definitions stay in `packages/ads-api`; they are not moved into `shared` merely because
the worker consumes them. The database stores the fixed definition version, not an arbitrary wire
query document.

## State machine and crash proof

Admission occurs only after the v3 report id and first v3 poll job are durable.

```text
v3 ready and eligible
  -> run(create_ready) + create operation(ready) + advance job

create ready
  -> atomic create_dispatching fence
  -> one application-level create send at most
     -> created: settle + store report id + create retrieve operation/job atomically
     -> indexed refusal: settle create_refused
     -> ambiguous/unknown post-fence error: settle create_ambiguous

retrieve ready
  -> dispatching
  -> idempotent retrieve
     -> PENDING: settle + create next retrieve operation/job atomically
     -> another status: settle provider_status_observed; stop without interpreting it
     -> indexed refusal: settle retrieve_refused
     -> transport failure: settle + schedule another bounded retrieve
     -> parse/contract failure: settle contract_blocked
```

Recovery rules are conservative:

- A crash before the create fence leaves a ready operation that may be claimed once.
- A replay that finds `create_dispatching` records create ambiguity and never calls create. This
  includes the false-ambiguity window where the crash happened before a byte was sent.
- A late create result may settle only with the same dispatch token and only before a conflicting
  settlement. It can strengthen ambiguity to a known result but cannot initiate another call.
- A replay that finds a retrieve dispatch in progress settles that operation as interrupted and
  creates a successor. Retrieve is idempotent, so the successor may read again.
- A settled operation and its successor job commit together. Replay after that transaction is a
  no-op.
- At no point does the sidecar update `report_requests`, facts, promotion watermarks, or coverage.

The honest guarantee is at-most-one application-level Unified create attempt, not exactly-once
provider creation. Without a provider idempotency key or reconciliation endpoint, exactly once is
not available.

Retrieval uses a local 5, 10, 20, then 30 minute bounded cadence and a four-hour observation
horizon. Those are resource controls, not claims about Amazon's SLA. Exactly `PENDING` is the only
status that schedules another observation because it is the only lifecycle value in the pinned
primary fixture. Any other parsed status is stored without interpretation. A non-null completed
part remains a contract failure in WP-173 and ends this package's observation; it does not trigger
a download.

## Feature and deployment gates

Source is inert unless all gates agree:

1. `OPENSPELL_UNIFIED_REPORTING_DUAL_RUN_READY` is exactly `1`; absent or `0` performs no binding
   read, row insert, queue insert, or provider call.
2. The process is the exclusive `evo-report-lane` and `OPENSPELL_EVO_REPORT_LANE_READY` is `1`.
3. `WORKER_JOB_TYPES` exactly matches the expanded Evo set, including
   `report.unified.advance`.
4. The deployment-only profile allowlist is non-empty, canonical, and duplicate-free.
5. The exact profile has an enabled database binding.
6. The source report type is `spCampaigns` and has the fixed evidence-backed template.

The binding is re-read immediately before each provider call and acts as a dynamic kill switch.
Disabling it pauses queued work without touching v3.

Regional provider capacity is acquired before that re-read and dispatch fence. The fence uses a
nonblocking row lock plus sidecar-local lock and statement timeouts, so contended database work
cannot monopolize Amazon capacity. The permit is released immediately after the provider outcome
and before durable settlement.

The v3 ledger remains the parent lifecycle. Deleting a `report_requests` row cascades only its
Unified run and operations; it never fails because a sidecar exists, and the independent queue
ledger remains intact. Unified dispatch jobs otherwise follow the existing `sync_jobs` retention
contract: successful queue-ledger rows are not deleted. If a retained advance job is claimed after
its parent was deleted, it closes as a local no-op with zero provider calls.

The additive migration does not build composite indexes on the populated `report_requests` or
`sync_jobs` ledgers. Primary-key foreign keys preserve parent existence. Child scope checks lock
the selected parent row while validating exact org/profile identity, and parent guards reject
later tenant-scope changes as invalid for these immutable ledgers, whether or not a sidecar already
exists. This avoids a write-conflicting full-table index build in the hosted rollout while keeping
concurrent cross-tenant drift database-invalid.

The remaining parent-table DDL is metadata-only and runs with a five-second lock timeout. A hosted
apply that cannot acquire its brief lock fails for a later low-traffic retry instead of waiting
behind the live queue. WP-181 does not apply it to a hosted database.

The current four-type Evo claim contract remains valid while the Unified gate is off. New source
accepts the four-type base set when disabled and requires the five-type expanded set when enabled.
Vercel's reduced claim set remains unchanged and contains no Unified job.

No database trigger creates sidecars. A trigger failure would roll back the v3 ledger insert, and
a binding-only trigger would bypass the environment gate. No queue-wide protocol column is added
in this slice. Before activation, the operator must prove that every running worker uses an exact
filtered claim set and that no old or unrestricted worker can claim the new job type. If that
cannot be proved, activation stays blocked and queue protocol fencing becomes a separate package.

Safe rollout is schema, inert source, exact worker ownership, explicit bindings, bounded allowlist,
then the gate. Safe rollback first disables every binding while the five-type worker remains live,
then drains or quarantines the now-paused sidecars, and finally changes the gate to `0` and the
claim set to four types in the same deployment update. A gate-off five-type drain mode does not
exist. WP-181 performs none of those hosted actions.

## Accounting and tests

Database checks and shared schemas enforce:

- one run per v3 request;
- one create operation per run;
- unique retrieve sequence per run;
- one input per operation;
- zero dispositions while ready or dispatching;
- exactly one disposition for every settled operation;
- a provider report id only after a known create success;
- non-negative and reconciled operation counts;
- matching org and profile scope across binding, run, operation, queue job, and v3 request.

Focused tests must prove:

- absent/zero/malformed gates and missing/disabled bindings make zero Unified calls;
- v3 completes its existing request/poll path when admission, create, retrieve, or persistence is
  refused, ambiguous, interrupted, or failed;
- concurrent create claims produce one dispatch winner and fake-provider create calls never
  exceed one;
- crashes on both sides of every create fence never cause a second create;
- each accepted `PENDING` observation atomically creates one successor;
- retrieve interruption and transport failure remain safely replayable and fully accounted;
- malformed indexed results, wrong report ids, non-null parts, and unrecognized statuses fail
  closed without downloads or promotion;
- source inputs equal provider success, refusal, ambiguity, transport, invalid, local, and
  interrupted dispositions for every settled operation;
- RLS, tenant/profile foreign keys, and service-role-only lifecycle writes hold in disposable
  PostgreSQL tests;
- old four-type and new five-type deployment policies are accepted only in their matching gate
  state, and Vercel/Evo claim sets remain disjoint.

Repository typecheck, lint, tests, hygiene, migration reset, and blast-radius checks remain the
pre-merge gate.

## Alternatives and red-flag screen

Three independent candidates were compared. The selected design takes the separate sidecar and
crash fence from the adversarial candidate, the one-item accounting from the testability
candidate, and the narrow metadata-only boundary from the minimal candidate.

Rejected shapes:

- Inline create/retrieve in `report.request`: smaller, but recovery and terminal failure can leak
  into v3.
- Reuse `report_requests` or `report.poll`: conflates independent provider authority and violates
  the table's v3-only constraints.
- Database-triggered sidecars: atomically convenient, but trigger failure can block v3 and the
  trigger cannot see the deployment gate.
- Queue-wide worker protocol fencing: protects against an old unrestricted worker, but changes
  every claim path. Exact filtered ownership is a required activation proof; protocol fencing is
  a redesign trigger if that proof is unavailable.
- Provider batching: expands one ambiguous send across several v3 requests and needs a second
  partial-recovery protocol.
- Arbitrary query JSON in tenant configuration: moves provider protocol into storage and makes a
  supposedly comparable run mean whatever was entered.

Red-flag result:

- The module is deep: `advance` hides admission, fencing, recovery, polling, and accounting.
- Provider wire information remains in `ads-api`; storage and deployment details do not leak into
  the client.
- The coordinator is organized around Unified lifecycle knowledge, not load/transform/save
  stages.
- Store methods complete atomic invariants; the one-item adapter adds accounting and error policy
  rather than forwarding calls.

Redesign if primary evidence supplies create idempotency, safe reconciliation, completed-part and
download shapes, a full lifecycle vocabulary, an authoritative account binding, comparable query
definitions for another grain, or a batch limit. Scrap the shape if implementation repeatedly
requires v3 status changes, arbitrary query escape hatches, or more than the one queue capability
described here.
