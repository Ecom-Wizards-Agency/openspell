-- WP-214: immutable, reconstructable preview evidence. No runtime activation.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

create table public.sp_write_preview_evidence (
  plan_id uuid primary key,
  org_id uuid not null,
  profile_id uuid not null,
  artifact_text text not null,
  artifact jsonb not null,
  guardrail_preimage text not null,
  provenance_preimage text not null,
  persisted_at timestamptz not null default clock_timestamp(),
  constraint sp_write_preview_evidence_plan_fkey
    foreign key (org_id, profile_id, plan_id)
    references public.sp_write_plans (org_id, profile_id, plan_id) on delete cascade,
  constraint sp_write_preview_evidence_tenant_key unique (org_id, profile_id, plan_id),
  constraint sp_write_preview_evidence_text_agrees check (artifact_text::jsonb = artifact)
);

create trigger sp_write_preview_evidence_immutable
  before update or delete on public.sp_write_preview_evidence
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_preview_evidence_no_truncate
  before truncate on public.sp_write_preview_evidence
  for each statement execute function app.reject_sp_write_evidence_truncate();

select app.install_tenant_rls('public.sp_write_preview_evidence', null);
revoke all on public.sp_write_preview_evidence from public, anon, authenticated, service_role;
grant select on public.sp_write_preview_evidence to authenticated, service_role;

