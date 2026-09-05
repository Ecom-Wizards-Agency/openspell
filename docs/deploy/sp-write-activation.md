# Guarded keyword-write activation preparation

Status: source preparation only, 2026-09-06. Nothing in this document authorizes a hosted
migration, gate change, credential access, deployment or Amazon call. Source and synthetic
proof live on `wp-214-sp-write-source`. The separate activation PR is not implemented.
Claude owns the confirmation client and WP-207's original five-file migration window.

## Release dependencies

1. Review and merge the source PR, resolve its required checks, then build the activation PR.
   Register one provider executor behind the declared runtime flag/profile allowlist. Configure
   `createKeywordMirrorCapability` on **every** ordinary keyword-sync owner before enabling
   native writes; an older sync must not overwrite or tombstone a newly observed bid.
2. Produce an immutable worker release with install, identity verification, shutdown/drain and
   rollback tests. Preserve integration job ownership and inject credentials through the
   approved runtime mechanism. This source does not supply those deployment scripts yet.
3. Verify Claude's WP-207 window independently. Rehearse the later source bundle against a
   disposable database using the exact reviewed migration bytes. The bundle contains WP-214's
   five files `20260905000000` through `20260905040000`, followed by WP-217's five files
   `20260906000000` through `20260906040000`. See the explicit inventories in
   [WP-214](../workpackages/WP-214-first-live-sp-write.md) and
   [WP-217](../workpackages/WP-217-mcp-guarded-apply.md). Commit each migration separately;
   the delegated enum cannot be consumed in its adding transaction. Preserve the five-second
   lock timeout and advisory DDL lock. Do not add files to Claude's existing window.
4. Apply that later bundle only under its own reviewed scope, before the matching web/MCP
   deployment. Native history, revised recommendations, audited read-key revocation and
   filtered exports have schema dependencies even when write tools stay off. A code rollback
   does not justify deleting evidence tables or reversing additive schema blindly.

## Private pilot scope

Prepare one gitignored review packet with the exact database/project and release identities,
operator, profile/connection/marketplace/currency, existing gate versions, one forward keyword
preview, old/new bid, count, bounds, expiry, inverse policy and stop/restore steps. Keep account
names, IDs and values out of tracked documents. The currently existing authorization JSON is
not an executable gate: its validated loader is still an activation prerequisite if used.

[The first-pilot SQL template](../../_local/sp-write-gate-seed.TEMPLATE.sql) seeds only one
environment version/head and one scoped profile grant version/head. It checks current routing,
owner/admin membership, expected prior grant and the authorization window; it refuses an existing
environment head. Its final `rollback` makes a rendered rehearsal nonpersistent. An authorized
execution copy must be reviewed with an explicit `commit`. Existing environment authority needs
an exact version-replacement script prepared from the observed state, outside this template.
This template enables no MCP gate, issues no key and records no approval. The authorization
window bounds running the seed; it does not automatically switch those gate heads off later.

## UI cycle, then MCP cycle

Use Claude's completed UI client for the first live proof. The server exposes preview,
approve, status and inverse-preview under `/api/sp-writes/`; viewing or building a preview
does not approve it. Confirm the exact count with Amazon named in the control. Retain the
request, plan and execution identities before sending. A queued result is not an applied bid.

Reconcile requested, admitted, attempted, accepted, observed, refused and mirrored counts from
the durable operation. For the first one-row cycle, require one accepted and one observed row
and the matching current keyword value. Verify its actor and state in Time Machine. Prepare the
inverse against fresh state; execute it only with a new human approval or a validated exact
preapproval for that inverse. Verify the initial bid is restored and both operation links exist.

Only after UI proof, prepare separate bounded MCP authority. Operator issuance uses
`POST /api/mcp-keys/write`; the MCP cannot issue or enlarge it. Enable the database MCP gate
with a new immutable version and head under the scoped window, then explicitly expose the
transport with `OPENSPELL_MCP_WRITES_ENABLED=1`. Missing/default configuration hides write
tools and refuses write credentials. Database gate/version checks stop new delegated intents
without a deploy. A read key must remain unable to discover or invoke the three write tools.

Use `preview_bid_changes`, then `apply_bid_changes`, retaining the same request ID and payload
for retries after uncertainty. Recover with `get_write_status`; an unresolved lookup is not
proof that no admission occurred. Each admitted row permanently consumes UTC daily allowance,
including later refusals. The inverse needs its own preview, request and available allowance.
Verify both MCP key and issuing-user attribution and the linked inverse in Time Machine.

## Stop and restore

On stale state, wrong identity/count, missing observation, exceeded bounds or unknown provider
outcome, close new dispatch authority and keep reconciliation available. Advance a gate head
to a newly recorded **disabled** version; never edit an immutable historical version. Disabling
the MCP database gate prevents new delegated intents, including already queued rows when the
active dispatcher next checks authority. A process paused or stopped locally records those
refusals when it resumes. Already committed calls still need result/observation recovery; a gate
switch cannot undo a request already sent to Amazon.

Before restoring a previous release, account for outstanding calls and retain the observation
and keyword-mirror capabilities needed for them. Do not replay ambiguous writes or blindly
invert changed entities. Record final counts, original/inverse links, restored current values,
disabled gate versions and the actual release identity in the private packet. Publish only
sanitized counts and the reviewed commit references in the workpackage audit.
