-- WP-90: profile-local weekday scheduling for recommendation previews.
--
-- The legacy cadence/next_run_at columns deliberately remain intact for a
-- rollback window. New runtime scheduling uses review_weekdays,
-- review_local_time and next_review_at. This migration creates no Amazon write
-- path and never enables an unattended apply cadence.

create or replace function app.normalize_optimization_weekdays(p_days text[])
returns text[]
language sql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(array_agg(day order by position), '{}'::text[])
    from (
      select distinct day,
             case day
               when 'monday' then 1 when 'tuesday' then 2
               when 'wednesday' then 3 when 'thursday' then 4
               when 'friday' then 5 when 'saturday' then 6
               when 'sunday' then 7
             end as position
        from unnest(p_days) as offered(day)
       where day = any (array[
         'monday', 'tuesday', 'wednesday', 'thursday',
         'friday', 'saturday', 'sunday'
       ]::text[])
    ) normalized
$$;

alter table public.optimization_groups
  add column review_weekdays text[],
  add column review_local_time time(0) without time zone,
  add column schedule_migration_state text,
  add column next_review_at timestamptz;

update public.optimization_groups g
   set review_weekdays = case
         when g.cadence = interval '1 day' then array[
           'monday', 'tuesday', 'wednesday', 'thursday',
           'friday', 'saturday', 'sunday'
         ]::text[]
         else array[
           case extract(isodow from (
             coalesce(g.next_run_at, now()) at time zone p.timezone
           ))::integer
             when 1 then 'monday' when 2 then 'tuesday'
             when 3 then 'wednesday' when 4 then 'thursday'
             when 5 then 'friday' when 6 then 'saturday'
             else 'sunday'
           end
         ]::text[]
       end,
       review_local_time = coalesce(
         (g.next_run_at at time zone p.timezone)::time(0),
         time '04:00'
       ),
       schedule_migration_state = case
         when g.cadence in (interval '1 day', interval '7 days')
           then 'legacy_supported'
         else 'needs_review'
       end,
       next_review_at = case
         when g.cadence in (interval '1 day', interval '7 days')
           then g.next_run_at
         else null
       end,
       enabled = case
         when g.cadence in (interval '1 day', interval '7 days')
           then g.enabled
         else false
       end
  from public.ad_profiles p
 where p.org_id = g.org_id and p.id = g.profile_id;

alter table public.optimization_groups
  alter column review_weekdays set not null,
  alter column review_weekdays set default array['monday']::text[],
  alter column review_local_time set not null,
  alter column review_local_time set default time '04:00',
  alter column schedule_migration_state set not null,
  alter column schedule_migration_state set default 'needs_review',
  add constraint optimization_groups_review_weekdays_canonical check (
    cardinality(review_weekdays) > 0
    and review_weekdays = app.normalize_optimization_weekdays(review_weekdays)
  ),
  add constraint optimization_groups_schedule_migration_state_check check (
    schedule_migration_state in ('native', 'legacy_supported', 'needs_review')
  ),
  add constraint optimization_groups_needs_review_disabled check (
    schedule_migration_state <> 'needs_review' or not enabled
  );

create index optimization_groups_review_due_idx
  on public.optimization_groups (next_review_at)
  where enabled and schedule_migration_state <> 'needs_review';

comment on column public.optimization_groups.cadence is
  'Legacy rollback compatibility only. Weekday preview scheduling uses review_weekdays and review_local_time.';
comment on column public.optimization_groups.next_run_at is
  'Legacy rollback compatibility only. Weekday preview scheduling uses next_review_at.';
comment on column public.optimization_groups.enabled is
  'Whether scheduled recommendation previews are enabled. Manual previews remain available.';

alter table public.recommendation_runs
  add column run_trigger text not null default 'legacy',
  add column schedule_context jsonb,
  add constraint recommendation_runs_trigger_check check (
    run_trigger in ('legacy', 'manual', 'schedule')
  ),
  add constraint recommendation_runs_schedule_context_check check (
    (run_trigger = 'legacy' and schedule_context is null)
    or (
      run_trigger in ('manual', 'schedule')
      and jsonb_typeof(schedule_context) = 'object'
      and schedule_context ->> 'trigger' = run_trigger
      and nullif(btrim(schedule_context ->> 'profileTimezone'), '') is not null
      and (schedule_context ->> 'queuedAt')::timestamptz is not null
      and jsonb_typeof(schedule_context -> 'scheduleEnabled') = 'boolean'
      and (
        (group_id is null and schedule_context -> 'reviewSchedule' = 'null'::jsonb)
        or (
          group_id is not null
          and group_snapshot is not null
          and schedule_context -> 'reviewSchedule' = group_snapshot -> 'reviewSchedule'
          and schedule_context -> 'scheduleEnabled' = group_snapshot -> 'enabled'
        )
      )
    )
  ),
  add constraint recommendation_runs_scheduled_due_check check (
    run_trigger <> 'schedule'
    or (
      group_id is not null
      and due_at is not null
      and schedule_context -> 'scheduleEnabled' = 'true'::jsonb
      and schedule_context ->> 'scheduledFor' is not null
      and (schedule_context ->> 'scheduledFor')::timestamptz = due_at
    )
  ),
  add constraint recommendation_runs_manual_occurrence_check check (
    run_trigger <> 'manual'
    or schedule_context -> 'scheduledFor' = 'null'::jsonb
  );

create unique index recommendation_runs_group_schedule_occurrence_key
  on public.recommendation_runs (group_id, due_at)
  where run_trigger = 'schedule';

create or replace function app.guard_recommendation_schedule_evidence()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.group_id is distinct from new.group_id
     or old.group_role is distinct from new.group_role
     or old.group_snapshot is distinct from new.group_snapshot
     or old.due_at is distinct from new.due_at
     or old.run_trigger is distinct from new.run_trigger
     or old.schedule_context is distinct from new.schedule_context then
    raise exception 'recommendation schedule evidence is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger recommendation_runs_schedule_evidence_guard
  before update on public.recommendation_runs
  for each row execute function app.guard_recommendation_schedule_evidence();
