# wizard-ads

This file is the single source of truth for agent behavior in this repository, for
every assistant. It routes and it rules. Each work package brief in
`docs/workpackages/` adds detail for one package; where a brief and this file
disagree about a boundary, this file wins and the brief is wrong.

## What this is

**wizard-ads** is an in-house Amazon Advertising platform: profile and entity sync,
Reporting v3 ingestion, analytics, and bid recommendations, plus the pieces the
commercial tools do not have (search-query-versus-PPC analysis, rank reconciliation,
BSR proximity alerts, a creative hub, off-Amazon placement control).

Two facts shape every design decision in here:

1. **v1 is read-only.** It proposes; the operator applies. Accepted proposals leave
   as an export, not as an API write. Writes unlock only after our numbers match the
   incumbent tool side by side for a sustained period, on real profiles.
2. **This repository is public.** Everything below about hygiene follows from that.

Architecture and phase plan: `docs/PLAN.md`. Program status: `docs/STATUS.md`.

## Layout and ownership

Package boundaries are work-package boundaries. Two agents building in parallel must
never need the same file.

| Path | What it is | Owner |
|---|---|---|
| `packages/shared` | THE contract package. Zod schemas and inferred types. | WP-00 |
| `packages/db` | Drizzle schema, typed queries, RLS test helpers. | WP-01 |
| `packages/ads-api` | Amazon Ads API client. Pure client, no database. | WP-02 |
| `packages/core` | Doctrine engine. Pure functions, zero I/O. | WP-05 |
| `packages/strategy` | Tenant config resolution. Template only, no values. | WP-05 |
| `packages/campaigns` | Campaign generation engine (SKW/Halo/Phrase/Auto/PAT; BMM dropped 2026-08-14). Pure, plus its own XLSX writer. | WP-14 |
| `packages/ui` | DataGrid, charts, tiles. | WP-06 |
| `apps/web` | Next.js App Router: auth, OAuth, dashboard, grid, settings. | WP-04, 06, 07, 08 |
| `apps/worker` | Job worker. Every Amazon API call in the system happens here. | WP-03 |
| `apps/mcp` | Read-only MCP server. | WP-09 |
| `supabase/` | Migrations, RLS, partitions, seed. | WP-01 |
| `fixtures/` | Python-to-TypeScript parity harness. | WP-05 |
| `tools/crosscheck-cli` | Crosscheck CLI and exit-report generator. | WP-10 |
| `tools/recon` | Competitor UI walkthrough specs. Specs only, no code. | WP-11 |
| `tools/hygiene-lint` | The public-repo gate. | WP-00 |
| `_local/` | Gitignored per-operator config. Only `*.TEMPLATE.*` is tracked. | operator |

## Dependency direction

```
shared  <-  core / strategy / ads-api / db  <-  web / worker / mcp
```

Three rules inside that, each one load-bearing rather than stylistic:

- **`shared` depends on nothing of ours.** It is the contract; a contract that
  imports an implementation is not a contract.
- **`core` and `strategy` never import `db` or `ads-api`.** Pure functions with zero
  I/O are what make the parity harness against the Python reference possible at all.
  The moment the doctrine engine can read a database, it cannot be replayed.
- **`apps/web` never imports `ads-api`.** Every Amazon call lives in the worker.
  Reporting v3 takes hours and throttles with no quota headers; that does not belong
  behind a request handler, and Amazon tokens must never reach the web tier.

`eslint.config.js` enforces all three with `no-restricted-imports`. A violation is a
lint failure, not a code review comment.

wizard-ads consumes nothing from any sibling project at runtime.

## Contract freeze

`packages/shared` is frozen. Six packages are built in parallel against it.

If you need a shape that is not there, or a shape that is there and wrong: **stop and
report it.** Do not add a local type that duplicates a contract, do not widen a schema
to make your package compile, and do not edit `packages/shared` unless you own WP-00
and the manager has signed off. A contract that changes under a parallel build costs
more than a day of waiting.

Adding a genuinely new shape that no other package touches yet is the one cheap case,
and it still goes through the same door.

## Program rules

1. **Own your package only.** Never edit files another work package owns. Cross-package
   shapes live in `packages/shared`.
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

Live Amazon smoke tests read credentials from a gitignored `_local/` config. Ask the
operator to place it. Never hardcode a credential, and never commit one for "just a
test".
