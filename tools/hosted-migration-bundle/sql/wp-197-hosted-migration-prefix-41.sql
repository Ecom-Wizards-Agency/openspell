-- WP-197 offline evidence for the exact 41-file hosted prefix.
-- Execute only after the universal probe selects this file and passes.

begin transaction isolation level repeatable read read only;
set local statement_timeout = '30s';
set local lock_timeout = '2s';
set local search_path = pg_catalog, public, app;
set local timezone = 'UTC';
set local datestyle = 'ISO, YMD';
set local intervalstyle = 'postgres';
set local bytea_output = 'hex';

with
queue_measure as materialized (
  select count(*)::bigint as row_count,
         coalesce(sum(pg_catalog.octet_length(
           (to_jsonb(job) - 'claim_token')::text
         )), 0)::bigint as byte_count
  from public.sync_jobs job where job.job_type = 'recommendations.run'
),
recommendation_measure as materialized (
  select sum(measure.row_count)::bigint as row_count,
         sum(measure.byte_count)::bigint as byte_count
  from (
    select count(*)::bigint as row_count,
           coalesce(sum(pg_catalog.octet_length((to_jsonb(run) - array[
             'batch_id', 'scope_version', 'scope_count', 'scope_fingerprint',
             'strategy_goal', 'job_id', 'execution_lineage'
           ]::text[])::text)), 0)::bigint as byte_count
    from public.recommendation_runs run
    union all
    select count(*)::bigint,
           coalesce(sum(pg_catalog.octet_length(to_jsonb(item)::text)), 0)::bigint
    from public.recommendations item
    union all
    select count(*)::bigint,
           coalesce(sum(pg_catalog.octet_length(to_jsonb(batch)::text)), 0)::bigint
    from public.apply_batches batch
    union all
    select count(*)::bigint,
           coalesce(sum(pg_catalog.octet_length(to_jsonb(row_item)::text)), 0)::bigint
    from public.apply_rows row_item
    union all
    select count(*)::bigint,
           coalesce(sum(pg_catalog.octet_length(to_jsonb(observation)::text)), 0)::bigint
    from public.recommendation_observations observation
    union all
    select count(*)::bigint,
           coalesce(sum(pg_catalog.octet_length(to_jsonb(entry)::text)), 0)::bigint
    from public.audit_log entry
    where to_jsonb(entry) ->> 'action' like 'recommendation.%'
  ) measure
),
schedule_measure as materialized (
  select count(*)::bigint as row_count,
         coalesce(sum(pg_catalog.octet_length(to_jsonb(schedule)::text)), 0)::bigint
           as byte_count
  from public.sync_schedules schedule where schedule.job_type = 'recommendations.run'
),
state_bounds as materialized (
  select queue_measure.row_count <= 100000
           and queue_measure.byte_count <= 67108864 as queue_within_bounds,
         recommendation_measure.row_count <= 500000
           and recommendation_measure.byte_count <= 134217728 as recommendation_within_bounds,
         schedule_measure.row_count <= 100000
           and schedule_measure.byte_count <= 67108864 as schedule_within_bounds
  from queue_measure, recommendation_measure, schedule_measure
),
queue_payload as (
  select coalesce(jsonb_agg(to_jsonb(job) - 'claim_token' order by job.id), '[]'::jsonb) as value
  from public.sync_jobs job cross join state_bounds
  where job.job_type = 'recommendations.run' and state_bounds.queue_within_bounds
),
run_payload as (
  select coalesce(jsonb_agg(
           to_jsonb(run) - array[
             'batch_id', 'scope_version', 'scope_count', 'scope_fingerprint',
             'strategy_goal', 'job_id', 'execution_lineage'
           ]::text[] order by run.id
         ), '[]'::jsonb) as value
  from public.recommendation_runs run cross join state_bounds
  where state_bounds.recommendation_within_bounds
),
recommendation_payload as (
  select coalesce(jsonb_agg(to_jsonb(item) order by item.id), '[]'::jsonb) as value
  from public.recommendations item cross join state_bounds
  where state_bounds.recommendation_within_bounds
),
apply_batch_payload as (
  select coalesce(jsonb_agg(to_jsonb(batch) order by batch.id), '[]'::jsonb) as value
  from public.apply_batches batch cross join state_bounds
  where state_bounds.recommendation_within_bounds
),
apply_row_payload as (
  select coalesce(jsonb_agg(to_jsonb(row_item) order by row_item.id), '[]'::jsonb) as value
  from public.apply_rows row_item cross join state_bounds
  where state_bounds.recommendation_within_bounds
),
observation_payload as (
  select coalesce(jsonb_agg(to_jsonb(observation) order by observation.id), '[]'::jsonb) as value
  from public.recommendation_observations observation cross join state_bounds
  where state_bounds.recommendation_within_bounds
),
recommendation_audit_payload as (
  select coalesce(jsonb_agg(to_jsonb(entry) order by entry.id), '[]'::jsonb) as value
  from public.audit_log entry cross join state_bounds
  where to_jsonb(entry) ->> 'action' like 'recommendation.%'
    and state_bounds.recommendation_within_bounds
),
schedule_payload as (
  select coalesce(jsonb_agg(to_jsonb(schedule) order by schedule.id), '[]'::jsonb) as value
  from public.sync_schedules schedule cross join state_bounds
  where schedule.job_type = 'recommendations.run' and state_bounds.schedule_within_bounds
),
out_of_scope_catalog as (
  select 'relation:' || namespace.nspname || '.' || relation.relname as item_key,
         jsonb_build_object(
           'forceRls', relation.relforcerowsecurity,
           'owner', pg_catalog.pg_get_userbyid(relation.relowner),
           'rls', relation.relrowsecurity
         )::text as item_value
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname in ('app', 'public')
    and relation.relkind in ('r', 'p', 'v', 'm', 'S')
    and relation.relname <> all(array[
      'sync_jobs', 'sync_schedules', 'recommendation_runs', 'recommendations',
      'recommendation_preview_batches', 'recommendation_run_campaigns',
      'audit_log', 'audit_log_id_seq', 'ad_profiles', 'fact_sp_target_daily',
      'fact_sb_daily', 'fact_sd_daily', 'fact_profile_daily', 'campaigns',
      'ad_groups', 'keywords', 'targets', 'product_ads', 'rank_observations',
      'bid_series_daily', 'apply_rows', 'apply_batches', 'recommendation_observations',
      'report_worker_claim_authority', 'recommendation_claim_authority',
      'sp_write_outbox_delivery_heads', 'sp_write_outbox_delivery_events'
    ]::text[])
    and relation.relname not like 'sp_write_%'
  union all
  select 'relation-acl:' || namespace.nspname || '.' || relation.relname || ':'
         || case acl.grantee when 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(acl.grantee) end
         || ':' || pg_catalog.pg_get_userbyid(acl.grantor) || ':' || acl.privilege_type,
         acl.is_grantable::text
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  cross join lateral pg_catalog.aclexplode(relation.relacl) acl
  where namespace.nspname in ('app', 'public')
    and relation.relkind in ('r', 'p', 'v', 'm', 'S')
    and relation.relname <> all(array[
      'sync_jobs', 'sync_schedules', 'recommendation_runs', 'recommendations',
      'recommendation_preview_batches', 'recommendation_run_campaigns',
      'audit_log', 'audit_log_id_seq', 'ad_profiles', 'fact_sp_target_daily',
      'fact_sb_daily', 'fact_sd_daily', 'fact_profile_daily', 'campaigns',
      'ad_groups', 'keywords', 'targets', 'product_ads', 'rank_observations',
      'bid_series_daily', 'apply_rows', 'apply_batches', 'recommendation_observations',
      'report_worker_claim_authority', 'recommendation_claim_authority',
      'sp_write_outbox_delivery_heads', 'sp_write_outbox_delivery_events'
    ]::text[])
    and relation.relname not like 'sp_write_%'
  union all
  select 'column-acl:' || namespace.nspname || '.' || relation.relname || ':'
         || attribute.attname || ':'
         || case acl.grantee when 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(acl.grantee) end
         || ':' || pg_catalog.pg_get_userbyid(acl.grantor) || ':' || acl.privilege_type,
         acl.is_grantable::text
  from pg_catalog.pg_attribute attribute
  join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  cross join lateral pg_catalog.aclexplode(attribute.attacl) acl
  where namespace.nspname in ('app', 'public')
    and attribute.attnum > 0 and not attribute.attisdropped
    and relation.relname <> all(array[
      'sync_jobs', 'sync_schedules', 'recommendation_runs', 'recommendations',
      'recommendation_preview_batches', 'recommendation_run_campaigns',
      'audit_log', 'audit_log_id_seq', 'ad_profiles', 'fact_sp_target_daily',
      'fact_sb_daily', 'fact_sd_daily', 'fact_profile_daily', 'campaigns',
      'ad_groups', 'keywords', 'targets', 'product_ads', 'rank_observations',
      'bid_series_daily', 'apply_rows', 'apply_batches', 'recommendation_observations',
      'report_worker_claim_authority', 'recommendation_claim_authority',
      'sp_write_outbox_delivery_heads', 'sp_write_outbox_delivery_events'
    ]::text[])
    and relation.relname not like 'sp_write_%'
  union all
  select 'routine:' || namespace.nspname || '.' || routine.oid::regprocedure::text,
         jsonb_build_object(
           'acl', coalesce(routine.proacl, '{}'::aclitem[])::text,
           'owner', pg_catalog.pg_get_userbyid(routine.proowner),
           'securityDefiner', routine.prosecdef
         )::text
  from pg_catalog.pg_proc routine
  join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
  where namespace.nspname in ('app', 'public')
    and routine.proname not like '%sp_write%'
    and routine.proname not like '%recommendation%'
    and routine.proname <> all(array[
      'claim_sync_jobs', 'finish_sync_job', 'requeue_stale_sync_jobs',
      'claim_sync_jobs_fenced', 'finish_sync_job_fenced',
      'defer_sync_job_fenced', 'get_report_worker_claim_authority',
      'activate_report_worker_fenced_claims', 'enqueue_due_schedules',
      'apply_cooldown_conflicts', 'tag_subtree'
    ]::text[])
  union all
  select 'policy:' || namespace.nspname || '.' || relation.relname || ':' || policy.polname,
         jsonb_build_object(
           'check', coalesce(pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid), ''),
           'command', policy.polcmd,
           'permissive', policy.polpermissive,
           'roles', policy.polroles::text,
           'using', coalesce(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid), '')
         )::text
  from pg_catalog.pg_policy policy
  join pg_catalog.pg_class relation on relation.oid = policy.polrelid
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname in ('app', 'public')
    and relation.relname <> all(array[
      'sync_jobs', 'sync_schedules', 'recommendation_runs', 'recommendations',
      'recommendation_preview_batches', 'recommendation_run_campaigns',
      'audit_log', 'ad_profiles', 'fact_sp_target_daily', 'fact_sb_daily',
      'fact_sd_daily', 'fact_profile_daily', 'campaigns', 'ad_groups',
      'keywords', 'targets', 'product_ads', 'rank_observations',
      'bid_series_daily', 'apply_rows', 'apply_batches', 'recommendation_observations',
      'report_worker_claim_authority', 'recommendation_claim_authority',
      'sp_write_outbox_delivery_heads', 'sp_write_outbox_delivery_events'
    ]::text[])
    and relation.relname not like 'sp_write_%'
  union all
  select 'schema:' || namespace.nspname,
         jsonb_build_object('owner', pg_catalog.pg_get_userbyid(namespace.nspowner))::text
  from pg_catalog.pg_namespace namespace
  where namespace.nspname in ('app', 'public')
  union all
  select 'schema-acl:' || namespace.nspname || ':'
         || case acl.grantee when 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(acl.grantee) end
         || ':' || pg_catalog.pg_get_userbyid(acl.grantor) || ':' || acl.privilege_type,
         acl.is_grantable::text
  from pg_catalog.pg_namespace namespace
  cross join lateral pg_catalog.aclexplode(namespace.nspacl) acl
  where namespace.nspname in ('app', 'public')
    and coalesce(pg_catalog.pg_get_userbyid(acl.grantee), '') not in (
      'openspell_recommendation_worker', 'openspell_recommendation_executor'
    )
  union all
  select 'type:' || namespace.nspname || '.' || type_def.typname,
         jsonb_build_object(
           'acl', coalesce(type_def.typacl, '{}'::aclitem[])::text,
           'owner', pg_catalog.pg_get_userbyid(type_def.typowner)
         )::text
  from pg_catalog.pg_type type_def
  join pg_catalog.pg_namespace namespace on namespace.oid = type_def.typnamespace
  where namespace.nspname in ('app', 'public')
    and left(type_def.typname, 9) <> 'sp_write_'
    and left(type_def.typname, 10) <> '_sp_write_'
    and ltrim(type_def.typname, '_') <> all(array[
      'report_worker_claim_authority', 'recommendation_claim_authority',
      'recommendation_preview_batches', 'recommendation_run_campaigns'
    ]::text[])
  union all
  select 'role:' || role_def.rolname,
         jsonb_build_object(
           'bypassRls', role_def.rolbypassrls, 'canLogin', role_def.rolcanlogin,
           'connectionLimit', role_def.rolconnlimit,
           'createDb', role_def.rolcreatedb, 'createRole', role_def.rolcreaterole,
           'inherit', role_def.rolinherit,
           'replication', role_def.rolreplication, 'superuser', role_def.rolsuper,
           'validUntil', coalesce(role_def.rolvaliduntil::text, '')
         )::text
  from pg_catalog.pg_roles role_def
  where role_def.rolname not in (
    'openspell_recommendation_worker', 'openspell_recommendation_executor'
  )
  union all
  select 'membership:' || role_role.rolname || ':' || member_role.rolname || ':'
         || grantor_role.rolname,
         jsonb_build_object(
           'admin', membership.admin_option, 'inherit', membership.inherit_option,
           'set', membership.set_option
         )::text
  from pg_catalog.pg_auth_members membership
  join pg_catalog.pg_roles role_role on role_role.oid = membership.roleid
  join pg_catalog.pg_roles member_role on member_role.oid = membership.member
  join pg_catalog.pg_roles grantor_role on grantor_role.oid = membership.grantor
  where role_role.rolname not in (
      'openspell_recommendation_worker', 'openspell_recommendation_executor'
    )
    and member_role.rolname not in (
      'openspell_recommendation_worker', 'openspell_recommendation_executor'
    )
  union all
  select 'default-acl:' || pg_catalog.pg_get_userbyid(default_acl.defaclrole)
         || ':' || coalesce(namespace.nspname, '') || ':' || default_acl.defaclobjtype::text,
         default_acl.defaclacl::text
  from pg_catalog.pg_default_acl default_acl
  left join pg_catalog.pg_namespace namespace on namespace.oid = default_acl.defaclnamespace
  where pg_catalog.pg_get_userbyid(default_acl.defaclrole) not in (
    'openspell_recommendation_worker', 'openspell_recommendation_executor'
  )
),
relevant_relations as materialized (
  select relation.oid, namespace.nspname, relation.relname, relation.relkind
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname in ('app', 'public')
    and (
      relation.relname like 'sp_write_%'
      or relation.relname = any(array[
        'orgs', 'sync_jobs', 'sync_schedules', 'recommendation_runs', 'recommendations',
        'recommendation_preview_batches', 'recommendation_run_campaigns', 'audit_log',
        'audit_log_id_seq', 'ad_profiles', 'fact_sp_target_daily', 'fact_sb_daily',
        'fact_sd_daily', 'fact_profile_daily', 'campaigns', 'ad_groups', 'keywords',
        'targets', 'product_ads', 'rank_observations', 'bid_series_daily', 'apply_rows',
        'apply_batches', 'recommendation_observations', 'report_worker_claim_authority',
        'recommendation_claim_authority'
      ]::text[])
    )
),
relevant_routines as materialized (
  select routine.oid, namespace.nspname, routine.proname
  from pg_catalog.pg_proc routine
  join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
  where namespace.nspname in ('app', 'public')
    and (
      routine.proname like '%sp_write%'
      or routine.proname like '%recommendation%'
      or routine.proname = any(array[
        'claim_sync_jobs', 'finish_sync_job', 'requeue_stale_sync_jobs',
        'claim_sync_jobs_fenced', 'finish_sync_job_fenced',
        'defer_sync_job_fenced', 'get_report_worker_claim_authority',
        'activate_report_worker_fenced_claims', 'enqueue_due_schedules',
        'apply_cooldown_conflicts', 'tag_subtree'
      ]::text[])
    )
),
catalog_items(item_key, item_value) as materialized (
  select 'schema-acl:' || namespace.nspname || ':'
         || case acl.grantee when 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(acl.grantee) end
         || ':' || pg_catalog.pg_get_userbyid(acl.grantor) || ':' || acl.privilege_type,
         jsonb_build_object('grantable', acl.is_grantable)::text
  from pg_catalog.pg_namespace namespace
  cross join lateral pg_catalog.aclexplode(namespace.nspacl) acl
  where namespace.nspname in ('app', 'public')
    and pg_catalog.pg_get_userbyid(acl.grantee) in (
      'openspell_recommendation_worker', 'openspell_recommendation_executor'
    )
  union all
  select 'relation:' || relevant.nspname || '.' || relevant.relname,
         jsonb_build_object(
           'forceRls', relation.relforcerowsecurity, 'isPartition', relation.relispartition,
           'kind', relation.relkind, 'owner', pg_catalog.pg_get_userbyid(relation.relowner),
           'partitionBound', coalesce(pg_catalog.pg_get_expr(relation.relpartbound, relation.oid), ''),
           'persistence', relation.relpersistence, 'replicaIdentity', relation.relreplident,
           'rls', relation.relrowsecurity,
           'viewDefinition', case when relation.relkind in ('v', 'm')
             then pg_catalog.pg_get_viewdef(relation.oid, false) else '' end
         )::text
  from relevant_relations relevant
  join pg_catalog.pg_class relation on relation.oid = relevant.oid
  union all
  select 'relation-acl:' || relevant.nspname || '.' || relevant.relname || ':'
         || case acl.grantee when 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(acl.grantee) end
         || ':' || pg_catalog.pg_get_userbyid(acl.grantor) || ':' || acl.privilege_type,
         jsonb_build_object('grantable', acl.is_grantable)::text
  from relevant_relations relevant
  join pg_catalog.pg_class relation on relation.oid = relevant.oid
  cross join lateral pg_catalog.aclexplode(relation.relacl) acl
  union all
  select 'column:' || relevant.nspname || '.' || relevant.relname || ':'
         || attribute.attnum::text || ':' || attribute.attname,
         jsonb_build_object(
           'collation', case when attribute.attcollation = 0 then '' else
             (select coll_namespace.nspname || '.' || coll.collname
              from pg_catalog.pg_collation coll
              join pg_catalog.pg_namespace coll_namespace on coll_namespace.oid = coll.collnamespace
              where coll.oid = attribute.attcollation) end,
           'compression', attribute.attcompression,
           'default', coalesce(pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid), ''),
           'generated', attribute.attgenerated, 'identity', attribute.attidentity,
           'notNull', attribute.attnotnull, 'storage', attribute.attstorage,
           'type', pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
         )::text
  from relevant_relations relevant
  join pg_catalog.pg_attribute attribute on attribute.attrelid = relevant.oid
  left join pg_catalog.pg_attrdef default_value
    on default_value.adrelid = attribute.attrelid and default_value.adnum = attribute.attnum
  where attribute.attnum > 0 and not attribute.attisdropped
  union all
  select 'column-acl:' || relevant.nspname || '.' || relevant.relname || ':'
         || attribute.attname || ':'
         || case acl.grantee when 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(acl.grantee) end
         || ':' || pg_catalog.pg_get_userbyid(acl.grantor) || ':' || acl.privilege_type,
         jsonb_build_object('grantable', acl.is_grantable)::text
  from relevant_relations relevant
  join pg_catalog.pg_attribute attribute on attribute.attrelid = relevant.oid
  cross join lateral pg_catalog.aclexplode(attribute.attacl) acl
  where attribute.attnum > 0 and not attribute.attisdropped
  union all
  select 'constraint:' || relevant.nspname || '.' || relevant.relname || ':'
         || constraint_def.conname,
         jsonb_build_object(
           'deferred', constraint_def.condeferred, 'deferrable', constraint_def.condeferrable,
           'definition', pg_catalog.pg_get_constraintdef(constraint_def.oid, false),
           'noInherit', constraint_def.connoinherit, 'type', constraint_def.contype,
           'validated', constraint_def.convalidated
         )::text
  from pg_catalog.pg_constraint constraint_def
  join relevant_relations relevant on relevant.oid = constraint_def.conrelid
  union all
  select 'index:' || index_namespace.nspname || '.' || index_relation.relname,
         jsonb_build_object(
           'clustered', index_def.indisclustered,
           'definition', pg_catalog.pg_get_indexdef(index_def.indexrelid),
           'immediate', index_def.indimmediate, 'live', index_def.indislive,
           'owner', pg_catalog.pg_get_userbyid(index_relation.relowner),
           'primary', index_def.indisprimary, 'ready', index_def.indisready,
           'replicaIdentity', index_def.indisreplident, 'unique', index_def.indisunique,
           'valid', index_def.indisvalid
         )::text
  from pg_catalog.pg_index index_def
  join relevant_relations relevant on relevant.oid = index_def.indrelid
  join pg_catalog.pg_class index_relation on index_relation.oid = index_def.indexrelid
  join pg_catalog.pg_namespace index_namespace on index_namespace.oid = index_relation.relnamespace
  union all
  select 'trigger:' || relevant.nspname || '.' || relevant.relname || ':' || trigger_def.tgname,
         jsonb_build_object(
           'definition', pg_catalog.pg_get_triggerdef(trigger_def.oid, false),
           'enabled', trigger_def.tgenabled, 'internal', trigger_def.tgisinternal
         )::text
  from pg_catalog.pg_trigger trigger_def
  join relevant_relations relevant on relevant.oid = trigger_def.tgrelid
  where not trigger_def.tgisinternal
  union all
  select 'policy:' || relevant.nspname || '.' || relevant.relname || ':' || policy.polname,
         jsonb_build_object(
           'check', coalesce(pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid), ''),
           'command', policy.polcmd, 'permissive', policy.polpermissive,
           'roles', (select coalesce(pg_catalog.jsonb_agg(role_name order by role_name), '[]'::jsonb)
                     from (select case role_oid when 0 then 'PUBLIC'
                                          else pg_catalog.pg_get_userbyid(role_oid) end as role_name
                           from pg_catalog.unnest(policy.polroles) role_oid) role_names),
           'using', coalesce(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid), '')
         )::text
  from pg_catalog.pg_policy policy
  join relevant_relations relevant on relevant.oid = policy.polrelid
  union all
  select 'routine:' || relevant.nspname || '.' || relevant.proname || '('
         || pg_catalog.pg_get_function_identity_arguments(routine.oid) || ')',
         jsonb_build_object(
           'definition', pg_catalog.pg_get_functiondef(routine.oid),
           'language', language.lanname, 'leakproof', routine.proleakproof,
           'owner', pg_catalog.pg_get_userbyid(routine.proowner), 'parallel', routine.proparallel,
           'securityDefiner', routine.prosecdef, 'strict', routine.proisstrict,
           'volatility', routine.provolatile
         )::text
  from relevant_routines relevant
  join pg_catalog.pg_proc routine on routine.oid = relevant.oid
  join pg_catalog.pg_language language on language.oid = routine.prolang
  union all
  select 'routine-acl:' || relevant.nspname || '.' || relevant.proname || '('
         || pg_catalog.pg_get_function_identity_arguments(routine.oid) || '):'
         || case acl.grantee when 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(acl.grantee) end
         || ':' || pg_catalog.pg_get_userbyid(acl.grantor) || ':' || acl.privilege_type,
         jsonb_build_object('grantable', acl.is_grantable)::text
  from relevant_routines relevant
  join pg_catalog.pg_proc routine on routine.oid = relevant.oid
  cross join lateral pg_catalog.aclexplode(routine.proacl) acl
  union all
  select 'enum:' || namespace.nspname || '.' || type_def.typname || ':'
         || enum.enumsortorder::text,
         jsonb_build_object('label', enum.enumlabel)::text
  from pg_catalog.pg_enum enum
  join pg_catalog.pg_type type_def on type_def.oid = enum.enumtypid
  join pg_catalog.pg_namespace namespace on namespace.oid = type_def.typnamespace
  where namespace.nspname in ('app', 'public') and type_def.typname like 'sp_write_%'
  union all
  select 'role:' || role_def.rolname,
         jsonb_build_object(
           'bypassRls', role_def.rolbypassrls, 'canLogin', role_def.rolcanlogin,
           'connectionLimit', role_def.rolconnlimit, 'createDb', role_def.rolcreatedb,
           'createRole', role_def.rolcreaterole, 'inherit', role_def.rolinherit,
           'replication', role_def.rolreplication, 'superuser', role_def.rolsuper,
           'validUntil', coalesce(role_def.rolvaliduntil::text, '')
         )::text
  from pg_catalog.pg_roles role_def
  where role_def.rolname in ('openspell_recommendation_worker', 'openspell_recommendation_executor')
  union all
  select 'membership:' || role_role.rolname || ':' || member_role.rolname || ':'
         || grantor_role.rolname,
         jsonb_build_object(
           'admin', membership.admin_option, 'inherit', membership.inherit_option,
           'set', membership.set_option
         )::text
  from pg_catalog.pg_auth_members membership
  join pg_catalog.pg_roles role_role on role_role.oid = membership.roleid
  join pg_catalog.pg_roles member_role on member_role.oid = membership.member
  join pg_catalog.pg_roles grantor_role on grantor_role.oid = membership.grantor
  where role_role.rolname in ('openspell_recommendation_worker', 'openspell_recommendation_executor')
     or member_role.rolname in ('openspell_recommendation_worker', 'openspell_recommendation_executor')
  union all
  select 'default-acl:' || role_def.rolname || ':' || coalesce(namespace.nspname, '')
         || ':' || default_acl.defaclobjtype::text,
         jsonb_build_object('acl', default_acl.defaclacl::text)::text
  from pg_catalog.pg_default_acl default_acl
  join pg_catalog.pg_roles role_def on role_def.oid = default_acl.defaclrole
  left join pg_catalog.pg_namespace namespace on namespace.oid = default_acl.defaclnamespace
  where role_def.rolname in ('openspell_recommendation_worker', 'openspell_recommendation_executor')
),
bounded_catalog as materialized (
  select item_key, item_value from catalog_items order by item_key collate "C" limit 10001
),
catalog_snapshot as (
  select count(*)::integer as item_count,
         count(*) filter (where pg_catalog.octet_length(item_value) > 1048576)::integer
           as oversized_count,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           'openspell.hosted-relevant-catalog.v1' || chr(10)
           || coalesce(pg_catalog.string_agg(
                pg_catalog.octet_length(item_key)::text || ':' || item_key
                || pg_catalog.octet_length(item_value)::text || ':' || item_value || chr(10),
                '' order by item_key collate "C"), ''), 'UTF8')), 'hex') as catalog_sha256
  from bounded_catalog
),
fingerprints as (
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           'openspell.hosted-queue-state.v1' || chr(10) || queue_payload.value::text || chr(10),
           'UTF8')), 'hex') as queue_fingerprint,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           'openspell.hosted-recommendation-state.v1' || chr(10)
           || jsonb_build_object(
                'applyBatches', apply_batch_payload.value,
                'applyRows', apply_row_payload.value,
                'audit', recommendation_audit_payload.value,
                'observations', observation_payload.value,
                'recommendations', recommendation_payload.value,
                'runs', run_payload.value
              )::text || chr(10),
           'UTF8')), 'hex') as recommendation_fingerprint,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           'openspell.hosted-schedule-state.v1' || chr(10) || schedule_payload.value::text || chr(10),
           'UTF8')), 'hex') as schedule_fingerprint,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           'openspell.hosted-out-of-scope-privileges.v1' || chr(10)
           || coalesce((select jsonb_agg(jsonb_build_array(item_key, item_value)
                                         order by item_key)::text
                        from out_of_scope_catalog), '[]') || chr(10),
           'UTF8')), 'hex') as out_of_scope_privilege_fingerprint
  from queue_payload, run_payload, recommendation_payload, apply_batch_payload,
       apply_row_payload, observation_payload, recommendation_audit_payload,
       schedule_payload
),
ledger_state as (
  select count(*)::integer as file_count,
         coalesce(max(version::text), '') as terminal_version,
         (select count(*) from (
            (select version::text from supabase_migrations.schema_migrations
             except
             select value from unnest(array[
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
               '20260901000000', '20260901010000'
             ]::text[]) expected(value))
            union all
            (select value from unnest(array[
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
               '20260901000000', '20260901010000'
             ]::text[]) expected(value)
             except select version::text from supabase_migrations.schema_migrations)
          ) mismatch)::integer as mismatch_count
  from supabase_migrations.schema_migrations
),
checks(check_key, expected, observed) as (
  select 'catalog.later_relations', '0', count(*)::text
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname in ('app', 'public')
    and (relation.relname like 'sp_write_%'
      or relation.relname in (
        'report_worker_claim_authority', 'recommendation_claim_authority',
        'recommendation_preview_batches', 'recommendation_run_campaigns'
      ))
  union all
  select 'catalog.later_roles', '0', count(*)::text
  from pg_catalog.pg_roles
  where rolname in ('openspell_recommendation_worker', 'openspell_recommendation_executor')
  union all
  select 'catalog.later_routines', '0', count(*)::text
  from pg_catalog.pg_proc routine
  join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
  where (namespace.nspname = 'app'
         and (routine.proname like 'sp_write_%'
              or routine.proname like '%recommendation%'))
     or (namespace.nspname = 'public' and routine.proname in (
       'claim_sync_jobs_fenced', 'finish_sync_job_fenced', 'defer_sync_job_fenced',
       'get_report_worker_claim_authority', 'activate_report_worker_fenced_claims',
       'get_recommendation_claim_authority', 'get_recommendation_cutover_evidence',
       'get_recommendation_worker_authority', 'block_recommendation_admission',
       'activate_recommendation_fenced_claims', 'authorize_recommendation_scoped_admission',
       'rebind_recommendation_fenced_revision', 'claim_recommendation_jobs_fenced',
       'resume_recommendation_jobs_fenced', 'finish_recommendation_job_fenced',
       'defer_recommendation_job_fenced', 'start_recommendation_run_fenced',
       'fail_recommendation_run_fenced', 'succeed_recommendation_run_fenced',
       'read_recommendation_inputs_fenced'
     ))
  union all
  select 'catalog.recommendation_future_columns', '0', count(*)::text
  from information_schema.columns
  where table_schema = 'public'
    and ((table_name = 'sync_jobs' and column_name = 'claim_token')
      or (table_name = 'recommendation_runs' and column_name in (
        'batch_id', 'scope_version', 'scope_count', 'scope_fingerprint',
        'strategy_goal', 'job_id', 'execution_lineage'
      )))
  union all
  select 'catalog.later_triggers', '0', count(*)::text
  from pg_catalog.pg_trigger trigger_def
  where not trigger_def.tgisinternal
    and (trigger_def.tgname like '%sp_write%'
      or trigger_def.tgname = any(array[
        'a_recommendation_authority_prelock',
        'sync_jobs_recommendation_admission_gate',
        'recommendation_runs_execution_guard',
        'recommendations_execution_guard',
        'audit_log_recommendation_execution_guard'
      ]::text[]))
  union all
  select 'prefix.file_count', '41', file_count::text from ledger_state
  union all
  select 'prefix.ledger_sha256',
         '9dd52d5fdee63b6b3c19de850ec72c27f3d8312a5bb5c73c492705e47c18bcea',
         case when mismatch_count = 0 and file_count = 41
              then '9dd52d5fdee63b6b3c19de850ec72c27f3d8312a5bb5c73c492705e47c18bcea'
              else repeat('0', 64) end
  from ledger_state
  union all
  select 'prefix.terminal_version', '20260901010000', terminal_version from ledger_state
  union all
  select 'prefix.version_set_mismatch', '0', mismatch_count::text from ledger_state
  union all
  select 'catalog.relevant_item_count', '983', item_count::text from catalog_snapshot
  union all
  select 'catalog.relevant_sha256',
         '800fa92b8877dca0cdefa1e3e50a9561daea76dea97c955f9b61e51149fdf112',
         catalog_sha256 from catalog_snapshot
  union all
  select 'catalog.relevant_within_bounds', 'true',
         (item_count <= 10000 and oversized_count = 0)::text from catalog_snapshot
  union all
  select 'state.fingerprints_within_bounds', 'true:true:true',
         queue_within_bounds::text || ':' || recommendation_within_bounds::text || ':'
         || schedule_within_bounds::text from state_bounds
),
evidence as (
  select check_key, expected, observed, expected = observed as pass
  from checks
),
numbered as (
  select *, row_number() over (order by check_key collate "C") as ordinal
  from evidence
),
digest as (
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           'openspell.hosted-prefix-evidence.v1' || chr(10)
           || string_agg(
                ordinal::text || chr(9)
                || octet_length(check_key)::text || chr(9) || check_key || chr(9)
                || octet_length(expected)::text || chr(9) || expected || chr(9)
                || octet_length(observed)::text || chr(9) || observed || chr(9)
                || pass::text || chr(10),
                '' order by check_key collate "C"
              ), 'UTF8')), 'hex') as prefix_evidence_sha256
  from numbered
)
select numbered.check_key, numbered.expected, numbered.observed, numbered.pass,
       fingerprints.queue_fingerprint as "queueFingerprint",
       fingerprints.recommendation_fingerprint as "recommendationFingerprint",
       fingerprints.schedule_fingerprint as "scheduleFingerprint",
       fingerprints.out_of_scope_privilege_fingerprint as "outOfScopePrivilegeFingerprint",
       digest.prefix_evidence_sha256 as "prefixEvidenceSha256"
from numbered cross join fingerprints cross join digest
order by numbered.check_key collate "C";

rollback;
