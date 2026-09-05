-- WP-207 attended hosted migration window: read-only preflight and postflight checks.
--
-- Companion to docs/deploy/hosted-migration-attended-window.md. Every section opens
-- its own read-only transaction and rolls back. Static SQL only: no target, project
-- reference, credential, identifier or expected fingerprint is embedded here, and
-- nothing in this file mutates state. Each query returns aggregates or catalog facts.
--
-- Run one section at a time, in the order the runbook names. Record every number.
-- The WP-197 probe and prefix scripts under tools/hosted-migration-bundle/sql/ are
-- separate files and are run before and after this file's sections as the runbook
-- describes.
--
-- Rehearsed on a disposable plain-PostgreSQL 17 database with the shim in
-- supabase/tests/supabase-platform-shim.sql; the expected shapes recorded in the
-- runbook come from that rehearsal.

-- ============================================================================
-- SECTION: preflight
-- Valid on the 41-version ledger (and on any 41..46 prefix while classifying a
-- failure). Nothing here references an object created by the five window files.
-- ============================================================================

begin transaction isolation level repeatable read read only;
set local statement_timeout = '30s';
set local lock_timeout = '2s';
set local search_path = pg_catalog, public, app;
set local timezone = 'UTC';

-- PRE-1  Ledger summary. Expect 41 rows and terminal version 20260901010000.
select count(*)::integer as ledger_rows,
       coalesce(max(version::text), '') as terminal_version
  from supabase_migrations.schema_migrations;

-- PRE-2  Recommendations with no matching run under the tenant-qualified key.
--        20260901060000 adds recommendations_tenant_run_fkey and validates existing
--        rows, so any orphan fails the apply. Expect 0.
select count(*)::bigint as orphan_recommendations
  from public.recommendations item
 where not exists (
   select 1
     from public.recommendation_runs run
    where run.org_id = item.org_id
      and run.profile_id = item.profile_id
      and run.id = item.run_id
 );

-- PRE-3  recommendations.run jobs still queued or running. The freeze should have
--        emptied both. Expect 0 and 0; a nonzero running count means a claimant
--        is still active and the window has not been quiesced.
select count(*) filter (where status = 'queued')::integer as recommendation_jobs_queued,
       count(*) filter (where status = 'running')::integer as recommendation_jobs_running
  from public.sync_jobs
 where job_type = 'recommendations.run';

-- PRE-4  Every running claim, any job type, with the age of the oldest. Judge
--        quiescence by this row, not by a poll interval: report jobs legitimately
--        run longer than one tick. Expect 0 running claims before apply.
select count(*)::integer as running_claims,
       coalesce(max(extract(epoch from now() - claimed_at))::integer, 0) as oldest_running_seconds,
       coalesce(string_agg(distinct job_type::text, ',' order by job_type::text), '') as running_job_types
  from public.sync_jobs
 where status = 'running';

-- PRE-5  Migration principal. 20260901060000 creates two cluster-wide roles, so the
--        applying role needs CREATEROLE. Expect rolcreaterole = true. (A plain
--        superuser also passes; hosted principals are not superusers.)
select rolname as principal,
       rolcreaterole,
       rolsuper
  from pg_catalog.pg_roles
 where rolname = current_user;

-- PRE-6  Blocking: sessions waiting on another session, and ungranted locks. Expect 0 and 0.
select (select count(*)::integer
          from pg_catalog.pg_stat_activity activity
         where activity.datname = current_database()
           and activity.pid <> pg_backend_pid()
           and cardinality(pg_blocking_pids(activity.pid)) > 0) as blocked_sessions,
       (select count(*)::integer
          from pg_catalog.pg_locks locks
         where not locks.granted) as ungranted_locks;

-- PRE-7  Idle-in-transaction sessions on this database. A schema-capable path that is
--        idle inside a transaction can hold a lock the migration's five-second
--        lock_timeout will hit. Expect 0.
select count(*)::integer as idle_in_transaction_sessions
  from pg_catalog.pg_stat_activity activity
 where activity.datname = current_database()
   and activity.pid <> pg_backend_pid()
   and activity.state in ('idle in transaction', 'idle in transaction (aborted)');

