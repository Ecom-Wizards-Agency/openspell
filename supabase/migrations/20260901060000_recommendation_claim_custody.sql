-- WP-196: exclusive, revision-bound custody for read-only recommendation execution.
--
-- Applying this migration is compatibility-preserving. Recommendation claims and
-- admission remain legacy until separately authorized compare-and-set transitions.

set local lock_timeout = '5s';
select pg_advisory_xact_lock(
  pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0)
);

-- Roles are cluster-wide while disposable test databases are not. CREATE ROLE
-- itself serializes on the catalog unique index; a concurrent winner is caught
-- as duplicate_object. Never lock pg_authid: managed migration principals may
-- have CREATEROLE without direct pg_authid table privileges.
create function app.install_recommendation_roles()
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $role_install$
declare
  v_role record;
begin
  if not exists (
    select 1 from pg_catalog.pg_roles where rolname = 'openspell_recommendation_worker'
  ) then
    begin
      execute 'create role openspell_recommendation_worker '
        'nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls';
    exception when duplicate_object then
      null;
    end;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_roles where rolname = 'openspell_recommendation_executor'
  ) then
    begin
      execute 'create role openspell_recommendation_executor '
        'nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls';
    exception when duplicate_object then
      null;
    end;
  end if;

  for v_role in
    select rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole,
           rolreplication, rolbypassrls
      from pg_catalog.pg_roles
     where rolname in (
       'openspell_recommendation_worker',
       'openspell_recommendation_executor'
     )
  loop
    if v_role.rolcanlogin or v_role.rolinherit or v_role.rolsuper
       or v_role.rolcreatedb or v_role.rolcreaterole
       or v_role.rolreplication or v_role.rolbypassrls then
      raise exception 'recommendation role % has unsafe attributes', v_role.rolname
        using errcode = '55000';
    end if;
  end loop;

  if (
    select count(*) from pg_catalog.pg_roles
     where rolname in (
       'openspell_recommendation_worker',
       'openspell_recommendation_executor'
     )
  ) <> 2 then
    raise exception 'recommendation roles are unavailable' using errcode = '55000';
  end if;

  -- Managed PostgreSQL 16 may record its migration principal as ADMIN of a
  -- role it creates. That one outgoing edge is bootstrap metadata: neither
  -- narrow role inherits it, and service_role is not the migration principal.
  -- Every edge where a narrow role is the member, or where another role is its
  -- admin/member, remains forbidden.
  if exists (
    select 1
      from pg_catalog.pg_auth_members membership
     where membership.member in (
       'openspell_recommendation_worker'::regrole,
       'openspell_recommendation_executor'::regrole
     )
        or (
          membership.roleid in (
            'openspell_recommendation_worker'::regrole,
            'openspell_recommendation_executor'::regrole
          )
          and membership.member <> current_user::regrole
        )
  ) then
    raise exception 'recommendation roles have an unsafe membership edge' using errcode = '55000';
  end if;

  -- ALTER FUNCTION OWNER requires SET authority. Managed PostgreSQL records
  -- the creator edge with SET=false, so add one transaction-local, non-
  -- inheriting grant under our own grantor and revoke that exact edge below
  -- after every executor-owned function has been installed.
  execute pg_catalog.format(
    'grant openspell_recommendation_executor to %I '
    'with inherit false, set true granted by %I', current_user, current_user
  );
end;
$role_install$;

select app.install_recommendation_roles();
drop function app.install_recommendation_roles();

grant usage on schema public, app to openspell_recommendation_executor;
grant create on schema public, app to openspell_recommendation_executor;
grant usage on schema public to openspell_recommendation_worker;

-- These historical invoker RPCs granted their intended authenticated and
-- service roles directly but left PostgreSQL's default PUBLIC execute in
-- place. Remove only that ambient edge so the recommendation LOGIN role has
-- no effective function surface beyond the exact grants below.
revoke execute on function public.apply_cooldown_conflicts(uuid, text[], integer, date)
  from public;
revoke execute on function public.tag_subtree(uuid) from public;

create table app.recommendation_claim_authority (
  singleton boolean primary key default true check (singleton),
  protocol text not null default 'legacy' check (protocol in ('legacy', 'fenced')),
  admission text not null default 'legacy' check (admission in ('legacy', 'blocked', 'scoped')),
  epoch bigint not null default 0 check (epoch >= 0),
  authorized_revision text,
  updated_at timestamptz not null default now(),
  constraint recommendation_claim_authority_revision_check check (
    (protocol = 'legacy' and authorized_revision is null)
    or
    (protocol = 'fenced' and authorized_revision ~ '^[0-9a-f]{40}$')
  ),
  constraint recommendation_claim_authority_protocol_admission_check check (
    protocol = 'legacy' or admission <> 'legacy'
  )
);

insert into app.recommendation_claim_authority
  (singleton, protocol, admission, epoch, authorized_revision)
values (true, 'legacy', 'legacy', 0, null);

comment on table app.recommendation_claim_authority is
  'Private recommendation claim/admission authority. Source apply starts in compatibility-preserving legacy mode.';

revoke all on table app.recommendation_claim_authority from public;
revoke all on table app.recommendation_claim_authority from anon;
revoke all on table app.recommendation_claim_authority from authenticated;
revoke all on table app.recommendation_claim_authority from service_role;
revoke all on table app.recommendation_claim_authority from openspell_recommendation_worker;
revoke all on table app.recommendation_claim_authority from openspell_recommendation_executor;

alter table public.recommendation_runs
  add column execution_lineage text,
  add constraint recommendation_runs_execution_lineage_check
    check (execution_lineage is null or execution_lineage in ('queue', 'human'));

create index sync_jobs_recommendation_run_payload_run_idx
  on public.sync_jobs ((payload ->> 'runId'))
  where job_type = 'recommendations.run';

alter table public.recommendations
  add constraint recommendations_tenant_run_fkey
    foreign key (org_id, profile_id, run_id)
    references public.recommendation_runs (org_id, profile_id, id) on delete cascade;

comment on column public.recommendation_runs.execution_lineage is
  'queue for queue-backed optimizer execution; human only for the exact jobless N-gram proposal transaction. Historical null is guarded as queue lineage.';

-- Exact canonical bytes shared with WP-195's Node implementation. Callers
-- supply values in semantic order; campaign arrays are sorted by the wrappers.
create function app.recommendation_canonical_fingerprint(
  p_domain text,
  p_values text[]
)
returns text
language plpgsql
immutable
strict
set search_path = pg_catalog
as $$
declare
  v_value text;
  v_preimage text := p_domain || E'\n';
begin
  if p_domain not in (
    'openspell.recommendation-preview.batch-scope.v1',
    'openspell.recommendation-preview.run-scope.v1'
  ) then
    raise exception 'unsupported recommendation fingerprint domain' using errcode = '22023';
  end if;
  foreach v_value in array p_values loop
    if v_value is null then
      raise exception 'recommendation fingerprint values must be non-null' using errcode = '22023';
    end if;
    v_preimage := v_preimage
      || pg_catalog.octet_length(v_value)::text || ':' || v_value || E'\n';
  end loop;
  return pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_preimage, 'UTF8')),
    'hex'
  );
end;
$$;

create function app.recommendation_batch_scope_fingerprint(
  p_profile_id uuid,
  p_campaign_ids text[]
)
returns text
language plpgsql
immutable
strict
set search_path = pg_catalog, app
as $$
declare
  v_sorted text[];
begin
  if pg_catalog.current_setting('server_encoding') <> 'UTF8'
     or pg_catalog.cardinality(p_campaign_ids) not between 1 and 10000
     or pg_catalog.array_position(p_campaign_ids, null) is not null
     or exists (
       select 1 from pg_catalog.unnest(p_campaign_ids) value
        where pg_catalog.btrim(value) = ''
     )
     or (
       select pg_catalog.count(*) from pg_catalog.unnest(p_campaign_ids)
     ) <> (
       select pg_catalog.count(distinct value collate "C")
         from pg_catalog.unnest(p_campaign_ids) value
     ) then
    raise exception 'recommendation batch scope must contain 1..10000 unique non-empty campaign ids'
      using errcode = '22023';
  end if;
  select pg_catalog.array_agg(value order by value collate "C")
    into v_sorted from pg_catalog.unnest(p_campaign_ids) value;
  return app.recommendation_canonical_fingerprint(
    'openspell.recommendation-preview.batch-scope.v1',
    array[p_profile_id::text] || v_sorted
  );
end;
$$;

create function app.recommendation_run_scope_fingerprint(
  p_profile_id uuid,
  p_group_id uuid,
  p_campaign_ids text[]
)
returns text
language plpgsql
immutable
set search_path = pg_catalog, app
as $$
declare
  v_sorted text[];
begin
  if p_profile_id is null or p_campaign_ids is null
     or pg_catalog.current_setting('server_encoding') <> 'UTF8'
     or pg_catalog.cardinality(p_campaign_ids) not between 1 and 10000
     or pg_catalog.array_position(p_campaign_ids, null) is not null
     or exists (
       select 1 from pg_catalog.unnest(p_campaign_ids) value
        where pg_catalog.btrim(value) = ''
     )
     or (
       select pg_catalog.count(*) from pg_catalog.unnest(p_campaign_ids)
     ) <> (
       select pg_catalog.count(distinct value collate "C")
         from pg_catalog.unnest(p_campaign_ids) value
     ) then
    raise exception 'recommendation run scope must contain 1..10000 unique non-empty campaign ids'
      using errcode = '22023';
  end if;
  select pg_catalog.array_agg(value order by value collate "C")
    into v_sorted from pg_catalog.unnest(p_campaign_ids) value;
  return app.recommendation_canonical_fingerprint(
    'openspell.recommendation-preview.run-scope.v1',
    array[p_profile_id::text, coalesce(p_group_id::text, 'unassigned')] || v_sorted
  );
end;
$$;

revoke all on function app.recommendation_canonical_fingerprint(text, text[]) from public;
revoke all on function app.recommendation_batch_scope_fingerprint(uuid, text[]) from public;
revoke all on function app.recommendation_run_scope_fingerprint(uuid, uuid, text[]) from public;

-- SECURITY DEFINER functions see their owner as current_user. The direct
-- connection identity remains session_user and cannot be forged with a GUC.
create function app.assert_recommendation_worker(p_what text)
returns void
language plpgsql
stable
set search_path = pg_catalog
as $$
begin
  if session_user::text <> 'openspell_recommendation_worker' then
    raise exception '% is recommendation-worker only', p_what using errcode = '42501';
  end if;
end;
$$;

revoke all on function app.assert_recommendation_worker(text) from public;
grant execute on function app.assert_recommendation_worker(text)
  to openspell_recommendation_executor;

-- The executor is NOLOGIN and the runtime cannot SET ROLE to it. These exact
-- policies let only reviewed SECURITY DEFINER functions cross tenant RLS.
grant select, update on public.sync_jobs to openspell_recommendation_executor;
create policy recommendation_executor_select on public.sync_jobs
  for select to openspell_recommendation_executor using (job_type = 'recommendations.run');
create policy recommendation_executor_update on public.sync_jobs
  for update to openspell_recommendation_executor
  using (job_type = 'recommendations.run')
  with check (job_type = 'recommendations.run');

grant select, update on public.recommendation_runs to openspell_recommendation_executor;
create policy recommendation_executor_select on public.recommendation_runs
  for select to openspell_recommendation_executor using (true);
create policy recommendation_executor_update on public.recommendation_runs
  for update to openspell_recommendation_executor using (true) with check (true);

grant select on public.recommendation_run_campaigns to openspell_recommendation_executor;
create policy recommendation_executor_select on public.recommendation_run_campaigns
  for select to openspell_recommendation_executor using (true);

grant select on public.recommendation_preview_batches to openspell_recommendation_executor;
create policy recommendation_executor_select on public.recommendation_preview_batches
  for select to openspell_recommendation_executor using (true);

grant select, insert on public.recommendations to openspell_recommendation_executor;
create policy recommendation_executor_select on public.recommendations
  for select to openspell_recommendation_executor using (true);
create policy recommendation_executor_insert on public.recommendations
  for insert to openspell_recommendation_executor with check (true);

grant insert on public.audit_log to openspell_recommendation_executor;
grant usage, select on sequence public.audit_log_id_seq to openspell_recommendation_executor;
create policy recommendation_executor_insert on public.audit_log
  for insert to openspell_recommendation_executor with check (true);

