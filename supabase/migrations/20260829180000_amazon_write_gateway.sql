-- OpenSpell WP-96: guarded Sponsored Products mutation execution ledger.
--
-- Additive only. This migration does not enable a deployment gate, approve a
-- batch, enqueue a write, or call Amazon.

alter type public.sync_job_type add value if not exists 'amazon.apply';
alter type public.sync_job_type add value if not exists 'amazon.observe';

-- Every queue claim gets a fresh fencing token. Worker identity alone is not
-- ownership: a stale-claim sweep may legitimately hand the same row to a new
-- invocation of the same deployment while the old process is still unwinding.
alter table public.sync_jobs add column claim_token uuid;

create or replace function public.claim_sync_jobs(p_worker_id text, p_limit integer)
returns setof public.sync_jobs
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform app.assert_service_role('claim_sync_jobs');
  if p_worker_id is null or length(p_worker_id) = 0 then
    raise exception 'claim_sync_jobs needs a worker id' using errcode = '22023';
  end if;
  return query
  update public.sync_jobs job
     set status = 'running', claimed_by = p_worker_id, claimed_at = now(),
         claim_token = gen_random_uuid(), started_at = coalesce(job.started_at, now()),
         attempts = job.attempts + 1, updated_at = now()
   where job.id in (
     select candidate.id from public.sync_jobs candidate
      where candidate.status = 'queued' and candidate.run_after <= now()
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
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform app.assert_service_role('claim_sync_jobs');
  if p_worker_id is null or length(p_worker_id) = 0 then
    raise exception 'claim_sync_jobs needs a worker id' using errcode = '22023';
  end if;
  return query
  update public.sync_jobs job
     set status = 'running', claimed_by = p_worker_id, claimed_at = now(),
         claim_token = gen_random_uuid(), started_at = coalesce(job.started_at, now()),
         attempts = job.attempts + 1, updated_at = now()
   where job.id in (
     select candidate.id from public.sync_jobs candidate
      where candidate.status = 'queued' and candidate.run_after <= now()
        and (p_job_types is null or candidate.job_type = any(p_job_types))
      order by candidate.priority desc, candidate.run_after, candidate.created_at
      limit greatest(coalesce(p_limit, 0), 0)
      for update skip locked
   )
  returning job.*;
end;
$$;

create function public.finish_sync_job(
  p_job_id uuid,
  p_claim_token uuid,
  p_status public.sync_job_status,
  p_error text default null,
  p_result jsonb default null,
  p_retry_in interval default null
)
returns public.sync_jobs
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_job public.sync_jobs;
begin
  perform app.assert_service_role('finish_sync_job');
  select * into v_job from public.sync_jobs where id = p_job_id for update;
  if not found then
    raise exception 'no such job %', p_job_id using errcode = '22023';
  end if;
  if v_job.status <> 'running'
     or p_claim_token is null
     or v_job.claim_token is distinct from p_claim_token then
    raise exception 'stale or missing claim token for job %', p_job_id using errcode = '40001';
  end if;

  if p_status = 'failed' and v_job.attempts >= v_job.max_attempts then
    update public.sync_jobs
       set status = 'dead', last_error = p_error, result = coalesce(p_result, result),
           finished_at = now(), updated_at = now()
     where id = p_job_id and claim_token = p_claim_token
    returning * into v_job;
  elsif p_status = 'failed' then
    update public.sync_jobs
       set status = 'queued', last_error = p_error, result = coalesce(p_result, result),
           claimed_by = null, claimed_at = null, claim_token = null,
           run_after = now() + coalesce(p_retry_in, interval '1 minute'),
           finished_at = null, updated_at = now()
     where id = p_job_id and claim_token = p_claim_token
    returning * into v_job;
  else
    update public.sync_jobs
       set status = p_status, last_error = p_error, result = coalesce(p_result, result),
           finished_at = now(), updated_at = now()
     where id = p_job_id and claim_token = p_claim_token
    returning * into v_job;
  end if;
  if not found then
    raise exception 'claim ownership changed for job %', p_job_id using errcode = '40001';
  end if;
  return v_job;
end;
$$;

-- Rolling compatibility for a job claimed before claim-token fencing was
-- installed. It can finish only a legacy running row whose token is NULL;
-- every claim made by the new function has a token and is rejected here.
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
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_job public.sync_jobs;
begin
  perform app.assert_service_role('finish_sync_job');
  select * into v_job from public.sync_jobs where id = p_job_id for update;
  if not found then
    raise exception 'no such job %', p_job_id using errcode = '22023';
  end if;
  if v_job.status <> 'running' or v_job.claim_token is not null then
    raise exception 'legacy completion cannot own tokenized job %', p_job_id
      using errcode = '40001';
  end if;
  if p_status = 'failed' and v_job.attempts >= v_job.max_attempts then
    update public.sync_jobs set status = 'dead', last_error = p_error,
      result = coalesce(p_result, result), finished_at = now(), updated_at = now()
      where id = p_job_id and status = 'running' and claim_token is null returning * into v_job;
  elsif p_status = 'failed' then
    update public.sync_jobs set status = 'queued', last_error = p_error,
      result = coalesce(p_result, result), claimed_by = null, claimed_at = null,
      run_after = now() + coalesce(p_retry_in, interval '1 minute'),
      finished_at = null, updated_at = now()
      where id = p_job_id and status = 'running' and claim_token is null returning * into v_job;
  else
    update public.sync_jobs set status = p_status, last_error = p_error,
      result = coalesce(p_result, result), finished_at = now(), updated_at = now()
      where id = p_job_id and status = 'running' and claim_token is null returning * into v_job;
  end if;
  if not found then
    raise exception 'legacy claim ownership changed for job %', p_job_id using errcode = '40001';
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
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_count integer;
begin
  perform app.assert_service_role('requeue_stale_sync_jobs');
  with revived as (
    update public.sync_jobs
       set status = (case when attempts >= max_attempts then 'dead' else 'queued' end)::public.sync_job_status,
           claimed_by = null, claimed_at = null, claim_token = null,
           last_error = coalesce(last_error, 'reclaimed: worker went away'),
           run_after = now(),
           finished_at = case when attempts >= max_attempts then now() else null end,
           updated_at = now()
     where status = 'running' and claimed_at < now() - p_older_than
    returning 1
  )
  select count(*)::integer into v_count from revived;
  return v_count;
end;
$$;

revoke execute on function public.finish_sync_job(
  uuid, uuid, public.sync_job_status, text, jsonb, interval
) from public, anon, authenticated;
grant execute on function public.finish_sync_job(
  uuid, uuid, public.sync_job_status, text, jsonb, interval
) to service_role;
revoke execute on function public.finish_sync_job(
  uuid, public.sync_job_status, text, jsonb, interval
) from public, anon, authenticated;
grant execute on function public.finish_sync_job(
  uuid, public.sync_job_status, text, jsonb, interval
) to service_role;

-- The export artifact is order-sensitive. UUID order is not insertion order,
-- so freeze an explicit per-row position for approval re-hashing and download.
alter table public.apply_rows
  add column artifact_ordinal bigint generated by default as identity;
create unique index apply_rows_batch_artifact_ordinal_key
  on public.apply_rows (batch_id, artifact_ordinal);

create type public.amazon_write_action_type as enum (
  'sp_keyword_bid',
  'sp_target_bid',
  'sp_campaign_placement'
);
create type public.amazon_write_approval_mode as enum ('manual', 'bounded_live_test');
create type public.amazon_write_execution_direction as enum ('forward', 'inverse');
create type public.amazon_write_execution_status as enum (
  'queued', 'running', 'awaiting_sync', 'succeeded', 'partial', 'refused', 'failed', 'conflict'
);
create type public.amazon_write_row_status as enum (
  'pending', 'dispatched', 'retryable', 'accepted', 'observed_after_ambiguous',
  'failed', 'refused', 'ambiguous'
);
create type public.amazon_write_observation_status as enum ('pending', 'not_applied', 'observed', 'conflict');
create type public.amazon_write_attempt_outcome as enum (
  'accepted', 'failed', 'retryable', 'ambiguous'
);
create type public.amazon_write_provider_call_event_type as enum ('dispatch', 'result');
create type public.amazon_write_provider_call_outcome as enum (
  'dispatched', 'accepted', 'mixed', 'throttled', 'rejected', 'ambiguous'
);

create table public.amazon_write_approvals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete restrict,
  profile_id uuid not null references public.ad_profiles (id) on delete restrict,
  amazon_profile_id text not null,
  connection_id uuid not null,
  region public.ads_region not null,
  apply_batch_id uuid not null references public.apply_batches (id) on delete restrict,
  mode public.amazon_write_approval_mode not null,
  preview_sha256 text not null check (preview_sha256 ~ '^[a-f0-9]{64}$'),
  approved_count integer not null check (approved_count > 0),
  approved_by uuid not null references auth.users (id) on delete restrict,
  approved_at timestamptz not null,
  expires_at timestamptz not null,
  inverse_preapproved boolean not null default false,
  authorization_id uuid,
  authorization_sha256 text check (authorization_sha256 ~ '^[a-f0-9]{64}$'),
  authorization_snapshot jsonb,
  created_at timestamptz not null default now(),
  constraint amazon_write_approvals_valid_window check (expires_at > approved_at),
  constraint amazon_write_approvals_authorization_mode check (
    (mode = 'manual' and authorization_id is null and authorization_sha256 is null
      and authorization_snapshot is null)
    or (mode = 'bounded_live_test' and authorization_id is not null
      and authorization_sha256 is not null and authorization_snapshot is not null)
  ),
  constraint amazon_write_approvals_inverse_mode check (
    not inverse_preapproved or mode = 'bounded_live_test'
  ),
  unique (org_id, profile_id, id)
);
create index amazon_write_approvals_profile_idx
  on public.amazon_write_approvals (org_id, profile_id, approved_at desc);
