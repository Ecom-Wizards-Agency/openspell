# WP-188 — inert Sponsored Products write-query facade

Owner: WP-01 (`packages/db`). Depends on merged WP-179, WP-180, and WP-187. Runtime state:
default-empty, source-only, and unreachable.

Architecture: `docs/design/WP-188-ARCHITECTURE.md`.

## Outcome

Add a typed, fail-closed TypeScript boundary over the controlled WP-187 database capabilities.
The facade verifies canonical WP-179 artifacts, hides SQL-shaped arguments and raw database errors,
returns provider authority only from a committed winning reservation, and reconstructs exact
execution evidence. No current runtime imports or activates it.

## Owned files

- `docs/design/WP-188-ARCHITECTURE.md` and this brief;
- one explicit `packages/db` subpath entrypoint and private `packages/db/src/queries` helpers;
- focused pure and disposable-PostgreSQL facade tests;
- the narrow `packages/db/package.json` explicit export;
- handover/status prose only after the implementation is merged.

Do not edit `packages/shared`, `packages/ads-api`, migrations, the Drizzle schema, current app code,
the existing DB root or worker barrels, job schemas/enums, queue functions, schedules, deployment,
seeds, or any hosted database. Do not transplant PR #24.

## Required behavior

1. Export the facade only from `@wizard-ads/db/sp-write-persistence`; keep it absent from the root
   and existing worker entrypoints.
2. Split staging and runtime factories so a future worker capability does not include plan or
   bounded-authorization staging.
3. Accept a root SQL handle and own every runtime autocommit boundary. Never return a dispatch
   ticket inside an open transaction and never call a provider.
4. Parse and verify every artifact through `@wizard-ads/shared/sp-writes` before SQL. Derive exact
   artifact text and every fingerprint preimage internally; accept none from callers.
5. Record plans and bounded authorizations only through their exact controlled RPCs. Align bounded
   tenant bindings one-to-one by canonical provider scope and reject missing, extra, or duplicate
   bindings before SQL.
6. Do not expose authenticated approval. Do not impersonate a user, accept actor/time/gate fields,
   or allow the service connection to mint approval authority.
7. Start executions and acquire leases only through the exact WP-187 capabilities. Map expected
   lease contention to a typed unavailable outcome; do not perform stale prechecks.
8. Reserve a provider call through exactly one invocation of
   `app.reserve_sp_write_provider_call`. Exhaustively validate the single result row. Only exact
   `won` may proceed to committed ticket readback; every other decision exposes zero mutation
   authority.
9. On a winner, read back the immutable intent, reserved result ID, SQL-owned deadlines, and
   database time by exact identity after commit. Return an opaque, non-serializable ticket only
   while the dispatch-start deadline remains open. Missing, late, ambiguous, or malformed readback
   fails closed and never permits a provider call.
10. Provide separate provider and recovery result methods with fixed origin literals. Preserve all
    four append outcomes. Exact result/observation replay is persistence-only and must never imply
    provider redispatch.
11. Load evidence in one repeatable-read, read-only snapshot using the complete tenant/execution/
    plan/approval/generation identity. Parse stored canonical bytes, assert every list count, run
    `verifySpWriteExecutionEvidence`, derive the shared snapshot, and require exact equality with
    the accounting view. Never return partial evidence.
12. Replace raw database/shared-protocol failures with a fresh operation-aware
    `SpWritePersistenceError`. Retain no cause, raw message, SQL, parameters, identifiers, artifact
    bytes, provider diagnostics, or database metadata.
13. Never automatically retry. Reservation uncertainty is reconcile-only; a lost lease is not
    authority; exact result/observation replay remains a database-only operation. Do not map the
    facade to the worker's generic retry error.
14. Add no gate/grant/revocation/consumption/purge mutator, generic RPC executor, arbitrary result
    origin, job claim/delivery method, provider import, route, schedule, or activation setting.
15. Leave the installed empty state unchanged: without later gate, grant, approval, job, worker,
    provider, and deployment packages, there is no path to Amazon.

## Public outcomes

- lease: `acquired` or `unavailable`;
- reservation: `dispatch_once`, `defer_and_reobserve`, or `closed_without_dispatch`;
- result append: `recorded`, `already_recorded`, `late_audited`, or
  `canonical_result_already_recorded`;