-- Internal fact check shared by preview persistence and later approval. It
-- receives no execution authority and is callable only by owner-run functions.
create function app.assert_sp_write_preview_source(
  p_plan_text text,
  p_plan_preimage text,
  p_evidence_text text,
  p_guardrail_preimage text,
  p_provenance_preimage text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_plan jsonb;
  v_evidence jsonb;
  v_source jsonb;
  v_policy jsonb;
  v_action jsonb;
  v_artifact jsonb;
  v_guards jsonb;
  v_provenance jsonb;
  v_org uuid;
  v_profile uuid;
  v_batch public.apply_batches%rowtype;
  v_grant public.sp_write_profile_grant_versions%rowtype;
  v_row public.apply_rows%rowtype;
  v_recommendation public.recommendations%rowtype;
  v_run public.recommendation_runs%rowtype;
  v_keyword public.keywords%rowtype;
  v_index integer;
  v_count integer := 0;
  v_actual_count integer;
begin
  v_plan := app.sp_write_verified_artifact(p_plan_text, p_plan_preimage, 'openspell.sp-write-plan.v1');
  v_evidence := p_evidence_text::jsonb;
  v_guards := p_guardrail_preimage::jsonb;
  v_provenance := p_provenance_preimage::jsonb;
  if v_evidence ->> 'schemaVersion' is distinct from 'openspell.sp-write-preview-evidence.v1'
     or not coalesce(app.sp_write_exact_json_keys(v_evidence, array['schemaVersion','planId','guardrails','provenance']), false)
     or v_evidence -> 'planId' is distinct from v_plan -> 'id'
     or v_plan ->> 'direction' is distinct from 'forward'
     or v_plan #>> '{source,kind}' is distinct from 'apply_batch'
     or jsonb_typeof(v_guards) is distinct from 'array' or jsonb_array_length(v_guards) <> 2
     or v_guards ->> 0 is distinct from 'openspell.sp-write-preview-guards.v1'
     or v_guards -> 1 is distinct from v_evidence -> 'guardrails'
     or app.sp_write_sha256(p_guardrail_preimage) is distinct from v_plan #>> '{source,guardrailSnapshotFingerprint}'
     or jsonb_typeof(v_provenance) is distinct from 'array' or jsonb_array_length(v_provenance) <> 2
     or v_provenance ->> 0 is distinct from 'openspell.sp-write-preview-source.v1'
     or v_provenance -> 1 is distinct from v_evidence -> 'provenance'
     or app.sp_write_sha256(p_provenance_preimage) is distinct from v_plan #>> '{source,provenanceSnapshotFingerprint}'
     or v_evidence #> '{guardrails,providerScope}' is distinct from v_plan -> 'providerScope'
     or v_evidence #> '{guardrails,maximumProviderRows}' is distinct from '500'::jsonb
     or v_evidence #> '{guardrails,requireCurrentValueMatch}' is distinct from 'true'::jsonb
     or v_evidence #>> '{provenance,applyBatchId}' is distinct from v_plan #>> '{source,applyBatchId}' then
    raise exception 'SP preview evidence does not bind its plan' using errcode = '22023';
  end if;
  v_org := (v_plan ->> 'orgId')::uuid;
  v_profile := (v_plan ->> 'profileId')::uuid;

  -- Same parent-first ordering as execution authority. Preview does not take
  -- an environment gate: it grants no permission to execute.
  perform 1 from public.orgs where id = v_org for key share;
  if not found then raise exception 'SP preview scope unavailable' using errcode = '42501'; end if;
  select g.* into strict v_grant
    from public.sp_write_profile_grant_heads h
    join public.sp_write_profile_grant_versions g
      on g.org_id = h.org_id and g.profile_id = h.profile_id
     and g.grant_id = h.grant_id and g.version_id = h.version_id
    join public.ad_profiles p on p.org_id = h.org_id and p.id = h.profile_id
    join public.ads_connections c on c.org_id = p.org_id and c.id = p.connection_id
   where h.org_id = v_org and h.profile_id = v_profile and g.enabled
     and p.sync_enabled and c.status = 'active'
     and g.amazon_profile_id = p.amazon_profile_id and g.connection_id = p.connection_id
     and g.region = p.region and g.currency_code = p.currency_code
   for share of h, g, p, c;
  if v_grant.grant_id::text is distinct from v_evidence #>> '{guardrails,profileGrantId}'
     or v_grant.version_id::text is distinct from v_evidence #>> '{guardrails,profileGrantVersion}'
     or v_plan -> 'providerScope' is distinct from jsonb_build_object(
       'amazonProfileId', v_grant.amazon_profile_id, 'connectionId', v_grant.connection_id,
       'region', v_grant.region, 'marketplaceId', v_grant.marketplace_id,
       'currencyCode', v_grant.currency_code, 'apiDialect', v_grant.api_dialect) then
    raise exception 'SP preview grant changed' using errcode = '55000';
  end if;

  -- Lock source parents before children, including the run->recommendation
  -- cascade. The later comparisons prove these are the actual source parents;
  -- caller-supplied identities cannot substitute another run or recommendation.
  perform 1 from public.recommendation_runs
   where org_id = v_org and profile_id = v_profile
     and id in (select (s ->> 'runId')::uuid
       from jsonb_array_elements(v_evidence #> '{provenance,rows}') s)
   order by id for share;
  perform 1 from public.recommendations
   where org_id = v_org and profile_id = v_profile
     and id in (select (s ->> 'recommendationId')::uuid
       from jsonb_array_elements(v_evidence #> '{provenance,rows}') s)
   order by id for share;

  -- FOR UPDATE also excludes new child rows taking an FK key-share lock.
  select * into strict v_batch from public.apply_batches
   where org_id = v_org and profile_id = v_profile
     and id = (v_plan #>> '{source,applyBatchId}')::uuid for update;
  perform 1 from public.apply_rows
   where org_id = v_org and profile_id = v_profile and batch_id = v_batch.id
   order by id for share;
  get diagnostics v_actual_count = row_count;
  v_artifact := (v_evidence #>> '{provenance,artifactText}')::jsonb;
  if v_batch.status <> 'staged' or v_batch.source_batch_id is not null
     or v_batch.unsupported_rows <> 0 or v_batch.reversible_rows not between 1 and 500
     or v_batch.reversible_rows <> v_actual_count or v_batch.exported_proposals <> v_actual_count
     or jsonb_typeof(v_artifact) is distinct from 'array' or jsonb_array_length(v_artifact) <> v_actual_count
     or jsonb_typeof(v_evidence #> '{provenance,rows}') is distinct from 'array'
     or jsonb_array_length(v_evidence #> '{provenance,rows}') <> v_actual_count
     or jsonb_typeof(v_evidence #> '{guardrails,policies}') is distinct from 'array'
     or jsonb_array_length(v_evidence #> '{guardrails,policies}') <> v_actual_count
     or v_batch.artifact_sha256 is null
     or v_batch.artifact_sha256 is distinct from v_evidence #>> '{provenance,artifactSha256}'
     or v_batch.artifact_sha256 is distinct from app.sp_write_sha256(v_evidence #>> '{provenance,artifactText}')
     or v_batch.exported_at is distinct from (v_evidence #>> '{provenance,exportedAt}')::timestamptz
     or v_batch.tag is distinct from v_evidence #>> '{provenance,tag}'
     or v_batch.opt_group is distinct from v_evidence #>> '{provenance,optGroup}'
     or v_batch.lever is distinct from v_evidence #>> '{provenance,lever}'
     or v_batch.note is distinct from v_evidence #>> '{provenance,note}' then
    raise exception 'SP preview export changed or is incomplete' using errcode = '55000';
  end if;
  if (select count(distinct r ->> 'applyRowId') from jsonb_array_elements(v_evidence #> '{provenance,rows}') r) <> v_actual_count
     or (select count(distinct r ->> 'recommendationId') from jsonb_array_elements(v_evidence #> '{provenance,rows}') r) <> v_actual_count then
    raise exception 'SP preview repeats a source identity' using errcode = '22023';
  end if;

  for v_source, v_index in
    select value, (ordinality - 1)::integer
      from jsonb_array_elements(v_evidence #> '{provenance,rows}') with ordinality
  loop
    v_policy := v_evidence #> array['guardrails','policies',v_index::text];
    select * into strict v_row from public.apply_rows
     where org_id = v_org and profile_id = v_profile and batch_id = v_batch.id
       and id = (v_source ->> 'applyRowId')::uuid;
    select * into strict v_recommendation from public.recommendations
     where org_id = v_org and profile_id = v_profile and id = v_row.recommendation_id;
    select * into strict v_run from public.recommendation_runs
     where org_id = v_org and profile_id = v_profile and id = v_recommendation.run_id;
    select * into strict v_keyword from public.keywords
     where org_id = v_org and profile_id = v_profile and amazon_id = v_row.entity_id
       and ad_product = 'SP' and deleted_at is null and state in ('enabled', 'paused') for share;
    select a into strict v_action from jsonb_array_elements(v_plan -> 'actions') a
     where a #>> '{sources,0,applyRowId}' = v_row.id::text;
    if v_row.entity_type <> 'keyword' or v_row.field <> 'bid'
       or v_recommendation.id::text is distinct from v_source ->> 'recommendationId'
       or v_run.id::text is distinct from v_source ->> 'runId'
       or v_recommendation.export_batch_id is distinct from v_batch.id
       or v_recommendation.status <> 'exported'
       or v_recommendation.entity_type::text is distinct from v_row.entity_type::text
       or v_recommendation.entity_id is distinct from v_row.entity_id
       or v_recommendation.field is distinct from v_row.field
       or (v_recommendation.ad_product is not null and v_recommendation.ad_product <> 'SP')
       or (v_recommendation.campaign_id is not null and v_recommendation.campaign_id is distinct from v_keyword.campaign_id)
       or (v_recommendation.ad_group_id is not null and v_recommendation.ad_group_id is distinct from v_keyword.ad_group_id)
       or v_recommendation.current_value is distinct from v_row.old_value
       or v_recommendation.proposed_value is distinct from v_row.new_value
       or v_policy ->> 'applyRowId' is distinct from v_source ->> 'applyRowId'
       or v_policy ->> 'recommendationId' is distinct from v_source ->> 'recommendationId'
       or v_policy ->> 'runId' is distinct from v_source ->> 'runId'
       or v_run.strategy_snapshot is null or v_run.strategy_goal is null
       or v_policy ->> 'strategySnapshotText' is distinct from v_run.strategy_snapshot::text
       or v_policy ->> 'strategyGoal' is distinct from v_run.strategy_goal
       or v_policy ->> 'groupId' is distinct from v_run.group_id::text
       or v_policy ->> 'groupSnapshotText' is distinct from v_run.group_snapshot::text
       or v_action ->> 'routeKey' is distinct from 'sp.v3.keywords.update'
       or v_action #>> '{entity,keywordId}' is distinct from v_row.entity_id
       or jsonb_array_length(v_action -> 'sources') <> 1
       or v_action #>> '{sources,0,changeKey}' is distinct from 'keyword.bid'
       or not coalesce(app.sp_write_exact_json_keys(v_action -> 'changes', array['bid']), false)
       or (v_row.old_value #>> '{}')::numeric is distinct from (v_action #>> '{changes,bid,expected,amount}')::numeric
       or (v_row.new_value #>> '{}')::numeric is distinct from (v_action #>> '{changes,bid,requested,amount}')::numeric
       or v_keyword.bid is distinct from (v_row.old_value #>> '{}')::numeric
       or v_artifact -> v_index is distinct from jsonb_strip_nulls(jsonb_build_object(
         'entity_type', v_row.entity_type, 'entity_id', v_row.entity_id, 'field', v_row.field,
         'old', v_row.old_value, 'new', v_row.new_value, 'name', v_row.entity_name,
         'clicks', v_row.clicks, 'revenue', v_row.revenue)) then
      raise exception 'SP preview source or policy changed' using errcode = '55000';
    end if;
    v_count := v_count + 1;
  end loop;
  if v_count <> v_actual_count or v_count <> (v_plan #>> '{counts,providerRows}')::integer then
    raise exception 'SP preview source counts differ' using errcode = '22023';
  end if;
end;
$$;

revoke all on function app.assert_sp_write_preview_source(text,text,text,text,text)
  from public, anon, authenticated, service_role;

create function app.record_sp_write_preview(
  p_plan_text text, p_plan_preimage text, p_action_proofs jsonb,
  p_evidence_text text, p_guardrail_preimage text, p_provenance_preimage text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_plan jsonb := p_plan_text::jsonb;
  v_plan_id uuid := (v_plan ->> 'id')::uuid;
begin
  perform app.assert_service_role('record_sp_write_preview');
  perform app.assert_sp_write_preview_source(p_plan_text, p_plan_preimage,
    p_evidence_text, p_guardrail_preimage, p_provenance_preimage);
  perform app.record_sp_write_plan(p_plan_text, p_plan_preimage, p_action_proofs);
  insert into public.sp_write_preview_evidence
    (plan_id, org_id, profile_id, artifact_text, artifact, guardrail_preimage, provenance_preimage)
  values (v_plan_id, (v_plan ->> 'orgId')::uuid, (v_plan ->> 'profileId')::uuid,
    p_evidence_text, p_evidence_text::jsonb, p_guardrail_preimage, p_provenance_preimage);
  return v_plan_id;
end;
$$;

revoke all on function app.record_sp_write_preview(text,text,jsonb,text,text,text) from public, anon, authenticated;
grant execute on function app.record_sp_write_preview(text,text,jsonb,text,text,text) to service_role;
