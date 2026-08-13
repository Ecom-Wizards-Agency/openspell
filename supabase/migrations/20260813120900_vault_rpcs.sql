-- wizard-ads 0010: Amazon token custody.
--
-- The refresh token is the single most valuable string in the system: one
-- agency-wide credential for 211 advertiser profiles. Three rules, enforced
-- here rather than remembered:
--
--  1. It lives in Supabase Vault, encrypted at rest, never in a table column.
--  2. It moves only through these `security definer` functions.
--  3. Only the service role may call them. The web tier never holds an Amazon
--     token; it calls the store function once during the OAuth callback and
--     never reads one back.
--
-- Two gates, deliberately redundant. EXECUTE is revoked from `public`, `anon`
-- and `authenticated`, so a browser client is refused by the grant system
-- before the body runs. The body then asserts the caller role anyway, which
-- catches the case where somebody re-grants EXECUTE in a later migration.

create or replace function public.store_ads_refresh_token(
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
  perform app.assert_service_role('store_ads_refresh_token');

  if p_token is null or length(p_token) = 0 then
    raise exception 'refusing to store an empty token' using errcode = '22023';
  end if;

  select c.org_id, c.vault_secret_id into v_org_id, v_secret_id
    from public.ads_connections c
   where c.id = p_connection_id;

  if v_org_id is null then
    raise exception 'no such ads connection %', p_connection_id using errcode = '22023';
  end if;

  v_name := 'wizard-ads:ads-connection:' || p_connection_id::text;

  if v_secret_id is null then
    v_secret_id := vault.create_secret(p_token, v_name, 'Amazon Ads LWA refresh credential');
  else
    perform vault.update_secret(v_secret_id, p_token);
  end if;

  update public.ads_connections
     set vault_secret_id = v_secret_id,
         status = 'active',
         connected_at = coalesce(connected_at, now()),
         last_error = null
   where id = p_connection_id;

  return v_secret_id;
end;
$$;

comment on function public.store_ads_refresh_token(uuid, text) is
  'Put an Amazon credential into Vault and point the connection at it. Service role only. Returns the vault secret id, never the value.';

create or replace function public.get_ads_refresh_token(p_connection_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, vault, pg_temp
as $$
declare
  v_secret_id uuid;
  v_value text;
begin
  perform app.assert_service_role('get_ads_refresh_token');

  select c.vault_secret_id into v_secret_id
    from public.ads_connections c
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

comment on function public.get_ads_refresh_token(uuid) is
  'Read an Amazon credential back out of Vault. Service role only: this is the worker''s call, never the web tier''s.';

create or replace function public.revoke_ads_refresh_token(p_connection_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, vault, pg_temp
as $$
declare
  v_secret_id uuid;
begin
  perform app.assert_service_role('revoke_ads_refresh_token');

  select c.vault_secret_id into v_secret_id
    from public.ads_connections c
   where c.id = p_connection_id;

  update public.ads_connections
     set vault_secret_id = null, status = 'revoked'
   where id = p_connection_id;

  if v_secret_id is null then
    return false;
  end if;

  delete from vault.secrets where id = v_secret_id;
  return true;
end;
$$;

-- The grant side of the gate.
revoke all on function public.store_ads_refresh_token(uuid, text) from public;
revoke all on function public.get_ads_refresh_token(uuid) from public;
revoke all on function public.revoke_ads_refresh_token(uuid) from public;
grant execute on function public.store_ads_refresh_token(uuid, text) to service_role;
grant execute on function public.get_ads_refresh_token(uuid) to service_role;
grant execute on function public.revoke_ads_refresh_token(uuid) to service_role;