-- Read-only inputs used by the fenced execution RPCs. The executor has no
-- direct login, and the RPCs close every read to the exact claim tenant.
grant select on table
  public.ad_profiles,
  public.fact_sp_target_daily,
  public.fact_sb_daily,
  public.fact_sd_daily,
  public.fact_profile_daily,
  public.campaigns,
  public.ad_groups,
  public.keywords,
  public.targets,
  public.product_ads,
  public.rank_observations,
  public.bid_series_daily,
  public.apply_rows,
  public.apply_batches,
  public.recommendation_observations
to openspell_recommendation_executor;

create policy recommendation_executor_select on public.ad_profiles
  for select to openspell_recommendation_executor using (true);
create policy recommendation_executor_select on public.fact_sp_target_daily
  for select to openspell_recommendation_executor using (true);
create policy recommendation_executor_select on public.fact_sb_daily
  for select to openspell_recommendation_executor using (true);
create policy recommendation_executor_select on public.fact_sd_daily
  for select to openspell_recommendation_executor using (true);
create policy recommendation_executor_select on public.fact_profile_daily
  for select to openspell_recommendation_executor using (true);
create policy recommendation_executor_select on public.campaigns
  for select to openspell_recommendation_executor using (true);
create policy recommendation_executor_select on public.ad_groups
  for select to openspell_recommendation_executor using (true);
create policy recommendation_executor_select on public.keywords
  for select to openspell_recommendation_executor using (true);
create policy recommendation_executor_select on public.targets
  for select to openspell_recommendation_executor using (true);
create policy recommendation_executor_select on public.product_ads
  for select to openspell_recommendation_executor using (true);
create policy recommendation_executor_select on public.rank_observations
  for select to openspell_recommendation_executor using (true);
create policy recommendation_executor_select on public.bid_series_daily
  for select to openspell_recommendation_executor using (true);
create policy recommendation_executor_select on public.apply_rows
  for select to openspell_recommendation_executor using (true);
create policy recommendation_executor_select on public.apply_batches
  for select to openspell_recommendation_executor using (true);
create policy recommendation_executor_select on public.recommendation_observations
  for select to openspell_recommendation_executor using (true);

-- -------------------------------------------------------------------------
-- Private scope, lineage and authority helpers
-- -------------------------------------------------------------------------

create function app.recommendation_authority_snapshot()
returns table (
  protocol text,
  admission text,
  epoch bigint,
  authorized_revision text
)
language plpgsql
security definer
set search_path = pg_catalog, app, pg_temp
as $$
begin
  if session_user::text <> 'openspell_recommendation_worker' then
    raise exception 'recommendation authority snapshot is recommendation-worker only'
      using errcode = '42501';
  end if;

  return query
  select authority.protocol, authority.admission, authority.epoch,
         authority.authorized_revision
    from app.recommendation_claim_authority authority
   where authority.singleton
   for share;

  if not found then
    raise exception 'recommendation claim authority is unavailable' using errcode = '55000';
  end if;
end;
$$;

revoke all on function app.recommendation_authority_snapshot() from public;
revoke all on function app.recommendation_authority_snapshot() from anon;
revoke all on function app.recommendation_authority_snapshot() from authenticated;
revoke all on function app.recommendation_authority_snapshot() from service_role;
grant execute on function app.recommendation_authority_snapshot()
  to openspell_recommendation_executor;

