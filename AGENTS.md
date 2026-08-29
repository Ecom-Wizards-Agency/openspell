# OpenSpell (`wizard-ads` repository)

This file is the single source of truth for agent behavior in this repository, for
every assistant. It routes and it rules. Each work package brief in
`docs/workpackages/` adds detail for one package; where a brief and this file
disagree about a boundary, this file wins and the brief is wrong.

## What this is

**OpenSpell** is an in-house Amazon Advertising platform: profile and entity sync,
Reporting v3 ingestion, analytics, and bid recommendations, plus the pieces the
commercial tools do not have (search-query-versus-PPC analysis, rank reconciliation,
BSR proximity alerts, a creative hub, off-Amazon placement control).

The public repository and package scope remain `wizard-ads` / `@wizard-ads/*` until a
separately planned infrastructure migration changes those stable identifiers. User-facing
product copy, metadata, and connection guidance use **OpenSpell**.

Three facts shape every design decision in here:

1. **OpenSpell may write through the Amazon Advertising API.** Supported campaign
   creation and approved bid, budget, placement, targeting, and state changes may be
   applied directly by the worker. Read-only preview remains the default; no write is
   implicit in viewing, analysing, syncing, or generating a recommendation.
2. **Every write is an operator-approved batch.** Before execution the UI shows the
   exact profile, entities, old/new values, guardrails, and change count. The operator
   explicitly confirms the batch; the worker then applies it idempotently, records every
   response, resynchronizes the affected entities, and exposes conflicts or failures.
   Automatic execution exists only for a deliberately configured and enabled cadence with
   its own bounds and kill switch. Without an active cadence, no unattended batch is pushed.
3. **This repository is public.** Everything below about hygiene follows from that.

Architecture and phase plan: `docs/PLAN.md`. Program status: `docs/STATUS.md`.

## Package boundaries

Numbered work packages are historical delivery records, not permanent owners. Active work
declares its file scope in its branch or brief, and concurrent work must use non-overlapping
files. Keep this map because these boundaries still define where code belongs.

| Path | Responsibility | Change boundary |
|---|---|---|
| `packages/shared` | THE contract package: Zod schemas and inferred types. | Contracts land before dependent implementations. |
| `packages/db` | Drizzle schema, typed queries, and RLS test helpers. | Persistence only; no Amazon calls. |
| `packages/ads-api` | Pure Amazon Ads API client. | HTTP client only; no database. |
| `packages/sp-api` | Pure Selling Partner API report client. | HTTP client only; worker-only at runtime. |
| `packages/core` | Doctrine and decision engine. | Pure functions, zero I/O. |
| `packages/strategy` | Tenant strategy resolution. | Shape and resolution only; no tenant values in source. |
| `packages/campaigns` | Campaign planning, validation, and artifacts. | Pure; no database, credentials, or Amazon calls. |
| `packages/ui` | Reusable DataGrid, chart, and tile primitives. | Presentation only. |
| `apps/web` | Next.js operator application. | May preview, approve, and enqueue; never calls Amazon. |
| `apps/worker` | Sync, reports, schedules, and mutation execution. | Every Amazon API call happens here. |
| `apps/mcp` | Authenticated MCP interface. | No direct Amazon calls; cannot self-approve. |
| `supabase/` | Migrations, RLS, partitions, and seed structure. | No production execution without scoped authorization. |
| `fixtures/` | Python-to-TypeScript parity harness. | Synthetic data only. |
| `tools/crosscheck-cli` | Crosscheck CLI and exit-report generator. | Read-only evidence. |
| `tools/recon` | Competitor walkthrough specifications. | Specs only, no product runtime. |
| `tools/hygiene-lint` | Public-repository safety gate. | Scans tracked content. |
| `_local/` | Gitignored operator configuration and authorizations. | Only `*.TEMPLATE.*` files are tracked. |

## Dependency direction

```
shared  <-  core / strategy / ads-api / sp-api / db  <-  web / worker / mcp
```

Three rules inside that, each one load-bearing rather than stylistic:

