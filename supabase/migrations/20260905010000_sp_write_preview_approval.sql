-- WP-214: approve only frozen source-backed previews and recover exact retries.
-- No worker registration, environment enablement or profile grant changes.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

alter function app.approve_sp_write_cycle(uuid,text) rename to approve_sp_write_cycle_internal;
revoke all on function app.approve_sp_write_cycle_internal(uuid,text)
  from public, anon, authenticated, service_role;

create function app.approve_sp_write_cycle(p_plan_id uuid, p_approval_request_text text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, app, auth, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_plan public.sp_write_plans%rowtype;
  v_evidence public.sp_write_preview_evidence%rowtype;
  v_request jsonb := p_approval_request_text::jsonb;
  v_prior public.sp_write_authorization_receipts%rowtype;
  v_receipt jsonb;
  v_action jsonb;
  v_keyword public.keywords%rowtype;
  v_count integer := 0;
begin
  select * into strict v_plan from public.sp_write_plans where plan_id = p_plan_id;
  perform 1 from public.orgs where id = v_plan.org_id for key share;
  perform 1 from public.org_members
   where org_id = v_plan.org_id and user_id = v_actor and role in ('owner','admin') for share;
  if not found then
    raise exception 'SP write approval requires current owner or admin' using errcode = '42501';
  end if;
  if v_request -> 'plan' is distinct from app.sp_write_plan_binding(v_plan.artifact) then
    raise exception 'SP approval does not bind its preview' using errcode = '22023';
  end if;

  -- A new confirmation identity cannot admit the same immutable plan twice.
  -- Retries compare the entire request and actor before returning prior authority.
  perform pg_advisory_xact_lock(hashtextextended('openspell.sp-write-approval:' || p_plan_id::text, 0));
  select * into v_prior from public.sp_write_authorization_receipts
   where org_id = v_plan.org_id and profile_id = v_plan.profile_id and plan_id = p_plan_id;
  if found then
    if v_prior.approved_by is distinct from v_actor or not exists (
      select 1 from public.sp_write_approval_requests
       where approval_request_id = v_prior.approval_request_id and artifact = v_request
    ) then
      raise exception 'SP write confirmation identity already used' using errcode = '23505';
    end if;
    return v_prior.artifact;
  end if;

  -- The existing authority function takes environment then profile locks. Keep
  -- that order before source locks; a failed source check rolls back its receipt.
  v_receipt := app.approve_sp_write_cycle_internal(p_plan_id, p_approval_request_text);
  perform 1 from public.ad_profiles profile
    join public.ads_connections connection
      on connection.org_id = profile.org_id and connection.id = profile.connection_id
   where profile.org_id = v_plan.org_id and profile.id = v_plan.profile_id
     and profile.sync_enabled and connection.status = 'active'
     and profile.amazon_profile_id = v_plan.amazon_profile_id
     and profile.connection_id = v_plan.connection_id
     and profile.region = v_plan.region and profile.currency_code = v_plan.currency_code
   for share of profile, connection;
  if not found then
    raise exception 'SP preview profile or connection changed' using errcode = '55000';
  end if;
  if v_plan.direction = 'forward' then
    select * into strict v_evidence from public.sp_write_preview_evidence
     where org_id = v_plan.org_id and profile_id = v_plan.profile_id and plan_id = p_plan_id;
    perform app.assert_sp_write_preview_source(v_plan.artifact_text, v_plan.fingerprint_preimage,
      v_evidence.artifact_text, v_evidence.guardrail_preimage, v_evidence.provenance_preimage);
  else
    if not exists (
      select 1 from public.sp_write_preview_evidence evidence
      join public.sp_write_plans source on source.plan_id = evidence.plan_id
       and source.org_id = evidence.org_id and source.profile_id = evidence.profile_id
      where source.org_id = v_plan.org_id and source.profile_id = v_plan.profile_id
        and source.plan_id = v_plan.source_plan_id and source.fingerprint = v_plan.source_plan_fingerprint
        and source.direction = 'forward' and source.artifact -> 'providerScope' = v_plan.artifact -> 'providerScope'
        and source.artifact -> 'counts' = v_plan.artifact -> 'counts'
    ) or not app.sp_write_inverse_pair_exact(v_plan.source_plan_id, p_plan_id)
      or (select count(*) from public.sp_write_observations
           where org_id = v_plan.org_id and profile_id = v_plan.profile_id
             and execution_id = v_plan.source_execution_id and plan_id = v_plan.source_plan_id
             and outcome = 'observed_requested') <> v_plan.provider_rows then
      raise exception 'SP inverse source is not completely observed' using errcode = '55000';
    end if;
    for v_action in select value from jsonb_array_elements(v_plan.artifact -> 'actions') loop
      if v_action ->> 'routeKey' is distinct from 'sp.v3.keywords.update'
        or not coalesce(app.sp_write_exact_json_keys(v_action -> 'changes', array['bid']), false) then
        raise exception 'SP inverse action is unsupported' using errcode = '22023';
      end if;
      select * into strict v_keyword from public.keywords
       where org_id = v_plan.org_id and profile_id = v_plan.profile_id
         and amazon_id = v_action #>> '{entity,keywordId}' and ad_product = 'SP'
         and deleted_at is null and state in ('enabled','paused') for share;
      if v_keyword.bid is distinct from (v_action #>> '{changes,bid,expected,amount}')::numeric then
        raise exception 'SP inverse mirror changed' using errcode = '55000';
      end if;
      v_count := v_count + 1;
    end loop;
    if v_count <> v_plan.provider_rows then
      raise exception 'SP inverse count mismatch' using errcode = '22023';
    end if;
  end if;
  return v_receipt;
end;
$$;

revoke all on function app.approve_sp_write_cycle(uuid,text) from public, anon, service_role;
grant execute on function app.approve_sp_write_cycle(uuid,text) to authenticated;
