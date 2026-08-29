-- WP-79: explicit Ads-profile to SP-API authorization ownership.
--
-- The existing spapi_connections row owns one encrypted LWA refresh credential.
-- A connection can authorize several marketplaces; each Ads profile gets one
-- exact marketplace binding so SQP/PPC joins cannot borrow another profile's
-- authorization or duplicate spend across marketplace scopes.

create unique index spapi_connections_org_id_id_key
  on public.spapi_connections (org_id, id);

create table public.spapi_profile_bindings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null,
  connection_id uuid not null,
  marketplace_id text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint spapi_profile_bindings_profile_org_fk
    foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint spapi_profile_bindings_connection_org_fk
    foreign key (org_id, connection_id)
    references public.spapi_connections (org_id, id) on delete cascade,
  constraint spapi_profile_bindings_one_per_profile unique (profile_id),
  constraint spapi_profile_bindings_marketplace_nonempty
    check (marketplace_id = btrim(marketplace_id) and length(marketplace_id) between 1 and 64)
);

create index spapi_profile_bindings_connection_idx
  on public.spapi_profile_bindings (connection_id, marketplace_id);

comment on table public.spapi_profile_bindings is
  'One exact SP-API authorization and marketplace per Ads profile. Worker reads only; operator-managed metadata.';

-- Public Amazon marketplace identifiers have one SP-API endpoint region. Keep
-- endpoint selection database-enforced so an Ads profile cannot accidentally
-- send a durable SQP request to the wrong regional host.
create or replace function app.spapi_region_for_marketplace(p_marketplace_id text)
returns public.ads_region
language sql
immutable
parallel safe
set search_path = pg_catalog, public, pg_temp
as $$
  select case p_marketplace_id
    when 'A2EUQ1WTGCTBG2' then 'NA'::public.ads_region -- Canada
    when 'ATVPDKIKX0DER' then 'NA'::public.ads_region -- United States
    when 'A1AM78C64UM0Y8' then 'NA'::public.ads_region -- Mexico
    when 'A2Q3Y263D00KWC' then 'NA'::public.ads_region -- Brazil
    when 'A28R8C7NBKEWEA' then 'EU'::public.ads_region -- Ireland
    when 'A1RKKUPIHCS9HS' then 'EU'::public.ads_region -- Spain
    when 'A1F83G8C2ARO7P' then 'EU'::public.ads_region -- United Kingdom
    when 'A13V1IB3VIYZZH' then 'EU'::public.ads_region -- France
    when 'AMEN7PMS3EDWL' then 'EU'::public.ads_region -- Belgium
    when 'A1805IZSGTT6HS' then 'EU'::public.ads_region -- Netherlands
    when 'A1PA6795UKMFR9' then 'EU'::public.ads_region -- Germany
    when 'APJ6JRA9NG5V4' then 'EU'::public.ads_region -- Italy
    when 'A2NODRKZP88ZB9' then 'EU'::public.ads_region -- Sweden
    when 'AE08WJ6YKNBMC' then 'EU'::public.ads_region -- South Africa
    when 'A1C3SOZRARQ6R3' then 'EU'::public.ads_region -- Poland
    when 'ARBP9OOSHTCHU' then 'EU'::public.ads_region -- Egypt
    when 'A33AVAJ2PDY3EV' then 'EU'::public.ads_region -- Turkey
    when 'A17E79C6D8DWNP' then 'EU'::public.ads_region -- Saudi Arabia
    when 'A2VIGQ35RCS4UG' then 'EU'::public.ads_region -- United Arab Emirates
    when 'A21TJRUUN4KGV' then 'EU'::public.ads_region -- India
    when 'A19VAU5U5O7RUS' then 'FE'::public.ads_region -- Singapore
    when 'A39IBJ37TRP1C6' then 'FE'::public.ads_region -- Australia
    when 'A1VC38T7YXB528' then 'FE'::public.ads_region -- Japan
    else null
  end
$$;

create trigger spapi_profile_bindings_touch
  before update on public.spapi_profile_bindings
  for each row execute function app.touch_updated_at();

create or replace function app.assert_spapi_binding_marketplace()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_profile_region public.ads_region;
  v_marketplace_region public.ads_region;
begin
  if not exists (
    select 1
      from public.spapi_connections c
     where c.id = new.connection_id
       and c.org_id = new.org_id
       and new.marketplace_id = any(c.marketplace_ids)
  ) then
    raise exception 'SP-API binding marketplace is not authorized by its connection'
      using errcode = '23514';
  end if;

  select p.region into v_profile_region
    from public.ad_profiles p
   where p.id = new.profile_id
     and p.org_id = new.org_id;
  v_marketplace_region := app.spapi_region_for_marketplace(new.marketplace_id);
  if v_marketplace_region is null then
    raise exception 'SP-API binding marketplace is unsupported'
      using errcode = '23514';
  end if;
  if v_profile_region is null or v_profile_region <> v_marketplace_region then
    raise exception 'SP-API binding marketplace does not match the Ads profile region'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger spapi_profile_bindings_marketplace_guard
  before insert or update of connection_id, org_id, marketplace_id
  on public.spapi_profile_bindings
  for each row execute function app.assert_spapi_binding_marketplace();

