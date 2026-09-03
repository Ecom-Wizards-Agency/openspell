-- WP-197 offline universal hosted-migration prefix probe.
--
-- This script is inert: it accepts no parameters, returns bounded catalog and
-- aggregate migration-activity evidence, and rolls back its transaction.  An
-- unguarded passing run is review evidence only; a future private runner must
-- use the guarded probe/prefix/probe contract before any action authorization.

begin transaction isolation level repeatable read read only;
set local statement_timeout = '30s';
set local lock_timeout = '2s';
set local search_path = pg_catalog, public, app;
set local timezone = 'UTC';
set local datestyle = 'ISO, YMD';
set local intervalstyle = 'postgres';
set local bytea_output = 'hex';

with
expected_versions(version, ordinal) as (
  select value, ordinality::integer
  from unnest(array[
    '20260813183448', '20260813183526', '20260813183557',
    '20260813183644', '20260813183720', '20260813183827',
    '20260813183855', '20260813183930', '20260813183958',
    '20260813184020', '20260814011921', '20260814012040',
    '20260814012320', '20260814035854', '20260814051941',
    '20260814055804', '20260814080742', '20260814092051',
    '20260814150715', '20260814172712', '20260814182546',
    '20260827070831', '20260827071956', '20260827082124',
    '20260827082140', '20260827082158', '20260827082430',
    '20260827085603', '20260827085807', '20260827094639',
    '20260829120000', '20260829130000', '20260829140000',
    '20260829150000', '20260829160000', '20260829160100',
    '20260830170000', '20260830180000', '20260831100000',
    '20260901000000', '20260901010000', '20260901020000',
    '20260901030000', '20260901040000', '20260901050000',
    '20260901060000'
  ]::text[]) with ordinality as listed(value, ordinality)
),
actual as (
  select version::text,
         row_number() over (order by version::text)::integer as ordinal
  from supabase_migrations.schema_migrations
),
summary as (
  select count(*)::integer as file_count,
         coalesce(max(version), '') as terminal_version,
         coalesce(array_agg(version order by ordinal), array[]::text[]) as versions
  from actual
),
classification as (
  select summary.*,
         case
           when versions = (select array_agg(version order by ordinal)
                             from expected_versions where ordinal <= 41) then 41
           when versions = (select array_agg(version order by ordinal)
                             from expected_versions where ordinal <= 42) then 42
           when versions = (select array_agg(version order by ordinal)
                             from expected_versions where ordinal <= 43) then 43
           when versions = (select array_agg(version order by ordinal)
                             from expected_versions where ordinal <= 44) then 44
           when versions = (select array_agg(version order by ordinal)
                             from expected_versions where ordinal <= 45) then 45
           when versions = (select array_agg(version order by ordinal)
                             from expected_versions where ordinal <= 46) then 46
           else 0
         end as prefix_files
  from summary
),
catalog_pattern as (
  select
    (to_regclass('public.sp_write_environment_gate_versions') is not null) as has_wp187,
    (to_regclass('app.sp_write_outbox_delivery_heads') is not null) as has_wp192,
    (to_regclass('app.report_worker_claim_authority') is not null) as has_wp194,
    (to_regclass('public.recommendation_preview_batches') is not null) as has_wp195,
    (to_regclass('app.recommendation_claim_authority') is not null) as has_wp196
),
ddl_activity as (
  select count(*) filter (where locks.granted)::integer as holder_count,
         count(*) filter (where not locks.granted)::integer as waiter_count
  from pg_catalog.pg_locks locks
  cross join lateral (
    select pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0) as lock_key
  ) expected
  where locks.locktype = 'advisory'
    and locks.database = (select oid from pg_catalog.pg_database
                           where datname = current_database())
    and locks.classid = (((expected.lock_key >> 32) & 4294967295)::bigint)::oid
    and locks.objid = ((expected.lock_key & 4294967295)::bigint)::oid
    and locks.pid is distinct from pg_catalog.pg_backend_pid()
),
guarded_cli_activity as (
  select count(*)::integer as session_count,
         count(*) filter (where activity.state is distinct from 'idle')::integer
           as active_count,
         count(*) filter (where activity.wait_event_type = 'Lock')::integer
           as waiting_count
  from pg_catalog.pg_stat_activity activity
  where activity.datid = (
      select database_def.oid
      from pg_catalog.pg_database database_def
      where database_def.datname = pg_catalog.current_database()
    )
    and activity.pid <> pg_catalog.pg_backend_pid()
    and activity.application_name like 'os-wp197-cli-%'
),
observed as (
  select classification.file_count,
         classification.terminal_version,
         classification.prefix_files,
         case classification.prefix_files
           when 41 then '9dd52d5fdee63b6b3c19de850ec72c27f3d8312a5bb5c73c492705e47c18bcea'
           when 42 then '82fa9aea16b9d44a4b0bc82111a5ab960246a9c9a970fa86182b8aa36632413e'
           when 43 then 'd1359b1fd9dfa5b1ed8c6669df8323a35b4684fbbb3d7a0fc739488aee1d9530'
           when 44 then '0e408d86b6fad5713e459b4369bbf5a6c39a3174c4ea6845bfb1ca262de647b1'
           when 45 then 'ac7e960282c6f7d999656eb0f0a87ca84deef772b5c9fa974cd75b7893a44a5b'
           when 46 then 'baef4df400ed7a045395322667e1d3ac61fa27075b2d36bb855071a6bfe20458'
           else ''
         end as prefix_ledger_sha256,
         case classification.prefix_files
           when 41 then not has_wp187 and not has_wp192 and not has_wp194
                        and not has_wp195 and not has_wp196
           when 42 then has_wp187 and not has_wp192 and not has_wp194
                        and not has_wp195 and not has_wp196
           when 43 then has_wp187 and has_wp192 and not has_wp194
                        and not has_wp195 and not has_wp196
           when 44 then has_wp187 and has_wp192 and has_wp194
                        and not has_wp195 and not has_wp196
           when 45 then has_wp187 and has_wp192 and has_wp194
                        and has_wp195 and not has_wp196
           when 46 then has_wp187 and has_wp192 and has_wp194
                        and has_wp195 and has_wp196
           else false
         end as catalog_pattern_pass,
         ddl_activity.holder_count,
         ddl_activity.waiter_count,
         guarded_cli_activity.session_count,
         guarded_cli_activity.active_count,
         guarded_cli_activity.waiting_count
  from classification
  cross join catalog_pattern
  cross join ddl_activity
  cross join guarded_cli_activity
)
select file_count as "observedPrefixFiles",
       terminal_version as "observedTerminalVersion",
       prefix_ledger_sha256 as "observedPrefixLedgerSha256",
       case prefix_files
         when 41 then 'wp-197-hosted-migration-prefix-41.sql'
         when 42 then 'wp-197-hosted-migration-prefix-42.sql'
         when 43 then 'wp-197-hosted-migration-prefix-43.sql'
         when 44 then 'wp-197-hosted-migration-prefix-44.sql'
         when 45 then 'wp-197-hosted-migration-prefix-45.sql'
         when 46 then 'wp-197-hosted-migration-prefix-46.sql'
         else ''
       end as "selectedEvidenceScript",
       catalog_pattern_pass as "catalogPatternPass",
       holder_count as "schemaDdlLockHolderCount",
       waiter_count as "schemaDdlLockWaiterCount",
       session_count as "guardedCliSessionCount",
       active_count as "guardedCliActiveCount",
       waiting_count as "guardedCliWaitingCount",
       (prefix_files between 41 and 46
        and catalog_pattern_pass
        and holder_count = 0
        and waiter_count = 0
        and session_count = 0
        and active_count = 0
        and waiting_count = 0) as pass
from observed;

rollback;
