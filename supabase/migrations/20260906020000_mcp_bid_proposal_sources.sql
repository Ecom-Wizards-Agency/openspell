-- WP-217 explicit MCP proposal provenance. No admission, enabled gate or runtime registration.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

create type public.apply_batch_source_kind as enum ('legacy_export', 'mcp_keyword_proposals');
alter table public.apply_batches add column source_kind public.apply_batch_source_kind not null default 'legacy_export';
alter table public.apply_batches drop constraint apply_batches_export_counts;
alter table public.apply_batches add constraint apply_batches_export_counts check (
  exported_proposals >= 0 and reversible_rows >= 0 and unsupported_rows >= 0
  and case source_kind when 'legacy_export' then exported_proposals = reversible_rows + unsupported_rows
    when 'mcp_keyword_proposals' then exported_proposals = 0 and reversible_rows between 1 and 500 and unsupported_rows = 0 end
);

create table mcp.write_previews (
  plan_id uuid primary key,
  org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null,
  key_id uuid not null,
  delegation_version_id uuid not null,
  request_id uuid not null,
  request_text text not null,
  request jsonb not null,
  request_preimage text not null,
  request_fingerprint text not null,
  prepared_at timestamptz not null,
  constraint write_previews_request_key unique (org_id, key_id, request_id),
  constraint write_previews_tenant_key unique (org_id, profile_id, plan_id),
  constraint write_previews_plan_fkey foreign key (org_id, profile_id, plan_id)
    references public.sp_write_plans(org_id, profile_id, plan_id) on delete cascade deferrable initially deferred,
  constraint write_previews_delegation_fkey foreign key (org_id, key_id, delegation_version_id)
    references mcp.write_delegations(org_id, key_id, version_id) on delete cascade,
  constraint write_previews_request_shape check (coalesce(
    request = request_text::jsonb and request_fingerprint = app.sp_write_sha256(request_preimage)
    and request_preimage::jsonb = jsonb_build_array('openspell.mcp-bid-preview-request.v1', request)
    and request ->> 'requestId' = request_id::text and request ->> 'profileId' = profile_id::text
    and request #>> '{source,kind}' in ('apply_batch','keyword_proposals','inverse'), false))
);

create table mcp.bid_proposal_sources (
  batch_id uuid primary key,
  org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null,
  plan_id uuid not null unique,
  artifact_text text not null,
  artifact jsonb not null,
  artifact_sha256 text not null,
  constraint bid_proposal_sources_batch_fkey foreign key (org_id, profile_id, batch_id)
    references public.apply_batches(org_id, profile_id, id) on delete cascade,
  constraint bid_proposal_sources_preview_fkey foreign key (org_id, profile_id, plan_id)
    references mcp.write_previews(org_id, profile_id, plan_id) on delete cascade,
  constraint bid_proposal_sources_tenant_key unique (org_id, profile_id, batch_id),
  constraint bid_proposal_sources_shape check (coalesce(
    artifact = artifact_text::jsonb and artifact_sha256 = app.sp_write_sha256(artifact_text)
    and artifact ->> 'schemaVersion' = 'openspell.mcp-bid-proposal.v1'
    and artifact ->> 'orgId' = org_id::text and artifact ->> 'profileId' = profile_id::text
    and artifact ->> 'applyBatchId' = batch_id::text, false))
);

alter table mcp.write_previews enable row level security;
alter table mcp.bid_proposal_sources enable row level security;
revoke all on mcp.write_previews, mcp.bid_proposal_sources from public, anon, authenticated, service_role;
grant select on mcp.write_previews, mcp.bid_proposal_sources to service_role;
create trigger write_previews_immutable before update or delete on mcp.write_previews
  for each row execute function app.reject_sp_write_evidence_change();
create trigger write_previews_no_truncate before truncate on mcp.write_previews
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger bid_proposal_sources_immutable before update or delete on mcp.bid_proposal_sources
  for each row execute function app.reject_sp_write_evidence_change();
create trigger bid_proposal_sources_no_truncate before truncate on mcp.bid_proposal_sources
  for each statement execute function app.reject_sp_write_evidence_truncate();

create function app.guard_mcp_apply_batch()
returns trigger language plpgsql set search_path = pg_catalog, public, app, mcp, pg_temp as $$
declare v_parent public.apply_batches%rowtype;
begin
  if tg_op = 'DELETE' then
    if old.source_kind = 'mcp_keyword_proposals' and exists(select 1 from public.orgs where id = old.org_id) then
      raise exception 'MCP source batches are immutable' using errcode = '55000';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and (old.source_kind is distinct from new.source_kind or old.source_kind = 'mcp_keyword_proposals') then
    raise exception 'apply source identity is immutable' using errcode = '55000';
  end if;
  if new.source_kind = 'mcp_keyword_proposals' then
    if current_user <> pg_get_userbyid((select relowner from pg_class where oid = 'public.apply_batches'::regclass)) then
      raise exception 'MCP sources require controlled preparation' using errcode = '42501';
    end if;
    if new.source_batch_id is not null or new.status <> 'staged' or new.applied_at is not null
      or new.applied_on is not null or new.reverted_at is not null then
      raise exception 'MCP proposals do not use legacy export lifecycle' using errcode = '22023';
    end if;
  end if;
  if new.source_batch_id is not null then
    -- This lock also serializes a legacy inverse with native source admission.
    select * into strict v_parent from public.apply_batches where id = new.source_batch_id
      and org_id = new.org_id and profile_id = new.profile_id for update;
    if v_parent.source_kind <> 'legacy_export' or exists (
      select 1 from public.sp_write_plans p join public.sp_write_authorization_receipts r
        on r.org_id = p.org_id and r.profile_id = p.profile_id and r.plan_id = p.plan_id
      where p.org_id = new.org_id and p.profile_id = new.profile_id
        and p.direction = 'forward' and p.artifact #>> '{source,applyBatchId}' = v_parent.id::text
    ) then
      raise exception 'native sources require native inverse approval' using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;
create trigger apply_batches_mcp_source_guard before insert or update or delete on public.apply_batches
  for each row execute function app.guard_mcp_apply_batch();

create function app.guard_mcp_apply_row()
returns trigger language plpgsql set search_path = pg_catalog, public, app, mcp, pg_temp as $$
declare v_kind public.apply_batch_source_kind; v_old_kind public.apply_batch_source_kind;
begin
  if tg_op <> 'INSERT' then
    select source_kind into v_old_kind from public.apply_batches where id = old.batch_id;
    if v_old_kind = 'mcp_keyword_proposals' then
      if tg_op = 'DELETE' and not exists(select 1 from public.orgs where id = old.org_id) then return old; end if;
      raise exception 'MCP source rows are immutable' using errcode = '55000';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  select source_kind into v_kind from public.apply_batches where id = new.batch_id;
  if v_kind = 'mcp_keyword_proposals' then
    if tg_op <> 'INSERT' or current_user <> pg_get_userbyid((select relowner from pg_class where oid = 'public.apply_rows'::regclass)) then
      raise exception 'MCP rows require controlled preparation' using errcode = '42501';
    end if;
    if exists(select 1 from mcp.bid_proposal_sources where batch_id = new.batch_id) then
      raise exception 'MCP source row set is already sealed' using errcode = '55000';
    end if;
    if new.recommendation_id is not null or new.proposal_revision_id is not null
      or new.entity_type <> 'keyword' or new.field <> 'bid' or new.clicks is not null or new.revenue is not null
      or not coalesce(jsonb_typeof(new.old_value) = 'string' and jsonb_typeof(new.new_value) = 'string'
        and new.old_value <> new.new_value
        and new.old_value #>> '{}' ~ '^(0|[1-9][0-9]{0,7})([.][0-9]{0,3}[1-9])?$'
        and new.new_value #>> '{}' ~ '^(0|[1-9][0-9]{0,7})([.][0-9]{0,3}[1-9])?$'
        and (new.old_value #>> '{}')::numeric > 0 and (new.new_value #>> '{}')::numeric > 0, false) then
      raise exception 'MCP proposal rows require exact bids without recommendation ancestry' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
create trigger apply_rows_mcp_source_guard before insert or update or delete on public.apply_rows
  for each row execute function app.guard_mcp_apply_row();

-- A marker without its complete scoped source is never a committable proposal.
create function app.assert_mcp_proposal_closure()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, app, mcp, pg_temp as $$
declare
  v_batch public.apply_batches%rowtype; v_source mcp.bid_proposal_sources%rowtype;
  v_preview mcp.write_previews%rowtype; v_plan public.sp_write_plans%rowtype;
  v_rows jsonb; v_count integer;
begin
  select * into v_batch from public.apply_batches where id =
    (to_jsonb(new) ->> case when tg_table_name = 'apply_batches' then 'id' else 'batch_id' end)::uuid;
  if not found or v_batch.source_kind <> 'mcp_keyword_proposals' then
    if tg_table_name = 'bid_proposal_sources' and found then
      raise exception 'MCP source cannot attach to a legacy export' using errcode = '22023';
    end if;
    return null;
  end if;
  select * into strict v_source from mcp.bid_proposal_sources where batch_id = v_batch.id
    and org_id = v_batch.org_id and profile_id = v_batch.profile_id;
  select * into strict v_preview from mcp.write_previews where plan_id = v_source.plan_id
    and org_id = v_batch.org_id and profile_id = v_batch.profile_id;
  select * into strict v_plan from public.sp_write_plans where plan_id = v_source.plan_id
    and org_id = v_batch.org_id and profile_id = v_batch.profile_id;
  if v_preview.request #>> '{source,kind}' <> 'keyword_proposals'
    or v_source.artifact ->> 'requestId' is distinct from v_preview.request_id::text
    or v_source.artifact ->> 'keyId' is distinct from v_preview.key_id::text
    or v_source.artifact ->> 'delegationVersionId' is distinct from v_preview.delegation_version_id::text
    or v_source.artifact ->> 'issuerUserId' is distinct from (select issuer_user_id::text from mcp.write_delegations
      where version_id = v_preview.delegation_version_id)
    or v_source.artifact_sha256 is distinct from v_batch.artifact_sha256
    or v_source.artifact ->> 'note' is distinct from v_batch.note
    or v_source.artifact ->> 'note' is distinct from v_preview.request #>> '{source,note}'
    or v_batch.created_by::text is distinct from v_source.artifact ->> 'issuerUserId'
    or v_batch.exported_at is distinct from v_preview.prepared_at
    or v_plan.artifact ->> 'schemaVersion' is distinct from 'openspell.sp-write-plan.v2'
    or v_plan.direction <> 'forward' or v_plan.artifact #>> '{source,kind}' is distinct from 'apply_batch'
    or v_plan.artifact #>> '{source,applyBatchId}' is distinct from v_batch.id::text
    or (v_source.artifact ->> 'preparedAt')::timestamptz is distinct from v_preview.prepared_at then
    raise exception 'MCP source identity disagrees with preview or batch' using errcode = '22023';
  end if;
  v_rows := v_source.artifact -> 'rows';
  select count(*)::integer into v_count from public.apply_rows where batch_id = v_batch.id;
  if jsonb_typeof(v_rows) is distinct from 'array' or jsonb_array_length(v_rows) not between 1 and 500
    or v_count <> jsonb_array_length(v_rows) or v_batch.reversible_rows <> v_count
    or v_plan.provider_rows <> v_count or v_plan.logical_changes <> v_count or v_plan.unique_entities <> v_count
    or (select count(*) from public.sp_write_plan_actions a where a.org_id = v_batch.org_id
      and a.profile_id = v_batch.profile_id and a.plan_id = v_plan.plan_id) <> v_count
    or v_batch.unsupported_rows <> 0 or v_batch.exported_proposals <> 0
    or (select count(distinct r ->> 'applyRowId') from jsonb_array_elements(v_rows) r) <> v_count
    or (select count(distinct r ->> 'keywordId') from jsonb_array_elements(v_rows) r) <> v_count
    or (select jsonb_agg(r - 'applyRowId' order by n) from jsonb_array_elements(v_rows) with ordinality a(r,n))
      is distinct from v_preview.request #> '{source,rows}'
    or exists(select 1 from jsonb_array_elements(v_rows) s where not exists (
      select 1 from public.apply_rows r where r.org_id = v_batch.org_id and r.profile_id = v_batch.profile_id
        and r.batch_id = v_batch.id and r.id::text = s ->> 'applyRowId'
        and r.entity_type = 'keyword' and r.entity_id = s ->> 'keywordId' and r.field = 'bid'
        and r.old_value = s -> 'expectedBid' and r.new_value = s -> 'requestedBid'
        and r.recommendation_id is null and r.proposal_revision_id is null
    )) then raise exception 'MCP proposal row counts or values disagree' using errcode = '22023'; end if;
  if exists(select 1 from jsonb_array_elements(v_rows) with ordinality proposal(r,n) where (select count(*)
    from public.sp_write_plan_actions a where a.org_id = v_batch.org_id and a.profile_id = v_batch.profile_id
      and a.plan_id = v_plan.plan_id and a.action_index = n - 1 and a.route_key = 'sp.v3.keywords.update'
      and a.amazon_entity_id = r ->> 'keywordId'
      and a.artifact -> 'sources' = jsonb_build_array(jsonb_build_object(
        'kind','apply_row','applyRowId',r ->> 'applyRowId','changeKey','keyword.bid'))
      and a.artifact -> 'changes' = jsonb_build_object('bid', jsonb_build_object(
        'expected', jsonb_build_object('amount',r ->> 'expectedBid','currencyCode',v_plan.currency_code),
        'requested', jsonb_build_object('amount',r ->> 'requestedBid','currencyCode',v_plan.currency_code)))
  ) <> 1) then raise exception 'MCP plan actions disagree with source' using errcode = '22023'; end if;
  return null;
end;
$$;
create constraint trigger apply_batches_mcp_source_closure after insert on public.apply_batches
  deferrable initially deferred for each row when (new.source_kind = 'mcp_keyword_proposals')
  execute function app.assert_mcp_proposal_closure();
create constraint trigger bid_proposal_sources_closure after insert on mcp.bid_proposal_sources
  deferrable initially deferred for each row execute function app.assert_mcp_proposal_closure();
-- Rows must precede their immutable source record. Once it exists the BEFORE
-- guard rejects appends, so closure runs per batch/source, not once per row.
create trigger apply_rows_no_source_truncate before truncate on public.apply_rows
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger apply_batches_no_source_truncate before truncate on public.apply_batches
  for each statement execute function app.reject_sp_write_evidence_truncate();

revoke all on function app.guard_mcp_apply_batch(), app.guard_mcp_apply_row(), app.assert_mcp_proposal_closure()
  from public, anon, authenticated, service_role;

-- Retain the complete recommendation validator and its lock order. The explicit
-- v2 branch validates private MCP source records rather than optimizer ancestry.
alter function app.assert_sp_write_preview_source(text,text,text,text,text)
  rename to assert_sp_write_legacy_preview_source_v1;
create function app.assert_sp_write_preview_source(
  p_plan_text text, p_plan_preimage text, p_evidence_text text,
  p_guardrail_preimage text, p_provenance_preimage text
)
returns void language plpgsql security definer
set search_path = pg_catalog, public, app, pg_temp as $$
declare v_plan jsonb := p_plan_text::jsonb; v_batch public.apply_batches%rowtype;
begin
  if p_evidence_text::jsonb ->> 'schemaVersion' = 'openspell.sp-write-preview-evidence.v2' then
    perform app.assert_mcp_bid_preview_source_v2(p_plan_text,p_plan_preimage,p_evidence_text,
      p_guardrail_preimage,p_provenance_preimage);
    return;
  end if;
  perform app.assert_sp_write_legacy_preview_source_v1(p_plan_text, p_plan_preimage,
    p_evidence_text, p_guardrail_preimage, p_provenance_preimage);
  -- The legacy validator already holds this batch FOR UPDATE, after its source
  -- parents. Never take the batch before those parents here.
  select * into strict v_batch from public.apply_batches where org_id = (v_plan ->> 'orgId')::uuid
    and profile_id = (v_plan ->> 'profileId')::uuid and id = (v_plan #>> '{source,applyBatchId}')::uuid;
  if v_batch.source_kind <> 'legacy_export' or exists(select 1 from public.apply_batches child
    where child.org_id = v_batch.org_id and child.profile_id = v_batch.profile_id
      and child.source_batch_id = v_batch.id and child.status <> 'abandoned') then
    raise exception 'source belongs to another write path' using errcode = '55000';
  end if;
end;
$$;
revoke all on function app.assert_sp_write_preview_source(text,text,text,text,text)
  from public, anon, authenticated, service_role;


-- Preserve the existing linker and cooldown semantics for legacy exports only.
create or replace function app.link_exact_apply_changes(p_change_ids bigint[])
returns table (offered integer, linked integer, ambiguous integer, unmatched integer)
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_scope record;
  v_linked integer := 0;
  v_ambiguous integer := 0;
  v_unmatched integer := 0;
begin
  -- Serialise attribution per tenant/profile. Together with the one-change-per-
  -- apply-row index this makes redelivery and concurrent sync passes idempotent.
  for v_scope in
    select distinct ec.org_id, ec.profile_id
      from public.entity_changes ec
     where ec.id = any(p_change_ids)
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('apply-link:' || v_scope.org_id::text || ':' || v_scope.profile_id::text, 0)
    );
  end loop;

  with offered_changes as (
    select ec.*
      from public.entity_changes ec
     where ec.id = any(p_change_ids)
       and ec.source = 'sync'
       and ec.apply_batch_id is null
  ),
  candidates as (
    select ec.id as change_id, ar.id as apply_row_id, ab.id as batch_id,
           count(*) over (partition by ec.id) as candidate_count,
           row_number() over (
             partition by ar.id
             order by ec.observed_at, ec.id
           ) as row_match_order
      from offered_changes ec
      join public.apply_rows ar
        on ar.org_id = ec.org_id
       and ar.profile_id = ec.profile_id
       and (case when ar.entity_type = 'placement' then 'campaign' else ar.entity_type::text end)
           = ec.entity_type::text
       and ar.entity_id = ec.amazon_id
       and app.canonical_apply_field(ar.entity_type::text, ar.field)
           = app.canonical_apply_field(ec.entity_type::text, ec.field)
       and ar.old_value = ec.old_value
       and ar.new_value = ec.new_value
      join public.apply_batches ab
        on ab.org_id = ar.org_id
       and ab.profile_id = ar.profile_id
       and ab.id = ar.batch_id
       and ab.source_kind = 'legacy_export'
       and ab.status in ('staged', 'applied')
       and ab.artifact_sha256 is not null
       and ab.exported_at <= ec.observed_at
     where not exists (
       select 1
         from public.entity_changes prior
        where prior.org_id = ec.org_id
          and prior.profile_id = ec.profile_id
          and prior.apply_row_id = ar.id
     )
  ),
  linkable as (
    select change_id, apply_row_id, batch_id
      from candidates
     where candidate_count = 1 and row_match_order = 1
  ),
  linked_rows as (
    update public.entity_changes ec
       set apply_batch_id = linkable.batch_id,
           apply_row_id = linkable.apply_row_id
      from linkable
     where ec.id = linkable.change_id
       and ec.apply_batch_id is null
    returning ec.id, ec.apply_batch_id
  ),
  classified as (
    select oc.id,
           case
             when exists (select 1 from linked_rows lr where lr.id = oc.id) then 'linked'
             when exists (
               select 1 from candidates c
                where c.change_id = oc.id
                  and (c.candidate_count > 1 or c.row_match_order > 1)
             ) then 'ambiguous'
             else 'unmatched'
           end as result
      from offered_changes oc
  )
  select count(*) filter (where result = 'linked')::integer,
         count(*) filter (where result = 'ambiguous')::integer,
         (cardinality(p_change_ids) - count(*) filter (where result in ('linked', 'ambiguous')))::integer
    into v_linked, v_ambiguous, v_unmatched
    from classified;

  -- A batch becomes applied only when every reversible row has one unique sync
  -- event and the current mirror still holds every exported value. Partial or
  -- conflicting observations deliberately leave the lifecycle unchanged.
  with eligible_batches as (
    select b.id, max(ec.observed_at) as applied_at
      from public.apply_batches b
      join public.apply_rows ar
        on ar.org_id = b.org_id
       and ar.profile_id = b.profile_id
       and ar.batch_id = b.id
      left join public.entity_changes ec on ec.apply_row_id = ar.id
      cross join lateral app.resolve_apply_current_value(
        ar.org_id, ar.profile_id, ar.entity_type, ar.entity_id, ar.field
      ) current_state
     where b.source_kind = 'legacy_export'
       and b.status = 'staged'
       and b.artifact_sha256 is not null
       and b.unsupported_rows = 0
       and b.reversible_rows > 0
       and exists (
         select 1 from public.entity_changes touched
          where touched.id = any(p_change_ids)
            and touched.apply_batch_id = b.id
       )
     group by b.id, b.reversible_rows
    having count(ar.id) = b.reversible_rows
       and count(ec.id) = b.reversible_rows
       and bool_and(
         current_state.supported
         and current_state.present
         and current_state.current_value is not distinct from ar.new_value
       )
  )
  update public.apply_batches b
     set status = 'applied',
         applied_at = eligible.applied_at,
         applied_on = eligible.applied_at::date,
         updated_at = now()
    from eligible_batches eligible
   where b.id = eligible.id;

  -- A fully observed inverse verifies the source as reverted. This remains a
  -- ledger transition only; no Amazon mutation is performed here.
  update public.apply_batches source
     set status = 'reverted',
         reverted_at = coalesce(source.reverted_at, child.applied_at, now()),
         revert_note = coalesce(source.revert_note, 'Verified by synchronized inverse export'),
         updated_at = now()
    from public.apply_batches child
   where child.source_batch_id = source.id
     and child.org_id = source.org_id
     and child.profile_id = source.profile_id
     and child.source_kind = 'legacy_export'
     and source.source_kind = 'legacy_export'
     and child.status = 'applied'
     and exists (
       select 1 from public.entity_changes touched
        where touched.id = any(p_change_ids)
          and touched.apply_batch_id = child.id
     )
     and source.status = 'applied';

  return query select cardinality(p_change_ids)::integer, v_linked, v_ambiguous, v_unmatched;
end;
$$;

create or replace function public.apply_cooldown_conflicts(
  p_profile_id uuid,
  p_entity_keys text[],
  p_cooldown_days integer default 7,
  p_today date default current_date
)
returns table (
  entity_key text,
  entity_name text,
  batch_tag text,
  applied_on date,
  days_ago integer,
  free_on date
)
language sql
stable
set search_path = pg_catalog, public, pg_temp
as $$
  select
    r.entity_type::text || ':' || r.entity_id as entity_key,
    r.entity_name,
    b.tag as batch_tag,
    b.applied_on,
    (p_today - b.applied_on)::integer as days_ago,
    (b.applied_on + p_cooldown_days)::date as free_on
  from public.apply_rows r
  join public.apply_batches b on b.id = r.batch_id
  where b.source_kind = 'legacy_export'
    and b.profile_id = p_profile_id
    and b.status = 'applied'
    and b.applied_on is not null
    and (p_today - b.applied_on) < p_cooldown_days
    and (r.entity_type::text || ':' || r.entity_id) = any (p_entity_keys)
  order by b.applied_on desc, entity_key;
$$;

-- Preview checks acquire no execution gate and confer no execution authority.
-- Only the supported MCP keyword subset is serialized here. Field order follows
-- the shared parsers; semantic JSON equality cannot validate fingerprint bytes.
create function app.mcp_keyword_preview_json(p_value jsonb, p_kind text)
returns text language plpgsql immutable set search_path = pg_catalog, app, pg_temp as $$
declare v_fields jsonb; v_field jsonb; v_parts text[] := array[]::text[]; v_text text; v_type text := jsonb_typeof(p_value);
begin
  if right(p_kind,2) = '[]' then
    if v_type is distinct from 'array' then raise exception 'MCP array required' using errcode = '22023'; end if;
    for v_field in select value from jsonb_array_elements(p_value) loop
      v_parts := array_append(v_parts,app.mcp_keyword_preview_json(v_field,left(p_kind,length(p_kind)-2)));
    end loop;
    return '[' || array_to_string(v_parts,',') || ']';
  end if;
  if p_kind in ('string','uuid','instant','sha256','note') then
    if v_type is distinct from 'string' then raise exception 'MCP string required' using errcode = '22023'; end if;
    v_text := p_value #>> '{}';
    if (p_kind = 'uuid' and v_text !~ '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$')
      or (p_kind = 'sha256' and v_text !~ '^[a-f0-9]{64}$')
      or (p_kind = 'instant' and v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]+)?Z$') then
      raise exception 'MCP scalar format differs from shared contract' using errcode = '22023';
    end if;
    if p_kind = 'instant' then perform v_text::timestamptz; end if;
    if p_kind = 'note' and (length(v_text) < 1
      or length(v_text) + (select count(*) from regexp_split_to_table(v_text,'') ch where octet_length(ch) = 4) > 1000
      or v_text <> btrim(v_text,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) then
      raise exception 'MCP note differs from shared contract' using errcode = '22023';
    end if;
    return to_json(v_text)::text;
  end if;
  if p_kind = 'integer' then
    if v_type is distinct from 'number' or (p_value #>> '{}')::numeric <> trunc((p_value #>> '{}')::numeric)
      or (p_value #>> '{}')::numeric not between 0 and 2147483647 then
      raise exception 'MCP bounded integer required' using errcode = '22023';
    end if;
    return (p_value #>> '{}')::integer::text;
  end if;
  if p_kind = 'boolean' then
    if v_type is distinct from 'boolean' then raise exception 'MCP boolean required' using errcode = '22023'; end if;
    return p_value::text;
  end if;
  case p_kind
    when 'scope' then v_fields := '[["amazonProfileId","string"],["connectionId","uuid"],["region","string"],["marketplaceId","string"],["currencyCode","string"],["apiDialect","string"]]';
    when 'money' then v_fields := '[["amount","string"],["currencyCode","string"]]';
    when 'bid_change' then v_fields := '[["expected","money"],["requested","money"]]';
    when 'changes' then v_fields := '[["bid","bid_change"]]';
    when 'action_source' then
      v_fields := case when p_value ->> 'kind' = 'inverse_action'
        then '[["kind","string"],["sourceActionId","uuid"],["changeKey","string"]]'::jsonb
        else '[["kind","string"],["applyRowId","uuid"],["changeKey","string"]]'::jsonb end;
    when 'entity' then v_fields := '[["keywordId","string"]]';
    when 'action','action_preimage' then
      v_fields := '[["actionId","uuid"],["sources","action_source[]"],["fingerprint","sha256"],["routeKey","string"],["entity","entity"],["changes","changes"]]';
    when 'by_route' then v_fields := '[["sp.v3.campaigns.update","integer"],["sp.v3.ad_groups.update","integer"],["sp.v3.keywords.update","integer"],["sp.v3.targets.update","integer"],["sp.v3.product_ads.update","integer"]]';
    when 'counts' then v_fields := '[["logicalChanges","integer"],["providerRows","integer"],["uniqueEntities","integer"],["byRoute","by_route"]]';
    when 'plan_source' then
      v_fields := case when p_value ->> 'kind' = 'inverse_execution'
        then '[["kind","string"],["sourceExecutionId","uuid"],["sourcePlanId","uuid"],["sourcePlanFingerprint","sha256"]]'::jsonb
        else '[["kind","string"],["applyBatchId","uuid"],["guardrailSnapshotFingerprint","sha256"],["provenanceSnapshotFingerprint","sha256"]]'::jsonb end;
    when 'plan','plan_preimage' then
      v_fields := '[["schemaVersion","string"],["id","uuid"],["orgId","uuid"],["profileId","uuid"],["providerScope","scope"],["direction","string"],["source","plan_source"],["generatedAt","instant"],["frozenAt","instant"],["expiresAt","instant"],["actions","action[]"],["counts","counts"],["fingerprint","sha256"]]';
    when 'proposal_row','request_row' then
      v_fields := '[["keywordId","string"],["expectedBid","string"],["requestedBid","string"],["applyRowId","uuid"]]';
    when 'proposal' then v_fields := '[["schemaVersion","string"],["orgId","uuid"],["profileId","uuid"],["applyBatchId","uuid"],["requestId","uuid"],["keyId","uuid"],["issuerUserId","uuid"],["delegationVersionId","uuid"],["preparedAt","instant"],["note","note"],["rows","proposal_row[]"]]';
    when 'request' then v_fields := '[["requestId","uuid"],["profileId","uuid"],["source","request_source"]]';
    when 'request_source' then v_fields := '[["kind","string"],["note","note"],["rows","request_row[]"]]';
    when 'guards' then v_fields := '[["profileGrantId","uuid"],["profileGrantVersion","uuid"],["providerScope","scope"],["maximumProviderRows","integer"],["requireCurrentValueMatch","boolean"],["delegation","delegation"]]';
    when 'provenance' then v_fields := '[["kind","string"],["applyBatchId","uuid"],["artifactText","string"],["artifactSha256","sha256"],["preparedAt","instant"],["rows","proposal_row[]"]]';
    when 'delegation' then v_fields := '[["schemaVersion","string"],["versionId","uuid"],["keyId","uuid"],["keyLabel","string"],["orgId","uuid"],["issuerUserId","uuid"],["profiles","delegation_profile[]"],["issuedAt","instant"],["expiresAt","instant"],["limits","limits"],["fingerprint","sha256"]]';
    when 'delegation_profile' then v_fields := '[["profileId","uuid"],["currencyCode","string"]]';
    when 'limits' then v_fields := '[["action","string"],["maximumRowsPerCall","integer"],["maximumRowsPerUtcDay","integer"],["maximumAbsoluteDeltaByCurrency","money[]"],["maximumRelativeDelta","string"]]';
    else raise exception 'unsupported MCP serialization shape' using errcode = '22023';
  end case;
  if p_kind in ('action_preimage','plan_preimage','request_row') then
    select jsonb_agg(value order by ordinality) into v_fields from jsonb_array_elements(v_fields) with ordinality
      where value ->> 0 <> case when p_kind = 'request_row' then 'applyRowId' else 'fingerprint' end;
  end if;
  if not coalesce(app.sp_write_exact_json_keys(p_value,array(select f ->> 0 from jsonb_array_elements(v_fields) f)),false) then
    raise exception 'MCP object fields differ from shared contract' using errcode = '22023';
  end if;
  for v_field in select value from jsonb_array_elements(v_fields) loop
    v_parts := array_append(v_parts,to_json(v_field ->> 0)::text || ':' || app.mcp_keyword_preview_json(p_value -> (v_field ->> 0),v_field ->> 1));
  end loop;
  return '{' || array_to_string(v_parts,',') || '}';
end;
$$;
revoke all on function app.mcp_keyword_preview_json(jsonb,text) from public,anon,authenticated,service_role;

create function app.mcp_bid_preview_context(p_org uuid, p_key uuid, p_hash text, p_profile uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, app, mcp, pg_temp as $$
declare
  v_delegation mcp.write_delegations%rowtype; v_key mcp.api_keys%rowtype;
  v_grant public.sp_write_profile_grant_versions%rowtype; v_now timestamptz;
begin
  perform app.assert_service_role('mcp_bid_preview_context');
  select * into v_delegation from mcp.write_delegations where org_id = p_org and key_id = p_key;
  if not found then raise exception 'MCP authority unavailable' using errcode = '42501'; end if;
  perform 1 from public.orgs where id = p_org for key share;
  if not found then raise exception 'MCP authority unavailable' using errcode = '42501'; end if;
  perform 1 from public.org_members where org_id = p_org and user_id = v_delegation.issuer_user_id
    and role in ('owner','admin') for share;
  if not found then raise exception 'MCP authority unavailable' using errcode = '42501'; end if;
  select g.* into v_grant from public.sp_write_profile_grant_heads h
    join public.sp_write_profile_grant_versions g on g.org_id = h.org_id and g.profile_id = h.profile_id
      and g.grant_id = h.grant_id and g.version_id = h.version_id
    join public.ad_profiles p on p.org_id = h.org_id and p.id = h.profile_id
    join public.ads_connections c on c.org_id = p.org_id and c.id = p.connection_id
    where h.org_id = p_org and h.profile_id = p_profile and g.enabled and p.sync_enabled and c.status = 'active'
      and g.amazon_profile_id = p.amazon_profile_id and g.connection_id = p.connection_id
      and g.region = p.region and g.currency_code = p.currency_code and g.api_dialect = 'sp_v3'
    for share of h,g,p,c;
  if not found then raise exception 'MCP profile unavailable' using errcode = '42501'; end if;
  select * into v_key from mcp.api_keys where org_id = p_org and id = p_key for share;
  v_now := clock_timestamp();
  if not found or v_key.scope <> 'write' or v_key.token_hash is distinct from p_hash
    or v_key.revoked_at is not null or v_key.created_by is distinct from v_delegation.issuer_user_id
    or v_key.expires_at is distinct from v_delegation.expires_at
    or v_delegation.issued_at > v_now or v_delegation.expires_at <= v_now
    or not coalesce(p_profile = any(v_key.profile_ids), false)
    or not exists(select 1 from jsonb_array_elements(v_delegation.artifact -> 'profiles') profile
      where profile ->> 'profileId' = p_profile::text and profile ->> 'currencyCode' = v_grant.currency_code) then
    raise exception 'MCP authority unavailable' using errcode = '42501';
  end if;
  return jsonb_build_object('delegation',v_delegation.artifact,'profileGrantId',v_grant.grant_id,
    'profileGrantVersion',v_grant.version_id,'now',app.sp_write_instant(v_now),
    'providerScope',jsonb_build_object('amazonProfileId',v_grant.amazon_profile_id,'connectionId',v_grant.connection_id,
      'region',v_grant.region,'marketplaceId',v_grant.marketplace_id,'currencyCode',v_grant.currency_code,'apiDialect',v_grant.api_dialect));
end;
$$;
revoke all on function app.mcp_bid_preview_context(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function app.mcp_bid_preview_context(uuid,uuid,text,uuid) to service_role;

create function app.assert_mcp_bid_plan_limits(p_plan jsonb, p_delegation jsonb)
returns void language plpgsql immutable set search_path = pg_catalog, app, pg_temp as $$
declare v_action jsonb; v_bid jsonb; v_expected numeric; v_requested numeric; v_absolute numeric;
  v_currency text := p_plan #>> '{providerScope,currencyCode}'; v_count integer;
  v_decimal text := '^(0|[1-9][0-9]{0,7})([.][0-9]{0,3}[1-9])?$';
begin
  v_count := jsonb_array_length(p_plan -> 'actions');
  if not coalesce(p_plan ->> 'orgId' = p_delegation ->> 'orgId'
    and v_count between 1 and (p_delegation #>> '{limits,maximumRowsPerCall}')::integer
    and (p_plan #>> '{counts,providerRows}')::integer = v_count
    and (p_plan #>> '{counts,logicalChanges}')::integer = v_count
    and (p_plan #>> '{counts,uniqueEntities}')::integer = v_count
    and p_plan #> '{counts,byRoute}' = jsonb_build_object('sp.v3.campaigns.update',0,'sp.v3.ad_groups.update',0,
      'sp.v3.keywords.update',v_count,'sp.v3.targets.update',0,'sp.v3.product_ads.update',0)
    and exists(select 1 from jsonb_array_elements(p_delegation -> 'profiles') p
      where p ->> 'profileId' = p_plan ->> 'profileId' and p ->> 'currencyCode' = v_currency), false) then
    raise exception 'MCP plan scope or count exceeds delegation' using errcode = '42501';
  end if;
  select (limit_row ->> 'amount')::numeric into strict v_absolute
    from jsonb_array_elements(p_delegation #> '{limits,maximumAbsoluteDeltaByCurrency}') limit_row
    where limit_row ->> 'currencyCode' = v_currency;
  for v_action in select value from jsonb_array_elements(p_plan -> 'actions') loop
    v_bid := v_action #> '{changes,bid}';
    if not coalesce(v_action ->> 'routeKey' = 'sp.v3.keywords.update'
      and app.sp_write_exact_json_keys(v_action -> 'changes',array['bid'])
      and jsonb_typeof(v_bid #> '{expected,amount}') = 'string'
      and jsonb_typeof(v_bid #> '{requested,amount}') = 'string'
      and v_bid #>> '{expected,amount}' ~ v_decimal and v_bid #>> '{requested,amount}' ~ v_decimal
      and v_bid #>> '{expected,currencyCode}' = v_currency and v_bid #>> '{requested,currencyCode}' = v_currency, false) then
      raise exception 'MCP plan is not an exact keyword bid change' using errcode = '22023';
    end if;
    v_expected := (v_bid #>> '{expected,amount}')::numeric; v_requested := (v_bid #>> '{requested,amount}')::numeric;
    if v_expected <= 0 or v_requested <= 0 or v_expected = v_requested
      or abs(v_requested - v_expected) > v_absolute
      or abs(v_requested - v_expected) > v_expected * (p_delegation #>> '{limits,maximumRelativeDelta}')::numeric then
      raise exception 'MCP bid delta exceeds delegation' using errcode = '42501';
    end if;
  end loop;
end;
$$;
revoke all on function app.assert_mcp_bid_plan_limits(jsonb,jsonb) from public,anon,authenticated,service_role;

create function app.assert_mcp_bid_preview_source_v2(
  p_plan_text text, p_plan_preimage text, p_evidence_text text,
  p_guardrail_preimage text, p_provenance_preimage text
)
returns void language plpgsql security definer set search_path = pg_catalog, public, app, mcp, pg_temp as $$
declare
  v_plan jsonb := app.sp_write_verified_artifact(p_plan_text,p_plan_preimage,'openspell.sp-write-plan.v2');
  v_evidence jsonb := p_evidence_text::jsonb; v_guard jsonb := v_evidence -> 'guardrails';
  v_provenance jsonb := v_evidence -> 'provenance'; v_source mcp.bid_proposal_sources%rowtype;
  v_preview mcp.write_previews%rowtype; v_delegation mcp.write_delegations%rowtype;
  v_grant public.sp_write_profile_grant_versions%rowtype; v_batch public.apply_batches%rowtype;
  v_row public.apply_rows%rowtype; v_action jsonb; v_keyword public.keywords%rowtype; v_count integer;
  v_org uuid := (v_plan ->> 'orgId')::uuid; v_profile uuid := (v_plan ->> 'profileId')::uuid;
begin
  perform app.assert_sp_keyword_plan_v2(v_plan,p_plan_preimage);
  perform app.assert_sp_keyword_plan_source_v2(v_plan);
  if p_plan_preimage is distinct from '["openspell.sp-write-plan.v2",' || app.mcp_keyword_preview_json(v_plan - 'fingerprint','plan_preimage') || ']'
    or p_guardrail_preimage is distinct from '["openspell.sp-write-preview-guards.v2",' || app.mcp_keyword_preview_json(v_guard,'guards') || ']'
    or p_provenance_preimage is distinct from '["openspell.sp-write-preview-source.v2",' || app.mcp_keyword_preview_json(v_provenance,'provenance') || ']' then
    raise exception 'MCP preview fingerprint bytes differ from shared contract' using errcode = '22023';
  end if;
  for v_action in select value from jsonb_array_elements(v_plan -> 'actions') loop
    if v_action ->> 'fingerprint' is distinct from app.sp_write_sha256('["openspell.sp-write-action.v1",' ||
      app.mcp_keyword_preview_json(v_action - 'fingerprint','action_preimage') || ']') then
      raise exception 'MCP action fingerprint bytes differ from shared contract' using errcode = '22023';
    end if;
  end loop;
  if not coalesce(app.sp_write_exact_json_keys(v_evidence,array['schemaVersion','planId','guardrails','provenance'])
    and v_evidence ->> 'schemaVersion' = 'openspell.sp-write-preview-evidence.v2'
    and v_plan ->> 'schemaVersion' = 'openspell.sp-write-plan.v2'
    and v_evidence -> 'planId' = v_plan -> 'id' and v_plan ->> 'direction' = 'forward'
    and v_plan #>> '{source,kind}' = 'apply_batch'
    and app.sp_write_exact_json_keys(v_guard,array['profileGrantId','profileGrantVersion','providerScope','maximumProviderRows','requireCurrentValueMatch','delegation'])
    and app.sp_write_exact_json_keys(v_provenance,array['kind','applyBatchId','artifactText','artifactSha256','preparedAt','rows'])
    and v_guard -> 'providerScope' = v_plan -> 'providerScope'
    and v_guard -> 'maximumProviderRows' = '500'::jsonb and v_guard -> 'requireCurrentValueMatch' = 'true'::jsonb
    and v_provenance ->> 'kind' = 'mcp_keyword_proposals'
    and v_provenance ->> 'applyBatchId' = v_plan #>> '{source,applyBatchId}'
    and p_guardrail_preimage::jsonb = jsonb_build_array('openspell.sp-write-preview-guards.v2',v_guard)
    and p_provenance_preimage::jsonb = jsonb_build_array('openspell.sp-write-preview-source.v2',v_provenance)
    and app.sp_write_sha256(p_guardrail_preimage) = v_plan #>> '{source,guardrailSnapshotFingerprint}'
    and app.sp_write_sha256(p_provenance_preimage) = v_plan #>> '{source,provenanceSnapshotFingerprint}', false) then
    raise exception 'MCP preview evidence does not bind its plan' using errcode = '22023';
  end if;
  perform 1 from public.orgs where id = v_org for key share;
  select g.* into strict v_grant from public.sp_write_profile_grant_heads h
    join public.sp_write_profile_grant_versions g on g.org_id = h.org_id and g.profile_id = h.profile_id
      and g.grant_id = h.grant_id and g.version_id = h.version_id
    join public.ad_profiles p on p.org_id = h.org_id and p.id = h.profile_id
    join public.ads_connections c on c.org_id = p.org_id and c.id = p.connection_id
    where h.org_id = v_org and h.profile_id = v_profile and g.enabled and p.sync_enabled and c.status = 'active'
      and g.amazon_profile_id = p.amazon_profile_id and g.connection_id = p.connection_id
      and g.region = p.region and g.currency_code = p.currency_code for share of h,g,p,c;
  if v_grant.grant_id::text is distinct from v_guard ->> 'profileGrantId'
    or v_grant.version_id::text is distinct from v_guard ->> 'profileGrantVersion'
    or v_plan -> 'providerScope' is distinct from jsonb_build_object('amazonProfileId',v_grant.amazon_profile_id,
      'connectionId',v_grant.connection_id,'region',v_grant.region,'marketplaceId',v_grant.marketplace_id,
      'currencyCode',v_grant.currency_code,'apiDialect',v_grant.api_dialect) then
    raise exception 'MCP preview profile grant changed' using errcode = '55000';
  end if;
  select * into strict v_batch from public.apply_batches where org_id = v_org and profile_id = v_profile
    and id = (v_provenance ->> 'applyBatchId')::uuid for update;
  select * into strict v_source from mcp.bid_proposal_sources where org_id = v_org and profile_id = v_profile
    and batch_id = v_batch.id and plan_id = (v_plan ->> 'id')::uuid;
  select * into strict v_preview from mcp.write_previews where org_id = v_org and profile_id = v_profile and plan_id = v_source.plan_id;
  select * into strict v_delegation from mcp.write_delegations where org_id = v_org and key_id = v_preview.key_id
    and version_id = v_preview.delegation_version_id;
  perform app.mcp_keyword_preview_json(v_source.artifact,'proposal');
  if v_batch.source_kind <> 'mcp_keyword_proposals' or v_batch.status <> 'staged'
    or v_source.artifact_text is distinct from v_provenance ->> 'artifactText'
    or v_source.artifact_sha256 is distinct from v_provenance ->> 'artifactSha256'
    or v_source.artifact -> 'rows' is distinct from v_provenance -> 'rows'
    or v_source.artifact -> 'preparedAt' is distinct from v_provenance -> 'preparedAt'
    or v_delegation.artifact is distinct from v_guard -> 'delegation'
    or v_preview.prepared_at < v_delegation.issued_at
    or v_preview.prepared_at > (v_plan ->> 'generatedAt')::timestamptz
    or (v_plan ->> 'frozenAt')::timestamptz >= v_delegation.expires_at
    or (v_plan ->> 'expiresAt')::timestamptz > v_delegation.expires_at then
    raise exception 'MCP preview source or delegation differs' using errcode = '22023';
  end if;
  perform app.assert_mcp_bid_plan_limits(v_plan,v_delegation.artifact);
  v_count := 0;
  for v_row in select * from public.apply_rows where org_id = v_org and profile_id = v_profile
    and batch_id = v_batch.id order by id for share loop
    select * into strict v_keyword from public.keywords where org_id = v_org and profile_id = v_profile
      and amazon_id = v_row.entity_id and ad_product = 'SP' and deleted_at is null and state in ('enabled','paused') for share;
    select a into strict v_action from jsonb_array_elements(v_plan -> 'actions') a
      where a -> 'sources' = jsonb_build_array(jsonb_build_object('kind','apply_row','applyRowId',v_row.id,'changeKey','keyword.bid'));
    if v_keyword.bid is distinct from (v_row.old_value #>> '{}')::numeric
      or v_action #>> '{entity,keywordId}' is distinct from v_row.entity_id
      or v_action #>> '{changes,bid,expected,amount}' is distinct from v_row.old_value #>> '{}'
      or v_action #>> '{changes,bid,requested,amount}' is distinct from v_row.new_value #>> '{}' then
      raise exception 'MCP keyword source changed' using errcode = '55000';
    end if;
    v_count := v_count + 1;
  end loop;
  if v_count <> (v_plan #>> '{counts,providerRows}')::integer then
    raise exception 'MCP source row count differs' using errcode = '22023';
  end if;
end;
$$;
revoke all on function app.assert_mcp_bid_preview_source_v2(text,text,text,text,text) from public,anon,authenticated,service_role;

create function app.prepare_mcp_bid_proposals_v1(
  p_org uuid, p_key uuid, p_hash text, p_request_text text, p_request_preimage text,
  p_source_text text, p_plan_text text, p_plan_preimage text, p_actions jsonb,
  p_evidence_text text, p_guardrail_preimage text, p_provenance_preimage text
)
returns uuid language plpgsql security definer set search_path = pg_catalog, public, app, mcp, pg_temp as $$
declare
  v_request jsonb := p_request_text::jsonb; v_source jsonb := p_source_text::jsonb;
  v_plan jsonb := p_plan_text::jsonb; v_context jsonb; v_existing mcp.write_previews%rowtype;
  v_profile uuid := (v_request ->> 'profileId')::uuid; v_plan_id uuid := (v_plan ->> 'id')::uuid;
  v_batch uuid := (v_source ->> 'applyBatchId')::uuid; v_row jsonb; v_count integer;
  v_uuid text := '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$';
begin
  perform app.assert_service_role('prepare_mcp_bid_proposals_v1');
  perform app.mcp_keyword_preview_json(v_source,'proposal');
  if p_request_preimage is distinct from '["openspell.mcp-bid-preview-request.v1",' || app.mcp_keyword_preview_json(v_request,'request') || ']' then
    raise exception 'MCP request fingerprint bytes differ from shared contract' using errcode = '22023';
  end if;
  if not coalesce(app.sp_write_exact_json_keys(v_request,array['requestId','profileId','source'])
    and v_request ->> 'requestId' ~ v_uuid and v_request ->> 'profileId' ~ v_uuid
    and p_request_preimage::jsonb = jsonb_build_array('openspell.mcp-bid-preview-request.v1',v_request)
    and app.sp_write_exact_json_keys(v_request -> 'source',array['kind','note','rows'])
    and v_request #>> '{source,kind}' = 'keyword_proposals'
    and jsonb_typeof(v_request #> '{source,note}') = 'string'
    and length(v_request #>> '{source,note}') between 1 and 1000
    and btrim(v_request #>> '{source,note}') = v_request #>> '{source,note}'
    and jsonb_typeof(v_request #> '{source,rows}') = 'array'
    and jsonb_array_length(v_request #> '{source,rows}') between 1 and 500
    and app.sp_write_exact_json_keys(v_source,array['schemaVersion','orgId','profileId','applyBatchId','requestId','keyId','issuerUserId','delegationVersionId','preparedAt','note','rows'])
    and v_source ->> 'schemaVersion' = 'openspell.mcp-bid-proposal.v1'
    and v_source ->> 'orgId' = p_org::text and v_source ->> 'profileId' = v_profile::text
    and v_source ->> 'keyId' = p_key::text and v_source -> 'requestId' = v_request -> 'requestId'
    and v_source ->> 'applyBatchId' ~ v_uuid
    and v_source ->> 'note' = v_request #>> '{source,note}'
    and jsonb_typeof(v_source -> 'rows') = 'array'
    and v_plan ->> 'orgId' = p_org::text and v_plan ->> 'profileId' = v_profile::text, false) then
    raise exception 'invalid MCP proposal request' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('mcp-preview:' || p_org::text || ':' || p_key::text || ':' || (v_request ->> 'requestId'),0));
  v_context := app.mcp_bid_preview_context(p_org,p_key,p_hash,v_profile);
  select * into v_existing from mcp.write_previews where org_id = p_org and key_id = p_key
    and request_id = (v_request ->> 'requestId')::uuid;
  if found then
    if v_existing.request is distinct from v_request then
      raise exception 'MCP preview request identity conflict' using errcode = '23505';
    end if;
    return v_existing.plan_id;
  end if;
  if v_source ->> 'issuerUserId' is distinct from v_context #>> '{delegation,issuerUserId}'
    or v_source ->> 'delegationVersionId' is distinct from v_context #>> '{delegation,versionId}'
    or v_source ->> 'preparedAt' is distinct from v_plan ->> 'generatedAt'
    or v_plan -> 'generatedAt' is distinct from v_plan -> 'frozenAt'
    or (v_plan ->> 'generatedAt')::timestamptz > clock_timestamp()
    or (v_plan ->> 'expiresAt')::timestamptz <= clock_timestamp()
    or (v_plan ->> 'expiresAt')::timestamptz > (v_plan ->> 'generatedAt')::timestamptz + interval '15 minutes'
    or v_plan -> 'providerScope' is distinct from v_context -> 'providerScope' then
    raise exception 'MCP proposal authority or time differs' using errcode = '22023';
  end if;
  perform app.assert_mcp_bid_plan_limits(v_plan,v_context -> 'delegation');
  insert into mcp.write_previews(plan_id,org_id,profile_id,key_id,delegation_version_id,request_id,
    request_text,request,request_preimage,request_fingerprint,prepared_at)
    values(v_plan_id,p_org,v_profile,p_key,(v_source ->> 'delegationVersionId')::uuid,(v_request ->> 'requestId')::uuid,
      p_request_text,v_request,p_request_preimage,app.sp_write_sha256(p_request_preimage),(v_source ->> 'preparedAt')::timestamptz);
  insert into public.apply_batches(id,org_id,profile_id,tag,opt_group,lever,note,source_kind,artifact_sha256,
    exported_proposals,reversible_rows,unsupported_rows,created_by,exported_at)
    values(v_batch,p_org,v_profile,v_batch::text,'mcp','bid',v_source ->> 'note','mcp_keyword_proposals',app.sp_write_sha256(p_source_text),
      0,jsonb_array_length(v_source -> 'rows'),0,(v_source ->> 'issuerUserId')::uuid,(v_source ->> 'preparedAt')::timestamptz);
  for v_row in select value from jsonb_array_elements(v_source -> 'rows') loop
    if not coalesce(app.sp_write_exact_json_keys(v_row,array['keywordId','expectedBid','requestedBid','applyRowId'])
      and v_row ->> 'applyRowId' ~ v_uuid and jsonb_typeof(v_row -> 'keywordId') = 'string'
      and length(v_row ->> 'keywordId') > 0, false) then
      raise exception 'invalid MCP source row' using errcode = '22023';
    end if;
    insert into public.apply_rows(id,batch_id,org_id,profile_id,entity_type,entity_id,entity_name,field,old_value,new_value)
      select (v_row ->> 'applyRowId')::uuid,v_batch,p_org,v_profile,'keyword',amazon_id,name,'bid',
        v_row -> 'expectedBid',v_row -> 'requestedBid'
      from public.keywords where org_id = p_org and profile_id = v_profile and amazon_id = v_row ->> 'keywordId'
        and ad_product = 'SP' and deleted_at is null and state in ('enabled','paused');
    get diagnostics v_count = row_count;
    if v_count <> 1 then raise exception 'MCP keyword unavailable' using errcode = '55000'; end if;
  end loop;
  insert into mcp.bid_proposal_sources(batch_id,org_id,profile_id,plan_id,artifact_text,artifact,artifact_sha256)
    values(v_batch,p_org,v_profile,v_plan_id,p_source_text,v_source,app.sp_write_sha256(p_source_text));
  perform app.record_sp_write_preview(p_plan_text,p_plan_preimage,p_actions,p_evidence_text,p_guardrail_preimage,p_provenance_preimage);
  insert into public.audit_log(org_id,actor_type,actor_id,action,target_type,target_id,payload,source)
    values(p_org,'mcp',p_key::text,'mcp.bid_preview.prepared','sp_write_plan',v_plan_id::text,
      jsonb_build_object('requestId',v_request -> 'requestId','issuerUserId',v_source -> 'issuerUserId',
        'delegationVersionId',v_source -> 'delegationVersionId','profileId',v_profile,'rows',jsonb_array_length(v_source -> 'rows')), 'mcp');
  get diagnostics v_count = row_count;
  if v_count <> 1 then raise exception 'MCP preview audit count mismatch' using errcode = '55000'; end if;
  return v_plan_id;
end;
$$;
revoke all on function app.prepare_mcp_bid_proposals_v1(uuid,uuid,text,text,text,text,text,text,jsonb,text,text,text) from public,anon,authenticated;
grant execute on function app.prepare_mcp_bid_proposals_v1(uuid,uuid,text,text,text,text,text,text,jsonb,text,text,text) to service_role;
create trigger audit_log_mcp_preview_immutable before update or delete on public.audit_log
  for each row when (old.action = 'mcp.bid_preview.prepared')
  execute function app.reject_sp_write_evidence_change();

-- Plan v2 is the bounded keyword-bid source sequence. It has no locale-dependent
-- sorting rule; persistence proves every position against its immutable source.
-- This validator establishes canonical shared bytes before any row is inserted.
create function app.assert_sp_keyword_plan_v2(p_plan jsonb, p_preimage text)
returns void language plpgsql immutable set search_path = pg_catalog, app, pg_temp as $$
declare
  v_action jsonb; v_source jsonb; v_count integer; v_currency text := p_plan #>> '{providerScope,currencyCode}';
  v_direction text := p_plan ->> 'direction';
  v_decimal text := '^(0|[1-9][0-9]{0,7})([.][0-9]{0,3}[1-9])?$';
begin
  if p_preimage is distinct from '["openspell.sp-write-plan.v2",' ||
    app.mcp_keyword_preview_json(p_plan - 'fingerprint','plan_preimage') || ']'
    or p_plan ->> 'fingerprint' is distinct from app.sp_write_sha256(p_preimage) then
    raise exception 'v2 plan fingerprint bytes differ from shared contract' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_plan -> 'actions');
  if not coalesce(p_plan ->> 'schemaVersion' = 'openspell.sp-write-plan.v2'
    and v_direction in ('forward','inverse')
    and p_plan #>> '{source,kind}' = case v_direction when 'forward' then 'apply_batch' else 'inverse_execution' end
    and p_plan #>> '{providerScope,region}' in ('NA','EU','FE')
    and p_plan #>> '{providerScope,apiDialect}' = 'sp_v3'
    and length(p_plan #>> '{providerScope,amazonProfileId}') > 0
    and length(p_plan #>> '{providerScope,marketplaceId}') > 0 and v_currency ~ '^[A-Z]{3}$'
    and p_plan ->> 'generatedAt' ~ 'T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$'
    and p_plan ->> 'frozenAt' ~ 'T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$'
    and p_plan ->> 'expiresAt' ~ 'T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$'
    and date_trunc('milliseconds',(p_plan ->> 'generatedAt')::timestamptz)
      <= date_trunc('milliseconds',(p_plan ->> 'frozenAt')::timestamptz)
    and date_trunc('milliseconds',(p_plan ->> 'frozenAt')::timestamptz)
      < date_trunc('milliseconds',(p_plan ->> 'expiresAt')::timestamptz)
    and v_count between 1 and 500
    and (p_plan #>> '{counts,providerRows}')::integer = v_count
    and (p_plan #>> '{counts,logicalChanges}')::integer = v_count
    and (p_plan #>> '{counts,uniqueEntities}')::integer = v_count
    and p_plan #> '{counts,byRoute}' = jsonb_build_object('sp.v3.campaigns.update',0,'sp.v3.ad_groups.update',0,
      'sp.v3.keywords.update',v_count,'sp.v3.targets.update',0,'sp.v3.product_ads.update',0)
    and (select count(distinct a ->> 'actionId') from jsonb_array_elements(p_plan -> 'actions') a) = v_count
    and (select count(distinct a #>> '{entity,keywordId}') from jsonb_array_elements(p_plan -> 'actions') a) = v_count,
    false) then raise exception 'v2 keyword plan shape differs from shared contract' using errcode = '22023'; end if;
  for v_action in select value from jsonb_array_elements(p_plan -> 'actions') loop
    v_source := v_action #> '{sources,0}';
    if not coalesce(v_action ->> 'routeKey' = 'sp.v3.keywords.update'
      and length(v_action #>> '{entity,keywordId}') > 0 and jsonb_array_length(v_action -> 'sources') = 1
      and v_source ->> 'kind' = case v_direction when 'forward' then 'apply_row' else 'inverse_action' end
      and v_source ->> 'changeKey' = 'keyword.bid'
      and v_action #>> '{changes,bid,expected,amount}' ~ v_decimal
      and v_action #>> '{changes,bid,requested,amount}' ~ v_decimal
      and (v_action #>> '{changes,bid,expected,amount}')::numeric > 0
      and (v_action #>> '{changes,bid,requested,amount}')::numeric > 0
      and v_action #> '{changes,bid,expected,amount}' <> v_action #> '{changes,bid,requested,amount}'
      and v_action #>> '{changes,bid,expected,currencyCode}' = v_currency
      and v_action #>> '{changes,bid,requested,currencyCode}' = v_currency
      and v_action ->> 'fingerprint' = app.sp_write_sha256('["openspell.sp-write-action.v1",' ||
        app.mcp_keyword_preview_json(v_action - 'fingerprint','action_preimage') || ']'), false) then
      raise exception 'v2 action is not an exact keyword bid change' using errcode = '22023';
    end if;
  end loop;
  if (select count(distinct case v_direction when 'forward' then a #>> '{sources,0,applyRowId}'
    else a #>> '{sources,0,sourceActionId}' end) from jsonb_array_elements(p_plan -> 'actions') a) <> v_count then
    raise exception 'v2 plan repeats its immutable source' using errcode = '22023';
  end if;
end;
$$;
revoke all on function app.assert_sp_keyword_plan_v2(jsonb,text) from public,anon,authenticated,service_role;

-- No credential or caller-provided ordinal proves this relation. Forward rows
-- already exist in the private source transaction; inverses bind a stored plan.
create function app.assert_sp_keyword_plan_source_v2(p_plan jsonb)
returns void language plpgsql stable set search_path = pg_catalog, public, app, mcp, pg_temp as $$
declare
  v_source jsonb; v_parent jsonb; v_action jsonb; v_row jsonb; v_index integer;
  v_org uuid := (p_plan ->> 'orgId')::uuid; v_profile uuid := (p_plan ->> 'profileId')::uuid;
  v_count integer := jsonb_array_length(p_plan -> 'actions');
begin
  if p_plan ->> 'direction' = 'forward' then
    select s.artifact into v_source from mcp.bid_proposal_sources s
      join mcp.write_previews p on p.org_id = s.org_id and p.profile_id = s.profile_id and p.plan_id = s.plan_id
      join public.apply_batches b on b.org_id = s.org_id and b.profile_id = s.profile_id and b.id = s.batch_id
      where s.org_id = v_org and s.profile_id = v_profile and s.plan_id::text = p_plan ->> 'id'
        and s.batch_id::text = p_plan #>> '{source,applyBatchId}' and b.source_kind = 'mcp_keyword_proposals';
    if not found or jsonb_array_length(v_source -> 'rows') is distinct from v_count then
      raise exception 'v2 forward requires its exact private proposal source' using errcode = '22023';
    end if;
    for v_action,v_index in select value,(ordinality - 1)::integer
      from jsonb_array_elements(p_plan -> 'actions') with ordinality loop
      v_row := v_source -> 'rows' -> v_index;
      if v_action -> 'sources' is distinct from jsonb_build_array(jsonb_build_object(
        'kind','apply_row','applyRowId',v_row ->> 'applyRowId','changeKey','keyword.bid'))
        or v_action #>> '{entity,keywordId}' is distinct from v_row ->> 'keywordId'
        or v_action #>> '{changes,bid,expected,amount}' is distinct from v_row ->> 'expectedBid'
        or v_action #>> '{changes,bid,requested,amount}' is distinct from v_row ->> 'requestedBid' then
        raise exception 'v2 forward action sequence differs from its source' using errcode = '22023';
      end if;
    end loop;
  elsif p_plan ->> 'direction' = 'inverse' then
    select artifact into v_parent from public.sp_write_plans where org_id = v_org and profile_id = v_profile
      and plan_id::text = p_plan #>> '{source,sourcePlanId}'
      and fingerprint = p_plan #>> '{source,sourcePlanFingerprint}' and direction = 'forward';
    if not found or v_parent ->> 'schemaVersion' is distinct from 'openspell.sp-write-plan.v2'
      or p_plan -> 'providerScope' is distinct from v_parent -> 'providerScope'
      or p_plan -> 'counts' is distinct from v_parent -> 'counts'
      or jsonb_array_length(v_parent -> 'actions') is distinct from v_count then
      raise exception 'v2 inverse requires its immutable v2 forward plan' using errcode = '22023';
    end if;
    for v_action,v_index in select value,(ordinality - 1)::integer
      from jsonb_array_elements(p_plan -> 'actions') with ordinality loop
      v_row := v_parent -> 'actions' -> v_index;
      if v_action -> 'sources' is distinct from jsonb_build_array(jsonb_build_object(
        'kind','inverse_action','sourceActionId',v_row ->> 'actionId','changeKey','keyword.bid'))
        or v_action -> 'actionId' = v_row -> 'actionId'
        or v_action -> 'routeKey' is distinct from v_row -> 'routeKey'
        or v_action -> 'entity' is distinct from v_row -> 'entity'
        or v_action #> '{changes,bid,expected}' is distinct from v_row #> '{changes,bid,requested}'
        or v_action #> '{changes,bid,requested}' is distinct from v_row #> '{changes,bid,expected}' then
        raise exception 'v2 inverse sequence is not the exact source swap' using errcode = '22023';
      end if;
    end loop;
  else raise exception 'v2 plan direction is invalid' using errcode = '22023';
  end if;
end;
$$;
revoke all on function app.assert_sp_keyword_plan_source_v2(jsonb) from public,anon,authenticated,service_role;

-- The original general route comparison remains private and unchanged. The
-- wrapper adds v2 version/position constraints without exposing a legacy RPC.
alter function app.sp_write_inverse_pair_exact(uuid,uuid) rename to sp_write_inverse_pair_exact_legacy_inner;
revoke all on function app.sp_write_inverse_pair_exact_legacy_inner(uuid,uuid) from public,anon,authenticated,service_role;
create function app.sp_write_inverse_pair_exact(p_forward_plan_id uuid,p_inverse_plan_id uuid)
returns boolean language plpgsql stable strict set search_path = pg_catalog, public, app, pg_temp as $$
declare v_forward public.sp_write_plans%rowtype; v_inverse public.sp_write_plans%rowtype;
begin
  select * into v_forward from public.sp_write_plans where plan_id = p_forward_plan_id;
  if not found then return false; end if;
  select * into v_inverse from public.sp_write_plans where plan_id = p_inverse_plan_id;
  if not found then return false; end if;
  if v_forward.artifact ->> 'schemaVersion' = 'openspell.sp-write-plan.v2'
    or v_inverse.artifact ->> 'schemaVersion' = 'openspell.sp-write-plan.v2' then
    if v_forward.artifact ->> 'schemaVersion' is distinct from 'openspell.sp-write-plan.v2'
      or v_inverse.artifact ->> 'schemaVersion' is distinct from 'openspell.sp-write-plan.v2'
      or v_inverse.source_plan_id is distinct from p_forward_plan_id then return false; end if;
    perform app.assert_sp_keyword_plan_v2(v_inverse.artifact,v_inverse.fingerprint_preimage);
    perform app.assert_sp_keyword_plan_source_v2(v_inverse.artifact);
  end if;
  return app.sp_write_inverse_pair_exact_legacy_inner(p_forward_plan_id,p_inverse_plan_id);
exception when others then return false;
end;
$$;
revoke all on function app.sp_write_inverse_pair_exact(uuid,uuid) from public,anon,authenticated,service_role;

-- Preserve the existing service RPC and its persistence/count checks. No callable legacy bypass.
create or replace function app.record_sp_write_plan(
  p_plan_text text,
  p_plan_fingerprint_preimage text,
  p_action_proofs jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_plan jsonb;
  v_action jsonb;
  v_proof jsonb;
  v_action_text text;
  v_action_preimage text;
  v_org_id uuid;
  v_profile_id uuid;
  v_plan_id uuid;
  v_direction public.sp_write_plan_direction;
  v_route public.sp_write_route_key;
  v_entity_id text;
  v_index integer;
  v_inserted integer := 0;
  v_logical_changes integer := 0;
  v_existing public.sp_write_plans%rowtype;
  v_version text;
begin
  perform app.assert_service_role('record_sp_write_plan');
  v_version := p_plan_text::jsonb ->> 'schemaVersion';
  if v_version is null or v_version not in ('openspell.sp-write-plan.v1','openspell.sp-write-plan.v2') then
    raise exception 'unrecognized SP write plan version' using errcode = '22023';
  end if;
  v_plan := app.sp_write_verified_artifact(p_plan_text,p_plan_fingerprint_preimage,v_version);
  if v_version = 'openspell.sp-write-plan.v2' then
    perform app.assert_sp_keyword_plan_v2(v_plan,p_plan_fingerprint_preimage);
    perform app.assert_sp_keyword_plan_source_v2(v_plan);
  elsif v_plan ->> 'direction' = 'inverse' and exists (
    select 1 from public.sp_write_plans parent where parent.org_id::text = v_plan ->> 'orgId'
      and parent.profile_id::text = v_plan ->> 'profileId'
      and parent.plan_id::text = v_plan #>> '{source,sourcePlanId}'
      and parent.artifact ->> 'schemaVersion' = 'openspell.sp-write-plan.v2'
  ) then
    raise exception 'v2 source requires a v2 inverse' using errcode = '22023';
  end if;
  if not app.sp_write_exact_json_keys(v_plan, array[
    'schemaVersion','id','orgId','profileId','providerScope','direction','source',
    'generatedAt','frozenAt','expiresAt','actions','counts','fingerprint'
  ])
     or v_plan ->> 'schemaVersion' <> v_version
     or not app.sp_write_exact_json_keys(v_plan -> 'providerScope', array[
       'amazonProfileId','connectionId','region','marketplaceId','currencyCode','apiDialect'
     ])
     or pg_catalog.jsonb_typeof(v_plan -> 'actions') <> 'array'
     or pg_catalog.jsonb_typeof(p_action_proofs) <> 'array'
     or pg_catalog.jsonb_array_length(v_plan -> 'actions')
        <> pg_catalog.jsonb_array_length(p_action_proofs) then
    raise exception 'SP write plan relational shape mismatch' using errcode = '22023';
  end if;

  begin
    v_org_id := (v_plan ->> 'orgId')::uuid;
    v_profile_id := (v_plan ->> 'profileId')::uuid;
    v_plan_id := (v_plan ->> 'id')::uuid;
    v_direction := (v_plan ->> 'direction')::public.sp_write_plan_direction;
  exception when others then
    raise exception 'SP write plan identity is invalid' using errcode = '22023';
  end;

  select * into v_existing from public.sp_write_plans where plan_id = v_plan_id;
  if found then
    raise exception 'SP write plan identity collision' using errcode = '23505';
  end if;

  insert into public.sp_write_plans (
    plan_id, org_id, profile_id, direction, artifact_text, artifact,
    fingerprint_preimage, fingerprint, amazon_profile_id, connection_id,
    region, marketplace_id, currency_code, api_dialect,
    source_execution_id, source_plan_id, source_plan_fingerprint,
    generated_at, frozen_at, expires_at, logical_changes, provider_rows,
    unique_entities
  ) values (
    v_plan_id, v_org_id, v_profile_id, v_direction, p_plan_text, v_plan,
    p_plan_fingerprint_preimage, v_plan ->> 'fingerprint',
    v_plan #>> '{providerScope,amazonProfileId}',
    (v_plan #>> '{providerScope,connectionId}')::uuid,
    (v_plan #>> '{providerScope,region}')::public.ads_region,
    v_plan #>> '{providerScope,marketplaceId}',
    v_plan #>> '{providerScope,currencyCode}',
    v_plan #>> '{providerScope,apiDialect}',
    case when v_direction = 'inverse'
      then (v_plan #>> '{source,sourceExecutionId}')::uuid end,
    case when v_direction = 'inverse'
      then (v_plan #>> '{source,sourcePlanId}')::uuid end,
    case when v_direction = 'inverse'
      then v_plan #>> '{source,sourcePlanFingerprint}' end,
    (v_plan ->> 'generatedAt')::timestamptz,
    (v_plan ->> 'frozenAt')::timestamptz,
    (v_plan ->> 'expiresAt')::timestamptz,
    (v_plan #>> '{counts,logicalChanges}')::integer,
    (v_plan #>> '{counts,providerRows}')::integer,
    (v_plan #>> '{counts,uniqueEntities}')::integer
  );

  for v_action, v_index in
    select value, (ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(v_plan -> 'actions') with ordinality
  loop
    v_proof := p_action_proofs -> v_index;
    if not app.sp_write_exact_json_keys(v_proof, array['artifactText','fingerprintPreimage']) then
      raise exception 'SP write action proof shape mismatch' using errcode = '22023';
    end if;
    v_action_text := v_proof ->> 'artifactText';
    v_action_preimage := v_proof ->> 'fingerprintPreimage';
    if v_action_text::jsonb <> v_action then
      raise exception 'SP write action text differs from nested plan action'
        using errcode = '22023';
    end if;
    v_action := app.sp_write_verified_artifact(
      v_action_text, v_action_preimage, 'openspell.sp-write-action.v1'
    );
    if not app.sp_write_exact_json_keys(
      v_action, array['actionId','sources','fingerprint','routeKey','entity','changes']
    ) or pg_catalog.jsonb_typeof(v_action -> 'sources') <> 'array' then
      raise exception 'SP write action relational shape mismatch' using errcode = '22023';
    end if;
    if v_version = 'openspell.sp-write-plan.v2' and v_action_preimage is distinct from
      '["openspell.sp-write-action.v1",' || app.mcp_keyword_preview_json(v_action - 'fingerprint','action_preimage') || ']' then
      raise exception 'v2 action fingerprint bytes differ from shared contract' using errcode = '22023';
    end if;
    v_route := (v_action ->> 'routeKey')::public.sp_write_route_key;
    v_entity_id := app.sp_write_action_entity_id(v_action);
    if v_entity_id is null or v_entity_id = '' then
      raise exception 'SP write action entity is empty' using errcode = '22023';
    end if;
    insert into public.sp_write_plan_actions (
      org_id, profile_id, plan_id, action_id, action_index, route_key,
      amazon_entity_id, artifact_text, artifact, fingerprint_preimage, fingerprint
    ) values (
      v_org_id, v_profile_id, v_plan_id, (v_action ->> 'actionId')::uuid,
      v_index, v_route, v_entity_id, v_action_text, v_action,
      v_action_preimage, v_action ->> 'fingerprint'
    );
    v_inserted := v_inserted + 1;
    v_logical_changes := v_logical_changes
      + pg_catalog.jsonb_array_length(v_action -> 'sources');
  end loop;

  if v_inserted <> (v_plan #>> '{counts,providerRows}')::integer
     or v_logical_changes <> (v_plan #>> '{counts,logicalChanges}')::integer
     or v_inserted <> (v_plan #>> '{counts,uniqueEntities}')::integer
     or exists (
       select 1
       from pg_catalog.jsonb_each_text(v_plan #> '{counts,byRoute}') expected(route, count)
       where (
         select count(*)
         from public.sp_write_plan_actions action
         where action.org_id = v_org_id and action.profile_id = v_profile_id
           and action.plan_id = v_plan_id and action.route_key::text = expected.route
       ) <> expected.count::integer
     ) then
    raise exception 'SP write plan action counts do not close' using errcode = '22023';
  end if;
  return v_plan_id;
end;
$$;

revoke all on function app.record_sp_write_plan(text,text,jsonb) from public,anon,authenticated;
grant execute on function app.record_sp_write_plan(text,text,jsonb) to service_role;
