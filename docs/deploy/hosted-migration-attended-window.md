# Attended hosted migration window: five files, 41 to 46 versions

This runbook takes the hosted Supabase ledger from 41 versions (terminal `20260901010000`) to 46
by applying, in order:

| # | Version (repository file starts with this) | Work package | Bytes | SHA-256 |
|---|---|---|---:|---|
| 42 | `20260901020000` | WP-187 | 179749 | `d28e2c3630ac4b59732cde8bb7021ae955c9b36f0b58d0567a7751c14259df67` |
| 43 | `20260901030000` | WP-192 | 46611 | `c34fc0a1902abe27f0c33d66c1a083fb32f0fd5df30974baecace674a2219a2c` |
| 44 | `20260901040000` | WP-194 | 20101 | `ec96b16f6c2c487404ee15d24cdf58d40d2d079ed0ed12fd5b12bc7abbcd9bf2` |
| 45 | `20260901050000` | WP-195 | 6379 | `af126c432ca8d523d7483139de3cbf267f3c1d2c68a14b236f2b171fc3811021` |
| 46 | `20260901060000` | WP-196 | 114111 | `937fe566de09413df7a7578bcd3889c36d4465b81c6d03ad0a1773ca3cf0cb84` |

The digests are the pinned `additions` in `tools/hosted-migration-bundle/src/policy.ts`. The same
attended procedure applied WP-186 on 2026-09-01. Nothing in this document is itself an
authorization: the window runs only under the one scoped authorization described in
`docs/workpackages/WP-207-hosted-migration-window.md`, and `AGENTS.md` program rule 8 governs.

Out of scope for this window, and not to be staged with it: the four WP-214 migrations with
versions `20260905000000`, `20260905010000`, `20260905020000` and `20260905030000`. They exist
on the separate WP-214 source branch, are not on `main`, are not in the WP-197 policy, and have their own
later gate. If a dry run ever offers a `20260905*` version, the workdir was staged from the wrong
checkout: stop.

Why this window is the schema gate for everything newer than 2026-08-30: since WP-194 the shared
row parser reads `claim_token` from every claimed job, and the hosted `claim_sync_jobs` at 41
versions returns rows without it. The claim UPDATE commits, the parse throws, the row is stranded
`running` with one attempt burned. `apps/worker/src/store.hosted-prefix.test.ts` reproduces that
on a disposable database and proves the 44-file prefix repairs it (finding F1 in
`docs/workpackages/REPLAN-2026-09-05.md`).

## What the rehearsal proved

Everything below marked **rehearsed** was executed on 2026-09-05 against a disposable plain
PostgreSQL 17 database with `supabase/tests/supabase-platform-shim.sql`, a hand-built
`supabase_migrations.schema_migrations` ledger carrying the 41 hosted version numbers, and the 41
repository files. The five files were then applied one transaction each with a ledger row, exactly
as `supabase db push` does. Expected shapes in this document are those observed outputs. Things
the rehearsal cannot exercise are marked **hosted only**: the CLI itself, Vercel, systemd, the real
`pg_cron` job table, and role state on a cluster that has never seen the WP-196 roles.

- `apps/worker/src/store.hosted-prefix.test.ts`: 5 of 5 passed. With the three-file upgrade
  removed, the same file fails on the 44-prefix assertions and the reclaim throws
  `claim function returned an invalid claim capability`, so the test measures the schema, not
  itself.
- `packages/db/src/migrations.test.ts`: 22 of 22 passed on a fresh 46-file replay.
- Probe, prefix-41, probe; apply five; probe, prefix-46, probe; preflight and postflight sections
  of `hosted-migration-preflight-checks.sql`: outputs recorded in the steps below.

## 1. Preconditions

All of the following hold before any command touches the hosted project:

1. The scoped window authorization from the WP-207 brief is recorded in the current task. It names
   the hosted target privately, these five digests, the fetched-workdir procedure, the exact worker
   stops and restarts, the Vercel cron suspension and restoration, the two `pg_cron` jobs, the
   prefix-aware failure handling, the restoration order and the stop conditions. Without it, stop
   after step 4 (dry run) and report.
2. Supabase CLI **2.116.0**, authenticated for the operator. Verify `supabase --version` prints
   `2.116.0`. Every command below passes the project reference explicitly as `--project-ref`; never
   rely on a linked project, a default, or `supabase link`.
3. A fresh, private, empty work directory **outside** the repository. Call it `$WORKDIR` below. It is
   deleted after the window. Never run `supabase db push` from a repository checkout: the first 30
   hosted version numbers differ from the repository filenames, and a push from the checkout would
   offer 30 already-applied files under new names.
