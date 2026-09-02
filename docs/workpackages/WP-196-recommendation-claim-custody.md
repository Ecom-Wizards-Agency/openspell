# WP-196 — Exclusive recommendation claim custody

Owner: recommendation queue custody, recommendation-only worker and optimizer readiness boundary.

Depends on: merged WP-195 and source migration order through WP-195.

Architecture: `docs/design/WP-196-ARCHITECTURE.md`.

## Objective

Add the missing WP-195-compatible recommendation claimant and make campaign-scoped `Run preview`
safe to activate without overlapping Vercel or the legacy mixed worker. Bind every recommendation
run write to the exact opaque queue claim and preserve the existing integration and report lanes.

WP-196 is source-only until separately authorized. It does not apply a hosted migration, stage or
activate a service, deploy web, call Amazon, export a bulk file, mutate an Amazon campaign, recover a
production job or change a production queue.

## Owned files

- new `20260901060000` recommendation authority/admission migration and focused migration tests;
- narrow recommendation database principal, RPC facade and privilege-denial proofs;
- recommendation queue query adapter, recommendation-only claimant/runtime and focused tests;
- exact claim-binding and direct-old-writer barrier changes in the recommendation run store;
- Vercel recommendation ownership and optimizer readiness gate with focused tests;
- recommendation-worker staging, activation, verification, rollback and read-only cutover package;
- WP-196 architecture and this work-package brief.

Do not edit `packages/shared`, Ads API, SP-API, Amazon write gateway/outbox/delivery, report authority,
earlier migration bytes, seeds, handover or status. Handover and status change only after reviewed
merge, exact-main CI and external-state reconciliation.

## Required behavior

1. Add a private recommendation authority whose initial legacy state preserves current claim and
   admission behavior when the migration is applied.
2. Separate admission blocking, exact-revision fenced activation, fenced-to-fenced revision rebind
   and scope-version-1 admission into compare-and-set transitions. Lost transition responses are
   unknown until exact authority readback proves the old or new tuple; never retry or restore blind.
3. Make both legacy claim overloads, tokenless finish and stale recovery exclude
   `recommendations.run` after fenced activation while preserving every non-recommendation lane.
4. Add a NOLOGIN-by-default recommendation runtime principal with no `service_role` membership,
   bypass-RLS, direct table DML, Vault/provider/integration/SP-write or general queue authority.
5. Add narrow recommendation claim/read/start/succeed/fail/finish/defer RPCs that hardcode
   `recommendations.run`, require exact authorized revision and bind one opaque non-expiring claim.
   The NOLOGIN executor has exact relation-targeted RLS policies, while the runtime has only effective
   execute authority on these RPCs; identity is direct-login `session_user`, never a GUC.
6. Carry the full `ClaimRef` through runner start, success and failure. Every run/recommendation/audit
   mutation verifies exact job, worker, token, tenant, profile, payload and immutable scope in the
   same transaction.
7. Add always-locking mutation triggers that preserve legacy behavior before fencing but reject old
   direct service-role execution writes afterward, including a stale tokenless executor whose queue
   row has already drained. Guard scoped and historical unscoped queue lineage; exempt only an exact
   jobless human negative-proposal lineage whose stored shape and audit provenance close.
8. Resume unresolved work only for the same stable worker identity and authorized exact revision.
   Lost-host recovery remains attended; no timer or lease expires a live claim.
9. Add an immediate authority-locking admission gate plus deferred transaction-complete validator:
   legacy admits legacy work, blocked admits none, and scoped admits only exact WP-195 scope-version-1
   evidence recomputed by a Node-equivalent private SQL fingerprint canonicalizer.
10. Add a dedicated single-flight DB-only worker role with exactly `recommendations.run`, no periodic
   producer/reaper/observer pass and no Amazon/provider dependency or credential.
11. Add a capability-free loopback health response binding exact revision, role, protocol, job set,
   authority epoch/admission and claimant readiness.
12. Make web readiness the conjunction of strict deployment intent and fresh DB evidence for fenced
    protocol, scoped admission and the exact expected worker revision. Stale intent or DB failure is
    controlled unavailability with zero artifacts from either optimizer POST or scheduled enqueue.
