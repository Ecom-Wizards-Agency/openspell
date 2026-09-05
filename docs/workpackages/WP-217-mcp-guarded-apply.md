# WP-217 — MCP-triggered guarded apply

Owner: implementer. Starts only after WP-214 is live.

Depends on: decision D8 in `docs/workpackages/REPLAN-2026-09-05.md`. The operator's stated
target on 2026-09-05 is the AdLabs model: UI changes go through one approval step; changes
through the MCP do not, but every one is tracked in the logs. `AGENTS.md` currently says the MCP
cannot approve its own change, so D8 is an `AGENTS.md` amendment that only the operator can make.

## Objective

Let an MCP client with an explicit write-scoped key preview and apply a bounded set of bid
changes on allowlisted profiles through the same ledger, worker loop, counts, audit and
resynchronization as WP-214, without a separate UI approval, and with a kill switch.

## Owned files

- `apps/mcp/src/**` (new tools `preview_bid_changes` and `apply_bid_changes`, key scope checks);
- `supabase/migrations/<timestamp>_mcp_write_scope.sql` (new: `write` scope on `mcp.api_keys`
  with per-key profile allowlist and per-call caps);
- `AGENTS.md` "Amazon write contract" rule 1 and `apps/mcp` boundary row (text supplied by the
  operator's D8 decision);
- `skills/*/SKILL.md` "Required MCP tools" only if a skill gains a write tool;
- `docs/STATUS.md` one row.

## Proposed `AGENTS.md` amendment (decision D8)

Replace the sentence in "Amazon write contract" rule 1 that reads "`apps/mcp` may create
drafts and trigger an already approved batch, but it never calls Amazon directly and cannot
approve its own change in the same operation" with:

> `apps/mcp` never calls Amazon directly. A key without the `write` scope can only read and
> preview. A key with the `write` scope, a profile allowlist and per-call caps may record a plan
> and start its execution in one operation on behalf of the key's owning user; the key is the
> recorded actor, the same ledger, worker execution, counts, resynchronization and audit apply,
> and the environment kill switch can disable both tools without a deploy. Cadences and
> unattended batches still require their own explicitly enabled configuration.

Also change the `apps/mcp` row of the package table from "cannot self-approve" to "writes
only through write-scoped keys under the guarded contract". The operator applies this wording
or supplies their own before the package starts.

## Required behavior

1. Read-only keys are unchanged. A key must carry the `write` scope, a profile allowlist and
   caps: maximum rows per call, maximum absolute and relative bid delta, and a daily row budget.
2. `preview_bid_changes` records an `SpWritePlan` through the WP-214 builder and returns the
   preview with a plan id and a goto link to the UI preview page. Nothing is applied.
3. `apply_bid_changes(planId)` approves as the key's owning user through the authenticated-actor
   helper, records the actor as the key, starts the execution and returns the execution id.
   Every call writes an `audit_log` row with key id, plan id, counts and sanitized outcome.
4. The environment kill switch `OPENSPELL_MCP_WRITES_READY` gates both tools; unset means the
   tools are not registered.
5. Reversion remains available through the UI's inverse plan and Time Machine.
6. Tests: scope refusal, cap refusal, allowlist refusal, audit row per call, kill switch.

## Acceptance

1. A write-scoped key can preview and apply one bid change on one allowlisted profile; the
   audit log shows the key as actor; the UI status page shows the same execution.
2. A read-only key is refused; a call above a cap is refused before any plan is recorded.
3. `AGENTS.md` and `README.md` describe the new boundary; `pnpm check` and skill lint pass.
