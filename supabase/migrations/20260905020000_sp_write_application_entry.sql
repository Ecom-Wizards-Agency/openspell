-- A versioned application entry cannot fall back to pre-preview approval SQL.
-- Existing evidence remains readable; no environment/profile gate is enabled.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

create function app.approve_sp_write_preview_v1(p_plan_id uuid, p_approval_request_text text)
returns jsonb
language sql
security invoker
set search_path = pg_catalog, app, pg_temp
as $$
  select app.approve_sp_write_cycle(p_plan_id, p_approval_request_text);
$$;

revoke all on function app.approve_sp_write_preview_v1(uuid,text) from public, anon, service_role;
grant execute on function app.approve_sp_write_preview_v1(uuid,text) to authenticated;
