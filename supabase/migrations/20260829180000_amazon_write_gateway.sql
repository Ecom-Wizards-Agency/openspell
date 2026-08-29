-- OpenSpell WP-96: guarded Sponsored Products mutation execution ledger.
--
-- Additive only. This migration does not enable a deployment gate, approve a
-- batch, enqueue a write, or call Amazon.

alter type public.sync_job_type add value if not exists 'amazon.apply';
alter type public.sync_job_type add value if not exists 'amazon.observe';

create type public.amazon_write_action_type as enum (
  'sp_keyword_bid',
  'sp_target_bid',
  'sp_campaign_placement'
);
create type public.amazon_write_approval_mode as enum ('manual', 'bounded_live_test');
create type public.amazon_write_execution_status as enum (
  'queued', 'running', 'awaiting_sync', 'succeeded', 'partial', 'refused', 'failed', 'conflict'
);
create type public.amazon_write_row_status as enum (
  'pending', 'retryable', 'accepted', 'failed', 'refused', 'ambiguous'
);
create type public.amazon_write_observation_status as enum ('pending', 'observed', 'conflict');
create type public.amazon_write_attempt_outcome as enum (
  'accepted', 'failed', 'retryable', 'ambiguous'
);

create table public.amazon_write_approvals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  apply_batch_id uuid not null references public.apply_batches (id) on delete restrict,
  mode public.amazon_write_approval_mode not null,
  preview_sha256 text not null check (preview_sha256 ~ '^[a-f0-9]{64}$'),
  approved_count integer not null check (approved_count > 0),
  approved_by uuid not null references auth.users (id) on delete restrict,
  approved_at timestamptz not null,
  expires_at timestamptz not null,
  inverse_preapproved boolean not null default false,
  created_at timestamptz not null default now(),
  constraint amazon_write_approvals_valid_window check (expires_at > approved_at),
  unique (org_id, profile_id, id)
);
create index amazon_write_approvals_profile_idx
  on public.amazon_write_approvals (org_id, profile_id, approved_at desc);
select app.install_tenant_rls('public.amazon_write_approvals');

create table public.amazon_write_executions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  apply_batch_id uuid not null references public.apply_batches (id) on delete restrict,
  approval_id uuid not null references public.amazon_write_approvals (id) on delete restrict,
  idempotency_key text not null unique check (idempotency_key ~ '^[a-f0-9]{64}$'),
  status public.amazon_write_execution_status not null default 'queued',
  requested_count integer not null,
  attempted_count integer not null default 0,
  succeeded_count integer not null default 0,
  failed_count integer not null default 0,
  ambiguous_count integer not null default 0,
  refused_count integer not null default 0,
  resync_requested_count integer not null default 0,
  resynchronized_count integer not null default 0,
  observation_attempts integer not null default 0,
  next_observation_at timestamptz,
  inverse_ready_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint amazon_write_executions_counts check (
    requested_count > 0
    and attempted_count >= 0
    and succeeded_count >= 0
    and failed_count >= 0
    and ambiguous_count >= 0
    and refused_count >= 0
    and resync_requested_count >= 0
    and resynchronized_count >= 0
    and observation_attempts >= 0
    and attempted_count + refused_count <= requested_count
    and succeeded_count + failed_count + ambiguous_count <= attempted_count
    and resynchronized_count <= succeeded_count
  ),
  constraint amazon_write_executions_succeeded_complete check (
    status <> 'succeeded'
    or (
      refused_count = 0
      and failed_count = 0
      and ambiguous_count = 0
      and attempted_count = requested_count
      and succeeded_count = requested_count
      and resynchronized_count = requested_count
      and inverse_ready_at is not null
    )
  ),
  unique (org_id, profile_id, id),
  unique (org_id, profile_id, apply_batch_id),
  unique (approval_id)
);
create index amazon_write_executions_status_idx
  on public.amazon_write_executions (status, next_observation_at);
create trigger amazon_write_executions_touch before update on public.amazon_write_executions
  for each row execute function app.touch_updated_at();
select app.install_tenant_rls('public.amazon_write_executions');

alter table public.amazon_write_approvals
  add constraint amazon_write_approvals_profile_fkey foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  add constraint amazon_write_approvals_batch_fkey foreign key (org_id, profile_id, apply_batch_id)
    references public.apply_batches (org_id, profile_id, id) on delete restrict;

alter table public.amazon_write_executions
  add constraint amazon_write_executions_profile_fkey foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  add constraint amazon_write_executions_batch_fkey foreign key (org_id, profile_id, apply_batch_id)
    references public.apply_batches (org_id, profile_id, id) on delete restrict,
  add constraint amazon_write_executions_approval_fkey foreign key (org_id, profile_id, approval_id)
    references public.amazon_write_approvals (org_id, profile_id, id) on delete restrict;

