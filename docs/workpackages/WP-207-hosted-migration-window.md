# WP-207 — Hosted migration window and program re-baseline

Owner: Claude for implementation and the migration window. GPT supplies the reviewed handoff.
Updated 2026-09-05 after the operator assigned D1 to their Claude work.

Depends on: `origin/main` at `560d5e2` or later; decision D1 in
`docs/workpackages/REPLAN-2026-09-05.md`.

## Objective

Bring the hosted Supabase ledger from 41 to 46 versions by applying
`20260901020000` through `20260901060000` through the attended procedure that applied WP-186 on
2026-09-01, prove the procedure on a disposable database first, and record that the WP-201 to
WP-205 supervisor program is parked. This is the schema gate for the new queue consumers;
WP-216 is a separate preview-readiness gate.

## Owned files

- `docs/deploy/hosted-migration-attended-window.md` (new runbook);
- `docs/deploy/hosted-migration-preflight-checks.sql` (new, read-only queries);
- `apps/worker/src/store.hosted-prefix.test.ts` (new integration test);
- `docs/HANDOVER.md` sections "Hosted migration gates" and "Recommended continuation order";
- `docs/STATUS.md` rows for WP-197 to WP-207 and the "Release gates" list;
- `.github/workflows/trusted-kernel-proof.yml` (disable on push, keep on manual dispatch);
- this brief.

No migration file is edited. No file under `tools/hosted-migration-*` is edited or deleted.

## Read first

1. `AGENTS.md`: program rule 8 and the hosted gates.
2. `supabase/README.md`.
3. `docs/HANDOVER.md`: "Hosted migration gates" and the WP-186 window narrative.
4. The WP-186 brief in `docs/workpackages/`, section "Hosted application gate".
5. `docs/deploy/hosted-migration-bundle.md` and `tools/hosted-migration-bundle/sql/*.sql`.
6. The five migration files, in full, with finding F6 beside you.

## Required behavior

### Part A: rehearsal on a disposable database (no authorization needed)

1. Add `apps/worker/src/store.hosted-prefix.test.ts`, keeping the database package free of
   worker imports. Use the existing `createTestDatabase` predecessor support to apply the
   first 41 repository files through `20260901010000` on a disposable local database. Enqueue
   one synthetic `entity.sync` job and claim it through `PostgresWorkerStore`. Assert the parser
   failure and read back exactly one durable `running` row with one consumed attempt.
   Apply `20260901020000`, `030000` and `040000` in order, producing the canonical 44-file
   prefix. Explicitly recover the stranded synthetic row, assert the recovery count, then
   reclaim exactly one row and assert `claim === null`. A new job is an alternative only if
   the first row's recovery is separately verified. Do not call an isolated 41-plus-040000
   experiment a 42-version migration prefix.
   Skip only when the disposable test database is unavailable; CI must execute the test with
   a database. Explicitly set the test URL to the local/branch target, never a production URL.
   The existing shim locks `pg_authid` when bootstrapping a fresh database; the local Supabase
   principal used during this review lacks that permission. Use an isolated plain-Postgres
   superuser test service as CI does, or repair the test shim in a separately declared slice.
   Do not add that catalog permission to a production principal for a rehearsal.
2. Replay all 46 files on a fresh database and run the existing `migrations.test.ts`.
3. Rehearse the runbook end to end against that disposable database: preflight queries, the
   push, postflight queries. Record the exact outputs in the runbook as expected shapes.

### Part B: the runbook

`docs/deploy/hosted-migration-attended-window.md` must contain, in order:

1. Preconditions: authenticated Supabase CLI 2.116.0, explicit project reference passed on every
   command, a fresh private workdir outside the repository, no other schema tool or SQL-editor
   DDL for the duration, the optimizer edit and job-creation freeze still in force.
2. Fetch: `supabase migration fetch` into the workdir; require `supabase migration list` to show
   exactly 41 remote versions ending in `20260901010000`. Never push from the repository
   checkout: the first 30 hosted version numbers differ from the repository filenames.
3. Stage the five files: copy the five repository files by hand into the fetched workdir and
   compare their SHA-256 with the pinned digests in
   `tools/hosted-migration-bundle/src/policy.ts`. The bundle tool's `build` and `verify` are
   optional extra evidence; a `BASELINE_POLICY` refusal is not a blocker for the hand path.
