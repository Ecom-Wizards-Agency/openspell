# WP-191 architecture: token-fenced Sponsored Products outbox protocol

Status: selected architecture for an architecture-only package. Date: 2026-09-02.

Base: `origin/main` at `f888ea89f58aa3e15ccd15b50370e7476d12479b`.

## Decision summary

Preserve `public.sp_write_outbox` as the immutable WP-187 wake. A later source package will add a
separate service-only delivery head and an immutable transition journal in the private `app`
schema. Claiming, renewal, deferment and completion use database time, a monotonically increasing
claim epoch and a fresh opaque token. Every state change compares the exact current epoch and token
digest and appends one journal event in the same transaction.

The delivery token is custody, not mutation authority. A dispatch claimant may acquire a WP-187
dispatch lease or reach reservation only through new claim-bound wrappers. Each wrapper locks the
owning organisation before the delivery head, proves the exact live dispatch claim, invokes the
canonical function and revalidates custody before return. The existing tokenless lease and
reservation functions lose their `service_role` execute grants. Only the original committed WP-188
dispatch ticket can authorize one WP-180 mutation attempt.

Provider-result, recovery-result and observation persistence remain independent of delivery
custody. They must continue after claim expiry, worker replacement, gate closure, authorization
expiry or credential rotation. A lost reservation response remains reconciliation-only, and a
reclaimed dispatch wake with an existing intent never receives another provider ticket.

WP-191 freezes this protocol in documentation only. It creates no migration, table, function,
facade, job, worker, provider import, hosted schema, deployment or activation. Source implementation,
worker coordination and activation belong to separately numbered packages.

## Grounded boundary

Current main already provides the domain safety layers:

- WP-179 freezes exact plans, approvals, provider intents, results, observations and closed
  accounting.
- WP-180 provides an inert one-attempt provider adapter with complete indexed accounting.
- WP-187 persists immutable evidence, creates `dispatch` and `observe_and_recover` wakes, owns the
  one permanent action-resolution fence and never stores outbox delivery state.
- WP-188 exposes staging and runtime database capabilities under the explicit
  `@wizard-ads/db/sp-write-persistence` subpath. Its opaque dispatch ticket is the only in-process
  mutation authority.
- WP-189 hardens the generic `sync_jobs` claim loop but explicitly excludes mutation outbox
  ownership.

Current main also proves the negative boundary: no application imports an SP-write subpath,
`JobPayload` and `sync_job_type` contain no SP-write member, no worker handler can reach WP-180, the
WP-187 migration is unhosted, and every environment/profile/runtime gate remains closed.

PR #24 at archival head `78e718b4e08b880843cda2fae16045db6d131037` contains the remaining
historical lesson: a worker identifier alone is not ownership. Fresh claim tokens, exact-token
settlement and stale-owner rejection must survive. Its shared contracts, provider code, generic
queue migration, mutable execution lifecycle, process-clock recovery and post-intent retry behavior
are superseded and must not be transplanted.

## Usage from the future caller's view

This sketch shows the intended package boundary, not code added by WP-191:

```ts
import {
  createSpWriteOutboxLedger,
  createSpWriteRuntimeLedger,
} from '@wizard-ads/db/sp-write-persistence';

const outbox = createSpWriteOutboxLedger(db);
const runtime = createSpWriteRuntimeLedger(db);

const batch = await outbox.claimAvailable({
  claimantId,
  kinds: ['dispatch'],
  limit: 1,
  leaseSeconds: 120,
});

for (const claim of batch.claims) {
  if (claim.kind !== 'dispatch') continue;
  const lease = await runtime.acquireDispatchLease({
    claim,
    routeKey,
    leaseSeconds: 120,
  });
  if (lease.kind !== 'acquired') continue;
  const reservation = await runtime.reserveProviderCall({
    claim,
    observation,
    intent,
  });

  if (reservation.kind === 'dispatch_once') {
    // The claim did not authorize this call. The committed ticket did.
    const result = await adapter.executeOneAttempt({
      plan,
      intent: reservation.ticket.intent,
      resultId: reservation.ticket.resultId,
    });
    await runtime.appendProviderResult(result);
  }

  // PostgreSQL, not the caller, decides whether this wake is complete.
  await outbox.completeClaim(claim);
}
```

The claim handle is opaque and non-serializable. It carries exact wake identity, claim epoch and
timestamps while keeping the raw token private to the DB facade. It cannot construct, recover or
replace a `SpWriteDispatchTicket`.

