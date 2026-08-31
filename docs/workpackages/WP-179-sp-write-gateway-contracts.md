# WP-179, guarded Sponsored Products write contracts

## Outcome

OpenSpell has one strict, provider-semantic contract for operator-approved reversible Sponsored
Products updates. It covers immutable plans, exact approval and bounded live-test authorization,
write-ahead intents, provider results, synchronized observations, exact inverses, closed accounting,
and inactive future jobs. This package performs no I/O and activates no write path.

Architecture rationale: `docs/design/WP-179-ARCHITECTURE.md`.

## Scope

This package may edit only:

- `packages/shared/src/sp-writes.ts`;
- `packages/shared/src/sp-writes.test.ts`;
- the shared package export in `packages/shared/src/index.ts`;
- this brief and `docs/design/WP-179-ARCHITECTURE.md`;
- rolling handover/status prose after verification.

It must not edit `ApplyRow`, `EntityRow`, current job unions, the Ads client, DB package, worker,
web, migrations, deployment configuration, or operator authorization values.

## Supported semantic actions

- campaign budget and enabled/paused state;
- one grouped complete campaign-placement bidding update;
- ad-group default bid and enabled/paused state;
- keyword bid and enabled/paused state;
- target bid and enabled/paused state;
- product-ad enabled/paused state.

Creation uses WP-125. Archive/delete, negative-resource deletion, targeting-expression replacement,
and other irreversible or immutable provider operations are excluded.

## Required invariants

1. Executable money is an exact canonical decimal plus ISO currency. JavaScript numbers and a
   universal two-minor-unit assumption are refused.
2. Every plan binds org/profile, Amazon profile, connection, region, marketplace, currency, and SP
   dialect plus guardrail/provenance evidence.
3. One action is one provider response position. Compatible logical changes for the same
   route/entity are grouped, while exact logical and provider counts remain separate.
4. A placement action carries complete normalized bidding state. Only explicitly approved
   placements may differ; strategy, shopper cohorts, off-Amazon settings, and siblings are
   preserved.
5. Plans and actions use deterministic canonical order and SHA-256 preimages. Shared receives a
   hasher and performs no platform crypto I/O.
6. An inverse is a separately frozen plan that exactly swaps one observed source execution. Manual
   rollback needs fresh approval. Only a bounded live test may bind one exact inverse in advance.
7. Approval request JSON cannot supply actor, approval time, execution generation, gate evidence,
   or lease. The DB-issued receipt binds those facts and exact counts.
8. The gitignored bounded authorization shape names exact scopes, entities, change keys, maxima,
   expiry, one active mutation, one test cycle, and mandatory observation-before-inverse.
9. A write-ahead intent binds a fresh direct provider observation, one route, exact zero-based
   positions, request fingerprints, execution generation, and lease identity before provider I/O.
10. An intent without a result is ambiguous. No action is automatically sent again after intent
    under version 1.
11. Results account for every intended position. Provider acceptance remains distinct from fresh
    synchronized observation.
12. Accounting and execution status derive from exact evidence. No caller may select success.
13. Future `sp_write.dispatch` and `sp_write.observe` schemas remain absent from current `JobPayload`.
14. Pure artifact verification is not live authority. The later persistence slice must use one
    DB-clock transaction to recheck and lock current gates, profile grant, receipt, route,
    generation, and lease while committing the unique intent and observation outbox. Only the
    committed winner may call Amazon.

## Acceptance checks

- Strict round trips cover every action, plan, authorization, receipt, intent, result, observation,
  evidence bundle, and future job.
- Numeric, exponent, noncanonical, negative, and excessive-precision money fails.
- Fingerprints change for every approval-bound field and reject tampering.
- Noncanonical action order, duplicate route/entity actions, duplicate provenance, empty changes,
  and exact-count drift fail.
- Multi-placement selection produces one provider row and the exact logical-change count.
- Any unapproved bidding strategy, shopper-cohort, off-Amazon, or sibling-placement change fails.
- Forward and inverse plans must be exact swaps with one-to-one source action mapping.
- Manual approval cannot preauthorize an inverse. Bounded approval requires one exact inverse and a
  matching, unexpired authorization fingerprint within all action and count bounds.
- Mixed plan, route, receipt, job, generation, authorization, observation, intent, or request
  fingerprints fail compound verification.
- Intent positions cover `0..n-1` exactly, contain one route, and never reuse a planned action.
- Open, accepted, rejected, or ambiguous intent evidence blocks redispatch of that action.
- Indexed and ambiguous provider evidence closes every request position without raw bodies or
  headers.
- Accepted provider evidence cannot produce `succeeded` before requested state observation.
- Ambiguous requested-state observation remains distinguishable from provider-accepted success.
- Tampered accounting and caller-selected status fail.
- Real `JobPayload` rejects both future SP write job types.
- Focused shared tests, full `pnpm check`, `git diff --check`, staged hygiene, and hosted exact-head
  CI pass.
- A static repository check proves no current worker registers or dispatches either future job.
- Tests use synthetic values and make no network, database, deployment, or Amazon mutation call.

## Later serialized packages

1. A pure Ads adapter adds complete placement reads, exact decimal-to-wire checks, one-request
   execution, sanitized indexed outcomes, and fake-provider tests. It remains unreachable from the
   current worker.
2. After attended hosted-ledger reconciliation and exact migration authorization, a dedicated
   write ledger adds gates, grants, plans, approvals, executions, leases, intents, results,
   observations, outbox, RLS, and the atomic reservation function. It does not replace the global
   queue protocol.
3. Typed DB queries implement that ledger and prove tenant, route, generation, lease, and concurrent
   unique-intent fencing.
4. A worker executor and recovery loop compile against the still-inactive job shapes and prove zero
   provider calls on every refused path.
5. Web preview, exact-count confirmation, status, and Time Machine inverse review land behind a
   default-off gate.
6. Job enum/union registration, deployment, profile grants, bounded authorization, and any live
   Amazon test remain separate activation gates.
