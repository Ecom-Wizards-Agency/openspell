-- WP-217 operator-issued immutable key authority. No MCP admission or worker activation.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

alter table mcp.api_keys add constraint api_keys_tenant_identity_key unique (org_id, id);

create table mcp.write_delegations (
  version_id uuid primary key,
  org_id uuid not null references public.orgs(id) on delete cascade,
  key_id uuid not null unique,
  issuer_user_id uuid not null references auth.users(id),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  artifact_text text not null,
  artifact jsonb not null,
  fingerprint_preimage text not null,
  fingerprint text not null,
  constraint write_delegations_key_fkey foreign key (org_id, key_id)
    references mcp.api_keys(org_id, id) on delete cascade,
  constraint write_delegations_scope_key unique (org_id, key_id, version_id),
  constraint write_delegations_shape check (
    issued_at < expires_at and expires_at <= issued_at + interval '2160 hours'
    and artifact = artifact_text::jsonb and fingerprint ~ '^[a-f0-9]{64}$'
    and fingerprint = app.sp_write_sha256(fingerprint_preimage)
    and artifact ->> 'schemaVersion' = 'openspell.mcp-write-delegation.v1'
    and artifact ->> 'fingerprint' = fingerprint
    and artifact ->> 'orgId' = org_id::text and artifact ->> 'keyId' = key_id::text
    and artifact ->> 'versionId' = version_id::text and artifact ->> 'issuerUserId' = issuer_user_id::text
  )
);

alter table mcp.write_delegations enable row level security;
revoke all on mcp.write_delegations from public, anon, authenticated, service_role;
grant select on mcp.write_delegations to service_role;
create trigger write_delegations_immutable before update or delete on mcp.write_delegations
  for each row execute function app.reject_sp_write_evidence_change();
create trigger write_delegations_no_truncate before truncate on mcp.write_delegations
  for each statement execute function app.reject_sp_write_evidence_truncate();

-- Old read-key code may keep issuing reads, but cannot upgrade a credential in place.
-- A write insert is available only inside an owner-run definer or to the database owner.
create function app.guard_mcp_write_key()
returns trigger language plpgsql set search_path = pg_catalog, public, app, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.scope = 'write' and current_user <> pg_get_userbyid((
      select relowner from pg_class where oid = 'mcp.api_keys'::regclass
    )) then
      raise exception 'write keys require operator issuance' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.scope = 'write' and exists (select 1 from public.orgs where id = old.org_id) then
      raise exception 'write keys must be revoked, not deleted' using errcode = '55000';
    end if;
    return old;
  end if;
  if old.scope is distinct from new.scope then
    raise exception 'MCP key scope is immutable' using errcode = '55000';
  end if;
  if old.scope = 'write' and (
    to_jsonb(old) - 'revoked_at' - 'last_used_at' is distinct from to_jsonb(new) - 'revoked_at' - 'last_used_at'
    or (old.revoked_at is not null and old.revoked_at is distinct from new.revoked_at)
    or (new.revoked_at is not null and (new.revoked_at < old.created_at or new.revoked_at > clock_timestamp()))
  ) then
    raise exception 'write key authority is immutable; issue a new key' using errcode = '55000';
  end if;
  if old.scope = 'write' and old.revoked_at is distinct from new.revoked_at
    and current_user <> pg_get_userbyid((select relowner from pg_class where oid = 'mcp.api_keys'::regclass)) then
    raise exception 'write keys require audited operator revocation' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger api_keys_guard_write before insert or update or delete on mcp.api_keys
  for each row execute function app.guard_mcp_write_key();
create trigger api_keys_no_truncate before truncate on mcp.api_keys
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger audit_log_mcp_authority_immutable before update or delete on public.audit_log
  for each row when (old.action in ('mcp.write_key.issued','mcp.key.revoked'))
  execute function app.reject_sp_write_evidence_change();