- **`shared` depends on nothing of ours.** It is the contract; a contract that
  imports an implementation is not a contract.
- **`core` and `strategy` never import `db`, `ads-api`, or `sp-api`.** Pure functions with zero
  I/O are what make the parity harness against the Python reference possible at all.
  The moment the doctrine engine can read a database, it cannot be replayed.
- **`apps/web` never imports `ads-api` or `sp-api`.** Every Amazon call lives in the worker.
  Reporting v3 takes hours and throttles with no quota headers; that does not belong
  behind a request handler, and Amazon tokens must never reach the web tier.

`eslint.config.js` enforces all three with `no-restricted-imports`. A violation is a
lint failure, not a code review comment.

wizard-ads consumes nothing from any sibling project at runtime.

## Contract authority

`packages/shared` remains authoritative. Do not add a package-local type that duplicates a
cross-package contract or widen a schema merely to make one caller compile. Additive contract
work for the guarded Amazon write gateway and SP/SB/SB Video/SD campaign creation is approved;
land and verify those contracts before dependent implementations, and serialize concurrent
changes that touch the same contract files.

## Program rules

1. **Respect active file scope.** Inspect branches and worktrees before editing. Concurrent
   packages must not edit the same files; cross-package shapes live in `packages/shared`.
2. **Dependency direction is enforced.** See above.
3. **This repo is public.** See hygiene, below.
4. **Verify the artifact, not the exit code.** Any list-driven operation counts outputs
   against inputs as a test assertion: rows parsed against rows loaded, entities listed
   against entities upserted. A zero exit code and a written file prove nothing. Every
   silent data-loss bug this rule exists for reported success while losing rows.
5. **Reference code is spec, not dependency.** The Python tools in the sibling
   `amazon-agent` repository are read-only ground truth. Port the logic; never import
   it, modify it, or copy files wholesale. Its selftests define correct behavior.
6. **TypeScript strict everywhere.** pnpm workspaces and Turborepo, Vitest for tests,
   Playwright for end-to-end. Every package lands with its tests green.
7. **Work on a branch** named `wp-XX-short-name`, commit in logical units, and report
   against the brief's acceptance checks before merge.
8. **Blast radius.** Never run migrations, seeds, or destructive statements against a
   production or shared Supabase project, and never point a local run at production
   credentials, unless the operator authorizes that exact action in the current task.
   Branch databases and local stacks are the default target; say which one you are on
   before any schema or data change.

## Amazon write contract

Amazon writes are allowed only through this contract:

1. **Worker-only execution.** `apps/web` may validate, preview, approve, and enqueue a
   batch, but it never imports `packages/ads-api` and never receives Amazon credentials.
   `apps/mcp` may create drafts and trigger an already approved batch, but it never calls
   Amazon directly and cannot approve its own change in the same operation.
2. **Explicit profile enablement.** Production writes require both an environment-level
   write gate and a tenant/profile allowlist. Missing, expired, or mismatched authorization
   fails closed. A read credential or successful sync never implies write permission.
3. **Preview before approval.** The immutable preview records the exact requested action,
   Amazon entity identity, current synchronized value, proposed value, guardrails,
   provenance, and total count. Campaign creation also records that Amazon resources cannot
   be deleted by a rollback after creation.
4. **Unambiguous confirmation.** The final control names Amazon and the exact count, for
   example **“Yes, apply 24 changes to Amazon”** or **“Yes, create 6 campaigns in Amazon.”**
   Selection, confirmation, and execution are separate acts. Stale or changed previews
   require a new approval.
5. **Idempotent, conflict-aware batches.** Every batch and row carries a stable idempotency
   identity. The worker checks the latest synchronized state before mutation, never retries
   a successful row as a new write, and records partial success without presenting the whole
   batch as applied.
6. **Count and response assertions.** Requested, accepted, attempted, succeeded, failed,
   refused, and resynchronized rows are counted and reconciled. An HTTP success without
   entity-level response agreement is not completion evidence.
