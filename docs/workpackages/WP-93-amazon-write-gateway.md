# WP-93 — Guarded Amazon write gateway

## Outcome

OpenSpell can create supported SP, SB, SB Video, and SD campaigns and apply approved bid,
budget, placement, targeting, and state changes through the Amazon Advertising API. The web
application remains credential-free; the worker is the only executor.

## Operator workflow

1. Build or review a change set.
2. Preview the exact Amazon profile, entity identities, old/new values, guardrails, and count.
3. Select the intended rows.
4. Confirm with a control that names Amazon and the exact count.
5. Queue one immutable, idempotent apply batch.
6. Show per-row requested, accepted, failed, resynchronized, and conflicting states.
7. Offer a separately reviewed Time Machine API restore where an exact inverse is legal.

Campaign creation explicitly warns that created resources cannot be deleted by rollback.
Pausing or archiving them is a new reviewed action.

## Ownership and sequence

1. `packages/shared`: additive batch, approval, idempotency, provider-response, and campaign
   creation contracts.
2. `packages/ads-api`: pure SP/SB/SB Video/SD mutation clients and typed partial-failure results.
3. `packages/db` plus `supabase/`: write enablement, immutable approvals, row attempts,
   provider results, and observation state.
4. `apps/worker`: authorization, conflict check, throttling, idempotent execution, audit, and
   resynchronization.
5. `apps/web`: product-specific campaign preview, exact-count confirmation, apply progress,
   failures, and Time Machine reversion review.

Serialize these owners. MCP may draft or trigger a separately approved batch but cannot approve
and execute its own change. Automatic execution requires a deliberately enabled cadence with
action-specific caps, next-run visibility, pause, and kill-switch controls.

## Acceptance checks

- Missing environment gate, profile allowlist, permission, current-value match, or approval
  refuses the write before any provider mutation call.
- Replaying a batch cannot create or mutate an entity twice.
- Every list-driven stage asserts offered and resulting counts.
- Partial Amazon success remains partial and retryable only for unresolved rows.
- A post-write sync observes the expected state or records a conflict; “API accepted” is not
  presented as “verified in Amazon.”
- Creation, bid, budget, placement, targeting, state, and reversion paths have synthetic tests.
- No unattended write occurs without an active cadence; disabling a cadence prevents future
  batches before any provider mutation call.
- MCP cannot mutate without a valid, unexpired approval created separately from the trigger call.
- Playwright proves selection, preview, exact confirmation text, progress, failure, conflict,
  and reversion behavior.
- Hygiene, typecheck, lint, unit tests, migration/RLS tests, Playwright, and build pass.
- No production migration or live Amazon write runs without exact task authorization.