-- Caller supplies a canonical artifact made from server identity and current DB facts.
-- This function independently checks every policy field and current owner/profile authority.
create function app.issue_mcp_write_key_v1(
  p_delegation_text text, p_fingerprint_preimage text, p_token_hash text, p_key_prefix text
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, app, auth, mcp, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v jsonb := p_delegation_text::jsonb;
  v_limits jsonb;
  v_profile jsonb;
  v_amount jsonb;
  v_org uuid;
  v_key uuid;
  v_version uuid;
  v_issued timestamptz;
  v_expiry timestamptz;
  v_now timestamptz;
  v_profiles uuid[] := array[]::uuid[];
  v_currencies text[] := array[]::text[];
  v_money_currencies text[] := array[]::text[];
  v_previous text := '';
  v_count integer;
  v_canonical_preimage text;
  v_profile_json text;
  v_money_json text;
  v_decimal text := '^(0|[1-9][0-9]{0,11})([.][0-9]{0,5}[1-9])?$';
  v_uuid text := '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$';
  v_instant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9]([.][0-9]+)?)?Z$';
begin
  if v_actor is null then raise exception 'operator authentication required' using errcode = '42501'; end if;
  if not coalesce(app.sp_write_exact_json_keys(v, array[
    'schemaVersion','versionId','keyId','keyLabel','orgId','issuerUserId','profiles',
    'issuedAt','expiresAt','limits','fingerprint'
  ]) and v ->> 'schemaVersion' = 'openspell.mcp-write-delegation.v1'
    and jsonb_typeof(v -> 'profiles') = 'array' and jsonb_array_length(v -> 'profiles') > 0
    and jsonb_typeof(v -> 'keyLabel') = 'string' and length(v ->> 'keyLabel') between 1 and 160
    and v ->> 'keyLabel' = btrim(v ->> 'keyLabel',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
    and p_token_hash ~ '^[a-f0-9]{64}$' and p_key_prefix ~ '^wza_[A-Za-z0-9_-]{8}$'
    and v ->> 'fingerprint' = app.sp_write_sha256(p_fingerprint_preimage)
    and p_fingerprint_preimage::jsonb = jsonb_build_array('openspell.mcp-write-delegation-fingerprint.v1', v - 'fingerprint'), false) then
    raise exception 'invalid MCP delegation artifact' using errcode = '22023';
  end if;
  if length(v ->> 'keyLabel') + (select count(*) from regexp_split_to_table(v ->> 'keyLabel','') ch where octet_length(ch) = 4) > 160 then
    raise exception 'MCP key label exceeds UTF-16 length limit' using errcode = '22023';
  end if;
  v_org := (v ->> 'orgId')::uuid; v_key := (v ->> 'keyId')::uuid; v_version := (v ->> 'versionId')::uuid;
  if not coalesce(v ->> 'orgId' ~ v_uuid and v ->> 'keyId' ~ v_uuid
    and v ->> 'versionId' ~ v_uuid and v ->> 'issuerUserId' ~ v_uuid
    and v ->> 'issuerUserId' = v_actor::text, false) then
    raise exception 'delegation actor or identity mismatch' using errcode = '42501';
  end if;
  perform 1 from public.orgs where id = v_org for key share;
  perform 1 from public.org_members where org_id = v_org and user_id = v_actor
    and role in ('owner','admin') for share;
  if not found then raise exception 'operator membership required' using errcode = '42501'; end if;
  v_limits := v -> 'limits';
  if not coalesce(app.sp_write_exact_json_keys(v_limits, array[
    'action','maximumRowsPerCall','maximumRowsPerUtcDay','maximumAbsoluteDeltaByCurrency','maximumRelativeDelta'
  ]) and v_limits ->> 'action' = 'keyword.bid'
    and jsonb_typeof(v_limits -> 'maximumRowsPerCall') = 'number'
    and jsonb_typeof(v_limits -> 'maximumRowsPerUtcDay') = 'number'
    and (v_limits ->> 'maximumRowsPerCall')::integer between 1 and 500
    and (v_limits ->> 'maximumRowsPerUtcDay')::integer >= (v_limits ->> 'maximumRowsPerCall')::integer
    and jsonb_typeof(v_limits -> 'maximumRelativeDelta') = 'string'
    and v_limits ->> 'maximumRelativeDelta' ~ v_decimal and (v_limits ->> 'maximumRelativeDelta')::numeric > 0
    and jsonb_typeof(v_limits -> 'maximumAbsoluteDeltaByCurrency') = 'array', false) then
    raise exception 'invalid MCP delegation limits' using errcode = '22023';
  end if;
  for v_profile in select value from jsonb_array_elements(v -> 'profiles') loop
    if not coalesce(app.sp_write_exact_json_keys(v_profile, array['profileId','currencyCode'])
      and v_profile ->> 'profileId' ~ v_uuid
      and v_profile ->> 'profileId' collate "C" > v_previous collate "C"
      and v_profile ->> 'currencyCode' ~ '^[A-Z]{3}$', false) then
      raise exception 'invalid or unsorted delegation profile' using errcode = '22023';
    end if;
    perform 1 from public.ad_profiles where org_id = v_org and id = (v_profile ->> 'profileId')::uuid
      and currency_code = v_profile ->> 'currencyCode' for share;
    if not found then raise exception 'delegation profile unavailable' using errcode = '42501'; end if;
    v_profiles := array_append(v_profiles, (v_profile ->> 'profileId')::uuid);
    v_currencies := array_append(v_currencies, v_profile ->> 'currencyCode');
    v_previous := v_profile ->> 'profileId';
  end loop;
  v_previous := '';
  for v_amount in select value from jsonb_array_elements(v_limits -> 'maximumAbsoluteDeltaByCurrency') loop
    if not coalesce(app.sp_write_exact_json_keys(v_amount, array['amount','currencyCode'])
      and jsonb_typeof(v_amount -> 'amount') = 'string' and v_amount ->> 'amount' ~ v_decimal
      and (v_amount ->> 'amount')::numeric > 0 and v_amount ->> 'currencyCode' ~ '^[A-Z]{3}$'
      and v_amount ->> 'currencyCode' collate "C" > v_previous collate "C", false) then
      raise exception 'invalid or unsorted delegation currency limit' using errcode = '22023';
    end if;
    v_money_currencies := array_append(v_money_currencies, v_amount ->> 'currencyCode');
    v_previous := v_amount ->> 'currencyCode';
  end loop;
  if v_money_currencies is distinct from app.sp_write_canonical_text_array(v_currencies) then
    raise exception 'delegation currency limits do not match profiles' using errcode = '22023';
  end if;
  if not coalesce(jsonb_typeof(v -> 'issuedAt') = 'string' and jsonb_typeof(v -> 'expiresAt') = 'string'
    and v ->> 'issuedAt' ~ v_instant and v ->> 'expiresAt' ~ v_instant, false) then
    raise exception 'invalid delegation time' using errcode = '22023';
  end if;
  v_issued := (v ->> 'issuedAt')::timestamptz; v_expiry := (v ->> 'expiresAt')::timestamptz;
  v_now := clock_timestamp();
  if v_issued > v_now or v_expiry <= v_now or v_expiry > v_issued + interval '2160 hours' then
    raise exception 'delegation is not current or exceeds key lifetime' using errcode = '22023';
  end if;
  -- Match the shared serializer's field order and JSON string escaping. Semantic
  -- JSON equality alone admits hashes the runtime cannot verify after reload.
  select '[' || string_agg(format('{"profileId":%s,"currencyCode":%s}',
    to_json(value ->> 'profileId')::text, to_json(value ->> 'currencyCode')::text), ',' order by ordinality) || ']'
    into v_profile_json from jsonb_array_elements(v -> 'profiles') with ordinality;
  select '[' || string_agg(format('{"amount":%s,"currencyCode":%s}',
    to_json(value ->> 'amount')::text, to_json(value ->> 'currencyCode')::text), ',' order by ordinality) || ']'
    into v_money_json from jsonb_array_elements(v_limits -> 'maximumAbsoluteDeltaByCurrency') with ordinality;
  v_canonical_preimage := format(
    '["openspell.mcp-write-delegation-fingerprint.v1",{"schemaVersion":"openspell.mcp-write-delegation.v1","versionId":%s,"keyId":%s,"keyLabel":%s,"orgId":%s,"issuerUserId":%s,"profiles":%s,"issuedAt":%s,"expiresAt":%s,"limits":{"action":"keyword.bid","maximumRowsPerCall":%s,"maximumRowsPerUtcDay":%s,"maximumAbsoluteDeltaByCurrency":%s,"maximumRelativeDelta":%s}}]',
    to_json(v ->> 'versionId')::text, to_json(v ->> 'keyId')::text, to_json(v ->> 'keyLabel')::text,
    to_json(v ->> 'orgId')::text, to_json(v ->> 'issuerUserId')::text, v_profile_json,
    to_json(v ->> 'issuedAt')::text, to_json(v ->> 'expiresAt')::text,
    (v_limits ->> 'maximumRowsPerCall')::integer::text, (v_limits ->> 'maximumRowsPerUtcDay')::integer::text,
    v_money_json, to_json(v_limits ->> 'maximumRelativeDelta')::text
  );
  if p_fingerprint_preimage is distinct from v_canonical_preimage then
    raise exception 'MCP delegation fingerprint bytes are not canonical' using errcode = '22023';
  end if;
  insert into mcp.api_keys(id, org_id, label, key_prefix, token_hash, scope, profile_ids, expires_at, created_by, created_at)
    values(v_key, v_org, v ->> 'keyLabel', p_key_prefix, p_token_hash, 'write', v_profiles, v_expiry, v_actor, v_issued);
  get diagnostics v_count = row_count;
  if v_count <> 1 then raise exception 'MCP key count mismatch' using errcode = '55000'; end if;
  insert into mcp.write_delegations(version_id, org_id, key_id, issuer_user_id, issued_at, expires_at,
    artifact_text, artifact, fingerprint_preimage, fingerprint)
    values(v_version, v_org, v_key, v_actor, v_issued, v_expiry, p_delegation_text, v, p_fingerprint_preimage, v ->> 'fingerprint');
  get diagnostics v_count = row_count;
  if v_count <> 1 then raise exception 'MCP delegation count mismatch' using errcode = '55000'; end if;
  insert into public.audit_log(org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
    values(v_org, 'user', v_actor::text, 'mcp.write_key.issued', 'mcp_key', v_key::text,
      jsonb_build_object('delegation',v), 'web');
  get diagnostics v_count = row_count;
  if v_count <> 1 then raise exception 'MCP issuance audit count mismatch' using errcode = '55000'; end if;
  return v;
end;
$$;
revoke all on function app.issue_mcp_write_key_v1(text,text,text,text) from public, anon, service_role;
grant execute on function app.issue_mcp_write_key_v1(text,text,text,text) to authenticated;

create function app.revoke_mcp_key_v1(p_org_id uuid, p_key_id uuid)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, app, auth, mcp, pg_temp as $$
declare v_actor uuid := auth.uid(); v_key mcp.api_keys%rowtype; v_count integer;
begin
  perform 1 from public.orgs where id = p_org_id for key share;
  perform 1 from public.org_members where org_id = p_org_id and user_id = v_actor
    and role in ('owner','admin') for share;
  if not found then raise exception 'operator membership required' using errcode = '42501'; end if;
  select * into v_key from mcp.api_keys where org_id = p_org_id and id = p_key_id for update;
  if not found then return false; end if;
  if v_key.revoked_at is not null then return true; end if;
  update mcp.api_keys set revoked_at = clock_timestamp() where id = p_key_id;
  get diagnostics v_count = row_count;
  if v_count <> 1 then raise exception 'MCP revoke key count mismatch' using errcode = '55000'; end if;
  insert into public.audit_log(org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
    values(p_org_id, 'user', v_actor::text, 'mcp.key.revoked', 'mcp_key', p_key_id::text,
      jsonb_build_object('scope',v_key.scope), 'web');
  get diagnostics v_count = row_count;
  if v_count <> 1 then raise exception 'MCP revoke audit count mismatch' using errcode = '55000'; end if;
  return true;
end;
$$;
revoke all on function app.revoke_mcp_key_v1(uuid,uuid) from public, anon, service_role;
grant execute on function app.revoke_mcp_key_v1(uuid,uuid) to authenticated;
revoke all on function app.guard_mcp_write_key() from public, anon, authenticated, service_role;
