# WP-188 inert Sponsored Products write-query facade rationale

Status: selected architecture, source-only. Date: 2026-09-02.

WP-179 froze the cross-package Sponsored Products write contract, WP-180 implemented a one-attempt
provider adapter, and WP-187 installed an append-only PostgreSQL proof ledger. None is reachable
from a current job, worker handler, web route, MCP tool, deployment, or schedule. WP-188 adds the
typed database boundary that future control-plane and worker code can use without exposing raw SQL
arguments, treating process state as authority, or turning the inert ledger on.

The ledger remains default-empty. Its migration remains source-only and is not applied to a hosted
database by this package.

## Usage first

The intended surface is an explicit subpath, deliberately absent from the package root:

```ts
// Design sketch only. WP-188 adds no caller.
import {
  createSpWriteRuntimeLedger,
  createSpWriteStagingLedger,
} from '@wizard-ads/db/sp-write-persistence';

// Operator-controlled staging code may persist already-approved contract artifacts.
const staging = createSpWriteStagingLedger(db);
await staging.recordPlan(plan);
await staging.recordBoundedAuthorization({
  authorization,
  bindings: exactProviderScopeBindings,
});

// A future worker may receive only the runtime capability.
const runtime = createSpWriteRuntimeLedger(db);
const lease = await runtime.acquireDispatchLease({
  executionId,
  planId,
  generation,
  routeKey,
  leaseSeconds: 120,
});
if (lease.kind !== 'acquired') return;

const reservation = await runtime.reserveProviderCall({ observation, intent });
if (reservation.kind !== 'dispatch_once') return;

// Only reservation.ticket is mutation authority. WP-188 neither imports nor calls the adapter.
```

No public method accepts serialized artifact text, a fingerprint preimage, proof arrays, a result
origin, database time, a gate version, an actor, or an arbitrary RPC name. The facade parses the
frozen shared artifacts, derives canonical bytes and preimages itself, and validates every database
response before returning it.

## Problem and constraints

The SQL functions are intentionally deep capabilities. Calling them directly from future workers
would leak nine positional reservation arguments, database enum values, raw postgres errors, and
subtle commit-ambiguity rules into orchestration code. A shallow wrapper would merely rename that
risk.

The facade must preserve these boundaries:

1. `packages/shared` stays frozen. Every lifecycle artifact, serializer, verifier, refusal reason,
   and accounting derivation comes from `@wizard-ads/shared/sp-writes`.
2. PostgreSQL remains the authority for locks, time, current generation, gate and route state,
   bounded consumption, global and entity capacity, winner identity, and recovery eligibility.
3. A provider call is permitted only after one winning reservation transaction has committed and
   the facade has read back the exact persisted ticket before its database-owned deadline.
4. Current apps, jobs, queue functions, provider code, routes, schedules, and deployments stay
   unchanged. Importability is not activation.
5. The current `DbHandle` is a root/service connection. It is not an authenticated end-user
   transport and must not be used to impersonate one.

## Candidates

### Candidate A — capability-segregated explicit subpath

Expose separate staging and runtime factories from one explicit package subpath. Both accept a root
SQL handle, share private artifact/error/decoder code, and offer domain operations rather than SQL
parameters. Keep authenticated approval outside the facade.

This is selected. The split follows caller authority: a future worker importing runtime operations
does not also receive plan or bounded-authorization staging. The explicit subpath keeps the large
inactive contract out of existing root imports and makes reachability mechanically searchable.

### Candidate B — one stateful lifecycle session

A typestate object could progress from staged to approved, leased, and reserved. It was rejected
because the lifecycle crosses processes and time. A JavaScript object would look authoritative
after a database revocation, crash, lease expiry, or competing reservation even though it is not.

### Candidate C — root-exported RPC wrappers

Named wrappers or a generic command union would be concise. They were rejected because they expose
SQL-shaped arguments and transport behavior, broaden ambient authority to every current DB
consumer, and encourage callers to compose stale prechecks or generic retries.

## Selected public boundary

The production entrypoint is `@wizard-ads/db/sp-write-persistence`. It exports factories, result
types, and one sanitized error class. It is not re-exported from `packages/db/src/index.ts` or the
existing worker barrel.

The staging capability owns:

- `recordPlan(rawPlan)`, which parses and rehashes the plan and every action, creates canonical
  artifact/preimage arguments, invokes only `app.record_sp_write_plan`, checks exactly one returned
  UUID, and verifies it equals the artifact identity;
