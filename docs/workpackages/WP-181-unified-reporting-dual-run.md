# WP-181 — inert Unified Reporting dual run

## Status

Merged at `d75ec26` after exact-head and exact-main CI passed. High correctness and Extra-High
adversarial safety reviews found no remaining defects. This package remains source-only and
default-off in merged source: PR #91 performed no hosted migration, tenant binding, deployment,
feature activation, or provider probe. Hosted migration and binding state remain unverified.

## Outcome

Add a worker-owned Unified Reporting sidecar for a bounded, metadata-only comparison with existing
Reporting v3 `spCampaigns` requests. Reporting v3 remains the only promotion authority. Every
admitted Unified create and retrieve operation has its own durable state and exact accounting, and
a Unified refusal or ambiguous create cannot change the v3 ledger or facts.

The selected design is frozen in [WP-181-ARCHITECTURE.md](../design/WP-181-ARCHITECTURE.md).

## Scope

Implement:

- one shared `report.unified.advance` queue payload plus durable state/accounting contracts;
- a separate worker Unified capability over WP-173's create/retrieve methods;
- one fixed `campaign-observation-v1` definition derived from Amazon's pinned create example;
- a default-off gate requiring the exclusive Evo report lane, an exact expanded claim set, a
  bounded deployment allowlist, and an enabled explicit advertiser binding;
- tenant-scoped binding, run, and append-only operation tables with RLS and count constraints;
- atomic admission and successor-enqueue transactions;
- an at-most-one create dispatch fence and conservative ambiguity recovery;
- bounded idempotent retrieval while the proven status is exactly `PENDING`;
- opaque non-PENDING observation and contract blocking for unproven completed parts;
- synthetic unit, integration, migration, RLS, deployment-policy, crash, and count tests.

Do not implement:

- a hosted migration or tenant binding;
- a deployment or feature activation;
- a real Amazon capability probe;
- an inferred mapping from profile or v2 account identifiers to Unified advertiser accounts;
- arbitrary operator-defined query JSON;
- provider batching;
- completed-part decoding or download;
- report parsing, fact loading, coverage, history bootstrap, parity verdicts, or promotion;
- hourly periods;
- web or MCP controls;
- any advertising-entity write.

## Ownership

- `packages/shared`: queue and durable domain contracts.
- `packages/db`: schema mirrors and migration tests.
- `packages/ads-api`: the existing Unified transport remains provider-native and pure.
- `apps/worker`: account/connection routing, feature policy, coordinator, persistence, and queue
  dispatch.
- `supabase`: one additive migration and RLS/test-fixture coverage.
- `apps/web` and `apps/mcp`: no runtime capability change.

`report_requests`, Reporting v3 fetch/parsers, fact tables, and promotion queries must remain
semantically unchanged.

## Required invariants

1. A v3 request id has at most one Unified run and one create operation.
2. No code path sends Unified create twice for one run. A crash after the dispatch fence becomes
   ambiguity, including a possible false ambiguity before network I/O.
3. Every settled operation accounts exactly one input into exactly one closed disposition.
4. Created/PENDING settlement and successor creation are atomic.
5. Retrieve may repeat after interruption because it is idempotent; create may not.
6. Only `PENDING` schedules another observation. Other statuses remain opaque.
7. Unified state never updates v3 status, facts, coverage, watermarks, or promotion.
8. Disabled source performs no Unified database read, write, queue insert, or provider call.
9. The account binding is explicit and synthetic tests never contain real roster values.
10. No raw provider response or message is persisted or logged.
11. Deleting a v3 ledger row cascades its sidecar evidence instead of being blocked by it; the
    independent queue ledger remains intact and any later orphan claim performs zero provider calls.

## Acceptance checks

- Shared schemas reject scope drift, malformed ids, impossible states, and count mismatches.
- One-item adapter tests prove one input and one indexed outcome for create and retrieve.
- Fake-provider crash tests cover before and after each create fence and report at most one create
  call.
- Worker tests prove v3 still schedules and succeeds under every Unified outcome.
- Database tests prove atomic admission, single-winner dispatch, atomic successors, RLS, and
  tenant/profile foreign keys and scope triggers without new indexes on the populated v3 or queue
  ledgers.
- Deployment-policy tests prove the absent/zero gate preserves the current four-type Evo contract,
  the enabled gate requires the exact five-type contract, and Vercel remains disjoint.
- No test invokes a live provider or hosted database.
- `pnpm check` and the full migration-backed suite pass.

## Rollout gate after merge

Merging this package does not authorize activation. Before the gate can be enabled, reconcile and
apply the hosted migration under the repository blast-radius procedure, deploy the compatible
worker, prove all queue consumers use exact filtered ownership, verify the five-type Evo health
contract, configure explicit bindings and a bounded allowlist, and obtain authorization for the
exact read-only provider probe. If any worker can claim all job types or its revision is unknown,
activation remains blocked.

Rollback disables bindings while the five-type worker is still running, drains or quarantines its
paused sidecars, then changes the feature gate to `0` and restores the four-type claim set in one
deployment update. The disabled source intentionally has no five-type drain mode.