create function app.recommendation_job_scope_closes(p_job_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_job public.sync_jobs;
  v_run public.recommendation_runs;
  v_campaign_ids text[];
  v_scope_count integer;
  v_batch record;
begin
  select * into v_job
    from public.sync_jobs job
   where job.id = p_job_id
     and job.job_type = 'recommendations.run';
  if not found
     or pg_catalog.jsonb_typeof(v_job.payload) <> 'object'
     or v_job.payload ->> 'type' <> 'recommendations.run'
     or v_job.payload ->> 'orgId' <> v_job.org_id::text
     or v_job.payload ->> 'profileId' <> v_job.profile_id::text
     or not coalesce((v_job.payload ->> 'runId') ~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false)
     or not coalesce((v_job.payload ->> 'lookbackDays') ~ '^[1-9][0-9]*$', false)
     or (v_job.payload ->> 'lookbackDays')::integer > 366 then
    return false;
  end if;

  select * into v_run
    from public.recommendation_runs run
   where run.id = (v_job.payload ->> 'runId')::uuid
     and run.org_id = v_job.org_id
     and run.profile_id = v_job.profile_id
     and run.job_id = v_job.id;
  if not found
     -- WP-195 producers predate the marker column. A structurally complete
     -- scoped run is queue lineage unless it is explicitly marked human.
     or v_run.execution_lineage is not distinct from 'human'
     or v_run.scope_version <> 1
     or v_run.scope_count is null
     or v_run.scope_count not between 1 and 10000
     or v_run.scope_fingerprint is null
     or v_run.strategy_snapshot is null
     or nullif(pg_catalog.btrim(v_run.strategy_goal), '') is null
     or v_run.lookback_days <> (v_job.payload ->> 'lookbackDays')::integer
     or coalesce(v_job.payload ->> 'groupId', '')
        <> coalesce(v_run.group_id::text, '') then
    return false;
  end if;

  select pg_catalog.count(*)::integer,
         coalesce(
           pg_catalog.array_agg(scope.campaign_id order by scope.campaign_id collate "C"),
           array[]::text[]
         )
    into v_scope_count, v_campaign_ids
    from public.recommendation_run_campaigns scope
   where scope.org_id = v_run.org_id
     and scope.profile_id = v_run.profile_id
     and scope.run_id = v_run.id
     and scope.batch_id is not distinct from v_run.batch_id;

  if v_scope_count <> v_run.scope_count
     or v_scope_count <> pg_catalog.cardinality(v_campaign_ids)
     or v_run.scope_fingerprint <>
       app.recommendation_run_scope_fingerprint(
         v_run.profile_id, v_run.group_id, v_campaign_ids
       ) then
    return false;
  end if;

  if v_run.batch_id is null then
    return true;
  end if;

  select batch.scope_count, batch.scope_fingerprint, batch.child_count,
         pg_catalog.count(distinct child.id)::integer as actual_children,
         pg_catalog.count(member.campaign_id)::integer as actual_campaigns,
         coalesce(
           pg_catalog.array_agg(member.campaign_id order by member.campaign_id collate "C"),
           array[]::text[]
         ) as campaign_ids,
         pg_catalog.count(distinct child.job_id)::integer as actual_jobs,
         pg_catalog.bool_and(
           child.execution_lineage is distinct from 'human'
           and child.scope_version = 1
           and child.job_id is not null
         ) as children_scoped
    into v_batch
    from public.recommendation_preview_batches batch
    join public.recommendation_runs child
      on child.org_id = batch.org_id
     and child.profile_id = batch.profile_id
     and child.batch_id = batch.id
    join public.recommendation_run_campaigns member
      on member.org_id = child.org_id
     and member.profile_id = child.profile_id
     and member.run_id = child.id
     and member.batch_id = child.batch_id
   where batch.id = v_run.batch_id
     and batch.org_id = v_run.org_id
     and batch.profile_id = v_run.profile_id
   group by batch.scope_count, batch.scope_fingerprint, batch.child_count;

  if not found
     or not coalesce(v_batch.children_scoped, false)
     or v_batch.actual_children <> v_batch.child_count
     or v_batch.actual_jobs <> v_batch.child_count
     or v_batch.actual_campaigns <> v_batch.scope_count
     or v_batch.scope_fingerprint <>
       app.recommendation_batch_scope_fingerprint(v_run.profile_id, v_batch.campaign_ids) then
    return false;
  end if;

  return true;
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return false;
end;
$$;

revoke all on function app.recommendation_job_scope_closes(uuid) from public;

create function app.recommendation_job_scope_is_current(p_job_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_current boolean;
begin
  if not app.recommendation_job_scope_closes(p_job_id) then
    return false;
  end if;
  select run.execution_lineage = 'queue'
         and not exists (
           select 1
             from public.recommendation_runs child
            where run.batch_id is not null
              and child.org_id = run.org_id
              and child.profile_id = run.profile_id
              and child.batch_id = run.batch_id
              and child.execution_lineage is distinct from 'queue'
         )
    into v_current
    from public.recommendation_runs run
   where run.job_id = p_job_id;
  return coalesce(v_current, false);
end;
$$;

revoke all on function app.recommendation_job_scope_is_current(uuid) from public;

create function app.recommendation_run_is_provisional_human(p_run_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce((
    select (
         run.execution_lineage = 'human'
         or (
           run.execution_lineage is null
           and run.engine_version = 'ngram-explorer'
           and run.started_at = run.finished_at
         )
       )
       and run.scope_version is null
       and run.scope_count is null
       and run.scope_fingerprint is null
       and run.batch_id is null
       and run.job_id is null
       and run.group_id is null
       and run.status = 'succeeded'
       and run.proposals_count > 0
       and run.started_at is not null
       and run.finished_at is not null
      from public.recommendation_runs run
     where run.id = p_run_id
  ), false);
$$;

revoke all on function app.recommendation_run_is_provisional_human(uuid) from public;

create function app.assert_recommendation_human_lineage(
  p_run_id uuid,
  p_require_human boolean
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_run public.recommendation_runs;
  v_proposals integer;
  v_valid_proposals integer;
  v_audits integer;
begin
  select * into v_run
    from public.recommendation_runs run
   where run.id = p_run_id
   for share;
  if not found then
    return;
  end if;
  if not app.recommendation_run_is_provisional_human(v_run.id) then
    if not p_require_human then
      return;
    end if;
    raise exception 'human recommendation lineage has an invalid run shape'
      using errcode = '23514';
  end if;

  if exists (
    select 1
      from public.sync_jobs job
     where job.job_type = 'recommendations.run'
       and job.org_id = v_run.org_id
       and job.profile_id = v_run.profile_id
       and job.payload ->> 'runId' = v_run.id::text
  ) then
    raise exception 'human recommendation lineage cannot be queue linked'
      using errcode = '23514';
  end if;

  select pg_catalog.count(*)::integer,
         pg_catalog.count(*) filter (
           where recommendation.reason = 'flag'
             and recommendation.entity_type = 'negative'
             and recommendation.ad_product = 'SP'
             and recommendation.field = 'negative_keyword'
             and recommendation.status = 'proposed'
         )::integer
    into v_proposals, v_valid_proposals
    from public.recommendations recommendation
   where recommendation.run_id = v_run.id
     and recommendation.org_id = v_run.org_id
     and recommendation.profile_id = v_run.profile_id;

  select pg_catalog.count(*)::integer into v_audits
    from public.audit_log audit
   where audit.org_id = v_run.org_id
     and audit.actor_type = 'user'
     and audit.action = 'recommendation.proposed'
     and audit.target_type = 'recommendation_run'
     and audit.target_id = v_run.id::text
     and audit.source = 'web'
     and audit.payload ->> 'source' = 'ngram-explorer'
     and audit.payload ->> 'proposals' = v_run.proposals_count::text;

  if v_proposals <> v_run.proposals_count
     or v_valid_proposals <> v_proposals
     or v_audits <> 1 then
    raise exception 'human recommendation lineage is incomplete or mixed'
      using errcode = '23514';
  end if;

  return;
end;
$$;

revoke all on function app.assert_recommendation_human_lineage(uuid, boolean) from public;

create function app.validate_recommendation_human_lineage()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
begin
  perform app.assert_recommendation_human_lineage(
    new.id,
    new.execution_lineage is not distinct from 'human'
  );
  return null;
end;
$$;

revoke all on function app.validate_recommendation_human_lineage() from public;

create constraint trigger recommendation_runs_human_lineage_validate
  after insert or update on public.recommendation_runs
  deferrable initially deferred
  for each row execute function app.validate_recommendation_human_lineage();

create function app.validate_recommendation_human_child_lineage()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
begin
  if tg_op <> 'DELETE' then
    perform app.assert_recommendation_human_lineage(new.run_id, false);
  end if;
  if tg_op <> 'INSERT' and (
    tg_op = 'DELETE' or old.run_id is distinct from new.run_id
  ) then
    perform app.assert_recommendation_human_lineage(old.run_id, false);
  end if;
  return null;
end;
$$;

revoke all on function app.validate_recommendation_human_child_lineage() from public;

create constraint trigger recommendations_human_lineage_insert_delete_validate
  after insert or delete on public.recommendations
  deferrable initially deferred
  for each row execute function app.validate_recommendation_human_child_lineage();

create constraint trigger recommendations_human_lineage_structure_validate
  after update of run_id, org_id, profile_id, reason, entity_type, entity_id,
    ad_product, campaign_id, ad_group_id, entity_name, field, current_value,
    proposed_value, inputs
  on public.recommendations
  deferrable initially deferred
  for each row execute function app.validate_recommendation_human_child_lineage();

create function app.validate_recommendation_human_audit_lineage()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
begin
  if tg_op <> 'DELETE'
     and new.actor_type = 'user'
     and new.action = 'recommendation.proposed'
     and new.target_type = 'recommendation_run'
     and new.source = 'web'
     and new.payload ->> 'source' = 'ngram-explorer'
     and new.target_id ~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    perform app.assert_recommendation_human_lineage(new.target_id::uuid, false);
  end if;
  if tg_op <> 'INSERT'
     and old.actor_type = 'user'
     and old.action = 'recommendation.proposed'
     and old.target_type = 'recommendation_run'
     and old.source = 'web'
     and old.payload ->> 'source' = 'ngram-explorer'
     and old.target_id ~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     and (tg_op = 'DELETE' or old.id is distinct from new.id
          or old.org_id is distinct from new.org_id
          or old.actor_type is distinct from new.actor_type
          or old.action is distinct from new.action
          or old.target_type is distinct from new.target_type
          or old.target_id is distinct from new.target_id
          or old.payload is distinct from new.payload
          or old.source is distinct from new.source) then
    perform app.assert_recommendation_human_lineage(old.target_id::uuid, false);
  end if;
  return null;
end;
$$;

revoke all on function app.validate_recommendation_human_audit_lineage() from public;

create constraint trigger audit_log_human_lineage_validate
  after insert or update or delete on public.audit_log
  deferrable initially deferred
  for each row execute function app.validate_recommendation_human_audit_lineage();

-- -------------------------------------------------------------------------
-- Admission and old-writer serialization
-- -------------------------------------------------------------------------

-- PostgreSQL acquires target-row locks before a BEFORE ROW trigger runs. The
-- unconditional statement trigger is therefore the lock-order primitive:
-- authority first, then every job/run/result row touched by the statement.
create function app.prelock_recommendation_authority()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, app, pg_temp
as $$
begin
  perform 1
    from app.recommendation_claim_authority authority
   where authority.singleton
   for share;
  if not found then
    raise exception 'recommendation claim authority is unavailable' using errcode = '55000';
  end if;
  return null;
end;
$$;

revoke all on function app.prelock_recommendation_authority() from public;

create trigger a_recommendation_authority_prelock
  before insert or update on public.sync_jobs
  for each statement execute function app.prelock_recommendation_authority();

create trigger a_recommendation_authority_prelock
  before update on public.recommendation_runs
  for each statement execute function app.prelock_recommendation_authority();

create trigger a_recommendation_authority_prelock
  before insert on public.recommendations
  for each statement execute function app.prelock_recommendation_authority();

create trigger a_recommendation_authority_prelock
  before insert on public.audit_log
  for each statement execute function app.prelock_recommendation_authority();

create function app.guard_recommendation_job_admission()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_admission text;
begin
  if tg_op = 'UPDATE' then
    if old.job_type <> 'recommendations.run' and new.job_type <> 'recommendations.run' then
      return new;
    end if;
  elsif new.job_type <> 'recommendations.run' then
    return new;
  end if;

  select authority.admission into v_admission
    from app.recommendation_claim_authority authority
   where authority.singleton
   for share;
  if not found then
    raise exception 'recommendation claim authority is unavailable' using errcode = '55000';
  end if;

  if tg_op = 'UPDATE' and (
    old.id is distinct from new.id
    or old.org_id is distinct from new.org_id
    or old.profile_id is distinct from new.profile_id
    or old.job_type is distinct from new.job_type
    or old.payload is distinct from new.payload
  ) then
    raise exception 'recommendation job identity is immutable' using errcode = '23514';
  end if;

  if v_admission = 'blocked' and new.job_type = 'recommendations.run' then
    raise exception 'recommendation admission is blocked' using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function app.guard_recommendation_job_admission() from public;

create trigger sync_jobs_recommendation_admission_gate
  before insert or update of id, org_id, profile_id, job_type, payload
  on public.sync_jobs
  for each row execute function app.guard_recommendation_job_admission();

create function app.validate_recommendation_job_admission()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_admission text;
  v_run public.recommendation_runs;
begin
  if new.job_type <> 'recommendations.run' then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.id = new.id and old.org_id = new.org_id
     and old.profile_id = new.profile_id and old.job_type = new.job_type
     and old.payload = new.payload then
    return null;
  end if;

  select authority.admission into v_admission
    from app.recommendation_claim_authority authority
   where authority.singleton;
  if not found then
    raise exception 'recommendation claim authority is unavailable' using errcode = '55000';
  end if;

  if v_admission = 'blocked' then
    raise exception 'recommendation admission is blocked' using errcode = '55000';
  elsif v_admission = 'scoped' then
    if not app.recommendation_job_scope_is_current(new.id) then
      raise exception 'scoped recommendation admission evidence does not close'
        using errcode = '23514';
    end if;
  else
    begin
      select * into strict v_run
        from public.recommendation_runs run
       where run.id = (new.payload ->> 'runId')::uuid
         and run.org_id = new.org_id
         and run.profile_id = new.profile_id;
    exception
      when no_data_found or too_many_rows or invalid_text_representation then
        raise exception 'legacy recommendation admission evidence does not close'
          using errcode = '23514';
    end;
    -- Legacy admission is compatibility mode, not a legacy-shape-only mode.
    -- WP-195 already emits exact scope-v1 work before this migration lands, so
    -- preserve both its closed scoped shape and the historical unscoped shape.
    if v_run.scope_version is not null or v_run.batch_id is not null or v_run.job_id is not null then
      if not app.recommendation_job_scope_closes(new.id) then
        raise exception 'legacy scoped recommendation admission evidence does not close'
          using errcode = '23514';
      end if;
    end if;
  end if;
  return null;
end;
$$;

revoke all on function app.validate_recommendation_job_admission() from public;

create constraint trigger sync_jobs_recommendation_admission_validate
  after insert or update on public.sync_jobs
  deferrable initially deferred
  for each row execute function app.validate_recommendation_job_admission();

create function app.guard_recommendation_run_execution()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_protocol text;
begin
  if old.execution_lineage is distinct from new.execution_lineage then
    raise exception 'recommendation execution lineage is immutable' using errcode = '23514';
  end if;
  select authority.protocol into v_protocol
    from app.recommendation_claim_authority authority
   where authority.singleton
   for share;
  if not found then
    raise exception 'recommendation claim authority is unavailable' using errcode = '55000';
  end if;
  if v_protocol = 'fenced'
     and session_user::text <> 'openspell_recommendation_worker' then
    raise exception 'fenced recommendation run mutation requires narrow custody'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function app.guard_recommendation_run_execution() from public;

create trigger recommendation_runs_execution_guard
  before update on public.recommendation_runs
  for each row execute function app.guard_recommendation_run_execution();

create function app.guard_recommendation_insert()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_protocol text;
begin
  if app.recommendation_run_is_provisional_human(new.run_id) then
    if exists (
      select 1
        from public.audit_log audit
       where audit.org_id = new.org_id
         and audit.actor_type = 'user'
         and audit.action = 'recommendation.proposed'
         and audit.target_type = 'recommendation_run'
         and audit.target_id = new.run_id::text
         and audit.source = 'web'
         and audit.payload ->> 'source' = 'ngram-explorer'
         and audit.xmin::text <> pg_catalog.pg_current_xact_id()::text
    ) then
      raise exception 'committed human recommendation runs cannot accept later proposals'
        using errcode = '23514';
    end if;
    return new;
  end if;
  select authority.protocol into v_protocol
    from app.recommendation_claim_authority authority
   where authority.singleton
   for share;
  if not found then
    raise exception 'recommendation claim authority is unavailable' using errcode = '55000';
  end if;
  if v_protocol = 'fenced'
     and session_user::text <> 'openspell_recommendation_worker' then
    raise exception 'fenced recommendation insert requires narrow custody'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function app.guard_recommendation_insert() from public;

create trigger recommendations_execution_guard
  before insert on public.recommendations
  for each row execute function app.guard_recommendation_insert();

create function app.guard_recommendation_execution_audit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_protocol text;
  v_run_id uuid;
begin
  if new.actor_type = 'user'
     and new.action = 'recommendation.proposed'
     and new.target_type = 'recommendation_run'
     and new.source = 'web'
     and new.payload ->> 'source' = 'ngram-explorer'
     and new.target_id ~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     and app.recommendation_run_is_provisional_human(new.target_id::uuid) then
    if exists (
      select 1
        from public.audit_log audit
       where audit.org_id = new.org_id
         and audit.actor_type = 'user'
         and audit.action = 'recommendation.proposed'
         and audit.target_type = 'recommendation_run'
         and audit.target_id = new.target_id
         and audit.source = 'web'
         and audit.payload ->> 'source' = 'ngram-explorer'
    ) then
      raise exception 'human recommendation lineage requires exactly one provenance audit'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.action not in (
    'recommendation.preconditions.noted',
    'recommendation.run.succeeded',
    'recommendation.run.failed'
  ) then
    return new;
  end if;

  if new.target_type = 'recommendation_run'
     and new.target_id ~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    v_run_id := new.target_id::uuid;
  elsif new.target_type = 'recommendation'
        and new.target_id ~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    select recommendation.run_id into v_run_id
      from public.recommendations recommendation
     where recommendation.id = new.target_id::uuid;
  end if;

  if v_run_id is not null and app.recommendation_run_is_provisional_human(v_run_id) then
    return new;
  end if;

  select authority.protocol into v_protocol
    from app.recommendation_claim_authority authority
   where authority.singleton
   for share;
  if not found then
    raise exception 'recommendation claim authority is unavailable' using errcode = '55000';
  end if;
  if v_protocol = 'fenced'
     and session_user::text <> 'openspell_recommendation_worker' then
    raise exception 'fenced recommendation audit requires narrow custody'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function app.guard_recommendation_execution_audit() from public;

create trigger audit_log_recommendation_execution_guard
  before insert on public.audit_log
  for each row execute function app.guard_recommendation_execution_audit();

-- -------------------------------------------------------------------------
-- Preserve legacy lanes while excluding recommendation custody after fence
-- -------------------------------------------------------------------------

create or replace function public.claim_sync_jobs(p_worker_id text, p_limit integer)
returns setof public.sync_jobs
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_report_protocol text;
  v_recommendation_protocol text;
  v_report_types public.sync_job_type[] := array[
    'creative.sync', 'report.request', 'report.poll', 'report.fetch'
  ]::public.sync_job_type[];
begin
  perform app.assert_service_role('claim_sync_jobs');
  if p_worker_id is null or length(p_worker_id) = 0 then
    raise exception 'claim_sync_jobs needs a worker id' using errcode = '22023';
  end if;

  select authority.protocol into v_report_protocol
    from app.report_worker_claim_authority authority
   where authority.singleton for share;
  if not found then
    raise exception 'report worker claim authority is unavailable' using errcode = '55000';
  end if;
  select authority.protocol into v_recommendation_protocol
    from app.recommendation_claim_authority authority
   where authority.singleton for share;
  if not found then
    raise exception 'recommendation claim authority is unavailable' using errcode = '55000';
  end if;

  return query
  update public.sync_jobs job
     set status = 'running', claimed_by = p_worker_id, claimed_at = now(),
         started_at = coalesce(job.started_at, now()), attempts = job.attempts + 1,
         updated_at = now()
   where job.id in (
     select candidate.id
       from public.sync_jobs candidate
      where candidate.status = 'queued'
        and candidate.claim_token is null
        and candidate.run_after <= now()
        and (v_report_protocol = 'legacy' or candidate.job_type <> all(v_report_types))
        and (v_recommendation_protocol = 'legacy'
             or candidate.job_type <> 'recommendations.run')
      order by candidate.priority desc, candidate.run_after, candidate.created_at
      limit greatest(coalesce(p_limit, 0), 0)
      for update skip locked
   )
  returning job.*;
end;
$$;

create or replace function public.claim_sync_jobs(
  p_worker_id text,
  p_limit integer,
  p_job_types public.sync_job_type[]
)
returns setof public.sync_jobs
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_report_protocol text;
  v_recommendation_protocol text;
  v_report_types public.sync_job_type[] := array[
    'creative.sync', 'report.request', 'report.poll', 'report.fetch'
  ]::public.sync_job_type[];
begin
  perform app.assert_service_role('claim_sync_jobs');
  if p_worker_id is null or length(p_worker_id) = 0 then
    raise exception 'claim_sync_jobs needs a worker id' using errcode = '22023';
  end if;

  select authority.protocol into v_report_protocol
    from app.report_worker_claim_authority authority
   where authority.singleton for share;
  if not found then
    raise exception 'report worker claim authority is unavailable' using errcode = '55000';
  end if;
  select authority.protocol into v_recommendation_protocol
    from app.recommendation_claim_authority authority
   where authority.singleton for share;
  if not found then
    raise exception 'recommendation claim authority is unavailable' using errcode = '55000';
  end if;

  return query
  update public.sync_jobs job
     set status = 'running', claimed_by = p_worker_id, claimed_at = now(),
         started_at = coalesce(job.started_at, now()), attempts = job.attempts + 1,
         updated_at = now()
   where job.id in (
     select candidate.id
       from public.sync_jobs candidate
      where candidate.status = 'queued'
        and candidate.claim_token is null
        and candidate.run_after <= now()
        and (p_job_types is null or candidate.job_type = any(p_job_types))
        and (v_report_protocol = 'legacy' or candidate.job_type <> all(v_report_types))
        and (v_recommendation_protocol = 'legacy'
             or candidate.job_type <> 'recommendations.run')
      order by candidate.priority desc, candidate.run_after, candidate.created_at
      limit greatest(coalesce(p_limit, 0), 0)
      for update skip locked
   )
  returning job.*;
end;
$$;

create or replace function public.finish_sync_job(
  p_job_id uuid,
  p_status public.sync_job_status,
  p_error text default null,
  p_result jsonb default null,
  p_retry_in interval default null
)
returns public.sync_jobs
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_job public.sync_jobs;
  v_report_protocol text;
  v_recommendation_protocol text;
  v_report_types public.sync_job_type[] := array[
    'creative.sync', 'report.request', 'report.poll', 'report.fetch'
  ]::public.sync_job_type[];
begin
  perform app.assert_service_role('finish_sync_job');

  select authority.protocol into v_report_protocol
    from app.report_worker_claim_authority authority
   where authority.singleton for share;
  if not found then
    raise exception 'report worker claim authority is unavailable' using errcode = '55000';
  end if;
  select authority.protocol into v_recommendation_protocol
    from app.recommendation_claim_authority authority
   where authority.singleton for share;
  if not found then
    raise exception 'recommendation claim authority is unavailable' using errcode = '55000';
  end if;

  select * into v_job from public.sync_jobs
   where id = p_job_id and status = 'running' and claim_token is null
   for update;
  if not found then
    raise exception 'legacy finish requires running tokenless custody' using errcode = '55000';
  end if;
  if (v_report_protocol = 'fenced' and v_job.job_type = any(v_report_types))
     or (v_recommendation_protocol = 'fenced'
         and v_job.job_type = 'recommendations.run') then
    raise exception 'legacy finish is not authoritative for fenced custody'
      using errcode = '55000';
  end if;

  if p_status = 'failed' and v_job.attempts >= v_job.max_attempts then
    update public.sync_jobs
       set status = 'dead', last_error = p_error, result = coalesce(p_result, result),
           finished_at = now()
     where id = p_job_id and status = 'running' and claim_token is null
    returning * into v_job;
  elsif p_status = 'failed' then
    update public.sync_jobs
       set status = 'queued', last_error = p_error, result = coalesce(p_result, result),
           claimed_by = null, claimed_at = null,
           run_after = now() + coalesce(p_retry_in, interval '1 minute')
     where id = p_job_id and status = 'running' and claim_token is null
    returning * into v_job;
  else
    update public.sync_jobs
       set status = p_status, last_error = p_error, result = coalesce(p_result, result),
           finished_at = now()
     where id = p_job_id and status = 'running' and claim_token is null
    returning * into v_job;
  end if;
  return v_job;
end;
$$;

create or replace function public.requeue_stale_sync_jobs(
  p_older_than interval default interval '30 minutes'
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_count integer;
  v_report_protocol text;
  v_recommendation_protocol text;
  v_report_types public.sync_job_type[] := array[
    'creative.sync', 'report.request', 'report.poll', 'report.fetch'
  ]::public.sync_job_type[];
begin
  perform app.assert_service_role('requeue_stale_sync_jobs');
  select authority.protocol into v_report_protocol
    from app.report_worker_claim_authority authority
   where authority.singleton for share;
  if not found then
    raise exception 'report worker claim authority is unavailable' using errcode = '55000';
  end if;
  select authority.protocol into v_recommendation_protocol
    from app.recommendation_claim_authority authority
   where authority.singleton for share;
  if not found then
    raise exception 'recommendation claim authority is unavailable' using errcode = '55000';
  end if;

  with revived as (
    update public.sync_jobs
       set status = (case when attempts >= max_attempts then 'dead' else 'queued' end)::public.sync_job_status,
           claimed_by = null, claimed_at = null,
           last_error = coalesce(last_error, 'reclaimed: worker went away'),
           run_after = now()
     where status = 'running'
       and claim_token is null
       and (v_report_protocol = 'legacy' or job_type <> all(v_report_types))
       and (v_recommendation_protocol = 'legacy' or job_type <> 'recommendations.run')
       and claimed_at < now() - p_older_than
    returning 1
  )
  select count(*)::integer into v_count from revived;
  return v_count;
end;
$$;

-- -------------------------------------------------------------------------
-- Read-only authority evidence and explicit compare-and-set transitions
-- -------------------------------------------------------------------------

create function public.get_recommendation_claim_authority()
returns table (
  protocol text,
  admission text,
  epoch bigint,
  authorized_revision text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
begin
  if session_user::text <> 'openspell_recommendation_worker' then
    perform app.assert_service_role('get_recommendation_claim_authority');
  end if;
  return query
  select authority.protocol, authority.admission, authority.epoch,
         authority.authorized_revision
    from app.recommendation_claim_authority authority
   where authority.singleton;
  if not found then
    raise exception 'recommendation claim authority is unavailable' using errcode = '55000';
  end if;
end;
$$;

create function public.get_recommendation_cutover_evidence()
returns table (
  protocol text,
  admission text,
  epoch bigint,
  authorized_revision text,
  queued_jobs integer,
  running_jobs integer,
  token_bearing_jobs integer,
  invalid_active_scopes integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
begin
  if session_user::text <> 'openspell_recommendation_worker' then
    raise exception 'recommendation cutover evidence is recommendation-worker only'
      using errcode = '42501';
  end if;
  return query
  select authority.protocol, authority.admission, authority.epoch,
         authority.authorized_revision,
         pg_catalog.count(*) filter (where job.status = 'queued')::integer,
         pg_catalog.count(*) filter (where job.status = 'running')::integer,
         pg_catalog.count(*) filter (where job.claim_token is not null)::integer,
         pg_catalog.count(*) filter (
           where job.status in ('queued', 'running')
             and not app.recommendation_job_scope_is_current(job.id)
         )::integer
    from app.recommendation_claim_authority authority
    left join public.sync_jobs job on job.job_type = 'recommendations.run'
   where authority.singleton
   group by authority.protocol, authority.admission, authority.epoch,
            authority.authorized_revision;
  if not found then
    raise exception 'recommendation cutover evidence is unavailable' using errcode = '55000';
  end if;
end;
$$;

create function public.get_recommendation_worker_authority()
returns table (
  protocol text,
  admission text,
  epoch bigint,
  authorized_revision text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, app, pg_temp
as $$
begin
  if session_user::text <> 'openspell_recommendation_worker' then
    raise exception 'recommendation runtime authority is recommendation-worker only'
      using errcode = '42501';
  end if;
  return query
  select authority.protocol, authority.admission, authority.epoch,
         authority.authorized_revision
    from app.recommendation_claim_authority authority
   where authority.singleton;
  if not found then
    raise exception 'recommendation claim authority is unavailable' using errcode = '55000';
  end if;
end;
$$;

create function public.block_recommendation_admission(p_expected_epoch bigint)
returns table (
  decision text,
  protocol text,
  admission text,
  epoch bigint,
  authorized_revision text,
  unresolved integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_authority app.recommendation_claim_authority;
begin
  perform app.assert_service_role('block_recommendation_admission');
  if p_expected_epoch is null or p_expected_epoch < 0 then
    raise exception 'expected recommendation authority epoch is invalid' using errcode = '22023';
  end if;
  select * into v_authority from app.recommendation_claim_authority
   where singleton for update;
  if not found then
    raise exception 'recommendation claim authority is unavailable' using errcode = '55000';
  end if;
  if v_authority.epoch <> p_expected_epoch then
    return query select 'stale_epoch', v_authority.protocol, v_authority.admission,
      v_authority.epoch, v_authority.authorized_revision, 0;
    return;
  end if;
  if v_authority.admission = 'blocked' then
    return query select 'already_blocked', v_authority.protocol, v_authority.admission,
      v_authority.epoch, v_authority.authorized_revision, 0;
    return;
  end if;
  update app.recommendation_claim_authority authority
     set admission = 'blocked', epoch = authority.epoch + 1, updated_at = now()
   where authority.singleton
  returning authority.* into v_authority;
  return query select 'blocked', v_authority.protocol, v_authority.admission,
    v_authority.epoch, v_authority.authorized_revision, 0;
end;
$$;

create function public.activate_recommendation_fenced_claims(
  p_expected_epoch bigint,
  p_revision text
)
returns table (
  decision text,
  protocol text,
  admission text,
  epoch bigint,
  authorized_revision text,
  unresolved integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_authority app.recommendation_claim_authority;
  v_unresolved integer;
begin
  perform app.assert_service_role('activate_recommendation_fenced_claims');
  if p_expected_epoch is null or p_expected_epoch < 0
     or p_revision is null or p_revision !~ '^[0-9a-f]{40}$' then
    raise exception 'recommendation activation inputs are invalid' using errcode = '22023';
  end if;
  select * into v_authority from app.recommendation_claim_authority
   where singleton for update;
  if not found then
    raise exception 'recommendation claim authority is unavailable' using errcode = '55000';
  end if;
  if v_authority.epoch <> p_expected_epoch then
    return query select 'stale_epoch', v_authority.protocol, v_authority.admission,
      v_authority.epoch, v_authority.authorized_revision, 0;
    return;
  end if;
  if v_authority.protocol = 'fenced' then
    return query select
      case when v_authority.authorized_revision = p_revision
           then 'already_fenced' else 'revision_conflict' end,
      v_authority.protocol, v_authority.admission, v_authority.epoch,
      v_authority.authorized_revision, 0;
    return;
  end if;
  if v_authority.admission <> 'blocked' then
    return query select 'admission_not_blocked', v_authority.protocol,
      v_authority.admission, v_authority.epoch, v_authority.authorized_revision, 0;
    return;
  end if;
  select pg_catalog.count(*)::integer into v_unresolved
    from public.sync_jobs job
   where job.job_type = 'recommendations.run'
     and (job.status in ('queued', 'running') or job.claim_token is not null);
  if v_unresolved <> 0 then
    return query select 'unresolved', v_authority.protocol, v_authority.admission,
      v_authority.epoch, v_authority.authorized_revision, v_unresolved;
    return;
  end if;
  update app.recommendation_claim_authority authority
     set protocol = 'fenced', admission = 'blocked',
         authorized_revision = p_revision, epoch = authority.epoch + 1,
         updated_at = now()
   where authority.singleton
  returning authority.* into v_authority;
  return query select 'activated', v_authority.protocol, v_authority.admission,
    v_authority.epoch, v_authority.authorized_revision, 0;
end;
$$;

create function public.authorize_recommendation_scoped_admission(
  p_expected_epoch bigint,
  p_revision text
)
returns table (
  decision text,
  protocol text,
  admission text,
  epoch bigint,
  authorized_revision text,
  unresolved integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_authority app.recommendation_claim_authority;
  v_unresolved integer;
begin
  perform app.assert_service_role('authorize_recommendation_scoped_admission');
  if p_expected_epoch is null or p_expected_epoch < 0
     or p_revision is null or p_revision !~ '^[0-9a-f]{40}$' then
    raise exception 'recommendation admission inputs are invalid' using errcode = '22023';
  end if;
  select * into v_authority from app.recommendation_claim_authority
   where singleton for update;
  if not found then
    raise exception 'recommendation claim authority is unavailable' using errcode = '55000';
  end if;
  if v_authority.epoch <> p_expected_epoch then
    return query select 'stale_epoch', v_authority.protocol, v_authority.admission,
      v_authority.epoch, v_authority.authorized_revision, 0;
    return;
  end if;
  if v_authority.protocol <> 'fenced'
     or v_authority.authorized_revision is distinct from p_revision then
    return query select 'authority_mismatch', v_authority.protocol,
      v_authority.admission, v_authority.epoch, v_authority.authorized_revision, 0;
    return;
  end if;
  if v_authority.admission = 'scoped' then
    return query select 'already_scoped', v_authority.protocol,
      v_authority.admission, v_authority.epoch, v_authority.authorized_revision, 0;
    return;
  end if;
  if v_authority.admission <> 'blocked' then
    return query select 'admission_not_blocked', v_authority.protocol,
      v_authority.admission, v_authority.epoch, v_authority.authorized_revision, 0;
    return;
  end if;
  select pg_catalog.count(*)::integer into v_unresolved
    from public.sync_jobs job
   where job.job_type = 'recommendations.run'
     and (
       job.status = 'running' or job.claim_token is not null
       or (job.status = 'queued' and not app.recommendation_job_scope_is_current(job.id))
     );
  if v_unresolved <> 0 then
    return query select 'unresolved', v_authority.protocol, v_authority.admission,
      v_authority.epoch, v_authority.authorized_revision, v_unresolved;
    return;
  end if;
  update app.recommendation_claim_authority authority
     set admission = 'scoped', epoch = authority.epoch + 1, updated_at = now()
   where authority.singleton
  returning authority.* into v_authority;
  return query select 'authorized', v_authority.protocol, v_authority.admission,
    v_authority.epoch, v_authority.authorized_revision, 0;
end;
$$;

create function public.rebind_recommendation_fenced_revision(
  p_expected_epoch bigint,
  p_old_revision text,
  p_new_revision text
)
returns table (
  decision text,
  protocol text,
  admission text,
  epoch bigint,
  authorized_revision text,
  unresolved integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_authority app.recommendation_claim_authority;
  v_unresolved integer;
begin
  perform app.assert_service_role('rebind_recommendation_fenced_revision');
  if p_expected_epoch is null or p_expected_epoch < 0
     or p_old_revision is null or p_old_revision !~ '^[0-9a-f]{40}$'
     or p_new_revision is null or p_new_revision !~ '^[0-9a-f]{40}$'
     or p_old_revision = p_new_revision then
    raise exception 'recommendation revision rebind inputs are invalid' using errcode = '22023';
  end if;
  select * into v_authority from app.recommendation_claim_authority
   where singleton for update;
  if not found then
    raise exception 'recommendation claim authority is unavailable' using errcode = '55000';
  end if;
  if v_authority.epoch <> p_expected_epoch then
    return query select 'stale_epoch', v_authority.protocol, v_authority.admission,
      v_authority.epoch, v_authority.authorized_revision, 0;
    return;
  end if;
  if v_authority.protocol <> 'fenced'
     or v_authority.admission <> 'blocked'
     or v_authority.authorized_revision is distinct from p_old_revision then
    return query select 'authority_mismatch', v_authority.protocol,
      v_authority.admission, v_authority.epoch, v_authority.authorized_revision, 0;
    return;
  end if;
  select pg_catalog.count(*)::integer into v_unresolved
    from public.sync_jobs job
   where job.job_type = 'recommendations.run'
     and (
       job.status = 'running' or job.claim_token is not null
       or (job.status = 'queued' and not app.recommendation_job_scope_is_current(job.id))
     );
  if v_unresolved <> 0 then
    return query select 'unresolved', v_authority.protocol, v_authority.admission,
      v_authority.epoch, v_authority.authorized_revision, v_unresolved;
    return;
  end if;
  update app.recommendation_claim_authority authority
     set authorized_revision = p_new_revision, epoch = authority.epoch + 1,
         updated_at = now()
   where authority.singleton
  returning authority.* into v_authority;
  return query select 'rebound', v_authority.protocol, v_authority.admission,
    v_authority.epoch, v_authority.authorized_revision, 0;
end;
$$;

revoke all on function public.get_recommendation_claim_authority() from public, anon, authenticated;
grant execute on function public.get_recommendation_claim_authority()
  to service_role, openspell_recommendation_worker;
revoke all on function public.get_recommendation_cutover_evidence()
  from public, anon, authenticated, service_role;
grant execute on function public.get_recommendation_cutover_evidence()
  to openspell_recommendation_worker;
revoke all on function public.get_recommendation_worker_authority()
  from public, anon, authenticated, service_role;
grant execute on function public.get_recommendation_worker_authority()
  to openspell_recommendation_worker;
revoke all on function public.block_recommendation_admission(bigint) from public, anon, authenticated;
grant execute on function public.block_recommendation_admission(bigint) to service_role;
revoke all on function public.activate_recommendation_fenced_claims(bigint, text)
  from public, anon, authenticated;
grant execute on function public.activate_recommendation_fenced_claims(bigint, text) to service_role;
revoke all on function public.authorize_recommendation_scoped_admission(bigint, text)
  from public, anon, authenticated;
grant execute on function public.authorize_recommendation_scoped_admission(bigint, text)
  to service_role;
revoke all on function public.rebind_recommendation_fenced_revision(bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.rebind_recommendation_fenced_revision(bigint, text, text)
  to service_role;

-- -------------------------------------------------------------------------
-- Narrow recommendation queue custody (one non-expiring claim globally)
-- -------------------------------------------------------------------------

create function app.recommendation_authority_claim_snapshot()
returns table (
  protocol text,
  admission text,
  epoch bigint,
  authorized_revision text
)
language plpgsql
security definer
set search_path = pg_catalog, app, pg_temp
as $$
begin
  if session_user::text <> 'openspell_recommendation_worker' then
    raise exception 'recommendation claim authority is recommendation-worker only'
      using errcode = '42501';
  end if;
  return query
  select authority.protocol, authority.admission, authority.epoch,
         authority.authorized_revision
    from app.recommendation_claim_authority authority
   where authority.singleton
   for update;
  if not found then
    raise exception 'recommendation claim authority is unavailable' using errcode = '55000';
  end if;
end;
$$;

revoke all on function app.recommendation_authority_claim_snapshot() from public;
grant execute on function app.recommendation_authority_claim_snapshot()
  to openspell_recommendation_executor;

create function public.claim_recommendation_jobs_fenced(
  p_worker_id text,
  p_revision text,
  p_limit integer
)
returns table (
  id uuid,
  org_id uuid,
  profile_id uuid,
  job_type text,
  payload jsonb,
  attempts integer,
  max_attempts integer,
  dedupe_key text,
  claimed_by text,
  claim_token uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_authority record;
  v_active integer;
begin
  perform app.assert_recommendation_worker('claim_recommendation_jobs_fenced');
  if p_worker_id is null or pg_catalog.btrim(p_worker_id) = ''
     or pg_catalog.length(p_worker_id) > 128
     or p_revision is null or p_revision !~ '^[0-9a-f]{40}$'
     or p_limit is distinct from 1 then
    raise exception 'recommendation claim identity, revision or limit is invalid'
      using errcode = '22023';
  end if;
  select * into v_authority from app.recommendation_authority_claim_snapshot();
  if v_authority.protocol <> 'fenced'
     or v_authority.authorized_revision is distinct from p_revision then
    raise exception 'recommendation fenced claim authority does not match this worker'
      using errcode = '55000';
  end if;
  if v_authority.admission <> 'scoped' then
    return;
  end if;
  select pg_catalog.count(*)::integer into v_active
    from public.sync_jobs job
   where job.job_type = 'recommendations.run'
     and (job.status = 'running' or job.claim_token is not null);
  if v_active <> 0 then
    return;
  end if;

  return query
  update public.sync_jobs job
     set status = 'running', claimed_by = p_worker_id, claimed_at = now(),
         claim_token = pg_catalog.gen_random_uuid(),
         started_at = coalesce(job.started_at, now()), attempts = job.attempts + 1,
         updated_at = now()
   where job.id = (
     select candidate.id
       from public.sync_jobs candidate
      where candidate.job_type = 'recommendations.run'
        and candidate.status = 'queued'
        and candidate.claim_token is null
        and candidate.run_after <= now()
        and app.recommendation_job_scope_is_current(candidate.id)
      order by candidate.priority desc, candidate.run_after, candidate.created_at
      limit 1 for update skip locked
   )
  returning job.id, job.org_id, job.profile_id, job.job_type::text, job.payload,
            job.attempts, job.max_attempts, job.dedupe_key, job.claimed_by,
            job.claim_token;
end;
$$;

create function public.resume_recommendation_jobs_fenced(
  p_worker_id text,
  p_revision text
)
returns table (
  id uuid,
  org_id uuid,
  profile_id uuid,
  job_type text,
  payload jsonb,
  attempts integer,
  max_attempts integer,
  dedupe_key text,
  claimed_by text,
  claim_token uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_authority record;
  v_owned integer;
begin
  perform app.assert_recommendation_worker('resume_recommendation_jobs_fenced');
  if p_worker_id is null or pg_catalog.btrim(p_worker_id) = ''
     or pg_catalog.length(p_worker_id) > 128
     or p_revision is null or p_revision !~ '^[0-9a-f]{40}$' then
    raise exception 'recommendation resume identity or revision is invalid'
      using errcode = '22023';
  end if;
  select * into v_authority from app.recommendation_authority_snapshot();
  if v_authority.protocol <> 'fenced'
     or v_authority.authorized_revision is distinct from p_revision then
    raise exception 'recommendation fenced resume authority does not match this worker'
      using errcode = '55000';
  end if;
  select pg_catalog.count(*)::integer into v_owned
    from public.sync_jobs job
   where job.job_type = 'recommendations.run' and job.status = 'running'
     and job.claim_token is not null and job.claimed_by = p_worker_id;
  if v_owned > 1 then
    raise exception 'recommendation single-flight custody is violated' using errcode = '55000';
  end if;
  return query
  select job.id, job.org_id, job.profile_id, job.job_type::text, job.payload,
         job.attempts, job.max_attempts, job.dedupe_key, job.claimed_by,
         job.claim_token
    from public.sync_jobs job
   where job.job_type = 'recommendations.run' and job.status = 'running'
     and job.claim_token is not null and job.claimed_by = p_worker_id
     and app.recommendation_job_scope_is_current(job.id)
   order by job.claimed_at, job.id
   limit 1
   for update;
end;
$$;

create function public.finish_recommendation_job_fenced(
  p_job_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_revision text,
  p_status public.sync_job_status,
  p_error text default null,
  p_result jsonb default null,
  p_retry_in interval default null
)
returns table (decision text, status public.sync_job_status, attempts integer)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_authority record;
  v_job public.sync_jobs;
begin
  perform app.assert_recommendation_worker('finish_recommendation_job_fenced');
  if p_job_id is null or p_claim_token is null
     or p_worker_id is null or pg_catalog.btrim(p_worker_id) = ''
     or pg_catalog.length(p_worker_id) > 128
     or p_revision is null or p_revision !~ '^[0-9a-f]{40}$'
     or p_status is null or p_status not in ('succeeded', 'failed', 'dead')
     or pg_catalog.octet_length(coalesce(p_error, '')) > 4000
     or pg_catalog.octet_length(coalesce(p_result, 'null'::jsonb)::text) > 1048576
     or (p_retry_in is not null and (p_retry_in < interval '0' or p_retry_in > interval '1 day')) then
    raise exception 'recommendation settlement input is invalid' using errcode = '22023';
  end if;
  select * into v_authority from app.recommendation_authority_snapshot();
  if v_authority.protocol <> 'fenced'
     or v_authority.authorized_revision is distinct from p_revision then
    raise exception 'recommendation settlement authority does not match this worker'
      using errcode = '55000';
  end if;
  select * into v_job from public.sync_jobs job
   where job.id = p_job_id for update;
  if not found or v_job.job_type <> 'recommendations.run'
     or v_job.status <> 'running' or v_job.claim_token is null
     or v_job.claim_token is distinct from p_claim_token
     or v_job.claimed_by is distinct from p_worker_id
     or not app.recommendation_job_scope_is_current(v_job.id) then
    return query select 'stale_claim', null::public.sync_job_status, null::integer;
    return;
  end if;
  if p_status = 'failed' and v_job.attempts < v_job.max_attempts then
    update public.sync_jobs job
       set status = 'queued', last_error = p_error,
           result = coalesce(p_result, job.result), claimed_by = null,
           claimed_at = null, claim_token = null,
           run_after = now() + coalesce(p_retry_in, interval '1 minute'),
           updated_at = now()
     where job.id = p_job_id and job.status = 'running'
       and job.claim_token = p_claim_token and job.claimed_by = p_worker_id
    returning job.* into v_job;
  else
    update public.sync_jobs job
       set status = case when p_status = 'failed'
                         then 'dead'::public.sync_job_status else p_status end,
           last_error = p_error, result = coalesce(p_result, job.result),
           finished_at = now(), claim_token = null, updated_at = now()
     where job.id = p_job_id and job.status = 'running'
       and job.claim_token = p_claim_token and job.claimed_by = p_worker_id
    returning job.* into v_job;
  end if;
  if not found then
    return query select 'stale_claim', null::public.sync_job_status, null::integer;
  else
    return query select 'settled', v_job.status, v_job.attempts;
  end if;
end;
$$;

create function public.defer_recommendation_job_fenced(
  p_job_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_revision text,
  p_retry_in interval
)
returns table (decision text, status public.sync_job_status, attempts integer)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_authority record;
  v_job public.sync_jobs;
begin
  perform app.assert_recommendation_worker('defer_recommendation_job_fenced');
  if p_job_id is null or p_claim_token is null
     or p_worker_id is null or pg_catalog.btrim(p_worker_id) = ''
     or pg_catalog.length(p_worker_id) > 128
     or p_revision is null or p_revision !~ '^[0-9a-f]{40}$'
     or p_retry_in is null or p_retry_in < interval '0' or p_retry_in > interval '1 day' then
    raise exception 'recommendation defer input is invalid' using errcode = '22023';
  end if;
  select * into v_authority from app.recommendation_authority_snapshot();
  if v_authority.protocol <> 'fenced'
     or v_authority.authorized_revision is distinct from p_revision then
    raise exception 'recommendation defer authority does not match this worker'
      using errcode = '55000';
  end if;
  update public.sync_jobs job
     set status = 'queued', attempts = greatest(job.attempts - 1, 0),
         last_error = null, claimed_by = null, claimed_at = null,
         claim_token = null, run_after = now() + p_retry_in, updated_at = now()
   where job.id = p_job_id and job.job_type = 'recommendations.run'
     and job.status = 'running' and job.claim_token = p_claim_token
     and job.claimed_by = p_worker_id and app.recommendation_job_scope_is_current(job.id)
  returning job.* into v_job;
  if not found then
    return query select 'stale_claim', null::public.sync_job_status, null::integer;
  else
    return query select 'deferred', v_job.status, v_job.attempts;
  end if;
end;
$$;

alter function public.claim_recommendation_jobs_fenced(text, text, integer)
  owner to openspell_recommendation_executor;
alter function public.resume_recommendation_jobs_fenced(text, text)
  owner to openspell_recommendation_executor;
alter function public.finish_recommendation_job_fenced(
  uuid, text, uuid, text, public.sync_job_status, text, jsonb, interval
) owner to openspell_recommendation_executor;
alter function public.defer_recommendation_job_fenced(uuid, text, uuid, text, interval)
  owner to openspell_recommendation_executor;

revoke all on function public.claim_recommendation_jobs_fenced(text, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_recommendation_jobs_fenced(text, text, integer)
  to openspell_recommendation_worker;
revoke all on function public.resume_recommendation_jobs_fenced(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.resume_recommendation_jobs_fenced(text, text)
  to openspell_recommendation_worker;
revoke all on function public.finish_recommendation_job_fenced(
  uuid, text, uuid, text, public.sync_job_status, text, jsonb, interval
) from public, anon, authenticated, service_role;
grant execute on function public.finish_recommendation_job_fenced(
  uuid, text, uuid, text, public.sync_job_status, text, jsonb, interval
) to openspell_recommendation_worker;
revoke all on function public.defer_recommendation_job_fenced(uuid, text, uuid, text, interval)
  from public, anon, authenticated, service_role;
grant execute on function public.defer_recommendation_job_fenced(uuid, text, uuid, text, interval)
  to openspell_recommendation_worker;

grant execute on function app.recommendation_job_scope_closes(uuid)
  to openspell_recommendation_executor;
grant execute on function app.recommendation_job_scope_is_current(uuid)
  to openspell_recommendation_executor;

-- Lock and close the complete capability tuple in the global order
-- authority -> queue job -> immutable run/scope. Tenant inputs are evidence to
-- check, never authority used to choose a row.
create function app.lock_recommendation_claimed_run(
  p_job_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_revision text,
  p_org_id uuid,
  p_profile_id uuid,
  p_run_id uuid,
  p_group_id uuid
)
returns public.recommendation_runs
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_authority record;
  v_job public.sync_jobs;
  v_run public.recommendation_runs;
begin
  perform app.assert_recommendation_worker('recommendation execution claim');
  if p_job_id is null or p_claim_token is null or p_org_id is null
     or p_profile_id is null or p_run_id is null
     or p_worker_id is null or pg_catalog.btrim(p_worker_id) = ''
     or pg_catalog.length(p_worker_id) > 128
     or p_revision is null or p_revision !~ '^[0-9a-f]{40}$' then
    raise exception 'recommendation execution claim input is invalid' using errcode = '22023';
  end if;
  select * into v_authority from app.recommendation_authority_snapshot();
  if v_authority.protocol <> 'fenced'
     or v_authority.authorized_revision is distinct from p_revision then
    raise exception 'recommendation execution authority does not match this worker'
      using errcode = '55000';
  end if;
  select * into v_job from public.sync_jobs job
   where job.id = p_job_id for update;
  if not found or v_job.job_type <> 'recommendations.run'
     or v_job.status <> 'running' or v_job.claim_token is null
     or v_job.claim_token is distinct from p_claim_token
     or v_job.claimed_by is distinct from p_worker_id
     or v_job.org_id is distinct from p_org_id
     or v_job.profile_id is distinct from p_profile_id
     or v_job.payload ->> 'type' <> 'recommendations.run'
     or v_job.payload ->> 'orgId' <> p_org_id::text
     or v_job.payload ->> 'profileId' <> p_profile_id::text
     or v_job.payload ->> 'runId' <> p_run_id::text
     or coalesce(v_job.payload ->> 'groupId', '') <> coalesce(p_group_id::text, '')
     or not app.recommendation_job_scope_is_current(v_job.id) then
    raise exception 'recommendation execution custody is stale or mismatched'
      using errcode = '55000';
  end if;
  select * into v_run from public.recommendation_runs run
   where run.id = p_run_id and run.org_id = p_org_id
     and run.profile_id = p_profile_id and run.job_id = p_job_id
     and run.group_id is not distinct from p_group_id
   for update;
  if not found then
    raise exception 'recommendation execution run does not match its claim'
      using errcode = '55000';
  end if;
  return v_run;
end;
$$;

alter function app.lock_recommendation_claimed_run(
  uuid, text, uuid, text, uuid, uuid, uuid, uuid
) owner to openspell_recommendation_executor;
revoke all on function app.lock_recommendation_claimed_run(
  uuid, text, uuid, text, uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role, openspell_recommendation_worker;
grant execute on function app.lock_recommendation_claimed_run(
  uuid, text, uuid, text, uuid, uuid, uuid, uuid
) to openspell_recommendation_executor;

create function public.start_recommendation_run_fenced(
  p_job_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_revision text,
  p_org_id uuid,
  p_profile_id uuid,
  p_run_id uuid,
  p_group_id uuid
)
returns table (decision text, run_data jsonb, profile_data jsonb)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_run public.recommendation_runs;
  v_profile public.ad_profiles;
begin
  v_run := app.lock_recommendation_claimed_run(
    p_job_id, p_worker_id, p_claim_token, p_revision,
    p_org_id, p_profile_id, p_run_id, p_group_id
  );
  if v_run.status not in ('queued', 'running', 'failed', 'succeeded') then
    raise exception 'recommendation run has an invalid execution state' using errcode = '55000';
  end if;
  select * into v_profile from public.ad_profiles profile
   where profile.org_id = v_run.org_id and profile.id = v_run.profile_id;
  if not found then
    raise exception 'recommendation execution profile is unavailable' using errcode = '55000';
  end if;
  if v_run.status <> 'succeeded' then
    update public.recommendation_runs run
       set status = 'running', started_at = coalesce(run.started_at, now()),
           finished_at = null, error = null
     where run.id = v_run.id and run.org_id = v_run.org_id
       and run.profile_id = v_run.profile_id
    returning run.* into v_run;
  end if;
  return query select
    case when v_run.status = 'succeeded' then 'already_succeeded' else 'started' end,
    pg_catalog.jsonb_build_object(
      'proposalsCount', v_run.proposals_count,
      'lookbackDays', v_run.lookback_days,
      'groupId', v_run.group_id,
      'groupRole', v_run.group_role,
      'groupSnapshot', v_run.group_snapshot,
      'dueAt', v_run.due_at,
      'scheduleContext', v_run.schedule_context,
      'strategySnapshot', v_run.strategy_snapshot,
      'strategyGoal', v_run.strategy_goal
    ),
    pg_catalog.jsonb_build_object(
      'orgId', v_profile.org_id,
      'profileId', v_profile.id,
      'timezone', v_profile.timezone,
      'goal', v_profile.goal_lens,
      'monthlyBudget', v_profile.monthly_budget
    );
end;
$$;

create function public.fail_recommendation_run_fenced(
  p_job_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_revision text,
  p_org_id uuid,
  p_profile_id uuid,
  p_run_id uuid,
  p_group_id uuid,
  p_error text
)
returns table (decision text, proposals_count integer)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_run public.recommendation_runs;
begin
  if p_error is null or pg_catalog.octet_length(p_error) > 4000 then
    raise exception 'recommendation failure text is invalid' using errcode = '22023';
  end if;
  v_run := app.lock_recommendation_claimed_run(
    p_job_id, p_worker_id, p_claim_token, p_revision,
    p_org_id, p_profile_id, p_run_id, p_group_id
  );
  if v_run.status = 'succeeded' then
    return query select 'already_succeeded'::text, v_run.proposals_count;
    return;
  end if;
  update public.recommendation_runs run
     set status = 'failed', finished_at = now(), error = p_error
   where run.id = v_run.id and run.org_id = v_run.org_id
     and run.profile_id = v_run.profile_id;
  if not found then
    raise exception 'failed zero recommendation runs' using errcode = '55000';
  end if;
  insert into public.audit_log
    (org_id, actor_type, action, target_type, target_id, payload, source)
  values (v_run.org_id, 'service', 'recommendation.run.failed',
          'recommendation_run', v_run.id::text,
          pg_catalog.jsonb_build_object('error', p_error), 'worker');
  return query select 'failed'::text, v_run.proposals_count;
end;
$$;

alter function public.start_recommendation_run_fenced(
  uuid, text, uuid, text, uuid, uuid, uuid, uuid
) owner to openspell_recommendation_executor;
alter function public.fail_recommendation_run_fenced(
  uuid, text, uuid, text, uuid, uuid, uuid, uuid, text
) owner to openspell_recommendation_executor;
revoke all on function public.start_recommendation_run_fenced(
  uuid, text, uuid, text, uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.start_recommendation_run_fenced(
  uuid, text, uuid, text, uuid, uuid, uuid, uuid
) to openspell_recommendation_worker;
revoke all on function public.fail_recommendation_run_fenced(
  uuid, text, uuid, text, uuid, uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.fail_recommendation_run_fenced(
  uuid, text, uuid, text, uuid, uuid, uuid, uuid, text
) to openspell_recommendation_worker;

create function public.succeed_recommendation_run_fenced(
  p_job_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_revision text,
  p_org_id uuid,
  p_profile_id uuid,
  p_run_id uuid,
  p_group_id uuid,
  p_completion jsonb
)
returns table (decision text, proposals_count integer)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_run public.recommendation_runs;
  v_offered integer;
  v_inserted integer;
  v_notes_offered integer;
  v_notes_inserted integer;
  v_start date;
  v_end date;
begin
  if p_completion is null or pg_catalog.jsonb_typeof(p_completion) <> 'object'
     or pg_catalog.octet_length(p_completion::text) > 67108864
     or pg_catalog.jsonb_typeof(p_completion -> 'proposals') <> 'array'
     or pg_catalog.jsonb_array_length(p_completion -> 'proposals') > 100000
     or not coalesce((p_completion ->> 'lookbackDays') ~ '^[1-9][0-9]*$', false)
     or not coalesce((p_completion #>> '{window,start}') ~ '^\d{4}-\d{2}-\d{2}$', false)
     or not coalesce((p_completion #>> '{window,end}') ~ '^\d{4}-\d{2}-\d{2}$', false)
     or p_completion -> 'strategySnapshot' is null
     or p_completion -> 'narrative' is null then
    raise exception 'recommendation completion envelope is invalid' using errcode = '22023';
  end if;
  begin
    v_start := (p_completion #>> '{window,start}')::date;
    v_end := (p_completion #>> '{window,end}')::date;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'recommendation completion window is invalid' using errcode = '22023';
  end;

  v_run := app.lock_recommendation_claimed_run(
    p_job_id, p_worker_id, p_claim_token, p_revision,
    p_org_id, p_profile_id, p_run_id, p_group_id
  );
  if v_run.status = 'succeeded' then
    return query select 'already_succeeded'::text, v_run.proposals_count;
    return;
  end if;
  if v_run.status <> 'running'
     or (p_completion ->> 'lookbackDays')::integer <> v_run.lookback_days
     or v_end < v_start
     or (v_end - v_start + 1) <> v_run.lookback_days
     or p_completion -> 'strategySnapshot' is distinct from v_run.strategy_snapshot then
    raise exception 'recommendation completion does not match the locked run'
      using errcode = '23514';
  end if;
  if exists (
    select 1 from public.recommendations recommendation
     where recommendation.run_id = v_run.id
  ) then
    raise exception 'running recommendation run already has result rows' using errcode = '55000';
  end if;
  if exists (
    select 1
      from pg_catalog.jsonb_array_elements(p_completion -> 'proposals') offered(value)
     where pg_catalog.jsonb_typeof(offered.value) <> 'object'
        or pg_catalog.jsonb_typeof(offered.value -> 'entityRef') <> 'object'
        or offered.value #>> '{entityRef,profileId}' <> v_run.profile_id::text
        or nullif(pg_catalog.btrim(offered.value #>> '{entityRef,entityId}'), '') is null
        or nullif(pg_catalog.btrim(offered.value ->> 'field'), '') is null
        or nullif(pg_catalog.btrim(offered.value #>> '{entityRef,campaignId}'), '') is null
        or offered.value -> 'inputs' is null
        or pg_catalog.jsonb_typeof(offered.value -> 'preconditionNotes') <> 'array'
        or not exists (
          select 1 from public.recommendation_run_campaigns member
           where member.org_id = v_run.org_id
             and member.profile_id = v_run.profile_id
             and member.run_id = v_run.id
             and member.campaign_id = offered.value #>> '{entityRef,campaignId}'
        )
        or exists (
          select 1
            from pg_catalog.jsonb_array_elements(offered.value -> 'preconditionNotes') note(value)
           where pg_catalog.jsonb_typeof(note.value) <> 'object'
              or nullif(pg_catalog.btrim(note.value ->> 'code'), '') is null
              or nullif(pg_catalog.btrim(note.value ->> 'message'), '') is null
        )
  ) then
    raise exception 'recommendation completion contains an invalid or out-of-scope proposal'
      using errcode = '23514';
  end if;

  v_offered := pg_catalog.jsonb_array_length(p_completion -> 'proposals');
  select pg_catalog.count(*)::integer into v_notes_offered
    from pg_catalog.jsonb_array_elements(p_completion -> 'proposals') offered(value)
   where pg_catalog.jsonb_array_length(offered.value -> 'preconditionNotes') > 0;

  with offered as materialized (
    select pg_catalog.gen_random_uuid() as id, proposal.value, proposal.ordinality
      from pg_catalog.jsonb_array_elements(p_completion -> 'proposals')
           with ordinality proposal(value, ordinality)
  ), inserted as (
    insert into public.recommendations
      (id, run_id, org_id, profile_id, reason, entity_type, entity_id, ad_product,
       campaign_id, ad_group_id, entity_name, field, current_value, proposed_value,
       inputs, status)
    select offered.id, v_run.id, v_run.org_id, v_run.profile_id,
           (offered.value ->> 'reason')::public.recommendation_reason,
           (offered.value #>> '{entityRef,entityType}')::public.entity_type,
           offered.value #>> '{entityRef,entityId}',
           (offered.value #>> '{entityRef,adProduct}')::public.ad_product,
           offered.value #>> '{entityRef,campaignId}',
           offered.value #>> '{entityRef,adGroupId}',
           offered.value #>> '{entityRef,name}',
           offered.value ->> 'field', offered.value -> 'currentValue',
           offered.value -> 'proposedValue', offered.value -> 'inputs',
           'proposed'::public.recommendation_status
      from offered order by offered.ordinality
    returning id
  ), noted as (
    insert into public.audit_log
      (org_id, actor_type, action, target_type, target_id, payload, source)
    select v_run.org_id, 'service', 'recommendation.preconditions.noted',
           'recommendation', offered.id::text,
           pg_catalog.jsonb_build_object(
             'note', (
               select pg_catalog.string_agg(note.value ->> 'message', ' ' order by note.ordinality)
                 from pg_catalog.jsonb_array_elements(offered.value -> 'preconditionNotes')
                      with ordinality note(value, ordinality)
             ),
             'codes', (
               select pg_catalog.jsonb_agg(note.value -> 'code' order by note.ordinality)
                 from pg_catalog.jsonb_array_elements(offered.value -> 'preconditionNotes')
                      with ordinality note(value, ordinality)
             )
           ), 'worker'
      from offered join inserted using (id)
     where pg_catalog.jsonb_array_length(offered.value -> 'preconditionNotes') > 0
    returning 1 as inserted
  )
  select (select pg_catalog.count(*)::integer from inserted),
         (select pg_catalog.count(*)::integer from noted)
    into v_inserted, v_notes_inserted;

  if v_inserted <> v_offered or v_notes_inserted <> v_notes_offered then
    raise exception 'recommendation completion row counts do not close' using errcode = '55000';
  end if;
  update public.recommendation_runs run
     set status = 'succeeded', lookback_days = v_run.lookback_days,
         window_start = v_start, window_end = v_end,
         engine_version = 'white-box-v1', proposals_count = v_inserted,
         finished_at = now(), error = null
   where run.id = v_run.id and run.org_id = v_run.org_id
     and run.profile_id = v_run.profile_id;
  if not found then
    raise exception 'succeeded zero recommendation runs' using errcode = '55000';
  end if;
  insert into public.audit_log
    (org_id, actor_type, action, target_type, target_id, payload, source)
  values (
    v_run.org_id, 'service', 'recommendation.run.succeeded',
    'recommendation_run', v_run.id::text,
    pg_catalog.jsonb_build_object(
      'engineVersion', 'white-box-v1', 'proposals', v_inserted,
      'narrative', p_completion -> 'narrative'
    ), 'worker'
  );
  return query select 'succeeded'::text, v_inserted;
end;
$$;

alter function public.succeed_recommendation_run_fenced(
  uuid, text, uuid, text, uuid, uuid, uuid, uuid, jsonb
) owner to openspell_recommendation_executor;
revoke all on function public.succeed_recommendation_run_fenced(
  uuid, text, uuid, text, uuid, uuid, uuid, uuid, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.succeed_recommendation_run_fenced(
  uuid, text, uuid, text, uuid, uuid, uuid, uuid, jsonb
) to openspell_recommendation_worker;

create function public.read_recommendation_inputs_fenced(
  p_job_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_revision text,
  p_org_id uuid,
  p_profile_id uuid,
  p_run_id uuid,
  p_group_id uuid,
  p_window_start date,
  p_window_end date
)
returns table (inputs jsonb, group_safety jsonb)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_run public.recommendation_runs;
  v_targets jsonb;
  v_campaigns jsonb;
  v_profile_facts jsonb;
  v_group_safety jsonb;
  v_inputs jsonb;
begin
  if p_window_start is null or p_window_end is null or p_window_end < p_window_start then
    raise exception 'recommendation input window is invalid' using errcode = '22023';
  end if;
  v_run := app.lock_recommendation_claimed_run(
    p_job_id, p_worker_id, p_claim_token, p_revision,
    p_org_id, p_profile_id, p_run_id, p_group_id
  );
  if v_run.status <> 'running'
     or (p_window_end - p_window_start + 1) <> v_run.lookback_days then
    raise exception 'recommendation input window does not match the running claim'
      using errcode = '23514';
  end if;

  with performance as (
    select fact.target_id, fact.target_kind::text as target_kind,
           min(fact.ad_product::text) as ad_product, fact.campaign_id,
           fact.ad_group_id, max(fact.match_type::text) as fact_match_type,
           sum(fact.impressions)::bigint as impressions,
           sum(fact.clicks)::bigint as clicks, sum(fact.cost) as cost,
           sum(fact.purchases_7d)::bigint as orders, sum(fact.sales_7d) as sales
      from public.fact_sp_target_daily fact
     where fact.org_id = v_run.org_id and fact.profile_id = v_run.profile_id
       and fact.date between p_window_start and p_window_end
       and exists (
         select 1 from public.recommendation_run_campaigns member
          where member.org_id = v_run.org_id
            and member.profile_id = v_run.profile_id
            and member.run_id = v_run.id
            and member.campaign_id = fact.campaign_id
       )
     group by fact.target_id, fact.target_kind, fact.campaign_id, fact.ad_group_id
  ), target_rows as (
    select performance.target_id, performance.target_kind,
           performance.ad_product::public.ad_product as ad_product,
           performance.campaign_id, performance.ad_group_id,
           coalesce(keyword.keyword_text, target.resolved_expression,
                    keyword.name, target.name, performance.target_id) as entity_name,
           coalesce(campaign.name, performance.campaign_id) as campaign_name,
           ad_group.name as ad_group_name,
           coalesce(keyword.match_type::text, performance.fact_match_type) as match_type,
           case when coalesce(keyword.deleted_at, target.deleted_at) is not null
                then 'deleted' else coalesce(keyword.state::text, target.state::text) end
             as entity_state,
           case when campaign.deleted_at is not null then 'deleted'
                else campaign.state::text end as campaign_state,
           case when ad_group.deleted_at is not null then 'deleted'
                else ad_group.state::text end as ad_group_state,
           coalesce(keyword.bid, target.bid) as current_bid,
           campaign.budget_amount as daily_budget,
           coalesce(product_ads.advertised_asins, '{}'::text[]) as advertised_asins,
           radar.rank_now, radar.rank_prev, radar.rank_asin,
           radar.rank_observed_on::text as rank_observed_on,
           performance.impressions, performance.clicks, performance.cost,
           performance.orders, performance.sales,
           corridor.date::text as corridor_date,
           corridor.suggested_bid_low, corridor.suggested_bid_median,
           corridor.suggested_bid_high, corridor.bid as corridor_bid,
           corridor.cpc as corridor_cpc
      from performance
      left join public.campaigns campaign
        on campaign.org_id = v_run.org_id and campaign.profile_id = v_run.profile_id
       and campaign.amazon_id = performance.campaign_id
      left join public.ad_groups ad_group
        on ad_group.org_id = v_run.org_id and ad_group.profile_id = v_run.profile_id
       and ad_group.amazon_id = performance.ad_group_id
      left join public.keywords keyword
        on performance.target_kind = 'keyword'
       and keyword.org_id = v_run.org_id and keyword.profile_id = v_run.profile_id
       and keyword.amazon_id = performance.target_id
      left join public.targets target
        on performance.target_kind = 'target'
       and target.org_id = v_run.org_id and target.profile_id = v_run.profile_id
       and target.amazon_id = performance.target_id
      left join lateral (
        select pg_catalog.array_agg(distinct product_ad.asin order by product_ad.asin)
                 filter (where product_ad.asin is not null) as advertised_asins
          from public.product_ads product_ad
         where product_ad.org_id = v_run.org_id
           and product_ad.profile_id = v_run.profile_id
           and product_ad.campaign_id = performance.campaign_id
           and product_ad.ad_group_id = performance.ad_group_id
           and product_ad.deleted_at is null and product_ad.state = 'enabled'
      ) product_ads on true
      left join lateral (
        select candidate.rank_now, candidate.rank_prev, candidate.rank_asin,
               candidate.rank_observed_on
          from (
            select current_rank.organic_rank as rank_now,
                   previous_rank.organic_rank as rank_prev,
                   current_rank.asin as rank_asin,
                   current_rank.observed_on as rank_observed_on,
                   current_rank.id as rank_id
              from public.rank_observations current_rank
              left join lateral (
                select prior.organic_rank
                  from public.rank_observations prior
                 where prior.org_id = v_run.org_id
                   and prior.profile_id = v_run.profile_id
                   and prior.source = current_rank.source
                   and prior.asin = current_rank.asin
                   and pg_catalog.lower(prior.keyword) = pg_catalog.lower(current_rank.keyword)
                   and prior.organic_rank is not null
                   and prior.observed_on < current_rank.observed_on
                 order by prior.observed_on desc, prior.id desc limit 1
              ) previous_rank on true
             where performance.target_kind = 'keyword'
               and current_rank.org_id = v_run.org_id
               and current_rank.profile_id = v_run.profile_id
               and current_rank.source = 'rank_radar'
               and current_rank.asin = any(coalesce(product_ads.advertised_asins, '{}'::text[]))
               and pg_catalog.lower(current_rank.keyword) = pg_catalog.lower(
                 coalesce(keyword.keyword_text, keyword.name, performance.target_id)
               )
               and current_rank.organic_rank is not null
               and current_rank.observed_on <= p_window_end
          ) candidate
         order by (candidate.rank_prev is not null
                   and candidate.rank_now < candidate.rank_prev) desc,
                  candidate.rank_observed_on desc, candidate.rank_id desc
         limit 1
      ) radar on true
      left join lateral (
        select series.date, series.suggested_bid_low, series.suggested_bid_median,
               series.suggested_bid_high, series.bid, series.cpc
          from public.bid_series_daily series
         where series.org_id = v_run.org_id and series.profile_id = v_run.profile_id
           and series.target_id = performance.target_id
           and series.campaign_id = performance.campaign_id
           and series.ad_group_id = performance.ad_group_id
           and series.is_keyword = (performance.target_kind = 'keyword')
         order by series.date desc limit 1
      ) corridor on true
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(target_rows)
           order by target_rows.campaign_id, target_rows.ad_group_id,
                    target_rows.target_id), '[]'::jsonb)
    into v_targets from target_rows;

  with campaign_facts as (
    select 'SP'::text as ad_product, fact.campaign_id,
           sum(fact.impressions)::bigint as impressions,
           sum(fact.clicks)::bigint as clicks, sum(fact.cost) as cost,
           sum(fact.purchases_7d)::bigint as orders, sum(fact.sales_7d) as sales
      from public.fact_sp_target_daily fact
     where fact.org_id = v_run.org_id and fact.profile_id = v_run.profile_id
       and fact.date between p_window_start and p_window_end
       and exists (
         select 1 from public.recommendation_run_campaigns member
          where member.org_id = v_run.org_id and member.profile_id = v_run.profile_id
            and member.run_id = v_run.id and member.campaign_id = fact.campaign_id
       ) group by fact.campaign_id
    union all
    select 'SB', fact.campaign_id, sum(fact.impressions)::bigint,
           sum(fact.clicks)::bigint, sum(fact.cost),
           sum(fact.purchases_7d)::bigint, sum(fact.sales_7d)
      from public.fact_sb_daily fact
     where fact.org_id = v_run.org_id and fact.profile_id = v_run.profile_id
       and fact.date between p_window_start and p_window_end
       and exists (
         select 1 from public.recommendation_run_campaigns member
          where member.org_id = v_run.org_id and member.profile_id = v_run.profile_id
            and member.run_id = v_run.id and member.campaign_id = fact.campaign_id
       ) group by fact.campaign_id
    union all
    select 'SD', fact.campaign_id, sum(fact.impressions)::bigint,
           sum(fact.clicks)::bigint, sum(fact.cost),
           sum(fact.purchases_7d)::bigint, sum(fact.sales_7d)
      from public.fact_sd_daily fact
     where fact.org_id = v_run.org_id and fact.profile_id = v_run.profile_id
       and fact.date between p_window_start and p_window_end
       and exists (
         select 1 from public.recommendation_run_campaigns member
          where member.org_id = v_run.org_id and member.profile_id = v_run.profile_id
            and member.run_id = v_run.id and member.campaign_id = fact.campaign_id
       ) group by fact.campaign_id
  ), campaign_rows as (
    select facts.ad_product::public.ad_product as ad_product, facts.campaign_id,
           coalesce(campaign.name, facts.campaign_id) as campaign_name,
           case when campaign.deleted_at is not null then 'deleted'
                else campaign.state::text end as state,
           campaign.budget_amount as daily_budget, facts.impressions, facts.clicks,
           facts.cost, facts.orders, facts.sales
      from campaign_facts facts
      left join public.campaigns campaign
        on campaign.org_id = v_run.org_id and campaign.profile_id = v_run.profile_id
       and campaign.amazon_id = facts.campaign_id
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(campaign_rows)
           order by campaign_rows.ad_product, campaign_rows.campaign_id), '[]'::jsonb)
    into v_campaigns from campaign_rows;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(profile_row)
           order by profile_row.date), '[]'::jsonb)
    into v_profile_facts
    from (
      select fact.date::text as date, fact.impressions, fact.clicks, fact.cost,
             fact.purchases_7d as orders, fact.sales_7d as sales
        from public.fact_profile_daily fact
       where fact.org_id = v_run.org_id and fact.profile_id = v_run.profile_id
         and fact.date between least(
           pg_catalog.date_trunc('month', p_window_end)::date, p_window_start
         ) and p_window_end
       order by fact.date
    ) profile_row;

  if pg_catalog.jsonb_array_length(v_targets) > 100000
     or pg_catalog.jsonb_array_length(v_campaigns) > 10000
     or pg_catalog.jsonb_array_length(v_profile_facts) > 400 then
    raise exception 'recommendation execution inputs exceed their row bounds'
      using errcode = '54000';
  end if;

  if v_run.group_id is not null then
    with exported as (
      select distinct recommendation.id
        from public.recommendations recommendation
        join public.recommendation_runs prior_run
          on prior_run.id = recommendation.run_id
         and prior_run.org_id = v_run.org_id
         and prior_run.profile_id = v_run.profile_id
         and prior_run.group_id = v_run.group_id
        join public.apply_rows apply_row
          on apply_row.org_id = v_run.org_id
         and apply_row.profile_id = v_run.profile_id
         and apply_row.recommendation_id = recommendation.id
        join public.apply_batches batch
          on batch.org_id = v_run.org_id and batch.profile_id = v_run.profile_id
         and batch.id = apply_row.batch_id and batch.status in ('staged', 'applied')
       where recommendation.org_id = v_run.org_id
         and recommendation.profile_id = v_run.profile_id
    ), evidence as (
      select exported.id, observation.evidence_state, observation.decision
        from exported
        left join lateral (
          select candidate.evidence_state::text as evidence_state,
                 candidate.decision::text as decision
            from public.recommendation_observations candidate
           where candidate.org_id = v_run.org_id
             and candidate.profile_id = v_run.profile_id
             and candidate.group_id = v_run.group_id
             and candidate.recommendation_id = exported.id
           order by candidate.observed_at desc, candidate.id desc limit 1
        ) observation on true
    ), counts as (
      select pg_catalog.count(*)::integer as exported_recommendations,
             pg_catalog.count(*) filter (
               where evidence_state is null or evidence_state <> 'complete'
             )::integer as incomplete_observations,
             pg_catalog.count(*) filter (where decision = 'hold')::integer as hold_decisions,
             pg_catalog.count(*) filter (where decision = 'revert')::integer as revert_decisions
        from evidence
    )
    select pg_catalog.jsonb_build_object(
      'mayPropose', counts.revert_decisions = 0
                    and counts.incomplete_observations = 0
                    and counts.hold_decisions = 0,
      'exportedRecommendations', counts.exported_recommendations,
      'incompleteObservations', counts.incomplete_observations,
      'holdDecisions', counts.hold_decisions,
      'revertDecisions', counts.revert_decisions,
      'reason', case
        when counts.revert_decisions > 0 then
          counts.revert_decisions::text || ' exported recommendation(s) require reversion review before another group preview'
        when counts.incomplete_observations > 0 or counts.hold_decisions > 0 then
          greatest(counts.incomplete_observations, counts.hold_decisions)::text
            || ' exported recommendation(s) are awaiting complete synchronized evidence; hold and do not compound'
        when counts.exported_recommendations = 0 then
          'No prior exported recommendation requires observation.'
        else 'Every active exported recommendation has complete continue evidence.'
      end
    ) into v_group_safety from counts;
  else
    v_group_safety := null;
  end if;

  v_inputs := pg_catalog.jsonb_build_object(
    'targets', v_targets, 'campaigns', v_campaigns, 'profileFacts', v_profile_facts
  );
  if pg_catalog.octet_length(v_inputs::text) > 67108864 then
    raise exception 'recommendation execution inputs exceed the byte bound'
      using errcode = '54000';
  end if;
  return query select v_inputs, v_group_safety;
end;
$$;

alter function public.read_recommendation_inputs_fenced(
  uuid, text, uuid, text, uuid, uuid, uuid, uuid, date, date
) owner to openspell_recommendation_executor;
revoke all on function public.read_recommendation_inputs_fenced(
  uuid, text, uuid, text, uuid, uuid, uuid, uuid, date, date
) from public, anon, authenticated, service_role;
grant execute on function public.read_recommendation_inputs_fenced(
  uuid, text, uuid, text, uuid, uuid, uuid, uuid, date, date
) to openspell_recommendation_worker;

-- The generic schedule loop cannot mint the run id and immutable scope evidence
-- a recommendation job requires. Never try a legacy recommendation schedule:
-- its deferred rejection would roll back unrelated report/integration enqueues
-- in the same transaction. The readiness-gated TypeScript producer owns this
-- job type in every authority state.
create or replace function public.enqueue_due_schedules(p_now timestamptz default now())
returns table (schedule_id uuid, job_id uuid, dedupe_key text, enqueued boolean)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_sched record;
  v_slot timestamptz;
  v_next timestamptz;
  v_key text;
  v_payload jsonb;
  v_job_id uuid;
  v_end date;
  v_start date;
  v_week_start date;
  v_now timestamptz;
  v_hour integer;
begin
  perform app.assert_service_role('enqueue_due_schedules');
  v_now := coalesce(p_now, now());
  for v_sched in
    select schedule.*, profile.timezone, profile.sync_enabled,
           profile.preferred_sync_hour
      from public.sync_schedules schedule
      join public.ad_profiles profile on profile.id = schedule.profile_id
     where schedule.enabled and profile.sync_enabled
       and schedule.next_run_at <= v_now
       and schedule.job_type <> 'recommendations.run'
     order by schedule.next_run_at
     for update of schedule skip locked
  loop
    v_slot := v_sched.next_run_at;
    v_key := v_sched.id::text || ':'
      || pg_catalog.to_char(v_slot at time zone 'UTC', 'YYYYMMDD"T"HH24MI');
    v_payload := pg_catalog.jsonb_build_object(
      'type', v_sched.job_type::text,
      'orgId', v_sched.org_id,
      'profileId', v_sched.profile_id
    ) || coalesce(v_sched.payload, '{}'::jsonb);
    if v_sched.job_type = 'report.request' then
      v_end := (v_now at time zone v_sched.timezone)::date
               - 1 - v_sched.window_offset_days;
      v_start := v_end - (coalesce(v_sched.lookback_days, 1) - 1);
      v_payload := v_payload || pg_catalog.jsonb_build_object(
        'reportType', v_sched.report_type::text,
        'startDate', pg_catalog.to_char(v_start, 'YYYY-MM-DD'),
        'endDate', pg_catalog.to_char(v_end, 'YYYY-MM-DD')
      );
    elsif v_sched.job_type = 'sqp.categorize' then
      v_end := (v_now at time zone v_sched.timezone)::date;
      v_week_start := v_end - extract(dow from v_end)::integer;
      v_payload := v_payload || pg_catalog.jsonb_build_object(
        'weekStart', pg_catalog.to_char(v_week_start, 'YYYY-MM-DD')
      );
    end if;
    begin
      insert into public.sync_jobs
        (org_id, profile_id, schedule_id, job_type, payload, priority,
         dedupe_key, run_after)
      values (
        v_sched.org_id, v_sched.profile_id, v_sched.id, v_sched.job_type,
        v_payload, v_sched.priority, v_key, v_now
      ) returning id into v_job_id;
    exception when unique_violation then
      v_job_id := null;
    end;
    v_hour := coalesce(v_sched.preferred_sync_hour, 4);
    v_next := (
      pg_catalog.date_trunc('day', v_now at time zone v_sched.timezone)
      + pg_catalog.make_interval(hours => v_hour)
    ) at time zone v_sched.timezone;
    while v_next <= v_now loop
      v_next := v_next + v_sched.cadence;
    end loop;
    update public.sync_schedules
       set next_run_at = v_next, last_enqueued_at = v_now
     where id = v_sched.id;
    schedule_id := v_sched.id;
    job_id := v_job_id;
    dedupe_key := v_key;
    enqueued := v_job_id is not null;
    return next;
  end loop;
end;
$$;

comment on function public.enqueue_due_schedules(timestamptz) is
  'Enqueue non-recommendation schedules with profile-local report windows and SQP week starts; recommendation production is a separate readiness-gated lane.';

revoke create on schema public, app from openspell_recommendation_executor;
revoke openspell_recommendation_executor from current_user granted by current_user;

select 1 / case when
  not exists (
    select 1 from pg_catalog.pg_auth_members membership
     where membership.member in (
       'openspell_recommendation_worker'::regrole,
       'openspell_recommendation_executor'::regrole
     )
        or (
          membership.roleid in (
            'openspell_recommendation_worker'::regrole,
            'openspell_recommendation_executor'::regrole
          )
          and (
            membership.member <> current_user::regrole
            or membership.inherit_option
            or membership.set_option
          )
        )
  )
then 1 else 0 end as recommendation_role_membership_guard;
