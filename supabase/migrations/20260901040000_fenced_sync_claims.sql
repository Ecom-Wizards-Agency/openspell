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

-- The authority row is deliberately private. Public callers can observe it
-- only through the service-role-gated status function below, and the sole
-- mutation is the one-way activation RPC. Row locks on this singleton are the
-- cutover barrier shared by both claim protocols.
create table app.report_worker_claim_authority (
  singleton boolean primary key default true check (singleton),
  protocol text not null default 'legacy' check (protocol in ('legacy', 'fenced')),
  epoch bigint not null default 0 check (epoch >= 0),
  updated_at timestamptz not null default now()
);

insert into app.report_worker_claim_authority (singleton, protocol, epoch)
values (true, 'legacy', 0);

comment on table app.report_worker_claim_authority is
  'Private one-way protocol authority for the Evo report lane. Exactly one singleton row exists.';

revoke all on table app.report_worker_claim_authority from public;
revoke all on table app.report_worker_claim_authority from anon;
revoke all on table app.report_worker_claim_authority from authenticated;
revoke all on table app.report_worker_claim_authority from service_role;

-- `claim_token` is a capability, not tenant-visible queue evidence. Replace
-- the predecessor table-level grant with the complete safe-column set.
revoke select on table public.sync_jobs from anon, authenticated;
revoke select (claim_token) on public.sync_jobs from anon, authenticated;
grant select (
  id, org_id, profile_id, schedule_id, job_type, payload, status, priority,
  run_after, attempts, max_attempts, dedupe_key, claimed_by, claimed_at,
  started_at, finished_at, last_error, result, created_at, updated_at
) on public.sync_jobs to authenticated;

-- Preserve both legacy claim signatures during the staged rollout. A
-- token-bearing queued row can only exist during attended recovery and must
-- not be acquired through the tokenless protocol.
create or replace function public.claim_sync_jobs(p_worker_id text, p_limit integer)
returns setof public.sync_jobs
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_protocol text;
  v_report_types public.sync_job_type[] := array[
    'creative.sync', 'report.request', 'report.poll', 'report.fetch'
  ]::public.sync_job_type[];
begin
  perform app.assert_service_role('claim_sync_jobs');

  if p_worker_id is null or length(p_worker_id) = 0 then
    raise exception 'claim_sync_jobs needs a worker id' using errcode = '22023';
  end if;

  select authority.protocol into v_protocol
    from app.report_worker_claim_authority authority
   where authority.singleton
   for share;
  if not found then
    raise exception 'report worker claim authority is unavailable' using errcode = '55000';
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
        and (v_protocol = 'legacy' or c.job_type <> all(v_report_types))
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
declare
  v_protocol text;
  v_report_types public.sync_job_type[] := array[
    'creative.sync', 'report.request', 'report.poll', 'report.fetch'
  ]::public.sync_job_type[];
begin
  perform app.assert_service_role('claim_sync_jobs');

  if p_worker_id is null or length(p_worker_id) = 0 then
    raise exception 'claim_sync_jobs needs a worker id' using errcode = '22023';
  end if;

  select authority.protocol into v_protocol
    from app.report_worker_claim_authority authority
   where authority.singleton
   for share;
  if not found then
    raise exception 'report worker claim authority is unavailable' using errcode = '55000';
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
        and (v_protocol = 'legacy' or c.job_type <> all(v_report_types))
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

  select * into v_job
    from public.sync_jobs
   where id = p_job_id
     and status = 'running'
     and claim_token is null
   for update;
  if not found then
    raise exception 'legacy finish requires running tokenless custody' using errcode = '55000';
  end if;

  if p_status = 'failed' and v_job.attempts >= v_job.max_attempts then
    update public.sync_jobs
       set status = 'dead', last_error = p_error, result = coalesce(p_result, result),
           finished_at = now()
     where id = p_job_id
       and status = 'running'
       and claim_token is null
    returning * into v_job;
  elsif p_status = 'failed' then
    update public.sync_jobs
       set status = 'queued', last_error = p_error, result = coalesce(p_result, result),
           claimed_by = null, claimed_at = null,
           run_after = now() + coalesce(p_retry_in, interval '1 minute')
     where id = p_job_id
       and status = 'running'
       and claim_token is null
    returning * into v_job;
  else
    update public.sync_jobs
       set status = p_status, last_error = p_error, result = coalesce(p_result, result),
           finished_at = now()
     where id = p_job_id
       and status = 'running'
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
  v_protocol text;
  v_report_types public.sync_job_type[] := array[
    'creative.sync', 'report.request', 'report.poll', 'report.fetch'
  ]::public.sync_job_type[];
