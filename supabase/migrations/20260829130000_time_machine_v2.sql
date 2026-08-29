-- wizard-ads WP-61: evidence-backed Time Machine and conflict-safe reversion exports.
--
-- This migration changes only the Wizard Ads ledger. It does not add an
-- Amazon mutation path. Reversions remain staged files that an operator must
-- review and apply outside Wizard Ads.

alter table public.apply_batches
  add column source_batch_id uuid,
  add column exported_at timestamptz,
  add column applied_at timestamptz,
  add column artifact_sha256 text,
  add column exported_proposals integer,
  add column reversible_rows integer,
  add column unsupported_rows integer;

update public.apply_batches b
   set exported_at = b.created_at,
       applied_at = case
         when b.status in ('applied', 'reverted') and b.applied_on is not null
           then b.applied_on::timestamptz
         else null
       end,
       exported_proposals = greatest(
         (select count(*)::integer from public.recommendations r where r.export_batch_id = b.id),
         (select count(*)::integer from public.apply_rows ar where ar.batch_id = b.id)
       ),
       reversible_rows = (select count(*)::integer from public.apply_rows ar where ar.batch_id = b.id),
       unsupported_rows = greatest(
         (select count(*)::integer from public.recommendations r where r.export_batch_id = b.id)
           - (select count(*)::integer from public.apply_rows ar where ar.batch_id = b.id),
         0
       );

alter table public.apply_batches
  alter column exported_at set not null,
  alter column exported_at set default now(),
  alter column exported_proposals set not null,
  alter column exported_proposals set default 0,
  alter column reversible_rows set not null,
  alter column reversible_rows set default 0,
  alter column unsupported_rows set not null,
  alter column unsupported_rows set default 0,
  add constraint apply_batches_artifact_sha256_shape check (
    artifact_sha256 is null or artifact_sha256 ~ '^[a-f0-9]{64}$'
  ),
  add constraint apply_batches_export_counts check (
    exported_proposals >= 0
    and reversible_rows >= 0
    and unsupported_rows >= 0
    and exported_proposals = reversible_rows + unsupported_rows
  );

create unique index apply_batches_org_profile_id_key
  on public.apply_batches (org_id, profile_id, id);

create unique index apply_batches_active_reversion_key
  on public.apply_batches (source_batch_id)
  where source_batch_id is not null and status <> 'abandoned';

alter table public.apply_batches
  add constraint apply_batches_profile_fkey foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  add constraint apply_batches_source_batch_fkey foreign key (org_id, profile_id, source_batch_id)
    references public.apply_batches (org_id, profile_id, id) on delete restrict;

alter table public.apply_rows
  add column profile_id uuid,
  add column recommendation_id uuid;

update public.apply_rows ar
   set profile_id = b.profile_id
  from public.apply_batches b
 where b.id = ar.batch_id
   and b.org_id = ar.org_id;

alter table public.apply_rows
  alter column profile_id set not null,
  add constraint apply_rows_batch_fkey_v2 foreign key (org_id, profile_id, batch_id)
    references public.apply_batches (org_id, profile_id, id) on delete cascade,
  add constraint apply_rows_recommendation_fkey foreign key (org_id, profile_id, recommendation_id)
    references public.recommendations (org_id, profile_id, id) on delete restrict;

create unique index apply_rows_org_profile_id_key
  on public.apply_rows (org_id, profile_id, id);

create index apply_rows_profile_entity_idx
  on public.apply_rows (org_id, profile_id, entity_type, entity_id, field);

alter table public.entity_changes
  add column apply_row_id uuid,
  add constraint entity_changes_apply_batch_fkey foreign key (org_id, profile_id, apply_batch_id)
    references public.apply_batches (org_id, profile_id, id) on delete restrict,
  add constraint entity_changes_apply_row_fkey foreign key (org_id, profile_id, apply_row_id)
    references public.apply_rows (org_id, profile_id, id) on delete restrict;

