-- WP-214: audited proposal edits. This is outside WP-207's original window.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

alter table public.recommendations add column proposal_revision_id uuid;
alter table public.apply_rows add column proposal_revision_id uuid;

create table public.recommendation_proposal_revisions (
  id uuid primary key,
  org_id uuid not null,
  profile_id uuid not null,
  recommendation_id uuid not null,
  previous_revision_id uuid,
  actor_id uuid not null,
  request_id uuid not null,
  request jsonb not null,
  receipt jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint recommendation_proposal_revisions_parent_fkey
    foreign key (org_id, profile_id, recommendation_id)
    references public.recommendations (org_id, profile_id, id),
  constraint recommendation_proposal_revisions_identity_key
    unique (org_id, profile_id, recommendation_id, id),
  constraint recommendation_proposal_revisions_request_key unique (org_id, actor_id, request_id),
  constraint recommendation_proposal_revisions_successor_key
    unique nulls not distinct (recommendation_id, previous_revision_id),
  constraint recommendation_proposal_revisions_previous_fkey
    foreign key (org_id, profile_id, recommendation_id, previous_revision_id)
    references public.recommendation_proposal_revisions (org_id, profile_id, recommendation_id, id)
);
alter table public.recommendations add constraint recommendations_revision_fkey
  foreign key (org_id, profile_id, id, proposal_revision_id)
  references public.recommendation_proposal_revisions (org_id, profile_id, recommendation_id, id);
alter table public.apply_rows add constraint apply_rows_proposal_revision_fkey
  foreign key (org_id, profile_id, recommendation_id, proposal_revision_id)
  references public.recommendation_proposal_revisions (org_id, profile_id, recommendation_id, id);

select app.install_tenant_rls('public.recommendation_proposal_revisions', null);
revoke all on public.recommendation_proposal_revisions from public, anon, authenticated, service_role;
grant select on public.recommendation_proposal_revisions to authenticated, service_role;

create function app.reject_recommendation_revision_change() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin raise exception 'recommendation revision evidence is immutable' using errcode = '55000'; end;
$$;
revoke all on function app.reject_recommendation_revision_change() from public;
create trigger recommendation_proposal_revisions_immutable
  before update or delete on public.recommendation_proposal_revisions
  for each row execute function app.reject_recommendation_revision_change();
create trigger recommendation_proposal_revisions_no_truncate
  before truncate on public.recommendation_proposal_revisions
  for each statement execute function app.reject_recommendation_revision_change();

create function app.guard_recommendation_revision() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if (old.proposal_revision_id is not null or old.export_batch_id is not null
      or old.status in ('exported','applied','superseded')) and
    row(new.id,new.org_id,new.profile_id,new.run_id,new.reason,new.entity_type,new.entity_id,
        new.ad_product,new.campaign_id,new.ad_group_id,new.entity_name,new.field,
        new.current_value,new.proposed_value,new.inputs)
    is distinct from
    row(old.id,old.org_id,old.profile_id,old.run_id,old.reason,old.entity_type,old.entity_id,
        old.ad_product,old.campaign_id,old.ad_group_id,old.entity_name,old.field,
        old.current_value,old.proposed_value,old.inputs) then
    raise exception 'recommendation source is frozen' using errcode = '55000';
  end if;
  if old.export_batch_id is not null and new.export_batch_id is distinct from old.export_batch_id then
    raise exception 'recommendation export is frozen' using errcode = '55000';
  end if;
  if new.proposal_revision_id is distinct from old.proposal_revision_id then
    if old.status not in ('proposed','accepted','dismissed') or old.export_batch_id is not null
      or new.status <> 'proposed' or new.decided_by is not null or new.decided_at is not null
      or not exists (
        select 1 from public.recommendation_proposal_revisions revision
        where revision.org_id = old.org_id and revision.profile_id = old.profile_id
          and revision.recommendation_id = old.id and revision.id = new.proposal_revision_id
          and revision.previous_revision_id is not distinct from old.proposal_revision_id
      ) then
      raise exception 'invalid recommendation revision transition' using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.guard_recommendation_revision() from public;
create trigger recommendations_revision_guard before update on public.recommendations
  for each row execute function app.guard_recommendation_revision();

-- Direct authenticated table updates cannot approve an unseen revised value.
-- The existing worker INSERT capability and run-custody triggers remain intact.
revoke update on public.recommendations from authenticated;
drop policy tenant_update on public.recommendations;