create table public.amazon_write_rows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  execution_id uuid not null references public.amazon_write_executions (id) on delete restrict,
  apply_row_id uuid not null references public.apply_rows (id) on delete restrict,
  action_type public.amazon_write_action_type not null,
  action jsonb not null,
  expected_value jsonb not null,
  requested_value jsonb not null,
  inverse_value jsonb not null,
  row_status public.amazon_write_row_status not null default 'pending',
  observation_status public.amazon_write_observation_status not null default 'pending',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  refusal_reason text,
  provider_evidence jsonb,
  provider_accepted_at timestamptz,
  current_observed_value jsonb,
  observed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint amazon_write_rows_action_shape check (
    action->>'actionType' = action_type::text
    and action->'applyRowId' = to_jsonb(apply_row_id::text)
    and action->'expectedValue' = expected_value
    and action->'requestedValue' = requested_value
    and action->'inverseValue' = inverse_value
  ),
  unique (org_id, profile_id, id),
  unique (execution_id, apply_row_id)
);
create index amazon_write_rows_execution_status_idx
  on public.amazon_write_rows (execution_id, row_status, observation_status);
create trigger amazon_write_rows_touch before update on public.amazon_write_rows
  for each row execute function app.touch_updated_at();
select app.install_tenant_rls('public.amazon_write_rows');

alter table public.amazon_write_rows
  add constraint amazon_write_rows_execution_fkey foreign key (org_id, profile_id, execution_id)
    references public.amazon_write_executions (org_id, profile_id, id) on delete restrict,
  add constraint amazon_write_rows_apply_row_fkey foreign key (org_id, profile_id, apply_row_id)
    references public.apply_rows (org_id, profile_id, id) on delete restrict;

create table public.amazon_write_attempts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  execution_id uuid not null references public.amazon_write_executions (id) on delete restrict,
  write_row_id uuid not null references public.amazon_write_rows (id) on delete restrict,
  attempt_number integer not null check (attempt_number > 0),
  request_fingerprint text not null unique check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  outcome public.amazon_write_attempt_outcome not null,
  provider_evidence jsonb not null,
  attempted_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (write_row_id, attempt_number)
);
create index amazon_write_attempts_execution_idx
  on public.amazon_write_attempts (execution_id, attempted_at);
select app.install_tenant_rls('public.amazon_write_attempts');

alter table public.amazon_write_attempts
  add constraint amazon_write_attempts_execution_fkey foreign key (org_id, profile_id, execution_id)
    references public.amazon_write_executions (org_id, profile_id, id) on delete restrict,
  add constraint amazon_write_attempts_row_fkey foreign key (org_id, profile_id, write_row_id)
    references public.amazon_write_rows (org_id, profile_id, id) on delete restrict;

-- Approval and provider attempt evidence is append-only. Execution/row status
-- remains mutable because it is the worker's durable state machine.
create or replace function app.reject_amazon_write_immutable_change()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception '% is immutable', tg_table_name;
end;
$$;

create trigger amazon_write_approvals_immutable
  before update or delete on public.amazon_write_approvals
  for each row execute function app.reject_amazon_write_immutable_change();
create trigger amazon_write_attempts_immutable
  before update or delete on public.amazon_write_attempts
  for each row execute function app.reject_amazon_write_immutable_change();

create or replace function app.protect_amazon_write_execution_identity()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'amazon_write_executions is immutable';
  end if;
  if new.org_id is distinct from old.org_id
     or new.profile_id is distinct from old.profile_id
     or new.apply_batch_id is distinct from old.apply_batch_id
     or new.approval_id is distinct from old.approval_id
     or new.idempotency_key is distinct from old.idempotency_key
     or new.requested_count is distinct from old.requested_count
     or new.created_at is distinct from old.created_at then
    raise exception 'amazon write execution identity is immutable';
  end if;
  return new;
end;
$$;

create or replace function app.protect_amazon_write_row_identity()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'amazon_write_rows is immutable';
  end if;
  if new.org_id is distinct from old.org_id
     or new.profile_id is distinct from old.profile_id
     or new.execution_id is distinct from old.execution_id
     or new.apply_row_id is distinct from old.apply_row_id
     or new.action_type is distinct from old.action_type
     or new.action is distinct from old.action
     or new.expected_value is distinct from old.expected_value
     or new.requested_value is distinct from old.requested_value
     or new.inverse_value is distinct from old.inverse_value
     or new.created_at is distinct from old.created_at then
    raise exception 'amazon write row identity is immutable';
  end if;
  return new;
end;
$$;

create trigger amazon_write_executions_identity_immutable
  before update or delete on public.amazon_write_executions
  for each row execute function app.protect_amazon_write_execution_identity();
create trigger amazon_write_rows_identity_immutable
  before update or delete on public.amazon_write_rows
  for each row execute function app.protect_amazon_write_row_identity();

