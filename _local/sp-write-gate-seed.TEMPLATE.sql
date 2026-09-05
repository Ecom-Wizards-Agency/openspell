-- First UI pilot only. Copy to a gitignored file and replace every placeholder
-- from the separately approved private scope. Run as the migration owner.
-- This template deliberately ROLLS BACK. A reviewed execution copy may COMMIT.
-- It refuses an existing environment head; replacements need a separate scope.
begin;
set local lock_timeout = '5s';

do $pilot$
declare
  v_org uuid := '__ORG_ID__';
  v_user uuid := '__OPERATOR_USER_ID__';
  v_profile uuid := '__PROFILE_ID__';
  v_connection uuid := '__CONNECTION_ID__';
  v_amazon_profile text := '__AMAZON_PROFILE_ID__';
  v_region public.ads_region := '__REGION__';
  v_marketplace text := '__MARKETPLACE_ID__';
  v_currency text := '__CURRENCY_CODE__';
  v_environment uuid := '__ENVIRONMENT_VERSION_ID__';
  v_grant uuid := '__GRANT_ID__';
  v_version uuid := '__GRANT_VERSION_ID__';
  v_expected_version uuid := nullif('__EXPECTED_PRIOR_GRANT_VERSION_OR_EMPTY__', '');
  v_window_end timestamptz := '__WINDOW_EXPIRES_AT__';
  v_prior public.sp_write_profile_grant_heads%rowtype;
begin
  if clock_timestamp() >= v_window_end then
    raise exception 'Pilot authorization window expired';
  end if;
  perform 1 from public.org_members where org_id = v_org and user_id = v_user
    and role in ('owner', 'admin') for share;
  if not found then raise exception 'Pilot operator scope changed'; end if;
  if exists(select 1 from public.sp_write_environment_gate_head) then
    raise exception 'First-pilot template refuses an existing environment head';
  end if;
  select * into v_prior from public.sp_write_profile_grant_heads
    where org_id = v_org and profile_id = v_profile for update;
  if v_prior.version_id is distinct from v_expected_version
    or (v_prior.version_id is not null and v_prior.grant_id <> v_grant) then
    raise exception 'Pilot prior grant changed';
  end if;
  perform 1 from public.ad_profiles p join public.ads_connections c
    on c.org_id = p.org_id and c.id = p.connection_id
    where p.org_id = v_org and p.id = v_profile and p.sync_enabled
      and p.connection_id = v_connection and p.amazon_profile_id = v_amazon_profile
      and p.region = v_region and p.currency_code = v_currency and c.status = 'active'
    for update of p, c;
  if not found then raise exception 'Pilot profile routing changed'; end if;

  insert into public.sp_write_environment_gate_versions
    (version_id, enabled, max_unresolved_calls, created_by)
    values (v_environment, true, 1, v_user);
  insert into public.sp_write_environment_gate_head(singleton, version_id)
    values (true, v_environment);
  insert into public.sp_write_profile_grant_versions
    (grant_id, version_id, org_id, profile_id, enabled, amazon_profile_id,
     connection_id, region, marketplace_id, currency_code, api_dialect, created_by)
    values (v_grant, v_version, v_org, v_profile, true, v_amazon_profile,
      v_connection, v_region, v_marketplace, v_currency, 'sp_v3', v_user);
  insert into public.sp_write_profile_grant_heads(org_id, profile_id, grant_id, version_id)
    values (v_org, v_profile, v_grant, v_version)
    on conflict(org_id, profile_id) do update set grant_id = excluded.grant_id,
      version_id = excluded.version_id;

  if (select count(*) from public.sp_write_environment_gate_head
      where version_id = v_environment) <> 1
    or (select count(*) from public.sp_write_profile_grant_heads
      where org_id = v_org and profile_id = v_profile and version_id = v_version) <> 1
    or clock_timestamp() >= v_window_end then
    raise exception 'Pilot gate count or authorization window changed';
  end if;
end;
$pilot$;

rollback;
