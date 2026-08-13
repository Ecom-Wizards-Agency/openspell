-- wizard-ads 0001: platform prerequisites.
--
-- Everything in here is machinery the rest of the schema leans on: the private
-- `app` schema, the tenancy predicates every RLS policy calls, and one DDL
-- helper that stamps the same policy set onto forty tables.
--
-- Why a helper instead of forty hand-written policy blocks: the RLS rule is a
-- single sentence ("a member of the org reads it; a role-gated member writes
-- it; anon gets nothing"), and forty copies of a sentence drift. The helper
-- makes the rule enforceable by a test that walks pg_policy and asserts every
-- tenant table carries the full set.
--
-- Objects in `app` are deliberately NOT in `public`: PostgREST exposes `public`
-- and nothing else, so nothing here is reachable over the API.

create schema if not exists app;

comment on schema app is
  'wizard-ads internals: tenancy predicates, partition automation, DDL helpers. Not exposed over PostgREST.';

grant usage on schema app to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Caller identity
-- ---------------------------------------------------------------------------

-- The role PostgREST put in the JWT, or the session role for a direct
-- connection. Read inside a `security definer` function this still reports the
-- caller, because `current_user` there is the function owner and the JWT claim
-- is a session setting that survives the switch.
create or replace function app.caller_role()
returns text
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_claims text;
begin
  v_claims := nullif(current_setting('request.jwt.claims', true), '');
  if v_claims is not null then
    begin
      return v_claims::jsonb ->> 'role';
    exception when others then
      return null;
    end;
  end if;
  return session_user::text;
end;
$$;

comment on function app.caller_role() is
  'Effective caller role: the JWT claim when PostgREST set one, else the session role.';

create or replace function app.is_service_role()
returns boolean
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_role text := app.caller_role();
begin
  if v_role is null then
    return false;
  end if;
  if v_role = 'service_role' then
    return true;
  end if;
  -- A direct superuser connection (migrations, the seeder, psql) counts. An
  -- `anon` or `authenticated` JWT never reaches this branch.
  if v_role in ('anon', 'authenticated') then
    return false;
  end if;
  -- coalesce, not `or`: an unknown role name yields null, and `not null` is not
  -- true, which would make the assert below pass silently.
  return coalesce(
    pg_catalog.pg_has_role(v_role, 'service_role', 'member')
      or (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = v_role),
    false
  );
exception when others then
  return false;
end;
$$;

comment on function app.is_service_role() is
  'True for the worker (service role) and direct superuser connections. The gate on every token RPC.';

create or replace function app.assert_service_role(p_what text)
returns void
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
begin
  if not app.is_service_role() then
    raise exception '% is service-role only (caller: %)', p_what, coalesce(app.caller_role(), '<none>')
      using errcode = '42501';
  end if;
end;
$$;

grant execute on function app.caller_role() to authenticated, service_role;
grant execute on function app.is_service_role() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS installer
-- ---------------------------------------------------------------------------

-- Roles a tenant table's writes can be gated on. Ordered strongest first; the
-- order is not semantic, the membership test is.
create type public.org_role as enum ('owner', 'admin', 'analyst', 'viewer');

comment on type public.org_role is
  'Membership role. viewer reads; analyst reads and decides on proposals; admin configures; owner owns billing and membership.';

-- Install the standard tenant policy set on a table.
--
--   p_write_roles = null  -> members read, only the service role writes. This
--                            is the default for anything the sync worker owns:
--                            facts, the entity mirror, the job queue. A user
--                            editing a fact row is a bug, not a feature.
--   p_write_roles = {...} -> members read, listed roles write.
--
-- `anon` is revoked explicitly because Supabase's default privileges grant new
-- public tables to anon, and RLS-with-no-policy plus a live grant is one
-- forgotten policy away from a public table.
create or replace function app.install_tenant_rls(
  p_table regclass,
  p_write_roles text[] default null
)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_ident text := p_table::text;
begin
  execute format('alter table %s enable row level security', v_ident);

  execute format(
    'create policy tenant_read on %s for select to authenticated using (app.is_org_member(org_id))',
    v_ident
  );

  if p_write_roles is not null then
    execute format(
      'create policy tenant_insert on %s for insert to authenticated with check (app.has_org_role(org_id, %L))',
      v_ident, p_write_roles
    );
    execute format(
      'create policy tenant_update on %s for update to authenticated using (app.has_org_role(org_id, %L)) with check (app.has_org_role(org_id, %L))',
      v_ident, p_write_roles, p_write_roles
    );
    execute format(
      'create policy tenant_delete on %s for delete to authenticated using (app.has_org_role(org_id, %L))',
      v_ident, p_write_roles
    );
  end if;

  execute format('revoke all on %s from anon', v_ident);
  execute format('grant select on %s to authenticated', v_ident);
  if p_write_roles is not null then
    execute format('grant insert, update, delete on %s to authenticated', v_ident);
  end if;
  execute format('grant all on %s to service_role', v_ident);
end;
$$;

comment on function app.install_tenant_rls(regclass, text[]) is
  'Stamp the standard org_id policy set on a tenant table. Null write roles means service-role-only writes.';

-- Timestamps that update themselves, so "when did this row last change" is a
-- fact rather than a convention.
create or replace function app.touch_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