create index amazon_write_approvals_authorization_idx
  on public.amazon_write_approvals (authorization_id) where authorization_id is not null;
select app.install_tenant_rls('public.amazon_write_approvals');

create table public.amazon_write_executions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete restrict,
  profile_id uuid not null references public.ad_profiles (id) on delete restrict,
  apply_batch_id uuid not null references public.apply_batches (id) on delete restrict,
  approval_id uuid not null references public.amazon_write_approvals (id) on delete restrict,
  idempotency_key text not null unique check (idempotency_key ~ '^[a-f0-9]{64}$'),
  direction public.amazon_write_execution_direction not null default 'forward',
  source_execution_id uuid references public.amazon_write_executions (id) on delete restrict,
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
  dispatch_lease_token uuid,
  dispatch_lease_expires_at timestamptz,
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
    and resynchronized_count <= succeeded_count + ambiguous_count
  ),
  constraint amazon_write_executions_succeeded_complete check (
    status <> 'succeeded'
    or (
      refused_count = 0
      and failed_count = 0
      and attempted_count = requested_count
      and succeeded_count + ambiguous_count = requested_count
      and resynchronized_count = requested_count
      and inverse_ready_at is not null
    )
  ),
  constraint amazon_write_executions_direction_shape check (
    (direction = 'forward' and source_execution_id is null)
    or (direction = 'inverse' and source_execution_id is not null)
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

alter table public.amazon_write_executions
  add column reauthorization_approval_id uuid unique
    references public.amazon_write_approvals (id) on delete restrict;

create table public.amazon_write_reapprovals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete restrict,
  profile_id uuid not null references public.ad_profiles (id) on delete restrict,
  execution_id uuid not null references public.amazon_write_executions (id) on delete restrict,
  prior_approval_id uuid not null references public.amazon_write_approvals (id) on delete restrict,
  replacement_approval_id uuid not null unique references public.amazon_write_approvals (id) on delete restrict,
  approved_by uuid not null references auth.users (id) on delete restrict,
  approved_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (org_id, profile_id, execution_id, replacement_approval_id)
);
select app.install_tenant_rls('public.amazon_write_reapprovals');
revoke insert, update, delete, truncate on public.amazon_write_reapprovals
  from anon, authenticated;