create function app.revise_recommendation_v1(p_org_id uuid, p_request_text text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, app, auth, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_request jsonb := p_request_text::jsonb;
  v_uuid_pattern constant text := '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$';
  v_profile uuid := (v_request ->> 'profileId')::uuid;
  v_id uuid := (v_request ->> 'recommendationId')::uuid;
  v_request_id uuid := (v_request ->> 'requestId')::uuid;
  v_expected uuid := (v_request ->> 'expectedRevisionId')::uuid;
  v_previous public.recommendation_proposal_revisions%rowtype;
  v_row public.recommendations%rowtype;
  v_run uuid;
  v_currency text;
  v_prior text;
  v_value text := v_request ->> 'proposedValue';
  v_note text := v_request ->> 'note';
  v_revision uuid := gen_random_uuid();
  v_receipt jsonb;
  v_count integer;
begin
  if not coalesce(app.sp_write_exact_json_keys(v_request,
      array['requestId','profileId','recommendationId','expectedRevisionId','proposedValue','note']), false)
    or v_profile is null or v_id is null or v_request_id is null
    or jsonb_typeof(v_request -> 'profileId') is distinct from 'string'
    or jsonb_typeof(v_request -> 'recommendationId') is distinct from 'string'
    or jsonb_typeof(v_request -> 'requestId') is distinct from 'string'
    or jsonb_typeof(v_request -> 'expectedRevisionId') not in ('string','null')
    or v_profile::text !~ v_uuid_pattern or v_id::text !~ v_uuid_pattern
    or v_request_id::text !~ v_uuid_pattern or (v_expected is not null and v_expected::text !~ v_uuid_pattern)
    or jsonb_typeof(v_request -> 'proposedValue') is distinct from 'string'
    or v_value !~ '^(0|[1-9][0-9]{0,7})([.][0-9]{0,3}[1-9])?$' or v_value = '0'
    or jsonb_typeof(v_request -> 'note') is distinct from 'string'
    or v_note <> btrim(v_note,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') or length(v_note) not between 1 and 1000 then
    raise exception 'invalid recommendation revision request' using errcode = '22023';
  end if;
  -- JavaScript string limits count supplementary Unicode characters as two UTF-16 units.
  if length(v_note) + (select count(*) from regexp_split_to_table(v_note,'') ch where octet_length(ch) = 4) > 1000 then
    raise exception 'recommendation note is too long' using errcode = '22023';
  end if;
  perform 1 from app.recommendation_claim_authority where singleton for share;
  if not found then raise exception 'recommendation authority unavailable' using errcode = '55000'; end if;
  perform 1 from public.orgs where id = p_org_id for key share;
  perform 1 from public.org_members where org_id = p_org_id and user_id = v_actor
    and role in ('owner','admin','analyst') for share;
  if not found then raise exception 'recommendation edit is not authorized' using errcode = '42501'; end if;
  select currency_code into v_currency from public.ad_profiles
    where org_id = p_org_id and id = v_profile for share;
  if not found then raise exception 'recommendation not found' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'openspell.recommendation-revision:' || p_org_id::text || ':' || v_actor::text || ':' || v_request_id::text, 0));
  select * into v_previous from public.recommendation_proposal_revisions
    where org_id = p_org_id and actor_id = v_actor and request_id = v_request_id;
  if found then
    if v_previous.request is distinct from v_request then
      raise exception 'recommendation edit request identity already used' using errcode = '23505';
    end if;
    return v_previous.receipt;
  end if;
  select run_id into v_run from public.recommendations
    where org_id = p_org_id and profile_id = v_profile and id = v_id;
  perform 1 from public.recommendation_runs
    where org_id = p_org_id and profile_id = v_profile and id = v_run
      and execution_lineage is distinct from 'human' for share;
  if not found then raise exception 'recommendation cannot be revised' using errcode = 'P0002'; end if;
  select * into v_row from public.recommendations
    where org_id = p_org_id and profile_id = v_profile and id = v_id and run_id = v_run for update;
  if not found then raise exception 'recommendation not found' using errcode = 'P0002'; end if;
  if v_row.proposal_revision_id is distinct from v_expected then
    raise exception 'recommendation revision changed' using errcode = '40001';
  end if;
  if v_row.status not in ('proposed','accepted','dismissed') or v_row.export_batch_id is not null then
    raise exception 'recommendation is already frozen' using errcode = '55000';
  end if;
  if v_row.entity_type <> 'keyword' or v_row.field <> 'bid'
    or (v_row.ad_product is not null and v_row.ad_product <> 'SP') then
    raise exception 'unsupported recommendation edit' using errcode = '22023';
  end if;
  perform 1 from public.keywords where org_id = p_org_id and profile_id = v_profile
    and amazon_id = v_row.entity_id and ad_product = 'SP' and deleted_at is null
    and state in ('enabled','paused')
    and (v_row.campaign_id is null or campaign_id = v_row.campaign_id)
    and (v_row.ad_group_id is null or ad_group_id = v_row.ad_group_id) for share;
  if not found then raise exception 'unsupported recommendation mirror' using errcode = '22023'; end if;
  if v_expected is null then
    v_prior := v_row.proposed_value #>> '{}';
    if v_prior is null or v_prior !~ '^[0-9]+([.][0-9]+)?$' then
      raise exception 'unsupported original proposal' using errcode = '22023';
    end if;
    v_prior := trim_scale(v_prior::numeric)::text;
  else
    select receipt ->> 'proposedValue' into strict v_prior from public.recommendation_proposal_revisions
      where id = v_expected and recommendation_id = v_id and org_id = p_org_id and profile_id = v_profile;
  end if;
  if v_prior !~ '^(0|[1-9][0-9]{0,7})([.][0-9]{0,3}[1-9])?$' or v_prior = '0' then
    raise exception 'unsupported original proposal precision' using errcode = '22023';
  end if;
  if v_prior = v_value then raise exception 'recommendation proposal is unchanged' using errcode = '22023'; end if;
  v_receipt := jsonb_build_object(
    'schemaVersion','openspell.recommendation-revision.v1', 'requestId',v_request_id,
    'profileId',v_profile, 'recommendationId',v_id, 'revisionId',v_revision,
    'previousRevisionId',v_expected, 'actor',jsonb_build_object('orgId',p_org_id,'userId',v_actor),
    'currencyCode',v_currency, 'priorProposedValue',v_prior, 'proposedValue',v_value,
    'note',v_note, 'recordedStatus','proposed',
    'recordedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  insert into public.recommendation_proposal_revisions
    (id,org_id,profile_id,recommendation_id,previous_revision_id,actor_id,request_id,request,receipt)
    values (v_revision,p_org_id,v_profile,v_id,v_expected,v_actor,v_request_id,v_request,v_receipt);
  get diagnostics v_count = row_count;
  if v_count <> 1 then raise exception 'recommendation revision count mismatch'; end if;
  update public.recommendations set proposal_revision_id = v_revision,
    status = 'proposed', decided_by = null, decided_at = null where id = v_id and org_id = p_org_id;
  get diagnostics v_count = row_count;
  if v_count <> 1 then raise exception 'recommendation head count mismatch'; end if;
  insert into public.audit_log (org_id,actor_type,actor_id,action,target_type,target_id,payload,source)
    values (p_org_id,'user',v_actor::text,'recommendation.revised','recommendation',v_id::text,v_receipt,'web');
  get diagnostics v_count = row_count;
  if v_count <> 1 then raise exception 'recommendation audit count mismatch'; end if;
  return v_receipt;
end;
$$;
revoke all on function app.revise_recommendation_v1(uuid,text) from public, anon, service_role;
grant execute on function app.revise_recommendation_v1(uuid,text) to authenticated;

create function app.decide_recommendations_v1(
  p_org_id uuid, p_ids uuid[], p_decision text, p_note text, p_expected_text text
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, app, auth, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_expected jsonb := p_expected_text::jsonb;
  v_result jsonb;
  v_updated integer;
  v_audited integer;
begin
  if p_decision is null or p_decision not in ('proposed','accepted','dismissed')
    or p_ids is null or cardinality(p_ids) not between 1 and 20000
    or (select count(distinct id) from unnest(p_ids) id) <> cardinality(p_ids)
    or p_note is null or length(p_note) > 1000 or p_note <> btrim(p_note,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
    or (p_decision = 'dismissed' and p_note = '') then
    raise exception 'invalid recommendation decision' using errcode = '22023';
  end if;
  if v_expected is not null then
    if jsonb_typeof(v_expected) is distinct from 'array' or jsonb_array_length(v_expected) <> cardinality(p_ids) then
      raise exception 'reviewed selection count mismatch' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(v_expected) ref
        where not coalesce(app.sp_write_exact_json_keys(ref,array['recommendationId','revisionId']),false)
          or not coalesce((ref ->> 'recommendationId')::uuid = any(p_ids),false))
      or (select count(distinct (ref ->> 'recommendationId')::uuid)
            from jsonb_array_elements(v_expected) ref) <> cardinality(p_ids) then
      raise exception 'reviewed selection identity mismatch' using errcode = '22023';
    end if;
  end if;
  if length(p_note) + (select count(*) from regexp_split_to_table(p_note,'') ch where octet_length(ch) = 4) > 1000 then
    raise exception 'recommendation note is too long' using errcode = '22023';
  end if;
  perform 1 from app.recommendation_claim_authority where singleton for share;
  if not found then raise exception 'recommendation authority unavailable' using errcode = '55000'; end if;
  perform 1 from public.orgs where id = p_org_id for key share;
  perform 1 from public.org_members where org_id = p_org_id and user_id = v_actor
    and role in ('owner','admin','analyst') for share;
  if not found then raise exception 'recommendation decision is not authorized' using errcode = '42501'; end if;
  perform 1 from public.ad_profiles where org_id = p_org_id and id in
    (select profile_id from public.recommendations where org_id = p_org_id and id = any(p_ids)) order by id for share;
  perform 1 from public.recommendation_runs where org_id = p_org_id and id in
    (select run_id from public.recommendations where org_id = p_org_id and id = any(p_ids)) order by id for share;
  perform 1 from public.recommendations where org_id = p_org_id and id = any(p_ids) order by id for update;
  with offered as materialized (
    select input.id, rec.status::text as status, rec.proposal_revision_id,
      case when v_expected is null then rec.proposal_revision_id is null
        else rec.proposal_revision_id is not distinct from (ref.value ->> 'revisionId')::uuid end as reviewed
    from unnest(p_ids) input(id)
    left join public.recommendations rec on rec.id = input.id and rec.org_id = p_org_id
    left join jsonb_array_elements(v_expected) ref(value) on (ref.value ->> 'recommendationId')::uuid = input.id
  ), updated as (
    update public.recommendations rec set status = p_decision::public.recommendation_status,
      decided_by = case when p_decision = 'proposed' then null else v_actor end,
      decided_at = case when p_decision = 'proposed' then null else clock_timestamp() end
    from offered where rec.id = offered.id and rec.org_id = p_org_id
      and offered.status in ('proposed','accepted','dismissed') and offered.reviewed
    returning rec.id, rec.proposal_revision_id
  ), audited as (
    insert into public.audit_log (org_id,actor_type,actor_id,action,target_type,target_id,payload,source)
    select p_org_id,'user',v_actor::text,'recommendation.' || p_decision,'recommendation',id::text,
      jsonb_build_object('note',p_note,'proposalRevisionId',proposal_revision_id),'web' from updated returning id
  )
  select (select count(*)::integer from updated), (select count(*)::integer from audited),
    jsonb_build_object('updated',(select count(*) from updated),'refused',coalesce((
      select jsonb_agg(jsonb_build_object('id',offered.id,'status',
        case when offered.status is null then 'unavailable'
             when not offered.reviewed then 'revision_changed' else offered.status end) order by offered.id)
      from offered where not exists(select 1 from updated where updated.id = offered.id)
    ),'[]'::jsonb)) into v_updated,v_audited,v_result;
  if v_updated <> v_audited or v_updated + jsonb_array_length(v_result -> 'refused') <> cardinality(p_ids) then
    raise exception 'recommendation decision counts do not reconcile';
  end if;
  return v_result;
end;
$$;
revoke all on function app.decide_recommendations_v1(uuid,uuid[],text,text,text) from public, anon, service_role;
grant execute on function app.decide_recommendations_v1(uuid,uuid[],text,text,text) to authenticated;

-- Preserve the existing source checks and fingerprint formats; bind edited exports to their frozen revision.
create or replace function app.assert_sp_write_preview_source(
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
       or v_row.proposal_revision_id is distinct from v_recommendation.proposal_revision_id
       or v_row.proposal_revision_id::text is distinct from v_source ->> 'proposalRevisionId'
       or (case when v_row.proposal_revision_id is null then
         v_recommendation.current_value is distinct from v_row.old_value
         or v_recommendation.proposed_value is distinct from v_row.new_value
       else
         jsonb_typeof(v_row.old_value) is distinct from 'number'
         or jsonb_typeof(v_row.new_value) is distinct from 'number'
         or to_jsonb((v_recommendation.current_value #>> '{}')::numeric) is distinct from v_row.old_value
         or not exists (
           select 1 from public.recommendation_proposal_revisions revision
           where revision.org_id = v_org and revision.profile_id = v_profile
             and revision.recommendation_id = v_recommendation.id and revision.id = v_row.proposal_revision_id
             and to_jsonb((revision.receipt ->> 'proposedValue')::numeric) = v_row.new_value
         )
       end)
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