- evidence: one fully verified execution or `null` for an absent complete identity;
- exceptional failure: sanitized operation, fixed category, fixed recovery directive, and
  `providerCallAllowed: false`.

Only `dispatch_once` carries `SpWriteDispatchTicket`. `busy`, every frozen refusal reason,
`already_intended`, an elapsed ticket-readback window, and every error carry no result identity or
intent authority.

## Test matrix

### Pure boundary

- invalid artifact or binding fails before SQL;
- plan/action/authorization/observation/request/intent/result preimages and bytes match the frozen
  shared serializers exactly;
- bounded binding coverage accepts keyed input order while rejecting missing, extra, duplicate, or
  cross-scope inputs;
- exact one-row and scalar decoders reject empty, extra, unknown, nullable, inconsistent, or
  over-authoritative responses;
- compile-time and runtime checks prove non-winners cannot expose a ticket;
- provider/recovery origins are fixed and caller-unselectable;
- a synthetic raw error containing unique secrets in every field/cause is absent from the mapped
  error message, stack, JSON, and enumerable properties;
- simulated reservation connection loss calls the reservation RPC once and yields no authority.

### Disposable PostgreSQL 17

- empty state cannot start, lease, or reserve;
- plan and bounded-authorization round trips preserve exact artifacts, projections, counts, and
  identities;
- start is idempotent and emits one inert wake;
- lease contention is typed and an unknown lease response cannot be recovered as authority;
- concurrent facade reservations produce exactly one ticket and all losers expose none;
- the committed intent is visible to another connection before ticket use; the existing WP-187
  concurrency suite separately proves the purge guard against the same committed intent;
- duplicate reservation never reconstructs a ticket;
- facade tests cover default-off, lease, capacity, expected-state, and replay outcomes while the
  existing WP-187 PostgreSQL matrix continues to prove gate, grant, route, generation, bounded
  authorization, prior-resolution, purge, and crash-cut semantics;
- the facade fixes provider/recovery origins and preserves their controlled outcomes; the existing
  WP-187 race matrix proves one canonical immutable result, and exact facade append replay converges;
- final observation replay converges and authoritative rejection cannot be observed;
- full evidence parses from stored bytes, closes every count, passes the shared verifier, and equals
  the database accounting view;
- a mixed or mismatched full tenant/cycle identity returns no evidence. The service facade is an
  intentionally global worker capability; authenticated end-user tenant isolation remains the
  separately tested WP-187 RLS boundary.

### Blast radius

- the explicit subpath resolves and the root/worker barrels omit every WP-188 symbol;
- current `JobPayload`, `JobType`, and `sync_job_type` still omit SP write jobs;
- nonempty repository scans find no current app import, handler, queue registration, provider call,
  route, schedule, deployment, environment variable, seed, migration, Time Machine, or ApplyRow
  activation;
- WP-187 migration tests and all existing package/repository CI remain green.

## Acceptance

- [ ] Architecture/work-package commit precedes implementation.
- [ ] High implementation inventory finds no shared-contract or package-boundary blocker.
- [ ] Extra-High authority/concurrency review findings are incorporated before code.
- [ ] Canonical codecs, controlled outcomes, ticket readback, error sanitization, and evidence
      verification are covered by focused tests.
- [ ] High correctness and Extra-High adversarial reviews report no unresolved blocker/high/medium
      finding.
- [ ] Focused PostgreSQL, concurrency, tenant, and blast-radius proofs pass.
- [ ] Full CI-equivalent check, diff-check, staged hygiene, exact-head PR CI, merge, and exact-main CI
      pass.
- [ ] Handover/status is updated only after implementation merge.

## Deliberately deferred

- authenticated owner/admin approval transport;
- current job union/enum registration, outbox claiming, worker orchestration, and crash recovery;
- WP-180 adapter import/invocation and provider timeout orchestration;
- recovery polling and observation scheduling;
- web confirmation/status UI and Time Machine inverse review;
- gate/grant/bounded-authorization values, activation, deployment, hosted migration, and every live
  Amazon mutation.
