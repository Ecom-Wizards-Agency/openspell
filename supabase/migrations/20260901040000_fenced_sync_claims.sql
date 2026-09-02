-- WP-194: fail-closed custody for provider-sensitive report jobs.
--
-- A fenced claim is an opaque capability. Elapsed time, a reusable worker id,
-- and the queue row id do not prove that the previous provider operation has
-- stopped, so legacy settlement and stale recovery must ignore token-bearing
-- rows. Recovery of a stranded fenced claim is deliberately attended and is
-- not implemented by this migration.

set local lock_timeout = '5s';
select pg_advisory_xact_lock(
  pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0)
);

alter table public.sync_jobs
  add column claim_token uuid;

comment on column public.sync_jobs.claim_token is
  'Opaque per-attempt capability for fenced worker custody. Null for legacy and unclaimed jobs; never log or expose it.';

create unique index sync_jobs_claim_token_key
  on public.sync_jobs (claim_token)
  where claim_token is not null;

-- Preserve both legacy claim signatures during the staged rollout. A
-- token-bearing queued row can only exist during attended recovery and must
-- not be acquired through the tokenless protocol.
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
  update public.sync_jobs j
     set status = 'running',
         claimed_by = p_worker_id,
         claimed_at = now(),
         started_at = coalesce(j.started_at, now()),
         attempts = j.attempts + 1,
         updated_at = now()
   where j.id in (
     select c.id
       from public.sync_jobs c
      where c.status = 'queued'
        and c.claim_token is null
        and c.run_after <= now()
      order by c.priority desc, c.run_after, c.created_at
      limit greatest(coalesce(p_limit, 0), 0)
      for update skip locked
   )
  returning j.*;
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
  update public.sync_jobs j
     set status = 'running',
         claimed_by = p_worker_id,
         claimed_at = now(),
         started_at = coalesce(j.started_at, now()),
         attempts = j.attempts + 1,
         updated_at = now()
   where j.id in (
     select c.id
       from public.sync_jobs c
      where c.status = 'queued'
        and c.claim_token is null
        and c.run_after <= now()
        and (p_job_types is null or c.job_type = any(p_job_types))
      order by c.priority desc, c.run_after, c.created_at
      limit greatest(coalesce(p_limit, 0), 0)
      for update skip locked
   )
  returning j.*;
end;
$$;

-- The existing finisher remains tokenless for rollout compatibility, but it
-- refuses fenced custody before considering any state transition.
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
  if v_job.claim_token is not null then
    raise exception 'fenced job requires a fenced transition' using errcode = '55000';
  end if;

  if p_status = 'failed' and v_job.attempts >= v_job.max_attempts then
    update public.sync_jobs
       set status = 'dead', last_error = p_error, result = coalesce(p_result, result),
           finished_at = now()
     where id = p_job_id
       and claim_token is null
    returning * into v_job;
  elsif p_status = 'failed' then
    update public.sync_jobs
       set status = 'queued', last_error = p_error, result = coalesce(p_result, result),
           claimed_by = null, claimed_at = null,
           run_after = now() + coalesce(p_retry_in, interval '1 minute')
     where id = p_job_id
       and claim_token is null
    returning * into v_job;
  else
    update public.sync_jobs
       set status = p_status, last_error = p_error, result = coalesce(p_result, result),
           finished_at = now()
     where id = p_job_id
       and claim_token is null
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
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_count integer;
begin
  perform app.assert_service_role('requeue_stale_sync_jobs');

  with revived as (
    update public.sync_jobs
       set status = (case when attempts >= max_attempts then 'dead' else 'queued' end)::public.sync_job_status,
           claimed_by = null,
           claimed_at = null,
           last_error = coalesce(last_error, 'reclaimed: worker went away'),
           run_after = now()
     where status = 'running'
       and claim_token is null
       and claimed_at < now() - p_older_than
    returning 1
  )
  select count(*)::integer into v_count from revived;
  return v_count;
end;
$$;

