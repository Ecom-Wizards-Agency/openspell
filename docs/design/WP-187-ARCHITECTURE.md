# WP-187 inert Sponsored Products write-persistence rationale

## Problem

WP-179 defines the canonical Sponsored Products write lifecycle and WP-180 implements an inert,
one-attempt provider adapter. Neither is live authority. WP-187 must persist the complete lifecycle
and make the one safe transition explicit: a provider call is legal only after one database
transaction rechecks current authority and commits a unique write-ahead intent.

The slice must remain inert. It adds no current job type, queue member, worker handler, provider
import, schedule, environment enablement, profile grant, deployment change, hosted migration, or
Amazon call. The existing conflicting PR #24 is archaeology only; it must not be rebased, merged, or
cherry-picked wholesale.

## Usage from the caller's view

The future typed DB package records artifacts only after the existing WP-179 verifiers accept their
exact canonical text and fingerprint preimages:

```ts
// Future usage; WP-187 adds SQL persistence, not this TypeScript facade.
const staged = await ledger.recordApprovalArtifacts({
  plan,
  inversePlan,
  boundedAuthorization,
});

// The authenticated owner/admin supplies only the canonical approval request.
// PostgreSQL supplies actor, time, gate versions, generation, and receipt. A manual
// forward gets a DB-generated cycle ID; inverse-bound flows adopt and validate the
// sourceExecutionId already frozen into the inverse plan.
const receipt = await ledger.approveCycle(staged, approvalRequest);

// Approval and execution initiation are deliberately separate acts.
await ledger.startPlanExecution(receipt.approvalId, receipt.plan.planId);
```

A future worker acquires a DB lease, reads exact provider state through WP-180, and proposes one
already-verified intent. The commit result, not possession of a job or lease, is mutation authority:

```ts
const lease = await ledger.acquireDispatchLease({
  executionId: receipt.executionId,
  planId: plan.id,
  generation: receipt.generation,
  routeKey: prepared.routeKey,
});

const providerObservation = await adapter.observeCurrent({ plan, call: prepared });
const intent = freezeIntent({ plan, receipt, lease, providerObservation, prepared });

const reservation = await ledger.reserveProviderCall({
  plan,
  receipt,
  lease,
  providerObservation,
  intent,
});

if (reservation.kind !== 'won') return; // zero provider mutation calls

const result = await adapter.executeOneAttempt({
  plan,
  intent: reservation.intent,
  resultId: reservation.resultId,
});
await ledger.appendProviderResult(result, 'provider_adapter');
```

The winning transaction stores the observation, intent, positions, stable result ID, and one inert
observation/recovery outbox wake. A duplicate reservation never receives a dispatch ticket, even if
its artifact is byte-identical. Losing the commit response therefore causes conservative ambiguity,
not a second Amazon call.

Result and observation appends do not recheck mutation gates. If an intent has no durable result, a
future recovery consumer builds a complete all-ambiguous `SpWriteProviderResult` with the already
reserved result ID, appends it with origin `recovery_synthesized`, and observes current provider
state. It never calls the mutation adapter for that intent.

## Shape

### Frozen artifacts plus relational proof columns

WP-179 remains the semantic contract. Each fingerprinted artifact relation stores:

```ts
type StoredArtifact = {
  artifactText: string;          // exact canonical JSON bytes supplied by the verifier
  artifact: unknown;             // JSONB projection; must equal artifactText parsed as JSON
  fingerprintPreimage: string;   // exact domain-separated WP-179 preimage bytes
  fingerprint: string;           // lowercase SHA-256
};
```

An intent additionally stores its independently serialized provider-request preimage and
`requestFingerprint`. The provider-request and enclosing-intent digests are distinct WP-179 proofs;
neither is inferred from the other or recreated by a SQL serializer.

SQL verifies the SHA-256 of `fingerprintPreimage`, the expected domain, the semantic JSON value of
the preimage, and the artifact's fingerprint field. It duplicates only the columns required for
tenant-scoped foreign keys, row locks, uniqueness, route checks, exact counts, and indexes. Money
remains a canonical decimal string inside the artifact; no floating or generic numeric projection is
introduced.

