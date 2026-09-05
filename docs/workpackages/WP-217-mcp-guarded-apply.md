# WP-217 — MCP-triggered guarded apply under bounded delegation

Owner: implementer. Source design can follow WP-214's application contract; activation requires its
proven direct Amazon write and inverse. Claude Fable 5.1 owns any key-management UI design.

The operator authorized the direction on 2026-09-05 and requested autonomous implementation.
The implementer writes the policy amendment; the operator does not need to supply its prose or
attend implementation. Concrete live key/profile/action bounds are still operator-issued.
D1/WP-207 and D2/WP-216 remain with Claude.

## Current source checkpoint, 2026-09-06

See [the architecture and file scope](../design/WP-217-DELEGATED-WRITES.md) and
[the implementation audit](REPLAN-2026-09-05-AUDIT.md). The source now implements operator-only
bounded key issuance/revocation, direct keyword and legacy/inverse previews, atomic delegated
admission and the authenticated MCP preview/apply/status tools. Human confirmation remains
separate. Time Machine preserves key/issuer attribution and reciprocal original/inverse links.
Local HTTP and worker tests prove counted two-row cycles, restored bids, lost-response recovery,
revocation and closed-authority refusal. Final local checks pass 593 DB, 66 MCP, 32 worker and 18 selected web tests, plus 22 workspace
typechecks. Source PR/CI review and operational activation remain pending.

Shared contracts landed before consumers: delegated policy/receipts at `707cf6e`, ordered v2
plans at `69af518` with timestamp correction `a7ec15c`, client request identity at `22b4132`,
and claim-bound settlement at `8f31fce`. V1 compatibility remains covered. The controlled
proposal producer is committed at `605548e`; the admission/transport slice follows it.

`POST /api/mcp-keys/write` and `issueMcpWriteKey`/`listMcpWriteKeys` in
`apps/web/src/data/mcp-keys.ts` expose operator issuance and Claude's server action/loader.
Read-key revocation requires `20260906010000`; filtered history/export queries require
`20260906020000`, even with MCP writes disabled. Client components remain Claude-owned.

**Declared transport boundary:** `apps/mcp/src/writes.ts` registers exactly three tools only
when the startup flag `OPENSPELL_MCP_WRITES_ENABLED=1` and verified write identity are present.
The flag defaults off and malformed values refuse startup. HTTP tests verify write/read/default-off
catalogs and calls. The exact source scans permit that conditional registration, its two new
HTTP/worker fixtures and the existing operator key loader; they still forbid provider worker
entrypoint/config/deployment activation. The analyst integration fixture explicitly supplies
`writeToolsEnabled: false`; this is configuration compatibility, with no analyst behavior change.

Exact migration inventory for this package, in commit order:

| Migration | Purpose |
|---|---|
| `20260906000000_mcp_write_delegation_mode.sql` | Commit the delegated enum label before consumers |
| `20260906010000_mcp_write_delegations.sql` | Immutable operator-issued key authority and audited revocation |
| `20260906020000_mcp_bid_proposal_sources.sql` | Controlled keyword source, immutable mapping/evidence and legacy exclusions |
| `20260906030000_mcp_write_admissions.sql` | Atomic authorization, UTC charges, audit/enqueue and counted worker refusal |
| `20260906040000_mcp_write_preview_sources.sql` | Atomic legacy/inverse preview mapping under key scope |

All five use the five-second lock timeout and advisory DDL lock. They follow WP-214's five
source files in a later reviewed/rehearsed window, outside WP-207. Source tests do not authorize
that window. The MCP database switch stops new delegated intents without a deployment;
a paused or stopped dispatcher records queued refusals when it resumes. Existing intended
calls retain result and observation recovery. The real HTTP and worker/history suites now exercise this behavior with a disposable database
and synthetic providers. They do not establish hosted deployment or live Amazon behavior.

## Objective

Allow an operator-issued write key to apply bounded keyword bid changes through the same
application service, durable ledger and worker as WP-214. A working authenticated MCP
connection that can submit changes is required, not an optional future integration. UI writes
are proven first; MCP then invokes the same backend programmatically. A key delegates authority within recorded limits; no per-plan UI
confirmation is required within that delegation. Read-only keys stay read-only. MCP never calls
Amazon or grants itself more authority. Implement the programmatic interface needed by MCP.
The existing Streamable HTTP MCP server is the client connection; it may invoke the shared
application service directly. A separate REST service is not required for that connection.

## Historical starting point (before this implementation)

- The SQL key-scope enum already contains `write`; `apps/mcp/src/keys.ts` issues/verifies read
  keys only. The missing work is issuance, verified scope propagation, bounds and revocation.
