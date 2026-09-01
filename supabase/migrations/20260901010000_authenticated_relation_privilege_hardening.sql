-- WP-186: normalize hosted Supabase relation privileges to the RLS policy contract.
--
-- Supabase grants broad table and sequence privileges to API roles through
-- creator-specific defaults. A later GRANT SELECT is additive, so it does not
-- remove inherited TRUNCATE, REFERENCES, TRIGGER, MAINTAIN or sequence-rewrite
-- authority. RLS governs row commands only. This forward migration closes the
-- `postgres` defaults used by repository migrations and normalizes current
-- relations without changing the separately-owned `supabase_admin` baseline,
-- a policy, row, service-role grant or preview-role grant.

set local lock_timeout = '5s';

-- Serialize every cooperating repository migration. This is defense in depth,
-- not a substitute for the attended exclusive-DDL window: PostgreSQL cannot
-- reveal an already-created object in another uncommitted transaction.
select pg_advisory_xact_lock(
  pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0)
);

-- Abort before changing an ACL if the hosted root inventory has drifted from
-- the reviewed snapshot. A missing expected name also fails in the static
-- statements below; these counts close the additive-drift case. Dynamic
-- partition children may vary by month, but none may carry an API-role ACL.
select 1 / case when
  current_user = 'postgres'
  and (
    select count(*) = 77
       and count(*) filter (
         where relation.relkind in ('r', 'p') and relation.relrowsecurity
       ) = 77
       and count(*) filter (
         where relation.relowner = (
           select oid from pg_catalog.pg_roles where rolname = 'postgres'
         )
       ) = 77
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
     where namespace.nspname = 'public'
       and relation.relkind in ('r', 'p', 'v', 'm', 'f')
       and not relation.relispartition
  )
  and (
    select count(*) = 7
       and count(*) filter (
         where sequence.relowner = (
           select oid from pg_catalog.pg_roles where rolname = 'postgres'
         )
       ) = 7
      from pg_catalog.pg_class sequence
      join pg_catalog.pg_namespace namespace on namespace.oid = sequence.relnamespace
     where namespace.nspname = 'public'
       and sequence.relkind = 'S'
  )
  and not exists (
    select 1
      from pg_catalog.pg_class partition
      join pg_catalog.pg_namespace namespace on namespace.oid = partition.relnamespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(partition.relacl, pg_catalog.acldefault('r', partition.relowner))
      ) privilege
     where namespace.nspname = 'public'
       and partition.relispartition
       and privilege.grantee in (
         0::oid,
         (select oid from pg_catalog.pg_roles where rolname = 'anon'),
         (select oid from pg_catalog.pg_roles where rolname = 'authenticated')
       )
  )
  and not exists (
    select 1
      from pg_catalog.pg_class partition
      join pg_catalog.pg_namespace namespace on namespace.oid = partition.relnamespace
     where namespace.nspname = 'public'
       and partition.relispartition
       and (
         partition.relowner <> (
           select oid from pg_catalog.pg_roles where rolname = 'postgres'
         )
         or (
           select count(*)
             from pg_catalog.pg_inherits inheritance
             join pg_catalog.pg_class parent on parent.oid = inheritance.inhparent
             join pg_catalog.pg_namespace parent_namespace
               on parent_namespace.oid = parent.relnamespace
            where inheritance.inhrelid = partition.oid
              and parent_namespace.nspname = 'public'
              and not parent.relispartition
         ) <> 1
       )
  )
  and not exists (
    select 1
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          relation.relacl,
          pg_catalog.acldefault(
            (case when relation.relkind = 'S' then 'S' else 'r' end)::"char",
            relation.relowner
          )
        )
      ) privilege
     where namespace.nspname = 'public'
       and relation.relkind in ('r', 'p', 'S')
       and not relation.relispartition
       and privilege.grantee = 0
  )
  and not exists (
    select 1
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
     where namespace.nspname = 'public'
       and relation.relkind in ('r', 'p', 'S')
       and relation.relowner <> (
         select oid from pg_catalog.pg_roles where rolname = 'postgres'
       )
  )
  and not exists (
    select 1
      from pg_catalog.pg_attribute attribute
      join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      cross join lateral pg_catalog.aclexplode(attribute.attacl) privilege
     where namespace.nspname = 'public'
       and relation.relkind in ('r', 'p')
       and attribute.attnum > 0
       and not attribute.attisdropped
       and privilege.grantee in (
         0::oid, 'anon'::regrole, 'authenticated'::regrole
       )
  )
  and (
    select count(*) = 2
       and not bool_or(
         role.rolsuper
         or role.rolbypassrls
         or role.rolcreaterole
         or role.rolcreatedb
         or role.rolreplication
         or role.rolcanlogin
       )
      from pg_catalog.pg_roles role
     where role.rolname in ('anon', 'authenticated')
  )
  and not exists (
    select 1
      from pg_catalog.pg_auth_members membership
     where membership.member in (
       select oid from pg_catalog.pg_roles where rolname in ('anon', 'authenticated')
     )
  )
  and (
    select count(*) = 1
       and bool_and(owner.rolname = 'postgres')
       and not bool_or(function.prosecdef)
       and bool_and(function.prolang = (
         select oid from pg_catalog.pg_language where lanname = 'plpgsql'
       ))
       and bool_and(function.prorettype = 'void'::regtype)
       and bool_and(
         function.proconfig = array['search_path=pg_catalog, pg_temp']::text[]
       )
      from pg_catalog.pg_proc function
     join pg_catalog.pg_roles owner on owner.oid = function.proowner
     where function.oid = 'app.install_tenant_rls(regclass,text[])'::regprocedure
  )
  and (
    select count(*) = 1
       and bool_and(privilege.grantor = 'postgres'::regrole)
       and bool_and(privilege.grantee = 0)
       and bool_and(privilege.privilege_type = 'EXECUTE')
       and not bool_or(privilege.is_grantable)
      from pg_catalog.pg_proc function
      cross join lateral pg_catalog.aclexplode(
        coalesce(function.proacl, pg_catalog.acldefault('f', function.proowner))
      ) privilege
     where function.oid = 'app.install_tenant_rls(regclass,text[])'::regprocedure
       and privilege.grantee in (
         0::oid, 'anon'::regrole, 'authenticated'::regrole
       )
  )