## Hard boundaries

1. The WP-187 outbox remains immutable evidence. Delivery state never becomes a column on it.
2. Delivery relations are private operational state, not approval, accounting, result or mutation
   evidence.
3. Every claim gets a fresh token and a strictly increasing epoch, including takeover by the same
   claimant identifier.
4. Claim, expiry, renewal, deferment, completion and recovery eligibility use PostgreSQL time after
   required locks. Process time is never authority.
5. Renew, defer and complete require the exact current token and epoch. A stale or replaced token
   changes nothing.
6. Dispatch-lease acquisition and reservation require an exact live dispatch claim in their
   transactions. Both old tokenless service-role entrypoints are revoked.
7. Claim expiry after committed reservation does not invalidate a dispatch ticket or block result,
   recovery-result, late-audit or observation persistence.
8. A committed intent permanently forbids redispatch. Reservation uncertainty is reconcile-only.
9. Outside deliberate tenant purge, unresolved work is never dead-lettered away. Backoff changes
   only `available_at`; it does not alter immutable evidence or derived completion. A guarded purge
   may cascade pending observation delivery after a durable result; that is the sole deletion
   exception and is not lifecycle completion.
10. No shared contract, generic queue, app import, provider reachability, schedule, environment
    value, seed, deployment or hosted operation belongs to the source protocol slice.

## Architecture candidates

### Candidate A: append-only claim epochs and settlements

Each acquisition would append an epoch and each release/completion a settlement. Current custody
would be the latest unsettled epoch.

This is attractive because every ownership fact is immutable, but it makes current authority a
cross-table fold. Concurrent first claims, expiry versus settlement and renewal require locking an
otherwise immutable parent plus anti-joins over an unbounded event history. PostgreSQL cannot
enforce “one latest epoch without a settlement” with a simple unique constraint spanning two
tables. Repeated observation deferments also increase the current-state query cost.

Decision: rejected for operational custody.

### Candidate B: mutable delivery head plus immutable transition journal

Keep one private head per outbox wake for current custody and append one immutable event for every
head transition. The head gives one row to lock and one constant-time eligibility predicate; the
journal retains exact operational history.

Decision: selected. Mutable custody is acceptable because it is not domain evidence or mutation
authority, direct DML is closed, every capability is compare-and-swap, and head/journal parity is
proved after every transition.

### Candidate C: extend `sync_jobs`

Adding SP job enums, global claim tokens or changed finish signatures would require coordinated
deployment of every current worker and could expose new work to an older consumer.

Decision: rejected. The SP outbox remains a dedicated boundary.

### Candidate D: stateless periodic scan

Scanning immutable wakes without custody is small but cannot reject stale owners, bound retries or
prove one active coordinator.

Decision: rejected.

## Selected storage model

### Delivery head

The later additive migration creates one private head for every immutable outbox wake:

```text
app.sp_write_outbox_delivery_heads
  org_id, profile_id, outbox_id                 exact parent identity
  state                                         available | leased | completed
  claim_epoch                                   monotonically increasing bigint
  transition_sequence                           increments on every transition
  claimant_id                                   service-only, null unless leased
  token_digest                                  domain-separated SHA-256, null unless leased
  claimed_at, lease_expires_at                  DB-owned, null unless leased
  available_at                                  DB-owned next eligibility
  attempt_count                                 increments on every successful claim
  completed_at                                  DB-owned, set once
```

The head has a composite cascading foreign key to
`public.sp_write_outbox(org_id, profile_id, outbox_id)`. Its shape check makes every state exact:

- implicit genesis is `(available, epoch 0, sequence 0, attempts 0,
  available_at = outbox.created_at)` with every custody and completion field null;
- `available`: `available_at` is non-null and every custody and completion field is null;
- `leased`: claimant, token digest, claim time and lease expiry are non-null while `available_at`
  and completion are null;
- `completed`: completion is non-null while `available_at` and every live-custody field are null.

Every acquisition increments `claim_epoch` and `attempt_count` together, so both start at zero and
remain equal. `transition_sequence` starts at zero and increases by exactly one for every event.
Completion is terminal. There is no failed or dead-letter state.

The raw UUID token is returned once and never stored. PostgreSQL stores only lowercase SHA-256 over
this exact LF-separated preimage with no trailing LF:

```text
openspell.sp-write-outbox-claim-token.sql.v1
<lowercase claim UUID>
```

A lost claim response therefore leaves no recoverable credential. The wake becomes available only
after its database lease expires.

### Immutable transition journal

Every successful head change inserts one row into
`app.sp_write_outbox_delivery_events` in the same transaction:

```text
org_id, profile_id, outbox_id
transition_sequence, claim_epoch
event_kind                                     claimed | expired_reclaimed |
                                               renewed | deferred | completed
actor_claimant_id, actor_token_digest
recorded_at, claimed_at, lease_expires_at, available_at, completed_at
defer_reason
```

`(outbox_id, transition_sequence)` is unique and every event carries the exact tenant parent key.
Each event has a composite cascading foreign key to the delivery head
`(org_id, profile_id, outbox_id)`, never directly to `public.sp_write_outbox`. Event insertion
therefore acquires no outbox-parent lock after the head lock; the head's composite foreign key
provides the transitive outbox and tenant chain. Actor identity is non-null for every event and
identifies the exact epoch/token that caused the transition; it is not necessarily custody
projected into the resulting head. Event closure is exact:

- `claimed` follows `available`; `expired_reclaimed` follows an expired `leased` state. Both carry
  the new epoch's claim time and lease expiry, with availability, completion and defer reason null,
  and project `leased` with the event actor as current custody.
- `renewed` follows the same unexpired `leased` epoch, retains its original claim time, carries its
  new lease expiry, has availability, completion and defer reason null, and projects that same
  lease.
- `deferred` follows the same unexpired `leased` epoch, carries only its new `available_at` and
  fixed defer reason among the conditional fields, and projects `available` with custody cleared.
- `completed` follows the same unexpired `leased` epoch, carries only `completed_at` among the
  conditional fields, and projects `completed` with custody and availability cleared.

Each transition captures one database instant. Claim/reclaim use it for both `recorded_at` and
`claimed_at`, with expiry exactly the requested lease later. Renewal uses it as `recorded_at` and in
the bounded expiry formula. Defer uses it as `recorded_at` and the base of its exact backoff.
Completion uses it for both `recorded_at` and `completed_at`.

The journal deliberately has no initialization event. Its fold begins from the exact implicit
genesis tuple above and applies events in contiguous sequence order. Every capability asserts one
updated head and one inserted event before returning; tests require the resulting fold to equal the
head exactly. Event update and truncate are always forbidden; tenant cascade may delete operational
history only through the already guarded organisation purge.

Acquisition alone increments epoch and attempt count. Acquisition, renewal, deferment and
completion each increment transition sequence by exactly one; renewal, deferment and completion
retain the current epoch and attempt count. Ordinary contention, stale custody, incomplete closure
and exact replay change neither head nor journal.

### Head creation and upgrade

An internal `AFTER INSERT` trigger on the immutable outbox inserts exactly one available head in the
same transaction. The additive migration backfills any existing wakes in canonical
`(created_at, outbox_id)` order and asserts exact outbox/head counts. It does not rewrite a WP-187
row or migration byte.

The trigger adds no delivery to the current worker: no application has function execute authority
or imports the facade, and the hosted database does not receive this migration in the source slice.

## Claim and custody protocol

### Claim

The controlled service-only capability has this conceptual shape:

```sql
app.claim_sp_write_outbox(
  p_claimant_id text,
  p_kinds public.sp_write_outbox_kind[],
  p_limit integer,
  p_lease_seconds integer
) returns table (
  offered_count integer,
  claimed_count integer,
  claim_ordinal integer,
  outbox_id uuid,
  org_id uuid,
  profile_id uuid,
  execution_id uuid,
  plan_id uuid,
  approval_id uuid,
  generation uuid,
  kind public.sp_write_outbox_kind,
  provider_call_id uuid,
  intent_id uuid,
  source_sync_job_id uuid,
  claim_epoch bigint,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  claim_token uuid
);
```

The function requires a nonempty unique exact kind allowlist, a trimmed ASCII claimant identifier
matching `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`, a list limit between 1 and 10 and a lease in the
existing public-safety range of 70 to 300 seconds. The facade defaults the lease to 120 seconds; SQL
always receives it explicitly. It prefilters candidates, locks them with `FOR UPDATE SKIP LOCKED`
in immutable wake order `(created_at, outbox_id)`, captures `clock_timestamp()` after the locks and
rechecks every predicate.