begin
  perform app.assert_service_role('requeue_stale_sync_jobs');

  select authority.protocol into v_protocol
    from app.report_worker_claim_authority authority
   where authority.singleton
   for share;
  if not found then
    raise exception 'report worker claim authority is unavailable' using errcode = '55000';
  end if;

  with revived as (
    update public.sync_jobs
       set status = (case when attempts >= max_attempts then 'dead' else 'queued' end)::public.sync_job_status,
           claimed_by = null,
           claimed_at = null,
           last_error = coalesce(last_error, 'reclaimed: worker went away'),
           run_after = now()
     where status = 'running'
       and claim_token is null
       and (v_protocol = 'legacy' or job_type <> all(v_report_types))
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
declare
  v_protocol text;
  v_report_types public.sync_job_type[] := array[
    'creative.sync', 'report.request', 'report.poll', 'report.fetch'
  ]::public.sync_job_type[];
begin
  perform app.assert_service_role('claim_sync_jobs_fenced');

  if p_worker_id is null or length(p_worker_id) = 0 then
    raise exception 'claim_sync_jobs_fenced needs a worker id' using errcode = '22023';
  end if;

  select authority.protocol into v_protocol
    from app.report_worker_claim_authority authority
   where authority.singleton
   for share;
  if not found or v_protocol <> 'fenced' then
    raise exception 'fenced report claims are not authoritative' using errcode = '55000';
  end if;

  if p_job_types is null
     or cardinality(p_job_types) <> cardinality(v_report_types)
     or not (p_job_types @> v_report_types and p_job_types <@ v_report_types) then
    raise exception 'fenced claim requires the complete report lane' using errcode = '22023';
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
        and c.job_type = any(v_report_types)
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

-- Readiness may observe protocol authority without reading the private table
-- or any queue capability. This is deliberately non-mutating: readiness must
-- never activate a lane as a side effect.
create function public.get_report_worker_claim_authority()
returns table (protocol text, epoch bigint)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_protocol text;
  v_epoch bigint;
begin
  perform app.assert_service_role('get_report_worker_claim_authority');

  select authority.protocol, authority.epoch
    into v_protocol, v_epoch
    from app.report_worker_claim_authority authority
   where authority.singleton;
  if not found then
    raise exception 'report worker claim authority is unavailable' using errcode = '55000';
  end if;

  return query select v_protocol, v_epoch;
end;
$$;

comment on function public.get_report_worker_claim_authority() is
  'Return only the current report-worker protocol and epoch to service-role readiness.';

-- Activation holds the singleton exclusively while it proves that no report
-- attempt remains under legacy or token-bearing custody. Claims hold a shared
-- lock on the same row, so the flip is ordered after every in-flight claim
-- transaction and before every later claim. There is intentionally no reverse
-- transition in this migration.
create function public.activate_report_worker_fenced_claims()
returns table (decision text, epoch bigint, unresolved integer)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_protocol text;
  v_epoch bigint;
  v_unresolved integer;
  v_report_types public.sync_job_type[] := array[
    'creative.sync', 'report.request', 'report.poll', 'report.fetch'
  ]::public.sync_job_type[];
begin
  perform app.assert_service_role('activate_report_worker_fenced_claims');

  select authority.protocol, authority.epoch
    into v_protocol, v_epoch
    from app.report_worker_claim_authority authority
   where authority.singleton
   for update;
  if not found then
    raise exception 'report worker claim authority is unavailable' using errcode = '55000';
  end if;

  select count(*)::integer into v_unresolved
    from public.sync_jobs job
   where job.job_type = any(v_report_types)
     and (job.status = 'running' or job.claim_token is not null);

  if v_protocol = 'fenced' then
    return query select 'already_fenced'::text, v_epoch, v_unresolved;
    return;
  end if;

  if v_unresolved <> 0 then
    return query select 'unresolved'::text, v_epoch, v_unresolved;
    return;
  end if;

  update app.report_worker_claim_authority authority
     set protocol = 'fenced',
         epoch = authority.epoch + 1,
         updated_at = now()
   where authority.singleton
     and authority.protocol = 'legacy'
  returning authority.epoch into v_epoch;

  if not found then
    raise exception 'report worker claim authority changed unexpectedly' using errcode = '55000';
  end if;

  return query select 'activated'::text, v_epoch, 0::integer;
end;
$$;

comment on function public.activate_report_worker_fenced_claims() is
  'Atomically and irreversibly authorize fenced report claims after proving zero unresolved report custody.';

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

revoke execute on function public.get_report_worker_claim_authority() from public;
revoke execute on function public.get_report_worker_claim_authority() from anon;
revoke execute on function public.get_report_worker_claim_authority() from authenticated;
grant execute on function public.get_report_worker_claim_authority() to service_role;

revoke execute on function public.activate_report_worker_fenced_claims() from public;
revoke execute on function public.activate_report_worker_fenced_claims() from anon;
revoke execute on function public.activate_report_worker_fenced_claims() from authenticated;
grant execute on function public.activate_report_worker_fenced_claims() to service_role;