4. No other schema tool, SQL-editor DDL, extension change, role change or migration push runs for the
   duration, by anyone.
5. The optimizer-group edit freeze and the manual/scheduled recommendation-job creation freeze from
   WP-186 are still in force and stay in force after this window until WP-213 lifts them.
6. Nobody has pre-created `openspell_recommendation_worker` or `openspell_recommendation_executor`
   on the hosted cluster. `20260901060000` creates them and refuses unsafe attributes; prefix-41
   must observe zero of them (step 6).
7. The operator has read `docs/HANDOVER.md` "Hosted migration gates", the WP-186 brief section
   "Hosted application gate", `docs/deploy/hosted-migration-bundle.md`, and the five files in full.

## 2. Fetch the hosted history

**Hosted only.**

```bash
mkdir -p "$WORKDIR" && cd "$WORKDIR"
supabase migration fetch --project-ref "$PROJECT_REF"
supabase migration list --project-ref "$PROJECT_REF"
```

Required result: the list shows **exactly 41** remote versions, every one also present locally after
the fetch, the last being `20260901010000`. Count them; do not eyeball. If the count is not 41, or
any version is remote-only or local-only, stop: the hosted ledger has moved since the last verified
snapshot and this runbook's preconditions are false.

`$WORKDIR/supabase/migrations/` now holds 41 files whose names are the hosted versions (the first
30 carry a second timestamp in their name; that is expected). Their byte contents must match the
`baseline` entries in `tools/hosted-migration-bundle/src/policy.ts`. Verify with `sha256sum` against
that table; 41 matches and no extra file.

## 3. Stage the five files by hand

Copy the five repository files from a clean `main` checkout into the fetched workdir, then compare
digests against the table at the top of this document:

```bash
for v in 20260901020000 20260901030000 20260901040000 20260901050000 20260901060000; do
  f=$(basename "$(ls "$REPO/supabase/migrations/${v}_"*.sql)")   # exactly one file per version
  cp "$REPO/supabase/migrations/$f" "$WORKDIR/supabase/migrations/$f"
done
(cd "$WORKDIR/supabase/migrations" && sha256sum 2026090102*.sql 2026090103*.sql 2026090104*.sql 2026090105*.sql 2026090106*.sql)
ls "$WORKDIR/supabase/migrations" | wc -l   # expect 46
```

**Rehearsed:** the five repository files hash to exactly the five digests above at the listed byte
counts. Any mismatch means the checkout is not `main` or a file was edited: stop; never edit a
migration file to make it match.

Optional extra evidence: `pnpm migration:bundle -- build` and `verify` per
`docs/deploy/hosted-migration-bundle.md`. A `BASELINE_POLICY` refusal from the bundle tool is not a
blocker for this hand path; the digests above are the acceptance check.

## 4. Dry run

**Hosted only.**

```bash
cd "$WORKDIR"
supabase db push --dry-run --skip-vault --project-ref "$PROJECT_REF"
```

Required result: the CLI offers **exactly** the five versions `20260901020000`, `20260901030000`,
`20260901040000`, `20260901050000`, `20260901060000`, in that order, and nothing else. No seed, no
roles file, no `20260905*` version, no already-applied version. Anything else: stop.

Record the dry-run output verbatim in the window notes. This is acceptance check 3.

Without the recorded window authorization, the procedure ends here.

## 5. Open the window

Record the exact current state of every writer **before** changing anything; postflight restores to
these records, not to memory.

### 5a. Record

- Legacy integration worker on the Evo host, unit `wizard-ads-worker.service`
  (**hosted only**): `systemctl show wizard-ads-worker.service -p ActiveState,SubState,UnitFileState,NRestarts,ExecMainStartTimestamp`.
- WP-210 pilot worker unit, if one exists (**hosted only**): the same `systemctl show` on that
  unit; record whether it exists and whether it is active.
- Vercel cron for `/api/cron/sync` (**hosted only**): record whether the project's cron jobs are
  enabled and the time of the last tick from the deployment logs.