The current-custody predicate is applied before kind-specific eligibility:

```text
(state = available AND database_now >= available_at)
OR (state = leased AND database_now >= lease_expires_at)
```

A live lease is never selectable, and `available_at` is never consulted while leased. Among rows
passing that custody predicate, domain eligibility is derived:

- a head whose domain evidence already satisfies its completion predicate is eligible so a
  claimant can settle delivery after an earlier crash;
- any incomplete `dispatch` wake is eligible;
- an `observe_and_recover` wake with a canonical result is eligible whether observations remain or
  the evidence is already complete;
- one without a result is eligible only after both its provider-attempt deadline and immutable
  dispatch lease have expired;
- a completed head is never eligible.

For each selected head, the function generates a fresh token, increments epoch, transition and
attempt counts, stores only the digest, and appends `claimed` or `expired_reclaimed`. Raw claim
tokens are transported only in the dedicated typed UUID column, never in JSON, arrays or metadata.
For a nonzero batch the function returns exactly `claimed_count` rows with consistent repeated
counts, contiguous ordinals and one exact typed claim per row. `offered_count` must equal locked
candidates, `claimed_count` must equal updated heads, and the function aborts unless those counts
are equal. Dispatch rows require the three provider/intent/source fields to be null;
observe/recover rows require all three exact immutable IDs. The zero case is exactly one header row
with both counts zero and every claim column null.

Claim does not lock the organisation. An organisation purge may invalidate a delivery claim because
the claim is not durable evidence or mutation authority. Any later claim-bound lease acquisition or
reservation locks and rechecks the complete parent chain before it can return authority.

### Renewal

Renewal requires exact outbox identity, epoch and raw token. It locks the head, captures DB time,
and refuses an expired, completed, deferred or replaced claim. The requested extension is between
70 and 300 seconds and the new expiry is exactly
`least(database_now + requested_extension, claimed_at + 300 seconds)`. It must be strictly later
than the current expiry; otherwise the ordinary result is `renewal_limit_reached`. A successful
extension appends one `renewed` event. Renewal stops when worker shutdown begins and never changes
provider-attempt, dispatch-lease or recovery deadlines.

Unknown renewal outcome does not authorize a retry loop. The claimant stops new claim-owned work
and must not enter reservation; persistence behind an already committed dispatch ticket may still
finish. A later worker lets custody expire and reclaims it. This conservative delay is preferable
to overlapping ownership. Renewal has no idempotency key: a second acknowledged call is a new
bounded renewal, while an outcome-unknown call is never replayed.

### Defer

Defer requires the exact live epoch/token and one fixed private-SQL/facade-local reason:
`reservation_busy`, `observation_pending`, `recovery_pending` or `shutdown`. The caller cannot
supply a duration. After locking and recapturing DB time, PostgreSQL computes a bounded backoff in
seconds as `least(300, 15 * 2^least(greatest(attempt_count - 1, 0), 5))`. It moves the head to
`available`, clears live custody, sets `available_at = database_now + backoff`, and appends one
`deferred` event with the reason. This gives an exact 15, 30, 60, 120, 240, then 300-second schedule
and prevents caller-selected one-second churn.

An exact replay with the same epoch, token and reason returns `already_deferred` only while that
defer remains the latest event. A different reason or any replacement claim returns `stale_claim`
and changes nothing. A lost response may therefore be retried once by exact identity, never as a
generic loop.

Deferment never removes a wake, changes evidence or releases a committed provider intent for
redispatch. A successor always reloads the ledger before acting.

### Complete

Completion requires the exact live epoch/token and computes its predicate inside PostgreSQL. The
caller supplies no status, counts or evidence summary. The function locks the owning organisation
before the head, captures DB time after both locks, validates custody, proves kind-specific closure,
moves the head to terminal `completed`, clears live custody and appends one `completed` event.

The first completion requires live custody. An exact replay may return `already_completed` only
when the terminal event is still the latest event for that same epoch and token digest; a different
token or missing parent returns `stale_claim` or the fixed missing-dependency error without change.

## Claim-bound dispatch lease and reservation

The source implementation first replaces direct worker access to dispatch-lease acquisition with a
wrapper shaped conceptually as:

```sql
app.acquire_sp_write_dispatch_lease_for_claim(
  p_outbox_id uuid,
  p_claim_epoch bigint,
  p_claim_token uuid,
  p_route_key public.sp_write_route_key,
  p_lease_seconds integer
) returns the existing dispatch-lease result;
```

