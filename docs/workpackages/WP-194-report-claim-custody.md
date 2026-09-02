# WP-194 — Fail-closed report claim custody

Owner: database, worker runtime and Evo deployment source.

Depends on: merged WP-193 and source-only WP-187/WP-192 migration ordering.

Architecture: `docs/design/WP-194-ARCHITECTURE.md`.

## Objective

Make the staged always-on report-worker design safe against stale reaping, timed shutdown, late
settlement and ambiguous Reporting v3 creation. Evo report claims become opaque-token fenced and are
never replayed based only on elapsed time. Deployment activation and rollback prove quiescence before
switching.

WP-194 is source-only until separately authorized. It does not apply a hosted migration, alter a
Vercel environment, deploy Vercel, activate or restart a service, recover a production job, mutate a
report ledger, call Amazon, enable a producer, or adopt historical unfinished rows.

## Owned files

- `supabase/migrations/20260901040000_fenced_sync_claims.sql`;
- `packages/db/src/schema/sync.ts`, queue query facade and focused tests;
- worker store, queue lifecycle, report-create classification, bounded parser/transport and tests;
- Evo readiness, activation, rollback, deployment harness and runbook;
- WP-194 architecture and this work-package brief.

Do not edit `packages/shared`, strategy doctrine, Sponsored Products write contracts, migration bytes
from WP-187/WP-192, seeds, handover or status. Handover and status change only after reviewed merge,
exact-main CI and external state reconciliation.

## Required behavior

1. Add one nullable UUID claim token to `sync_jobs`; existing rows remain byte-for-byte equivalent
   apart from the null column.
2. Add fenced claim, finish and defer RPCs with closed `settled/deferred/stale_claim` outcomes and
   service-role-only execute grants.
3. Make legacy finish, direct defer/release and stale reaping unable to mutate token-bearing rows while
   retaining current behavior for tokenless rows.
4. Select fenced custody only for `evo-report-lane`; web and integration runtimes remain compatible
   legacy consumers during rollout.
5. Key active fenced attempts by token, present the claim to every transition, and treat stale custody
   as an explicit sanitized failure.
6. Never release a fenced claim after a shutdown deadline. Health and shutdown evidence must identify
   unresolved custody without rendering ids or tokens.
7. Quarantine Reporting v3 create outcomes that may have reached Amazon but produced no durable id.
   Adopt a 425 only when it carries an id; never automatically replay an ambiguous create.
8. Bound compressed download bytes, decompressed bytes, idle time and total time. Limits must be
   deterministic, abortable and justified from aggregate evidence with headroom.
9. Readiness proves the exact hosted queue contract. Activation and rollback stop before switching
   unless current ownership is drained and the destination advertises the fenced protocol.
10. Preserve report row accounting, tenant boundaries, public-repo hygiene and v1 read-only behavior.

## Proof requirements

- fresh and populated migration replay with exact pre/post queue and report counts;
- concurrent fenced claim uniqueness and wrong/old/replaced-token refusal;
- every fenced terminal, retry, defer and dead-letter path uses the exact token;
- legacy finish, defer, release and both stale-reaper callers leave fenced rows unchanged;
- legacy tokenless crash recovery still functions;
- same job id under distinct claims cannot overwrite active promise bookkeeping;
- graceful shutdown settles completed fenced work and strands rather than releases unfinished work;
- report-create crash cuts classify known refusal versus possible dispatch without provider replay;
- bounded download tests cover compressed, decompressed, idle, total and abort limits;
- deployment harness covers first activation, failed pre-claim restoration, post-claim refusal,
  quiescent rollback and incompatible destination refusal;
- static blast-radius scan proves no shared contract, Amazon mutation, hosted apply or runtime activation.

## Acceptance checks

- [ ] Architecture and work-package contract committed separately before implementation.
- [ ] Focused DB, worker and deployment tests pass.
- [ ] Disposable PostgreSQL migration and concurrency proofs pass serially.
- [ ] High correctness and Extra-High adversarial reviews find no blocker, high or medium defect.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm hygiene` pass.
- [ ] Exact-head pull-request CI and exact-main CI pass both jobs.
- [ ] Hosted migration and deployment actions remain separately authorized and exactly evidenced.
- [ ] Handover and status are updated only after reviewed merge and exact-main CI.

## External gates

Merging WP-194 authorizes no external action. Hosted migration apply requires an exact ordered
migration review because production currently precedes two source-only migrations. Reduced Vercel
deployment, Evo staging, first activation, rollback and any claim recovery each require separate
attended authorization with their exact revision and observed queue scope.
