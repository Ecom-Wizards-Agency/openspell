# WP-119 — Query Intelligence join performance

## Outcome

Index candidate ASINs once per normalized query, marketplace, profile and week. The previous join
rebuilt, deduplicated and sorted the growing ASIN array for every SQP fact, producing superlinear
work on large shared-query sets.

## Scope

- `packages/core/src/query-intelligence/join.ts`
- `packages/core/src/query-intelligence/join.test.ts`
- this brief

This package does not change contracts, attribution rules, persistence, production data, or Amazon
calls.

## Acceptance

- Every PPC input still produces exactly one output.
- Spend conservation and exact/profile-only/ambiguous/unmatched attribution remain unchanged.
- Candidate ASINs remain unique, uppercase and lexically sorted.
- A synthetic 5,000-fact shared-query join completes in under 100 ms on the reference development
  machine.
- Typecheck, lint, tests and hygiene pass.
