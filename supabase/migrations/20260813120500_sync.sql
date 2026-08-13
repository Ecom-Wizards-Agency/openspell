-- wizard-ads 0006: sync machinery.
--
-- `sync_jobs` is queue and ledger in one row: the same row a worker claims is
-- the row an operator later reads to find out what happened. `report_requests`
-- is the Reporting v3 state machine spine (request, poll, fetch), and it is
-- where Rule 45 lives as data rather than as a log line: `rows_parsed` versus
-- `rows_loaded`, with a stored `counts_match` so a mismatch is queryable.
--
-- Claiming uses FOR UPDATE SKIP LOCKED. Two workers claiming at once take
-- disjoint sets; that is the whole reason the queue does not need Redis.

create type public.sync_job_type as enum (
  'entity.sync',
  'report.request',
  'report.poll',
  'report.fetch',
  'crosscheck.ingest',
  'recommendations.run'
);

create type public.sync_job_status as enum (
  'queued', 'running', 'succeeded', 'failed', 'dead'
);

-- Report type ids exactly as Amazon spells them, and exactly as ReportType in
-- packages/shared spells them. camelCase in an enum looks wrong and is right:
-- a translation table between our name and theirs is a bug generator.
create type public.report_type as enum (
  'spCampaigns', 'spTargeting', 'spSearchTerm', 'spPlacement', 'sbCampaigns', 'sdCampaigns'
);

create type public.report_status as enum (
  'pending', 'processing', 'completed', 'failed', 'expired', 'cancelled'
);

-- ---------------------------------------------------------------------------
-- Schedules
-- ---------------------------------------------------------------------------

create table public.sync_schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  job_type public.sync_job_type not null,
  report_type public.report_type,
  cadence interval not null,
  next_run_at timestamptz not null default now(),
  enabled boolean not null default true,
  priority integer not null default 100,
  -- Merged into the enqueued job's payload. Job-type specific extras live here
  -- so adding a knob does not mean adding a column.
  payload jsonb not null default '{}'::jsonb,
  -- Report jobs: how far back the window reaches. The restatement re-pull is
  -- just a schedule with a longer lookback and a slower cadence.
  lookback_days integer,
  last_enqueued_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sync_schedules_report_type_required
    check ((job_type in ('report.request')) = (report_type is not null))
);

comment on table public.sync_schedules is
  'What to sync, how often, per profile. pg_cron turns due rows into sync_jobs every five minutes.';

create unique index sync_schedules_scope_key
  on public.sync_schedules (profile_id, job_type, report_type) nulls not distinct;
create index sync_schedules_due_idx on public.sync_schedules (next_run_at) where enabled;

create trigger sync_schedules_touch before update on public.sync_schedules
  for each row execute function app.touch_updated_at();

select app.install_tenant_rls('public.sync_schedules', array['owner', 'admin']);

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------

create table public.sync_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  schedule_id uuid references public.sync_schedules (id) on delete set null,
  job_type public.sync_job_type not null,
  -- JobPayload from packages/shared, verbatim.
  payload jsonb not null,
  status public.sync_job_status not null default 'queued',
  priority integer not null default 100,
  run_after timestamptz not null default now(),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  -- Idempotency key. The enqueuer builds one per schedule per due slot, so a
  -- cron tick that fires twice enqueues once.
  dedupe_key text,
  claimed_by text,
  claimed_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  last_error text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.sync_jobs is
  'Queue and ledger in one row. Claimed with FOR UPDATE SKIP LOCKED; never deleted on success, because the ledger is the point.';

create unique index sync_jobs_dedupe_key
  on public.sync_jobs (org_id, dedupe_key) where dedupe_key is not null;

-- The claim query's index: queued rows only, in claim order.
create index sync_jobs_claimable_idx
  on public.sync_jobs (priority desc, run_after, created_at)
  where status = 'queued';
create index sync_jobs_org_status_idx on public.sync_jobs (org_id, status, created_at desc);
create index sync_jobs_profile_idx on public.sync_jobs (profile_id, created_at desc);
create index sync_jobs_running_idx on public.sync_jobs (claimed_at) where status = 'running';

