-- wizard-ads: generic external-integration credential custody.
--
-- Keepa, DataDive and My Real Profit share one connection shape. Provider
-- settings that are safe to inspect live in config; the API credential itself
-- lives only in Supabase Vault and this table carries its opaque row id.

create type public.integration_provider as enum ('keepa', 'datadive', 'mrp');

create table public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  provider public.integration_provider not null,
  label text not null,
  vault_secret_id uuid,
  config jsonb not null default '{}'::jsonb,
  status public.connection_status not null default 'pending',
  connected_by uuid references auth.users (id) on delete set null,
  connected_at timestamptz,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, provider, label)
);

comment on table public.integration_connections is
  'Per-organisation external API connections. Credentials live in Vault; config contains non-secret provider settings.';
comment on column public.integration_connections.vault_secret_id is
  'vault.secrets.id. Written and read only by the integration secret custody RPCs.';

create trigger integration_connections_touch before update on public.integration_connections
  for each row execute function app.touch_updated_at();

select app.install_tenant_rls(
  'public.integration_connections',
  array['owner', 'admin']
);

-- The same two-gate custody rule as the Amazon refresh-token RPCs: grants stop
-- browser callers at the door, and the body asserts the role in case a later
-- migration accidentally restores a grant.
create or replace function public.store_integration_secret(
  p_connection_id uuid,
  p_token text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, vault, pg_temp
as $$
declare
  v_secret_id uuid;
  v_org_id uuid;
  v_name text;
begin
  perform app.assert_service_role('store_integration_secret');

  if p_token is null or length(p_token) = 0 then
    raise exception 'refusing to store an empty token' using errcode = '22023';
  end if;

  select c.org_id, c.vault_secret_id into v_org_id, v_secret_id
    from public.integration_connections c
   where c.id = p_connection_id;

  if v_org_id is null then
    raise exception 'no such integration connection %', p_connection_id using errcode = '22023';
  end if;

  v_name := 'wizard-ads:integration-connection:' || p_connection_id::text;

  if v_secret_id is null then
    v_secret_id := vault.create_secret(
      p_token,
      v_name,
      'External integration API credential'
    );
  else
    perform vault.update_secret(v_secret_id, p_token);
  end if;

  update public.integration_connections
     set vault_secret_id = v_secret_id,
         status = 'active',
         connected_at = coalesce(connected_at, now()),
         last_error = null
   where id = p_connection_id;

  return v_secret_id;
end;
$$;

comment on function public.store_integration_secret(uuid, text) is
  'Put an external API credential into Vault and point the integration connection at it. Service role only.';

create or replace function public.get_integration_secret(p_connection_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, vault, pg_temp
as $$
declare
  v_secret_id uuid;
  v_value text;
begin
  perform app.assert_service_role('get_integration_secret');

  select c.vault_secret_id into v_secret_id
    from public.integration_connections c
   where c.id = p_connection_id;

  if v_secret_id is null then
    return null;
  end if;

  select s.decrypted_secret into v_value
    from vault.decrypted_secrets s
   where s.id = v_secret_id;

  return v_value;
end;
$$;

comment on function public.get_integration_secret(uuid) is
  'Read an external API credential from Vault. Service role only: workers call this, never browser clients.';

create or replace function public.revoke_integration_secret(p_connection_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, vault, pg_temp
as $$
declare
  v_secret_id uuid;
begin
  perform app.assert_service_role('revoke_integration_secret');

  select c.vault_secret_id into v_secret_id
    from public.integration_connections c
   where c.id = p_connection_id;

  update public.integration_connections
     set vault_secret_id = null, status = 'revoked'
   where id = p_connection_id;

  if v_secret_id is null then
    return false;
  end if;

  delete from vault.secrets where id = v_secret_id;
  return true;
end;
$$;

revoke all on function public.store_integration_secret(uuid, text) from public;
revoke all on function public.get_integration_secret(uuid) from public;
revoke all on function public.revoke_integration_secret(uuid) from public;
revoke all on function public.store_integration_secret(uuid, text) from anon, authenticated;
revoke all on function public.get_integration_secret(uuid) from anon, authenticated;
revoke all on function public.revoke_integration_secret(uuid) from anon, authenticated;
grant execute on function public.store_integration_secret(uuid, text) to service_role;
grant execute on function public.get_integration_secret(uuid) to service_role;
grant execute on function public.revoke_integration_secret(uuid) to service_role;
