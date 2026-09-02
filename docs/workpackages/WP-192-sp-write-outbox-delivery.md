# WP-192 — Token-fenced Sponsored Products outbox delivery

Owner: database and facade source only.

Depends on: merged WP-179, WP-180, WP-187, WP-188, WP-189, WP-190 and WP-191.

Architecture: `docs/design/WP-191-ARCHITECTURE.md`.

## Objective

Implement the inert database and typed-facade successor frozen by WP-191. Each immutable
`public.sp_write_outbox` wake receives one private mutable delivery head, an immutable transition
journal and one opaque token-fenced owner. A live dispatch claim is required before either the
WP-187 dispatch-lease capability or provider-call reservation can run.

WP-192 remains source-only. It does not apply a hosted migration, register or activate a job,
import the facade from an app, reach the WP-180 provider adapter, deploy a service, enable an
environment or profile write gate, or make an Amazon call.

## Owned files

- supabase/migrations/20260901030000_sp_write_outbox_delivery.sql;
- `packages/db/src/schema/sp-write-outbox.ts` and its schema-index export;
- `packages/db/src/queries/sp-write-persistence.ts` through the existing explicit
  `@wizard-ads/db/sp-write-persistence` subpath;
- focused database migration, protocol, facade, integration and blast-radius tests under
  `packages/db/src/`;
- this work-package brief.

Do not edit `packages/shared`, `packages/ads-api`, an app, worker job contracts, CI, seeds,
deployment files, WP-187's migration bytes, handover or status in this source package. Handover
and status change only after reviewed merge and exact-main CI.

## Storage contract

The migration adds `app.sp_write_outbox_delivery_heads`, keyed one-to-one to the immutable outbox
by the composite `(org_id, profile_id, outbox_id)` identity, and
`app.sp_write_outbox_delivery_events`, whose composite cascading parent is the delivery head rather
than the outbox. The head owns only current custody. The journal owns one immutable event for every
successful claim, expired reclaim, renewal, deferment and completion.

Head state is exactly `available | leased | completed`. Claim epoch and attempt count begin at zero
and remain equal. Transition sequence begins at zero and advances once per event. Genesis is
available at the immutable wake's `created_at`. A leased head alone carries claimant, token digest,
claim time and lease expiry. A completed head alone carries completion time. There is no failure or
dead-letter state.

The raw claim token is a fresh UUID returned once. PostgreSQL stores only lowercase SHA-256 over
the UTF-8 bytes `openspell.sp-write-outbox-claim-token.sql.v1`, one LF, then the lowercase UUID,
with no trailing LF.

Events are exactly `claimed | expired_reclaimed | renewed | deferred | completed`. Every event
carries the actor claimant and token digest for its epoch. Conditional timestamps and defer reason
follow the exact fold in WP-191, and folding contiguous events from genesis must reproduce the head.
Event update and truncate are forbidden. Delivery data may disappear only through the already
guarded parent-absent tenant purge.

The internal outbox insert trigger creates one genesis head in the same transaction. Upgrade
backfill runs in `(created_at, outbox_id)` order and aborts unless existing wake and head counts
close exactly. The migration retains the five-second shared DDL lock envelope.

## SQL capability contract

Claim is the sole raw-token producer:

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

For a nonzero batch, every row repeats the same counts, `offered_count = claimed_count` equals the
number of returned rows, and `claim_ordinal` is frozen as one-based `1..claimed_count` in immutable
wake order. The zero result is exactly one header row with both counts zero and every claim column,
including ordinal, null. Dispatch rows have all provider/intent/source columns null;
observe/recover rows have all three non-null.

The transition capabilities are exact single-row result surfaces:

```sql
app.renew_sp_write_outbox_claim(
  p_outbox_id uuid,
  p_claim_epoch bigint,
  p_claim_token uuid,
  p_lease_seconds integer
)
  returns table (decision text, checked_at timestamptz, expires_at timestamptz);

app.defer_sp_write_outbox_claim(
  p_outbox_id uuid,
  p_claim_epoch bigint,
  p_claim_token uuid,
  p_reason text
)
  returns table (
    decision text, reason text, checked_at timestamptz, available_at timestamptz
  );

app.complete_sp_write_outbox_claim(
  p_outbox_id uuid,
  p_claim_epoch bigint,
  p_claim_token uuid
)
  returns table (decision text, checked_at timestamptz, completed_at timestamptz);
```

Renew decisions are `renewed | renewal_limit_reached | stale_claim`; expiry is non-null for the
first two only. Defer decisions are `deferred | already_deferred | stale_claim`; reason and
availability are non-null for the first two only. Complete decisions are
`completed | already_completed | not_complete | stale_claim`; completion is non-null only for the
first two. Exact defer and complete replays change no row or event. Renew/defer treat an absent head
as ordinary stale custody; completion reports a missing immutable parent or delivery head as the
fixed missing-dependency error. Existing expired, replaced or deferred custody is ordinary stale
custody.

The claim-bound capabilities are:

```sql
app.acquire_sp_write_dispatch_lease_for_claim(
  p_outbox_id uuid,
  p_claim_epoch bigint,
  p_claim_token uuid,
  p_route_key public.sp_write_route_key,
  p_lease_seconds integer
) returns table (lease_id uuid, acquired_at timestamptz, expires_at timestamptz);

app.reserve_sp_write_provider_call_for_claim(
  p_outbox_id uuid,
  p_claim_epoch bigint,
  p_claim_token uuid,
  p_execution_id uuid,
  p_plan_id uuid,
  p_generation uuid,
  p_dispatch_lease_id uuid,
  p_observation_text text,
  p_observation_fingerprint_preimage text,
  p_intent_text text,
  p_request_fingerprint_preimage text,
  p_intent_fingerprint_preimage text
) returns table (
  decision text,
  refusal_reason text,
  checked_at timestamptz,
  result_id uuid,
  intent_text text
);
```

The first three arguments are outbox ID, claim epoch and raw token. Reservation then receives the
existing nine WP-187 arguments unchanged. Both wrappers read immutable identity, lock organisation
`KEY SHARE`, lock the delivery head, capture database time, prove the exact live dispatch claim,
invoke the canonical WP-187 capability, recapture time and revalidate custody before returning.
Initial claim unavailability yields no dispatch lease or the ordinary reservation decision
`claim_unavailable`. Expiry during a downstream wait raises `40001`, rolling back every nested
lease, refusal, resolution, intent, wake and ticket-producing write.

`service_role` loses execute on both old tokenless signatures and gains execute on claim, renew,
defer, complete and the two claim-bound wrappers. Canonical old functions remain private internal
implementation. Application roles receive no head, event, sequence or helper privilege.

## Facade contract

The existing explicit DB subpath adds `createSpWriteOutboxLedger`. `claimAvailable` accepts only a
trimmed claimant matching `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`, a nonempty unique exact-kind list,
limit `1..10`, and lease `70..300` seconds with facade default 120. It returns exact offered and
claimed counts plus frozen discriminated dispatch or observe/recover claims.

Claim epoch is a canonical bigint decimal string. SQL transports each raw UUID token only in its
dedicated typed column, never in SQL JSON, metadata or array fields. The driver necessarily
materializes module-local result rows; the facade moves each token immediately from that private
row batch into a module-private `WeakMap<SpWriteOutboxClaim, string>`. No token reaches a
caller-visible array, claim property, JSON, log, error or provider ticket. Claims are frozen,
reject JSON serialization and must be the exact WeakMap key. A structural clone or forged handle
fails before SQL.

`renewClaim`, `deferClaim` and `completeClaim` expose only the ordinary outcomes above.
`SpWriteRuntimeLedger.acquireDispatchLease` and `reserveProviderCall` require an opaque dispatch
claim; there is no tokenless overload. Reservation adds only
`closed_without_dispatch/claim_unavailable`. Result, recovery, observation and evidence reads stay
token-free.

Every input is parsed before SQL and every result proves exact count, order, identity, timestamp
and conditional-nullability closure. Exceptional paths use the existing sanitized
`SpWritePersistenceError`, retain no driver error or token and have `providerCallAllowed: false`.
Every acquire/reserve exception is `reconcile_only`; no capability automatically retries.

## Proof requirements

- fresh replay and populated WP-187 upgrade with exact trigger/backfill counts;
- five-second DDL lock rollback and replay without legacy data drift;
- exact private Drizzle columns, constraints, indexes, parentage and ACLs;
- exact genesis, event nullability and head/journal fold after every transition;
- 50-way claim race, same-claimant takeover, live-lease exclusion and zero-header closure;
- wrong, missing, expired and replaced token refusal for every controlled capability;
- database-clock renewal cap, exact defer schedule and exact replay behavior;
- dispatch and observe/recover completion refusal for every partial accounting state;
- claim-bound lease/reservation and revoked tokenless service-role entrypoints;
- downstream lock expiry returns `40001` with zero nested writes committed;
- provider result, recovery and observation persistence remain independent of claim custody;
- organisation purge races with every transition and wrapper without deadlock;
- exact token isolation, typed claim discrimination and malformed-row rejection;
- static absence of shared/job/queue/app/provider/schedule/seed/deployment/hosted activation.

The canonical WP-187 suite remains pinned through
`20260901020000_sp_write_persistence_ledger.sql`; WP-192 has separate upgrade and protocol proofs.

## Acceptance checks

- [ ] Focused DB typecheck, lint and pure facade tests pass.
- [ ] Fresh and populated PostgreSQL migration/protocol tests pass serially.
- [ ] The canonical WP-187 suite still passes unchanged in behavior at its exact migration.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm hygiene` pass.
- [ ] High correctness and Extra-High adversarial reviews find no blocker, high or medium defect.
- [ ] Blast-radius scans prove no runtime or hosted activation.
- [ ] Exact-head PR CI and exact-main CI pass both jobs.
- [ ] Handover and status are updated only after reviewed merge and exact-main CI.