then 1 else 0 end as wp186_catalog_inventory_guard;

-- The platform-owned defaults are an exact, creator-specific Supabase
-- baseline. The project `postgres` role cannot and must not alter them. Keep a
-- literal matrix so a platform change, partial ACL or grant option fails before
-- any permanent authority changes.
create temporary table wp186_expected_platform_defaults (
  object_type text not null,
  grantee text not null,
  privilege text not null,
  primary key (object_type, grantee, privilege)
) on commit drop;

insert into wp186_expected_platform_defaults (object_type, grantee, privilege)
select 'r', grantee, privilege
  from unnest(array['anon', 'authenticated']) grantee
  cross join lateral unnest(
    case when current_setting('server_version_num')::integer >= 170000 then
      array[
        'DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES',
        'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'
      ]::text[]
    else
      array[
        'DELETE', 'INSERT', 'REFERENCES',
        'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'
      ]::text[]
    end
  ) privilege
union all
select 'S', grantee, privilege
  from unnest(array['anon', 'authenticated']) grantee
  cross join lateral unnest(array['SELECT', 'UPDATE', 'USAGE']) privilege;

select 1 / case when
  (
    with actual as (
      select defaults.defaclobjtype::text as object_type,
             grantee.rolname as grantee,
             upper(privilege.privilege_type) as privilege,
             grantor.rolname as grantor,
             privilege.is_grantable
        from pg_catalog.pg_default_acl defaults
        cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
        join pg_catalog.pg_roles creator on creator.oid = defaults.defaclrole
        join pg_catalog.pg_roles grantor on grantor.oid = privilege.grantor
        join pg_catalog.pg_roles grantee on grantee.oid = privilege.grantee
       where defaults.defaclnamespace = 'public'::regnamespace::oid
         and defaults.defaclobjtype in ('r', 'S')
         and creator.rolname = 'supabase_admin'
         and grantee.rolname in ('anon', 'authenticated')
    ), expected as (
      select object_type, grantee, privilege,
             'supabase_admin'::text as grantor,
             false as is_grantable
        from wp186_expected_platform_defaults
    )
    select not exists (
             select * from expected
             except
             select * from actual
           )
       and not exists (
             select * from actual
             except
             select * from expected
           )
  )
  and (
    with actual as (
      select defaults.defaclobjtype::text as object_type,
             grantee.rolname as grantee,
             upper(privilege.privilege_type) as privilege,
             grantor.rolname as grantor,
             privilege.is_grantable
        from pg_catalog.pg_default_acl defaults
        cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
        join pg_catalog.pg_roles creator on creator.oid = defaults.defaclrole
        join pg_catalog.pg_roles grantor on grantor.oid = privilege.grantor
        join pg_catalog.pg_roles grantee on grantee.oid = privilege.grantee
       where defaults.defaclnamespace = 'public'::regnamespace::oid
         and defaults.defaclobjtype in ('r', 'S')
         and creator.rolname = 'postgres'
         and grantee.rolname in ('anon', 'authenticated')
    ), expected as (
      select object_type, grantee, privilege,
             'postgres'::text as grantor, false as is_grantable
        from wp186_expected_platform_defaults
    )
    select not exists (select 1 from actual)
        or (
          not exists (select * from expected except select * from actual)
          and not exists (select * from actual except select * from expected)
        )
  )
  and not exists (
    select 1
      from pg_catalog.pg_default_acl defaults
      cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
      join pg_catalog.pg_roles creator on creator.oid = defaults.defaclrole
      left join pg_catalog.pg_roles grantee on grantee.oid = privilege.grantee
     where defaults.defaclobjtype in ('r', 'S')
       and defaults.defaclnamespace in (0::oid, 'public'::regnamespace::oid)
       and (
         privilege.grantee = 0
         or grantee.rolname in ('anon', 'authenticated')
       )
       and (
         defaults.defaclnamespace = 0
         or privilege.grantee = 0
         or creator.rolname not in ('postgres', 'supabase_admin')
       )
  )