7. **Audit and observation.** Store actor, approval time, request identity, sanitized Amazon
   response, before/after values, and timestamps. Resynchronize affected entities after the
   write and distinguish requested, accepted by Amazon, observed in sync, conflicting, and
   failed states.
8. **Reversion is another guarded write.** Time Machine may restore prior values through the
   Advertising API after it previews the exact inverse against current synchronized state.
   It refuses blind inversion on conflicts and normally requires a fresh explicit
   confirmation. A bounded live-test authorization may pre-approve the exact inverse as part
   of the same test cycle, so the worker can verify and reverse without waiting for a second
   operator response. Creation has no delete rollback; any pause/archive proposal is a
   separate reviewed action.
9. **No automatic execution by accident.** Schedules, optimization cadence, dayparting, AI,
   and webhooks may execute only when the operator deliberately creates and enables a cadence
   for that profile and action class. The cadence carries its own caps, approval provenance,
   next-run visibility, pause control, and kill switch. Without an active cadence, these
   surfaces may generate previews but cannot push. MCP cannot create or enable a cadence and
   cannot mutate Amazon without a separately recorded approval.
10. **Live tests need scoped authorization.** Unit and integration tests use fake providers and
    synthetic fixtures. A live Amazon write smoke test requires either an exact
    operator-approved action or a current, gitignored
    `_local/amazon-write-authorization.json` that names the allowlisted profiles, permitted
    action classes, per-operation maxima, expiry, cadence limit, and rollback requirements.
    The worker resolves the final entity, records the immutable preview and inverse, allows
    only one active test mutation, and stops on stale state, conflict, missing observation,
    or any exceeded bound. Never use a live account merely because credentials are available.
    Profile names and ids never enter a tracked file.

## Public-repo hygiene

`pnpm hygiene` runs in CI on every push and pull request. It reads the tracked file
list from git, so anything gitignored is invisible to it by construction.

Four rules:

- **(a) No absolute home-directory paths.** Use a repo-relative path, an environment
  variable, or a gitignored pointer file in `_local/`.
- **(b) No credentials.** Prefix patterns, credential-shaped assignments, and a basic
  entropy check. Secrets belong in the deployment platform's environment or in
  Supabase Vault, never in a file.
- **(c) No client names.** Terms come from `_local/hygiene-denylist.txt`, which is
  gitignored. Copy `_local/hygiene-denylist.TEMPLATE.txt` to create it. The check
  warns and skips when the file is absent, so a fresh clone is not blocked.
- **(d) No untracked, unignored top-level directories.** Such a directory is either
  about to be committed by accident or lost by accident.

Beyond what the linter can see, three things never enter a tracked file:

- **Doctrine threshold values.** Target ACOS, change caps, search-volume bands,
  cooldowns, graduation ranks. These are the agency's method. They live as per-tenant
  rows in the database, seeded by an operator-run script from a gitignored local file.
  `packages/shared` defines their **shape**; `_local/strategy.TEMPLATE.json` shows the
  document with every value replaced by a placeholder.
- **The profile roster.** Profile ids, account labels, brand names, marketplaces.
- **Real data in fixtures.** Goldens are synthetic. A golden built from a live account
  is a client data leak with extra steps.

Test data follows the same rule. Where a test genuinely needs the shape of a forbidden
string, assemble it at runtime from fragments rather than writing the literal, so a
reviewer grepping the repository finds nothing. `tools/hygiene-lint/src/scan.test.ts`
does this, and the linter's own source is exempt from the content rules for the same
reason: it necessarily contains the patterns it hunts for.

## Working here

```bash
pnpm install
pnpm check        # typecheck, lint, test, hygiene. The same four steps CI runs.
```

Individually: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm hygiene`.

Node 22 or newer, pnpm as declared in `package.json`. Workspace packages are consumed
as TypeScript source, so there is no build step between them.

Live Amazon smoke tests load credentials through the approved secret manager and read bounded
authorization from gitignored `_local/` configuration. Never print or hardcode a credential,
and never commit one for "just a test".
