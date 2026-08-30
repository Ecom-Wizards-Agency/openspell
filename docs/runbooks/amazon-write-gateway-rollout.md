# Amazon write gateway rollout

Migration `20260829180000_amazon_write_gateway.sql` changes queue claim ownership and is
not a zero-downtime/additive worker rollout. Do not apply it while an old worker can
claim or finish jobs.

## Required order

1. Scale every worker and cron-backed worker invocation to zero. Verify the hosting
   platform shows no running or starting worker process on the old release.
2. Wait for existing invocations to exit. In the target database, require this query
   to return zero:

   ```sql
   select count(*) from public.sync_jobs where status = 'running';
   ```

   Also record queued/dead counts and the newest `updated_at` as rollout evidence.
3. Apply the migration. Its first guard aborts if any running job remains, and the
   old unfenced five-argument `finish_sync_job` signature is removed.
4. Verify only the fenced signature exists:

   ```sql
   select
     to_regprocedure('public.finish_sync_job(uuid,public.sync_job_status,text,jsonb,interval)') is null
       as legacy_removed,
     to_regprocedure('public.finish_sync_job(uuid,uuid,public.sync_job_status,text,jsonb,interval)') is not null
       as fenced_present;
   ```

5. Deploy the matching worker release, then restore one worker replica. Confirm one
   synthetic read-only job claims with a non-null `claim_token`, completes through
   the fenced signature, and no stale running row remains before scaling normally.

## Production preflight still required

Before this migration is authorized for a real project, separately dry-run and
record: cross-tenant or disconnected profile/connection rows that would violate the
new composite foreign keys; historical apply artifacts needing canonical hash/order
regeneration; and the chosen retention/offboarding procedure for immutable write
evidence. Do not repair any of those rows implicitly inside the migration.

