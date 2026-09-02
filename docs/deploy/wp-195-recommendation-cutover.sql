-- WP-195 read-only recommendation consumer compatibility evidence.
-- Run only after the WP-195 hosted migration exists. This script changes no state.
with active_recommendation_jobs as (
  select job.id as job_id,
         job.status::text as job_status,
         run.id as run_id,
         run.scope_version,
         run.job_id as linked_job_id
    from public.sync_jobs job
    left join public.recommendation_runs run
      on run.org_id = job.org_id
     and run.profile_id = job.profile_id
     and run.id::text = job.payload ->> 'runId'
   where job.job_type = 'recommendations.run'
     and job.status in ('queued', 'running')
)
select count(*) filter (
         where run_id is null or scope_version is null
       )::integer as legacy_active,
       count(*) filter (
         where scope_version = 1
       )::integer as scoped_active,
       count(*) filter (
         where scope_version = 1 and linked_job_id = job_id
       )::integer as scoped_exact_custody,
       count(*) filter (
         where scope_version = 1 and linked_job_id is distinct from job_id
       )::integer as scoped_custody_mismatch
  from active_recommendation_jobs;