The relations are grouped by the knowledge they own rather than by worker timing:

- authority: environment-gate heads and immutable versions, profile-grant heads and immutable
  full-scope versions, bounded authorizations, append-only revocations, and a global consumption
  tombstone carrying only authorization/cycle identity;
- approvals: plans, ordered actions, approval requests, DB-issued receipts/cycles, and forward or
  inverse child plan executions keyed by `(execution_id, plan_id)`;
- mutation fencing: immutable dispatch leases, direct predispatch observations/items, per-action
  refusals, provider-call intents/positions, and one permanent action resolution;
- reconciliation: provider results/positions, synchronized observations, and a derived accounting
  view;
- handoff: an immutable SP-only outbox containing `dispatch` or `observe_and_recover` wakes, with no
  claim or delivery state in this slice.

Every tenant relation repeats `org_id` and `profile_id`; every child uses composite foreign keys
through the complete parent chain. Historical provider scope is evidence, not a foreign key that
freezes a live credential. Mutation reservation still locks and rechecks the current profile and
connection route. After intent, a replacement credential may be used for read-only observation.

No execution status, accounting counter, mutation-eligible flag, retry count, inverse boolean, or
outbox delivery status is stored. Status and accounting derive from append-only facts using the
WP-179 equations.

### Authority and provider scope

The source migration creates no gate head and no profile grant. An empty authority set is disabled
by construction. Gate and grant changes are later manager-gated operations, outside WP-187.

A profile-grant version freezes the complete provider scope:

```ts
type SpWriteProfileGrantVersion = {
  grantId: string;
  version: string;
  orgId: string;
  profileId: string;
  enabled: boolean;
  amazonProfileId: string;
  connectionId: string;
  region: 'NA' | 'EU' | 'FE';
  marketplaceId: string;
  currencyCode: string;
  apiDialect: 'sp_v3';
};
```

It contains no credential or Vault value and has no foreign key to the live Ads connection.
Historical evidence cannot restrict, cascade from, or otherwise freeze credential rotation.
Reservation locks and joins the current connection route and proves its org/profile/scope
relationship without making that live row the parent of historical evidence.

Bounded authorizations remain service-only because one authorization may list multiple tenant
profiles. Tenant-visible receipts expose only the exact authorization binding needed by WP-179.
Their literal `maxCycles: 1`, `maxExecutions: 2`, and `maxConcurrentMutations: 1` limits are enforced
without reinterpretation. Approval consumes a bounded authorization under its existing lock by
inserting a service-only, immutable global tombstone keyed uniquely by both authorization ID and
cycle ID. The tombstone contains no tenant or provider data and deliberately survives tenant
purge, so deleting one profile's cycle cannot resurrect `maxCycles: 1` for another profile. A
DB-owned environment-gate safety limit additionally permits only one unresolved provider call
globally in v1; this is the independently testable cross-profile capacity race. Manual cycles also
permit at most one unresolved call within the cycle.

### Cycle, execution, and inverse identity

`SpWriteAuthorizationReceipt.executionId` is the forward/inverse cycle ID. Each plan has a child
ledger keyed by `(execution_id, plan_id)`. A manual forward receipt gets a DB-generated cycle ID. A
bounded forward receipt adopts and validates the otherwise-unused cycle ID already frozen into the
exact inverse plan's `sourceExecutionId`; the approval request itself still cannot supply it. A
later manually approved inverse adopts and validates its frozen source execution ID and joins that
existing cycle rather than inventing a second identity.

Approval receipts are separate immutable rows keyed by `approval_id` and reference the stable
cycle. Each `(execution_id, plan_id)` child binds its authorizing approval and generation. Bounded
forward and inverse children share the receipt that preauthorized both exact plan bindings. A later
manual inverse child has its own approval and generation and never overwrites the forward receipt.

Approval stores a cycle and its plan bindings but creates no intent or outbox. A separate
service-role execution-start capability inserts the child execution request and one inert dispatch
wake. Inverse start is unavailable until the source forward child is completely observed at
requested values under the shared derived accounting.