It reads immutable outbox identity without authority, locks the owning organisation `KEY SHARE`,
locks the delivery head, captures database time and proves the exact live epoch/token, then proves
the outbox is the exact dispatch wake for that execution, plan and generation. Only then does the
canonical WP-187 lease capability lock the exact execution request. After the canonical function
returns, the wrapper recaptures database time and revalidates the still-locked exact unexpired
epoch/token. Initial claim unavailability returns no lease; post-call expiry raises `40001` and
rolls back the inserted immutable dispatch lease. The migration revokes `service_role` execute on
the old tokenless
`app.acquire_sp_write_dispatch_lease(...)` signature.

The source implementation replaces direct worker access to the current reservation RPC with a
wrapper shaped conceptually as:

```sql
app.reserve_sp_write_provider_call_for_claim(
  p_outbox_id uuid,
  p_claim_epoch bigint,
  p_claim_token uuid,
  -- the existing nine WP-187 reservation arguments, unchanged in meaning
) returns the existing reservation result;
```

The wrapper performs this exact lock and proof order:

1. read the immutable outbox identity without treating it as authority;
2. acquire `KEY SHARE` on the owning `public.orgs` row;
3. lock the matching private delivery head;
4. capture `clock_timestamp()` and prove `leased`, exact epoch, exact token digest and unexpired
   custody;
5. prove the wake is the exact `dispatch` wake for the supplied execution, plan and generation;
6. invoke the canonical WP-187 reservation transaction while retaining both locks;
7. after the canonical function returns, capture `clock_timestamp()` again and revalidate the
   still-locked head as the same exact unexpired epoch/token;
8. return the canonical result unchanged only when that post-reservation proof succeeds.

If custody expires while the canonical reservation waits on any downstream lock, step 7 raises
`40001`. PostgreSQL rolls back the entire wrapper transaction, including every refusal, intent,
outbox or ticket-producing row written by the nested reservation. It cannot return a result from a
claim that was live only before the lock wait.

Organisation-first ordering matches WP-187 reservation and prevents a head-versus-purge deadlock.
If deletion wins before the organisation lock, the wrapper returns no authority. If the wrapper
wins, deletion waits and then observes any committed unresolved intent through the existing purge
guard.

The migration also revokes `service_role` execute on the old
`app.reserve_sp_write_provider_call(...)` signature and grants execute only on both claim-bound
wrappers. The old functions remain internal implementation capabilities so historical migrations
and their proven semantics are not rewritten. The WP-188 facade changes both runtime methods to
require an opaque dispatch claim; no tokenless overload remains.

A stale claimant could otherwise lose custody, resume, win the unique reservation and leave the
fresh claimant assuming another actor still owns the provider call. Intent uniqueness prevents a
duplicate mutation but does not make that ownership handoff correct. Atomic claim binding closes
that gap.

After reservation commits, the dispatch ticket stands on its own. Claim expiry or replacement does
not revoke it, extend it or permit another ticket. The five-second start deadline, 35-second
provider-attempt deadline and 70-second minimum dispatch lease remain unchanged.

## Kind-specific completion

### Dispatch wake

A dispatch wake completes only when every action in its exact execution/plan child has one
permanent action resolution:

- a terminal predispatch disposition; or
- a committed provider-call intent.

A mixed plan stays open until every action resolves. It does not wait for provider result or
observation. Crash after intent but before delivery completion is safe: a successor sees
`already_intended`, receives no ticket and closes the wake from database evidence.

### Observe-and-recover wake

An observation/recovery wake completes only when all of these hold:

- exactly one canonical provider or synthesized recovery result exists;
- result-position identity and count close exactly against the intent positions;
- every accepted or ambiguous position has exactly one terminal synchronized observation;
- authoritatively rejected positions have no observation requirement;
- every observation uses the immutable outbox `source_sync_job_id`.

Requested, expected-after-ambiguity, conflict and missing observations are terminal evidence.
Merely reaching a recovery deadline is not completion; the synthesized result must first be
durably appended. A late provider audit after synthesized recovery does not reopen the wake.

## Facade contract

The later source slice adds `createSpWriteOutboxLedger` to the existing explicit package subpath,
not to the DB root or worker barrel:

```ts
type SpWriteOutboxClaimBase = Readonly<{
  outboxId: string;
  orgId: string;
  profileId: string;
  executionId: string;
  planId: string;
  approvalId: string;
  generation: string;
  claimEpoch: string; // canonical bigint decimal
  claimedAt: string;
  expiresAt: string;
  toJSON(): never;
}>;

type SpWriteDispatchOutboxClaim = SpWriteOutboxClaimBase & Readonly<{
  kind: 'dispatch';
  providerCallId?: never;
  intentId?: never;
  sourceSyncJobId?: never;
}>;

type SpWriteObserveAndRecoverOutboxClaim = SpWriteOutboxClaimBase & Readonly<{
  kind: 'observe_and_recover';
  providerCallId: string;
  intentId: string;
  sourceSyncJobId: string;
}>;

type SpWriteOutboxClaim =
  | SpWriteDispatchOutboxClaim
  | SpWriteObserveAndRecoverOutboxClaim;

type SpWriteRenewOutcome =
  | Readonly<{ kind: 'renewed'; expiresAt: string }>
  | Readonly<{ kind: 'renewal_limit_reached'; expiresAt: string }>
  | Readonly<{ kind: 'stale_claim' }>;
type SpWriteDeferReason =
  | 'reservation_busy'
  | 'observation_pending'
  | 'recovery_pending'
  | 'shutdown';
type SpWriteDeferOutcome =
  | Readonly<{
      kind: 'deferred' | 'already_deferred';
      reason: SpWriteDeferReason;
      availableAt: string;
    }>
  | Readonly<{ kind: 'stale_claim' }>;
type SpWriteCompleteOutcome =
  | Readonly<{ kind: 'completed' | 'already_completed'; completedAt: string }>
  | Readonly<{ kind: 'not_complete' | 'stale_claim' }>;

interface SpWriteOutboxLedger {
  claimAvailable(input: unknown): Promise<{
    offeredCount: number;
    claimedCount: number;
    claims: readonly SpWriteOutboxClaim[];
  }>;
  renewClaim(claim: SpWriteOutboxClaim, leaseSeconds: number): Promise<SpWriteRenewOutcome>;
  deferClaim(claim: SpWriteOutboxClaim, reason: SpWriteDeferReason):
    Promise<SpWriteDeferOutcome>;
  completeClaim(claim: SpWriteOutboxClaim): Promise<SpWriteCompleteOutcome>;
}
```

The facade moves each typed response token immediately into a module-private
`WeakMap<SpWriteOutboxClaim, string>`. The raw token is not an object property or brand value and
never appears in JSON, arrays, logs, error messages, enumerable facade properties or caller
serialization. Handles are frozen, reject JSON serialization, and every token-using method rejects
a structurally equal clone that is not the exact `WeakMap` key before SQL. All inputs are parsed
before SQL; every response has exact header, row-count, ordinal, conditional-nullability and
identity validation. Raw PostgreSQL errors are replaced by the existing sanitized
`SpWritePersistenceError` boundary with `providerCallAllowed: false`.

Both `SpWriteRuntimeLedger.acquireDispatchLease` and `reserveProviderCall` require a
`SpWriteDispatchOutboxClaim`; the former additionally accepts only route and bounded lease seconds,
because cycle identity comes from the claim. Result, recovery, observation and evidence-load
methods remain token-free. No facade method automatically retries a claim transition, lease
acquisition or reservation.

### Exact outcomes and errors

Expected races are ordinary discriminated outcomes rather than exceptions:

- claim contention, live leases and no eligible rows return the count-closed zero batch;
- an expired, completed, deferred or replaced epoch/token returns `stale_claim` for renew, defer or
  complete without changing a row;
- renewal that cannot extend the current expiry within the absolute epoch cap returns
  `renewal_limit_reached`;
- exact latest defer and completion replays return `already_deferred` and `already_completed`;
- incomplete completion evidence returns `not_complete`;
- claim-bound lease acquisition with unavailable custody returns the existing `unavailable` result;
- a reservation whose claim is unavailable at its initial locked proof returns
  `closed_without_dispatch/claim_unavailable` without invoking the canonical reservation.

Renewal intentionally has no replay result: acknowledged repeats are new bounded renewals and
unknown outcomes are not retried. The future facade extends its fixed operation union for outbox
claim, renew, defer and complete and reuses the WP-188 sanitized boundary. It also changes the
operation-specific mapping for claim-bound `acquire_dispatch_lease`: transaction abort is now
`reconcile_only`, matching reservation, because an unknown result may conceal an immutable lease.