- `pg_cron`: run PRE-9 and PRE-10 from `hosted-migration-preflight-checks.sql`. **Rehearsed** shape
  of PRE-9 (the shim's `cron.job` lacks `nodename`, `nodeport`, `database`, `username`; hosted rows
  carry them inside `recorded_state` as well):

  ```text
  jobid | recorded_state
  1     | {"active":true,"command":"select public.enqueue_due_schedules()","jobname":"wizard-ads-enqueue-due-schedules","schedule":"*/5 * * * *"}
  2     | {"active":true,"command":"select public.requeue_stale_sync_jobs()","jobname":"wizard-ads-requeue-stale-jobs","schedule":"*/15 * * * *"}
  3     | {"active":true,"command":"select app.ensure_fact_partitions(current_date, 2)","jobname":"wizard-ads-ensure-partitions","schedule":"10 3 * * *"}
  4     | {"active":true,"command":"select app.drop_expired_fact_partitions()","jobname":"wizard-ads-fact-retention","schedule":"40 3 * * 0"}
  ```

  PRE-10 returned exactly two rows: the `enqueue_due_schedules` and `requeue_stale_sync_jobs`
  jobs, both `active = true`. Those two are the producer jobs for this window because both write
  `public.sync_jobs`, which `20260901040000` alters under `ACCESS EXCLUSIVE` and
  `20260901060000` wraps in statement triggers. Hosted job ids may differ from 1 and 2 and from
  WP-186's historical 3 and 4; identity is the command fingerprint, never the id. If PRE-10 returns
  other than two rows, stop and reconcile the scheduler before continuing.

### 5b. Stop and pause

Under the window authorization, in this order:

1. **Hosted only.** Stop the legacy worker: `sudo systemctl stop wizard-ads-worker.service`, then
   `systemctl is-active wizard-ads-worker.service` must print `inactive`. Do not disable it.
2. **Hosted only.** Stop the WP-210 pilot worker unit if it was active, the same way.
3. Pause the two producer jobs using the job ids PRE-10 returned (**hosted only**; the shim has no
   `cron.alter_job`, so the rehearsal used a direct `update cron.job set active = false` with the
   same fingerprint predicate and observed the same two rows change):

   ```sql
   select cron.alter_job(job_id := <enqueue_due_schedules jobid>, active := false);
   select cron.alter_job(job_id := <requeue_stale_sync_jobs jobid>, active := false);
   ```

   Re-run PRE-10: both rows now `active = false`; the partition and retention jobs are untouched.
4. **Hosted only.** Quiesce the Vercel cron: disable the project's cron jobs in the Vercel project
   settings and record the prior state. A tick that is already running holds its claims for up to
   the route's 300-second budget; wait for it to finish rather than assuming the five-minute interval
   means it has.
5. Verify quiescence with PRE-4 and PRE-8. Required: `running_claims = 0`; PRE-8 shows no session
   from the worker, pilot or Vercel application names, only the operator's own tooling. Report jobs
   can legitimately run longer than one poll interval, so judge by the claim state, not the clock. If
   a `running` row belongs to a stopped process, it is stranded: leave it for the cron
   `requeue_stale_sync_jobs` after restoration, or recover it explicitly with
   `select public.requeue_stale_sync_jobs(interval '0 seconds')` and record the count.

If any writer cannot be stopped, paused or proven quiet, do **not** apply. Restore what was changed
in reverse order, close the window, and revise and re-rehearse the procedure.

## 6. Frozen preflight

All read-only. Run, in order, from `tools/hosted-migration-bundle/sql/`:

1. `wp-197-hosted-migration-probe.sql`
2. `wp-197-hosted-migration-prefix-41.sql`
3. `wp-197-hosted-migration-probe.sql` again

then the `SECTION: preflight` block of `docs/deploy/hosted-migration-preflight-checks.sql`.

**Rehearsed** probe row (both runs identical):

```json
{"observedPrefixFiles":41,"observedTerminalVersion":"20260901010000",
 "observedPrefixLedgerSha256":"9dd52d5fdee63b6b3c19de850ec72c27f3d8312a5bb5c73c492705e47c18bcea",
 "selectedEvidenceScript":"wp-197-hosted-migration-prefix-41.sql","catalogPatternPass":true,
 "schemaDdlLockHolderCount":0,"schemaDdlLockWaiterCount":0,
 "guardedCliSessionCount":0,"guardedCliActiveCount":0,"guardedCliWaitingCount":0,"pass":true}
```

**Rehearsed** prefix-41: 13 rows, one shared `prefixEvidenceSha256`, four named fingerprints
present on every row. On a fresh disposable cluster all 13 rows passed and the probe reported the
pinned 41-file ledger digest. An earlier run on a shared disposable cluster passed 10 of 13: the
three failures (`catalog.later_roles` expected `0` observed `2`, plus the derived
`catalog.relevant_item_count` and `catalog.relevant_sha256`) came from another database on the same
cluster that had already created the two cluster-wide WP-196 roles. That is exactly the condition
precondition 6 excludes. On the hosted project **all 13 rows must have `pass = true`**; a
`catalog.later_roles` observation above zero means somebody pre-created the roles and the window
stops. The same fresh-cluster run then applied the five files, passed all 109 prefix-46 rows with
the pinned 46-file ledger digest, restored the two paused producers, and claimed one job with
`claim = null` on the legacy path.