- `mcp.api_keys.created_by` is nullable and the verified key record does not carry its owner.
  A write key needs an immutable key/user/org binding and current owner/admin membership.
- SP approval currently supports `manual` and `bounded_live_test`, with a user UUID in
  `approvedBy`. A delegated key is a distinct authorization source, not a forged manual click.
- WP-214's builder accepts an existing `apply_batch`; direct bid proposals need real staging
  rows and provenance before using that builder.
- `apps/mcp/src/server.ts` currently runs a handler before audit insertion and can then report
  "nothing was changed" on audit failure. This wrapper cannot admit writes safely.

## Owned files and delivery order

1. Policy/contracts PR: the coordinated `AGENTS.md` sections below; additive delegated-approval
   shapes in `packages/shared/src/sp-writes.ts` and their tests; exact MCP request schemas.
   Preserve existing manual/bounded-test behavior and serialize shared-file edits.
2. Persistence/application PR: a new additive migration for immutable key ownership, delegation
   versions, caps, daily reservations and durable admission/audit identity; DB schema/query
   modules and explicit exports. Name files in the implementation scope before editing.
   Include the SP approval/persistence facade and worker outbox checks needed to recognize a
   delegated receipt. Do not edit an already-applied migration.
3. Transport PR: `apps/mcp/src/**`, `apps/web/app/api/mcp-keys/**` for operator-issued keys,
   and the shared server/application write helpers. MCP reuses the same plan/execution service
   and status contract as WP-214; its delegated admission has separate authorization. Existing
   UI writes retain human approval. Key-management UI client design is Claude-owned.
4. Activation PR: provider worker/config registration and declaration-based blast tests; a scoped deploy
   runbook; relevant README/key guidance and this brief's close-out evidence. The current
   HANDOVER/STATUS owner integrates program updates. Skill docs change only where a tool is
   actually added; read-only analytical skills do not gain implicit mutation permission.

## Coordinated AGENTS.md amendment

Land the policy change with the authorization contracts before dependent consumers. Preserve
worker-only execution, exact-plan evidence and all existing default-off behavior. Amend every
relevant rule together, rather than just the MCP table row:

- In "What this is", rule 2: each write must bind either a human-approved immutable batch or
  an active, separately operator-issued delegation for the exact profile and action class.
  UI writes retain the exact-count confirmation. Delegated MCP writes bind the immutable
  preview, key and owning user to a versioned authorization receipt before execution.
- The `apps/mcp` table row: authenticated read/preview and bounded delegated admission only;
  no direct Amazon calls and no issuance or enlargement of its own delegation.
- Amazon write rule 1: the web server and MCP validate and enqueue through the application service;
  the worker alone calls Amazon. MCP callers with a valid operator-issued write key
  may admit a previously recorded plan within that delegation without a separate UI approval.
- Rule 4: exact human confirmation remains the UI path. The delegated path checks the stored
  plan fingerprint against key ownership, profile/action scope, expiry, current membership,
  per-call limits and atomic daily capacity, and records the receipt before enqueueing.
- Rule 8: a delegated inverse is another separately recorded plan checked against current
state and the same active delegation, caps and audit; it is not an unlimited rollback bypass.
- Rule 9: an enabled delegation authorizes individual MCP calls within its bounds, including
  calls made by an agent. It does not create an OpenSpell cadence. Cadences retain explicit
  enablement and their own bounds/kill switch; MCP cannot issue keys, enlarge a delegation,
  enable a cadence or override a kill switch.
- Rule 10: live delegated tests name the exact key/profile/action limits and inverse behavior
  in the scoped test authorization; existing manual/bounded live-test paths remain supported.

The policy change does not enable a key, deploy code or authorize a live provider call.

## Required behavior

1. Issuance is an authenticated owner/admin operation outside MCP tools. Bind a non-null owning
   user, organization, allowed profiles, keyword-bid action class, expiry, per-call row cap,
   absolute and relative delta caps and daily row budget. Store a versioned delegation; never
   grandfather existing keys into write permission. Keep raw keys out of logs and fixtures.
2. Define the request once: an existing apply-batch ID or explicit keyword bid proposals plus a
   stable client request ID. For proposals, validate tenant/entity scope, canonical decimal
   strings and current values, then create real `apply_batches`/`apply_rows` with MCP
   provenance before building the plan. Never synthesize nonexistent source row identities.
3. Preview stores the immutable plan and returns its ID/fingerprint, exact counts and UI URL.
   Apply accepts the recorded plan ID/fingerprint and stable request ID. A changed preview
   requires new admission. The two operations stay distinct even without a human UI click.
