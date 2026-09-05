-- WP-214: exact field reconciliation evidence. No worker or provider activation.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

alter table public.keywords add column bid_observed_at timestamptz;

create unique index entity_changes_tenant_identity_key on public.entity_changes (org_id, profile_id, id);
alter table public.sp_write_observations add constraint sp_write_observations_mirror_identity_key
  unique (org_id, profile_id, observation_id, execution_id, plan_id, action_id, fingerprint);

create table public.sp_write_mirror_observations (
  observation_id uuid primary key,
  org_id uuid not null,
  profile_id uuid not null,
  execution_id uuid not null,
  plan_id uuid not null,
  action_id uuid not null,
  observation_fingerprint text not null,
  outcome text not null check (outcome in ('promoted', 'already_current', 'superseded', 'missing')),
  entity_change_id bigint,
  change_attribution text check (change_attribution in ('write', 'observation')),
  artifact jsonb not null,
  reconciled_at timestamptz not null,
  constraint sp_write_mirror_observations_source_fkey foreign key
    (org_id, profile_id, observation_id, execution_id, plan_id, action_id, observation_fingerprint)
    references public.sp_write_observations
    (org_id, profile_id, observation_id, execution_id, plan_id, action_id, fingerprint) on delete cascade,
  constraint sp_write_mirror_observations_diff_fkey foreign key (org_id, profile_id, entity_change_id)
    references public.entity_changes (org_id, profile_id, id) on delete cascade,
  constraint sp_write_mirror_observations_tenant_key unique (org_id, profile_id, observation_id),
  constraint sp_write_mirror_observations_diff_key unique (entity_change_id),
  constraint sp_write_mirror_observations_diff_shape check (
    (outcome = 'promoted') = (entity_change_id is not null)
    and (outcome = 'promoted') = (change_attribution is not null)
  ),
  constraint sp_write_mirror_observations_artifact_identity check (coalesce(
    app.sp_write_exact_json_keys(artifact, array[
      'schemaVersion','orgId','profileId','executionId','planId','observationId','observationFingerprint',
      'actionId','amazonEntityId','changeKey','observationOutcome','outcome','before','observed','after',
      'entityChangeId','changeAttribution','observedAt','reconciledAt','bidObservedAt'
    ]) and
    artifact ->> 'schemaVersion' = 'openspell.sp-write-mirror-receipt.v1'
    and artifact ->> 'observationId' = observation_id::text
    and artifact ->> 'orgId' = org_id::text and artifact ->> 'profileId' = profile_id::text
    and artifact ->> 'executionId' = execution_id::text and artifact ->> 'planId' = plan_id::text
    and artifact ->> 'actionId' = action_id::text and artifact ->> 'observationFingerprint' = observation_fingerprint
    and artifact ->> 'outcome' = outcome
    and (artifact ->> 'entityChangeId') is not distinct from entity_change_id::text
    and (artifact ->> 'changeAttribution') is not distinct from change_attribution
    and (artifact ->> 'reconciledAt')::timestamptz = reconciled_at,
    false))
);

create trigger sp_write_mirror_observations_immutable
  before update or delete on public.sp_write_mirror_observations
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_mirror_observations_no_truncate
  before truncate on public.sp_write_mirror_observations
  for each statement execute function app.reject_sp_write_evidence_truncate();
select app.install_tenant_rls('public.sp_write_mirror_observations', null);
revoke all on public.sp_write_mirror_observations from public, anon, authenticated, service_role;
grant select on public.sp_write_mirror_observations to authenticated, service_role;

