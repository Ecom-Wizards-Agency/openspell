# WP-186 — Authenticated relation privilege hardening

Owner: WP-01 (`supabase/`, `packages/db`). Runtime state: source and hosted-schema gate only;
no web, worker, provider, or Amazon activation.

## Outcome

Public tables and sequences expose only the relation privileges required by their authenticated
RLS policies. Supabase's broad creator defaults no longer leave `TRUNCATE`, `REFERENCES`,
`TRIGGER`, `MAINTAIN`, or sequence-rewrite authority behind after a migration grants a narrower
set. Future tenant tables are fail-closed by default, and `app.install_tenant_rls` removes inherited
privileges before granting the intended read or member-write commands.

## Boundaries

- Add one forward migration. Never rewrite, repair, or replay an applied migration.
- Preserve every RLS policy, row, constraint, index, trigger, service-role grant, and preview-role
  grant.
- Normalize only `anon` and `authenticated` table and sequence privileges plus their `postgres`
  creator defaults in `public`.
- Keep partition children inaccessible directly to authenticated clients.
- Do not change function default privileges in this package. Public and `app` function execution
  require a separate explicit callable-surface audit.
- Do not link or mutate a hosted project, deploy code, call a provider, or activate a feature.
- Publishing or merging this source is not authorization to apply it to a hosted project.

## Hosted application gate

Hosted application requires one attended operator to own an exclusive schema-change window from
immediately before read-only preflight through migration commit and exact postflight. During that
window:

- Do not start a second migration push, SQL-editor DDL, default-privilege change, extension or
  schema operation, or external schema tool.
- Pause and drain partition and retention cron plus worker or backfill paths that can call
  `app.ensure_fact_partitions`. Wait for every pre-existing transaction from a schema-capable or
  DDL-producing path to end, including idle-in-transaction sessions. Abort the attempt rather than
  terminating a session.
- Keep the freeze until postflight proves the migration ledger, 77 roots, seven sequences, every
  partition, effective `PUBLIC`/`anon`/`authenticated` relation privileges, all-creator global and
  `public` default privileges, helper ownership and execution, relation ownership, preserved
  non-target grants, locks, and queues.

The migration and every later repository migration also take the same transaction-scoped advisory
DDL lock. That serializes cooperating sources but cannot reveal an object already created inside a
different uncommitted transaction, so it does not replace the exclusive window. If the operator
cannot establish and drain the window, do not approve the push.

## Required invariants

1. The migration begins with `SET LOCAL lock_timeout = '5s'`, then takes the shared repository DDL
   advisory lock, and runs transactionally through the Supabase migration ledger write.
2. Every current public RLS parent table has exactly the authenticated relation commands backed by
   its applicable policies; attached partitions have none.
3. No authenticated public table retains `TRUNCATE`, `REFERENCES`, `TRIGGER`, `MAINTAIN`, or any
   other non-row command.
4. No public sequence grants `anon` anything. `authenticated` has only `USAGE` on
   `experiment_events_id_seq`; it has no sequence `SELECT` or `UPDATE`.
5. Future public tables and sequences inherit no privilege for `anon` or `authenticated`.
6. `app.install_tenant_rls` first revokes both roles, then grants `SELECT` and optional
   `INSERT`/`UPDATE`/`DELETE`; the DDL helper itself is not executable by public API roles.
7. Existing rows, policies, non-target role ACLs, and service-role evidence-table truncate
   revocations remain unchanged.
8. The precondition requires `current_user = 'postgres'`, exact `postgres` relation ownership, and
   no target table or sequence default grant from an unexpected creator or global default scope.
9. A final statement snapshot rechecks inventory, owners, partitions, dangerous relation grants,
   exact sequence authority, and zero target defaults across every creator and both global and
   `public` scope. Any mismatch rolls back the entire migration.

## Acceptance

- The plain-PostgreSQL shim reproduces hosted Supabase table and sequence defaults before applying
  the real migrations, while remaining a no-op on an existing Supabase platform schema.
- Fresh replay and an existing-state replay prove exact row counts, policy fingerprints, table
  ACLs, sequence ACLs, and default ACLs.
- Synthetic installer probes reduce hostile inherited `ALL` to exact read-only and member-write
  privilege sets.
- Executable negative proofs refuse a non-`postgres` applier, another creator's `public` defaults,
  global defaults, and additive relation drift before any authority change can commit.
- A source guard requires this migration and every later repository migration to acquire the same
  DDL advisory lock immediately after the bounded lock timeout.
- Focused migration, RLS, feedback, experiment, and contextual-negative tests pass.
- `pnpm check`, `git diff --check`, staged hygiene, High correctness review, Extra-High adversarial
  review, exact-head CI, and exact-main CI pass.
- Hosted application is a separate attended schema-first action followed by exact grant, ledger,
  count, lock, and queue postflight before any web promotion or feature activation.
