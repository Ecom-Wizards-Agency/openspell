# WP-71 — Query Intelligence UI

## Scope

Add a read-only `/query-intelligence` operator surface over the existing weekly
SQP, query-vocabulary, contextual-negative, and PPC attribution foundations.
This package owns only:

- `apps/web/app/query-intelligence/**`
- `apps/web/src/query-intelligence/**`
- this brief

It does not change shared contracts, database schema, worker orchestration,
navigation, global theme files, or Amazon APIs.

## Operator contract

- Present all six categories: Own Brand, Competitor, Core, Generic Head,
  Excluded, and Needs Review.
- Keep Generic Head in raw demand and detailed rows while excluding it from
  addressable core demand.
- Lead with purchase share and click share. Show impression share as a
  secondary metric and never call it share of voice.
- Compare intent like-for-like. Do not visually compare branded capture with
  generic discovery as though their shopper origination were equivalent.
- Keep one detailed query/ASIN row for every authoritative SQP fact.
- Join PPC only when ASIN evidence supports it. Profile-only and ambiguous
  spend remains explicit and is never multiplied across candidate ASINs.
- Show marketplace vocabulary approval state. Unapproved suggestions remain
  Needs Review.
- Show contextual negatives as ad-group review/export proposals only. Own Brand
  remains valid in Shield; competitors remain valid in conquest; Core and Head
  are not negated merely because of their analytical category.
- Show Sunday–Saturday coverage, SP-API Brand Analytics source provenance, and
  input/parsed/refused/canonical count reconciliation where promotion evidence
  exists.
- Never call an Amazon write API.

## Implementation

- `data.ts` performs narrow, tenant/profile-scoped reads through the existing
  one-connection request database. Shared Zod contracts parse all domain rows.
- `model.ts` reuses the pure query classification labels, category rollup, SQP
  to PPC join, and spend-conservation assertion from `@wizard-ads/core`.
- The page is server-rendered. Marketplace/week, intent, and query filters are
  plain GET controls, so the read-only surface does not add client state or a
  mutation seam.
- Route-owned CSS uses the existing Wizard Ads design tokens in both themes.

## Count assertions

- Parsed SQP rows equal source rows returned from the query.
- Visible detailed SQP rows equal parsed SQP rows before presentation limits.
- Parsed vocabulary and proposal rows equal their source result counts.
- Every PPC input produces exactly one attribution output.
- PPC spend is conserved through the join.
- Promotion runs are reconciled only when source equals parsed plus refused and
  deduplicated equals promoted equals canonical.

## Verification

- `pnpm --filter @wizard-ads/web typecheck`
- `pnpm --filter @wizard-ads/web test`
- `pnpm lint`
- `pnpm hygiene`
- `pnpm --filter @wizard-ads/web build`

Synthetic tests cover taxonomy labels, Generic Head treatment, demand
deduplication across ASINs, explicit PPC attribution states, spend
conservation, approval status, promotion reconciliation, UI metric order, and
the no-Amazon-write copy.

## Backend gates

- The worker still needs an authenticated SP-API connection, a scheduled
  last-complete-week request, and durable checkpoints before a profile will
  receive authoritative live SQP facts.
- This bounded read-only package shows vocabulary decisions and negative
  proposal statuses. Interactive approve/dismiss/export workflows need
  separately authorized route and database operations; this surface does not
  fabricate controls that cannot complete safely.
- Navigation is outside this package's file ownership and must be wired by the
  integration package.