create function app.keyword_mirror_instant(p_value timestamptz)
returns text language sql immutable strict
set search_path = pg_catalog, pg_temp
as $$ select to_char(p_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') $$;
revoke all on function app.keyword_mirror_instant(timestamptz) from public, anon, authenticated, service_role;

-- Once a bid has field-level evidence, an older/unfenced writer cannot erase it.
-- Ordinary sync and the native writer install this context only within their transaction.
create function app.guard_keyword_bid_observation()
returns trigger language plpgsql
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_read_text text := nullif(current_setting('app.keyword_bid_read_started_at', true), '');
  v_read_at timestamptz;
begin
  if tg_op = 'UPDATE' and old.bid_observed_at is not null then
    if new.bid_observed_at is null or new.bid_observed_at < old.bid_observed_at then
      raise exception 'keyword field evidence cannot move backwards' using errcode = '55000';
    end if;
    if new.bid is not distinct from old.bid
       and new.deleted_at is not distinct from old.deleted_at
       and new.bid_observed_at is not distinct from old.bid_observed_at then return new; end if;
  elsif new.bid_observed_at is null then return new;
  end if;
  if v_read_text is null then
    raise exception 'keyword field update requires a read window' using errcode = '55000';
  end if;
  v_read_at := v_read_text::timestamptz;
  if v_read_at > clock_timestamp() or new.bid_observed_at is distinct from v_read_at
     or (tg_op = 'UPDATE' and old.bid_observed_at is not null and v_read_at < old.bid_observed_at) then
    raise exception 'keyword field read window is stale or invalid' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function app.guard_keyword_bid_observation() from public, anon, authenticated, service_role;
create trigger keywords_bid_observation_guard before insert or update on public.keywords
  for each row execute function app.guard_keyword_bid_observation();

create function app.reconcile_sp_write_mirror(p_observation_id uuid, p_observation_fingerprint text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_observation public.sp_write_observations%rowtype;
  v_action public.sp_write_plan_actions%rowtype;
  v_plan public.sp_write_plans%rowtype;
  v_keyword public.keywords%rowtype;
  v_existing public.sp_write_mirror_observations%rowtype;
  v_expected numeric;
  v_observed numeric;
  v_before numeric;
  v_after numeric;
  v_head timestamptz;
  v_outcome text;
  v_change_id bigint;
  v_attribution text;
  v_now timestamptz;
  v_artifact jsonb;
  v_old_context text := current_setting('app.keyword_bid_read_started_at', true);
  v_affected integer;
begin
  perform app.assert_service_role('reconcile_sp_write_mirror');
  select * into v_observation from public.sp_write_observations
    where observation_id = p_observation_id and fingerprint = p_observation_fingerprint;
  if not found then raise exception 'write observation not found' using errcode = 'P0002'; end if;

  perform 1 from public.orgs where id = v_observation.org_id for key share;
  if not found then raise exception 'write observation tenant not found' using errcode = 'P0002'; end if;
  perform 1 from public.ad_profiles where org_id = v_observation.org_id and id = v_observation.profile_id for key share;
  if not found then raise exception 'write observation profile not found' using errcode = 'P0002'; end if;
  perform 1 from public.sp_write_observations where observation_id = p_observation_id for update;
  select * into v_existing from public.sp_write_mirror_observations where observation_id = p_observation_id;
  if found then return v_existing.artifact; end if;

  select * into strict v_plan from public.sp_write_plans
    where org_id = v_observation.org_id and profile_id = v_observation.profile_id and plan_id = v_observation.plan_id;
  select * into strict v_action from public.sp_write_plan_actions
    where org_id = v_observation.org_id and profile_id = v_observation.profile_id
      and plan_id = v_observation.plan_id and action_id = v_observation.action_id;
  if v_action.route_key <> 'sp.v3.keywords.update'
     or not coalesce(app.sp_write_exact_json_keys(v_action.artifact -> 'changes', array['bid']), false)
     or (v_observation.observed is not null and (
       not coalesce(app.sp_write_exact_json_keys(v_observation.observed -> 'values', array['bid']), false)
       or v_observation.observed #>> '{values,bid,currencyCode}' is distinct from v_plan.currency_code
     )) then raise exception 'write mirror action unsupported' using errcode = '22023'; end if;
  v_expected := (v_action.artifact #>> '{changes,bid,expected,amount}')::numeric;
  v_observed := (v_observation.observed #>> '{values,bid,amount}')::numeric;
  if v_expected is null or v_expected < 0 or (v_observation.outcome <> 'missing' and v_observed is null)
     or v_observed < 0 then raise exception 'write observation value unavailable' using errcode = '22023'; end if;
  if v_observed is not null and v_observed <> v_observed::numeric(12,4) then
    raise exception 'write observation exceeds mirror precision' using errcode = '22023';
  end if;

  select * into v_keyword from public.keywords
    where org_id = v_observation.org_id and profile_id = v_observation.profile_id
      and amazon_id = v_action.amazon_entity_id and ad_product = 'SP' for update;
  if not found or v_keyword.deleted_at is not null or v_keyword.bid is null then
    v_outcome := 'missing';
  else
    v_before := v_keyword.bid;
    v_after := v_before;
    v_head := v_keyword.bid_observed_at;
    if v_observed is null then v_outcome := 'superseded';
    elsif v_before = v_observed then
      v_outcome := 'already_current';
      if v_head is null or v_head < v_observation.observed_at then
        v_head := v_observation.observed_at;
        perform set_config('app.keyword_bid_read_started_at', app.keyword_mirror_instant(v_head), true);
        update public.keywords set bid_observed_at = v_head where id = v_keyword.id;
        get diagnostics v_affected = row_count;
        if v_affected <> 1 then raise exception 'mirror row count does not close' using errcode = 'P0003'; end if;
      end if;
    elsif v_before <> v_expected or v_head > v_observation.observed_at then v_outcome := 'superseded';
    else
      v_outcome := 'promoted';
      v_after := v_observed;
      v_head := v_observation.observed_at;
      v_attribution := case when v_observation.outcome = 'observed_requested' then 'write' else 'observation' end;
      perform set_config('app.keyword_bid_read_started_at', app.keyword_mirror_instant(v_head), true);
      update public.keywords set bid = v_after, bid_observed_at = v_head where id = v_keyword.id;
      get diagnostics v_affected = row_count;
      if v_affected <> 1 then raise exception 'mirror row count does not close' using errcode = 'P0003'; end if;
      insert into public.entity_changes
        (org_id, profile_id, entity_type, amazon_id, entity_name, field, old_value, new_value, source, observed_at)
      values (v_observation.org_id, v_observation.profile_id, 'keyword', v_keyword.amazon_id, v_keyword.name, 'bid',
              to_jsonb(trim_scale(v_before)::text), to_jsonb(trim_scale(v_after)::text),
              case when v_attribution = 'write' then 'apply'::public.entity_change_source else 'sync'::public.entity_change_source end,
              v_observation.observed_at)
      returning id into strict v_change_id;
    end if;
  end if;
  perform set_config('app.keyword_bid_read_started_at', coalesce(v_old_context, ''), true);
  v_now := clock_timestamp();
  v_artifact := jsonb_build_object(
    'schemaVersion', 'openspell.sp-write-mirror-receipt.v1',
    'orgId', v_observation.org_id::text, 'profileId', v_observation.profile_id::text,
    'executionId', v_observation.execution_id::text, 'planId', v_observation.plan_id::text,
    'observationId', v_observation.observation_id::text, 'observationFingerprint', v_observation.fingerprint,
    'actionId', v_observation.action_id::text, 'amazonEntityId', v_action.amazon_entity_id, 'changeKey', 'keyword.bid',
    'observationOutcome', v_observation.outcome::text, 'outcome', v_outcome,
    'before', case when v_before is null then null else jsonb_build_object('amount', trim_scale(v_before)::text, 'currencyCode', v_plan.currency_code) end,
    'observed', case when v_observed is null then null else jsonb_build_object('amount', trim_scale(v_observed)::text, 'currencyCode', v_plan.currency_code) end,
    'after', case when v_after is null then null else jsonb_build_object('amount', trim_scale(v_after)::text, 'currencyCode', v_plan.currency_code) end,
    'entityChangeId', v_change_id::text, 'changeAttribution', v_attribution,
    'observedAt', app.keyword_mirror_instant(v_observation.observed_at), 'reconciledAt', app.keyword_mirror_instant(v_now),
    'bidObservedAt', case when v_head is null then null else app.keyword_mirror_instant(v_head) end
  );
  insert into public.sp_write_mirror_observations
    (observation_id, org_id, profile_id, execution_id, plan_id, action_id, observation_fingerprint,
     outcome, entity_change_id, change_attribution, artifact, reconciled_at)
  values (v_observation.observation_id, v_observation.org_id, v_observation.profile_id, v_observation.execution_id,
          v_observation.plan_id, v_observation.action_id, v_observation.fingerprint, v_outcome,
          v_change_id, v_attribution, v_artifact, (v_artifact ->> 'reconciledAt')::timestamptz);
  get diagnostics v_affected = row_count;
  if v_affected <> 1 then raise exception 'mirror receipt count does not close' using errcode = 'P0003'; end if;
  return v_artifact;
end;
$$;
revoke all on function app.reconcile_sp_write_mirror(uuid, text) from public, anon, authenticated, service_role;
grant execute on function app.reconcile_sp_write_mirror(uuid, text) to service_role;