- `recordBoundedAuthorization({ authorization, bindings })`, which parses and rehashes the
  authorization, aligns tenant bindings by exact canonical provider scope, rejects missing, extra,
  or duplicate scopes, invokes only `app.record_sp_write_bounded_authorization`, and verifies the
  returned identity.

The runtime capability owns:

- `startExecution({ approvalId, planId })`;
- `acquireDispatchLease({ executionId, planId, generation, routeKey, leaseSeconds })`;
- `reserveProviderCall({ observation, intent })`;
- separate `appendProviderResult(result)` and `appendRecoveryResult(result)` methods with fixed
  database origin literals;
- `appendObservation(observation)`;
- `loadVerifiedExecution(identity)`, using the complete tenant and cycle identity.

It does not own authenticated approval. `app.approve_sp_write_cycle` derives `auth.uid()` and is
granted to `authenticated`; the repository has no honest authenticated query transport for this
future mutation confirmation yet. WP-188 must not add `SET ROLE`, JWT-claim impersonation, a
caller-supplied actor, or a service-role approval wrapper. That capability belongs with a later
authenticated request boundary.

The facade also does not expose gate, grant, revocation, bounded-consumption, purge, repair, or
activation mutation. It never reads or recreates the global consumption tombstone.

## Root connection and commit boundary

Factories accept a root `postgres.Sql` handle, not an open `TransactionSql`. Each runtime mutation
is one schema-qualified controlled RPC in its own autocommit statement. This prevents a caller from
receiving a reservation ticket before commit or holding an Amazon call inside a database
transaction.

Staging methods persist inert immutable evidence and may be composed only by explicit future
control-plane code. WP-188 does not add a multi-artifact approval workflow. Partial staged evidence
confers no approval, lease, reservation, or provider authority.

No method performs a separate `canDispatch`, capacity, gate, generation, or route precheck. Those
facts are stale as soon as read. Only `app.reserve_sp_write_provider_call` may produce a winning
reservation.

## Canonical artifact handling

Every public artifact input is `unknown` at the trust boundary and is parsed through its frozen Zod
schema or verifier before SQL runs. Node's SHA-256 implementation supplies the shared hasher. The
facade derives:

- exact `JSON.stringify(parsedArtifact)` text;
- action and plan fingerprint preimages;
- bounded-authorization preimage;
- predispatch-observation preimage;
- provider-request and provider-intent preimages;
- provider-result and final-observation preimages.

Callers cannot provide or override those values. SQL deliberately verifies them again against
stored identities and relational projections. This duplicate verification is a trust-boundary
check, not a second semantic contract.

Bounded tenant bindings are the only relational input that is not part of the shared artifact.
They are keyed by the exact canonical `SpWriteProviderScope`, not by array position. The facade
produces the SQL array in authorization-profile order after proving one-to-one coverage. SQL still
rechecks each live tenant/provider route.

## Reservation and dispatch ticket

The raw reservation result has four decisions: `won`, `busy`, `refused`, and `already_intended`.
The facade maps them to a discriminated union:

```ts
type ReservationOutcome =
  | { kind: 'dispatch_once'; checkedAt: Date; ticket: SpWriteDispatchTicket }
  | { kind: 'defer_and_reobserve'; checkedAt: Date; reason: 'busy' }
  | {
      kind: 'closed_without_dispatch';
      checkedAt: Date;
      reason: SpWriteRefusalReason | 'already_intended' | 'dispatch_window_elapsed';
    };
```

Only `dispatch_once` contains a ticket. A ticket contains the exact parsed intent, stable reserved
result ID, persisted dispatch-start deadline, persisted provider-attempt deadline, and the database
readback time. It is opaque to construction and refuses JSON serialization so it is difficult to
store or replay as authority.

The reservation RPC returns only after its transaction commits. On `won`, the facade performs an
exact-identity read of the just-committed immutable intent/result reservation and its SQL-owned
deadlines, together with `clock_timestamp()`. It returns a ticket only when all of these hold:

- exactly one reservation row and exactly one readback row exist;
- refusal is null, result ID is canonical and non-null, and returned intent bytes exactly equal the
  facade-derived bytes;
- readback identity, result ID, intent bytes, route, lease, and every deadline match;
- database readback time is still before the persisted dispatch-start deadline.

Any unexpected combination fails closed. An elapsed readback returns
`closed_without_dispatch/dispatch_window_elapsed`; recovery later closes the committed intent. A
transport loss, malformed response, or failed readback never yields a ticket.

`busy`, `refused`, and `already_intended` must carry null result ID and intent text. A mixed batch's
dominant refusal does not imply that every offered action was resolved; future orchestration must
reload verified evidence before considering remaining actions.