| Condition | SQL/facade result | Fixed recovery |
|---|---|---|
| malformed input or invalid UUID/decimal | `22023` or `22P02` -> `invalid_artifact` | `stop` |
| expected contention or stale custody | ordinary outcomes above | reload current evidence before more claim-owned work |
| lease acquisition or reservation expires during a nested lock wait | `40001` -> `transaction_aborted` | `reconcile_only`; provider call forbidden |
| permission or missing relation/parent | existing WP-188 fixed mapping | `stop` or `reload_state` as already defined |
| transport loss, no SQLSTATE, `08xxx`, `57P01`-`57P03` | `outcome_unknown` | `reconcile_only` |
| malformed count, typed token, row or identity response | `protocol_violation` | `reconcile_only` |

Every exceptional path has `providerCallAllowed: false`, retains no raw database error, token or
identifier, and is never automatically retried. Lease acquisition and reservation remain
reconcile-only for every exception because a transport failure may conceal a committed immutable
lease or intent. A detected post-lock expiry is also reconcile-only even though its deliberate
`40001` proves rollback; this keeps one safe caller rule for each failed capability.

## Crash and race semantics

| Cut or race | Required result |
|---|---|
| Crash before claim commit | no token or event exists |
| Claim commit response lost | raw token is unrecoverable; successor waits for DB expiry |
| Same claimant reclaims expired work | fresh token and higher epoch; old token is stale |
| 50 concurrent claimers | exactly one live token for one head |
| Renewal versus takeover | one head lock decides; an expired epoch cannot resurrect |
| Defer/complete versus takeover | exact epoch/token compare-and-swap; stale actor changes nothing |
| Delete versus claim | claim may vanish with tenant purge; it confers no durable authority |
| Delete versus reservation | organisation-first lock order yields delete-wins or guarded intent-wins |
| Claim expires while lease acquisition waits on its execution request | post-call recheck raises and the new dispatch lease rolls back |
| Crash before reservation commit | no intent and no provider ticket |
| Claim expires while reservation waits on a downstream lock | post-call recheck raises; the whole nested transaction commits zero evidence and returns no ticket |
| Reservation commit response lost | intent may exist; no ticket is reconstructed and no call is retried |
| Claim expires after ticket commit | ticket remains bounded authority; replacement sees intent and cannot redispatch |
| Crash after provider send | result recovery/observation only; never another mutation attempt |
| Provider result versus synthesized recovery | one canonical immutable result wins |
| Shutdown after replacement | stale completion/defer cannot alter the replacement claim |

## Security and purge

- Delivery relations live in `app`, outside tenant-facing public evidence.
- `public`, `anon`, `authenticated` and `service_role` receive no table or sequence privilege.
- `service_role` receives execute only on fixed-search-path `SECURITY DEFINER` claim, renew, defer,
  complete, claim-bound lease and claim-bound reservation capabilities.
- Internal digest, trigger, closure and journal helpers receive no application-role execute grant.
- Claimant identifiers, token digests and delivery history are service-only and never enter tenant
  reads, health output or shared artifacts.
- Every row repeats `org_id` and `profile_id`; the head uses the full composite outbox parent key
  and each event uses the full composite delivery-head parent key.
- The existing unresolved-intent purge guard remains authoritative. A deliberate permitted tenant
  purge may cascade an unfinished observation wake after its durable result because that guard
  protects unresolved provider intent, not delivery completion. This sole deletion exception does
  not count as lifecycle closure and never retains claimant data globally.
- Direct head/event DML is denied. Journal update/truncate is forbidden, and delete is allowed only
  through the already proven parent-absent tenant cascade pattern.

## Synthesis and tradeoffs

The High candidate favored pure append-only custody because it minimizes mutable state. The
Extra-High adversarial review found avoidable first-claim, latest-unsettled, renewal and
anti-join risks and selected a mutable head. Both agreed on immutable transition history, fresh
tokens, DB time, private ACLs, count closure and separation between claim and ticket authority.

The selected design uses the mutable head for one-row compare-and-swap and the immutable journal for
audit. It also adopts Extra-High's mandatory claim-bound dispatch-lease and reservation wrappers.
We accept a private mutable operational row because its authority is narrow, repair is not exposed,
every transition is journaled, and all domain truth remains in WP-187 evidence.