4. Admit transactionally: verify the key and current owner/admin membership, lock the delegation
   and daily-budget row, validate caps and current plan, reserve capacity, record key ID, owning
   user ID, delegation version, plan fingerprint, receipt, durable audit and execution identity,
   and enqueue. If any part fails, no executable outbox work remains. A duplicate request returns
   the original execution and never consumes daily budget twice. Reusing an ID with different
   content refuses. Never trust a caller-supplied actor UUID.
5. Define the budget day/time zone and reservation/release accounting in the contract. Failed
   or ambiguous execution cannot silently refund capacity and allow duplicate provider calls.
   Count requested, reserved, attempted, accepted, observed, refused and released capacity.
6. Recheck revocation, expiry, profile scope and kill switches immediately before provider
   reservation. A revoked key blocks undispatched work; an already attempted call still records
   its outcome and observation. Preserve exact prior evidence for recovery.
7. A single source of current delegation/kill-switch authority must gate MCP admission and
   the worker. An environment gate may keep routes/tools unregistered at startup;
   a database-backed switch must stop queued dispatch without a redeploy. Startup registration
   alone is not a runtime kill switch.
8. Adapt MCP's audit wrapper so a lost response or post-admission failure returns an execution
   identity or an explicit unknown outcome, never "nothing was changed" after admission.
   Read-only audit behavior remains covered by its existing tests.
9. Read-only keys cannot preview write proposals or apply them. They retain existing analytical
   reads. Existing UI writes use WP-214's human approval path and are unaffected by delegation.
10. Expose discoverable MCP tools `preview_bid_changes`, `apply_bid_changes` and
    `get_write_status` with shared request/response contracts. Test tool discovery and calls
    through the authenticated Streamable HTTP connection using a fake provider, not just direct
    calls to internal handlers. The returned plan/execution identities must match the UI status.
    A write-scoped caller must complete the flow without browser cookies or a manual UI step.

## Time Machine and reversion

Every MCP write must appear in Time Machine, with the key and owning user, profile/entity,
old/requested/observed values, timestamps, exact counts and execution state. Link each entry to
its immutable plan and execution. A matching synchronization observation must enrich that
entry rather than create a duplicate action. Pending, refused, partial and failed outcomes must
not be presented as successfully applied changes.

Time Machine must offer a guarded inverse of an eligible MCP change against current synchronized
state. UI-triggered reversion uses human approval; MCP-triggered reversion uses its active bounded
delegation. Record the inverse as its own plan operation linked to the original. The current
ledger reuses the execution cycle id, so both the execution id and plan id identify each direction.
The initial inverse must cover the full source plan and requires every source action to be
observed at its requested value; partial results remain visible but cannot use a subset inverse.
Both directions
and the inverse's pending/accepted/observed/failed state remain visible. Refuse stale/conflicting
inversions; never erase or rewrite the original event.

Declare shared timeline/reversion contracts, DB projection/queries and tests as implementation
scope. Claude Fable 5.1 owns Time Machine's client presentation and interaction design; provide
synthetic fixtures and server data wiring for that handoff.

## Acceptance

1. Shared contracts and persistence land before consumers; source and activation PRs each pass
   independently. Existing manual and bounded-live-test fixtures remain green.
2. Fake-provider MCP tests exercise WP-214's application service; existing UI/backend tests
   remain green under their human-approval mode. Prove no second
   execution on retries/lost response, no enqueue on audit failure, and atomic daily-budget
   enforcement for concurrent calls at the final available row.
3. Test read-only scope refusal, cross-tenant entity/plan refusal, membership removal, key expiry
   or revocation between preview/apply and before dispatch, stale plan, delta/row cap refusal,
   kill switch after enqueue, and key/owning-user provenance in audit and status.
4. After WP-214 proves the UI path, one exact live-test authorization permits a bounded key
   to perform one bid-change cycle through the actual authenticated MCP connection. Verify
   discovery, preview, apply and status from an MCP client without using the UI to submit or
   approve the change. Reconcile accepted/observed counts and inverse restoration using the
   same worker path; the execution is also visible in the UI.
5. `AGENTS.md`, UI/MCP guidance and implementation agree; `pnpm check`, hygiene and skill lint
   pass. Record live evidence only when it has actually been observed.

6. Through the actual MCP connection, a synthetic write and its inverse appear in the Time
   Machine query/page data with the original actor, exact values, execution states and mutual
   links. Assert tenant isolation, one entry per logical change after resync, retained original
   history, and visible partial/failed reversion outcomes. Live proof repeats the same checks
   only within its exact authorization.
