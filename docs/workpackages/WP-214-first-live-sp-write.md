# WP-214 — UI-driven Amazon API writes and first live Sponsored Products bid change

Owner: implementer. Two pull requests: `wp-214-sp-write-source`, then
`wp-214-sp-write-activation`. This honors the WP-191 decision that the consumer is not
registered in the same slice as its source.

Depends on: WP-207 (migrations `20260901020000` and `030000` hosted); decision D4 in
`docs/workpackages/REPLAN-2026-09-05.md`. Operator answer on 2026-09-05: match AdLabs, where
every change goes through one approval step in the UI; MCP-triggered writes are WP-217.

## Objective

Let an operator edit a bid in OpenSpell, review the exact change, confirm it, and have the
worker send it to Amazon through the Advertising API. This works without MCP. Record the plan,
resynchronize the accepted value, show exact counts and restore the prior bid with an authorized
inverse. The existing contracts, adapter and ledger are inert foundations; this UI write flow
does not work yet. It is the first write priority, starting with keyword bids.

Claude Fable 5.1 owns the preview/status interaction and visual design. The implementer owns
the authenticated backend endpoints, plan/approval logic and worker execution. Those endpoints
serve the OpenSpell UI. The application service must also support programmatic submission by
MCP in WP-217; keep its planning, execution and status logic independent of browser state.
Both entrypoints are required. A separate external integration API is not needed to deliver
the MCP connection. Ordinary UI changes retain one exact-plan approval step.

## Owned files

Source PR:

- `packages/db/src/queries/authenticated-actor.ts` and tests (new; validated actor context,
  transaction-local JWT claims and role on one connection; no session state survives failure);