create trigger sync_jobs_touch before update on public.sync_jobs
  for each row execute function app.touch_updated_at();

select app.install_tenant_rls('public.sync_jobs');

-- ---------------------------------------------------------------------------
-- Report ledger
-- ---------------------------------------------------------------------------

create table public.report_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  report_type public.report_type not null,
  start_date date not null,
  end_date date not null,
  amazon_report_id text,
  status public.report_status not null default 'pending',
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  download_url text,
  download_expires_at timestamptz,
  poll_attempts integer not null default 0,
  last_polled_at timestamptz,
  next_poll_at timestamptz,
  -- Rule 45 as data: what the file said, and what reached the fact table.
  rows_parsed bigint,
  rows_loaded bigint,
  counts_match boolean generated always as (
    rows_parsed is not null and rows_loaded is not null and rows_parsed = rows_loaded
  ) stored,
  bytes_downloaded bigint,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint report_requests_window check (end_date >= start_date)
);

comment on table public.report_requests is
  'One Amazon report, request to load. Freshness is read from here, never inferred from facts: zero-impression rows are omitted by the API.';
comment on column public.report_requests.counts_match is
  'Stored, not computed at read time, so "which loads lost rows" is one indexed query.';

create index report_requests_profile_idx
  on public.report_requests (profile_id, report_type, end_date desc);
create index report_requests_open_idx
  on public.report_requests (next_poll_at)
  where status in ('pending', 'processing');
create index report_requests_amazon_id_idx on public.report_requests (amazon_report_id);
create index report_requests_mismatch_idx
  on public.report_requests (profile_id, completed_at desc)
  where counts_match is false;

create trigger report_requests_touch before update on public.report_requests
  for each row execute function app.touch_updated_at();

select app.install_tenant_rls('public.report_requests');

-- ---------------------------------------------------------------------------
-- Queue primitives
-- ---------------------------------------------------------------------------

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
        and c.run_after <= now()
      order by c.priority desc, c.run_after, c.created_at
      limit greatest(coalesce(p_limit, 0), 0)
      for update skip locked
   )
  returning j.*;
end;
$$;

comment on function public.claim_sync_jobs(text, integer) is
  'Atomically claim up to n queued jobs for one worker. SKIP LOCKED means two claimers never take the same row.';

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

  -- A failure with retries left goes back to the queue; out of retries it is
  -- `dead`, which is a different word from `failed` on purpose: dead means
  -- nobody will try again without a human.
  if p_status = 'failed' and v_job.attempts >= v_job.max_attempts then
    update public.sync_jobs
       set status = 'dead', last_error = p_error, result = coalesce(p_result, result),
           finished_at = now()
     where id = p_job_id
    returning * into v_job;
  elsif p_status = 'failed' then
    update public.sync_jobs
       set status = 'queued', last_error = p_error, result = coalesce(p_result, result),
           claimed_by = null, claimed_at = null,
           run_after = now() + coalesce(p_retry_in, interval '1 minute')
     where id = p_job_id
    returning * into v_job;
  else
    update public.sync_jobs
       set status = p_status, last_error = p_error, result = coalesce(p_result, result),
           finished_at = now()
     where id = p_job_id
    returning * into v_job;
  end if;

  return v_job;
end;
$$;

create or replace function public.requeue_stale_sync_jobs(p_older_than interval default interval '30 minutes')
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_count integer;
begin
  perform app.assert_service_role('requeue_stale_sync_jobs');

  -- A worker that dies mid-job leaves a `running` row nobody owns. Attempts
  -- were already incremented at claim time, so a job that keeps dying still
  -- reaches max_attempts instead of looping forever.
  with revived as (
    update public.sync_jobs
       set status = (case when attempts >= max_attempts then 'dead' else 'queued' end)::public.sync_job_status,
           claimed_by = null,
           claimed_at = null,
           last_error = coalesce(last_error, 'reclaimed: worker went away'),
           run_after = now()
     where status = 'running'
       and claimed_at < now() - p_older_than
    returning 1
  )
  select count(*)::integer into v_count from revived;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Scheduler
