-- wizard-ads 0013: RPC grant hardening.
--
-- Hosted-Supabase advisor finding (2026-08-14): the queue and vault RPCs are
-- SECURITY DEFINER and were EXECUTE-callable by `anon` and `authenticated`
-- through PostgREST's /rpc surface. Every one of them already refuses a
-- non-service JWT in the function body, so this closes the outer door to
-- match the inner one: EXECUTE only for service_role.
--
-- Default function ACLs grant EXECUTE to PUBLIC on creation; revoking from
-- PUBLIC plus the two API roles, then granting service_role, is the complete
-- statement of intent.

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.claim_sync_jobs(text, integer)',
    'public.finish_sync_job(uuid, public.sync_job_status, text, jsonb, interval)',
    'public.requeue_stale_sync_jobs(interval)',
    'public.enqueue_due_schedules(timestamptz)',
    'public.store_ads_refresh_token(uuid, text)',
    'public.get_ads_refresh_token(uuid)',
    'public.revoke_ads_refresh_token(uuid)'
  ] loop
    if to_regprocedure(fn) is null then
      raise notice 'function % not present; skipped', fn;
      continue;
    end if;
    execute format('revoke execute on function %s from public', fn);
    execute format('revoke execute on function %s from anon', fn);
    execute format('revoke execute on function %s from authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
