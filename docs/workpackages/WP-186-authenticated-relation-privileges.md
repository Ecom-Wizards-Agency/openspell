# WP-186 — Authenticated relation privilege hardening

Owner: WP-01 (`supabase/`, `packages/db`). Runtime state: source and hosted-schema gate only;
no web, worker, provider, or Amazon activation.

## Outcome

Public tables and sequences expose only the relation privileges required by their authenticated
RLS policies. Supabase's broad `postgres` creator defaults no longer leave `TRUNCATE`,
`REFERENCES`, `TRIGGER`, `MAINTAIN`, or sequence-rewrite authority behind after a repository
migration grants a narrower set. Future `postgres`-created tenant tables are fail-closed by
default, and `app.install_tenant_rls` removes inherited privileges before granting the intended
read or member-write commands.

## Boundaries

- Add one forward migration. Never rewrite, repair, or replay an applied migration.
- Preserve every RLS policy, row, constraint, index, trigger, service-role grant, and preview-role
  grant.
- Normalize only `anon` and `authenticated` table and sequence privileges plus their `postgres`
  creator defaults in `public`.
- Preserve and fingerprint the platform-owned `supabase_admin` defaults. The project `postgres`
  role has no membership in or authority over that internal role, so this package must not alter,
  impersonate, or escalate to it.
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
  schema operation, role or membership change, column grant, or external schema tool.
- Pause and drain partition and retention cron plus worker or backfill paths that can call
  `app.ensure_fact_partitions`. Wait for every pre-existing transaction from a schema-capable or
  DDL-producing path to end, including idle-in-transaction sessions. Abort the attempt rather than
  terminating a session.
- Keep the freeze until postflight proves the migration ledger, 77 roots, seven sequences, every
  partition, effective `PUBLIC`/`anon`/`authenticated` relation privileges, all-creator global and
  `public` default privileges, direct and effective column privileges, API-role security-relevant
  attributes and memberships, helper ownership and execution, relation ownership, preserved
  non-target grants, locks, and queues.
- Require the exact reviewed PostgreSQL-version-specific `supabase_admin` default matrix before
  mutation and preserve it exactly through commit. Abort on a missing privilege, extra target or
  `PUBLIC` privilege, grant option, global scope, unexpected creator, or grantor drift.

The migration and every later repository migration also take the same transaction-scoped advisory
DDL lock. That serializes cooperating sources but cannot reveal an object already created inside a
different uncommitted transaction, so it does not replace the exclusive window. If the operator
cannot establish and drain the window, do not approve the push.

## Required invariants

1. The migration begins with `SET LOCAL lock_timeout = '5s'`, then takes the shared repository DDL
   advisory lock, and runs transactionally through the Supabase migration ledger write.
2. Every current public RLS parent table has exactly the authenticated relation commands backed by
   its applicable policies; every user column has the matching effective column commands and
   attached partitions have none.
3. No authenticated public table retains `TRUNCATE`, `REFERENCES`, `TRIGGER`, `MAINTAIN`, or any
   other non-row command. No `PUBLIC`, `anon`, or `authenticated` column ACL exists.
4. No public sequence grants `anon` anything. `authenticated` has only `USAGE` on
   `experiment_events_id_seq`; it has no sequence `SELECT` or `UPDATE`.
5. Future public tables and sequences created by the repository migration role `postgres` inherit
   no privilege for `anon` or `authenticated`.
6. `app.install_tenant_rls` first revokes both roles, then grants `SELECT` and optional
   `INSERT`/`UPDATE`/`DELETE`; the DDL helper itself is not executable by public API roles.
7. Existing rows, policies, non-target role ACLs, and service-role evidence-table truncate
   revocations remain unchanged.
8. The precondition requires `current_user = 'postgres'`, exact `postgres` relation ownership, no
   parent-role membership or privileged/login attribute for `anon` or `authenticated`, zero target
   column ACLs, the exact platform-owned `supabase_admin` target-default matrix, and either the
   exact legacy or empty `postgres` matrix. It refuses an unexpected creator, global target
   default, `PUBLIC` target default, grant option, or grantor drift.
9. A final statement snapshot rechecks inventory, owners, partitions, dangerous relation grants,
   exact direct and effective table/column/sequence authority, unchanged API-role security-relevant
   attributes and zero parent memberships, helper identity and execution, preserved non-target
   relation and column ACLs, zero `postgres` target defaults, and an unchanged `supabase_admin`
   snapshot. Any mismatch rolls back the entire migration.

## Platform-owned residual boundary

`supabase_admin` is a separate object creator. PostgreSQL applies default privileges for the role
that creates an object, not defaults inherited from other roles. A future platform-created public
relation can therefore inherit Supabase's broad platform baseline. WP-186 cannot safely change
that baseline with the supported project migration role and does not install an event trigger or
attempt unsupported role escalation. Hosted preflight fingerprints it, every current relation is
normalized, and repository migrations continue to fail closed on additive catalog drift. A change
to the platform matrix is a new reviewed work package, not an exception to this migration.

## Acceptance

- The plain-PostgreSQL shim reproduces the distinct hosted `postgres` and `supabase_admin` table
  and sequence defaults before applying the real migrations, while remaining a no-op on an
  existing Supabase platform schema.
- Fresh replay and an existing-state replay prove exact row counts, policy fingerprints, table
  ACLs, sequence ACLs, and default ACLs.
- Synthetic installer probes reduce hostile inherited `ALL` to exact read-only and member-write
  privilege sets.
- Executable negative proofs refuse a non-`postgres` applier, a partial or grantable platform
  matrix, a foreign platform-default grantor, a `PUBLIC` platform default, another creator's
  `public` defaults, global defaults, target column ACLs, and additive relation drift before any
  authority change can commit. Injected final-guard proofs reject a target column grant, a new
  API-role parent membership, and `BYPASSRLS`. A brokered session with `current_user = 'postgres'`
  succeeds without a role-changing statement in the migration.
- Supabase CLI 2.116 disposable replays prove 41/41 migrations and the WP-186 ledger row commit
  together, while both an opening inventory failure and an injected final-guard failure leave the
  WP-186 ledger row absent and every pre-migration ACL/default intact.
- A two-session executable proof shows an object, target column ACL, API-role membership, and
  `BYPASSRLS` change made in an uncommitted non-cooperating transaction are invisible to both
  catalog snapshots and can commit afterward, making the attended schema/role freeze a correctness
  requirement.
- PostgreSQL 15, 16 and hosted-version PostgreSQL 17 replays pass the same source.
- A source guard requires this migration and every later repository migration to acquire the same
  DDL advisory lock immediately after the bounded lock timeout.
- Focused migration, RLS, feedback, experiment, and contextual-negative tests pass.
- `pnpm check`, `git diff --check`, staged hygiene, High correctness review, Extra-High adversarial
  review, exact-head CI, and exact-main CI pass.
- Hosted application is a separate attended schema-first action followed by exact grant, ledger,
  count, lock, and queue postflight before any web promotion or feature activation.