## Result and observation persistence

Provider and recovery appends are separate methods. They hardcode `provider_adapter` and
`recovery_synthesized` respectively, so callers cannot mislabel provenance. All result and
observation artifacts are reparsed, rehashed, canonically serialized, and passed to one controlled
RPC.

The four result outcomes remain distinct: `recorded`, `already_recorded`, `late_audited`, and
`canonical_result_already_recorded`. Exact result or observation replay is a persistence-only retry;
it never authorizes another provider call. Recovery-not-yet-eligible remains a database-owned
failure, not a process-clock calculation.

## Evidence read

`loadVerifiedExecution` requires the complete
`(orgId, profileId, executionId, planId, approvalId, generation)` identity. It has no UUID-only,
tenant-wide, or “latest” overload.

The loader uses one read-only repeatable-read snapshot. Every relation is selected with the full
tenant/cycle predicate and deterministic order. It parses the exact stored artifact text rather
than rebuilding artifacts from relational columns, checks every selected-row count against its
parent counts, and rejects partial or truncated evidence. It then runs
`verifySpWriteExecutionEvidence`, derives the snapshot through
`deriveSpWriteExecutionSnapshot`, and compares every counter and status with the
`public.sp_write_execution_accounting` view. A missing complete identity returns `null`; a partial,
malformed, or inconsistent identity is a protocol failure.

The loader does not claim or deliver outbox work, list tenants, expose service-only bounded
authorization details, or turn evidence into provider authority.

## Error boundary

Raw postgres.js errors never cross the module. They may retain query text, parameters, tenant IDs,
artifact bytes, provider diagnostics, constraint names, details, hints, and a cause chain. The
facade creates a fresh `SpWritePersistenceError` with only fixed values:

- operation;
- category;
- recovery directive;
- `providerCallAllowed: false`.

The original error is not used as `cause`, stored in an enumerable property, copied into the
message, or inspected by message text. SQLSTATE is classified coarsely:

| SQLSTATE | Category | Default directive |
|---|---|---|
| `22023`, `22P02` | `invalid_artifact` | `stop` |
| `42501` | `permission_denied` | `stop` |
| `23503`, `P0002` | `missing_dependency` | `reload_state` |
| `23505`, `P0003` | `identity_or_protocol_conflict` | `reload_state` |
| `55000` | `authority_unavailable` | `reload_state` |
| `55P03`, `40001`, `40P01`, `57014` | `transaction_aborted` | operation-specific |
| `08xxx`, `57P01`–`57P03`, no code | `outcome_unknown` | `reconcile_only` |
| malformed return rows or shared verification failure | `protocol_violation` | `reconcile_only` |

Expected lease `55P03` maps to `{ kind: 'unavailable' }`. A reservation failure is never labeled
generically retryable: transport ambiguity may conceal a committed intent, so its directive is
always `reconcile_only`. A lost lease result cannot be recovered as authority; wait and acquire a
new lease. Exact plan/start/result/observation commands may be replayable by their own documented
identity rules, but the facade never automatically retries any operation and never maps directly to
the worker's generic retry error.

## Test strategy

Pure tests prove parsing happens before SQL, canonical bytes/preimages match the shared functions,
binding coverage is exact, result decoders reject every impossible combination, only a winner can
carry a ticket, result origins are fixed, reservation SQL is invoked at most once, and sanitized
errors contain no sentinel from any raw error field or cause.

Disposable PostgreSQL 17 tests exercise the real WP-187 migration through the facade: empty-state
refusal, staging round trips, start idempotence, lease contention, one winner under concurrent
reservations, duplicate no-redispatch behavior, result/recovery races and replay, final observation
replay, tenant isolation, exact evidence/accounting closure, and visibility of the committed intent
before a ticket is returned.

Blast-radius tests prove the explicit subpath is absent from the root barrel and every current app,
the current job schemas and database enum still reject SP lifecycle jobs, no provider adapter is
imported, and no migration, route, schedule, deployment, environment, seed, or hosted operation is
added.

## Ownership and deferred work

WP-188 owns only its architecture/brief, an explicit `packages/db` entrypoint, private query helpers,
focused tests, and the package export map. It does not edit shared contracts, migrations, schema,
the existing worker barrel, current apps, jobs, queues, provider code, deployment, or hosted state.

Deferred packages own authenticated approval transport; worker job schemas and handlers; outbox
claiming and crash containment; adapter invocation; observation scheduling; gate/grant activation;
web confirmation; Time Machine integration; deployment; and any live Amazon mutation.
