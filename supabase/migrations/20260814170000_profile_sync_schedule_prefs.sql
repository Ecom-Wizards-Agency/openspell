-- ---------------------------------------------------------------------------
-- ad_profiles: per-account sync hour, and a timezone an operator can pin
-- ---------------------------------------------------------------------------
--
-- WP-23. Two operator decisions become two columns, both additive:
--
--  * `preferred_sync_hour` — the hour of the day (0–23, in the profile's *own*
--    timezone) the daily pull should land on. Null means "no preference", and
--    the scheduler falls back to a sensible small-hours default. This is the
--    data buffer the video asked for: an account whose owner wants fresh numbers
--    by 07:00 local sets 5 or 6 here and the pull is done before they look.
--
--  * `timezone_locked` — once an operator sets the timezone in the tool by hand,
--    Amazon's re-sync must never overwrite it. Amazon reports a profile's
--    timezone, but an agency managing an account across borders sometimes wants
--    the account's *reporting* calendar, not the marketplace's. The lock is how
--    that manual choice survives the next OAuth upsert. The OAuth upsert
--    (`connect.ts` `upsertProfiles`) reads this flag in its `on conflict` clause.
--
-- Both default so every existing row keeps working: `preferred_sync_hour` null
-- (default hour), `timezone_locked` false (Amazon still authoritative).

alter table public.ad_profiles
  add column if not exists preferred_sync_hour smallint,
  add column if not exists timezone_locked boolean not null default false;

alter table public.ad_profiles
  add constraint ad_profiles_preferred_sync_hour_range
    check (preferred_sync_hour is null or preferred_sync_hour between 0 and 23);

comment on column public.ad_profiles.preferred_sync_hour is
  'Hour of the day (0-23) in the profile''s own timezone the daily pull is anchored to. Null falls back to the scheduler default.';
comment on column public.ad_profiles.timezone_locked is
  'When true the operator set the timezone by hand and the Amazon OAuth upsert must not overwrite it.';

-- ---------------------------------------------------------------------------
-- enqueue_due_schedules: anchor next_run_at to the preferred hour
-- ---------------------------------------------------------------------------
--
-- The only change from migration 0006 is how the next slot is computed. It used
-- to step forward from the schedule's own arbitrary time-of-day; now it anchors
-- to the profile's preferred hour (default 4am local) and steps by the cadence
-- until strictly in the future. The hour is the time of day the operator chose;
-- the cadence is the gap between runs. A daily schedule therefore lands on that
-- hour every day, a weekly one on that hour every seventh day. The report
-- window is still computed from the real tick time in the profile's calendar, so
-- anchoring changes *when* a job is enqueued, never *what* window it pulls.

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
  v_hour integer;
begin
  perform app.assert_service_role('enqueue_due_schedules');

  -- A caller that passes an explicit null means "now". Without this every
  -- comparison below is null and the scheduler silently does nothing.
  v_now := coalesce(p_now, now());

  for v_sched in
    select s.*, p.timezone, p.sync_enabled, p.preferred_sync_hour
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

    -- Anchor the next run to the preferred hour in the profile's own timezone,
    -- then advance past every slot already due, so a scheduler that was down for
    -- a day enqueues one job, not a day's worth.
    v_hour := coalesce(v_sched.preferred_sync_hour, 4);
    v_next := (date_trunc('day', v_now at time zone v_sched.timezone)
               + make_interval(hours => v_hour)) at time zone v_sched.timezone;
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
  'pg_cron/Vercel-cron target: turn due sync_schedules into sync_jobs, anchoring the next slot to the profile''s preferred sync hour. Idempotent per due slot via dedupe_key.';

revoke all on function public.enqueue_due_schedules(timestamptz) from public;
grant execute on function public.enqueue_due_schedules(timestamptz) to service_role;
