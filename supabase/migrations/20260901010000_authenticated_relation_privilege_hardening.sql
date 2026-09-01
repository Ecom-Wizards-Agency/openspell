-- WP-186: normalize hosted Supabase relation privileges to the RLS policy contract.
--
-- Supabase grants broad table and sequence privileges to API roles by default.
-- A later GRANT SELECT is additive, so it does not remove inherited TRUNCATE,
-- REFERENCES, TRIGGER, MAINTAIN or sequence-rewrite authority. RLS governs row
-- commands only. This forward migration removes the inherited authority without
-- changing a policy, row, service-role grant or preview-role grant.

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
      from pg_catalog.pg_default_acl defaults
      cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
      left join pg_catalog.pg_roles grantee on grantee.oid = privilege.grantee
     where defaults.defaclobjtype in ('r', 'S')
       and defaults.defaclnamespace in (0::oid, 'public'::regnamespace::oid)
       and (
         privilege.grantee = 0
         or grantee.rolname in ('anon', 'authenticated')
       )
       and not (
         defaults.defaclnamespace = 'public'::regnamespace::oid
         and defaults.defaclrole = (
           select oid from pg_catalog.pg_roles where rolname = 'postgres'
         )
         and privilege.grantee <> 0
         and grantee.rolname in ('anon', 'authenticated')
       )
  )
then 1 else 0 end as wp186_catalog_inventory_guard;

-- Future objects start closed. Migrations and the tenant installer grant the
-- exact commands they need after object creation.
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

-- A second statement snapshot catches any committed drift that appeared after
-- the precondition. The attended exclusive-DDL window is still required to
-- exclude objects created by transactions that have not committed yet.
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
      left join pg_catalog.pg_roles grantee on grantee.oid = privilege.grantee
     where namespace.nspname = 'public'
       and relation.relkind in ('r', 'p', 'S')
       and (
         privilege.grantee = 0
         or grantee.rolname = 'anon'
         or (
           grantee.rolname = 'authenticated'
           and (
             relation.relispartition
             or (relation.relkind in ('r', 'p') and privilege.privilege_type not in (
               'SELECT', 'INSERT', 'UPDATE', 'DELETE'
             ))
             or (relation.relkind = 'S' and not (
               relation.relname = 'experiment_events_id_seq'
               and privilege.privilege_type = 'USAGE'
             ))
           )
         )
       )
  )
  and (
    select count(*) = 1
       and bool_and(
         sequence.relname = 'experiment_events_id_seq'
         and grantee.rolname = 'authenticated'
         and privilege.privilege_type = 'USAGE'
       )
      from pg_catalog.pg_class sequence
      join pg_catalog.pg_namespace namespace on namespace.oid = sequence.relnamespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(sequence.relacl, pg_catalog.acldefault('S', sequence.relowner))
      ) privilege
      left join pg_catalog.pg_roles grantee on grantee.oid = privilege.grantee
     where namespace.nspname = 'public'
       and sequence.relkind = 'S'
       and (
         privilege.grantee = 0
         or grantee.rolname in ('anon', 'authenticated')
       )
  )
  and not exists (
    select 1
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
then 1 else 0 end as wp186_catalog_postcondition;