alter table public.amazon_write_approvals
  add constraint amazon_write_approvals_profile_fkey foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete restrict,
  add constraint amazon_write_approvals_batch_fkey foreign key (org_id, profile_id, apply_batch_id)
    references public.apply_batches (org_id, profile_id, id) on delete restrict;

alter table public.amazon_write_executions
  add constraint amazon_write_executions_profile_fkey foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete restrict,
  add constraint amazon_write_executions_batch_fkey foreign key (org_id, profile_id, apply_batch_id)
    references public.apply_batches (org_id, profile_id, id) on delete restrict,
  add constraint amazon_write_executions_approval_fkey foreign key (org_id, profile_id, approval_id)
    references public.amazon_write_approvals (org_id, profile_id, id) on delete restrict,
  add constraint amazon_write_executions_source_fkey
    foreign key (org_id, profile_id, source_execution_id)
    references public.amazon_write_executions (org_id, profile_id, id) on delete restrict;

create table public.amazon_write_inverse_reservations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete restrict,
  profile_id uuid not null references public.ad_profiles (id) on delete restrict,
  forward_execution_id uuid not null references public.amazon_write_executions (id) on delete restrict,
  authorization_id uuid not null,
  authorization_sha256 text not null check (authorization_sha256 ~ '^[a-f0-9]{64}$'),
  inverse_execution_id uuid references public.amazon_write_executions (id) on delete restrict,
  reserved_at timestamptz not null default now(),
  materialized_at timestamptz,
  constraint amazon_write_inverse_reservations_materialized check (
    (inverse_execution_id is null and materialized_at is null)
    or (inverse_execution_id is not null and materialized_at is not null)
  ),
  unique (forward_execution_id),
  unique (inverse_execution_id),
  unique (org_id, profile_id, id)
);
create index amazon_write_inverse_reservations_authorization_idx
  on public.amazon_write_inverse_reservations (authorization_id, authorization_sha256);