### DB-owned gate snapshot digest

`gateSnapshotFingerprint` remains an opaque WP-179 field. PostgreSQL owns its bytes using this exact
UTF-8 preimage, with LF separators and no trailing LF:

```text
openspell.sp-write-gate-snapshot.sql.v1
environment=enabled
environment_version=<lowercase UUID>
profile_grant_id=<lowercase UUID>
profile_grant_version=<lowercase UUID>
checked_at=<UTC YYYY-MM-DDTHH:MM:SS.ffffffZ>
```

SQL uses core `pg_catalog.sha256(bytea)` and lowercase hexadecimal encoding. A Node golden test must
prove the exact same preimage and digest, including UUID case, timestamp precision, timezone, and
the absence of a final newline. The complete provider scope is transitively bound by the immutable
grant version and is stored on the receipt and plan.

### Atomic reservation

The reservation capability is one transaction with this conceptual signature:

```sql
-- Architecture signature; implementation may use composite/private SQL types.
app.reserve_sp_write_provider_call(
  p_execution_id uuid,
  p_plan_id uuid,
  p_generation uuid,
  p_dispatch_lease_id uuid,
  p_predispatch_observation_text text,
  p_predispatch_observation_preimage text,
  p_intent_text text,
  p_request_fingerprint_preimage text,
  p_intent_preimage text
) returns table (
  decision text,              -- won | busy | refused | already_intended
  refusal_reason text,
  checked_at timestamptz,
  result_id uuid,
  intent_text text
);
```

The implementation locks and rechecks, using `clock_timestamp()` after lock waits:

1. the current environment gate and exact version bound by the receipt;
2. the current full-scope profile grant and exact bound version;
3. the live tenant/profile/connection route for mutation only;
4. the receipt, cycle, child plan, generation, direction, expiry, and current dispatch lease;
5. the global environment capacity plus bounded-authorization revocation, cycle, execution, and
   concurrency limits;
6. the exact plan actions, route, stable provider-entity identities, prior dispositions, prior
   intents, unresolved observations, and source inverse evidence;
7. the fresh direct provider observation and exact expected values for every proposed position.

On success it independently verifies the provider-request and intent preimages, then inserts the
canonical observation and normalized items, canonical intent and exact `0..n-1` positions, one
DB-derived stable result ID, one permanent action-resolution row per position, and one
`observe_and_recover` outbox wake. Offered, inserted, and outbox counts are asserted before
returning. Only the transaction that inserted these rows returns `won` and the dispatch ticket.

The stable result UUID is an RFC 9562 UUIDv8 derived from the first 128 bits of SHA-256 over this
UTF-8 preimage:

```text
openspell.sp-write-reserved-result-id.sql.v1
<lowercase intent UUID>
```

Take the first 16 digest bytes, replace the high nibble of octet 6 with `0b1000` (version 8), and
replace the high two bits of octet 8 with `0b10` (the IETF variant), preserving every other digest
bit. Format the result as a lowercase `8-4-4-4-12` UUID. UUIDv8 is intentional: RFC 9562 reserves
it for custom formats and illustrates this same SHA-256 name-based construction; UUIDv5 would
mislabel a SHA-256 derivation as the standardized SHA-1 algorithm.

`result_id` is globally unique. A collision between distinct intent IDs is a fail-closed reservation
error; it never reuses an existing result identity.

Exact retries and overlapping requests return no authority. The permanent per-plan fence is one
resolution per `(execution_id, plan_id, action_id)`; an intent is never changed back to pending.
Reservation also takes sorted advisory locks for each stable
`(org_id, profile_id, route_key, amazon_entity_id)` and returns nonterminal `busy`, with no evidence
or action resolution, while another cycle has unresolved evidence for that entity. An authoritative
rejection releases that entity fence with the result;
accepted or ambiguous positions release it only after a terminal synchronized observation. The
global open-call capacity counts intents without a durable result and releases only when one result
wins the unique slot.

