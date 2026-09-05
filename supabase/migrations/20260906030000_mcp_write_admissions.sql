-- WP-217 atomic delegated admission and counted refusal. No runtime activation.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

create table mcp.write_gate_versions (
  version_id uuid primary key,
  enabled boolean not null,
  created_at timestamptz not null default clock_timestamp()
);
create table mcp.write_gate_head (
  singleton boolean primary key default true check (singleton),
  version_id uuid not null references mcp.write_gate_versions(version_id)
);
alter table mcp.write_gate_versions enable row level security;
alter table mcp.write_gate_head enable row level security;
revoke all on mcp.write_gate_versions,mcp.write_gate_head from public,anon,authenticated,service_role;
grant select on mcp.write_gate_versions,mcp.write_gate_head to service_role;
create trigger mcp_write_gate_versions_immutable before update or delete on mcp.write_gate_versions
  for each row execute function app.reject_sp_write_evidence_change();
create trigger mcp_write_gate_versions_no_truncate before truncate on mcp.write_gate_versions
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger mcp_write_gate_head_no_truncate before truncate on mcp.write_gate_head
  for each statement execute function app.reject_sp_write_evidence_truncate();

create table mcp.write_admissions (
  org_id uuid not null references public.orgs(id) on delete cascade,
  key_id uuid not null,
  mcp_request_id uuid not null,
  profile_id uuid not null,
  plan_id uuid not null unique,
  plan_fingerprint text not null,
  delegation_version_id uuid not null,
  approval_request_id uuid not null unique,
  approval_id uuid not null unique,
  execution_id uuid not null,
  generation uuid not null,
  mcp_gate_version_id uuid not null references mcp.write_gate_versions(version_id),
  reservation_id uuid not null unique,
  reservation_day date not null,
  reserved_rows integer not null check (reserved_rows between 1 and 500),
  admitted_at timestamptz not null,
  request_text text not null,
  request jsonb not null,
  request_preimage text not null,
  request_fingerprint text not null,
  primary key (org_id,key_id,mcp_request_id),
  constraint write_admissions_preview_fkey foreign key (org_id,profile_id,plan_id)
    references mcp.write_previews(org_id,profile_id,plan_id) on delete cascade,
  constraint write_admissions_delegation_fkey foreign key (org_id,key_id,delegation_version_id)
    references mcp.write_delegations(org_id,key_id,version_id) on delete cascade,
  constraint write_admissions_receipt_fkey foreign key (org_id,profile_id,execution_id,plan_id,approval_id,generation)
    references public.sp_write_authorization_receipts(org_id,profile_id,execution_id,plan_id,approval_id,generation)
    on delete cascade deferrable initially deferred,
  constraint write_admissions_request_fkey foreign key (org_id,profile_id,approval_request_id)
    references public.sp_write_approval_requests(org_id,profile_id,approval_request_id)
    on delete cascade deferrable initially deferred,
  constraint write_admissions_shape check (coalesce(
    reservation_day = (admitted_at at time zone 'UTC')::date
    and request = request_text::jsonb
    and request_fingerprint = app.sp_write_sha256(request_preimage)
    and request_preimage::jsonb = jsonb_build_array('openspell.mcp-bid-apply-request.v1',request)
    and request ->> 'requestId' = mcp_request_id::text and request ->> 'profileId' = profile_id::text
    and request ->> 'planId' = plan_id::text and request ->> 'planFingerprint' = plan_fingerprint,false))
);
create index write_admissions_daily_rows_idx on mcp.write_admissions(org_id,key_id,reservation_day);
alter table mcp.write_admissions enable row level security;
revoke all on mcp.write_admissions from public,anon,authenticated,service_role;
grant select on mcp.write_admissions to service_role;
create trigger write_admissions_immutable before update or delete on mcp.write_admissions
  for each row execute function app.reject_sp_write_evidence_change();
create trigger write_admissions_no_truncate before truncate on mcp.write_admissions
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger audit_log_mcp_admission_immutable before update or delete on public.audit_log
  for each row when (old.action = 'mcp.bid_apply.admitted')
  execute function app.reject_sp_write_evidence_change();
-- Generic audit INSERT/UPDATE remains available for existing callers, but it
-- cannot fabricate this authoritative event or poison exact replay counts.
create function app.guard_mcp_admission_audit_writer()
returns trigger language plpgsql set search_path = pg_catalog,pg_temp as $$
begin
  if current_user <> pg_get_userbyid((select relowner from pg_class where oid = 'mcp.write_admissions'::regclass)) then
    raise exception 'MCP admission audit requires its controlled writer' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function app.guard_mcp_admission_audit_writer() from public,anon,authenticated,service_role;
create trigger audit_log_mcp_admission_writer before insert or update on public.audit_log
  for each row when (new.action = 'mcp.bid_apply.admitted')
  execute function app.guard_mcp_admission_audit_writer();

alter table public.sp_write_approval_requests drop constraint sp_write_approval_requests_mode;
alter table public.sp_write_approval_requests add constraint sp_write_approval_requests_mode check (
  (confirmation_version = 'openspell.amazon-sp-write-confirmation.v1' and (
    (approval_mode = 'manual' and bounded_authorization_id is null and inverse_plan_id is null)
    or (approval_mode = 'bounded_live_test' and bounded_authorization_id is not null and inverse_plan_id is not null)))
  or (confirmation_version = 'openspell.mcp-delegated-bid-admission.v1' and approval_mode = 'delegated_mcp'
    and bounded_authorization_id is null and inverse_plan_id is null)
);
alter table public.sp_write_authorization_receipts drop constraint sp_write_authorization_receipts_shape;
alter table public.sp_write_authorization_receipts add constraint sp_write_authorization_receipts_shape check (
  approved_at < expires_at and gate_snapshot_fingerprint ~ '^[a-f0-9]{64}$' and (
    (approval_mode = 'manual' and bounded_authorization_id is null and inverse_plan_id is null)
    or (approval_mode = 'bounded_live_test' and bounded_authorization_id is not null and inverse_plan_id is not null)
    or (approval_mode = 'delegated_mcp' and bounded_authorization_id is null and inverse_plan_id is null
      and coalesce(artifact ->> 'schemaVersion' = 'openspell.sp-write-authorization-receipt.v2',false)))
);

create function app.mcp_apply_request_preimage(p_request jsonb)
returns text language plpgsql immutable set search_path = pg_catalog,app,pg_temp as $$
begin
  if not coalesce(app.sp_write_exact_json_keys(p_request,array['requestId','profileId','planId','planFingerprint']),false) then
    raise exception 'MCP apply request shape is invalid' using errcode = '22023';
  end if;
  return '["openspell.mcp-bid-apply-request.v1",{"requestId":' || app.mcp_keyword_preview_json(p_request -> 'requestId','uuid')
    || ',"profileId":' || app.mcp_keyword_preview_json(p_request -> 'profileId','uuid')
    || ',"planId":' || app.mcp_keyword_preview_json(p_request -> 'planId','uuid')
    || ',"planFingerprint":' || app.mcp_keyword_preview_json(p_request -> 'planFingerprint','sha256') || '}]';
end;
$$;
revoke all on function app.mcp_apply_request_preimage(jsonb) from public,anon,authenticated,service_role;

-- Read authority deliberately excludes issuer role and current execution gates.
-- This helper is a terminal read branch: never upgrade its key lock to UPDATE.
create function app.assert_mcp_write_read_authority(p_org uuid,p_key uuid,p_hash text,p_profile uuid)
returns void language plpgsql set search_path = pg_catalog,public,app,mcp,pg_temp as $$
declare v_key mcp.api_keys%rowtype; v_delegation mcp.write_delegations%rowtype; v_now timestamptz;
begin
  perform 1 from public.orgs where id = p_org for key share;
  if not found then raise exception 'MCP read authority unavailable' using errcode = '42501'; end if;
  select * into v_key from mcp.api_keys where org_id = p_org and id = p_key for share;
  select * into v_delegation from mcp.write_delegations where org_id = p_org and key_id = p_key;
  v_now := clock_timestamp();
  if v_key.id is null or v_delegation.version_id is null or v_key.scope <> 'write'
    or v_key.token_hash is distinct from p_hash or v_key.revoked_at is not null
    or v_key.created_by is distinct from v_delegation.issuer_user_id
    or v_key.expires_at is distinct from v_delegation.expires_at
    or v_delegation.issued_at > v_now or v_delegation.expires_at <= v_now
    or not coalesce(p_profile = any(v_key.profile_ids),false)
    or not exists(select 1 from jsonb_array_elements(v_delegation.artifact -> 'profiles') p
      where p ->> 'profileId' = p_profile::text) then
    raise exception 'MCP read authority unavailable' using errcode = '42501';
  end if;
end;
$$;
revoke all on function app.assert_mcp_write_read_authority(uuid,uuid,text,uuid) from public,anon,authenticated,service_role;