create function public.claim_sync_jobs_fenced(
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
  perform app.assert_service_role('claim_sync_jobs_fenced');

  if p_worker_id is null or length(p_worker_id) = 0 then
    raise exception 'claim_sync_jobs_fenced needs a worker id' using errcode = '22023';
  end if;

  return query
  update public.sync_jobs j
     set status = 'running',
         claimed_by = p_worker_id,
         claimed_at = now(),
         claim_token = gen_random_uuid(),
         started_at = coalesce(j.started_at, now()),
         attempts = j.attempts + 1,
         updated_at = now()
   where j.id in (
     select c.id
       from public.sync_jobs c
      where c.status = 'queued'
        and c.claim_token is null
        and c.run_after <= now()
        and (p_job_types is null or c.job_type = any(p_job_types))
      order by c.priority desc, c.run_after, c.created_at
      limit greatest(coalesce(p_limit, 0), 0)
      for update skip locked
   )
  returning j.*;
end;
$$;

comment on function public.claim_sync_jobs_fenced(text, integer, public.sync_job_type[]) is
  'Claim jobs with unique opaque per-attempt capabilities. Token-bearing claims never expire automatically.';

create function public.finish_sync_job_fenced(
  p_job_id uuid,
  p_claim_token uuid,
  p_status public.sync_job_status,
  p_error text default null,
  p_result jsonb default null,
  p_retry_in interval default null
)
returns table (decision text, status public.sync_job_status, attempts integer)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_job public.sync_jobs;
begin
  perform app.assert_service_role('finish_sync_job_fenced');

  if p_status is null or p_status not in ('succeeded', 'failed', 'dead') then
    raise exception 'finish_sync_job_fenced needs a terminal or failure status' using errcode = '22023';
  end if;

  select * into v_job
    from public.sync_jobs
   where id = p_job_id
   for update;

  if not found
     or v_job.status <> 'running'
     or v_job.claim_token is null
     or v_job.claim_token is distinct from p_claim_token then
    return query
    select 'stale_claim'::text, null::public.sync_job_status, null::integer;
    return;
  end if;

  if p_status = 'failed' and v_job.attempts < v_job.max_attempts then
    update public.sync_jobs j
       set status = 'queued',
           last_error = p_error,
           result = coalesce(p_result, j.result),
           claimed_by = null,
           claimed_at = null,
           claim_token = null,
           run_after = now() + coalesce(p_retry_in, interval '1 minute')
     where j.id = p_job_id
       and j.status = 'running'
       and j.claim_token = p_claim_token
    returning j.* into v_job;
  else
    update public.sync_jobs j
       set status = case
             when p_status = 'failed' then 'dead'::public.sync_job_status
             else p_status
           end,
           last_error = p_error,
           result = coalesce(p_result, j.result),
           finished_at = now(),
           claim_token = null
     where j.id = p_job_id
       and j.status = 'running'
       and j.claim_token = p_claim_token
    returning j.* into v_job;
  end if;

  if not found then
    return query
    select 'stale_claim'::text, null::public.sync_job_status, null::integer;
  else
    return query
    select 'settled'::text, v_job.status, v_job.attempts;
  end if;
end;
$$;

comment on function public.finish_sync_job_fenced(uuid, uuid, public.sync_job_status, text, jsonb, interval) is
  'Settle, retry, or dead-letter only the running attempt presenting its exact opaque claim capability.';

create function public.defer_sync_job_fenced(
  p_job_id uuid,
  p_claim_token uuid,
  p_retry_in interval
)
returns table (decision text, status public.sync_job_status, attempts integer)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_job public.sync_jobs;
begin
  perform app.assert_service_role('defer_sync_job_fenced');

  update public.sync_jobs j
     set status = 'queued',
         attempts = greatest(j.attempts - 1, 0),
         last_error = null,
         claimed_by = null,
         claimed_at = null,
         claim_token = null,
         run_after = now() + coalesce(p_retry_in, interval '0 seconds')
   where j.id = p_job_id
     and j.status = 'running'
     and j.claim_token is not null
     and j.claim_token = p_claim_token
  returning j.* into v_job;

  if not found then
    return query
    select 'stale_claim'::text, null::public.sync_job_status, null::integer;
  else
    return query
    select 'deferred'::text, v_job.status, v_job.attempts;
  end if;
end;
$$;

comment on function public.defer_sync_job_fenced(uuid, uuid, interval) is
  'Defer only the running attempt presenting its exact opaque claim capability, without consuming an attempt.';

revoke execute on function public.claim_sync_jobs_fenced(text, integer, public.sync_job_type[]) from public;
revoke execute on function public.claim_sync_jobs_fenced(text, integer, public.sync_job_type[]) from anon;
revoke execute on function public.claim_sync_jobs_fenced(text, integer, public.sync_job_type[]) from authenticated;
grant execute on function public.claim_sync_jobs_fenced(text, integer, public.sync_job_type[]) to service_role;

revoke execute on function public.finish_sync_job_fenced(uuid, uuid, public.sync_job_status, text, jsonb, interval) from public;
revoke execute on function public.finish_sync_job_fenced(uuid, uuid, public.sync_job_status, text, jsonb, interval) from anon;
revoke execute on function public.finish_sync_job_fenced(uuid, uuid, public.sync_job_status, text, jsonb, interval) from authenticated;
grant execute on function public.finish_sync_job_fenced(uuid, uuid, public.sync_job_status, text, jsonb, interval) to service_role;

revoke execute on function public.defer_sync_job_fenced(uuid, uuid, interval) from public;
revoke execute on function public.defer_sync_job_fenced(uuid, uuid, interval) from anon;
revoke execute on function public.defer_sync_job_fenced(uuid, uuid, interval) from authenticated;
grant execute on function public.defer_sync_job_fenced(uuid, uuid, interval) to service_role;