After lock waits, reservation captures `checked_at` and records
`dispatch_start_deadline = checked_at + interval '5 seconds'` and
`provider_attempt_deadline = checked_at + interval '35 seconds'`. A winning worker refuses a ticket
whose start deadline is already past and passes the absolute remaining provider deadline into
WP-180; the adapter deadline covers credential resolution, fetch, and body consumption. The
dispatch lease must extend at least 70 seconds after `checked_at`. Recovery is unavailable until
both the provider-attempt deadline and the dispatch lease have expired, so synthesized ambiguity
cannot release capacity while the one allowed HTTP attempt may still be running.

### Refusal, result, recovery, and observation

A terminal reservation refusal never calls Amazon. The same transaction constructs, fingerprints,
and stores one canonical WP-179 disposition plus a permanent refusal resolution for every selected
still-pending action. A stale-state refusal also stores the verified predispatch observation and its
exact items in that transaction, and asserts observation/item/disposition counts before commit.
SQL construction is deliberately limited to this small DB-owned artifact and is locked by
cross-language goldens. Transient capacity, cross-cycle entity fencing, or incomplete-inverse
verdicts return `busy` and consume no action, so they can be reconsidered without claiming a
terminal refusal.

Refusal categories retain their WP-179 meanings: an environment absence, closure, or version change
is `environment_gate_closed`; a profile-grant absence, closure, version, or scope change is
`profile_gate_closed`; live provider-route drift is `route_mismatch`; bounded-authorization
revocation or a superseded child generation is `authorization_revoked`; a missing/stale lease is
`lease_unavailable`; an otherwise unrecorded duplicate conflict is `duplicate_intent`; observed
value drift is `stale_expected_state`; and incomplete provider context is
`unsupported_provider_state`.

Prior resolution is handled before refusal construction: it returns `already_intended` with no new
disposition or resolution, because WP-179 forbids one action from carrying both. For still-pending
actions, `approval_expired` has precedence over gate, grant, route, generation, lease, and observed
state checks; its cutoff timestamp is therefore always valid. Transient `busy` is evaluated before
other terminal categories only when current authority remains otherwise valid.

For the shared `approval_expired` reason only, `recordedAt` is the authority-cutoff effective instant
`receipt.expiresAt`; DB-owned `persisted_at` records when the refusal was later detected or
synthesized. Every other disposition uses its actual decision time. This matches the existing
verifier, which permits equality with expiry but rejects a later artifact time, without changing the
frozen contract. SQL requires `persisted_at >= receipt.expiresAt`, and a shared-verifier golden
proves the resulting artifact.

Provider and recovery results share one append path and one unique result slot. Recovery origin is a
DB-owned column, not a new shared field. A recovery result must use the reserved result ID, cover
every intent position exactly, mark every position `ambiguous`, and contain only bounded sanitized
diagnostics. A provider-result/recovery race has one immutable winner; neither can overwrite the
other. A sanitized, immutable rejected-append audit fact retains a late provider result only after
WP-179 fingerprint verification and exact tenant, intent, reserved-result, request, position,
action, and entity binding checks. Invalid or foreign artifacts are discarded from tenant evidence.
The retained fact never becomes canonical evidence or changes derived status.

Observation append requires a durable result and exact plan/action/intent/request identity, but does
not inspect the current gate, grant, authorization expiry, generation, lease, or live credential
binding. The outbox freezes a separate tenant-scoped logical `source_sync_job_id`; the later
observation job must adopt that identity exactly, and `SpWriteObservation.sourceSyncJobId` must equal
it. The outbox row's own primary key is not overloaded as a job identity, and callers cannot supply
an unrelated UUID. Read failure retries only the read and does not write a terminal observation.

The combined outbox row is only an immutable wake, not permission to recover or observe. A later
consumer derives eligibility from DB time and intent/result facts: an existing result permits
observation; a missing result permits neither observation nor synthesized ambiguity until both
deadlines described above have elapsed. WP-187 adds no consumer.

## SQL capability surface