**Rehearsed** preflight section, expected values on a quiesced project:

| Query | Rehearsed output | Stop if |
|---|---|---|
| PRE-1 | `ledger_rows = 41`, `terminal_version = 20260901010000` | anything else |
| PRE-2 | `orphan_recommendations = 0` | `> 0` (the FK in `20260901060000` validates existing rows and would fail the file) |
| PRE-3 | `recommendation_jobs_queued = 0`, `recommendation_jobs_running = 0` | `running > 0`; `queued > 0` is tolerable only if the freeze explains it and no claimant runs |
| PRE-4 | `running_claims = 0`, `oldest_running_seconds = 0`, `running_job_types = ''` | `running_claims > 0` |
| PRE-5 | `rolcreaterole = true` for the applying principal (`rolsuper` is `true` only on the disposable superuser; hosted is `false`) | `rolcreaterole = false` |
| PRE-6 | `blocked_sessions = 0`, `ungranted_locks = 0` | either `> 0` |
| PRE-7 | `idle_in_transaction_sessions = 0` | `> 0` |
| PRE-8 | only the operator's own sessions | any worker, pilot or Vercel application name |
| PRE-9 | four rows as in 5a, the two producers now `active = false` | row count not 4 |
| PRE-10 | two rows, `active = false` | row count not 2 |

Record every number. The probe rows before and after prefix-41 must be identical; the four named
fingerprints from prefix-41 are the preflight leaf that postflight compares against.

## 7. Apply

**Hosted only.**

```bash
cd "$WORKDIR"
supabase db push --skip-vault --project-ref "$PROJECT_REF"
```

Every file opens with `set local lock_timeout = '5s'` and takes the shared advisory DDL lock, and the
CLI applies each file in its own transaction with its ledger row. **Rehearsed:** on the disposable
database all five applied without error; `20260901050000` added `recommendation_runs_job_fkey`,
`20260901060000` created both roles, added and validated `recommendations_tenant_run_fkey`
against existing rows, and left both authorities `legacy`. `--skip-vault` keeps the push from
touching Vault secrets declared in a local `config.toml`; the window changes schema only.

### If the push fails

Do not retry blind, do not edit an applied file, do not run `supabase migration repair`, do not
write reverse SQL.

1. Re-run the probe. `observedPrefixFiles` classifies the committed prefix: 41 means nothing
   committed; 42 through 45 means that many files are in the ledger and the next one failed;
   46 means everything committed and the failure was after the last ledger write. A value of `0`
   with `pass = false` means the ledger is not any known prefix: stop entirely and report.
2. Run the selected `wp-197-hosted-migration-prefix-<N>.sql` for the classified prefix and require
   every row `pass = true`. This confirms the committed files are whole.
3. Read the CLI error. Typical causes: a lock timeout from a writer that was not quiesced (recheck
   PRE-4, PRE-6, PRE-7, PRE-8), a foreign-key validation failure on `20260901060000` (recheck PRE-2),
   a missing `CREATEROLE` (PRE-5), or a pre-created role with unsafe attributes.
4. Fix the cause outside the migration files. Re-run the dry run: it must now offer exactly the
   remaining suffix, from `<N+1>` to 46, and nothing else.
5. Resume forward only with `supabase db push --skip-vault --project-ref "$PROJECT_REF"`. Never re-apply a version already in the ledger.

## 8. Postflight

All read-only first, then restoration in the stated order.

1. `wp-197-hosted-migration-probe.sql`, `wp-197-hosted-migration-prefix-46.sql`, probe again.

   **Rehearsed** probe row (both runs identical):

   ```json
   {"observedPrefixFiles":46,"observedTerminalVersion":"20260901060000",
    "observedPrefixLedgerSha256":"baef4df400ed7a045395322667e1d3ac61fa27075b2d36bb855071a6bfe20458",
    "selectedEvidenceScript":"wp-197-hosted-migration-prefix-46.sql","catalogPatternPass":true,
    "schemaDdlLockHolderCount":0,"schemaDdlLockWaiterCount":0,
    "guardedCliSessionCount":0,"guardedCliActiveCount":0,"guardedCliWaitingCount":0,"pass":true}
   ```

   **Rehearsed** prefix-46: 109 rows, 109 `pass = true`, one shared `prefixEvidenceSha256`, four
   named fingerprints on every row. Compare the four fingerprints with the prefix-41 leaf from step 6:
   `queueFingerprint`, `recommendationFingerprint` and `scheduleFingerprint` must be identical (the
   window changes no queue, recommendation or schedule rows). `outOfScopePrivilegeFingerprint` may
   differ only through the WP-196 role and ACL matrix; on the empty rehearsal database it did not
   change. Any other difference is a stop-and-investigate.