-- PRE-8  Who is connected, by application name and state. Aggregates only; used to
--        confirm the legacy worker, any pilot worker and the Vercel cron have gone
--        quiet. Expect only this session's own tooling once the window is quiesced.
select coalesce(application_name, '') as application_name,
       coalesce(state, '') as state,
       count(*)::integer as sessions
  from pg_catalog.pg_stat_activity activity
 where activity.datname = current_database()
   and activity.pid <> pg_backend_pid()
   and activity.backend_type = 'client backend'
 group by 1, 2
 order by 1, 2;

-- PRE-9  Every pg_cron job, recorded as a complete row. This is the state to restore
--        in postflight. `to_jsonb` keeps the record shape-agnostic across pg_cron
--        versions (hosted rows also carry nodename, nodeport, database, username).
select jobid,
       to_jsonb(job) - 'jobid' as recorded_state
  from cron.job job
 order by jobid;

-- PRE-10 The two producer jobs to pause, identified by command fingerprint rather
--        than by job id. Both write public.sync_jobs, which 20260901040000 alters
--        under ACCESS EXCLUSIVE and 20260901060000 wraps in statement triggers.
--        Expect exactly two rows with active = true before the pause.
select jobid,
       jobname,
       schedule,
       command,
       active
  from cron.job
 where command ~ 'public\.(enqueue_due_schedules|requeue_stale_sync_jobs)\('
 order by command;

rollback;

-- ============================================================================
-- SECTION: postflight-46
-- Valid only once the ledger holds all 46 versions. Run after the WP-197 probe,
-- prefix-46 and second probe have passed. Every function referenced below is
-- created by the window files, so this section errors on any shorter prefix.
-- ============================================================================

begin transaction isolation level repeatable read read only;
set local statement_timeout = '30s';
set local lock_timeout = '2s';
set local search_path = pg_catalog, public, app;
set local timezone = 'UTC';

-- POST-1 Ledger: 46 rows, terminal 20260901060000, and the five window versions present.
select count(*)::integer as ledger_rows,
       coalesce(max(version::text), '') as terminal_version,
       count(*) filter (where version::text in (
         '20260901020000', '20260901030000', '20260901040000',
         '20260901050000', '20260901060000'
       ))::integer as window_versions_present
  from supabase_migrations.schema_migrations;

-- POST-2 Report-lane authority stays legacy at epoch 0. Applying 040000 must not
--        activate fenced claims.
select protocol, epoch
  from public.get_report_worker_claim_authority();

-- POST-3 Recommendation authority stays legacy/legacy. Applying 060000 must not
--        block or scope admission.
select *
  from public.get_recommendation_claim_authority();

-- POST-4 The two WP-196 roles exist with no login and no privilege attribute.
select rolname,
       rolcanlogin,
       rolinherit,
       rolsuper,
       rolcreatedb,
       rolcreaterole,
       rolreplication,
       rolbypassrls
  from pg_catalog.pg_roles
 where rolname in ('openspell_recommendation_worker', 'openspell_recommendation_executor')
 order by rolname;

-- POST-5 No queue row carries a claim token, and no claim is running. Expect 0 and 0.
select count(*) filter (where claim_token is not null)::integer as token_bearing_rows,
       count(*) filter (where status = 'running')::integer as running_claims
  from public.sync_jobs;

-- POST-6 The two new foreign keys exist and are validated. Expect two rows, both true.
select conname,
       convalidated
  from pg_catalog.pg_constraint
 where conname in ('recommendation_runs_job_fkey', 'recommendations_tenant_run_fkey')
 order by conname;

-- POST-7 The WP-196 execution-guard triggers are installed: four prelock triggers
--        (sync_jobs, recommendation_runs, recommendations, audit_log) plus the
--        admission gate and three execution guards. Expect 8.
select count(*)::integer as recommendation_guard_triggers
  from pg_catalog.pg_trigger trigger_def
 where not trigger_def.tgisinternal
   and trigger_def.tgname in (
     'a_recommendation_authority_prelock',
     'sync_jobs_recommendation_admission_gate',
     'recommendation_runs_execution_guard',
     'recommendations_execution_guard',
     'audit_log_recommendation_execution_guard'
   );

-- POST-8 pg_cron state after restoration. Compare row for row with PRE-9; the only
--        permitted difference is that the two paused producer jobs are active again.
select jobid,
       to_jsonb(job) - 'jobid' as recorded_state
  from cron.job job
 order by jobid;

rollback;
