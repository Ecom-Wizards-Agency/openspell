# WP-191 — Token-fenced Sponsored Products outbox protocol architecture

Owner: architecture contract only.

Depends on: merged WP-179, WP-180, WP-187, WP-188, WP-189 and WP-190.

Architecture: `docs/design/WP-191-ARCHITECTURE.md`.

## Objective

Freeze the remaining claimant-fenced Sponsored Products outbox boundary on current main before any
database or worker implementation. The protocol must give each immutable WP-187 wake one private,
token-fenced delivery owner while preserving the rule that only a committed WP-188 dispatch ticket
can authorize one WP-180 mutation attempt.

WP-191 is documentation only. It performs no migration, hosted apply, job registration, provider
call, deployment, restart or activation.

## Owned files

- `docs/design/WP-191-ARCHITECTURE.md`;
- this work-package brief.

Do not edit `packages/shared`, `packages/db`, `packages/ads-api`, any app, `supabase/`, CI,
deployment, seeds, schedules, handover or status in this architecture package. Handover/status
changes occur only after reviewed merge and exact-main CI.

## Required decisions

1. Preserve `public.sp_write_outbox` as immutable evidence and place mutable custody in a separate
   private delivery head.
2. Append one immutable private event for every successful claim, expired takeover, renewal,
   deferment and completion.
3. Use fresh raw UUID tokens, store only their domain-separated SHA-256 digests, and increment a
   claim epoch on every acquisition, including same-claimant takeover.
4. Use PostgreSQL time after locks for claim eligibility, expiry, renewal, deferment, recovery
   readiness and completion.
5. Require exact live epoch/token compare-and-swap for renew, defer, complete, dispatch-lease
   acquisition and reservation. A stale actor changes nothing.
6. Bound claim batches, lease duration, absolute epoch lifetime and DB-owned defer backoff. Renewal
   cannot resurrect expiry or extend provider/recovery deadlines; callers cannot choose churn
   delays.
7. Keep the raw token outside JSON and arrays and private in a facade `WeakMap` behind a
   non-serializable claim handle. SQL transports it only as a dedicated typed UUID column. A claim
   handle is never a provider ticket.
8. Add claim-bound dispatch-lease and reservation wrappers which lock organisation before delivery
   head, validate the exact dispatch wake, invoke the canonical WP-187 capability, then revalidate
   unexpired custody before returning. Expiry during downstream lock waits rolls back the whole
   nested transaction.
9. Revoke `service_role` execute on both old tokenless signatures. The future facade has no
   tokenless overload.
10. Leave provider result, synthesized recovery, late audit and observation persistence independent
    of claim custody and all current authority/credential expiry.
11. Complete a dispatch wake only after every plan action has a permanent refusal or committed
    intent. Complete an observe/recover wake only after one canonical result, exact result-position
    closure and terminal observations for every accepted or ambiguous position.
12. Outside deliberate tenant purge, keep unresolved work recoverable forever. Deferment changes
    only delivery timing; no dead-letter or retryable-after-intent state exists. Permitted purge of
    pending observation delivery after a durable result is the sole deletion exception, not
    lifecycle completion.
13. Preserve tenant composite identity, organisation-first claim-bound lock order, guarded purge
    and zero application-role direct DML or claim-metadata visibility. Journal events cascade from
    the composite delivery-head parent, never directly from the outbox, so event insertion cannot
    reverse the purge lock order.
14. Keep shared contracts, `sync_jobs`, current job unions/enums, apps, provider reachability,
    schedules, deployment and hosted schema unchanged until later packages.
15. Freeze exact implicit head genesis, state/event projection and a current-custody predicate that
    runs before domain eligibility. A result-bearing or already-complete wake remains reclaimable
    for terminal settlement.
16. Expose discriminated dispatch and observe/recover claim identities plus fixed ordinary/error
    outcomes for stale custody, exact replay, incomplete closure, nested-lock expiry and
    outcome-unknown transport.

## Selected model

Use one mutable private custody head per immutable outbox wake plus one immutable transition
journal. Reject pure append-only current custody because concurrent first claim, latest-unsettled,
expiry/renewal and repeated-defer folds add avoidable correctness and query risk. Reject generic
`sync_jobs` changes and stateless scanning because they either widen the deployment blast radius or
cannot fence stale owners.

The public-safety timing contract caps a claim batch at 10 wakes, claimant identifiers at 128 ASCII
characters, reuses the existing 70-to-300-second lease range, defaults future callers to 120
seconds, caps one ownership epoch at 300 seconds from first claim, and uses the fixed DB-owned
15/30/60/120/240/300-second defer schedule. These are reviewed safety bounds, not tenant doctrine
values.

## Source-successor boundary

The next separately numbered database/facade package may add only:

- one additive forward migration after rechecking the exact last migration identity;
- private delivery-head and journal mirrors;
- controlled claim, renew, defer, complete, claim-bound lease and claim-bound reservation
  functions;
- both tokenless service-role grant revocations;
- an explicit outbox facade and claim-required runtime lease/reservation methods under
  `@wizard-ads/db/sp-write-persistence`;
- focused migration, PostgreSQL, concurrency, ACL, purge, facade and blast-radius tests.

That source package still does not host the migration, register a job, import the facade from an
app, reach WP-180, deploy a service or activate a write gate.

Worker coordination and activation remain later separately numbered packages.

## Architecture review gates

- High: compare the mutable-head and append-only models; verify schemas, transition counts, facade
  usability, compatibility and future test inventory.
- Extra High: verify stale-token rejection, claim-bound lease/reservation, lock order,
  expiry/renewal, crash cuts, recovery non-blocking, completion predicates, purge safety and
  provider no-redispatch.
- Main synthesis must resolve disagreements explicitly and include the rejected alternatives.

## Acceptance checks

- [ ] The architecture and this brief are the only changed files.
- [ ] The selected contract includes exact data ownership, state transitions, SQL/facade seams,
      lock order, completion predicates, error semantics, package sequencing and proof matrix.
- [ ] Lock-wait expiry proofs commit zero dispatch-lease, resolution, intent, outbox or ticket
      evidence.
- [ ] High review reports no unresolved blocker, high or medium finding.
- [ ] Extra-High review reports no unresolved blocker, high or medium finding.
- [ ] `git diff --check`, lint and public-repository hygiene pass.
- [ ] Exact-head PR CI and exact-main CI pass both jobs.
- [ ] Handover/status are updated only after merge.
- [ ] PR #24 closes unmerged only after WP-191 is accepted on exact main and linked as the durable
      preservation of its remaining token-fencing lesson.

## Non-goals

- No migration or Drizzle change in WP-191.
- No facade implementation or export change.
- No job payload, queue enum, handler, coordinator or worker main wiring.
- No provider import, adapter call, credential access or live probe.
- No environment/profile gate, bounded authorization, tenant activation or seed.
- No hosted migration, deployment, restart, queue-owner transfer or Amazon mutation.
- No reuse, rebase, cherry-pick or merge of PR #24 source.

## Completion

WP-191 completes after its documentation-only implementation is reviewed, merged and green on
exact main. Close PR #24 unmerged at that point, then update handover/status separately and begin
the source database/facade successor from the new reconciled main revision.