Bounded renewal is retained. Without renewal, callers must choose between long crash-recovery delay
and overlapping work. Renewal cannot outlive the absolute epoch limit and cannot touch any provider
deadline.

## Package decomposition

### WP-191 — architecture acceptance

Owned files are only this document and
`docs/workpackages/WP-191-sp-write-outbox-protocol.md`. After reviewed merge and exact-main CI,
PR #24 may close unmerged because its remaining token-fencing lesson has a durable current-main
home. Handover/status are updated only afterward.

### Next source package — database and facade

The next separately numbered package may own:

- one new forward migration, tentatively
  `20260901030000_sp_write_outbox_delivery.sql` after an immediate identity recheck;
- private delivery head/journal schema and Drizzle mirrors;
- controlled claim/renew/defer/complete plus claim-bound lease and reservation capabilities;
- revocation of both tokenless service-role entrypoints;
- the explicit DB facade additions and focused pure/PostgreSQL tests;
- ACL, migration, concurrency, crash, purge and blast-radius proofs.

It still adds no app import, job member, provider reachability, hosted apply or runtime activation.

### Later worker coordinator

A separate worker package may own one dedicated SP outbox loop, exact lifecycle/shutdown behavior,
WP-180 invocation only behind a committed ticket, and reconciliation-only recovery. It must not
register or activate the consumer in the same slice.

### Later activation

Hosted migration, single-consumer ownership, job/runtime wiring, environment/profile authority,
bounded authorization, revision-stamped deployment and any live proof require a separate attended
activation package and exact current-task authorization.

## Future implementation proof matrix

- migration fresh replay, upgrade replay, five-second lock envelope and last-migration identity;
- exact trigger/backfill offered/inserted counts and no WP-187 byte change;
- exact implicit genesis, state checks, event nullability and head/journal fold projection;
- 50-way claim race, same-claimant takeover and monotonically increasing epochs;
- live-lease exclusion before domain eligibility, completion-ready reclaim and exact zero-batch
  closure;
- wrong, missing, expired and replaced token rejection for every transition, lease acquisition and
  reservation;
- bounded renewal, DB-clock skew resistance and no deadline extension;
- exact defer/complete replay without touching a replacement claimant;
- dispatch and observe/recover completion refusal on every partial-accounting case;
- claim-bound lease and reservation, revoked tokenless execute grants and zero authority for stale
  custody;
- downstream lease/reservation locks held past claim expiry produce `40001` and zero committed
  dispatch lease, resolution, intent, outbox or ticket rows;
- lost reservation response, post-intent reclaim and zero mutation-ticket reconstruction;
- result/recovery/observation persistence after claim, gate, grant, receipt, lease and credential
  expiry;
- provider-result/recovery race, late audit and exact source-sync identity;
- organisation delete races with claim, renewal, deferment, reservation and completion without
  deadlock, including proof that event insertion takes no direct outbox-parent lock after a head
  lock;
- tenant A/B, anonymous, authenticated and service-role ACL matrices plus direct-DML denial;
- head/journal fold equality after every transition and quiescent purge cleanup;
- typed-row count/order closure, raw-token `WeakMap` isolation and discriminated dispatch versus
  observe/recover claim identities;
- static proof of no shared job, queue enum, app import, provider reachability, schedule, seed,
  deployment setting, hosted operation or activation.

## PR #24 archival decision

WP-191 preserves its useful requirements:

- a fresh claim token for every ownership epoch;
- exact-token compare-and-swap for renew, defer and completion;
- database-clock expiry and bounded renewal;
- stale-owner rejection even when claimant identifiers match;
- crash recovery without mutation redispatch;
- dispatch-lease and reservation side effects only through a live claim, and mutation authority only
  through the resulting committed reservation ticket.

It rejects PR #24's global queue changes, old shared/provider implementation, mutable execution
authority, random recovery jobs, process-clock eligibility and any transition that makes a committed
intent retryable. Once WP-191 is reviewed, merged and green on exact main, PR #24 should be closed
without merge and linked to this durable decision. Closing stale code does not claim the protocol is
implemented, hosted, deployed or active.

## Next step

Commit and review this architecture-only package. Do not create the migration or edit the facade on
this branch. After exact-main acceptance and PR #24 archival closure, start the separate source
database/facade package from a fresh reconciled main revision.