select app.install_tenant_rls('public.amazon_write_inverse_reservations');

alter table public.amazon_write_inverse_reservations
  add constraint amazon_write_inverse_reservations_forward_fkey
    foreign key (org_id, profile_id, forward_execution_id)
    references public.amazon_write_executions (org_id, profile_id, id) on delete restrict,
  add constraint amazon_write_inverse_reservations_inverse_fkey
    foreign key (org_id, profile_id, inverse_execution_id)
    references public.amazon_write_executions (org_id, profile_id, id) on delete restrict;

create table public.amazon_write_rows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete restrict,
  profile_id uuid not null references public.ad_profiles (id) on delete restrict,
  execution_id uuid not null references public.amazon_write_executions (id) on delete restrict,
  apply_row_id uuid not null references public.apply_rows (id) on delete restrict,
  action_type public.amazon_write_action_type not null,
  action jsonb not null,
  expected_value jsonb not null,
  requested_value jsonb not null,
  inverse_value jsonb not null,
  inverse_action jsonb not null,
  row_status public.amazon_write_row_status not null default 'pending',
  observation_status public.amazon_write_observation_status not null default 'pending',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  refusal_reason text,
  provider_evidence jsonb,
  provider_accepted_at timestamptz,
  current_observed_value jsonb,
  observed_at timestamptz,
  dispatch_token uuid,
  dispatched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint amazon_write_rows_action_shape check (
    action->>'actionType' = action_type::text
    and action->'applyRowId' = to_jsonb(apply_row_id::text)
    and action->'expectedValue' = expected_value
    and action->'requestedValue' = requested_value
    and action->'inverseValue' = inverse_value
    and inverse_action->>'actionType' = action_type::text
    and inverse_action->'applyRowId' = to_jsonb(apply_row_id::text)
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

create table public.amazon_write_predispatch_observations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete restrict,
  profile_id uuid not null references public.ad_profiles (id) on delete restrict,
  execution_id uuid not null references public.amazon_write_executions (id) on delete restrict,
  write_row_id uuid not null references public.amazon_write_rows (id) on delete restrict,
  call_id uuid not null,
  observation jsonb not null,
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint amazon_write_predispatch_observations_shape check (
    observation->>'writeRowId' = write_row_id::text
    and jsonb_typeof(observation->'currentValue') = 'number'
  ),
  unique (call_id, write_row_id),
  unique (org_id, profile_id, id)
);
create index amazon_write_predispatch_observations_execution_idx
  on public.amazon_write_predispatch_observations (execution_id, observed_at);
select app.install_tenant_rls('public.amazon_write_predispatch_observations');

alter table public.amazon_write_predispatch_observations
  add constraint amazon_write_predispatch_observations_execution_fkey
    foreign key (org_id, profile_id, execution_id)
    references public.amazon_write_executions (org_id, profile_id, id) on delete restrict,
  add constraint amazon_write_predispatch_observations_row_fkey
    foreign key (org_id, profile_id, write_row_id)
    references public.amazon_write_rows (org_id, profile_id, id) on delete restrict;