create unique index entity_changes_apply_row_once_key
  on public.entity_changes (apply_row_id)
  where apply_row_id is not null;

-- Amazon entity snapshots and operator exports use different spellings for a
-- few equivalent fields. Keep that translation in one immutable database
-- function so current-state resolution, synchronization linking, and preview
-- reconstruction cannot drift apart.
create or replace function app.canonical_apply_field(
  p_entity_type text,
  p_field text
)
returns text
language sql
immutable
strict
set search_path = pg_catalog, public, pg_temp
as $$
  select case
    when p_entity_type = 'campaign'
      and p_field in ('budget', 'budget_amount', 'budgetAmount') then 'budget'
    when p_entity_type = 'ad_group'
      and p_field in ('bid', 'default_bid', 'defaultBid') then 'bid'
    else p_field
  end
$$;

grant execute on function app.canonical_apply_field(text, text)
  to authenticated, service_role;

-- Resolve the current synchronized scalar for one staged update. Unsupported
-- fields return a row with supported=false; missing/deleted entities return a
-- supported row with present=false. Callers can therefore distinguish an
-- unsupported adapter from a genuine JSON null.
create or replace function app.resolve_apply_current_value(
  p_org_id uuid,
  p_profile_id uuid,
  p_entity_type public.apply_entity_type,
  p_entity_id text,
  p_field text
)
returns table (
  supported boolean,
  present boolean,
  current_value jsonb,
  current_synced_at timestamptz
)
language plpgsql
stable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_field text := app.canonical_apply_field(p_entity_type::text, p_field);
begin
  supported := false;
  present := false;
  current_value := null;
  current_synced_at := null;

  if p_entity_type = 'keyword' and v_field in ('bid', 'state') then
    supported := true;
    select k.deleted_at is null,
           case when v_field = 'bid' then to_jsonb(k.bid) else to_jsonb(k.state::text) end,
           k.synced_at
      into present, current_value, current_synced_at
      from public.keywords k
     where k.org_id = p_org_id and k.profile_id = p_profile_id and k.amazon_id = p_entity_id;
    if not found then present := false; end if;
  elsif p_entity_type = 'target' and v_field in ('bid', 'state') then
    supported := true;
    select t.deleted_at is null,
           case when v_field = 'bid' then to_jsonb(t.bid) else to_jsonb(t.state::text) end,
           t.synced_at
      into present, current_value, current_synced_at
      from public.targets t
     where t.org_id = p_org_id and t.profile_id = p_profile_id and t.amazon_id = p_entity_id;
    if not found then present := false; end if;
  elsif p_entity_type = 'campaign' and v_field in ('budget', 'state') then
    supported := true;
    select c.deleted_at is null,
           case
             when v_field = 'budget' then to_jsonb(c.budget_amount)
             else to_jsonb(c.state::text)
           end,
           c.synced_at
      into present, current_value, current_synced_at
      from public.campaigns c
     where c.org_id = p_org_id and c.profile_id = p_profile_id and c.amazon_id = p_entity_id;
    if not found then present := false; end if;
  elsif p_entity_type = 'ad_group' and v_field in ('bid', 'state') then
    supported := true;
    select a.deleted_at is null,
           case when v_field = 'bid' then to_jsonb(a.default_bid)
                else to_jsonb(a.state::text) end,
           a.synced_at
      into present, current_value, current_synced_at
      from public.ad_groups a
     where a.org_id = p_org_id and a.profile_id = p_profile_id and a.amazon_id = p_entity_id;
    if not found then present := false; end if;
  end if;

  return next;
end;
$$;

grant execute on function app.resolve_apply_current_value(uuid, uuid, public.apply_entity_type, text, text)
  to authenticated, service_role;

-- Link a newly observed sync diff only when exactly one exported row is an
-- exact old/value/new match. Duplicate same-value exports and redelivered
-- changes are counted as ambiguous and stay unlinked.
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
     where b.status = 'staged'
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

grant execute on function app.link_exact_apply_changes(bigint[])
  to service_role;