4. Dry run: `supabase db push --dry-run` must offer exactly the five versions and nothing else.
5. Window: record the exact service and scheduler states first. Under the window authorization,
   stop the legacy integration worker and any WP-210 worker; pause only the two producer jobs
   identified by the preflight schedule/command fingerprints. Historical IDs 3 and 4 are hints,
   not identity checks. Quiesce Vercel cron as part of the window and verify no active claims or
   schema-capable transactions remain. Report jobs may run longer than a poll interval; judge
   completion by the actual claim state and bounded shutdown, not that interval. If any writer
   cannot be quiesced, stop before apply and revise/rehearse the procedure.
6. Frozen preflight, all read-only, from `docs/deploy/hosted-migration-preflight-checks.sql`:
   `tools/hosted-migration-bundle/sql/wp-197-hosted-migration-probe.sql`, then
   `wp-197-hosted-migration-prefix-41.sql`, then the probe again; count `recommendations` rows
   with no matching `recommendation_runs` row (the FK in `20260901060000` validates existing
   rows); count `recommendations.run` jobs in `queued` or `running`; confirm the migration
   principal has CREATEROLE; confirm zero blocking locks and zero idle-in-transaction sessions
   from schema-capable paths. Record every number.
7. Apply: `supabase db push` from the workdir. On any failure do not retry blind: rerun the probe,
   classify the committed prefix between 41 and 46, fix the cause, fresh dry run, resume forward
   only. Never edit an applied file and never repair history.
8. Postflight: probe, `wp-197-hosted-migration-prefix-46.sql`, probe; all pass; fingerprints equal
   preflight except where the WP-196 role and ACL matrix is expected to change. Restore both cron
   jobs to the recorded schedule, command, database, user and active state. Restart the legacy
   worker and watch two claim cycles; each claim now reads two authority rows FOR SHARE.
   Restart the pilot worker if it was running. Restore the recorded Vercel cron state last and
   reconcile its next tick before closing the window.
9. Record: five new ledger rows and the postflight aggregates in `docs/HANDOVER.md` and
   `docs/STATUS.md`, sanitized as WP-186 did.

### Part C: program re-baseline

1. Rewrite the "Recommended continuation order" in `docs/HANDOVER.md` to point at
   `docs/workpackages/REPLAN-2026-09-05.md` and state that the rehearsed, scoped window is the
   selected path.
2. Record WP-201 to WP-205 as parked in `docs/STATUS.md`; leave the
   `wp-201-disposable-preparation` branch and its worktree untouched.
3. Change `.github/workflows/trusted-kernel-proof.yml` to run only on `workflow_dispatch`.

## Authorization

Part A and runbook preparation need no additional approval. After the rehearsal, present one
concrete authorization naming the hosted target privately, the five migration digests, fetched
workdir procedure, exact worker stops/restarts, Vercel cron suspension/restoration and the two
pg_cron jobs. Include prefix-aware failure recovery, the restoration order and stop conditions.
The operator can authorize the whole window once; attendance and per-command confirmation are
not required. Do not execute until that scoped authorization is recorded. New deployments,
credential provisioning, lane activation and Amazon writes are outside this window unless
separately named and authorized.

## Acceptance

1. `store.hosted-prefix.test.ts` proves the 41-file claim failure and committed row state,
   upgrades through the 44-file prefix in order, recovers and claims exactly one row, and runs
   in CI with a disposable database.
2. The runbook was rehearsed on a disposable database and its expected outputs are recorded.
3. Dry run offered exactly five versions.
4. Postflight shows 46 ledger rows, the probe and prefix-46 scripts pass, both pg_cron jobs and
   Vercel cron are restored to their recorded states, the legacy worker is active with a clean claim cycle.
5. `docs/HANDOVER.md` and `docs/STATUS.md` carry the new snapshot; `pnpm check` and
   `pnpm hygiene` pass on the branch.

## Do not

- Push from the repository checkout, run `migration repair`, or pull hosted schema into the repo.
- Call `activate_report_worker_fenced_claims()` or any recommendation activation function.
- Start any worker from `origin/main` before postflight passes.
- Delete branches, worktrees or the `tools/hosted-migration-*` packages.