create table public.amazon_write_attempts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete restrict,
  profile_id uuid not null references public.ad_profiles (id) on delete restrict,
  execution_id uuid not null references public.amazon_write_executions (id) on delete restrict,
  write_row_id uuid not null references public.amazon_write_rows (id) on delete restrict,
  call_id uuid not null,
  call_event_type public.amazon_write_provider_call_event_type not null default 'dispatch'
    check (call_event_type = 'dispatch'),
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

create table public.amazon_write_provider_call_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete restrict,
  profile_id uuid not null references public.ad_profiles (id) on delete restrict,
  execution_id uuid not null references public.amazon_write_executions (id) on delete restrict,
  call_id uuid not null,
  event_type public.amazon_write_provider_call_event_type not null,
  provider_operation public.amazon_write_action_type not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  requested_entity_ids jsonb not null,
  requested_count integer not null check (requested_count > 0 and requested_count <= 100),
  accepted_count integer not null default 0 check (accepted_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  api_call_count integer not null check (api_call_count between 0 and 100),
  outcome public.amazon_write_provider_call_outcome not null,
  code text,
  message text,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint amazon_write_provider_call_events_shape check (
    jsonb_typeof(requested_entity_ids) = 'array'
    and jsonb_array_length(requested_entity_ids) = requested_count
    and accepted_count + failed_count <= requested_count
    and (code is null or length(code) <= 160)
    and (message is null or length(message) <= 512)
    and ((event_type = 'dispatch' and outcome = 'dispatched' and api_call_count = 0
          and accepted_count = 0 and failed_count = 0)
      or (event_type = 'result' and outcome <> 'dispatched'
          and (api_call_count > 0 or outcome = 'ambiguous')))
    and (outcome not in ('accepted', 'mixed', 'rejected')
      or accepted_count + failed_count = requested_count)
    and (outcome <> 'accepted' or (accepted_count = requested_count and failed_count = 0))
    and (outcome <> 'mixed' or (accepted_count > 0 and failed_count > 0))
    and (outcome <> 'rejected' or (accepted_count = 0 and failed_count = requested_count))
    and (outcome <> 'throttled' or (accepted_count = 0 and failed_count = 0))
  ),
  unique (call_id, event_type),
  unique (org_id, profile_id, id)
);
create index amazon_write_provider_call_events_execution_idx
  on public.amazon_write_provider_call_events (execution_id, occurred_at);
alter table public.amazon_write_provider_call_events
  add constraint amazon_write_provider_call_events_tenant_call_event_key
    unique (org_id, profile_id, execution_id, call_id, event_type);
select app.install_tenant_rls('public.amazon_write_provider_call_events');

alter table public.amazon_write_provider_call_events
  add constraint amazon_write_provider_call_events_execution_fkey
    foreign key (org_id, profile_id, execution_id)
    references public.amazon_write_executions (org_id, profile_id, id) on delete restrict;

alter table public.amazon_write_attempts
  add constraint amazon_write_attempts_dispatch_event_fkey
    foreign key (org_id, profile_id, execution_id, call_id, call_event_type)
    references public.amazon_write_provider_call_events
      (org_id, profile_id, execution_id, call_id, event_type) on delete restrict;

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
create trigger amazon_write_reapprovals_immutable
  before update or delete on public.amazon_write_reapprovals
  for each row execute function app.reject_amazon_write_immutable_change();
create trigger amazon_write_attempts_immutable
  before update or delete on public.amazon_write_attempts
  for each row execute function app.reject_amazon_write_immutable_change();
create trigger amazon_write_predispatch_observations_immutable
  before update or delete on public.amazon_write_predispatch_observations
  for each row execute function app.reject_amazon_write_immutable_change();
create trigger amazon_write_provider_call_events_immutable
  before update or delete on public.amazon_write_provider_call_events
  for each row execute function app.reject_amazon_write_immutable_change();

