# WP-187 — inert Sponsored Products write-persistence ledger

Owner: WP-01 (`packages/db`, `supabase`). Depends on merged WP-179, WP-180, and WP-186. Runtime
state: default-empty and unreachable.

Architecture: `docs/design/WP-187-ARCHITECTURE.md`.

## Outcome

Add a source-only, append-only persistence ledger for the canonical WP-179 Sponsored Products write
lifecycle. PostgreSQL owns current gate checks, authenticated approval facts, execution cycles,
leases, capacity, unique write-ahead reservation, stable result identity, ambiguity recovery
closure, tenant isolation, and derived accounting. No path to Amazon is activated.

## Owned files

- `supabase/migrations/20260901020000_sp_write_persistence_ledger.sql` after rechecking migration
  order immediately before creation;
- `packages/db/src/schema/sp-writes.ts`, `packages/db/src/schema/enums.ts`, and their narrow schema
  exports;
- focused `packages/db/src/sp-write-*.test.ts` proofs;
- narrow `packages/db/src/rls.test.ts` and `supabase/tests/tenant-fixture.sql` additions needed for
  dynamic tenant-table coverage, using synthetic disabled data only;
- narrow migration/schema test inventory updates required by the new last migration;
- this brief and `docs/design/WP-187-ARCHITECTURE.md`;
- handover/status prose only after the package is merged.

Do not edit `packages/shared`, `packages/ads-api`, `apps/worker`, `apps/web`, `apps/mcp`, current job
unions/enums, current queue functions, deployment configuration, tenant fixtures with activation
data, or any hosted database. Do not transplant PR #24.

## Required behavior

1. Start the migration with the exact five-second lock timeout and shared repository DDL advisory
   lock required by `migration-lock-safety.test.ts`.
2. Install no environment-gate head, profile grant, bounded authorization, execution, outbox work,
   or tenant activation row. Empty state must deny approval, lease, and reservation.
3. Store exact canonical artifact text, parsed JSON, fingerprint preimage, fingerprint, and only the
   relational projections required for proof. Verify their equality and SHA-256 without retyping the
   WP-179 semantic contract in SQL.
4. Treat `executionId` as the cycle identity and keep forward/inverse evidence in child ledgers keyed
   by `(execution_id, plan_id)`.
5. Keep environment/profile authority versioned. A grant version binds exact org/profile, Amazon
   profile, connection, region, marketplace, currency, and `sp_v3` dialect, but no credential.
6. Issue approval receipts only through an authenticated owner/admin RPC. Derive actor, DB time,
   generation, current gate versions, and the DB-owned gate digest. Generate a manual-forward cycle
   ID in the DB; for bounded or manual inverse flows, adopt and validate the source cycle ID already
   frozen in the inverse plan. Store receipts separately by approval ID and bind each child plan to
   its authorizing receipt/generation. Approval alone creates no intent or outbox.
7. Start execution and issue time-bounded dispatch leases only through service-role capabilities.
   Neither a start request, outbox wake, nor lease is mutation authority.
8. In one DB-clock reservation transaction, lock and recheck global environment capacity, the exact
   gate/grant versions, live mutation route, receipt, generation, authorization/revocation/capacity,
   child plan, inverse eligibility, route, lease, fresh provider observation, expected values,
   counts, and prior action resolutions.
9. A winning reservation independently verifies the provider-request and intent fingerprint
   preimages, then atomically inserts one observation, exact items, one intent, exact
   positions, stable reserved result ID, permanent per-action resolutions, and one inert
   `observe_and_recover` outbox wake. Assert all offered/inserted counts. Only the inserting
   transaction receives `won` and a dispatch ticket.
10. A committed intent permanently forbids automatic redispatch. Duplicate, expired, revoked, busy,
    stale, mismatched, or already-resolved reservations return zero mutation authority.
    Terminal refusals atomically append canonical dispositions and permanent action resolutions;
    stale-state refusal also appends its exact proving observation/items. Prior resolution returns
    `already_intended` without new evidence, and transient capacity, cross-cycle entity-fence, or
    incomplete-inverse `busy` verdicts consume nothing.
11. Append provider and recovery results through the same unique result slot. Recovery must use the
    reserved ID and mark every position ambiguous. It never calls Amazon, and it cannot overwrite a
    racing provider result.
12. Permit provider-result and observation persistence after gates, grants, receipts, leases, or
    live credential bindings close. Observation requires a durable result and exact evidence
    identity. The outbox freezes a distinct tenant-scoped logical source-sync job ID which the later
    observation job and `sourceSyncJobId` must adopt; it is not the outbox row primary key.
13. Derive status and exact WP-179 accounting from immutable facts. Store no authoritative status,
    counters, retryability, success, or outbox-delivery state.
14. Enforce composite tenant foreign keys throughout. Anon reads nothing; authenticated users read
    only permitted tenant evidence and cannot directly mutate; service role uses controlled
    capabilities and cannot directly mutate evidence.
15. Make frozen and evidence relations immutable against update, delete, and truncate, including
    accidental privileged DML.
16. Keep the current `JobPayload`, `sync_job_type`, queue claimant protocol, worker, web, MCP, Ads
    adapter reachability, Time Machine, ApplyRow lifecycle, deployment, and schedules unchanged.

## Permanent local semantics

- Gate snapshot preimage: the exact LF-separated, no-trailing-LF
  `openspell.sp-write-gate-snapshot.sql.v1` format documented in the architecture.
