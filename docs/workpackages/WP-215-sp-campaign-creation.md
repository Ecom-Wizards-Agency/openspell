# WP-215 — Sponsored Products campaign creation via API

Owner: implementer. Starts only after WP-214 has proven one live write and its inverse.

Depends on: decision D7 in `docs/workpackages/REPLAN-2026-09-05.md` (Sponsored Products
only; Sponsored Brands and Sponsored Display deferred until the Asset Library client and SD
observation reads exist).

## Objective

Let the operator take a plan from the Campaign Builder, preview it as an immutable dependency
graph, confirm `Yes, create N campaigns in Amazon`, and have the worker create the campaign,
ad groups, product ads, keywords, targets and negatives in order through the Advertising API
with write-ahead evidence, exact counts and resynchronization. Creation has no delete rollback;
the preview says so and a pause proposal is a separate reviewed action.

## Owned files

- `packages/ads-api/src/sp-creation-adapter.ts` and test (new; maps plan nodes onto the
  existing `createSpCampaigns`, `createSpAdGroups`, `createSpProductAds`, `createSpKeywords`,
  `createSpTargets`, `createSpNegativeKeywords`, `createSpNegativeTargets` clients at
  `packages/ads-api/src/client.ts:551-702`);
- `supabase/migrations/<timestamp>_campaign_creation_ledger.sql` (new, additive, five-second
  lock timeout and the advisory DDL lock like every migration since WP-185);
- `packages/db/src/queries/campaign-creation-persistence.ts` and tests (new);
- `apps/worker/src/campaign-creation/**` (new executor, registered behind
  `OPENSPELL_CAMPAIGN_CREATION_READY` and a profile allowlist);
- `apps/web/app/campaigns/create/**` and `apps/web/app/api/campaign-creation/**` (new);
- `docs/deploy/campaign-creation-activation.md` (new);
- `docs/STATUS.md` one row.

Not owned: `packages/shared/src/campaign-creation.ts` (the contract from WP-125 is complete;
stop and report on any needed change), `packages/campaigns` (pure planner stays export-capable).

## Read first

1. `AGENTS.md` "Amazon write contract", especially rules 3, 4 and 8 on creation.
2. `docs/workpackages/WP-124-campaign-creation-architecture.md` and
   `WP-125-campaign-creation-contracts.md`; `docs/design/WP-125-ARCHITECTURE.md`.
3. `packages/shared/src/campaign-creation.ts`: plans, approvals, write-ahead evidence,
   accounting, observation-gated dependencies.
4. `packages/campaigns/src/**`: the planner whose output becomes the frozen plan.
5. WP-214's ledger, loop and approval transport; reuse the same patterns and the same
   authenticated-actor helper.

## Required behavior

1. Freeze: a route takes a Campaign Builder plan, validates it with the shared contract, and
   records an immutable plan with a fingerprint and the tenant and profile scope.
2. Preview: shows every node to be created with its parent, the count per entity type, the
   guardrails, and the statement that Amazon resources cannot be deleted by a rollback.
3. Approval: the literal `Yes, create N campaigns in Amazon` with the exact campaign count;
   approval runs as the signed-in owner or admin through the authenticated-actor helper.
4. Execution: worker-only, one plan at a time per profile; for each node write the intent before
   the call, call once, record the sanitized response, record the Amazon id, and only then
   release the dependants. Partial success is recorded as partial, never as complete.
5. Counts: requested, attempted, created, failed and refused per entity type reconcile against
   the plan; an HTTP success without an entity-level id is not creation evidence.
6. Resync: enqueue a scoped `entity.sync` after the last node and show observed versus created.
7. Campaigns are created paused unless the plan says otherwise, matching `packages/campaigns`.
8. Tests: fake provider proving ordering, write-ahead evidence, partial failure handling, refusal
   on a closed gate, and count reconciliation; Playwright for freeze, preview and confirmation.

## Authorization

The migration is hosted through the attended procedure of WP-207's runbook with its own exact
authorization. The worker deployment and each live approval are separate operator actions.

## Acceptance

1. One plan with one campaign, one ad group, one product ad and two keywords is created on the
   allowlisted profile with counts reconciled and the entities visible after resync.
2. A deliberately failing node leaves a recorded partial state with dependants unreleased.
3. `pnpm check`, `pnpm hygiene` and both CI jobs pass.