-- app.install_tenant_rls grants service_role the table's full privilege set.
-- The worker needs row-level lifecycle updates, but no runtime role may bypass
-- the append-only evidence contract with a statement-level TRUNCATE.
revoke truncate on table
  public.amazon_write_approvals,
  public.amazon_write_executions,
  public.amazon_write_reapprovals,
  public.amazon_write_inverse_reservations,
  public.amazon_write_rows,
  public.amazon_write_predispatch_observations,
  public.amazon_write_attempts,
  public.amazon_write_provider_call_events
from anon, authenticated, service_role;

create or replace function app.protect_amazon_write_inverse_reservation()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'amazon_write_inverse_reservations is immutable';
  end if;
  if new.org_id is distinct from old.org_id
     or new.profile_id is distinct from old.profile_id
     or new.forward_execution_id is distinct from old.forward_execution_id
     or new.authorization_id is distinct from old.authorization_id
     or new.authorization_sha256 is distinct from old.authorization_sha256
     or new.reserved_at is distinct from old.reserved_at
     or old.inverse_execution_id is not null
     or (new.inverse_execution_id is null) <> (new.materialized_at is null) then
    raise exception 'amazon write inverse reservation identity is immutable';
  end if;
  return new;
end;
$$;

create trigger amazon_write_inverse_reservations_identity_immutable
  before update or delete on public.amazon_write_inverse_reservations
  for each row execute function app.protect_amazon_write_inverse_reservation();

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
     or new.direction is distinct from old.direction
     or new.source_execution_id is distinct from old.source_execution_id
     or new.requested_count is distinct from old.requested_count
     or new.created_at is distinct from old.created_at then
    raise exception 'amazon write execution identity is immutable';
  end if;
  if new.reauthorization_approval_id is distinct from old.reauthorization_approval_id
  then
    perform app.assert_service_role('amazon inverse reauthorization');
    if current_setting('app.amazon_inverse_reapproval', true) <> 'on' then
      raise exception 'amazon write inverse reauthorization requires its authenticated ceremony';
    end if;
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
     or new.inverse_action is distinct from old.inverse_action
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

-- Legacy Time Machine linking treats an exact synchronized old->new value as
-- evidence that a staged export was applied. A gateway approval is different:
-- an external actor can independently make the proposed change between
-- approval and the worker's final freshness read. Do not attribute that sync
-- event to OpenSpell. Gateway evidence is always generation/call-bound and is
-- recorded by its observer as source='apply'; ordinary sync must never claim
-- a gateway row, including after a dispatch intent exists.
create or replace function app.guard_gateway_entity_change_link()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.source = 'sync'
     and new.apply_batch_id is not null
     and exists (
       select 1 from public.amazon_write_approvals approval
        where approval.apply_batch_id = new.apply_batch_id
     ) then
    if tg_op = 'UPDATE' and old.apply_batch_id is null and old.apply_row_id is null then
      return null;
    end if;
    raise exception 'gateway apply evidence requires its generation-bound observer';
  end if;
  return new;
end;
$$;

create trigger entity_changes_gateway_link_guard
  before insert or update of apply_batch_id, apply_row_id on public.entity_changes
  for each row execute function app.guard_gateway_entity_change_link();

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
    if tg_op = 'UPDATE' then
      if exists (
        select 1 from public.amazon_write_approvals approval
         where approval.apply_batch_id in (old.batch_id, new.batch_id)
      ) then
        raise exception 'approved apply rows are immutable';
      end if;
      return new;
    end if;
    v_batch_id := case when tg_op = 'INSERT' then new.batch_id else old.batch_id end;
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
     or new.cooldown_days is distinct from old.cooldown_days
     or new.cooldown_bypass is distinct from old.cooldown_bypass
     or new.score is distinct from old.score
     or new.source_batch_id is distinct from old.source_batch_id
     or new.created_by is distinct from old.created_by
     or new.exported_at is distinct from old.exported_at
     or new.artifact_sha256 is distinct from old.artifact_sha256
     or new.exported_proposals is distinct from old.exported_proposals
     or new.reversible_rows is distinct from old.reversible_rows
     or new.unsupported_rows is distinct from old.unsupported_rows then
    raise exception 'approved apply batch artifact is immutable';
  end if;
  if new.status is distinct from old.status
     or new.applied_on is distinct from old.applied_on
     or new.applied_at is distinct from old.applied_at
     or new.reverted_at is distinct from old.reverted_at
     or new.revert_note is distinct from old.revert_note then
    perform app.assert_service_role('approved apply batch lifecycle transition');
    if not (
      (old.status = 'staged' and new.status = 'applied'
       and new.applied_on is not null and new.applied_at is not null
       and new.reverted_at is null and new.revert_note is null)
      or (old.status = 'staged' and new.status = 'abandoned'
       and new.applied_on is not distinct from old.applied_on
       and new.applied_at is not distinct from old.applied_at
       and new.reverted_at is not distinct from old.reverted_at
       and new.revert_note is not distinct from old.revert_note)
      or (old.status in ('staged', 'applied') and new.status = 'reverted'
       and new.reverted_at is not null and new.revert_note is not null
       and (old.status <> 'applied'
         or (new.applied_on is not distinct from old.applied_on
           and new.applied_at is not distinct from old.applied_at)))
    ) then
      raise exception 'invalid approved apply batch lifecycle transition % -> %', old.status, new.status;
    end if;
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

