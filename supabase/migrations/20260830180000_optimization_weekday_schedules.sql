-- WP-171: replace opaque optimization intervals with explicit local weekdays.
--
-- `cadence` deliberately remains in place as dormant rollback evidence. New
-- scheduling decisions use only review_weekdays + the profile timezone/hour.

-- Function replacement, column DDL, backfill updates and trigger creation need
-- brief relation locks. Keep the timeout transaction-scoped through Supabase's
-- migration-ledger write and fail closed behind live optimizer traffic.
set local lock_timeout = '5s';

create or replace function app.canonical_optimization_weekdays(p_weekdays smallint[])
returns smallint[]
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select coalesce(array_agg(value order by value), '{}'::smallint[])
    from (
      select distinct value
        from unnest(p_weekdays) as weekday(value)
       where value between 1 and 7
    ) canonical;
$$;

create or replace function app.next_optimization_review_at(
  p_weekdays smallint[],
  p_timezone text,
  p_local_hour integer,
  p_after timestamptz
)
returns timestamptz
language plpgsql
immutable
strict
set search_path = pg_catalog
as $$
declare
  v_local_date date;
  v_offset integer;
  v_candidate timestamptz;
begin
  if p_local_hour < 0 or p_local_hour > 23 then
    raise exception 'optimization review local hour must be between 0 and 23';
  end if;
  if cardinality(p_weekdays) = 0
     or p_weekdays <> app.canonical_optimization_weekdays(p_weekdays) then
    raise exception 'optimization review weekdays must be unique ISO weekdays in ascending order';
  end if;

  -- Convert the instant to a local calendar date first, then resolve each
  -- local candidate back through the IANA zone. PostgreSQL deterministically
  -- resolves DST gaps/overlaps; adding 24 hours to UTC would not.
  v_local_date := (p_after at time zone p_timezone)::date;
  for v_offset in 0..7 loop
    if extract(isodow from v_local_date + v_offset)::smallint = any (p_weekdays) then
      v_candidate := (
        (v_local_date + v_offset)::timestamp
        + make_interval(hours => p_local_hour)
      ) at time zone p_timezone;
      if v_candidate > p_after then
        return v_candidate;
      end if;
    end if;
  end loop;
  raise exception 'could not resolve the next optimization review occurrence';
end;
$$;

create or replace function app.legacy_optimization_review_weekdays(
  p_cadence interval,
  p_anchor timestamptz,
  p_timezone text
)
returns smallint[]
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select case
    when p_cadence <= interval '1 day'
      then array[1, 2, 3, 4, 5, 6, 7]::smallint[]
    else array[extract(isodow from p_anchor at time zone p_timezone)::smallint]
  end;
$$;

alter table public.optimization_groups
  add column review_weekdays smallint[];

-- Daily-or-faster legacy groups become every day. Longer intervals retain
-- their existing next_run_at's local ISO weekday as their anchor. Intervals
-- other than exactly seven days cannot retain their old elapsed-day meaning;
-- the per-organisation count is retained in audit_log below for rollout review.
update public.optimization_groups optimization_group
   set review_weekdays = app.legacy_optimization_review_weekdays(
     optimization_group.cadence,
     coalesce(optimization_group.next_run_at, optimization_group.created_at),
     profile.timezone
   )
  from public.ad_profiles profile
 where profile.org_id = optimization_group.org_id
   and profile.id = optimization_group.profile_id;

insert into public.audit_log (
  org_id, actor_type, action, target_type, target_id, payload, source
)
select optimization_group.org_id,
       'system',
       'optimization_group.weekday_backfill',
       'optimization_schedule_migration',
       'wp-171',
       jsonb_build_object(
         'groups', count(*),
         'dailyOrFaster', count(*) filter (where optimization_group.cadence <= interval '1 day'),
         'anchored', count(*) filter (where optimization_group.cadence > interval '1 day'),
         'ambiguousIntervals', count(*) filter (
           where optimization_group.cadence > interval '1 day'
             and optimization_group.cadence <> interval '7 days'
         )
       ),
       'migration'
  from public.optimization_groups optimization_group
 group by optimization_group.org_id;

alter table public.optimization_groups
  alter column review_weekdays set default array[1, 2, 3, 4, 5, 6, 7]::smallint[],
  alter column review_weekdays set not null,
  add constraint optimization_groups_review_weekdays_canonical check (
    cardinality(review_weekdays) between 1 and 7
    and review_weekdays = app.canonical_optimization_weekdays(review_weekdays)
  );

comment on column public.optimization_groups.review_weekdays is
  'Canonical ISO weekdays (Monday=1 through Sunday=7) for local recommendation previews.';
comment on column public.optimization_groups.cadence is
  'Dormant legacy interval retained for rollback; weekday scheduling does not read it.';

alter table public.recommendation_runs
  add column schedule_context jsonb;

comment on column public.recommendation_runs.schedule_context is
  'Immutable v2 timezone, weekday, local-hour, due, evaluation and trigger context for a group run.';

create or replace function app.set_optimization_group_next_run()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_timezone text;
  v_hour smallint;
begin
  if not new.enabled then
    new.next_run_at := null;
    return new;
  end if;

  if tg_op = 'INSERT'
     or old.enabled is distinct from new.enabled
     or old.review_weekdays is distinct from new.review_weekdays
     or new.next_run_at is null then
    select profile.timezone, coalesce(profile.preferred_sync_hour, 4)::smallint
      into strict v_timezone, v_hour
      from public.ad_profiles profile
     where profile.org_id = new.org_id and profile.id = new.profile_id;
    new.next_run_at := app.next_optimization_review_at(
      new.review_weekdays,
      v_timezone,
      v_hour,
      statement_timestamp()
    );
  end if;
  return new;
end;
$$;

create trigger optimization_groups_schedule
before insert or update of enabled, review_weekdays, next_run_at
on public.optimization_groups
for each row execute function app.set_optimization_group_next_run();

create or replace function app.refresh_profile_optimization_schedules()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.timezone is distinct from new.timezone
     or old.preferred_sync_hour is distinct from new.preferred_sync_hour then
    update public.optimization_groups optimization_group
       set next_run_at = case
         when optimization_group.enabled then app.next_optimization_review_at(
           optimization_group.review_weekdays,
           new.timezone,
           coalesce(new.preferred_sync_hour, 4)::smallint,
           statement_timestamp()
         )
         else null
       end
     where optimization_group.org_id = new.org_id
       and optimization_group.profile_id = new.id;
  end if;
  return new;
end;
$$;

create trigger ad_profiles_refresh_optimization_schedules
after update of timezone, preferred_sync_hour
on public.ad_profiles
for each row execute function app.refresh_profile_optimization_schedules();

-- Re-anchor migrated schedules through the same authority used at runtime.
update public.optimization_groups optimization_group
   set next_run_at = case
     when optimization_group.enabled then app.next_optimization_review_at(
       optimization_group.review_weekdays,
       profile.timezone,
       coalesce(profile.preferred_sync_hour, 4)::smallint,
       statement_timestamp()
     )
     else null
   end
  from public.ad_profiles profile
 where profile.org_id = optimization_group.org_id
   and profile.id = optimization_group.profile_id;