then 1 else 0 end as wp186_default_acl_guard;

-- Snapshot every catalog surface that this migration must preserve. Temporary
-- rows disappear at transaction end and cannot become application state.
create temporary table wp186_platform_default_snapshot on commit drop as
select defaults.defaclrole,
       defaults.defaclnamespace,
       defaults.defaclobjtype,
       privilege.grantor,
       privilege.grantee,
       privilege.privilege_type,
       privilege.is_grantable
  from pg_catalog.pg_default_acl defaults
  cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
 where defaults.defaclrole = 'supabase_admin'::regrole
   and defaults.defaclnamespace = 'public'::regnamespace::oid
   and defaults.defaclobjtype in ('r', 'S')
   and privilege.grantee in ('anon'::regrole, 'authenticated'::regrole);

create temporary table wp186_partition_snapshot on commit drop as
select partition.oid,
       partition.relname,
       partition.relowner,
       partition.relrowsecurity,
       inheritance.inhparent
  from pg_catalog.pg_class partition
  join pg_catalog.pg_namespace namespace on namespace.oid = partition.relnamespace
  join pg_catalog.pg_inherits inheritance on inheritance.inhrelid = partition.oid
 where namespace.nspname = 'public'
   and partition.relispartition;

create temporary table wp186_api_role_snapshot on commit drop as
select role.oid,
       role.rolname,
       role.rolinherit,
       role.rolsuper,
       role.rolbypassrls,
       role.rolcreaterole,
       role.rolcreatedb,
       role.rolreplication,
       role.rolcanlogin
  from pg_catalog.pg_roles role
 where role.rolname in ('anon', 'authenticated');

create temporary table wp186_non_target_relation_acl_snapshot on commit drop as
select relation.oid as relation_oid,
       privilege.grantor,
       privilege.grantee,
       privilege.privilege_type,
       privilege.is_grantable
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  cross join lateral pg_catalog.aclexplode(
    coalesce(
      relation.relacl,
      pg_catalog.acldefault(
        (case when relation.relkind = 'S' then 'S' else 'r' end)::"char",
        relation.relowner
      )
    )
  ) privilege
 where namespace.nspname = 'public'
   and relation.relkind in ('r', 'p', 'S')
   and privilege.grantee not in (
     0::oid, 'anon'::regrole, 'authenticated'::regrole
   );

create temporary table wp186_non_target_column_acl_snapshot on commit drop as
select attribute.attrelid as relation_oid,
       attribute.attnum,
       privilege.grantor,
       privilege.grantee,
       privilege.privilege_type,
       privilege.is_grantable
  from pg_catalog.pg_attribute attribute
  join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  cross join lateral pg_catalog.aclexplode(attribute.attacl) privilege
 where namespace.nspname = 'public'
   and relation.relkind in ('r', 'p')
   and attribute.attnum > 0
   and not attribute.attisdropped
   and privilege.grantee not in (
     0::oid, 'anon'::regrole, 'authenticated'::regrole
   );

create temporary table wp186_non_target_default_acl_snapshot on commit drop as
select defaults.defaclrole,
       defaults.defaclnamespace,
       defaults.defaclobjtype,
       privilege.grantor,
       privilege.grantee,
       privilege.privilege_type,
       privilege.is_grantable
  from pg_catalog.pg_default_acl defaults
  cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
 where defaults.defaclobjtype in ('r', 'S')
   and privilege.grantee not in (
     0::oid, 'anon'::regrole, 'authenticated'::regrole
   );

create temporary table wp186_helper_acl_snapshot on commit drop as
select privilege.grantor,
       privilege.grantee,
       privilege.privilege_type,
       privilege.is_grantable
  from pg_catalog.pg_proc function
  cross join lateral pg_catalog.aclexplode(
    coalesce(function.proacl, pg_catalog.acldefault('f', function.proowner))
  ) privilege
 where function.oid = 'app.install_tenant_rls(regclass,text[])'::regprocedure
   and privilege.grantee not in (
     0::oid,
     'anon'::regrole,
     'authenticated'::regrole,
     'service_role'::regrole
   );

