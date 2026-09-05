# WP-214 — First live Sponsored Products bid write

Owner: implementer. Two pull requests: `wp-214-sp-write-source`, then
`wp-214-sp-write-activation`. This honors the WP-191 decision that the consumer is not
registered in the same slice as its source.

Depends on: WP-207 (migrations `20260901020000` and `030000` hosted); decision D4 in
`docs/workpackages/REPLAN-2026-09-05.md`. Operator answer on 2026-09-05: match AdLabs, where
every change goes through one approval step in the UI; MCP-triggered writes are WP-217.

## Objective

Apply one operator-approved keyword bid change to Amazon through the guarded worker path,
resynchronize, show exact counts, and revert it through a second approved plan. This turns the
five inert layers (finding F5) into a product feature and is the template for every later write.

## Owned files

Source PR:

- `packages/db/src/queries/authenticated-actor.ts` (new; lift the pattern from
  `packages/db/src/testing/rls.ts:32-49` into production: reserved connection,
  `set_config('request.jwt.claims')`, `set role authenticated`, reset);
- `packages/db/src/queries/sp-write-plan-builder.ts` and test (new);
- `apps/web/app/recommendations/apply/[batchId]/page.tsx` and its client component (new);
- `apps/web/app/api/sp-writes/**` (new routes: record plan, approve, status);
- `apps/web/src/writes/**` (new server helpers, no `@wizard-ads/ads-api` import);
- `apps/worker/src/sp-write-outbox/**` (new loop module, not registered);
- `_local/sp-write-gate-seed.TEMPLATE.sql` (tracked template with placeholders);
- `docs/deploy/sp-write-activation.md` (new).

Activation PR:

- `apps/worker/src/main.ts` and `apps/worker/src/config.ts` (register the loop behind
  `OPENSPELL_SP_WRITE_LOOP_READY` and `OPENSPELL_SP_WRITE_PROFILE_ALLOWLIST`);
- `packages/db/src/sp-write-persistence.test.ts` "runtime blast radius" block and
  `packages/db/src/sp-write-persistence-blast.test.ts` (rewrite to assert exactly the one
  deliberate consumer, the one env flag and the one deploy document; keep the campaign-creation
  checks intact);
- `docs/STATUS.md` one row.

Not owned: `packages/shared` (contract is complete; stop and report if a change seems needed),
`apps/web/app/recommendations/review.tsx` (WP-209), any migration file.

## Read first

1. `AGENTS.md` "Amazon write contract", all eight rules.
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
5. The confirm control requires the literal text `Yes, apply N changes to Amazon` with the exact
   count. Selection, confirmation and execution are separate requests.
6. Approval runs `select app.approve_sp_write_cycle(...)` through the authenticated-actor helper
   with the signed-in owner or admin's user id, never through the service-role handle alone. The
   RPC lives in schema `app`; do not route it through PostgREST.
7. After approval the route calls the runtime ledger's `startExecution`, which emits the outbox
   wake, and returns the execution id. A status route reports requested, accepted, attempted,
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
13. The rewritten blast-radius tests still fail if a second consumer, a second env flag or a
    campaign-creation consumer appears.

### Activation and live proof (operator-attended)

14. Seed one environment gate version plus head and one profile grant version plus head for the
    single profile with the template SQL, run by the operator as the migration owner. Values stay
    in `_local/`.
15. Deploy the worker revision with the loop enabled for that profile only.
16. Accept one keyword recommendation, export it, build and record the plan, preview, confirm
    with the exact text, watch reserve, execute and observe, verify accounting shows 1 requested,
    1 accepted, 1 observed, and see the new bid in the Grid after resync. Then build the inverse
    plan, approve it separately, and verify the original bid is restored.

## Authorization

Source work needs none. The gate seed, the worker deployment and each live approval are separate
operator actions stated in the current task. The gitignored
`_local/amazon-write-authorization.json` is not authority; it is read by no code.

## Acceptance

1. Both PRs pass exact-head and exact-main CI; `pnpm check` and `pnpm hygiene` pass.
2. Every test in step 12 and 13 exists and is green.
3. Live proof in step 16 is recorded in `docs/STATUS.md` with the sanitized counts, and the
   inverse restored the original value.
4. `apps/web` still never imports `@wizard-ads/ads-api` (lint rule).