- Reserved result ID: the version/variant-normalized first 128 SHA-256 bits of the exact
  `openspell.sp-write-reserved-result-id.sql.v1` preimage documented in the architecture.
- For still-pending actions, `approval_expired` precedes every other terminal authority/state
  category. Its disposition `recordedAt` is exact receipt expiry as the authority-cutoff effective
  instant; DB `persisted_at >= expiresAt` retains the later durability time. Prior resolution returns
  existing evidence without constructing a new disposition.
- Refusal mapping preserves WP-179 categories: environment change/closure maps to
  `environment_gate_closed`, profile-grant change/closure to `profile_gate_closed`, provider-route
  drift to `route_mismatch`, bounded revocation or superseded generation to
  `authorization_revoked`, lease loss to `lease_unavailable`, an otherwise unrecorded duplicate
  conflict to `duplicate_intent`, and transient capacity, entity-fence contention, or inverse
  incompleteness to nonterminal `busy`. Prior resolution returns `already_intended` without new
  evidence.
- Capacity one: the DB-owned environment gate permits one unresolved call globally in v1; literal
  bounded-authorization limits, one-open-call manual-cycle limits, and unresolved provider-entity
  fences also apply.
- Reservation records a five-second dispatch-start deadline and a 35-second provider-attempt
  deadline; its lease must extend at least 70 seconds. Recovery requires both attempt and lease
  expiry, and capacity cannot release early through synthesized ambiguity.
- Only the original insert winner receives a mutation ticket. Exact duplicates do not recover it.

## Test matrix

### Migration and mirror

- fresh replay and upgrade replay from `20260901010000`;
- exact new last migration and no identity collision;
- five-second DDL lock contention failure;
- SQL/Drizzle table, column, enum, FK, unique-index, trigger, view, and function-signature parity;
- no mutation or data drift outside the new schema surface.

### Artifact and accounting

- SQL/Node gate-digest and reserved-result UUID goldens;
- exact artifact text/JSON/preimage/fingerprint round trips for every fingerprinted WP-179 artifact,
  including both request and intent preimages, plus exact text/JSON round trips for unfingerprinted
  approval requests and receipts;
- tampered bytes, preimage, fingerprint, scope, route, generation, actor, count, position, result, or
  tenant binding fails before authority;
- offered action, provider position, result position, observation, and outbox counts close exactly;
- derived DB accounting/status matches `deriveSpWriteExecutionSnapshot` on exhaustive synthetic
  lifecycle cases.

### Concurrency and crash safety

- 50 simultaneous identical reservations produce exactly one winner, intent, result ID, outbox wake,
  and complete position set; 49 callers receive no ticket;
- two otherwise-ready profiles under the global capacity-one environment gate produce one winner;
- one bounded authorization cannot admit a second profile cycle because its literal `maxCycles: 1`
  remains enforced;
- gate, grant, route, generation, authorization, and revocation races have one serialized outcome;
- the documented environment-head, profile-head, authorization, cycle/child, and sorted-entity lock
  order prevents a later expected-version activation operation from bypassing reservation;
- two manual cycles targeting the same provider entity cannot overlap between provider result and
  terminal observation; the second receives `busy` with no evidence/action resolution and can be
  reconsidered only after the first obtains terminal observation;
- crash before intent commit leaves no intent/outbox; every crash after intent commit produces no
  second intent or provider authority;
- provider result versus recovery ambiguity has one immutable winner;
- recovery before either the provider-attempt deadline or dispatch-lease expiry is refused and does
  not release global capacity;
- a distinct-intent reserved-result UUID collision fails closed, and a late provider result after
  recovery is retained only as a sanitized rejected-append audit fact after exact WP-179 fingerprint,
  tenant, intent, reserved-result, request, position, action, and entity checks;
- revocation after intent blocks new intent but not result/recovery/observation;
- inverse start remains unavailable until every forward provider row is durably observed requested.

### Security and blast radius

- tenant A/B, anon, authenticated non-member/member/admin, and service-role matrices for every new
  relation, view, sequence, and function;
- direct insert/update/delete/truncate denied to API roles; immutability also rejects privileged
  update/delete/truncate;
- no cross-tenant scalar FK path and no credential/Vault value in evidence;
- static repository proof of no SP job union/enum, queue handler, worker import, provider call, web or
  MCP route, deployment variable, grant seed, hosted operation, Time Machine link, or ApplyRow
  lifecycle mutation.

## Acceptance

- [ ] Architecture/work-package commit precedes implementation.
- [ ] Migration and Drizzle mirror implement the selected proof-ledger shape.
- [ ] Empty installed state yields zero write authority.
- [ ] High correctness review reports no unresolved blocker/high finding.
- [ ] Extra-High adversarial review reports no unresolved blocker/high finding.
- [ ] Focused DB, concurrency, RLS/ACL, immutability, migration, and blast-radius proofs pass.
- [ ] Full `CI=1 pnpm check`, production build/Playwright, diff check, and staged hygiene pass.
- [ ] Exact-head PR CI and exact-main post-merge CI pass.
- [ ] Handover/status update only after merge and continues with the typed DB query slice.

## Deliberately deferred

- typed `packages/db/src/queries` facade and worker-facing error mapping;
- recovery polling cadence, operational lease renewal, and queue claimant fencing;
- current job union/enum registration, worker orchestration, and observation reads;
- web confirmation/status UI and Time Machine inverse review;
- environment/profile activation, bounded-authorization values, deployments, and any live Amazon or
  hosted schema operation.
