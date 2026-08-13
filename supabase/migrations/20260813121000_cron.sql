-- wizard-ads 0011: scheduled maintenance (pg_cron).
--
-- Four jobs, all of them thin wrappers around functions that already exist and
-- are already tested. pg_cron is the trigger, never the logic.
--
-- The whole file is conditional. pg_cron is available on Supabase and absent
-- from a plain Postgres, and a schema that only applies on one of the two is a
-- schema that cannot be tested locally. When the extension is missing the
-- migration logs a notice and moves on; the functions stay callable by hand and
-- by the worker.
--
-- Cadence note for WP-03: these are the defaults, not a contract. The five
-- minute tick matches the plan's scheduler; if the worker wants a different
-- rhythm, change it here (WP-01 owns migrations) rather than adding a second
-- scheduler.

do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise notice 'pg_cron not available (%); scheduled jobs skipped. The functions remain callable.', sqlerrm;
end;
$$;

do $$
begin
  -- `cron.schedule(name, schedule, command)` upserts by name, so re-running
  -- this migration re-points a job instead of duplicating it.
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'cron.schedule() not present; wizard-ads maintenance jobs not scheduled.';
    return;
  end if;

  -- Turn due schedules into jobs. The plan's five-minute tick.
  perform cron.schedule(
    'wizard-ads-enqueue-due-schedules',
    '*/5 * * * *',
    'select public.enqueue_due_schedules()'
  );

  -- Reclaim jobs whose worker went away mid-flight.
  perform cron.schedule(
    'wizard-ads-requeue-stale-jobs',
    '*/15 * * * *',
    'select public.requeue_stale_sync_jobs()'
  );

  -- Keep two months of fact partitions ahead of today. Runs nightly because a
  -- month boundary that arrives without a partition is a failed report load.
  perform cron.schedule(
    'wizard-ads-ensure-partitions',
    '10 3 * * *',
    'select app.ensure_fact_partitions(current_date, 2)'
  );

  -- Retention: roll up, then drop. Weekly, because dropping data should never
  -- be a nightly reflex.
  perform cron.schedule(
    'wizard-ads-fact-retention',
    '40 3 * * 0',
    'select app.drop_expired_fact_partitions()'
  );
end;
$$;