create function app.mcp_write_read_context(p_org uuid,p_key uuid,p_hash text,p_profile uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog,public,app,mcp,pg_temp as $$
declare v_delegation jsonb; v_now timestamptz; v_day date; v_reserved bigint;
begin
  perform app.assert_service_role('mcp_write_read_context');
  perform app.assert_mcp_write_read_authority(p_org,p_key,p_hash,p_profile);
  select artifact into strict v_delegation from mcp.write_delegations where org_id = p_org and key_id = p_key;
  v_now := clock_timestamp(); v_day := (v_now at time zone 'UTC')::date;
  select coalesce(sum(reserved_rows::bigint),0) into v_reserved from mcp.write_admissions
    where org_id = p_org and key_id = p_key and reservation_day = v_day;
  return jsonb_build_object('delegation',v_delegation,'now',app.sp_write_instant(v_now),
    'dailyRows',jsonb_build_object('day',v_day::text,'reserved',v_reserved,
      'maximum',(v_delegation #>> '{limits,maximumRowsPerUtcDay}')::integer));
end;
$$;
revoke all on function app.mcp_write_read_context(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function app.mcp_write_read_context(uuid,uuid,text,uuid) to service_role;

-- Shares the existing stored-source assertions; no simulated operator session.
create function app.assert_mcp_admission_source(p_plan_id uuid)
returns void language plpgsql set search_path = pg_catalog,public,app,pg_temp as $$
declare v_plan public.sp_write_plans%rowtype; v_evidence public.sp_write_preview_evidence%rowtype;
  v_action jsonb; v_keyword public.keywords%rowtype; v_count integer := 0;
begin
  select * into strict v_plan from public.sp_write_plans where plan_id = p_plan_id;
  if v_plan.direction = 'forward' then
    select * into strict v_evidence from public.sp_write_preview_evidence
      where org_id = v_plan.org_id and profile_id = v_plan.profile_id and plan_id = p_plan_id;
    perform app.assert_sp_write_preview_source(v_plan.artifact_text,v_plan.fingerprint_preimage,
      v_evidence.artifact_text,v_evidence.guardrail_preimage,v_evidence.provenance_preimage);
    return;
  end if;
  if not exists(select 1 from public.sp_write_preview_evidence e join public.sp_write_plans p on p.plan_id = e.plan_id
    where p.org_id = v_plan.org_id and p.profile_id = v_plan.profile_id and p.plan_id = v_plan.source_plan_id
      and p.fingerprint = v_plan.source_plan_fingerprint and p.direction = 'forward'
      and p.artifact -> 'providerScope' = v_plan.artifact -> 'providerScope' and p.artifact -> 'counts' = v_plan.artifact -> 'counts')
    or not app.sp_write_inverse_pair_exact(v_plan.source_plan_id,p_plan_id)
    or (select count(*) from public.sp_write_observations where org_id = v_plan.org_id and profile_id = v_plan.profile_id
      and execution_id = v_plan.source_execution_id and plan_id = v_plan.source_plan_id and outcome = 'observed_requested') <> v_plan.provider_rows then
    raise exception 'MCP inverse source is not completely observed' using errcode = '55000';
  end if;
  for v_action in select value from jsonb_array_elements(v_plan.artifact -> 'actions') loop
    if v_action ->> 'routeKey' is distinct from 'sp.v3.keywords.update'
      or not coalesce(app.sp_write_exact_json_keys(v_action -> 'changes',array['bid']),false) then
      raise exception 'MCP inverse action is unsupported' using errcode = '22023';
    end if;
    select * into strict v_keyword from public.keywords where org_id = v_plan.org_id and profile_id = v_plan.profile_id
      and amazon_id = v_action #>> '{entity,keywordId}' and ad_product = 'SP' and deleted_at is null and state in ('enabled','paused') for share;
    if v_keyword.bid is distinct from (v_action #>> '{changes,bid,expected,amount}')::numeric then
      raise exception 'MCP inverse mirror changed' using errcode = '55000';
    end if;
    v_count := v_count + 1;
  end loop;
  if v_count <> v_plan.provider_rows then raise exception 'MCP inverse count mismatch' using errcode = '22023'; end if;
end;
$$;
revoke all on function app.assert_mcp_admission_source(uuid) from public,anon,authenticated,service_role;

create function app.mcp_admission_receipt(
  p_a mcp.write_admissions,p_r public.sp_write_authorization_receipts,p_plan jsonb,p_delegation jsonb
) returns jsonb language plpgsql immutable set search_path = pg_catalog,app,pg_temp as $$
declare v_gate_preimage text := app.sp_write_gate_snapshot_preimage(
  p_r.environment_gate_version,p_r.profile_grant_id,p_r.profile_grant_version,p_a.admitted_at);
begin
  if date_trunc('milliseconds',p_a.admitted_at) >= date_trunc('milliseconds',
    least((p_plan ->> 'expiresAt')::timestamptz,(p_delegation ->> 'expiresAt')::timestamptz)) then
    raise exception 'MCP receipt window is empty at contract precision' using errcode = '22023';
  end if;
  return jsonb_build_object('schemaVersion','openspell.sp-write-authorization-receipt.v2',
    'approvalId',p_a.approval_id,'approvalRequestId',p_a.approval_request_id,'mcpRequestId',p_a.mcp_request_id,
    'executionId',p_a.execution_id,'generation',p_a.generation,'approvalMode','delegated_mcp',
    'plan',app.sp_write_plan_binding(p_plan),'preapprovedInversePlan',null,'boundedAuthorization',null,
    'approvedBy',p_delegation -> 'issuerUserId','approvedAt',app.sp_write_instant(p_a.admitted_at),
    'expiresAt',app.sp_write_instant(least((p_plan ->> 'expiresAt')::timestamptz,(p_delegation ->> 'expiresAt')::timestamptz)),
    'confirmationVersion','openspell.mcp-delegated-bid-admission.v1',
    'gateSnapshot',jsonb_build_object('environmentGate','enabled','environmentGateVersion',p_r.environment_gate_version,
      'profileGrantId',p_r.profile_grant_id,'profileGrantVersion',p_r.profile_grant_version,
      'gateSnapshotFingerprint',app.sp_write_sha256(v_gate_preimage),'checkedAt',app.sp_write_instant(p_a.admitted_at)),
    'mcpGate',jsonb_build_object('versionId',p_a.mcp_gate_version_id,'enabled',true,'checkedAt',app.sp_write_instant(p_a.admitted_at)),
    'delegation',p_delegation,'reservation',jsonb_build_object('id',p_a.reservation_id,'day',p_a.reservation_day::text,
      'rows',p_a.reserved_rows,'releasedRows',0));
end;
$$;
create function app.mcp_admission_audit_payload(p_a mcp.write_admissions,p_issuer uuid)
returns jsonb language sql immutable set search_path = pg_catalog,pg_temp as $$
  select jsonb_build_object('requestId',(p_a).mcp_request_id,'issuerUserId',p_issuer,
    'delegationVersionId',(p_a).delegation_version_id,'profileId',(p_a).profile_id,
    'reservationId',(p_a).reservation_id,'reservationDay',(p_a).reservation_day::text,'rows',(p_a).reserved_rows,
    'approvalId',(p_a).approval_id,'approvalRequestId',(p_a).approval_request_id,
    'executionId',(p_a).execution_id,'generation',(p_a).generation);
$$;
revoke all on function app.mcp_admission_receipt(mcp.write_admissions,public.sp_write_authorization_receipts,jsonb,jsonb),
  app.mcp_admission_audit_payload(mcp.write_admissions,uuid) from public,anon,authenticated,service_role;

create function app.admit_mcp_sp_write_v1(p_org uuid,p_key uuid,p_hash text,p_request_text text)
returns jsonb language plpgsql security definer set search_path = pg_catalog,public,app,mcp,pg_temp as $$
declare
  v_request jsonb := p_request_text::jsonb; v_preimage text;
  v_plan public.sp_write_plans%rowtype; v_preview mcp.write_previews%rowtype;
  v_delegation mcp.write_delegations%rowtype; v_key mcp.api_keys%rowtype;
  v_environment public.sp_write_environment_gate_versions%rowtype;
  v_grant public.sp_write_profile_grant_versions%rowtype; v_gate mcp.write_gate_versions%rowtype;
  v_profile public.ad_profiles%rowtype; v_connection public.ads_connections%rowtype;
  v_prior mcp.write_admissions%rowtype; v_a mcp.write_admissions%rowtype;
  v_r public.sp_write_authorization_receipts%rowtype;
  v_now timestamptz; v_used bigint; v_maximum bigint; v_request_artifact jsonb; v_count integer;
begin
  perform app.assert_service_role('admit_mcp_sp_write_v1');
  -- The key lock serializes immutable UTC charges, but cannot refresh a caller's
  -- repeatable-read snapshot. Every SUM below must see the previous lock owner's
  -- committed admission, including callers that invoke this RPC directly.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'MCP admission requires read committed isolation' using errcode = '25001';
  end if;
  v_preimage := app.mcp_apply_request_preimage(v_request);
  -- This read only avoids doing lock work for a plainly wrong bearer; authority
  -- is rechecked under the appropriate SHARE or UPDATE key lock below.
  if not exists(select 1 from mcp.api_keys where org_id = p_org and id = p_key and token_hash = p_hash and scope = 'write') then
    raise exception 'MCP admission authority unavailable' using errcode = '42501';
  end if;
  perform 1 from public.orgs where id = p_org for key share;
  if not found then raise exception 'MCP admission tenant unavailable' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('openspell.mcp-admission:' || p_org::text || ':' || p_key::text || ':' || (v_request ->> 'requestId'),0));
  select * into v_prior from mcp.write_admissions where org_id = p_org and key_id = p_key
    and mcp_request_id = (v_request ->> 'requestId')::uuid;
  if found then
    perform app.assert_mcp_write_read_authority(p_org,p_key,p_hash,(v_request ->> 'profileId')::uuid);
    if v_prior.request is distinct from v_request then
      raise exception 'MCP admission request identity conflict' using errcode = '23505';
    end if;
    perform app.assert_mcp_admission_closed(v_prior.approval_id);
    select artifact into strict v_request_artifact from public.sp_write_authorization_receipts where approval_id = v_prior.approval_id;
    return v_request_artifact;
  end if;
  select * into v_preview from mcp.write_previews where org_id = p_org and key_id = p_key
    and profile_id = (v_request ->> 'profileId')::uuid and plan_id = (v_request ->> 'planId')::uuid;
  if not found then raise exception 'MCP preview is not owned by this key' using errcode = '42501'; end if;
  select * into strict v_plan from public.sp_write_plans where org_id = p_org and profile_id = v_preview.profile_id and plan_id = v_preview.plan_id;
  if v_plan.fingerprint is distinct from v_request ->> 'planFingerprint' then
    raise exception 'MCP apply plan fingerprint differs' using errcode = '22023';
  end if;
  select * into strict v_delegation from mcp.write_delegations where org_id = p_org and key_id = p_key
    and version_id = v_preview.delegation_version_id;
  perform 1 from public.org_members where org_id = p_org and user_id = v_delegation.issuer_user_id
    and role in ('owner','admin') for share;
  if not found then raise exception 'MCP issuer is no longer an operator' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('openspell.sp-write-approval:' || v_plan.plan_id::text,0));
  if exists(select 1 from public.sp_write_authorization_receipts where org_id = p_org and profile_id = v_plan.profile_id and plan_id = v_plan.plan_id) then
    raise exception 'MCP plan already has an admission identity' using errcode = '23505';
  end if;
  select v.* into v_environment from public.sp_write_environment_gate_head h
    join public.sp_write_environment_gate_versions v on v.version_id = h.version_id where h.singleton for update of h,v;
  if not found or not v_environment.enabled then raise exception 'MCP environment gate is closed' using errcode = '42501'; end if;
  select v.* into v_grant from public.sp_write_profile_grant_heads h
    join public.sp_write_profile_grant_versions v on v.org_id = h.org_id and v.profile_id = h.profile_id
      and v.grant_id = h.grant_id and v.version_id = h.version_id
    where h.org_id = p_org and h.profile_id = v_plan.profile_id for update of h,v;
  if not found or not v_grant.enabled or v_grant.amazon_profile_id <> v_plan.amazon_profile_id
    or v_grant.connection_id <> v_plan.connection_id or v_grant.region <> v_plan.region
    or v_grant.marketplace_id <> v_plan.marketplace_id or v_grant.currency_code <> v_plan.currency_code
    or v_grant.api_dialect <> v_plan.api_dialect then
    raise exception 'MCP profile grant is closed or changed' using errcode = '42501';
  end if;
  select v.* into v_gate from mcp.write_gate_head h join mcp.write_gate_versions v on v.version_id = h.version_id
    where h.singleton for share of h,v;
  if not found or not v_gate.enabled then raise exception 'MCP write gate is closed' using errcode = '42501'; end if;
  select * into v_profile from public.ad_profiles where org_id = p_org and id = v_plan.profile_id for update;
  select * into v_connection from public.ads_connections where org_id = p_org and id = v_profile.connection_id for update;
  if v_profile.id is null or not v_profile.sync_enabled or v_connection.id is null or v_connection.status <> 'active'
    or v_profile.connection_id <> v_plan.connection_id or v_profile.amazon_profile_id <> v_plan.amazon_profile_id
    or v_profile.region <> v_plan.region or v_profile.currency_code <> v_plan.currency_code then
    raise exception 'MCP profile routing changed' using errcode = '42501';
  end if;
  select * into v_key from mcp.api_keys where org_id = p_org and id = p_key for update;
  if v_key.id is null or v_key.scope <> 'write' or v_key.token_hash is distinct from p_hash or v_key.revoked_at is not null
    or v_key.created_by is distinct from v_delegation.issuer_user_id or v_key.expires_at is distinct from v_delegation.expires_at
    or not coalesce(v_plan.profile_id = any(v_key.profile_ids),false) then
    raise exception 'MCP key authority changed' using errcode = '42501';
  end if;
  perform app.assert_mcp_admission_source(v_plan.plan_id);
  perform app.assert_mcp_bid_plan_limits(v_plan.artifact,v_delegation.artifact);
  v_now := app.sp_write_instant(clock_timestamp())::timestamptz;
  if v_now < v_delegation.issued_at or v_now >= v_delegation.expires_at
    or v_now < v_plan.frozen_at or v_now >= v_plan.expires_at
    or date_trunc('milliseconds',v_now) >= date_trunc('milliseconds',least(v_plan.expires_at,v_delegation.expires_at)) then
    raise exception 'MCP admission authority expired' using errcode = '42501';
  end if;
  v_a.org_id := p_org; v_a.key_id := p_key; v_a.mcp_request_id := (v_request ->> 'requestId')::uuid;
  v_a.profile_id := v_plan.profile_id; v_a.plan_id := v_plan.plan_id; v_a.plan_fingerprint := v_plan.fingerprint;
  v_a.delegation_version_id := v_delegation.version_id; v_a.approval_request_id := gen_random_uuid();
  v_a.approval_id := gen_random_uuid(); v_a.generation := gen_random_uuid();
  v_a.mcp_gate_version_id := v_gate.version_id; v_a.reservation_id := gen_random_uuid();
  v_a.reservation_day := (v_now at time zone 'UTC')::date; v_a.reserved_rows := v_plan.provider_rows; v_a.admitted_at := v_now;
  v_a.request_text := p_request_text; v_a.request := v_request; v_a.request_preimage := v_preimage; v_a.request_fingerprint := app.sp_write_sha256(v_preimage);
  select coalesce(sum(reserved_rows::bigint),0) into v_used from mcp.write_admissions
    where org_id = p_org and key_id = p_key and reservation_day = v_a.reservation_day;
  v_maximum := (v_delegation.artifact #>> '{limits,maximumRowsPerUtcDay}')::bigint;
  if v_used > v_maximum - v_a.reserved_rows then raise exception 'MCP daily row capacity exhausted' using errcode = '42501'; end if;
  if v_plan.direction = 'forward' then
    v_a.execution_id := gen_random_uuid();
    insert into public.sp_write_execution_cycles(execution_id,org_id,profile_id,bounded_authorization_id,created_at)
      values(v_a.execution_id,p_org,v_plan.profile_id,null,v_now);
  else
    v_a.execution_id := v_plan.source_execution_id;
    if not exists(select 1 from public.sp_write_cycle_plans where org_id = p_org and profile_id = v_plan.profile_id
      and execution_id = v_a.execution_id and plan_id = v_plan.source_plan_id and direction = 'forward') then
      raise exception 'MCP inverse does not join its source cycle' using errcode = '22023';
    end if;
  end if;
  v_r.environment_gate_version := v_environment.version_id; v_r.profile_grant_id := v_grant.grant_id; v_r.profile_grant_version := v_grant.version_id;
  v_r.artifact := app.mcp_admission_receipt(v_a,v_r,v_plan.artifact,v_delegation.artifact);
  v_request_artifact := jsonb_build_object('approvalRequestId',v_a.approval_request_id,'mcpRequestId',v_a.mcp_request_id,
    'plan',app.sp_write_plan_binding(v_plan.artifact),'approvalMode','delegated_mcp',
    'confirmationVersion','openspell.mcp-delegated-bid-admission.v1','boundedAuthorization',null,'preapprovedInversePlan',null);
  insert into public.sp_write_approval_requests(approval_request_id,org_id,profile_id,plan_id,plan_fingerprint,approval_mode,
    artifact_text,artifact,bounded_authorization_id,inverse_plan_id,confirmation_version,persisted_at)
    values(v_a.approval_request_id,p_org,v_plan.profile_id,v_plan.plan_id,v_plan.fingerprint,'delegated_mcp',
      v_request_artifact::text,v_request_artifact,null,null,'openspell.mcp-delegated-bid-admission.v1',v_now);
  insert into public.sp_write_authorization_receipts(approval_id,org_id,profile_id,execution_id,approval_request_id,plan_id,
    inverse_plan_id,bounded_authorization_id,generation,approval_mode,artifact_text,artifact,approved_by,approved_at,expires_at,
    environment_gate_version,profile_grant_id,profile_grant_version,gate_snapshot_preimage,gate_snapshot_fingerprint,persisted_at)
    values(v_a.approval_id,p_org,v_plan.profile_id,v_a.execution_id,v_a.approval_request_id,v_plan.plan_id,null,null,
      v_a.generation,'delegated_mcp',v_r.artifact::text,v_r.artifact,v_delegation.issuer_user_id,v_now,
      least(v_plan.expires_at,v_delegation.expires_at),v_environment.version_id,v_grant.grant_id,v_grant.version_id,
      app.sp_write_gate_snapshot_preimage(v_environment.version_id,v_grant.grant_id,v_grant.version_id,v_now),
      v_r.artifact #>> '{gateSnapshot,gateSnapshotFingerprint}',v_now);
  insert into public.sp_write_cycle_plans(org_id,profile_id,execution_id,plan_id,receipt_plan_id,approval_id,generation,direction,bound_at)
    values(p_org,v_plan.profile_id,v_a.execution_id,v_plan.plan_id,v_plan.plan_id,v_a.approval_id,v_a.generation,v_plan.direction,v_now);
  insert into mcp.write_admissions select (v_a).*;
  insert into public.audit_log(org_id,actor_type,actor_id,action,target_type,target_id,payload,source)
    values(p_org,'mcp',p_key::text,'mcp.bid_apply.admitted','sp_write_plan',v_plan.plan_id::text,
      app.mcp_admission_audit_payload(v_a,v_delegation.issuer_user_id),'mcp');
  get diagnostics v_count = row_count;
  if v_count <> 1 then raise exception 'MCP admission audit count mismatch' using errcode = '55000'; end if;
  perform app.start_sp_write_execution(v_a.approval_id,v_plan.plan_id);
  perform app.assert_mcp_admission_closed(v_a.approval_id);
  return v_r.artifact;
end;
$$;
revoke all on function app.admit_mcp_sp_write_v1(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function app.admit_mcp_sp_write_v1(uuid,uuid,text,text) to service_role;

-- One immutable row is both request recovery identity and permanent UTC charge.
-- This assertion reads historical facts, never today's membership or gate heads.
create function app.assert_mcp_admission_closed(p_approval uuid)
returns void language plpgsql stable set search_path = pg_catalog,public,app,mcp,pg_temp as $$
declare
  v_a mcp.write_admissions%rowtype; v_r public.sp_write_authorization_receipts%rowtype;
  v_p public.sp_write_plans%rowtype; v_d mcp.write_delegations%rowtype;
  v_q public.sp_write_approval_requests%rowtype; v_expected_request jsonb;
begin
  select * into v_a from mcp.write_admissions where approval_id = p_approval;
  select * into v_r from public.sp_write_authorization_receipts where approval_id = p_approval;
  if v_a.approval_id is null or v_r.approval_id is null then
    raise exception 'delegated receipt or capacity charge missing' using errcode = '23514';
  end if;
  select * into strict v_p from public.sp_write_plans where org_id = v_a.org_id and profile_id = v_a.profile_id and plan_id = v_a.plan_id;
  select * into strict v_d from mcp.write_delegations where org_id = v_a.org_id and key_id = v_a.key_id and version_id = v_a.delegation_version_id;
  select * into strict v_q from public.sp_write_approval_requests where approval_request_id = v_a.approval_request_id;
  v_expected_request := jsonb_build_object('approvalRequestId',v_a.approval_request_id,'mcpRequestId',v_a.mcp_request_id,
    'plan',app.sp_write_plan_binding(v_p.artifact),'approvalMode','delegated_mcp',
    'confirmationVersion','openspell.mcp-delegated-bid-admission.v1','boundedAuthorization',null,'preapprovedInversePlan',null);
  if v_r.approval_mode <> 'delegated_mcp' or v_r.org_id <> v_a.org_id or v_r.profile_id <> v_a.profile_id
    or v_r.execution_id <> v_a.execution_id or v_r.plan_id <> v_a.plan_id or v_r.generation <> v_a.generation
    or v_r.approval_request_id <> v_a.approval_request_id or v_r.approved_by <> v_d.issuer_user_id
    or v_r.approved_at <> v_a.admitted_at or v_r.expires_at <> least(v_p.expires_at,v_d.expires_at)
    or v_r.inverse_plan_id is not null or v_r.bounded_authorization_id is not null
    or v_a.plan_fingerprint <> v_p.fingerprint or v_a.reserved_rows <> v_p.provider_rows
    or v_a.admitted_at < v_d.issued_at or v_a.admitted_at >= v_d.expires_at
    or v_a.admitted_at < v_p.frozen_at or v_a.admitted_at >= v_p.expires_at
    or v_a.request_preimage is distinct from app.mcp_apply_request_preimage(v_a.request)
    or v_a.reservation_day is distinct from (v_a.admitted_at at time zone 'UTC')::date
    or v_r.artifact is distinct from app.mcp_admission_receipt(v_a,v_r,v_p.artifact,v_d.artifact)
    or v_r.artifact_text::jsonb is distinct from v_r.artifact
    or v_r.gate_snapshot_preimage is distinct from app.sp_write_gate_snapshot_preimage(
      v_r.environment_gate_version,v_r.profile_grant_id,v_r.profile_grant_version,v_a.admitted_at)
    or v_r.gate_snapshot_fingerprint is distinct from app.sp_write_sha256(v_r.gate_snapshot_preimage)
    or v_q.artifact is distinct from v_expected_request or v_q.artifact_text::jsonb is distinct from v_expected_request
    or v_q.approval_mode <> 'delegated_mcp' or v_q.confirmation_version <> 'openspell.mcp-delegated-bid-admission.v1'
    or v_q.org_id <> v_a.org_id or v_q.profile_id <> v_a.profile_id or v_q.plan_id <> v_a.plan_id
    or v_q.plan_fingerprint <> v_a.plan_fingerprint
    or not exists(select 1 from mcp.write_previews where org_id = v_a.org_id and profile_id = v_a.profile_id
      and key_id = v_a.key_id and delegation_version_id = v_a.delegation_version_id and plan_id = v_a.plan_id)
    or not exists(select 1 from public.sp_write_environment_gate_versions where version_id = v_r.environment_gate_version and enabled)
    or not exists(select 1 from public.sp_write_profile_grant_versions where org_id = v_a.org_id and profile_id = v_a.profile_id
      and grant_id = v_r.profile_grant_id and version_id = v_r.profile_grant_version and enabled
      and amazon_profile_id = v_p.amazon_profile_id and connection_id = v_p.connection_id and region = v_p.region
      and marketplace_id = v_p.marketplace_id and currency_code = v_p.currency_code and api_dialect = v_p.api_dialect)
    or not exists(select 1 from mcp.write_gate_versions where version_id = v_a.mcp_gate_version_id and enabled)
    or (select coalesce(sum(reserved_rows::bigint),0) from mcp.write_admissions where org_id = v_a.org_id
      and key_id = v_a.key_id and reservation_day = v_a.reservation_day) > (v_d.artifact #>> '{limits,maximumRowsPerUtcDay}')::bigint then
    raise exception 'delegated admission facts disagree' using errcode = '23514';
  end if;
  perform app.assert_mcp_bid_plan_limits(v_p.artifact,v_d.artifact);
  if (select count(*) from public.sp_write_execution_requests where org_id = v_a.org_id and profile_id = v_a.profile_id
    and execution_id = v_a.execution_id and plan_id = v_a.plan_id and approval_id = v_a.approval_id and generation = v_a.generation) <> 1
    or (select count(*) from public.sp_write_outbox o join app.sp_write_outbox_delivery_heads h on h.outbox_id = o.outbox_id
      where o.org_id = v_a.org_id and o.profile_id = v_a.profile_id and o.execution_id = v_a.execution_id
        and o.plan_id = v_a.plan_id and o.approval_id = v_a.approval_id and o.generation = v_a.generation and o.kind = 'dispatch') <> 1
    or (select count(*) from public.audit_log where org_id = v_a.org_id and actor_type = 'mcp' and actor_id = v_a.key_id::text
      and action = 'mcp.bid_apply.admitted' and target_type = 'sp_write_plan' and target_id = v_a.plan_id::text
      and source = 'mcp' and payload = app.mcp_admission_audit_payload(v_a,v_d.issuer_user_id)) <> 1 then
    raise exception 'delegated admission queue or audit counts do not close' using errcode = '23514';
  end if;
end;
$$;
create function app.check_mcp_admission_closure()
returns trigger language plpgsql security definer set search_path = pg_catalog,public,app,mcp,pg_temp as $$
begin
  if exists(select 1 from public.orgs where id = new.org_id) then
    perform app.assert_mcp_admission_closed(new.approval_id);
  end if;
  return null;
end;
$$;
create constraint trigger mcp_admissions_closed after insert on mcp.write_admissions
  deferrable initially deferred for each row execute function app.check_mcp_admission_closure();
create constraint trigger mcp_receipts_closed after insert on public.sp_write_authorization_receipts
  deferrable initially deferred for each row when (new.approval_mode = 'delegated_mcp')
  execute function app.check_mcp_admission_closure();
revoke all on function app.assert_mcp_admission_closed(uuid),app.check_mcp_admission_closure()
  from public,anon,authenticated,service_role;

-- Called only after org/custody locks. It takes the complete authority prefix;
-- canonical reservation's original locks below are then reentrant. Dispatch
-- never upgrades the key SHARE lock or mutates the immutable admission charge.
create function app.lock_mcp_dispatch_authority(p_plan_id uuid,p_approval_id uuid)
returns public.sp_write_refusal_reason language plpgsql
set search_path = pg_catalog,public,app,mcp,pg_temp as $$
declare
  v_p public.sp_write_plans%rowtype; v_r public.sp_write_authorization_receipts%rowtype;
  v_a mcp.write_admissions%rowtype; v_d mcp.write_delegations%rowtype; v_key mcp.api_keys%rowtype;
  v_env public.sp_write_environment_gate_versions%rowtype; v_grant public.sp_write_profile_grant_versions%rowtype;
  v_gate mcp.write_gate_versions%rowtype; v_profile public.ad_profiles%rowtype; v_connection public.ads_connections%rowtype;
  v_member boolean; v_closed boolean := false;
begin
  select * into v_p from public.sp_write_plans where plan_id = p_plan_id;
  select * into v_r from public.sp_write_authorization_receipts where approval_id = p_approval_id;
  if v_r.approval_mode is distinct from 'delegated_mcp' then return null; end if;
  select * into v_a from mcp.write_admissions where approval_id = p_approval_id;
  select * into v_d from mcp.write_delegations where org_id = v_a.org_id and key_id = v_a.key_id and version_id = v_a.delegation_version_id;
  perform 1 from public.org_members where org_id = v_p.org_id and user_id = v_d.issuer_user_id and role in ('owner','admin') for share;
  v_member := found;
  select v.* into v_env from public.sp_write_environment_gate_head h
    join public.sp_write_environment_gate_versions v on v.version_id = h.version_id where h.singleton for update of h,v;
  select v.* into v_grant from public.sp_write_profile_grant_heads h
    join public.sp_write_profile_grant_versions v on v.org_id = h.org_id and v.profile_id = h.profile_id
      and v.grant_id = h.grant_id and v.version_id = h.version_id
    where h.org_id = v_p.org_id and h.profile_id = v_p.profile_id for update of h,v;
  select v.* into v_gate from mcp.write_gate_head h join mcp.write_gate_versions v on v.version_id = h.version_id
    where h.singleton for share of h,v;
  select * into v_profile from public.ad_profiles where org_id = v_p.org_id and id = v_p.profile_id for update;
  select * into v_connection from public.ads_connections where org_id = v_p.org_id and id = v_profile.connection_id for update;
  select * into v_key from mcp.api_keys where org_id = v_a.org_id and id = v_a.key_id for share;
  -- Corrupt/incomplete authority is a durable refusal, not a retrying exception.
  begin perform app.assert_mcp_admission_closed(p_approval_id); exception
    when check_violation or no_data_found or invalid_parameter_value or insufficient_privilege then v_closed := true;
  end;
  if v_env.version_id is null or not v_env.enabled or v_env.version_id <> v_r.environment_gate_version then
    return 'environment_gate_closed';
  end if;
  if v_grant.version_id is null or not v_grant.enabled or v_grant.grant_id <> v_r.profile_grant_id
    or v_grant.version_id <> v_r.profile_grant_version or v_grant.amazon_profile_id <> v_p.amazon_profile_id
    or v_grant.connection_id <> v_p.connection_id or v_grant.region <> v_p.region
    or v_grant.marketplace_id <> v_p.marketplace_id or v_grant.currency_code <> v_p.currency_code
    or v_grant.api_dialect <> v_p.api_dialect then return 'profile_gate_closed'; end if;
  if v_profile.id is null or not v_profile.sync_enabled or v_connection.id is null or v_connection.status <> 'active'
    or v_profile.connection_id <> v_p.connection_id or v_profile.amazon_profile_id <> v_p.amazon_profile_id
    or v_profile.region <> v_p.region or v_profile.currency_code <> v_p.currency_code then return 'route_mismatch'; end if;
  if v_closed or not v_member or v_a.approval_id is null or v_d.version_id is null or v_key.id is null
    or v_key.scope <> 'write' or v_key.revoked_at is not null or v_key.created_by is distinct from v_d.issuer_user_id
    or v_key.expires_at is distinct from v_d.expires_at or not coalesce(v_p.profile_id = any(v_key.profile_ids),false)
    or v_gate.version_id is null or not v_gate.enabled or v_gate.version_id <> v_a.mcp_gate_version_id then
    return 'authorization_revoked';
  end if;
  return null;
end;
$$;
revoke all on function app.lock_mcp_dispatch_authority(uuid,uuid) from public,anon,authenticated,service_role;

-- Provider-free terminalization before worker adapter/preflight. It only closes
-- unresolved delegated actions; committed intents/results retain their ownership.
create function app.refuse_invalid_mcp_write_for_claim(p_outbox_id uuid,p_claim_epoch bigint,p_claim_token uuid)
returns table(decision text,refused_rows integer,checked_at timestamptz)
language plpgsql security definer set search_path = pg_catalog,public,app,mcp,pg_temp as $$
declare
  v_o public.sp_write_outbox%rowtype; v_h app.sp_write_outbox_delivery_heads%rowtype;
  v_p public.sp_write_plans%rowtype; v_r public.sp_write_authorization_receipts%rowtype;
  v_reason public.sp_write_refusal_reason; v_action public.sp_write_plan_actions%rowtype;
  v_artifact jsonb; v_disposition uuid; v_offered integer; v_inserted integer := 0;
begin
  perform app.assert_service_role('refuse_invalid_mcp_write_for_claim');
  if p_outbox_id is null or p_claim_epoch is null or p_claim_epoch < 1 or p_claim_token is null then
    raise exception 'invalid MCP settlement claim' using errcode = '22023';
  end if;
  select * into v_o from public.sp_write_outbox where outbox_id = p_outbox_id;
  if not found then
    decision := 'stale_claim'; refused_rows := 0; checked_at := clock_timestamp(); return next; return;
  end if;
  perform 1 from public.orgs where id = v_o.org_id for key share;
  select * into v_h from app.sp_write_outbox_delivery_heads where outbox_id = p_outbox_id for update;
  checked_at := clock_timestamp();
  if v_h.outbox_id is null or v_h.state <> 'leased' or v_h.claim_epoch <> p_claim_epoch
    or v_h.token_digest <> app.sp_write_outbox_claim_token_digest(p_claim_token) or v_h.lease_expires_at <= checked_at then
    decision := 'stale_claim'; refused_rows := 0; return next; return;
  end if;
  if v_o.kind <> 'dispatch' then decision := 'unchanged'; refused_rows := 0; return next; return; end if;
  select * into strict v_r from public.sp_write_authorization_receipts where approval_id = v_o.approval_id;
  if v_r.approval_mode <> 'delegated_mcp' then decision := 'unchanged'; refused_rows := 0; return next; return; end if;
  select * into strict v_p from public.sp_write_plans where org_id = v_o.org_id and profile_id = v_o.profile_id and plan_id = v_o.plan_id;
  v_reason := app.lock_mcp_dispatch_authority(v_o.plan_id,v_o.approval_id);
  perform 1 from public.sp_write_cycle_plans where org_id = v_o.org_id and profile_id = v_o.profile_id
    and execution_id = v_o.execution_id and plan_id = v_o.plan_id and approval_id = v_o.approval_id and generation = v_o.generation for update;
  if not found then raise exception 'MCP settlement child mismatch' using errcode = '22023'; end if;
  select * into strict v_r from public.sp_write_authorization_receipts where approval_id = v_o.approval_id for update;
  checked_at := clock_timestamp();
  if v_h.lease_expires_at <= checked_at then
    decision := 'stale_claim'; refused_rows := 0; return next; return;
  end if;
  if checked_at >= v_r.expires_at or checked_at >= v_p.expires_at then v_reason := 'approval_expired'; end if;
  if v_reason is null then decision := 'unchanged'; refused_rows := 0; return next; return; end if;
  select count(*)::integer into v_offered from public.sp_write_plan_actions a where a.org_id = v_o.org_id and a.profile_id = v_o.profile_id
    and a.plan_id = v_o.plan_id and not exists(select 1 from public.sp_write_action_resolutions r where r.org_id = a.org_id
      and r.profile_id = a.profile_id and r.execution_id = v_o.execution_id and r.plan_id = a.plan_id and r.action_id = a.action_id);
  for v_action in select a.* from public.sp_write_plan_actions a where a.org_id = v_o.org_id and a.profile_id = v_o.profile_id
    and a.plan_id = v_o.plan_id and not exists(select 1 from public.sp_write_action_resolutions r where r.org_id = a.org_id
      and r.profile_id = a.profile_id and r.execution_id = v_o.execution_id and r.plan_id = a.plan_id and r.action_id = a.action_id)
    order by a.action_index loop
    v_disposition := gen_random_uuid();
    v_artifact := app.sp_write_disposition_artifact(v_disposition,v_o.plan_id,v_p.fingerprint,v_o.approval_id,
      v_o.execution_id,v_o.generation,v_action.action_id,v_action.fingerprint,
      case when v_reason = 'approval_expired' then least(v_r.expires_at,v_p.expires_at) else checked_at end,v_reason,null);
    insert into public.sp_write_predispatch_dispositions(disposition_id,org_id,profile_id,execution_id,plan_id,approval_id,generation,
      action_id,action_fingerprint,reason,provider_observation_fingerprint,recorded_at,persisted_at,artifact_text,artifact,fingerprint_preimage,fingerprint)
      values(v_disposition,v_o.org_id,v_o.profile_id,v_o.execution_id,v_o.plan_id,v_o.approval_id,v_o.generation,
        v_action.action_id,v_action.fingerprint,v_reason,null,
        case when v_reason = 'approval_expired' then least(v_r.expires_at,v_p.expires_at) else checked_at end,checked_at,
        v_artifact ->> 'artifactText',v_artifact -> 'artifact',v_artifact ->> 'fingerprintPreimage',v_artifact ->> 'fingerprint');
    insert into public.sp_write_action_resolutions(org_id,profile_id,execution_id,plan_id,action_id,resolution_kind,disposition_id,intent_id,resolved_at)
      values(v_o.org_id,v_o.profile_id,v_o.execution_id,v_o.plan_id,v_action.action_id,'refusal',v_disposition,null,checked_at);
    v_inserted := v_inserted + 1;
  end loop;
  if v_inserted <> v_offered or (select count(*) from public.sp_write_plan_actions a where a.org_id = v_o.org_id
    and a.profile_id = v_o.profile_id and a.plan_id = v_o.plan_id and not exists(select 1 from public.sp_write_action_resolutions r
      where r.org_id = a.org_id and r.profile_id = a.profile_id and r.execution_id = v_o.execution_id
        and r.plan_id = a.plan_id and r.action_id = a.action_id)) <> 0 then
    raise exception 'MCP authority refusal counts do not close' using errcode = '23514';
  end if;
  if clock_timestamp() >= v_h.lease_expires_at then
    raise exception 'MCP settlement claim expired under authority locks' using errcode = '40001';
  end if;
  decision := case when v_inserted > 0 then 'refused' else 'unchanged' end; refused_rows := v_inserted; return next;
end;
$$;
revoke all on function app.refuse_invalid_mcp_write_for_claim(uuid,bigint,uuid) from public,anon,authenticated;
grant execute on function app.refuse_invalid_mcp_write_for_claim(uuid,bigint,uuid) to service_role;

-- Canonical authority remains inside the sole intent writer, including owner/internal calls.
create or replace function app.reserve_sp_write_provider_call(
  p_execution_id uuid,
  p_plan_id uuid,
  p_generation uuid,
  p_dispatch_lease_id uuid,
  p_predispatch_observation_text text,
  p_predispatch_observation_preimage text,
  p_intent_text text,
  p_request_fingerprint_preimage text,
  p_intent_preimage text
)
returns table (
  decision text,
  refusal_reason text,
  checked_at timestamptz,
  result_id uuid,
  intent_text text
)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_plan public.sp_write_plans%rowtype;
  v_child public.sp_write_cycle_plans%rowtype;
  v_receipt public.sp_write_authorization_receipts%rowtype;
  v_lease public.sp_write_dispatch_leases%rowtype;
  v_environment public.sp_write_environment_gate_versions%rowtype;
  v_grant public.sp_write_profile_grant_versions%rowtype;
  v_authorization public.sp_write_bounded_authorizations%rowtype;
  v_profile public.ad_profiles%rowtype;
  v_connection public.ads_connections%rowtype;
  v_observation jsonb;
  v_intent jsonb;
  v_position jsonb;
  v_item jsonb;
  v_expected_observed jsonb;
  v_action public.sp_write_plan_actions%rowtype;
  v_disposition jsonb;
  v_disposition_id uuid;
  v_source_sync_job_id uuid;
  v_result_id uuid;
  v_index integer;
  v_offered integer;
  v_inserted integer := 0;
  v_targeted integer := 0;
  v_refusal public.sp_write_refusal_reason;
  v_action_refusal public.sp_write_refusal_reason;
  v_effective_at timestamptz;
  v_context_invalid_action_ids uuid[] := array[]::uuid[];
  v_stale_action_ids uuid[] := array[]::uuid[];
  v_targeted_action_ids uuid[] := array[]::uuid[];
  v_environment_found boolean := false;
  v_grant_found boolean := false;
  v_lease_found boolean := false;
  v_route_valid boolean := false;
  v_authorization_valid boolean := true;
  v_lease_valid boolean := false;
  v_busy boolean := false;
  v_duplicate_intent boolean := false;
  v_mcp_refusal public.sp_write_refusal_reason;
begin
  perform app.assert_service_role('reserve_sp_write_provider_call');
  v_observation := app.sp_write_verified_artifact(
    p_predispatch_observation_text, p_predispatch_observation_preimage,
    'openspell.sp-write-predispatch-observation.v1'
  );
  v_intent := app.sp_write_verified_artifact(
    p_intent_text, p_intent_preimage,
    'openspell.sp-write-provider-call-intent.v1'
  );
  if not app.sp_write_exact_json_keys(v_intent, array[
       'schemaVersion','intentId','providerCallId','planId','planFingerprint',
       'approvalId','executionId','generation','routeKey','attemptNumber',
       'dispatchLeaseId','providerObservationFingerprint','requestFingerprint',
       'recordedAt','positions','fingerprint'
     ])
     or not app.sp_write_exact_json_keys(v_observation, array[
       'schemaVersion','observationId','planId','planFingerprint','approvalId',
       'executionId','generation','routeKey','observedAt','validUntil','items',
       'fingerprint'
     ])
     or pg_catalog.jsonb_typeof(v_intent -> 'positions') <> 'array'
     or pg_catalog.jsonb_typeof(v_observation -> 'items') <> 'array'
     or pg_catalog.jsonb_array_length(v_intent -> 'positions') < 1
     or pg_catalog.jsonb_array_length(v_intent -> 'positions') > 100
     or pg_catalog.jsonb_array_length(v_intent -> 'positions')
        <> pg_catalog.jsonb_array_length(v_observation -> 'items')
     or v_intent ->> 'schemaVersion' <> 'openspell.sp-write-provider-call-intent.v1'
     or v_observation ->> 'schemaVersion'
        <> 'openspell.sp-write-predispatch-observation.v1'
     or (v_intent ->> 'attemptNumber')::integer <> 1
     or (v_intent ->> 'executionId')::uuid <> p_execution_id
     or (v_intent ->> 'planId')::uuid <> p_plan_id
     or (v_intent ->> 'generation')::uuid <> p_generation
     or (v_intent ->> 'dispatchLeaseId')::uuid <> p_dispatch_lease_id
     or v_intent ->> 'providerObservationFingerprint' <> v_observation ->> 'fingerprint'
     or v_intent ->> 'requestFingerprint'
        <> app.sp_write_sha256(p_request_fingerprint_preimage)
     or p_request_fingerprint_preimage::jsonb <> pg_catalog.jsonb_build_array(
       'openspell.sp-write-provider-request.v1',
       v_intent -> 'planId', v_intent -> 'planFingerprint',
       v_intent -> 'approvalId', v_intent -> 'executionId',
       v_intent -> 'generation', v_intent -> 'providerCallId',
       v_intent -> 'routeKey', v_intent -> 'providerObservationFingerprint',
       v_intent -> 'positions'
     ) then
    raise exception 'SP write reservation artifacts are structurally mismatched'
      using errcode = '22023';
  end if;
  v_offered := pg_catalog.jsonb_array_length(v_intent -> 'positions');

  select * into strict v_plan from public.sp_write_plans where plan_id = p_plan_id;
  select * into strict v_child
  from public.sp_write_cycle_plans child
  where child.execution_id = p_execution_id and child.plan_id = p_plan_id;
  select * into strict v_receipt
  from public.sp_write_authorization_receipts receipt
  where receipt.approval_id = v_child.approval_id;
  if v_child.generation <> p_generation
     or (v_intent ->> 'approvalId')::uuid <> v_child.approval_id
     or v_intent ->> 'planFingerprint' <> v_plan.fingerprint
     or (v_observation ->> 'executionId')::uuid <> p_execution_id
     or (v_observation ->> 'planId')::uuid <> p_plan_id
     or (v_observation ->> 'approvalId')::uuid <> v_child.approval_id
     or (v_observation ->> 'generation')::uuid <> p_generation
     or v_observation ->> 'planFingerprint' <> v_plan.fingerprint
     or v_observation ->> 'routeKey' <> v_intent ->> 'routeKey' then
    raise exception 'SP write reservation identity does not match the child ledger'
      using errcode = '22023';
  end if;

  -- Hold the tenant parent against deletion through intent commit. The org
  -- purge guard below can therefore never observe "no unresolved intent" and
  -- then race a reservation which commits one before the cascade reaches it.
  -- This is reservation's first lock, before any authority or tenant-child
  -- lock, so a purge winner cannot deadlock behind a losing reservation.
  perform 1
  from public.orgs org
  where org.id = v_plan.org_id
  for key share;
  if not found then
    raise exception 'SP write reservation tenant no longer exists'
      using errcode = '55000';
  end if;

  if v_receipt.approval_mode = 'delegated_mcp' then
    v_mcp_refusal := app.lock_mcp_dispatch_authority(p_plan_id,v_receipt.approval_id);
  end if;

  select version.* into v_environment
  from public.sp_write_environment_gate_head head
  join public.sp_write_environment_gate_versions version
    on version.version_id = head.version_id
  where head.singleton
  for update of head, version;
  v_environment_found := found;

  select version.* into v_grant
  from public.sp_write_profile_grant_heads head
  join public.sp_write_profile_grant_versions version
    on version.org_id = head.org_id and version.profile_id = head.profile_id
   and version.grant_id = head.grant_id and version.version_id = head.version_id
  where head.org_id = v_plan.org_id and head.profile_id = v_plan.profile_id
  for update of head, version;
  v_grant_found := found;

  select * into v_profile from public.ad_profiles profile
  where profile.org_id = v_plan.org_id and profile.id = v_plan.profile_id
  for update;
  if found and v_profile.connection_id is not null then
    select * into v_connection from public.ads_connections connection
    where connection.id = v_profile.connection_id and connection.org_id = v_profile.org_id
    for update;
    v_route_valid := found
      and v_connection.status = 'active'
      and v_profile.connection_id = v_plan.connection_id
      and v_profile.amazon_profile_id = v_plan.amazon_profile_id
      and v_profile.region = v_plan.region
      and v_profile.currency_code = v_plan.currency_code;
  end if;

  if v_receipt.bounded_authorization_id is not null then
    select * into v_authorization
    from public.sp_write_bounded_authorizations bounded
    where bounded.authorization_id = v_receipt.bounded_authorization_id
    for update;
    v_authorization_valid := found and not exists (
      select 1 from public.sp_write_bounded_authorization_revocations revocation
      where revocation.authorization_id = v_receipt.bounded_authorization_id
    );
  end if;

  select * into strict v_child
  from public.sp_write_cycle_plans child
  where child.org_id = v_plan.org_id and child.profile_id = v_plan.profile_id
    and child.execution_id = p_execution_id and child.plan_id = p_plan_id
  for update;
  select * into strict v_receipt
  from public.sp_write_authorization_receipts receipt
  where receipt.org_id = v_child.org_id and receipt.profile_id = v_child.profile_id
    and receipt.approval_id = v_child.approval_id
  for update;

  select * into v_lease from public.sp_write_dispatch_leases lease
  where lease.lease_id = p_dispatch_lease_id
    and lease.org_id = v_plan.org_id and lease.profile_id = v_plan.profile_id
    and lease.execution_id = p_execution_id and lease.plan_id = p_plan_id
    and lease.approval_id = v_child.approval_id and lease.generation = p_generation
    and lease.route_key::text = v_intent ->> 'routeKey'
  for update;
  v_lease_found := found;

  -- Stable entity locks come after the authority and child locks. A hash
  -- collision only serializes unrelated entities; it cannot admit overlap.
  for v_position in
    select value
    from pg_catalog.jsonb_array_elements(v_intent -> 'positions') position(value)
    order by value ->> 'amazonEntityId', value ->> 'actionId'
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'openspell:sp-write-entity:v1:' || v_plan.org_id::text || ':'
      || v_plan.profile_id::text || ':' || (v_intent ->> 'routeKey') || ':'
      || (v_position ->> 'amazonEntityId'), 0
    ));
  end loop;
  checked_at := clock_timestamp();
  v_lease_valid := v_lease_found and v_lease.expires_at > checked_at
    and v_lease.expires_at >= checked_at + interval '70 seconds';

  if (
    select count(distinct value ->> 'actionId') <> v_offered
    from pg_catalog.jsonb_array_elements(v_intent -> 'positions') position(value)
  ) then
    raise exception 'SP write reservation repeats an action' using errcode = '22023';
  end if;

  for v_position, v_index in
    select value, (ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(v_intent -> 'positions') with ordinality
  loop
    v_item := v_observation -> 'items' -> v_index;
    if not app.sp_write_exact_json_keys(v_position, array[
         'requestIndex','actionId','actionFingerprint','amazonEntityId',
         'actionRequestFingerprint'
       ]) or not app.sp_write_exact_json_keys(v_item, array[
         'routeKey','actionId','actionFingerprint','amazonEntityId','values'
       ]) then
      raise exception 'SP write reservation position or item shape is invalid'
        using errcode = '22023';
    end if;
    select * into v_action
    from public.sp_write_plan_actions action
    where action.org_id = v_plan.org_id and action.profile_id = v_plan.profile_id
      and action.plan_id = p_plan_id
      and action.action_id = (v_position ->> 'actionId')::uuid;
    if not found
       or (v_position ->> 'requestIndex')::integer <> v_index
       or (v_position ->> 'actionFingerprint') !~ '^[a-f0-9]{64}$'
       or (v_position ->> 'actionRequestFingerprint') !~ '^[a-f0-9]{64}$'
       or v_position ->> 'actionFingerprint' <> v_action.fingerprint
       or v_position ->> 'amazonEntityId' <> v_action.amazon_entity_id
       or v_action.route_key::text <> v_intent ->> 'routeKey'
       or v_item ->> 'actionId' <> v_position ->> 'actionId'
       or v_item ->> 'actionFingerprint' <> v_action.fingerprint
       or v_item ->> 'routeKey' <> v_action.route_key::text
       or v_item ->> 'routeKey' <> v_observation ->> 'routeKey'
       or v_item ->> 'routeKey' <> v_intent ->> 'routeKey'
       or v_item ->> 'amazonEntityId' <> v_action.amazon_entity_id then
      raise exception 'SP write reservation position identity is invalid'
        using errcode = '22023';
    end if;
    if v_receipt.bounded_authorization_id is not null
       and not app.sp_write_action_within_bounded_authorization(
         v_receipt.bounded_authorization_id, v_plan.org_id, v_plan.profile_id,
         v_action.artifact
       ) then
      v_authorization_valid := false;
    end if;
    v_expected_observed := app.sp_write_observed_action_for_side(
      v_action.artifact, 'expected'
    );
    if not app.sp_write_exact_json_keys(v_item -> 'values', array(
      select key from pg_catalog.jsonb_object_keys(v_expected_observed -> 'values') key
    )) then
      v_context_invalid_action_ids := pg_catalog.array_append(
        v_context_invalid_action_ids, (v_position ->> 'actionId')::uuid
      );
    elsif v_item <> v_expected_observed then
      v_stale_action_ids := pg_catalog.array_append(
        v_stale_action_ids, (v_position ->> 'actionId')::uuid
      );
    end if;
  end loop;

  v_result_id := app.sp_write_reserved_result_id((v_intent ->> 'intentId')::uuid);
  if exists (
    select 1 from public.sp_write_provider_call_intents existing
    where existing.reserved_result_id = v_result_id
      and existing.intent_id <> (v_intent ->> 'intentId')::uuid
  ) then
    raise exception 'SP write reserved result UUID collision' using errcode = '23505';
  end if;
  v_duplicate_intent := exists (
    select 1 from public.sp_write_provider_call_intents existing
    where existing.intent_id = (v_intent ->> 'intentId')::uuid
       or existing.provider_call_id = (v_intent ->> 'providerCallId')::uuid
  );

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(v_intent -> 'positions') position(value)
    join public.sp_write_action_resolutions resolution
      on resolution.org_id = v_plan.org_id and resolution.profile_id = v_plan.profile_id
     and resolution.execution_id = p_execution_id and resolution.plan_id = p_plan_id
     and resolution.action_id = (position.value ->> 'actionId')::uuid
  ) then
    decision := 'already_intended';
    refusal_reason := null;
    result_id := null;
    intent_text := null;
    return next;
    return;
  end if;

  if checked_at >= v_receipt.expires_at or checked_at >= v_plan.expires_at then
    v_refusal := 'approval_expired';
    v_effective_at := v_receipt.expires_at;
  elsif not v_environment_found or not v_environment.enabled
     or v_environment.version_id <> v_receipt.environment_gate_version then
    v_refusal := 'environment_gate_closed';
    v_effective_at := checked_at;
  elsif not v_grant_found or not v_grant.enabled
     or v_grant.grant_id <> v_receipt.profile_grant_id
     or v_grant.version_id <> v_receipt.profile_grant_version
     or v_grant.amazon_profile_id <> v_plan.amazon_profile_id
     or v_grant.connection_id <> v_plan.connection_id
     or v_grant.region <> v_plan.region
     or v_grant.marketplace_id <> v_plan.marketplace_id
     or v_grant.currency_code <> v_plan.currency_code then
    v_refusal := 'profile_gate_closed';
    v_effective_at := checked_at;
  elsif not v_route_valid then
    v_refusal := 'route_mismatch';
    v_effective_at := checked_at;
  elsif v_mcp_refusal is not null then
    v_refusal := v_mcp_refusal;
    v_effective_at := checked_at;
  elsif not v_authorization_valid or v_child.generation <> v_receipt.generation then
    v_refusal := 'authorization_revoked';
    v_effective_at := checked_at;
  elsif not v_lease_valid then
    v_refusal := 'lease_unavailable';
    v_effective_at := checked_at;
  end if;

  if v_refusal is null then
    if (v_observation ->> 'observedAt')::timestamptz < v_receipt.approved_at
       or (v_observation ->> 'observedAt')::timestamptz > checked_at
       or (v_observation ->> 'validUntil')::timestamptz <=
          (v_observation ->> 'observedAt')::timestamptz
       or (v_observation ->> 'validUntil')::timestamptz >
          (v_observation ->> 'observedAt')::timestamptz + interval '2 minutes'
       or (v_observation ->> 'validUntil')::timestamptz < checked_at
       or (v_intent ->> 'recordedAt')::timestamptz
          < (v_observation ->> 'observedAt')::timestamptz
       or (v_intent ->> 'recordedAt')::timestamptz > checked_at
       or (v_intent ->> 'recordedAt')::timestamptz
          > (v_observation ->> 'validUntil')::timestamptz then
      raise exception 'SP write reservation observation or intent is stale'
        using errcode = '22023';
    end if;
  end if;

  if v_refusal is null then
    -- Authority remains current. Capacity and unresolved entity/source fences
    -- are nonterminal and consume no action.
    if exists (
      select 1
      from public.sp_write_provider_call_intents intent
      left join public.sp_write_provider_results result on result.intent_id = intent.intent_id
      where result.intent_id is null
    ) or (
      v_receipt.bounded_authorization_id is not null and exists (
        select 1
        from public.sp_write_provider_call_intents intent
        join public.sp_write_cycle_plans child
          on child.org_id = intent.org_id and child.profile_id = intent.profile_id
         and child.execution_id = intent.execution_id and child.plan_id = intent.plan_id
        join public.sp_write_authorization_receipts receipt
          on receipt.approval_id = child.approval_id
        left join public.sp_write_provider_results result on result.intent_id = intent.intent_id
        where receipt.bounded_authorization_id = v_receipt.bounded_authorization_id
          and (
            result.intent_id is null
            or exists (
              select 1
              from public.sp_write_provider_result_positions result_position
              left join public.sp_write_observations observation
                on observation.org_id = result_position.org_id
               and observation.profile_id = result_position.profile_id
               and observation.intent_id = result_position.intent_id
               and observation.result_id = result_position.result_id
               and observation.action_id = result_position.action_id
              where result_position.org_id = result.org_id
                and result_position.profile_id = result.profile_id
                and result_position.intent_id = result.intent_id
                and result_position.result_id = result.result_id
                and result_position.outcome <> 'authoritative_rejected'
                and observation.observation_id is null
            )
          )
      )
    ) or (
      v_receipt.bounded_authorization_id is null and exists (
        select 1 from public.sp_write_provider_call_intents intent
        left join public.sp_write_provider_results result on result.intent_id = intent.intent_id
        where intent.execution_id = p_execution_id and result.intent_id is null
      )
    ) then
      v_busy := true;
    end if;
    if not v_busy and exists (
      select 1
      from pg_catalog.jsonb_array_elements(v_intent -> 'positions') offered(value)
      join public.sp_write_provider_call_positions prior
        on prior.org_id = v_plan.org_id and prior.profile_id = v_plan.profile_id
       and prior.amazon_entity_id = offered.value ->> 'amazonEntityId'
      join public.sp_write_provider_call_intents prior_intent
        on prior_intent.intent_id = prior.intent_id
       and prior_intent.route_key::text = v_intent ->> 'routeKey'
      left join public.sp_write_provider_results prior_result
        on prior_result.intent_id = prior.intent_id
      left join public.sp_write_provider_result_positions prior_position
        on prior_position.result_id = prior_result.result_id
       and prior_position.action_id = prior.action_id
      left join public.sp_write_observations prior_observation
        on prior_observation.intent_id = prior.intent_id
       and prior_observation.action_id = prior.action_id
      where prior_intent.execution_id <> p_execution_id
        and (
          prior_result.result_id is null
          or (
            prior_position.outcome <> 'authoritative_rejected'
            and prior_observation.observation_id is null
          )
        )
    ) then
      v_busy := true;
    end if;
    if not v_busy and v_plan.direction = 'inverse' and not exists (
      select 1 from public.sp_write_plans source
      where source.plan_id = v_plan.source_plan_id
        and source.provider_rows = (
          select count(*) from public.sp_write_observations observed
          where observed.execution_id = p_execution_id
            and observed.plan_id = v_plan.source_plan_id
            and observed.outcome = 'observed_requested'
        )
    ) then
      v_busy := true;
    end if;
    if v_busy then
      decision := 'busy';
      refusal_reason := null;
      result_id := null;
      intent_text := null;
      return next;
      return;
    end if;
  end if;

  if v_refusal is null then
    if v_duplicate_intent then
      v_refusal := 'duplicate_intent';
      v_effective_at := checked_at;
    elsif pg_catalog.cardinality(v_context_invalid_action_ids) > 0 then
      v_refusal := 'unsupported_provider_state';
      v_effective_at := checked_at;
    elsif pg_catalog.cardinality(v_stale_action_ids) > 0 then
      v_refusal := 'stale_expected_state';
      v_effective_at := checked_at;
    end if;
  end if;

  if v_refusal is not null then
    if v_refusal in ('unsupported_provider_state', 'stale_expected_state') then
      v_targeted_action_ids := pg_catalog.array_cat(
        v_context_invalid_action_ids, v_stale_action_ids
      );
    else
      select pg_catalog.array_agg((position.value ->> 'actionId')::uuid)
      into v_targeted_action_ids
      from pg_catalog.jsonb_array_elements(v_intent -> 'positions') position(value);
    end if;
    v_targeted := pg_catalog.cardinality(v_targeted_action_ids);
    if v_targeted < 1 then
      raise exception 'SP write refusal selected no actions' using errcode = '22023';
    end if;

    if pg_catalog.cardinality(v_stale_action_ids) > 0
       and v_refusal in ('unsupported_provider_state', 'stale_expected_state') then
      insert into public.sp_write_predispatch_observations (
        observation_id, org_id, profile_id, execution_id, plan_id, approval_id,
        generation, route_key, observed_at, valid_until, artifact_text, artifact,
        fingerprint_preimage, fingerprint, persisted_at
      ) values (
        (v_observation ->> 'observationId')::uuid, v_plan.org_id, v_plan.profile_id,
        p_execution_id, p_plan_id, v_child.approval_id, p_generation,
        (v_observation ->> 'routeKey')::public.sp_write_route_key,
        (v_observation ->> 'observedAt')::timestamptz,
        (v_observation ->> 'validUntil')::timestamptz,
        p_predispatch_observation_text, v_observation,
        p_predispatch_observation_preimage, v_observation ->> 'fingerprint', checked_at
      );
      for v_item, v_index in
        select value, (ordinality - 1)::integer
        from pg_catalog.jsonb_array_elements(v_observation -> 'items') with ordinality
      loop
        insert into public.sp_write_predispatch_observation_items (
          org_id, profile_id, observation_id, execution_id, plan_id, approval_id,
          generation, item_index, action_id, action_fingerprint, route_key,
          amazon_entity_id, observed
        ) values (
          v_plan.org_id, v_plan.profile_id,
          (v_observation ->> 'observationId')::uuid, p_execution_id, p_plan_id,
          v_child.approval_id, p_generation, v_index,
          (v_item ->> 'actionId')::uuid, v_item ->> 'actionFingerprint',
          (v_item ->> 'routeKey')::public.sp_write_route_key,
          v_item ->> 'amazonEntityId', v_item
        );
      end loop;
    end if;
    v_inserted := 0;
    for v_position in select value
      from pg_catalog.jsonb_array_elements(v_intent -> 'positions')
    loop
      if not ((v_position ->> 'actionId')::uuid = any(v_targeted_action_ids)) then
        continue;
      end if;
      if v_refusal not in ('unsupported_provider_state', 'stale_expected_state') then
        v_action_refusal := v_refusal;
      elsif (v_position ->> 'actionId')::uuid = any(v_context_invalid_action_ids) then
        v_action_refusal := 'unsupported_provider_state';
      else
        v_action_refusal := 'stale_expected_state';
      end if;
      v_disposition_id := gen_random_uuid();
      v_disposition := app.sp_write_disposition_artifact(
        v_disposition_id, p_plan_id, v_plan.fingerprint, v_child.approval_id,
        p_execution_id, p_generation, (v_position ->> 'actionId')::uuid,
        v_position ->> 'actionFingerprint', v_effective_at, v_action_refusal,
        case when v_action_refusal = 'stale_expected_state'
          then v_observation ->> 'fingerprint' end
      );
      insert into public.sp_write_predispatch_dispositions (
        disposition_id, org_id, profile_id, execution_id, plan_id, approval_id,
        generation, action_id, action_fingerprint, reason,
        provider_observation_fingerprint, recorded_at, persisted_at,
        artifact_text, artifact, fingerprint_preimage, fingerprint
      ) values (
        v_disposition_id, v_plan.org_id, v_plan.profile_id, p_execution_id,
        p_plan_id, v_child.approval_id, p_generation,
        (v_position ->> 'actionId')::uuid, v_position ->> 'actionFingerprint',
        v_action_refusal, case when v_action_refusal = 'stale_expected_state'
          then v_observation ->> 'fingerprint' end,
        v_effective_at, checked_at, v_disposition ->> 'artifactText',
        v_disposition -> 'artifact', v_disposition ->> 'fingerprintPreimage',
        v_disposition ->> 'fingerprint'
      );
      insert into public.sp_write_action_resolutions (
        org_id, profile_id, execution_id, plan_id, action_id, resolution_kind,
        disposition_id, intent_id, resolved_at
      ) values (
        v_plan.org_id, v_plan.profile_id, p_execution_id, p_plan_id,
        (v_position ->> 'actionId')::uuid, 'refusal',
        v_disposition_id, null, checked_at
      );
      v_inserted := v_inserted + 1;
    end loop;
    if v_inserted <> v_targeted
       or (
         select count(*)
         from public.sp_write_predispatch_dispositions disposition
         where disposition.org_id = v_plan.org_id
           and disposition.profile_id = v_plan.profile_id
           and disposition.execution_id = p_execution_id
           and disposition.plan_id = p_plan_id
           and disposition.action_id = any(v_targeted_action_ids)
       ) <> v_targeted
       or (
         select count(*)
         from public.sp_write_action_resolutions resolution
         where resolution.org_id = v_plan.org_id
           and resolution.profile_id = v_plan.profile_id
           and resolution.execution_id = p_execution_id
           and resolution.plan_id = p_plan_id
           and resolution.resolution_kind = 'refusal'
           and resolution.action_id = any(v_targeted_action_ids)
       ) <> v_targeted then
      raise exception 'SP write refusal counts do not close' using errcode = '22023';
    end if;
    if pg_catalog.cardinality(v_stale_action_ids) > 0
       and v_refusal in ('unsupported_provider_state', 'stale_expected_state') and (
      (select count(*) from public.sp_write_predispatch_observations observation
       where observation.observation_id = (v_observation ->> 'observationId')::uuid) <> 1
      or
      (select count(*) from public.sp_write_predispatch_observation_items item
       where item.observation_id = (v_observation ->> 'observationId')::uuid) <> v_offered
    ) then
      raise exception 'SP write stale refusal observation counts do not close'
        using errcode = '22023';
    end if;
    decision := 'refused';
    refusal_reason := v_refusal::text;
    result_id := null;
    intent_text := null;
    return next;
    return;
  end if;

  insert into public.sp_write_predispatch_observations (
    observation_id, org_id, profile_id, execution_id, plan_id, approval_id,
    generation, route_key, observed_at, valid_until, artifact_text, artifact,
    fingerprint_preimage, fingerprint, persisted_at
  ) values (
    (v_observation ->> 'observationId')::uuid, v_plan.org_id, v_plan.profile_id,
    p_execution_id, p_plan_id, v_child.approval_id, p_generation,
    (v_observation ->> 'routeKey')::public.sp_write_route_key,
    (v_observation ->> 'observedAt')::timestamptz,
    (v_observation ->> 'validUntil')::timestamptz,
    p_predispatch_observation_text, v_observation,
    p_predispatch_observation_preimage, v_observation ->> 'fingerprint', checked_at
  );
  for v_item, v_index in
    select value, (ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(v_observation -> 'items') with ordinality
  loop
    insert into public.sp_write_predispatch_observation_items (
      org_id, profile_id, observation_id, execution_id, plan_id, approval_id,
      generation, item_index, action_id, action_fingerprint, route_key,
      amazon_entity_id, observed
    ) values (
      v_plan.org_id, v_plan.profile_id, (v_observation ->> 'observationId')::uuid,
      p_execution_id, p_plan_id, v_child.approval_id, p_generation, v_index,
      (v_item ->> 'actionId')::uuid, v_item ->> 'actionFingerprint',
      (v_item ->> 'routeKey')::public.sp_write_route_key,
      v_item ->> 'amazonEntityId', v_item
    );
  end loop;

  insert into public.sp_write_provider_call_intents (
    intent_id, provider_call_id, reserved_result_id, org_id, profile_id,
    execution_id, plan_id, approval_id, generation, route_key, attempt_number,
    dispatch_lease_id, provider_observation_fingerprint,
    request_fingerprint_preimage, request_fingerprint,
    intent_fingerprint_preimage, fingerprint, artifact_text, artifact,
    recorded_at, checked_at, dispatch_start_deadline, provider_attempt_deadline
  ) values (
    (v_intent ->> 'intentId')::uuid, (v_intent ->> 'providerCallId')::uuid,
    v_result_id, v_plan.org_id, v_plan.profile_id, p_execution_id, p_plan_id,
    v_child.approval_id, p_generation,
    (v_intent ->> 'routeKey')::public.sp_write_route_key, 1,
    p_dispatch_lease_id, v_intent ->> 'providerObservationFingerprint',
    p_request_fingerprint_preimage, v_intent ->> 'requestFingerprint',
    p_intent_preimage, v_intent ->> 'fingerprint', p_intent_text, v_intent,
    (v_intent ->> 'recordedAt')::timestamptz, checked_at,
    checked_at + interval '5 seconds', checked_at + interval '35 seconds'
  );
  v_inserted := 0;
  for v_position, v_index in
    select value, (ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(v_intent -> 'positions') with ordinality
  loop
    insert into public.sp_write_provider_call_positions (
      org_id, profile_id, execution_id, plan_id, intent_id, request_index,
      action_id, action_fingerprint, amazon_entity_id, action_request_fingerprint
    ) values (
      v_plan.org_id, v_plan.profile_id, p_execution_id, p_plan_id,
      (v_intent ->> 'intentId')::uuid, v_index,
      (v_position ->> 'actionId')::uuid, v_position ->> 'actionFingerprint',
      v_position ->> 'amazonEntityId', v_position ->> 'actionRequestFingerprint'
    );
    insert into public.sp_write_action_resolutions (
      org_id, profile_id, execution_id, plan_id, action_id, resolution_kind,
      disposition_id, intent_id, resolved_at
    ) values (
      v_plan.org_id, v_plan.profile_id, p_execution_id, p_plan_id,
      (v_position ->> 'actionId')::uuid, 'intent', null,
      (v_intent ->> 'intentId')::uuid, checked_at
    );
    v_inserted := v_inserted + 1;
  end loop;
  v_source_sync_job_id := gen_random_uuid();
  insert into public.sp_write_outbox (
    org_id, profile_id, execution_id, plan_id, approval_id, generation,
    kind, provider_call_id, intent_id, source_sync_job_id, created_at
  ) values (
    v_plan.org_id, v_plan.profile_id, p_execution_id, p_plan_id,
    v_child.approval_id, p_generation, 'observe_and_recover',
    (v_intent ->> 'providerCallId')::uuid, (v_intent ->> 'intentId')::uuid,
    v_source_sync_job_id, checked_at
  );
  if v_inserted <> v_offered
     or (select count(*) from public.sp_write_predispatch_observations observation
         where observation.observation_id =
           (v_observation ->> 'observationId')::uuid) <> 1
     or (select count(*) from public.sp_write_predispatch_observation_items item
         where item.observation_id =
           (v_observation ->> 'observationId')::uuid) <> v_offered
     or (select count(*) from public.sp_write_provider_call_intents intent
         where intent.intent_id = (v_intent ->> 'intentId')::uuid) <> 1
     or (select count(*) from public.sp_write_provider_call_positions position
         where position.intent_id = (v_intent ->> 'intentId')::uuid) <> v_offered
     or (select count(*) from public.sp_write_action_resolutions resolution
         where resolution.intent_id = (v_intent ->> 'intentId')::uuid) <> v_offered
     or (select count(*) from public.sp_write_outbox outbox
         where outbox.intent_id = (v_intent ->> 'intentId')::uuid
           and outbox.kind = 'observe_and_recover') <> 1 then
    raise exception 'SP write reservation counts do not close' using errcode = '22023';
  end if;
  decision := 'won';
  refusal_reason := null;
  result_id := v_result_id;
  intent_text := p_intent_text;
  return next;
end;
$$;
revoke all on function app.reserve_sp_write_provider_call(uuid,uuid,uuid,uuid,text,text,text,text,text)
  from public,anon,authenticated,service_role;
