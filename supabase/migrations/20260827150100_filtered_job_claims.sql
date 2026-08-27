-- WP-41: atomically claim only the job types deployed in one runtime.
--
-- Keep the original two-argument function for older callers. This overload has
-- no default for the allowlist, so two-argument calls remain unambiguous. Null
-- means all job types; an empty array means none.

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
        and c.run_after <= now()
        and (p_job_types is null or c.job_type = any(p_job_types))
      order by c.priority desc, c.run_after, c.created_at
      limit greatest(coalesce(p_limit, 0), 0)
      for update skip locked
   )
  returning j.*;
end;
$$;

comment on function public.claim_sync_jobs(text, integer, public.sync_job_type[]) is
  'Atomically claim queued jobs allowed in this runtime. Null allows all; an empty array allows none.';

revoke execute on function public.claim_sync_jobs(text, integer, public.sync_job_type[]) from public;
revoke execute on function public.claim_sync_jobs(text, integer, public.sync_job_type[]) from anon;
revoke execute on function public.claim_sync_jobs(text, integer, public.sync_job_type[]) from authenticated;
grant execute on function public.claim_sync_jobs(text, integer, public.sync_job_type[]) to service_role;
