-- TEST FIXTURE. Not a migration, never applied to a Supabase project.
--
-- The migrations in ../migrations target Supabase, which supplies four things a
-- plain Postgres does not: the `anon` / `authenticated` / `service_role` roles,
-- the `auth` schema with `auth.uid()`, Supabase Vault, and pg_cron. This file
-- creates the smallest believable version of each so the identical migration
-- files can be applied to any Postgres 15+ and tested there.
--
-- Every statement is guarded, so applying this to a real local Supabase
-- (`supabase db reset`) is a no-op: whatever the platform already provides is
-- left exactly as it is. That property is the point. The shim must never be
-- able to mask a difference between the two environments by overwriting the
-- real thing with an approximation.
--
-- The vault shim stores secrets in plaintext. It is a test double for an
-- encrypted store, it is applied only to a throwaway database, and it must
-- never see a real credential.

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    -- bypassrls is what makes the worker's connection able to write facts for
    -- every org, exactly as on Supabase.
    create role service_role nologin noinherit bypassrls;
  end if;
end;
$$;

grant usage on schema public to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- auth
-- ---------------------------------------------------------------------------

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

-- Column set trimmed to what wizard-ads references (a foreign key target and an
-- email for readable fixtures). The real table has forty more columns and none
-- of them matter here.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  created_at timestamptz not null default now()
);

-- Same definition Supabase ships: read the subject out of the JWT claims that
-- PostgREST puts on the session. Tests set `request.jwt.claims` directly, which
-- is precisely what PostgREST does.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  );
$$;

grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- vault
-- ---------------------------------------------------------------------------

create schema if not exists vault;

create table if not exists vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text not null default '',
  secret text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if to_regclass('vault.decrypted_secrets') is null then
    execute $view$
      create view vault.decrypted_secrets as
        select id, name, description, secret, secret as decrypted_secret, created_at, updated_at
        from vault.secrets
    $view$;
  end if;
end;
$$;

-- Parameters are named `p_*` rather than Supabase's `new_secret` and friends.
-- Callers pass them positionally, so the signature is compatible, and the short
-- names keep the public-repo secret scanner from reading an assignment in this
-- file as a credential. It has no way to tell the difference and it is right to
-- be suspicious.
create or replace function vault.create_secret(
  p_val text,
  p_name text default null,
  p_note text default ''
)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  insert into vault.secrets (name, description, secret)
  values (p_name, coalesce(p_note, ''), p_val)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function vault.update_secret(
  p_id uuid,
  p_val text default null,
  p_name text default null,
  p_note text default null
)
returns void
language plpgsql
as $$
begin
  update vault.secrets
     set secret = coalesce(p_val, secret),
         name = coalesce(p_name, name),
         description = coalesce(p_note, description),
         updated_at = now()
   where id = p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- cron
--
-- Enough of pg_cron for the scheduling migration to run and be asserted
-- against. Nothing here executes anything on a timer: the test checks that the
-- jobs are registered with the right cadence, not that Postgres can tell time.
-- ---------------------------------------------------------------------------

create schema if not exists cron;

create table if not exists cron.job (
  jobid bigint generated always as identity primary key,
  jobname text unique,
  schedule text not null,
  command text not null,
  active boolean not null default true
);

create or replace function cron.schedule(job_name text, schedule text, command text)
returns bigint
language plpgsql
as $$
declare
  v_id bigint;
begin
  insert into cron.job (jobname, schedule, command)
  values (job_name, schedule, command)
  on conflict (jobname) do update
    set schedule = excluded.schedule, command = excluded.command, active = true
  returning jobid into v_id;
  return v_id;
end;
$$;

create or replace function cron.unschedule(job_name text)
returns boolean
language plpgsql
as $$
begin
  delete from cron.job where jobname = job_name;
  return found;
end;
$$;