13. Stage immutable artifacts without changing `current`, units, enablement or service state. Keep
    hosted apply, credential provisioning, stage, activation, web promotion, scoped admission and QA
    as separate exact authorizations.
14. Preserve v1 read-only behavior. No runtime path may import or call Ads API, SP-API, export/apply
    or Amazon write code.

## Proof requirements

- fresh and populated migration replay preserves exact existing counts, policies and privileges;
- both legacy claim overloads, tokenless finish and stale recovery exclude only recommendation work
  after fencing, while the report claimant remains exactly four types;
- admission/claim transition races have only serialized before-or-after outcomes;
- activation refuses every queued, running, token-bearing or scope-mismatched recommendation job;
- old tokenless executors writing to scoped WP-195 or unscoped pre-WP-195 runs after their reaped
  queue rows drained are rejected after activation;
- unscoped human-requested negative proposals preserve their existing write behavior after fencing;
- incomplete, mixed, or queue-linked human lineage rolls back atomically;
- wrong revision, malformed identity/limit and concurrent claimant cases fail closed;
- deferred admission rejects late legacy, missing, extra, foreign and tampered scope evidence with
  zero partial artifacts;
- SQL and Node batch/run scope fingerprint goldens match for bytewise and non-ASCII cases;
- claim token, worker, tenant, profile, run, group, payload, scope and fingerprint mismatches write
  zero recommendation/audit rows;
- crash injection at claim, start, success and settlement-response-loss boundaries preserves exact
  run/job/proposal counts and same-revision resume settles the original claim;
- runtime tests prove single flight, retry/dead classification, shutdown drain and sanitized health;
- principal catalog proofs deny direct DML, Vault, Ads/SP-API/integration secrets, general/report
  queue and SP-write/outbox authority; static dependency/environment proofs find no provider or
  Amazon write reachability;
- executor-only RLS policy catalogs are exact and every narrow RPC refuses cross-tenant arguments;
- deployment fixtures prove stage-only installation, exact activation refusal, integration/report
  coexistence and compatible-only rollback;
- all report/recommendation web gate combinations plus stale intent, DB outage, blocked authority and
  revision mismatch preserve disjoint claims and create no disabled-POST artifact;
- both optimizer POST routes and the scheduled producer create zero artifacts when readiness is false;
- activation and revision-rebind response loss reconcile exact old/new authority tuples without
  overlap or blind retry;
- full repository typecheck, lint, tests and hygiene pass.

## Acceptance checks

- [ ] Architecture and work-package contract committed separately before implementation.
- [ ] Focused migration, DB, worker, web and deployment tests pass.
- [ ] Disposable PostgreSQL migration, concurrency, admission and stale-claim proofs pass serially.
- [ ] High correctness and Extra-High adversarial reviews find no blocker, high or medium defect.
- [ ] Blast-radius proof confirms no shared edit, provider dependency, Amazon action or external
      state change.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm hygiene` pass.
- [ ] Exact-head pull-request CI and exact-main CI pass both jobs.
- [ ] The source package performs no hosted migration, staging, activation, deployment, provider or
      Amazon action.
- [ ] Hosted apply, runtime credential provisioning, artifact staging, service activation, web
      promotion, scoped admission and QA each receive separate exact action-specific authorization
      and pre/postflight evidence.
- [ ] Live bounded QA proves campaign checkbox selection, one observable preview and exact immutable
      proposal counts before the feature is described as testable.
- [ ] Handover and status update only after reviewed merge and exact-main CI.

## External gates

Merging WP-196 authorizes no external action. Hosted apply requires a ledger-compatible artifact
containing pending WP-187, WP-192, WP-194, WP-195 and WP-196 migrations in exact order. Provisioning
the narrow credential, staging an exact origin/main artifact, activating the service, promoting web,
authorizing scoped admission and running live QA are separate actions. The mixed integration service
remains active; the database authority and mutation triggers, not its environment, exclude old
claims and writers. After fenced activation, rollback is limited to an atomic zero-active-claim
rebind to a `recommendation-fenced-v1` revision, or to blocked/unavailable web with no functional
preview. Amazon mutation remains locked behind the separate parity and write-activation program
gates.