-- An approved live-test cycle freezes the route by which its exact inverse
-- must reach Amazon. Profile deletion is permanently blocked by the durable
-- approval FKs above; route rebinding and connection deletion are blocked
-- while a forward/inverse cycle is unresolved. This also closes the race in
-- which a cached client can finish an in-flight mutation after its credential
-- route and recovery evidence were removed.
create or replace function app.amazon_write_route_is_unresolved(
  p_profile_id uuid,
  p_connection_id uuid default null
)
returns boolean
language sql
stable
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1
      from public.amazon_write_executions forward
      join public.amazon_write_approvals approval on approval.id = forward.approval_id
      left join public.amazon_write_inverse_reservations reservation
        on reservation.forward_execution_id = forward.id
      left join public.amazon_write_executions inverse
        on inverse.id = reservation.inverse_execution_id
     where forward.direction = 'forward'
       and forward.profile_id = p_profile_id
       and (p_connection_id is null or approval.connection_id = p_connection_id)
       and (
         forward.status in ('queued', 'running', 'awaiting_sync', 'conflict')
         or (
           forward.status in ('succeeded', 'partial')
           and forward.resynchronized_count > 0
           and coalesce(inverse.status::text, 'missing') <> 'succeeded'
         )
       )
  );
$$;

create or replace function app.protect_amazon_write_profile_route()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.amazon_write_approvals where profile_id = old.id) then
      raise exception 'profile with Amazon write evidence cannot be deleted';
    end if;
    return old;
  end if;
  if (new.org_id is distinct from old.org_id
      or new.connection_id is distinct from old.connection_id
      or new.amazon_profile_id is distinct from old.amazon_profile_id
      or new.region is distinct from old.region)
     and app.amazon_write_route_is_unresolved(old.id, old.connection_id) then
    raise exception 'Amazon write profile route is frozen until its inverse is observed';
  end if;
  return new;
end;
$$;

create trigger ad_profiles_amazon_write_route_guard
  before update or delete on public.ad_profiles
  for each row execute function app.protect_amazon_write_profile_route();

create or replace function app.protect_amazon_write_connection_route()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if exists (
    select 1 from public.ad_profiles profile
     where profile.connection_id = old.id
       and app.amazon_write_route_is_unresolved(profile.id, old.id)
  ) and (
    tg_op = 'DELETE'
    or new.org_id is distinct from old.org_id
    or new.lwa_client_id is distinct from old.lwa_client_id
    or new.vault_secret_id is distinct from old.vault_secret_id
  ) then
    raise exception 'Amazon write connection route is frozen until its inverse is observed';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger ads_connections_amazon_write_route_guard
  before update or delete on public.ads_connections
  for each row execute function app.protect_amazon_write_connection_route();

-- The profile credential route is tenant-owned as one identity. The original
-- scalar FK allowed an analyst to attach a profile to a connection UUID owned
-- by another organization; freeze that impossible state at the database edge.
create unique index if not exists ads_connections_org_id_id_key
  on public.ads_connections (org_id, id);
alter table public.ad_profiles
  add constraint ad_profiles_org_connection_fkey
    foreign key (org_id, connection_id)
    references public.ads_connections (org_id, id) on delete restrict;

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

-- Full provider-owned dynamic-bidding state is retained separately from the
-- three display modifiers. Placement mutation is blocked when this is null.
alter table public.campaigns
  add column campaign_write_context jsonb;
