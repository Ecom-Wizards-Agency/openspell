# WP-185 — Hosted migration lock safety

Owner: WP-01 (`supabase/`, `packages/db`). Runtime state: source guard only; no hosted action.

## Outcome

Every pending current-main migration that can acquire a live relation lock sets a bounded,
transaction-scoped five-second PostgreSQL `lock_timeout` before its first DDL statement. The limit
remains active through Supabase's migration-ledger write and PostgreSQL clears it only when the
whole migration transaction ends. Contention aborts the attended attempt instead of creating an
unbounded lock wait or convoy.

## Boundaries

- Amend only unapplied hosted migration source. Never rewrite a migration already present in the
  hosted ledger.
- Do not link a project, run `db push`, seed data, deploy code, or call Amazon.
- Preserve migration order, data semantics, RLS, grants, feature defaults, and application
  contracts. This package changes lock-wait behavior only.
- WP-171's branch migration receives the same guard only after that branch is integrated with the
  resulting current main. A single reviewed branch must then contain the exact four-file pending
  ledger in chronological order before an operator command is prepared.

## Required invariants

1. Marketing Stream correctness, Unified Reporting, and contextual-negative export migrations set
   `SET LOCAL lock_timeout = '5s'` as their first executable statement.
2. No in-file reset may disable the timeout before Supabase records the migration in its ledger.
3. A source-level regression test covers every lock-sensitive current-main migration so later
   edits cannot silently remove or move the guard below DDL.
4. Fresh-database replay and existing-state replay apply the exact migration sources in filename
   order and prove valid indexes, constraints, grants, RLS, and pre/post count reconciliation.
5. Hosted state remains read-only until separate exact-target authorization and the operator-run
   procedure in `supabase/README.md`.

## Acceptance

- Focused database tests and the source guard pass.
- Disposable PostgreSQL applies all current-main migrations in exact order.
- `pnpm check`, `git diff --check`, and public-repository hygiene pass.
- High correctness review and Extra-High adversarial safety review find no unresolved blocker.
- Exact-head pull-request CI and exact-main CI pass before WP-171 integration begins.