WP-187 keeps direct DML closed to `anon`, `authenticated`, and `service_role`. Frozen authority and
evidence also reject privileged direct update, delete, and truncate. The sole delete exception for
tenant-scoped rows is the repository's existing deliberate organisation purge. A `BEFORE DELETE`
guard refuses that purge while the organisation has any provider-call intent without a durable
provider result or recovery fact. Reservation takes a `KEY SHARE` lock on the owning organisation
before every authority/tenant lock and holds it through intent commit: either deletion wins and
reservation cannot proceed, or deletion waits and then observes the committed unresolved intent.
Once calls are durably closed, cascading deletion may proceed only after the tenant's parent `orgs`
row is already absent, an unspoofable database fact. The global bounded-authorization consumption
tombstone does not cascade. Fixed-search-path,
`SECURITY DEFINER` functions provide only complete capabilities:

- service role: record a verified plan/authorization, start a child execution, acquire a dispatch
  lease, reserve one call, and append a verified result/observation;
- authenticated owner/admin: approve one already-recorded exact plan request, deriving actor and DB
  time;
- reads: tenant-RLS evidence relations and a security-invoker derived-accounting view.

No gate/grant activation function is executable by an application role in this slice. Every
function is explicitly revoked from `public` and granted only to its intended role. Any later
authority mutation must use expected-version compare-and-swap and the same lock order as approval
and reservation. Reservation locks the owning organisation first, then the global environment head,
profile-grant head, bounded authorization, cycle/child, and sorted provider entities. Approval has no
intent-producing tenant mutation before its environment/profile/authorization sequence. Tests
simulate those locked head changes with privileged transactions now so later activation cannot
define an incompatible order.

## Synthesis decision

Three independent candidates were compared:

- Candidate A minimized the public surface with four deep capabilities, mutable authority heads
  backed by immutable versions, and one generic controlled evidence append;
- Candidate B optimized disposable-DB proof with append-only authority facts, global serialization,
  deterministic result recovery, and explicit derived accounting;
- Candidate C maximized adversarial recovery and worker replacement with byte-preserving artifacts,
  action-resolution slots, a dedicated claimant-fenced work protocol, and DB-created evidence.

The selected design uses Candidate A's small capability boundary, Candidate B's global safety
capacity, deterministic proof vectors, and conservative concurrency tests, and Candidate C's exact
artifact bytes, permanent action-resolution fence, and explicit cycle/child identity.

It deliberately excludes Candidate C's work-claim protocol from WP-187. Queue claimant fencing is a
separate global concern, and adding an alternative queue here would expand this schema slice into an
active worker subsystem. It also excludes Candidate B's rule that an exact duplicate reservation
can recover the original ticket: only the inserting transaction receives mutation authority.

## Tradeoffs accepted

- We accept a substantial private relational ledger in exchange for a small capability surface and
  executable tenant, count, uniqueness, and crash invariants.
- We accept artifact text, JSON projection, preimage, and enforcement columns in exchange for both
  byte-preserving audit and relational proof.
- We accept a DB-owned global one-open-call safety limit, the literal bounded-authorization limits,
  per-cycle limits, and unresolved provider-entity fences in exchange for a simple capacity-one proof
  across profiles and plans.
- We accept a conservative all-ambiguous recovery after any committed intent without a result in
  exchange for never replaying an uncertain Amazon mutation.
- We accept narrow SQL construction of terminal refusal dispositions in exchange for atomic action
  consumption and closed accounting on every terminal predispatch refusal.
- We accept dedicated inert outbox wakes with no delivery state until queue fencing and worker slices
  are separately reviewed.
- We accept complete provider-scope evidence without freezing live credentials, so observation and
  recovery remain possible after credential rotation.

## Alternatives rejected

### PR #24 wholesale

Its shared/provider code, floating values, mutable status and counters, retryable state after intent,
partial campaign context, apply-row lifecycle coupling, inverse boolean/reapproval mechanism,
active jobs, queue protocol change, and Time Machine auto-link conflict with current main.

### One generic JSON event table

It reduces DDL but moves every foreign key, uniqueness rule, count proof, and lifecycle fold into
large trigger or caller code. That is shallow persistence and was rejected.