-- Future objects created by repository migrations start closed. Migrations
-- and the tenant installer grant the exact commands they need after creation.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;

-- Keep the installer signature and policy semantics stable. The new revoke is
-- the load-bearing correction: a narrow GRANT cannot narrow an inherited ALL.
create or replace function app.install_tenant_rls(
  p_table regclass,
  p_write_roles text[] default null
)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_ident text := p_table::text;
begin
  execute format('alter table %s enable row level security', v_ident);

  execute format(
    'create policy tenant_read on %s for select to authenticated using (app.is_org_member(org_id))',
    v_ident
  );

  if p_write_roles is not null then
    execute format(
      'create policy tenant_insert on %s for insert to authenticated with check (app.has_org_role(org_id, %L))',
      v_ident, p_write_roles
    );
    execute format(
      'create policy tenant_update on %s for update to authenticated using (app.has_org_role(org_id, %L)) with check (app.has_org_role(org_id, %L))',
      v_ident, p_write_roles, p_write_roles
    );
    execute format(
      'create policy tenant_delete on %s for delete to authenticated using (app.has_org_role(org_id, %L))',
      v_ident, p_write_roles
    );
  end if;

  execute format('revoke all on %s from anon, authenticated', v_ident);
  execute format('grant select on %s to authenticated', v_ident);
  if p_write_roles is not null then
    execute format('grant insert, update, delete on %s to authenticated', v_ident);
  end if;
  execute format('grant all on %s to service_role', v_ident);
end;
$$;

revoke all on function app.install_tenant_rls(regclass, text[])
  from public, anon, authenticated;
grant execute on function app.install_tenant_rls(regclass, text[])
  to service_role;

-- Start every current parent relation from no API-role authority. Partition
-- children are created by guarded automation with no API grants; revoking the
-- parent closes parent-directed TRUNCATE across every attached child.
-- Static parent names make source drift fail instead of passing silently.
revoke all on table
  public.ad_creative_asset_mappings,
  public.ad_groups,
  public.ad_profiles,
  public.ads_connections,
  public.apply_batches,
  public.apply_rows,
  public.attribution_observations,
  public.audit_log,
  public.bid_series_daily,
  public.campaign_maps,
  public.campaign_optimization_assignments,
  public.campaigns,
  public.competitor_links,
  public.competitor_price_events,
  public.contextual_negative_exports,
  public.contextual_negative_proposals,
  public.creative_assets,
  public.creative_placements,
  public.creative_sync_snapshots,
  public.crosscheck_results,
  public.dashboards,
  public.dayparting_schedule_proposals,
  public.entity_changes,
  public.entity_tags,
  public.experiment_events,
  public.experiments,
  public.fact_creative_daily,
  public.fact_monthly_rollup,
  public.fact_placement_daily,
  public.fact_profile_daily,
  public.fact_sales_traffic_daily,
  public.fact_sb_daily,
  public.fact_sd_daily,
  public.fact_search_term_daily,
  public.fact_sp_target_daily,
  public.fact_sqp_weekly,
  public.feedback_items,
  public.feedback_votes,
  public.goto_links,
  public.historical_bootstrap_progress,
  public.insights,
  public.integration_connections,
  public.keepa_bsr_observations,
  public.keywords,
  public.marketing_stream_events,
  public.marketing_stream_hourly_facts,
  public.marketing_stream_projection_block_scopes,
  public.marketing_stream_projection_blocks,
  public.marketing_stream_subscription_bindings,
  public.negatives,
  public.optimization_groups,
  public.org_invitations,
  public.org_members,
  public.orgs,
  public.portfolios,
  public.product_ads,
  public.product_economics,
  public.profile_strategy,
  public.query_vocabulary,
  public.rank_observations,
  public.recommendation_observations,
  public.recommendation_runs,
  public.recommendations,
  public.report_coverage,
  public.report_promotion_watermarks,
  public.report_requests,
  public.spapi_connections,
  public.spapi_profile_bindings,
  public.sqp_promotion_runs,
  public.supa_flags,
  public.sync_jobs,
  public.sync_schedules,
  public.tags,
  public.targets,
  public.unified_report_operations,
  public.unified_report_runs,
  public.unified_reporting_bindings
from anon, authenticated;