-- Once approved, the exact export artifact and rows cannot be edited or
-- extended. Lifecycle timestamps/status remain available for Time Machine.
create or replace function app.protect_approved_apply_artifact()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_batch_id uuid;
begin
  if tg_table_name = 'apply_rows' then
    v_batch_id := case when tg_op = 'DELETE' then old.batch_id else new.batch_id end;
  else
    v_batch_id := case when tg_op = 'DELETE' then old.id else new.id end;
  end if;
  if not exists (
    select 1 from public.amazon_write_approvals approval
     where approval.apply_batch_id = v_batch_id
  ) then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_table_name = 'apply_rows' then
    raise exception 'approved apply rows are immutable';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'approved apply batches cannot be deleted';
  end if;
  if new.org_id is distinct from old.org_id
     or new.profile_id is distinct from old.profile_id
     or new.tag is distinct from old.tag
     or new.opt_group is distinct from old.opt_group
     or new.lever is distinct from old.lever
     or new.note is distinct from old.note
     or new.artifact_sha256 is distinct from old.artifact_sha256
     or new.exported_proposals is distinct from old.exported_proposals
     or new.reversible_rows is distinct from old.reversible_rows
     or new.unsupported_rows is distinct from old.unsupported_rows then
    raise exception 'approved apply batch artifact is immutable';
  end if;
  return new;
end;
$$;

create trigger apply_rows_approved_immutable
  before insert or update or delete on public.apply_rows
  for each row execute function app.protect_approved_apply_artifact();
create trigger apply_batches_approved_artifact_immutable
  before update or delete on public.apply_batches
  for each row execute function app.protect_approved_apply_artifact();

-- Placement aliases become first-class current-state fields for conflict and
-- inverse checks. The mirror holds percentages in campaign.placement_bidding.
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
    when p_entity_type = 'placement'
      and p_field in ('top_of_search', 'top_of_search_modifier', 'top_of_search_placement', 'tos_modifier')
      then 'top_of_search'
    when p_entity_type = 'placement'
      and p_field in ('product_pages', 'product_pages_modifier', 'product_pages_placement')
      then 'product_pages'
    when p_entity_type = 'placement'
      and p_field in ('rest_of_search', 'rest_of_search_modifier', 'rest_of_search_placement')
      then 'rest_of_search'
    else p_field
  end
$$;

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

  if p_entity_type = 'keyword' and v_field = 'bid' then
    supported := true;
    select k.deleted_at is null, to_jsonb(k.bid), k.synced_at
      into present, current_value, current_synced_at
      from public.keywords k
     where k.org_id = p_org_id and k.profile_id = p_profile_id and k.amazon_id = p_entity_id
       and k.ad_product = 'SP';
    if not found then present := false; end if;
  elsif p_entity_type = 'target' and v_field = 'bid' then
    supported := true;
    select t.deleted_at is null, to_jsonb(t.bid), t.synced_at
      into present, current_value, current_synced_at
      from public.targets t
     where t.org_id = p_org_id and t.profile_id = p_profile_id and t.amazon_id = p_entity_id
       and t.ad_product = 'SP';
    if not found then present := false; end if;
  elsif p_entity_type = 'placement'
        and v_field in ('top_of_search', 'product_pages', 'rest_of_search') then
    supported := true;
    select c.deleted_at is null,
           case v_field
             when 'top_of_search' then c.placement_bidding->'topOfSearch'
             when 'product_pages' then c.placement_bidding->'productPages'
             else c.placement_bidding->'restOfSearch'
           end,
           c.synced_at
      into present, current_value, current_synced_at
      from public.campaigns c
     where c.org_id = p_org_id and c.profile_id = p_profile_id and c.amazon_id = p_entity_id
       and c.ad_product = 'SP';
    if not found then present := false; end if;
  elsif p_entity_type = 'campaign' and v_field in ('budget', 'state') then
    supported := true;
    select c.deleted_at is null,
           case when v_field = 'budget' then to_jsonb(c.budget_amount) else to_jsonb(c.state::text) end,
           c.synced_at
      into present, current_value, current_synced_at
      from public.campaigns c
     where c.org_id = p_org_id and c.profile_id = p_profile_id and c.amazon_id = p_entity_id;
    if not found then present := false; end if;
  elsif p_entity_type = 'ad_group' and v_field in ('bid', 'state') then
    supported := true;
    select a.deleted_at is null,
           case when v_field = 'bid' then to_jsonb(a.default_bid) else to_jsonb(a.state::text) end,
           a.synced_at
      into present, current_value, current_synced_at
      from public.ad_groups a
     where a.org_id = p_org_id and a.profile_id = p_profile_id and a.amazon_id = p_entity_id;
    if not found then present := false; end if;
  elsif p_entity_type = 'keyword' and v_field = 'state' then
    supported := true;
    select k.deleted_at is null, to_jsonb(k.state::text), k.synced_at
      into present, current_value, current_synced_at
      from public.keywords k
     where k.org_id = p_org_id and k.profile_id = p_profile_id and k.amazon_id = p_entity_id;
    if not found then present := false; end if;
  elsif p_entity_type = 'target' and v_field = 'state' then
    supported := true;
    select t.deleted_at is null, to_jsonb(t.state::text), t.synced_at
      into present, current_value, current_synced_at
      from public.targets t
     where t.org_id = p_org_id and t.profile_id = p_profile_id and t.amazon_id = p_entity_id;
    if not found then present := false; end if;
  end if;

  return next;
end;
$$;

grant execute on function app.canonical_apply_field(text, text)
  to authenticated, service_role;
grant execute on function app.resolve_apply_current_value(uuid, uuid, public.apply_entity_type, text, text)
  to authenticated, service_role;