- `packages/db/src/sp-write-application.ts` and `packages/db/package.json` (explicit application
  subpath for plan/approval helpers; keep the persistence facade's existing export boundary);
- `packages/db/src/queries/sp-write-plan-builder.ts` and test (new);
- `apps/web/app/recommendations/apply/[batchId]/page.tsx` server loader and integration wiring;
  the separate client component is Claude-owned, with props agreed before implementation;
- `apps/web/app/api/sp-writes/**` (new routes: record plan, approve, status);
- `apps/web/src/writes/**` (new server helpers, no `@wizard-ads/ads-api` import);
- `apps/worker/src/sp-write-outbox/**` (new loop module, not registered);
- `_local/sp-write-gate-seed.TEMPLATE.sql` (tracked template with placeholders);
- `docs/deploy/sp-write-activation.md` (new);
- `packages/db/src/sp-write-persistence.test.ts` runtime blast block and
  `packages/db/src/sp-write-persistence-blast.test.ts`: allow the exact new inert application
  modules and runbook in the source PR, while asserting zero worker entrypoint registration;
- HTTP integration tests proving the full lifecycle with a fake provider and no MCP server;
- Shared Time Machine write/reversion contracts, DB projection/query tests and server data
  wiring, after declaring exact files. Claude owns client presentation. Expose plan/execution
  identity, actor, old/requested/observed values and inverse links; preserve existing export
  history and avoid duplicate sync entries. WP-217 extends this same projection for MCP.

Related backend handoff for WP-209, implemented as a separate source commit before its UI:

- A declared shared proposal-revision contract, API route and DB query/migration for decimal
  proposed values, prior value, revision identity, optimistic concurrency and audit. An edit
  invalidates stale export/plan/approval identities; export freezes the selected revision.
- Recommendation completeness metadata for the existing capped loader, with exact loaded/total
  or explicit truncated counts. Declare exact existing files before edits; coordinate with the
  WP-209 loader interface and keep this work independent of live-write activation.

Activation PR:

- `apps/worker/src/main.ts` and `apps/worker/src/config.ts` (register the loop behind
  `OPENSPELL_SP_WRITE_LOOP_READY` and `OPENSPELL_SP_WRITE_PROFILE_ALLOWLIST`);
- The two blast tests above: change only the registration assertions to permit the single
  worker executor and the exact declared flags/import sites. Multiple HTTP/UI helpers are
  legitimate consumers; they are not additional provider executors. Keep creation inactive.
- A declared immutable integration-worker release/install/verify/rollback script set under
  `docs/deploy/sp-write-worker-*`, with matching tests. Preserve integration job ownership;
  inject credentials through the approved runtime mechanism. Do not update the retired mutable
  checkout/plaintext setup from `always-on-worker.md`.
- This brief's close-out evidence for the current STATUS owner to integrate.

The existing SP write contracts remain authoritative. The application/history contracts and
query modules are declared in the [application architecture](../design/WP-214-APPLICATION-ARCHITECTURE.md); they reuse the
existing SP artifacts. The separately declared immutable preview-evidence, proposal-revision and exact observation-link
slices may add their shared shapes and migrations before dependent code. `recommendations/review.tsx` and
all approval-page client design belong to Claude. Other migration changes require a separate
reviewed contract/persistence slice before dependent source.

## Read first

1. `AGENTS.md` "Amazon write contract", all ten rules.
2. `packages/shared/src/sp-writes.ts`: `SpWritePlan`, `ApproveSpWritePlan` at line 936,
   `SpCanonicalDecimal` at line 26.
3. `packages/ads-api/src/sp-write-adapter.ts`: `preparePlan`, `observeCurrent`,
   `executeOneAttempt`.
4. `packages/db/src/queries/sp-write-persistence.ts`: staging and runtime ledgers, claim
   custody, lease, reservation, result, observation, recovery.
5. Migration `20260901020000` (the SP write persistence ledger): gate and grant tables
   at lines 217-272, `app.approve_sp_write_cycle` at 1634, `sp_write_execution_accounting` at
   3651, grants at 4095-4135, and the timing constants near the lease and reservation functions.
6. Migration `20260901030000` (the SP write outbox delivery).
7. `docs/design/WP-187-ARCHITECTURE.md`, `WP-188-ARCHITECTURE.md`, `WP-191-ARCHITECTURE.md`.
8. `apps/web/app/api/recommendations/export/route.ts` (the export creates `apply_batches` and
   `apply_rows`, which are the plan's forward source).
9. `apps/worker/src/ads-api.ts` lines 705-735 (`createAdsApiClientFromEnv`, refresh-token
   resolution per connection).
10. `tools/recon/10-goto-links.md` lines 55-64: the AdLabs pattern this must match, one persisted
    preview, a human approval in a real UI, then one apply.

## Required behavior

### Plan builder (packages/db)

1. Input: one `apply_batch` id. Join its `apply_rows` to the entity mirror for the current bid,
   and to `ad_profiles` and the connection for the provider scope. Read money as text, never as
   a JavaScript number; the mirror's `numeric` columns use `mode: 'number'`
   (`packages/db/src/schema/columns.ts:16-18`) while the contract requires canonical decimal
   strings. Emit an `SpWritePlan` with keyword bid actions only for this package; refuse other
   routes with a controlled error.
2. Hash with `node:crypto` SHA-256 through the facade's hasher contract and record through
   `createSpWriteStagingLedger(...).recordPlan`.
3. Provide `buildInversePlan(executionId)` that reads the recorded observation and result and
   emits the exact inverse against the current synchronized value, refusing on conflict.

### Approval and preview (apps/web)

4. The preview page renders profile, entity identity, current synchronized value, proposed value,
   guardrails, provenance, and the total count from the recorded plan. Stale or changed previews
   require a new plan.
5. The confirmation control names Amazon and the exact count, `Yes, apply N changes to Amazon`.
   The approval request binds the immutable plan fingerprint and exact count. Selection, approval
   and execution admission are distinct acts; typing a magic phrase is not a substitute for
   authorization. Add authenticated HTTP tests independent of browser and MCP entrypoints.
6. Approval runs `select app.approve_sp_write_cycle(...)` through the authenticated-actor helper
   with the signed-in owner or admin's user id, never through the service-role handle alone. The
   RPC lives in schema `app`; do not route it through PostgREST.
7. After approval the route calls the runtime ledger's `startExecution`, which emits the outbox
   wake and returns its **outbox id**. Return the execution id from the approval receipt together
   with the plan id; never expose the outbox id as the execution identity. Forward and inverse
   plans can share an execution cycle, so status and history identify an operation by both ids.
   A status route reports requested, accepted, attempted,
   succeeded, failed, refused and resynchronized counts from `sp_write_execution_accounting`.

### Outbox loop (apps/worker)

8. Single-flight, one profile at a time, allowlisted by environment. Resolve the Amazon
   credentials for the connection before claiming; the ledger's dispatch-start deadline and
   observation validity are seconds to minutes, so a slow token fetch after claiming makes the
   reservation refuse as stale.
9. Per dispatch claim: `acquireDispatchLease(claim)`, adapter `preparePlan` and
   `observeCurrent`, `reserveProviderCall(claim, observation, intent)`; only on `dispatch_once`
   call `executeOneAttempt`, then `appendProviderResult` and `completeClaim`. Never retry a
   successful row as a new write.
10. Per observe claim: re-observe through the adapter, `appendObservation`, `completeClaim`, and
    enqueue a scoped `entity.sync` so the mirror shows the accepted value.
11. Recovery: after both deadlines run the ledger's recovery append so one ambiguous result
    cannot block the single global capacity forever. Sanitize every logged Amazon response.

### Tests

12. Fake-provider end to end in Vitest: zero provider calls on a closed environment gate, a
    missing profile grant, a stale current value, an expired approval, and a duplicate
    reservation; one accepted-then-observed happy path; counts reconcile requested, accepted,
    observed. Playwright: preview render, exact confirmation text, refusal of a wrong count,
    status page.
13. Source-phase blast tests permit the declared inert modules and still reject registration.
    Activation-phase tests allow exactly the declared worker registration and environment gates;
    unexpected consumers, flags and creation activation still fail. Both PRs must pass separately.
14. HTTP tests prove tenant isolation, owner/admin approval, stale-plan refusal, duplicate request
    replay to the same execution, closed runtime gate, status reconciliation and inverse lifecycle.
    The tests do not initialize or import an MCP server.

### Activation and live proof (scoped authorization)

Deployment has two separate schema windows. Claude owns WP-207's original five migrations
`20260901020000` through `20260901060000`; this package does not modify that scope or execute
that window. After this source PR is reviewed and merged, rehearse and obtain scoped
authorization for a second window containing these additional WP-214 migrations in order:

| Migration | Dependency introduced |
|---|---|
| `20260905000000_sp_write_preview_evidence.sql` | Immutable reconstructable source and policy evidence |
| `20260905010000_sp_write_preview_approval.sql` | Frozen-source checks around the existing approval function; tighter function permissions |
| `20260905020000_sp_write_application_entry.sql` | Version-specific authenticated application approval entrypoint |
| `20260905030000_sp_write_mirror_observations.sql` | Exact observation/diff links, keyword bid freshness and guarded mirror updates |

Each begins with `set local lock_timeout = '5s'` and the shared transaction-scoped advisory
DDL lock. Keep changes in new migration files and preserve existing evidence. Rehearsal
must cover the stricter approval behavior and mirror triggers as well as creation of new
objects. The versioned application entry must exist before exposing approval. Every ordinary
entity-sync owner must receive the keyword-mirror capability before enabling native writes.
Do not mix this second window into WP-207 or use source tests as hosted-application evidence.

15. Seed one environment gate version plus head and one profile grant version plus head for the
    single profile with the template SQL, run by the authorized executor using the migration-
    owner role. Values stay in `_local/`.
16. Deploy the worker revision with the loop enabled for that profile only.
17. Accept one keyword recommendation, export it, build and record the plan, preview, confirm
    with the exact text, watch reserve, execute and observe, verify accounting shows 1 requested,
    1 accepted, 1 observed, and see the new bid in the Grid after resync. Execute the exact
    preapproved inverse under its bounded receipt when present; otherwise build the inverse
    against current state and obtain fresh approval. Verify the original bid is restored.

## Authorization

Source work and synthetic tests need no additional authorization. Prepare a single reviewable
live-test scope naming the private profile, exact forward preview, optional preapproved inverse,
maxima, expiry, gate seed, immutable worker deployment and stop conditions. AGENTS.md permits
that bounded inverse to run without waiting for a second response. Ordinary UI writes retain
per-plan approval; unattended tests execute only the exact authorized cycle.
The current `_local/amazon-write-authorization.json` is read by no implementation. Do not treat
its presence as executable authority. If used for this package, implement and test a validated
loader that binds it to the existing bounded-authorization contract before live use.

## Acceptance

1. Both PRs pass exact-head and exact-main CI; `pnpm check` and `pnpm hygiene` pass.
2. Every test in steps 12 through 14 exists and is green.
3. Live proof in step 17 is recorded in this brief for the STATUS owner to integrate, with
   sanitized counts and evidence that the inverse restored the original value.
4. `apps/web` still never imports `@wizard-ads/ads-api` (lint rule).
5. The operator completes the OpenSpell UI preview/approve/status flow without MCP; one
   worker-only Amazon write is accepted, observed and restored under the authorized cycle.
   Backend HTTP tests prove that this UI flow does not depend on an MCP process.
