-- WP-41: scheduled SQP categorization needs the week it is categorizing.
--
-- This replaces the latest scheduler body (20260814170000) and adds one branch:
-- `sqp.categorize` receives the Sunday starting the current profile-local week.

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
  v_week_start date;
  v_now timestamptz;
  v_hour integer;
begin
  perform app.assert_service_role('enqueue_due_schedules');

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
    v_key := v_sched.id::text || ':' || to_char(v_slot at time zone 'UTC', 'YYYYMMDD"T"HH24MI');

    v_payload := jsonb_build_object(
      'type', v_sched.job_type::text,
      'orgId', v_sched.org_id,
      'profileId', v_sched.profile_id
    ) || coalesce(v_sched.payload, '{}'::jsonb);

    if v_sched.job_type = 'report.request' then
      v_end := (v_now at time zone v_sched.timezone)::date;
      v_start := v_end - (coalesce(v_sched.lookback_days, 1) - 1);
      v_payload := v_payload || jsonb_build_object(
        'reportType', v_sched.report_type::text,
        'startDate', to_char(v_start, 'YYYY-MM-DD'),
        'endDate', to_char(v_end, 'YYYY-MM-DD')
      );
    elsif v_sched.job_type = 'sqp.categorize' then
      v_end := (v_now at time zone v_sched.timezone)::date;
      v_week_start := v_end - extract(dow from v_end)::integer;
      v_payload := v_payload || jsonb_build_object(
        'weekStart', to_char(v_week_start, 'YYYY-MM-DD')
      );
    end if;

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
  'pg_cron/Vercel-cron target: enqueue due schedules with report windows and SQP Sunday week starts. Idempotent per due slot.';

revoke execute on function public.enqueue_due_schedules(timestamptz) from public;
revoke execute on function public.enqueue_due_schedules(timestamptz) from anon;
revoke execute on function public.enqueue_due_schedules(timestamptz) from authenticated;
grant execute on function public.enqueue_due_schedules(timestamptz) to service_role;