-- ---------------------------------------------------------------------------

create or replace function public.enqueue_due_schedules(p_now timestamptz default now())
returns table (schedule_id uuid, job_id uuid, dedupe_key text, enqueued boolean)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_sched record;
  v_slot timestamptz;
  v_next timestamptz;
  v_key text;
  v_payload jsonb;
  v_job_id uuid;
  v_end date;
  v_start date;
  v_now timestamptz;
begin
  perform app.assert_service_role('enqueue_due_schedules');

  -- A caller that passes an explicit null means "now". Without this every
  -- comparison below is null and the scheduler silently does nothing.
  v_now := coalesce(p_now, now());

  for v_sched in
    select s.*, p.timezone, p.sync_enabled
      from public.sync_schedules s
      join public.ad_profiles p on p.id = s.profile_id
     where s.enabled
       and p.sync_enabled
       and s.next_run_at <= v_now
     order by s.next_run_at
     for update of s skip locked
  loop
    v_slot := v_sched.next_run_at;

    -- One key per schedule per due slot. Two cron ticks in the same slot, or a
    -- retried tick, produce the same key and therefore one job.
    v_key := v_sched.id::text || ':' || to_char(v_slot at time zone 'UTC', 'YYYYMMDD"T"HH24MI');

    v_payload := jsonb_build_object(
      'type', v_sched.job_type::text,
      'orgId', v_sched.org_id,
      'profileId', v_sched.profile_id
    ) || coalesce(v_sched.payload, '{}'::jsonb);

    if v_sched.job_type = 'report.request' then
      -- The window is in the profile's own calendar, which is the only
      -- calendar Amazon's report dates mean anything in.
      v_end := (v_now at time zone v_sched.timezone)::date;
      v_start := v_end - (coalesce(v_sched.lookback_days, 1) - 1);
      v_payload := v_payload || jsonb_build_object(
        'reportType', v_sched.report_type::text,
        'startDate', to_char(v_start, 'YYYY-MM-DD'),
        'endDate', to_char(v_end, 'YYYY-MM-DD')
      );
    end if;

    -- Caught rather than `on conflict do nothing`: this function returns a
    -- column named dedupe_key, and inside plpgsql that name would make the
    -- conflict clause's own reference to the column ambiguous. Letting the
    -- unique index raise and handling it says the same thing without the trap.
    begin
      insert into public.sync_jobs
        (org_id, profile_id, schedule_id, job_type, payload, priority, dedupe_key, run_after)
      values
        (v_sched.org_id, v_sched.profile_id, v_sched.id, v_sched.job_type, v_payload,
         v_sched.priority, v_key, v_now)
      returning id into v_job_id;
    exception when unique_violation then
      v_job_id := null;
    end;

    -- Advance past every slot already due, so a scheduler that was down for a
    -- day enqueues one job, not a day's worth.
    v_next := v_sched.next_run_at;
    while v_next <= v_now loop
      v_next := v_next + v_sched.cadence;
    end loop;

    update public.sync_schedules
       set next_run_at = v_next, last_enqueued_at = v_now
     where id = v_sched.id;

    schedule_id := v_sched.id;
    job_id := v_job_id;
    dedupe_key := v_key;
    enqueued := v_job_id is not null;
    return next;
  end loop;
end;
$$;

comment on function public.enqueue_due_schedules(timestamptz) is
  'pg_cron target: turn due sync_schedules into sync_jobs. Idempotent per due slot via dedupe_key.';

revoke all on function public.claim_sync_jobs(text, integer) from public;
revoke all on function public.finish_sync_job(uuid, public.sync_job_status, text, jsonb, interval) from public;
revoke all on function public.requeue_stale_sync_jobs(interval) from public;
revoke all on function public.enqueue_due_schedules(timestamptz) from public;
grant execute on function public.claim_sync_jobs(text, integer) to service_role;
grant execute on function public.finish_sync_job(uuid, public.sync_job_status, text, jsonb, interval) to service_role;
grant execute on function public.requeue_stale_sync_jobs(interval) to service_role;
grant execute on function public.enqueue_due_schedules(timestamptz) to service_role;