### Fully flattened provider semantics

It would reproduce WP-179 in SQL and turn shared-contract evolution into migrations. Only proof
columns are projected.

### Mutable execution aggregates

Stored status, counters, or retry eligibility can drift from evidence and require repair writes.
They are rejected as authority.

### Current `sync_jobs` or a new claim subsystem

The current queue lacks claimant fencing, and adding SP job membership could poison older workers.
Both queue changes are deferred to a separate repository-wide protocol package.

### DB-created complete shared artifacts

Reimplementing every WP-179 serializer in SQL would create a second contract. WP-187 constructs only
its own gate digest, reserved result ID, authorization receipt, and the small terminal-refusal
artifact needed for atomic closure; already-verified shared artifacts cross the boundary as exact
bytes and every independently required preimage.

## Red-flag screen

- Shallow module: avoided; callers cannot coordinate table writes or choose authority facts.
- Information leakage: avoided; the DB owns locks, clock, gate revisions, capacity, result identity,
  and resolution uniqueness.
- Temporal decomposition: avoided; authority and lifecycle facts are grouped by invariant, not by
  web/worker step.
- Pass-through methods: avoided; each capability derives or enforces a complete transaction policy.
- Contract duplication: bounded; SQL validates exact bytes and narrow projections rather than
  recreating provider semantics.

## Open risks and later decisions

- The target fresh-test and hosted-compatible PostgreSQL runtimes must expose
  `pg_catalog.sha256(bytea)`; this is an executable pre-implementation gate.
- Exact authenticated read visibility for raw plan/result diagnostics must be least-privilege
  reviewed. The default is tenant-member evidence reads and service-only bounded-authorization
  detail.
- An organisation purge is refused while any of its committed provider-call intents lacks a durable
  provider result/recovery. After closure, purge removes tenant bindings and lifecycle evidence but
  preserves the payload-free bounded-authorization consumption tombstone. The immutable bounded-
  authorization root remains global because one operator authorization may span organisations;
  its permanent consumption prevents a surviving profile binding from reusing `maxCycles: 1`.
  Expired/orphan global-authority retention and cleanup is later manager-only operational work, not
  an application capability in WP-187.
- The 5-second dispatch-start, 35-second provider-attempt, and 70-second minimum-lease constants are
  public safety protocol, not doctrine. Changing them requires a coordinated persistence/adapter
  review; operational recovery cadence remains for the later worker package.
- Current queue claim tokens remain a separate prerequisite before any SP job type is registered.
- Production activation remains a later exact-revision, attended operation with an enabled gate,
  explicit profile grant, bounded authorization, and worker claim allowlist.

## Module map

```text
supabase/migrations/20260901020000_sp_write_persistence_ledger.sql
  lock envelope, narrow enums, authority and evidence relations, private helpers,
  controlled RPCs, RLS/ACL, immutability, derived accounting

packages/db/src/schema/sp-writes.ts
  Drizzle mirror and narrow inferred row types only
packages/db/src/schema/enums.ts
  narrow storage enum mirrors
packages/db/src/schema/index.ts
  mirror export

packages/db/src/sp-write-persistence.test.ts
  migration, schema, fingerprint, RLS/ACL, immutability, lifecycle, and 50-way proofs
packages/db/src/rls.test.ts
supabase/tests/tenant-fixture.sql
  dynamic tenant coverage and synthetic rows for every new public tenant relation

docs/workpackages/WP-187-sp-write-persistence-ledger.md
docs/design/WP-187-ARCHITECTURE.md
```

No `packages/db/src/queries/*`, shared, Ads API, worker, web, MCP, queue, deployment,
production/operator seed or activation data, or hosted operation belongs to WP-187. The synthetic
disabled test fixture exists only so dynamic RLS coverage can exercise every new tenant relation.

## Next implementation step

Commit this architecture and its work-package contract first. Then implement the source-only
migration, Drizzle mirror, and executable database proofs. Do not apply the migration to hosted
Supabase in WP-187.