create or replace function app.assert_spapi_connection_marketplaces()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if exists (
    select 1
      from public.spapi_profile_bindings b
     where b.connection_id = new.id
       and (b.org_id <> new.org_id or not (b.marketplace_id = any(new.marketplace_ids)))
  ) then
    raise exception 'SP-API connection update would orphan a profile marketplace binding'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger spapi_connections_marketplace_guard
  before update of org_id, marketplace_ids on public.spapi_connections
  for each row execute function app.assert_spapi_connection_marketplaces();

create or replace function app.assert_spapi_profile_region()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if exists (
    select 1
      from public.spapi_profile_bindings b
     where b.profile_id = new.id
       and b.org_id = new.org_id
       and app.spapi_region_for_marketplace(b.marketplace_id) is distinct from new.region
  ) then
    raise exception 'Ads profile region update would invalidate its SP-API marketplace binding'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger ad_profiles_spapi_region_guard
  before update of org_id, region on public.ad_profiles
  for each row execute function app.assert_spapi_profile_region();

select app.install_tenant_rls('public.spapi_profile_bindings', array['owner', 'admin']);

create or replace function app.guard_spapi_vault_pointer()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if (tg_op = 'INSERT' and new.vault_secret_id is not null)
     or (tg_op = 'UPDATE' and new.vault_secret_id is distinct from old.vault_secret_id) then
    perform app.assert_service_role('spapi_connections.vault_secret_id');
  end if;
  return new;
end;
$$;

create trigger spapi_connections_vault_pointer_guard
  before insert or update of vault_secret_id on public.spapi_connections
  for each row execute function app.guard_spapi_vault_pointer();

-- Dedicated custody functions keep SP-API credentials out of the generic
-- integration table and preserve the same service-role-only boundary as Ads.
create or replace function public.store_spapi_refresh_token(
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
  perform app.assert_service_role('store_spapi_refresh_token');

  if p_token is null or length(p_token) = 0 then
    raise exception 'refusing to store an empty SP-API credential' using errcode = '22023';
  end if;

  select c.org_id, c.vault_secret_id into v_org_id, v_secret_id
    from public.spapi_connections c
   where c.id = p_connection_id
   for update;

  if v_org_id is null then
    raise exception 'no such SP-API connection' using errcode = '22023';
  end if;

  v_name := 'wizard-ads:spapi-connection:' || p_connection_id::text;
  if v_secret_id is null then
    v_secret_id := vault.create_secret(p_token, v_name, 'Amazon SP-API LWA refresh credential');
  else
    perform vault.update_secret(v_secret_id, p_token);
  end if;

  update public.spapi_connections
     set vault_secret_id = v_secret_id,
         status = 'active',
         connected_at = coalesce(connected_at, now()),
         last_error = null
   where id = p_connection_id;

  return v_secret_id;
end;
$$;

create or replace function public.get_spapi_refresh_token(p_connection_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, vault, pg_temp
as $$
declare
  v_secret_id uuid;
  v_value text;
begin
  perform app.assert_service_role('get_spapi_refresh_token');

  select c.vault_secret_id into v_secret_id
    from public.spapi_connections c
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

create or replace function public.revoke_spapi_refresh_token(p_connection_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, vault, pg_temp
as $$
declare
  v_secret_id uuid;
begin
  perform app.assert_service_role('revoke_spapi_refresh_token');

  select c.vault_secret_id into v_secret_id
    from public.spapi_connections c
   where c.id = p_connection_id
   for update;

  update public.spapi_connections
     set vault_secret_id = null, status = 'revoked'
   where id = p_connection_id;

  if v_secret_id is null then
    return false;
  end if;

  delete from vault.secrets where id = v_secret_id;
  return true;
end;
$$;

comment on function public.store_spapi_refresh_token(uuid, text) is
  'Store or rotate an SP-API LWA refresh credential in Vault. Service role only.';
comment on function public.get_spapi_refresh_token(uuid) is
  'Read an SP-API LWA refresh credential for a worker. Service role only.';
comment on function public.revoke_spapi_refresh_token(uuid) is
  'Delete an SP-API LWA refresh credential and revoke its connection. Service role only.';

revoke all on function public.store_spapi_refresh_token(uuid, text) from public, anon, authenticated;
revoke all on function public.get_spapi_refresh_token(uuid) from public, anon, authenticated;
revoke all on function public.revoke_spapi_refresh_token(uuid) from public, anon, authenticated;
grant execute on function public.store_spapi_refresh_token(uuid, text) to service_role;
grant execute on function public.get_spapi_refresh_token(uuid) to service_role;
grant execute on function public.revoke_spapi_refresh_token(uuid) to service_role;
