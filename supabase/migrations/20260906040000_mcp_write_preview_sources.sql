-- WP-217: atomically bind legacy and inverse previews to a current delegated key.
-- This creates no admission, capacity charge, enabled gate or worker registration.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- The legacy human recorder keeps its existing semantics. MCP additionally proves
-- the exact shared serializer bytes so every stored source can be rehydrated.
create function app.mcp_legacy_preview_json(p_value jsonb,p_kind text)
returns text language plpgsql immutable set search_path = pg_catalog,app,pg_temp as $$
declare v_fields jsonb; v_field jsonb; v_parts text[] := array[]::text[]; v_kind text; v_value jsonb;
begin
  if right(p_kind,2) = '[]' then
    if jsonb_typeof(p_value) is distinct from 'array' or jsonb_array_length(p_value) not between 1 and 500 then
      raise exception 'MCP legacy evidence array differs' using errcode = '22023';
    end if;
    for v_value in select value from jsonb_array_elements(p_value) loop
      v_parts := array_append(v_parts,app.mcp_legacy_preview_json(v_value,left(p_kind,length(p_kind)-2)));
    end loop;
    return '[' || array_to_string(v_parts,',') || ']';
  end if;
  case p_kind
    when 'guards' then v_fields := '[ ["profileGrantId","uuid"],["profileGrantVersion","uuid"],["providerScope","scope"],["maximumProviderRows","integer"],["requireCurrentValueMatch","boolean"],["policies","policy[]"] ]';
    when 'policy' then v_fields := '[ ["applyRowId","uuid"],["recommendationId","uuid"],["runId","uuid"],["strategySnapshotText","string"],["strategyGoal","nonempty"],["groupId","nullable_uuid"],["groupSnapshotText","nullable_string"] ]';
    when 'provenance' then v_fields := '[ ["applyBatchId","uuid"],["artifactText","nonempty"],["artifactSha256","sha256"],["exportedAt","instant"],["tag","string"],["optGroup","string"],["lever","string"],["note","string"],["rows","row[]"] ]';
    when 'row' then
      v_fields := '[ ["applyRowId","uuid"],["recommendationId","uuid"],["runId","uuid"] ]';
      if p_value ? 'proposalRevisionId' then v_fields := v_fields || '[["proposalRevisionId","uuid"]]'::jsonb; end if;
    else raise exception 'unknown MCP legacy evidence shape' using errcode = '22023';
  end case;
  if not coalesce(app.sp_write_exact_json_keys(p_value,array(select f ->> 0 from jsonb_array_elements(v_fields) f)),false) then
    raise exception 'MCP legacy evidence fields differ' using errcode = '22023';
  end if;
  for v_field in select value from jsonb_array_elements(v_fields) loop
    v_kind := v_field ->> 1; v_value := p_value -> (v_field ->> 0);
    if right(v_kind,2) = '[]' then
      v_parts := array_append(v_parts,to_json(v_field ->> 0)::text || ':' || app.mcp_legacy_preview_json(v_value,v_kind));
    elsif left(v_kind,9) = 'nullable_' and v_value = 'null'::jsonb then
      v_parts := array_append(v_parts,to_json(v_field ->> 0)::text || ':null');
    else
      if left(v_kind,9) = 'nullable_' then v_kind := substring(v_kind from 10); end if;
      if v_kind = 'nonempty' then
        if jsonb_typeof(v_value) is distinct from 'string' or length(v_value #>> '{}') = 0 then
          raise exception 'MCP legacy evidence string differs' using errcode = '22023';
        end if;
        v_kind := 'string';
      end if;
      v_parts := array_append(v_parts,to_json(v_field ->> 0)::text || ':' || app.mcp_keyword_preview_json(v_value,v_kind));
    end if;
  end loop;
  return '{' || array_to_string(v_parts,',') || '}';
end;
$$;
revoke all on function app.mcp_legacy_preview_json(jsonb,text) from public,anon,authenticated,service_role;

create function app.prepare_mcp_sp_write_preview_v1(
  p_org uuid, p_key uuid, p_hash text, p_request_text text, p_request_preimage text,
  p_plan_text text, p_plan_preimage text, p_actions jsonb,
  p_evidence_text text, p_guardrail_preimage text, p_provenance_preimage text
)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public, app, mcp, pg_temp as $$
declare
  v_request jsonb := p_request_text::jsonb; v_plan jsonb := p_plan_text::jsonb;
  v_profile uuid; v_plan_id uuid; v_request_json text; v_source_json text;
  v_context jsonb; v_existing mcp.write_previews%rowtype; v_forward public.sp_write_plans%rowtype;
  v_count integer; v_version text; v_action jsonb;
begin
  perform app.assert_service_role('prepare_mcp_sp_write_preview_v1');
  if not coalesce(app.sp_write_exact_json_keys(v_request,array['requestId','profileId','source']),false) then
    raise exception 'invalid MCP preview request' using errcode = '22023';
  end if;
  if v_request #>> '{source,kind}' = 'apply_batch' then
    if not coalesce(app.sp_write_exact_json_keys(v_request -> 'source',array['kind','applyBatchId']),false) then
      raise exception 'invalid MCP batch preview source' using errcode = '22023';
    end if;
    v_source_json := '{"kind":"apply_batch","applyBatchId":' ||
      app.mcp_keyword_preview_json(v_request #> '{source,applyBatchId}','uuid') || '}';
  elsif v_request #>> '{source,kind}' = 'inverse' then
    if not coalesce(app.sp_write_exact_json_keys(v_request -> 'source',array['kind','original'])
      and app.sp_write_exact_json_keys(v_request #> '{source,original}',array['executionId','planId']),false) then
      raise exception 'invalid MCP inverse preview source' using errcode = '22023';
    end if;
    v_source_json := '{"kind":"inverse","original":{"executionId":' ||
      app.mcp_keyword_preview_json(v_request #> '{source,original,executionId}','uuid') || ',"planId":' ||
      app.mcp_keyword_preview_json(v_request #> '{source,original,planId}','uuid') || '}}';
  else raise exception 'unsupported MCP preview source' using errcode = '22023';
  end if;
  v_request_json := '{"requestId":' || app.mcp_keyword_preview_json(v_request -> 'requestId','uuid') ||
    ',"profileId":' || app.mcp_keyword_preview_json(v_request -> 'profileId','uuid') || ',"source":' || v_source_json || '}';
  if p_request_preimage is distinct from '["openspell.mcp-bid-preview-request.v1",' || v_request_json || ']' then
    raise exception 'MCP preview request bytes differ from shared contract' using errcode = '22023';
  end if;
  v_profile := (v_request ->> 'profileId')::uuid;
  perform pg_advisory_xact_lock(hashtextextended('mcp-preview:' || p_org::text || ':' || p_key::text || ':' || (v_request ->> 'requestId'),0));
  v_context := app.mcp_bid_preview_context(p_org,p_key,p_hash,v_profile);
  select * into v_existing from mcp.write_previews where org_id = p_org and key_id = p_key
    and request_id = (v_request ->> 'requestId')::uuid;
  if found then
    if v_existing.request is distinct from v_request then
      raise exception 'MCP preview request identity conflict' using errcode = '23505';
    end if;
    return v_existing.plan_id;
  end if;
  v_version := v_plan ->> 'schemaVersion';
  if not coalesce(v_version in ('openspell.sp-write-plan.v1','openspell.sp-write-plan.v2')
    and v_plan ->> 'orgId' = p_org::text and v_plan ->> 'profileId' = v_profile::text
    and v_plan -> 'providerScope' = v_context -> 'providerScope'
    and v_plan -> 'generatedAt' = v_plan -> 'frozenAt', false)
    or p_plan_preimage is distinct from '[' || to_json(v_version)::text || ',' ||
      app.mcp_keyword_preview_json(v_plan - 'fingerprint','plan_preimage') || ']'
    or v_plan ->> 'fingerprint' is distinct from app.sp_write_sha256(p_plan_preimage) then
    raise exception 'MCP preview plan bytes or scope differ' using errcode = '22023';
  end if;
  if (v_plan ->> 'generatedAt')::timestamptz > clock_timestamp()
    or (v_plan ->> 'expiresAt')::timestamptz <= clock_timestamp()
    or (v_plan ->> 'expiresAt')::timestamptz <= (v_plan ->> 'frozenAt')::timestamptz
    or (v_plan ->> 'expiresAt')::timestamptz > (v_plan ->> 'generatedAt')::timestamptz + interval '15 minutes'
    or v_plan ->> 'generatedAt' !~ 'T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$'
    or v_plan ->> 'frozenAt' !~ 'T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$'
    or v_plan ->> 'expiresAt' !~ 'T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$' then
    raise exception 'MCP preview time differs from shared contract' using errcode = '22023';
  end if;
  perform app.assert_mcp_bid_plan_limits(v_plan,v_context -> 'delegation');
  for v_action in select value from jsonb_array_elements(v_plan -> 'actions') loop
    if v_action ->> 'fingerprint' is distinct from app.sp_write_sha256('["openspell.sp-write-action.v1",' ||
      app.mcp_keyword_preview_json(v_action - 'fingerprint','action_preimage') || ']') then
      raise exception 'MCP action fingerprint bytes differ from shared contract' using errcode = '22023';
    end if;
  end loop;
  v_plan_id := (v_plan ->> 'id')::uuid;
  insert into mcp.write_previews(plan_id,org_id,profile_id,key_id,delegation_version_id,request_id,
    request_text,request,request_preimage,request_fingerprint,prepared_at)
    values(v_plan_id,p_org,v_profile,p_key,(v_context #>> '{delegation,versionId}')::uuid,(v_request ->> 'requestId')::uuid,
      p_request_text,v_request,p_request_preimage,app.sp_write_sha256(p_request_preimage),(v_plan ->> 'generatedAt')::timestamptz);
  if v_request #>> '{source,kind}' = 'apply_batch' then
    if v_version is distinct from 'openspell.sp-write-plan.v1' or v_plan ->> 'direction' is distinct from 'forward'
      or v_plan #>> '{source,kind}' is distinct from 'apply_batch'
      or v_plan #> '{source,applyBatchId}' is distinct from v_request #> '{source,applyBatchId}'
      or p_evidence_text is null or p_guardrail_preimage is null or p_provenance_preimage is null then
      raise exception 'MCP batch preview must bind legacy evidence' using errcode = '22023';
    end if;
    if p_guardrail_preimage is distinct from '["openspell.sp-write-preview-guards.v1",' ||
      app.mcp_legacy_preview_json(p_evidence_text::jsonb -> 'guardrails','guards') || ']'
      or p_provenance_preimage is distinct from '["openspell.sp-write-preview-source.v1",' ||
      app.mcp_legacy_preview_json(p_evidence_text::jsonb -> 'provenance','provenance') || ']' then
      raise exception 'MCP legacy evidence fingerprint bytes differ from shared contract' using errcode = '22023';
    end if;
    perform app.record_sp_write_preview(p_plan_text,p_plan_preimage,p_actions,
      p_evidence_text,p_guardrail_preimage,p_provenance_preimage);
  else
    if v_plan ->> 'direction' is distinct from 'inverse' or v_plan #>> '{source,kind}' is distinct from 'inverse_execution'
      or v_plan #> '{source,sourceExecutionId}' is distinct from v_request #> '{source,original,executionId}'
      or v_plan #> '{source,sourcePlanId}' is distinct from v_request #> '{source,original,planId}'
      or p_evidence_text is not null or p_guardrail_preimage is not null or p_provenance_preimage is not null then
      raise exception 'MCP inverse preview source differs' using errcode = '22023';
    end if;
    select p.* into v_forward from public.sp_write_plans p
      join public.sp_write_preview_evidence e on e.org_id = p.org_id and e.profile_id = p.profile_id and e.plan_id = p.plan_id
      join public.sp_write_cycle_plans c on c.org_id = p.org_id and c.profile_id = p.profile_id and c.plan_id = p.plan_id
      where p.org_id = p_org and p.profile_id = v_profile and p.direction = 'forward'
        and p.plan_id::text = v_plan #>> '{source,sourcePlanId}'
        and p.fingerprint = v_plan #>> '{source,sourcePlanFingerprint}'
        and c.execution_id::text = v_plan #>> '{source,sourceExecutionId}'
        and p.artifact -> 'providerScope' = v_plan -> 'providerScope'
        and p.artifact -> 'counts' = v_plan -> 'counts';
    if not found then
      raise exception 'MCP inverse source operation differs' using errcode = '55000';
    end if;
    perform app.record_sp_write_plan(p_plan_text,p_plan_preimage,p_actions);
    perform app.assert_mcp_admission_source(v_plan_id);
  end if;
  insert into public.audit_log(org_id,actor_type,actor_id,action,target_type,target_id,payload,source)
    values(p_org,'mcp',p_key::text,'mcp.bid_preview.prepared','sp_write_plan',v_plan_id::text,
      jsonb_build_object('requestId',v_request -> 'requestId','issuerUserId',v_context #> '{delegation,issuerUserId}',
        'delegationVersionId',v_context #> '{delegation,versionId}','profileId',v_profile,
        'rows',(v_plan #>> '{counts,providerRows}')::integer,'sourceKind',v_request #>> '{source,kind}'), 'mcp');
  get diagnostics v_count = row_count;
  if v_count <> 1 then raise exception 'MCP preview audit count differs' using errcode = '55000'; end if;
  return v_plan_id;
end;
$$;
revoke all on function app.prepare_mcp_sp_write_preview_v1(uuid,uuid,text,text,text,text,text,jsonb,text,text,text)
  from public,anon,authenticated;
grant execute on function app.prepare_mcp_sp_write_preview_v1(uuid,uuid,text,text,text,text,text,jsonb,text,text,text) to service_role;