-- Service-owned and evidence tables are readable but never directly mutable by
-- authenticated clients.
grant select on table
  public.ad_creative_asset_mappings,
  public.ad_groups,
  public.attribution_observations,
  public.audit_log,
  public.bid_series_daily,
  public.campaigns,
  public.competitor_price_events,
  public.contextual_negative_exports,
  public.contextual_negative_proposals,
  public.creative_assets,
  public.creative_placements,
  public.creative_sync_snapshots,
  public.crosscheck_results,
  public.entity_changes,
  public.fact_creative_daily,
  public.fact_monthly_rollup,
  public.fact_placement_daily,
  public.fact_profile_daily,
  public.fact_sales_traffic_daily,
  public.fact_sb_daily,
  public.fact_sd_daily,
  public.fact_search_term_daily,
  public.fact_sp_target_daily,
  public.fact_sqp_weekly,
  public.historical_bootstrap_progress,
  public.insights,
  public.keepa_bsr_observations,
  public.keywords,
  public.marketing_stream_events,
  public.marketing_stream_hourly_facts,
  public.marketing_stream_projection_block_scopes,
  public.marketing_stream_projection_blocks,
  public.marketing_stream_subscription_bindings,
  public.negatives,
  public.portfolios,
  public.product_ads,
  public.product_economics,
  public.rank_observations,
  public.recommendation_observations,
  public.recommendation_runs,
  public.report_coverage,
  public.report_promotion_watermarks,
  public.report_requests,
  public.sqp_promotion_runs,
  public.supa_flags,
  public.sync_jobs,
  public.targets,
  public.unified_report_operations,
  public.unified_report_runs
to authenticated;

-- Configuration and operator-owned tables keep policy-filtered row DML only.
grant select, insert, update, delete on table
  public.ad_profiles,
  public.ads_connections,
  public.apply_batches,
  public.apply_rows,
  public.campaign_maps,
  public.campaign_optimization_assignments,
  public.competitor_links,
  public.dashboards,
  public.dayparting_schedule_proposals,
  public.entity_tags,
  public.experiments,
  public.feedback_items,
  public.goto_links,
  public.integration_connections,
  public.optimization_groups,
  public.org_invitations,
  public.org_members,
  public.profile_strategy,
  public.query_vocabulary,
  public.spapi_connections,
  public.spapi_profile_bindings,
  public.sync_schedules,
  public.tags,
  public.unified_reporting_bindings
to authenticated;

grant select, insert on table public.experiment_events to authenticated;
grant select, insert, delete on table public.feedback_votes to authenticated;
grant select, update on table public.orgs, public.recommendations to authenticated;

-- Identity sequences are service-owned except for authenticated experiment
-- event inserts. USAGE permits nextval and session-local currval while blocking
-- direct last_value reads and setval.
revoke all on sequence
  public.audit_log_id_seq,
  public.competitor_price_events_id_seq,
  public.entity_changes_id_seq,
  public.experiment_events_id_seq,
  public.keepa_bsr_observations_id_seq,
  public.product_economics_id_seq,
  public.rank_observations_id_seq
from anon, authenticated;

grant usage on sequence public.experiment_events_id_seq to authenticated;