2. `SECTION: postflight-46` of `hosted-migration-preflight-checks.sql`. **Rehearsed** outputs:

   | Query | Rehearsed output |
   |---|---|
   | POST-1 | `ledger_rows = 46`, `terminal_version = 20260901060000`, `window_versions_present = 5` |
   | POST-2 | `protocol = legacy`, `epoch = 0` |
   | POST-3 | `protocol = legacy`, `admission = legacy`, `epoch = 0`, `authorized_revision = null` |
   | POST-4 | two rows, `openspell_recommendation_executor` and `openspell_recommendation_worker`, every attribute column `false` |
   | POST-5 | `token_bearing_rows = 0`, `running_claims = 0` |
   | POST-6 | `recommendation_runs_job_fkey` and `recommendations_tenant_run_fkey`, both `convalidated = true` |
   | POST-7 | `recommendation_guard_triggers = 8` |
   | POST-8 | four rows equal to PRE-9 once the producers are restored (run it again after step 3) |

   POST-2 and POST-3 are the proof that applying the files activated nothing: do not call
   `activate_report_worker_fenced_claims()` or any recommendation activation function in this window.

3. Restore both producer jobs to their recorded schedule, command, database, user and active state
   (**hosted only**; the rehearsal used the mirror `update ... set active = true` and POST-8 then
   matched PRE-9 row for row):

   ```sql
   select cron.alter_job(job_id := <enqueue_due_schedules jobid>, active := true);
   select cron.alter_job(job_id := <requeue_stale_sync_jobs jobid>, active := true);
   ```

   Re-run POST-8 and compare with the PRE-9 record: identical, including the untouched partition and
   retention rows.

4. **Hosted only.** Restart the legacy worker: `sudo systemctl start wizard-ads-worker.service`;
   `systemctl is-active` prints `active`. Watch two claim cycles in its journal. Each legacy claim now
   reads two authority rows `FOR SHARE`: the report-lane singleton from `20260901040000` inside
   `claim_sync_jobs`, and the recommendation singleton from the `a_recommendation_authority_prelock`
   statement trigger on `sync_jobs` from `20260901060000`. A clean cycle claims or finds nothing,
   raises no error, and leaves no `running` row behind (POST-5 again).
5. **Hosted only.** Restart the WP-210 pilot worker unit if, and only if, it was active in 5a.
6. **Hosted only.** Restore the Vercel cron to its recorded state **last**. Watch its next tick in
   the deployment logs and confirm it claimed and settled without the `invalid claim capability`
   error; the tick response's counts and POST-5 must agree. If the current production web revision
   predates WP-194 it never read `claim_token` and needs no change; a `main` deploy is WP-213, not
   this window.

Postflight passes when the probe, prefix-46 and postflight-46 section all pass, both `pg_cron` jobs
and the Vercel cron are restored to their recorded states, and the legacy worker is active with a
clean claim cycle. That is acceptance check 4.

## 9. Record

Sanitized as WP-186 did, with no project reference, identifier, credential or row data:

- in `docs/HANDOVER.md` "Hosted migration gates": five new ledger rows, terminal `20260901060000`,
  the prefix-46 pass count, both authorities `legacy`, both foreign keys validated, eight triggers,
  the pre/post fingerprint comparison result, the `pg_cron` restoration, the worker restart with its
  `NRestarts`, and the Vercel cron restoration;
- in `docs/STATUS.md`: WP-207 row moves to the window's outcome, the hosted-ledger release gate reads
  46 versions, and the dated evidence entry records the postflight aggregates.

Then delete `$WORKDIR`. Keep the recorded preflight leaf (fingerprints and numbers) with the window
notes; it is the comparison baseline for the next window.

## Do not

- Push from the repository checkout, run `migration repair`, or pull hosted schema into the repo.
- Call `activate_report_worker_fenced_claims()` or any recommendation activation function.
- Start any worker built from `origin/main` before postflight passes.
- Stage or apply any `20260905*` migration as part of this window.
- Delete branches, worktrees or the `tools/hosted-migration-*` packages.