-- A second statement snapshot catches committed drift after the precondition
-- and proves exact relation authority rather than only excluding a dangerous
-- subset. The attended exclusive-DDL window is still required to exclude an
-- object created by a transaction that has not committed yet.
select 1 / case when
  current_user = 'postgres'
  and (
    with current_roles as (
      select role.oid,
             role.rolname,
             role.rolinherit,
             role.rolsuper,
             role.rolbypassrls,
             role.rolcreaterole,
             role.rolcreatedb,
             role.rolreplication,
             role.rolcanlogin
        from pg_catalog.pg_roles role
       where role.rolname in ('anon', 'authenticated')
    )
    select not exists (
             select * from wp186_api_role_snapshot
             except
             select * from current_roles
           )
       and not exists (
             select * from current_roles
             except
             select * from wp186_api_role_snapshot
           )
  )
  and not exists (
    select 1
      from pg_catalog.pg_auth_members membership
     where membership.member in (
       select oid from pg_catalog.pg_roles where rolname in ('anon', 'authenticated')
     )
  )
  and (
    select count(*) = 77
       and count(*) filter (
         where relation.relkind in ('r', 'p') and relation.relrowsecurity
       ) = 77
       and count(*) filter (where relation.relowner = 'postgres'::regrole) = 77
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
     where namespace.nspname = 'public'
       and relation.relkind in ('r', 'p', 'v', 'm', 'f')
       and not relation.relispartition
  )
  and (
    select count(*) = 7
       and count(*) filter (where sequence.relowner = 'postgres'::regrole) = 7
      from pg_catalog.pg_class sequence
      join pg_catalog.pg_namespace namespace on namespace.oid = sequence.relnamespace
     where namespace.nspname = 'public'
       and sequence.relkind = 'S'
  )
  and (
    with current_partitions as (
      select partition.oid,
             partition.relname,
             partition.relowner,
             partition.relrowsecurity,
             inheritance.inhparent
        from pg_catalog.pg_class partition
        join pg_catalog.pg_namespace namespace on namespace.oid = partition.relnamespace
        join pg_catalog.pg_inherits inheritance on inheritance.inhrelid = partition.oid
       where namespace.nspname = 'public'
         and partition.relispartition
    )
    select not exists (
             select * from wp186_partition_snapshot
             except
             select * from current_partitions
           )
       and not exists (
             select * from current_partitions
             except
             select * from wp186_partition_snapshot
           )
  )
  and not exists (
    select 1
      from pg_catalog.pg_class partition
      join pg_catalog.pg_namespace namespace on namespace.oid = partition.relnamespace
      cross join lateral unnest(
        case when current_setting('server_version_num')::integer >= 170000 then
          array[
            'SELECT', 'INSERT', 'UPDATE', 'DELETE',
            'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'
          ]::text[]
        else
          array[
            'SELECT', 'INSERT', 'UPDATE', 'DELETE',
            'TRUNCATE', 'REFERENCES', 'TRIGGER'
          ]::text[]
        end
      ) command
     where namespace.nspname = 'public'
       and partition.relispartition
       and (
         pg_catalog.has_table_privilege('anon', partition.oid, command)
         or pg_catalog.has_table_privilege('authenticated', partition.oid, command)
       )
  )
  and not exists (
    select 1
      from pg_catalog.pg_attribute attribute
      join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      cross join lateral pg_catalog.aclexplode(attribute.attacl) privilege
     where namespace.nspname = 'public'
       and relation.relkind in ('r', 'p')
       and attribute.attnum > 0
       and not attribute.attisdropped
       and privilege.grantee in (
         0::oid, 'anon'::regrole, 'authenticated'::regrole
       )
  )
  and (
    with expected as (
      select distinct policy.tablename::text as relation_name,
             'postgres'::text as grantor,
             'authenticated'::text as grantee,
             command.value::text as privilege,
             false as is_grantable
        from pg_catalog.pg_policies policy
        cross join lateral unnest(
          case policy.cmd
            when 'ALL' then array['SELECT', 'INSERT', 'UPDATE', 'DELETE']::text[]
            else array[policy.cmd::text]::text[]
          end
        ) command(value)
       where policy.schemaname = 'public'
         and policy.roles && array['authenticated', 'public']::name[]
    ), actual as (
      select relation.relname::text as relation_name,
             grantor.rolname::text as grantor,
             case privilege.grantee when 0 then 'public' else grantee.rolname end::text
               as grantee,
             upper(privilege.privilege_type)::text as privilege,
             privilege.is_grantable
        from pg_catalog.pg_class relation
        join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
        cross join lateral pg_catalog.aclexplode(
          coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
        ) privilege
        join pg_catalog.pg_roles grantor on grantor.oid = privilege.grantor
        left join pg_catalog.pg_roles grantee on grantee.oid = privilege.grantee
       where namespace.nspname = 'public'
         and relation.relkind in ('r', 'p')
         and not relation.relispartition
         and (
           privilege.grantee = 0
           or grantee.rolname in ('anon', 'authenticated')
         )
    )
    select not exists (select * from expected except select * from actual)
       and not exists (select * from actual except select * from expected)
  )
  and not exists (
    with expected as (
      select distinct policy.tablename::text as relation_name,
             command.value::text as privilege
        from pg_catalog.pg_policies policy
        cross join lateral unnest(
          case policy.cmd
            when 'ALL' then array['SELECT', 'INSERT', 'UPDATE', 'DELETE']::text[]
            else array[policy.cmd::text]::text[]
          end
        ) command(value)
       where policy.schemaname = 'public'
         and policy.roles && array['authenticated', 'public']::name[]
    ), commands as (
      select unnest(
        case when current_setting('server_version_num')::integer >= 170000 then
          array[
            'SELECT', 'INSERT', 'UPDATE', 'DELETE',
            'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'
          ]::text[]
        else
          array[
            'SELECT', 'INSERT', 'UPDATE', 'DELETE',
            'TRUNCATE', 'REFERENCES', 'TRIGGER'
          ]::text[]
        end
      ) as privilege
    )
    select 1
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      cross join commands
     where namespace.nspname = 'public'
       and relation.relkind in ('r', 'p')
       and not relation.relispartition
       and (
         pg_catalog.has_table_privilege('anon', relation.oid, commands.privilege)
         or pg_catalog.has_table_privilege(
           'authenticated', relation.oid, commands.privilege
         ) <> exists (
           select 1
             from expected
            where expected.relation_name = relation.relname
              and expected.privilege = commands.privilege
         )
       )
  )
  and not exists (
    with expected as (
      select distinct policy.tablename::text as relation_name,
             command.value::text as privilege
        from pg_catalog.pg_policies policy
        cross join lateral unnest(
          case policy.cmd
            when 'ALL' then array['SELECT', 'INSERT', 'UPDATE']::text[]
            else array[policy.cmd::text]::text[]
          end
        ) command(value)
       where policy.schemaname = 'public'
         and policy.roles && array['authenticated', 'public']::name[]
    ), commands as (
      select unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) as privilege
    )
    select 1
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      join pg_catalog.pg_attribute attribute on attribute.attrelid = relation.oid
      cross join commands
     where namespace.nspname = 'public'
       and relation.relkind in ('r', 'p')
       and not relation.relispartition
       and attribute.attnum > 0
       and not attribute.attisdropped
       and (
         pg_catalog.has_column_privilege(
           'anon', relation.oid, attribute.attnum, commands.privilege
         )
         or pg_catalog.has_column_privilege(
           'authenticated', relation.oid, attribute.attnum, commands.privilege
         ) <> exists (
           select 1
             from expected
            where expected.relation_name = relation.relname
              and expected.privilege = commands.privilege
         )
       )
  )
  and not exists (
    select 1
      from pg_catalog.pg_class partition
      join pg_catalog.pg_namespace namespace on namespace.oid = partition.relnamespace
      join pg_catalog.pg_attribute attribute on attribute.attrelid = partition.oid
      cross join lateral unnest(
        array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']::text[]
      ) command
     where namespace.nspname = 'public'
       and partition.relispartition
       and attribute.attnum > 0
       and not attribute.attisdropped
       and (
         pg_catalog.has_column_privilege(
           'anon', partition.oid, attribute.attnum, command
         )
         or pg_catalog.has_column_privilege(
           'authenticated', partition.oid, attribute.attnum, command
         )
       )
  )
  and (
    with expected as (
      select 'experiment_events_id_seq'::text as sequence_name,
             'postgres'::text as grantor,
             'authenticated'::text as grantee,
             'USAGE'::text as privilege,
             false as is_grantable
    ), actual as (
      select sequence.relname::text as sequence_name,
             grantor.rolname::text as grantor,
             case privilege.grantee when 0 then 'public' else grantee.rolname end::text
               as grantee,
             upper(privilege.privilege_type)::text as privilege,
             privilege.is_grantable
        from pg_catalog.pg_class sequence
        join pg_catalog.pg_namespace namespace on namespace.oid = sequence.relnamespace
        cross join lateral pg_catalog.aclexplode(
          coalesce(sequence.relacl, pg_catalog.acldefault('S', sequence.relowner))
        ) privilege
        join pg_catalog.pg_roles grantor on grantor.oid = privilege.grantor
        left join pg_catalog.pg_roles grantee on grantee.oid = privilege.grantee
       where namespace.nspname = 'public'
         and sequence.relkind = 'S'
         and (
           privilege.grantee = 0
           or grantee.rolname in ('anon', 'authenticated')
         )
    )
    select not exists (select * from expected except select * from actual)
       and not exists (select * from actual except select * from expected)
  )
  and not exists (
    select 1
      from pg_catalog.pg_class sequence
      join pg_catalog.pg_namespace namespace on namespace.oid = sequence.relnamespace
      cross join lateral unnest(array['SELECT', 'UPDATE', 'USAGE']) command
     where namespace.nspname = 'public'
       and sequence.relkind = 'S'
       and (
         pg_catalog.has_sequence_privilege('anon', sequence.oid, command)
         or pg_catalog.has_sequence_privilege('authenticated', sequence.oid, command)
            <> (
              sequence.relname = 'experiment_events_id_seq'
              and command = 'USAGE'
            )
       )
  )
  and (
    with actual as (
      select defaults.defaclrole,
             defaults.defaclnamespace,
             defaults.defaclobjtype,
             privilege.grantor,
             privilege.grantee,
             privilege.privilege_type,
             privilege.is_grantable
        from pg_catalog.pg_default_acl defaults
        cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
        left join pg_catalog.pg_roles grantee on grantee.oid = privilege.grantee
       where defaults.defaclobjtype in ('r', 'S')
         and defaults.defaclnamespace in (0::oid, 'public'::regnamespace::oid)
         and (
           privilege.grantee = 0
           or grantee.rolname in ('anon', 'authenticated')
         )
    )
    select not exists (
             select * from wp186_platform_default_snapshot
             except
             select * from actual
           )
       and not exists (
             select * from actual
             except
             select * from wp186_platform_default_snapshot
           )
  )
  and (
    with current_acl as (
      select relation.oid as relation_oid,
             privilege.grantor,
             privilege.grantee,
             privilege.privilege_type,
             privilege.is_grantable
        from pg_catalog.pg_class relation
        join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            relation.relacl,
            pg_catalog.acldefault(
              (case when relation.relkind = 'S' then 'S' else 'r' end)::"char",
              relation.relowner
            )
          )
        ) privilege
       where namespace.nspname = 'public'
         and relation.relkind in ('r', 'p', 'S')
         and privilege.grantee not in (
           0::oid, 'anon'::regrole, 'authenticated'::regrole
         )
    )
    select not exists (
             select * from wp186_non_target_relation_acl_snapshot
             except
             select * from current_acl
           )
       and not exists (
             select * from current_acl
             except
           select * from wp186_non_target_relation_acl_snapshot
           )
  )
  and (
    with current_acl as (
      select attribute.attrelid as relation_oid,
             attribute.attnum,
             privilege.grantor,
             privilege.grantee,
             privilege.privilege_type,
             privilege.is_grantable
        from pg_catalog.pg_attribute attribute
        join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
        join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
        cross join lateral pg_catalog.aclexplode(attribute.attacl) privilege
       where namespace.nspname = 'public'
         and relation.relkind in ('r', 'p')
         and attribute.attnum > 0
         and not attribute.attisdropped
         and privilege.grantee not in (
           0::oid, 'anon'::regrole, 'authenticated'::regrole
         )
    )
    select not exists (
             select * from wp186_non_target_column_acl_snapshot
             except
             select * from current_acl
           )
       and not exists (
             select * from current_acl
             except
             select * from wp186_non_target_column_acl_snapshot
           )
  )
  and (
    with current_acl as (
      select defaults.defaclrole,
             defaults.defaclnamespace,
             defaults.defaclobjtype,
             privilege.grantor,
             privilege.grantee,
             privilege.privilege_type,
             privilege.is_grantable
        from pg_catalog.pg_default_acl defaults
        cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
       where defaults.defaclobjtype in ('r', 'S')
         and privilege.grantee not in (
           0::oid, 'anon'::regrole, 'authenticated'::regrole
         )
    )
    select not exists (
             select * from wp186_non_target_default_acl_snapshot
             except
             select * from current_acl
           )
       and not exists (
             select * from current_acl
             except
             select * from wp186_non_target_default_acl_snapshot
           )
  )
  and (
    select count(*) = 1
       and bool_and(owner.rolname = 'postgres')
       and not bool_or(function.prosecdef)
       and bool_and(function.prolang = (
         select oid from pg_catalog.pg_language where lanname = 'plpgsql'
       ))
       and bool_and(function.prorettype = 'void'::regtype)
       and bool_and(
         function.proconfig = array['search_path=pg_catalog, pg_temp']::text[]
       )
      from pg_catalog.pg_proc function
      join pg_catalog.pg_roles owner on owner.oid = function.proowner
     where function.oid = 'app.install_tenant_rls(regclass,text[])'::regprocedure
  )
  and (
    with current_acl as (
      select privilege.grantor,
             privilege.grantee,
             privilege.privilege_type,
             privilege.is_grantable
        from pg_catalog.pg_proc function
        cross join lateral pg_catalog.aclexplode(
          coalesce(function.proacl, pg_catalog.acldefault('f', function.proowner))
        ) privilege
       where function.oid = 'app.install_tenant_rls(regclass,text[])'::regprocedure
         and privilege.grantee not in (
           0::oid,
           'anon'::regrole,
           'authenticated'::regrole,
           'service_role'::regrole
         )
    )
    select not exists (
             select * from wp186_helper_acl_snapshot
             except
             select * from current_acl
           )
       and not exists (
             select * from current_acl
             except
             select * from wp186_helper_acl_snapshot
           )
  )
  and not pg_catalog.has_function_privilege(
    'anon', 'app.install_tenant_rls(regclass,text[])', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated', 'app.install_tenant_rls(regclass,text[])', 'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role', 'app.install_tenant_rls(regclass,text[])', 'EXECUTE'
  )
  and (
    select count(*) = 1
       and bool_and(privilege.grantor = 'postgres'::regrole)
       and bool_and(privilege.grantee = 'service_role'::regrole)
       and bool_and(privilege.privilege_type = 'EXECUTE')
       and not bool_or(privilege.is_grantable)
      from pg_catalog.pg_proc function
      cross join lateral pg_catalog.aclexplode(
        coalesce(function.proacl, pg_catalog.acldefault('f', function.proowner))
      ) privilege
     where function.oid = 'app.install_tenant_rls(regclass,text[])'::regprocedure
       and privilege.grantee in (
         0::oid,
         'anon'::regrole,
         'authenticated'::regrole,
         'service_role'::regrole
       )
  )
then 1 else 0 end as wp186_catalog_postcondition;
