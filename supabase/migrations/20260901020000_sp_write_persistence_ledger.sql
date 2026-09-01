-- WP-187: inert Sponsored Products write-persistence ledger.
--
-- This migration installs evidence storage and guarded capabilities only. It
-- creates no gate head, profile grant, bounded authorization, execution, or
-- outbox row, and it does not add a current queue or worker job type.

set local lock_timeout = '5s';
select pg_advisory_xact_lock(
  pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0)
);

create type public.sp_write_route_key as enum (
  'sp.v3.campaigns.update',
  'sp.v3.ad_groups.update',
  'sp.v3.keywords.update',
  'sp.v3.targets.update',
  'sp.v3.product_ads.update'
);

create type public.sp_write_plan_direction as enum ('forward', 'inverse');
create type public.sp_write_approval_mode as enum ('manual', 'bounded_live_test');
create type public.sp_write_action_resolution_kind as enum ('refusal', 'intent');
create type public.sp_write_result_origin as enum ('provider_adapter', 'recovery_synthesized');
create type public.sp_write_provider_outcome as enum (
  'accepted', 'authoritative_rejected', 'ambiguous'
);
create type public.sp_write_observation_outcome as enum (
  'observed_requested',
  'observed_expected_after_ambiguous',
  'missing',
  'conflict'
);
create type public.sp_write_refusal_reason as enum (
  'approval_expired',
  'authorization_revoked',
  'environment_gate_closed',
  'profile_gate_closed',
  'route_mismatch',
  'stale_expected_state',
  'unsupported_provider_state',
  'lease_unavailable',
  'duplicate_intent'
);
create type public.sp_write_outbox_kind as enum ('dispatch', 'observe_and_recover');

-- -------------------------------------------------------------------------
-- Exact byte and identity helpers
-- -------------------------------------------------------------------------

create or replace function app.sp_write_sha256(p_preimage text)
returns text
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_preimage, 'UTF8')),
    'hex'
  );
$$;

create or replace function app.sp_write_exact_json_keys(
  p_value jsonb,
  p_keys text[]
)
returns boolean
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_typeof(p_value) = 'object'
     and (
       select coalesce(
         pg_catalog.array_agg(key order by key),
         array[]::text[]
       )
       from pg_catalog.jsonb_object_keys(p_value) key
     ) = (
       select pg_catalog.array_agg(key order by key)
       from pg_catalog.unnest(p_keys) key
     );
$$;

create or replace function app.sp_write_canonical_text_array(p_values text[])
returns text[]
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select coalesce(
    pg_catalog.array_agg(value order by value),
    array[]::text[]
  )
  from (
    select distinct value
    from pg_catalog.unnest(p_values) value
  ) canonical;
$$;

create or replace function app.sp_write_verified_artifact(
  p_artifact_text text,
  p_fingerprint_preimage text,
  p_domain text
)
returns jsonb
language plpgsql
immutable
strict
set search_path = pg_catalog, app, pg_temp
as $$
declare
  v_artifact jsonb;
  v_preimage jsonb;
  v_fingerprint text;
begin
  begin
    v_artifact := p_artifact_text::jsonb;
    v_preimage := p_fingerprint_preimage::jsonb;
  exception when others then
    raise exception 'SP write artifact or fingerprint preimage is not JSON'
      using errcode = '22023';
  end;

  if pg_catalog.jsonb_typeof(v_artifact) <> 'object'
     or pg_catalog.jsonb_typeof(v_preimage) <> 'array'
     or pg_catalog.jsonb_array_length(v_preimage) <> 2
     or v_preimage ->> 0 <> p_domain
     or v_preimage -> 1 <> v_artifact - 'fingerprint' then
    raise exception 'SP write artifact does not equal its % preimage', p_domain
      using errcode = '22023';
  end if;

  v_fingerprint := v_artifact ->> 'fingerprint';
  if v_fingerprint is null
     or v_fingerprint !~ '^[a-f0-9]{64}$'
     or app.sp_write_sha256(p_fingerprint_preimage) <> v_fingerprint then
    raise exception 'SP write % fingerprint mismatch', p_domain
      using errcode = '22023';
  end if;
  return v_artifact;
end;
$$;

create or replace function app.sp_write_instant(p_value timestamptz)
returns text
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select pg_catalog.to_char(
    p_value at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  );
$$;

create or replace function app.sp_write_gate_snapshot_preimage(
  p_environment_version uuid,
  p_profile_grant_id uuid,
  p_profile_grant_version uuid,
  p_checked_at timestamptz
)
returns text
language sql
immutable
strict
set search_path = pg_catalog, app
as $$
  select 'openspell.sp-write-gate-snapshot.sql.v1' || E'\n'
      || 'environment=enabled' || E'\n'
      || 'environment_version=' || pg_catalog.lower(p_environment_version::text) || E'\n'
      || 'profile_grant_id=' || pg_catalog.lower(p_profile_grant_id::text) || E'\n'
      || 'profile_grant_version=' || pg_catalog.lower(p_profile_grant_version::text) || E'\n'
      || 'checked_at=' || app.sp_write_instant(p_checked_at);
$$;

-- RFC 9562 UUIDv8. The digest supplies 128 bits, then octet 6 receives the
-- version nibble 1000 and octet 8 receives the IETF variant bits 10.
create or replace function app.sp_write_reserved_result_id(p_intent_id uuid)
returns uuid
language plpgsql
immutable
strict
set search_path = pg_catalog, app, pg_temp
as $$
declare
  v_preimage text := 'openspell.sp-write-reserved-result-id.sql.v1'
    || E'\n' || pg_catalog.lower(p_intent_id::text);
  v_bytes bytea;
  v_hex text;
begin
  v_bytes := pg_catalog.sha256(pg_catalog.convert_to(v_preimage, 'UTF8'));
  v_bytes := pg_catalog.set_byte(
    v_bytes, 6, (pg_catalog.get_byte(v_bytes, 6) & 15) | 128
  );
  v_bytes := pg_catalog.set_byte(
    v_bytes, 8, (pg_catalog.get_byte(v_bytes, 8) & 63) | 128
  );
  v_hex := pg_catalog.encode(pg_catalog.substring(v_bytes, 1, 16), 'hex');
  return (
    pg_catalog.substring(v_hex, 1, 8) || '-' ||
    pg_catalog.substring(v_hex, 9, 4) || '-' ||
    pg_catalog.substring(v_hex, 13, 4) || '-' ||
    pg_catalog.substring(v_hex, 17, 4) || '-' ||
    pg_catalog.substring(v_hex, 21, 12)
  )::uuid;
end;
$$;

-- -------------------------------------------------------------------------
-- Versioned, default-empty authority
-- -------------------------------------------------------------------------

create table public.sp_write_environment_gate_versions (
  version_id uuid primary key,
  enabled boolean not null,
  max_unresolved_calls integer not null,
  created_at timestamptz not null default clock_timestamp(),
  created_by uuid,
  constraint sp_write_environment_gate_versions_capacity_one
    check (max_unresolved_calls = 1)
);

create table public.sp_write_environment_gate_head (
  singleton boolean primary key default true,
  version_id uuid not null unique
    references public.sp_write_environment_gate_versions (version_id),
  constraint sp_write_environment_gate_head_singleton check (singleton)
);

create table public.sp_write_profile_grant_versions (
  grant_id uuid not null,
  version_id uuid primary key,
  org_id uuid not null,
  profile_id uuid not null,
  enabled boolean not null,
  amazon_profile_id text not null,
  connection_id uuid not null,
  region public.ads_region not null,
  marketplace_id text not null,
  currency_code text not null,
  api_dialect text not null,
  created_at timestamptz not null default clock_timestamp(),
  created_by uuid,
  constraint sp_write_profile_grant_versions_profile_fkey
    foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint sp_write_profile_grant_versions_scope
    check (
      amazon_profile_id <> ''
      and marketplace_id <> ''
      and currency_code ~ '^[A-Z]{3}$'
      and api_dialect = 'sp_v3'
    ),
  constraint sp_write_profile_grant_versions_identity_key
    unique (org_id, profile_id, grant_id, version_id)
);

create table public.sp_write_profile_grant_heads (
  org_id uuid not null,
  profile_id uuid not null,
  grant_id uuid not null,
  version_id uuid not null,
  primary key (org_id, profile_id),
  constraint sp_write_profile_grant_heads_version_fkey
    foreign key (org_id, profile_id, grant_id, version_id)
    references public.sp_write_profile_grant_versions
      (org_id, profile_id, grant_id, version_id) on delete cascade
);

create table public.sp_write_bounded_authorizations (
  authorization_id uuid primary key,
  artifact_text text not null,
  artifact jsonb not null,
  fingerprint_preimage text not null,
  fingerprint text not null unique,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  max_logical_changes_per_plan integer not null,
  max_provider_rows_per_plan integer not null,
  max_concurrent_mutations integer not null,
  max_cycles integer not null,
  max_executions integer not null,
  require_current_value_match boolean not null,
  require_forward_observation_before_inverse boolean not null,
  stop_on_conflict boolean not null,
  disable_after_cycle boolean not null,
  persisted_at timestamptz not null default clock_timestamp(),
  constraint sp_write_bounded_authorizations_literal_limits check (
    issued_at < expires_at
    and max_logical_changes_per_plan between 1 and 100
    and max_provider_rows_per_plan between 1 and 100
    and max_concurrent_mutations = 1
    and max_cycles = 1
    and max_executions = 2
    and require_current_value_match
    and require_forward_observation_before_inverse
    and stop_on_conflict
    and disable_after_cycle
  ),
  constraint sp_write_bounded_authorizations_fingerprint check (
    fingerprint ~ '^[a-f0-9]{64}$'
  )
);

create table public.sp_write_bounded_authorization_profiles (
  authorization_id uuid not null
    references public.sp_write_bounded_authorizations (authorization_id),
  profile_index integer not null,
  org_id uuid not null,
  profile_id uuid not null,
  amazon_profile_id text not null,
  connection_id uuid not null,
  region public.ads_region not null,
  marketplace_id text not null,
  currency_code text not null,
  api_dialect text not null,
  primary key (authorization_id, profile_index),
  constraint sp_write_bounded_authorization_profiles_profile_fkey
    foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint sp_write_bounded_authorization_profiles_identity_key
    unique (authorization_id, org_id, profile_id),
  constraint sp_write_bounded_authorization_profiles_complete_key
    unique (authorization_id, profile_index, org_id, profile_id),
  constraint sp_write_bounded_authorization_profiles_scope check (
    profile_index between 0 and 19
    and amazon_profile_id <> ''
    and marketplace_id <> ''
    and currency_code ~ '^[A-Z]{3}$'
    and api_dialect = 'sp_v3'
  )
);

create table public.sp_write_bounded_authorization_entities (
  authorization_id uuid not null,
  profile_index integer not null,
  entity_index integer not null,
  org_id uuid not null,
  profile_id uuid not null,
  route_key public.sp_write_route_key not null,
  amazon_entity_id text not null,
  allowed_change_keys text[] not null,
  max_absolute_money_delta text,
  max_absolute_placement_delta integer,
  primary key (authorization_id, profile_index, entity_index),
  constraint sp_write_bounded_authorization_entities_profile_fkey
    foreign key (authorization_id, profile_index, org_id, profile_id)
    references public.sp_write_bounded_authorization_profiles
      (authorization_id, profile_index, org_id, profile_id) on delete cascade,
  constraint sp_write_bounded_authorization_entities_identity_key
    unique (authorization_id, profile_index, route_key, amazon_entity_id),
  constraint sp_write_bounded_authorization_entities_bounds check (
    entity_index between 0 and 99
    and amazon_entity_id <> ''
    and cardinality(allowed_change_keys) between 1 and 16
    and allowed_change_keys = app.sp_write_canonical_text_array(allowed_change_keys)
    and (
      max_absolute_money_delta is null
      or max_absolute_money_delta ~ '^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{0,5}[1-9])?$'
    )
    and (
      max_absolute_placement_delta is null
      or max_absolute_placement_delta between 1 and 900
    )
  )
);

create table public.sp_write_bounded_authorization_revocations (
  revocation_id uuid primary key default gen_random_uuid(),
  authorization_id uuid not null unique
    references public.sp_write_bounded_authorizations (authorization_id),
  revoked_at timestamptz not null default clock_timestamp(),
  reason text not null check (reason = btrim(reason) and length(reason) between 1 and 160)
);

-- A bounded authorization is globally single-use even when its tenant cycle is
-- later removed by the deliberate organisation purge. This tombstone carries
-- no tenant or provider data and deliberately has no FK to the cascading cycle.
create table public.sp_write_bounded_authorization_consumptions (
  authorization_id uuid primary key,
  execution_id uuid not null,
  consumed_at timestamptz not null default clock_timestamp(),
  constraint sp_write_bounded_consumptions_authorization_fkey
    foreign key (authorization_id)
    references public.sp_write_bounded_authorizations (authorization_id),
  constraint sp_write_bounded_authorization_consumptions_execution_id_key
    unique (execution_id)
);

-- -------------------------------------------------------------------------
-- Frozen plans, approvals, cycles, and execution starts
-- -------------------------------------------------------------------------

create table public.sp_write_plans (
  plan_id uuid primary key,
  org_id uuid not null,
  profile_id uuid not null,
  direction public.sp_write_plan_direction not null,
  artifact_text text not null,
  artifact jsonb not null,
  fingerprint_preimage text not null,
  fingerprint text not null unique,
  amazon_profile_id text not null,
  connection_id uuid not null,
  region public.ads_region not null,
  marketplace_id text not null,
  currency_code text not null,
  api_dialect text not null,
  source_execution_id uuid,
  source_plan_id uuid,
  source_plan_fingerprint text,
  generated_at timestamptz not null,
  frozen_at timestamptz not null,
  expires_at timestamptz not null,
  logical_changes integer not null,
  provider_rows integer not null,
  unique_entities integer not null,
  persisted_at timestamptz not null default clock_timestamp(),
  constraint sp_write_plans_profile_fkey
    foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint sp_write_plans_tenant_identity_key unique (org_id, profile_id, plan_id),
  constraint sp_write_plans_identity_fingerprint_key
    unique (org_id, profile_id, plan_id, fingerprint),
  constraint sp_write_plans_shape check (
    fingerprint ~ '^[a-f0-9]{64}$'
    and generated_at <= frozen_at
    and frozen_at < expires_at
    and logical_changes > 0
    and provider_rows between 1 and 500
    and unique_entities between 1 and 500
    and amazon_profile_id <> ''
    and marketplace_id <> ''
    and currency_code ~ '^[A-Z]{3}$'
    and api_dialect = 'sp_v3'
    and (
      (direction = 'forward' and source_execution_id is null
        and source_plan_id is null and source_plan_fingerprint is null)
      or
      (direction = 'inverse' and source_execution_id is not null
        and source_plan_id is not null
        and source_plan_fingerprint ~ '^[a-f0-9]{64}$')
    )
  )
);

create table public.sp_write_plan_actions (
  org_id uuid not null,
  profile_id uuid not null,
  plan_id uuid not null,
  action_id uuid not null,
  action_index integer not null,
  route_key public.sp_write_route_key not null,
  amazon_entity_id text not null,
  artifact_text text not null,
  artifact jsonb not null,
  fingerprint_preimage text not null,
  fingerprint text not null,
  primary key (org_id, profile_id, plan_id, action_id),
  constraint sp_write_plan_actions_plan_fkey
    foreign key (org_id, profile_id, plan_id)
    references public.sp_write_plans (org_id, profile_id, plan_id) on delete cascade,
  constraint sp_write_plan_actions_order_key
    unique (org_id, profile_id, plan_id, action_index),
  constraint sp_write_plan_actions_entity_key
    unique (org_id, profile_id, plan_id, route_key, amazon_entity_id),
  constraint sp_write_plan_actions_complete_identity_key
    unique (
      org_id, profile_id, plan_id, action_id,
      fingerprint, route_key, amazon_entity_id
    ),
  constraint sp_write_plan_actions_position_identity_key
    unique (
      org_id, profile_id, plan_id, action_id, fingerprint, amazon_entity_id
    ),
  constraint sp_write_plan_actions_fingerprint_identity_key
    unique (org_id, profile_id, plan_id, action_id, fingerprint),
  constraint sp_write_plan_actions_shape check (
    action_index between 0 and 499
    and amazon_entity_id <> ''
    and fingerprint ~ '^[a-f0-9]{64}$'
  )
);

alter table public.sp_write_plans
  add constraint sp_write_plans_source_plan_fkey
  foreign key (org_id, profile_id, source_plan_id, source_plan_fingerprint)
  references public.sp_write_plans (org_id, profile_id, plan_id, fingerprint)
  on delete cascade;

create table public.sp_write_approval_requests (
  approval_request_id uuid primary key,
  org_id uuid not null,
  profile_id uuid not null,
  plan_id uuid not null,
  plan_fingerprint text not null,
  approval_mode public.sp_write_approval_mode not null,
  artifact_text text not null,
  artifact jsonb not null,
  bounded_authorization_id uuid
    references public.sp_write_bounded_authorizations (authorization_id),
  inverse_plan_id uuid,
  confirmation_version text not null,
  persisted_at timestamptz not null default clock_timestamp(),
  constraint sp_write_approval_requests_plan_fkey
    foreign key (org_id, profile_id, plan_id, plan_fingerprint)
    references public.sp_write_plans (org_id, profile_id, plan_id, fingerprint)
      on delete cascade,
  constraint sp_write_approval_requests_tenant_identity_key
    unique (org_id, profile_id, approval_request_id),
  constraint sp_write_approval_requests_inverse_fkey
    foreign key (org_id, profile_id, inverse_plan_id)
    references public.sp_write_plans (org_id, profile_id, plan_id) on delete cascade,
  constraint sp_write_approval_requests_mode check (
    confirmation_version = 'openspell.amazon-sp-write-confirmation.v1'
    and (
      (approval_mode = 'manual' and bounded_authorization_id is null and inverse_plan_id is null)
      or
      (approval_mode = 'bounded_live_test' and bounded_authorization_id is not null
        and inverse_plan_id is not null)
    )
  )
);

create table public.sp_write_execution_cycles (
  execution_id uuid primary key,
  org_id uuid not null,
  profile_id uuid not null,
  bounded_authorization_id uuid
    references public.sp_write_bounded_authorizations (authorization_id),
  created_at timestamptz not null default clock_timestamp(),
  constraint sp_write_execution_cycles_profile_fkey
    foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint sp_write_execution_cycles_tenant_identity_key
    unique (org_id, profile_id, execution_id)
);

create table public.sp_write_authorization_receipts (
  approval_id uuid primary key,
  org_id uuid not null,
  profile_id uuid not null,
  execution_id uuid not null,
  approval_request_id uuid not null unique,
  plan_id uuid not null,
  inverse_plan_id uuid,
  bounded_authorization_id uuid,
  generation uuid not null,
  approval_mode public.sp_write_approval_mode not null,
  artifact_text text not null,
  artifact jsonb not null,
  approved_by uuid not null references auth.users (id),
  approved_at timestamptz not null,
  expires_at timestamptz not null,
  environment_gate_version uuid not null
    references public.sp_write_environment_gate_versions (version_id),
  profile_grant_id uuid not null,
  profile_grant_version uuid not null,
  gate_snapshot_preimage text not null,
  gate_snapshot_fingerprint text not null,
  persisted_at timestamptz not null default clock_timestamp(),
  constraint sp_write_authorization_receipts_cycle_fkey
    foreign key (org_id, profile_id, execution_id)
    references public.sp_write_execution_cycles (org_id, profile_id, execution_id)
      on delete cascade,
  constraint sp_write_authorization_receipts_request_fkey
    foreign key (org_id, profile_id, approval_request_id)
    references public.sp_write_approval_requests
      (org_id, profile_id, approval_request_id) on delete cascade,
  constraint sp_write_authorization_receipts_plan_fkey
    foreign key (org_id, profile_id, plan_id)
    references public.sp_write_plans (org_id, profile_id, plan_id) on delete cascade,
  constraint sp_write_authorization_receipts_inverse_fkey
    foreign key (org_id, profile_id, inverse_plan_id)
    references public.sp_write_plans (org_id, profile_id, plan_id) on delete cascade,
  constraint sp_write_authorization_receipts_grant_fkey
    foreign key (org_id, profile_id, profile_grant_id, profile_grant_version)
    references public.sp_write_profile_grant_versions
      (org_id, profile_id, grant_id, version_id) on delete cascade,
  constraint sp_write_authorization_receipts_tenant_identity_key
    unique (org_id, profile_id, approval_id),
  constraint sp_write_authorization_receipts_generation_key
    unique (org_id, profile_id, execution_id, plan_id, approval_id, generation),
  constraint sp_write_authorization_receipts_shape check (
    approved_at < expires_at
    and gate_snapshot_fingerprint ~ '^[a-f0-9]{64}$'
    and (
      (approval_mode = 'manual' and bounded_authorization_id is null and inverse_plan_id is null)
      or
      (approval_mode = 'bounded_live_test' and bounded_authorization_id is not null
        and inverse_plan_id is not null)
    )
  )
);

create table public.sp_write_cycle_plans (
  org_id uuid not null,
  profile_id uuid not null,
  execution_id uuid not null,
  plan_id uuid not null,
  receipt_plan_id uuid not null,
  approval_id uuid not null,
  generation uuid not null,
  direction public.sp_write_plan_direction not null,
  bound_at timestamptz not null default clock_timestamp(),
  primary key (org_id, profile_id, execution_id, plan_id),
  constraint sp_write_cycle_plans_plan_fkey
    foreign key (org_id, profile_id, plan_id)
    references public.sp_write_plans (org_id, profile_id, plan_id) on delete cascade,
  constraint sp_write_cycle_plans_receipt_fkey
    foreign key (org_id, profile_id, execution_id, receipt_plan_id, approval_id, generation)
    references public.sp_write_authorization_receipts
      (org_id, profile_id, execution_id, plan_id, approval_id, generation)
      on delete cascade,
  constraint sp_write_cycle_plans_approval_generation_key
    unique (org_id, profile_id, execution_id, plan_id, approval_id, generation)
);

create table public.sp_write_execution_requests (
  org_id uuid not null,
  profile_id uuid not null,
  execution_id uuid not null,
  plan_id uuid not null,
  approval_id uuid not null,
  generation uuid not null,
  requested_at timestamptz not null default clock_timestamp(),
  primary key (org_id, profile_id, execution_id, plan_id),
  constraint sp_write_execution_requests_cycle_plan_fkey
    foreign key (
      org_id, profile_id, execution_id, plan_id, approval_id, generation
    )
    references public.sp_write_cycle_plans
      (org_id, profile_id, execution_id, plan_id, approval_id, generation)
      on delete cascade,
  constraint sp_write_execution_requests_complete_key
    unique (org_id, profile_id, execution_id, plan_id, approval_id, generation)
);

create table public.sp_write_dispatch_leases (
  lease_id uuid primary key,
  org_id uuid not null,
  profile_id uuid not null,
  execution_id uuid not null,
  plan_id uuid not null,
  approval_id uuid not null,
  generation uuid not null,
  route_key public.sp_write_route_key not null,
  acquired_at timestamptz not null,
  expires_at timestamptz not null,
  constraint sp_write_dispatch_leases_execution_fkey
    foreign key (
      org_id, profile_id, execution_id, plan_id, approval_id, generation
    )
    references public.sp_write_execution_requests
      (org_id, profile_id, execution_id, plan_id, approval_id, generation)
      on delete cascade,
  constraint sp_write_dispatch_leases_shape check (
    acquired_at < expires_at and expires_at <= acquired_at + interval '5 minutes'
  ),
  constraint sp_write_dispatch_leases_tenant_identity_key
    unique (org_id, profile_id, lease_id),
  constraint sp_write_dispatch_leases_complete_key
    unique (
      org_id, profile_id, execution_id, plan_id, approval_id, generation,
      route_key, lease_id
    )
);

-- -------------------------------------------------------------------------
-- Mutation fencing and append-only reconciliation
-- -------------------------------------------------------------------------

create table public.sp_write_predispatch_observations (
  observation_id uuid primary key,
  org_id uuid not null,
  profile_id uuid not null,
  execution_id uuid not null,
  plan_id uuid not null,
  approval_id uuid not null,
  generation uuid not null,
  route_key public.sp_write_route_key not null,
  observed_at timestamptz not null,
  valid_until timestamptz not null,
  artifact_text text not null,
  artifact jsonb not null,
  fingerprint_preimage text not null,
  fingerprint text not null unique,
  persisted_at timestamptz not null default clock_timestamp(),
  constraint sp_write_predispatch_observations_cycle_plan_fkey
    foreign key (
      org_id, profile_id, execution_id, plan_id, approval_id, generation
    )
    references public.sp_write_cycle_plans
      (org_id, profile_id, execution_id, plan_id, approval_id, generation)
      on delete cascade,
  constraint sp_write_predispatch_observations_shape check (
    fingerprint ~ '^[a-f0-9]{64}$'
    and observed_at < valid_until
    and valid_until <= observed_at + interval '2 minutes'
  ),
  constraint sp_write_predispatch_observations_tenant_identity_key
    unique (org_id, profile_id, observation_id),
  constraint sp_write_predispatch_observations_tenant_fingerprint_key
    unique (org_id, profile_id, fingerprint),
  constraint sp_write_predispatch_observations_complete_key
    unique (
      org_id, profile_id, execution_id, plan_id, approval_id, generation,
      observation_id, fingerprint, route_key
    ),
  constraint sp_write_predispatch_observations_item_parent_key
    unique (
      org_id, profile_id, execution_id, plan_id, approval_id, generation,
      observation_id, route_key
    )
);

create table public.sp_write_predispatch_observation_items (
  org_id uuid not null,
  profile_id uuid not null,
  observation_id uuid not null,
  execution_id uuid not null,
  plan_id uuid not null,
  approval_id uuid not null,
  generation uuid not null,
  item_index integer not null,
  action_id uuid not null,
  action_fingerprint text not null,
  route_key public.sp_write_route_key not null,
  amazon_entity_id text not null,
  observed jsonb not null,
  primary key (org_id, profile_id, observation_id, item_index),
  constraint sp_write_predispatch_observation_items_observation_fkey
    foreign key (
      org_id, profile_id, execution_id, plan_id, approval_id, generation,
      observation_id, route_key
    )
    references public.sp_write_predispatch_observations
      (org_id, profile_id, execution_id, plan_id, approval_id, generation,
       observation_id, route_key) on delete cascade,
  constraint sp_write_predispatch_observation_items_action_fkey
    foreign key (
      org_id, profile_id, plan_id, action_id,
      action_fingerprint, route_key, amazon_entity_id
    )
    references public.sp_write_plan_actions
      (org_id, profile_id, plan_id, action_id,
       fingerprint, route_key, amazon_entity_id) on delete cascade,
  constraint sp_write_predispatch_observation_items_action_key
    unique (org_id, profile_id, observation_id, action_id),
  constraint sp_write_predispatch_observation_items_shape check (
    item_index between 0 and 99
    and action_fingerprint ~ '^[a-f0-9]{64}$'
    and amazon_entity_id <> ''
  )
);

create table public.sp_write_predispatch_dispositions (
  disposition_id uuid primary key,
  org_id uuid not null,
  profile_id uuid not null,
  execution_id uuid not null,
  plan_id uuid not null,
  approval_id uuid not null,
  generation uuid not null,
  action_id uuid not null,
  action_fingerprint text not null,
  reason public.sp_write_refusal_reason not null,
  provider_observation_fingerprint text,
  recorded_at timestamptz not null,
  persisted_at timestamptz not null,
  artifact_text text not null,
  artifact jsonb not null,
  fingerprint_preimage text not null,
  fingerprint text not null unique,
  constraint sp_write_predispatch_dispositions_cycle_plan_fkey
    foreign key (
      org_id, profile_id, execution_id, plan_id, approval_id, generation
    )
    references public.sp_write_cycle_plans
      (org_id, profile_id, execution_id, plan_id, approval_id, generation)
      on delete cascade,
  constraint sp_write_predispatch_dispositions_action_fkey
    foreign key (org_id, profile_id, plan_id, action_id, action_fingerprint)
    references public.sp_write_plan_actions
      (org_id, profile_id, plan_id, action_id, fingerprint) on delete cascade,
  constraint sp_write_predispatch_dispositions_shape check (
    action_fingerprint ~ '^[a-f0-9]{64}$'
    and fingerprint ~ '^[a-f0-9]{64}$'
    and persisted_at >= recorded_at
    and (reason <> 'stale_expected_state' or provider_observation_fingerprint is not null)
  ),
  constraint sp_write_predispatch_dispositions_action_key
    unique (org_id, profile_id, execution_id, plan_id, action_id),
  constraint sp_write_predispatch_dispositions_complete_key
    unique (
      org_id, profile_id, execution_id, plan_id, action_id, disposition_id
    ),
  constraint sp_write_predispatch_dispositions_tenant_identity_key
    unique (org_id, profile_id, disposition_id),
  constraint sp_write_predispatch_dispositions_observation_fkey
    foreign key (org_id, profile_id, provider_observation_fingerprint)
    references public.sp_write_predispatch_observations
      (org_id, profile_id, fingerprint) on delete cascade
);

create table public.sp_write_provider_call_intents (
  intent_id uuid primary key,
  provider_call_id uuid not null unique,
  reserved_result_id uuid not null unique,
  org_id uuid not null,
  profile_id uuid not null,
  execution_id uuid not null,
  plan_id uuid not null,
  approval_id uuid not null,
  generation uuid not null,
  route_key public.sp_write_route_key not null,
  attempt_number integer not null,
  dispatch_lease_id uuid not null,
  provider_observation_fingerprint text not null,
  request_fingerprint_preimage text not null,
  request_fingerprint text not null,
  intent_fingerprint_preimage text not null,
  fingerprint text not null unique,
  artifact_text text not null,
  artifact jsonb not null,
  recorded_at timestamptz not null,
  checked_at timestamptz not null,
  dispatch_start_deadline timestamptz not null,
  provider_attempt_deadline timestamptz not null,
  constraint sp_write_provider_call_intents_cycle_plan_fkey
    foreign key (
      org_id, profile_id, execution_id, plan_id, approval_id, generation
    )
    references public.sp_write_cycle_plans
      (org_id, profile_id, execution_id, plan_id, approval_id, generation)
      on delete cascade,
  constraint sp_write_provider_call_intents_lease_fkey
    foreign key (
      org_id, profile_id, execution_id, plan_id, approval_id, generation,
      route_key, dispatch_lease_id
    )
    references public.sp_write_dispatch_leases
      (org_id, profile_id, execution_id, plan_id, approval_id, generation,
       route_key, lease_id) on delete cascade,
  constraint sp_write_provider_call_intents_observation_fkey
    foreign key (org_id, profile_id, provider_observation_fingerprint)
    references public.sp_write_predispatch_observations
      (org_id, profile_id, fingerprint) on delete cascade,
  constraint sp_write_provider_call_intents_shape check (
    attempt_number = 1
    and request_fingerprint ~ '^[a-f0-9]{64}$'
    and fingerprint ~ '^[a-f0-9]{64}$'
    and recorded_at <= checked_at
    and dispatch_start_deadline = checked_at + interval '5 seconds'
    and provider_attempt_deadline = checked_at + interval '35 seconds'
  ),
  constraint sp_write_provider_call_intents_tenant_identity_key
    unique (org_id, profile_id, intent_id),
  constraint sp_write_provider_call_intents_execution_identity_key
    unique (org_id, profile_id, execution_id, plan_id, intent_id),
  constraint sp_write_provider_call_intents_result_identity_key
    unique (org_id, profile_id, intent_id, reserved_result_id),
  constraint sp_write_provider_call_intents_provider_identity_key
    unique (
      org_id, profile_id, execution_id, plan_id, approval_id, generation,
      intent_id, provider_call_id, reserved_result_id,
      fingerprint, request_fingerprint
    ),
  constraint sp_write_provider_call_intents_result_parent_key
    unique (
      org_id, profile_id, intent_id, reserved_result_id,
      fingerprint, provider_call_id, request_fingerprint
    ),
  constraint sp_write_provider_call_intents_outbox_parent_key
    unique (
      org_id, profile_id, execution_id, plan_id, approval_id, generation,
      intent_id, provider_call_id
    )
);

create table public.sp_write_provider_call_positions (
  org_id uuid not null,
  profile_id uuid not null,
  execution_id uuid not null,
  plan_id uuid not null,
  intent_id uuid not null,
  request_index integer not null,
  action_id uuid not null,
  action_fingerprint text not null,
  amazon_entity_id text not null,
  action_request_fingerprint text not null,
  primary key (org_id, profile_id, intent_id, request_index),
  constraint sp_write_provider_call_positions_intent_fkey
    foreign key (org_id, profile_id, execution_id, plan_id, intent_id)
    references public.sp_write_provider_call_intents
      (org_id, profile_id, execution_id, plan_id, intent_id) on delete cascade,
  constraint sp_write_provider_call_positions_action_fkey
    foreign key (
      org_id, profile_id, plan_id, action_id,
      action_fingerprint, amazon_entity_id
    )
    references public.sp_write_plan_actions
      (org_id, profile_id, plan_id, action_id, fingerprint, amazon_entity_id)
      on delete cascade,
  constraint sp_write_provider_call_positions_action_key
    unique (org_id, profile_id, intent_id, action_id),
  constraint sp_write_provider_call_positions_complete_key
    unique (
      org_id, profile_id, intent_id, request_index, action_id,
      action_fingerprint, action_request_fingerprint
    ),
  constraint sp_write_provider_call_positions_resolution_key
    unique (org_id, profile_id, execution_id, plan_id, intent_id, action_id),
  constraint sp_write_provider_call_positions_shape check (
    request_index between 0 and 99
    and amazon_entity_id <> ''
    and action_fingerprint ~ '^[a-f0-9]{64}$'
    and action_request_fingerprint ~ '^[a-f0-9]{64}$'
  )
);

create table public.sp_write_action_resolutions (
  org_id uuid not null,
  profile_id uuid not null,
  execution_id uuid not null,
  plan_id uuid not null,
  action_id uuid not null,
  resolution_kind public.sp_write_action_resolution_kind not null,
  disposition_id uuid,
  intent_id uuid,
  resolved_at timestamptz not null,
  primary key (org_id, profile_id, execution_id, plan_id, action_id),
  constraint sp_write_action_resolutions_action_fkey
    foreign key (org_id, profile_id, plan_id, action_id)
    references public.sp_write_plan_actions (org_id, profile_id, plan_id, action_id)
      on delete cascade,
  constraint sp_write_action_resolutions_disposition_fkey
    foreign key (
      org_id, profile_id, execution_id, plan_id, action_id, disposition_id
    )
    references public.sp_write_predispatch_dispositions
      (org_id, profile_id, execution_id, plan_id, action_id, disposition_id)
      on delete cascade,
  constraint sp_write_action_resolutions_intent_fkey
    foreign key (
      org_id, profile_id, execution_id, plan_id, intent_id, action_id
    )
    references public.sp_write_provider_call_positions
      (org_id, profile_id, execution_id, plan_id, intent_id, action_id)
      on delete cascade,
  constraint sp_write_action_resolutions_exact_branch check (
    (resolution_kind = 'refusal' and disposition_id is not null and intent_id is null)
    or
    (resolution_kind = 'intent' and disposition_id is null and intent_id is not null)
  )
);

create table public.sp_write_provider_results (
  result_id uuid primary key,
  org_id uuid not null,
  profile_id uuid not null,
  intent_id uuid not null unique,
  origin public.sp_write_result_origin not null,
  artifact_text text not null,
  artifact jsonb not null,
  fingerprint_preimage text not null,
  fingerprint text not null unique,
  intent_fingerprint text not null,
  provider_call_id uuid not null,
  request_fingerprint text not null,
  completed_at timestamptz not null,
  persisted_at timestamptz not null default clock_timestamp(),
  constraint sp_write_provider_results_reserved_identity_fkey
    foreign key (
      org_id, profile_id, intent_id, result_id,
      intent_fingerprint, provider_call_id, request_fingerprint
    )
    references public.sp_write_provider_call_intents
      (org_id, profile_id, intent_id, reserved_result_id,
       fingerprint, provider_call_id, request_fingerprint) on delete cascade,
  constraint sp_write_provider_results_shape check (
    fingerprint ~ '^[a-f0-9]{64}$'
    and intent_fingerprint ~ '^[a-f0-9]{64}$'
    and request_fingerprint ~ '^[a-f0-9]{64}$'
    and completed_at <= persisted_at
  ),
  constraint sp_write_provider_results_tenant_identity_key
    unique (org_id, profile_id, result_id),
  constraint sp_write_provider_results_intent_identity_key
    unique (org_id, profile_id, intent_id, result_id)
);

create table public.sp_write_provider_result_positions (
  org_id uuid not null,
  profile_id uuid not null,
  result_id uuid not null,
  intent_id uuid not null,
  request_index integer not null,
  action_id uuid not null,
  action_fingerprint text not null,
  action_request_fingerprint text not null,
  outcome public.sp_write_provider_outcome not null,
  provider_entity_id text,
  code text,
  message text,
  primary key (org_id, profile_id, result_id, request_index),
  constraint sp_write_provider_result_positions_result_fkey
    foreign key (org_id, profile_id, intent_id, result_id)
    references public.sp_write_provider_results (org_id, profile_id, intent_id, result_id)
      on delete cascade,
  constraint sp_write_provider_result_positions_intent_position_fkey
    foreign key (
      org_id, profile_id, intent_id, request_index, action_id,
      action_fingerprint, action_request_fingerprint
    )
    references public.sp_write_provider_call_positions
      (org_id, profile_id, intent_id, request_index, action_id,
       action_fingerprint, action_request_fingerprint) on delete cascade,
  constraint sp_write_provider_result_positions_action_key
    unique (org_id, profile_id, result_id, action_id),
  constraint sp_write_provider_result_positions_observation_key
    unique (org_id, profile_id, result_id, intent_id, action_id),
  constraint sp_write_provider_result_positions_shape check (
    request_index between 0 and 99
    and action_fingerprint ~ '^[a-f0-9]{64}$'
    and action_request_fingerprint ~ '^[a-f0-9]{64}$'
    and (code is null or (code = btrim(code) and length(code) <= 160))
    and (message is null or (message = btrim(message) and length(message) <= 512))
    and (outcome <> 'accepted' or provider_entity_id is not null)
    and (outcome <> 'ambiguous' or provider_entity_id is null)
  )
);

create table public.sp_write_outbox (
  outbox_id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  profile_id uuid not null,
  execution_id uuid not null,
  plan_id uuid not null,
  approval_id uuid not null,
  generation uuid not null,
  kind public.sp_write_outbox_kind not null,
  provider_call_id uuid,
  intent_id uuid,
  source_sync_job_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  constraint sp_write_outbox_cycle_plan_fkey
    foreign key (
      org_id, profile_id, execution_id, plan_id, approval_id, generation
    )
    references public.sp_write_cycle_plans
      (org_id, profile_id, execution_id, plan_id, approval_id, generation)
      on delete cascade,
  constraint sp_write_outbox_intent_fkey
    foreign key (
      org_id, profile_id, execution_id, plan_id, approval_id, generation,
      intent_id, provider_call_id
    )
    references public.sp_write_provider_call_intents
      (org_id, profile_id, execution_id, plan_id, approval_id, generation,
       intent_id, provider_call_id) on delete cascade,
  constraint sp_write_outbox_kind_shape check (
    (kind = 'dispatch' and provider_call_id is null and intent_id is null
      and source_sync_job_id is null)
    or
    (kind = 'observe_and_recover' and provider_call_id is not null
      and intent_id is not null and source_sync_job_id is not null)
  ),
  constraint sp_write_outbox_dispatch_key
    unique nulls not distinct (org_id, profile_id, execution_id, plan_id, kind, provider_call_id),
  constraint sp_write_outbox_source_sync_job_key
    unique (org_id, profile_id, source_sync_job_id),
  constraint sp_write_outbox_source_identity_key
    unique nulls not distinct (
      org_id, profile_id, execution_id, plan_id, approval_id, generation,
      intent_id, provider_call_id, source_sync_job_id
    ),
  constraint sp_write_outbox_tenant_identity_key unique (org_id, profile_id, outbox_id)
);

create table public.sp_write_observations (
  observation_id uuid primary key,
  org_id uuid not null,
  profile_id uuid not null,
  execution_id uuid not null,
  plan_id uuid not null,
  approval_id uuid not null,
  generation uuid not null,
  intent_id uuid not null,
  result_id uuid not null,
  provider_call_id uuid not null,
  action_id uuid not null,
  action_fingerprint text not null,
  intent_fingerprint text not null,
  request_fingerprint text not null,
  route_key public.sp_write_route_key not null,
  source_sync_job_id uuid not null,
  outcome public.sp_write_observation_outcome not null,
  observed jsonb,
  observed_at timestamptz not null,
  artifact_text text not null,
  artifact jsonb not null,
  fingerprint_preimage text not null,
  fingerprint text not null unique,
  persisted_at timestamptz not null default clock_timestamp(),
  constraint sp_write_observations_cycle_plan_fkey
    foreign key (
      org_id, profile_id, execution_id, plan_id, approval_id, generation
    )
    references public.sp_write_cycle_plans
      (org_id, profile_id, execution_id, plan_id, approval_id, generation)
      on delete cascade,
  constraint sp_write_observations_result_fkey
    foreign key (org_id, profile_id, intent_id, result_id)
    references public.sp_write_provider_results (org_id, profile_id, intent_id, result_id)
      on delete cascade,
  constraint sp_write_observations_source_job_fkey
    foreign key (
      org_id, profile_id, execution_id, plan_id, approval_id, generation,
      intent_id, provider_call_id, source_sync_job_id
    )
    references public.sp_write_outbox
      (org_id, profile_id, execution_id, plan_id, approval_id, generation,
       intent_id, provider_call_id, source_sync_job_id) on delete cascade,
  constraint sp_write_observations_result_position_fkey
    foreign key (org_id, profile_id, result_id, intent_id, action_id)
    references public.sp_write_provider_result_positions
      (org_id, profile_id, result_id, intent_id, action_id) on delete cascade,
  constraint sp_write_observations_action_key
    unique (org_id, profile_id, execution_id, plan_id, action_id),
  constraint sp_write_observations_shape check (
    fingerprint ~ '^[a-f0-9]{64}$'
    and action_fingerprint ~ '^[a-f0-9]{64}$'
    and intent_fingerprint ~ '^[a-f0-9]{64}$'
    and request_fingerprint ~ '^[a-f0-9]{64}$'
    and ((outcome = 'missing') = (observed is null))
    and observed_at <= persisted_at
  ),
  constraint sp_write_observations_tenant_identity_key
    unique (org_id, profile_id, observation_id)
);

create table public.sp_write_late_result_audits (
  audit_id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  profile_id uuid not null,
  intent_id uuid not null,
  result_id uuid not null,
  submitted_fingerprint text not null,
  completed_at timestamptz not null,
  position_count integer not null,
  diagnostic_codes text[] not null,
  persisted_at timestamptz not null default clock_timestamp(),
  constraint sp_write_late_result_audits_canonical_result_fkey
    foreign key (org_id, profile_id, intent_id, result_id)
    references public.sp_write_provider_results (org_id, profile_id, intent_id, result_id)
      on delete cascade,
  constraint sp_write_late_result_audits_shape check (
    submitted_fingerprint ~ '^[a-f0-9]{64}$'
    and position_count between 1 and 100
    and cardinality(diagnostic_codes) <= 100
    and completed_at <= persisted_at
  ),
  constraint sp_write_late_result_audits_submission_key
    unique (org_id, profile_id, intent_id, submitted_fingerprint)
);

create index sp_write_intents_open_capacity_idx
  on public.sp_write_provider_call_intents (checked_at, intent_id);
create index sp_write_positions_entity_fence_idx
  on public.sp_write_provider_call_positions
    (org_id, profile_id, amazon_entity_id, intent_id);
create index sp_write_results_intent_idx
  on public.sp_write_provider_results (intent_id);
create index sp_write_observations_intent_action_idx
  on public.sp_write_observations (intent_id, action_id);

-- -------------------------------------------------------------------------
-- Verified staging capabilities
-- -------------------------------------------------------------------------

create or replace function app.sp_write_action_entity_id(p_action jsonb)
returns text
language plpgsql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
begin
  case p_action ->> 'routeKey'
    when 'sp.v3.campaigns.update' then return p_action #>> '{entity,campaignId}';
    when 'sp.v3.ad_groups.update' then return p_action #>> '{entity,adGroupId}';
    when 'sp.v3.keywords.update' then return p_action #>> '{entity,keywordId}';
    when 'sp.v3.targets.update' then return p_action #>> '{entity,targetId}';
    when 'sp.v3.product_ads.update' then return p_action #>> '{entity,productAdId}';
    else raise exception 'unsupported SP write route' using errcode = '22023';
  end case;
end;
$$;

create or replace function app.sp_write_plan_binding(p_plan jsonb)
returns jsonb
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'planId', p_plan -> 'id',
    'planFingerprint', p_plan -> 'fingerprint',
    'orgId', p_plan -> 'orgId',
    'profileId', p_plan -> 'profileId',
    'providerScope', p_plan -> 'providerScope',
    'direction', p_plan -> 'direction',
    'expiresAt', p_plan -> 'expiresAt',
    'counts', p_plan -> 'counts'
  );
$$;

create or replace function app.sp_write_verified_bounded_authorization(
  p_artifact_text text,
  p_fingerprint_preimage text
)
returns jsonb
language plpgsql
immutable
strict
set search_path = pg_catalog, app, pg_temp
as $$
declare
  v_artifact jsonb;
  v_preimage jsonb;
  v_body jsonb;
begin
  begin
    v_artifact := p_artifact_text::jsonb;
    v_preimage := p_fingerprint_preimage::jsonb;
  exception when others then
    raise exception 'SP write bounded authorization is not JSON' using errcode = '22023';
  end;
  if pg_catalog.jsonb_typeof(v_artifact) <> 'object'
     or pg_catalog.jsonb_typeof(v_preimage) <> 'array'
     or pg_catalog.jsonb_array_length(v_preimage) <> 2
     or v_preimage ->> 0 <> 'openspell.sp-write-bounded-authorization.v1'
     or app.sp_write_sha256(p_fingerprint_preimage) <> v_artifact ->> 'fingerprint' then
    raise exception 'SP write bounded authorization fingerprint mismatch'
      using errcode = '22023';
  end if;
  v_body := v_preimage -> 1;
  if v_body - 'profiles' <> v_artifact - 'fingerprint' - 'profiles'
     or pg_catalog.jsonb_typeof(v_body -> 'profiles') <> 'array'
     or pg_catalog.jsonb_typeof(v_artifact -> 'profiles') <> 'array'
     or pg_catalog.jsonb_array_length(v_body -> 'profiles')
        <> pg_catalog.jsonb_array_length(v_artifact -> 'profiles')
     or exists (
       select 1
       from pg_catalog.jsonb_array_elements(v_artifact -> 'profiles') a(profile)
       where (
         select count(*)
         from pg_catalog.jsonb_array_elements(v_body -> 'profiles') b(profile)
         where b.profile -> 'providerScope' = a.profile -> 'providerScope'
           and not exists (
             select 1
             from pg_catalog.jsonb_array_elements(a.profile -> 'allowedEntities') ae(entity)
             where not exists (
               select 1
               from pg_catalog.jsonb_array_elements(b.profile -> 'allowedEntities') be(entity)
               where be.entity = ae.entity
             )
           )
           and not exists (
             select 1
             from pg_catalog.jsonb_array_elements(b.profile -> 'allowedEntities') be(entity)
             where not exists (
               select 1
               from pg_catalog.jsonb_array_elements(a.profile -> 'allowedEntities') ae(entity)
               where ae.entity = be.entity
             )
           )
       ) <> 1
     ) then
    raise exception 'SP write bounded authorization does not equal its canonical preimage'
      using errcode = '22023';
  end if;
  return v_artifact;
end;
$$;

create or replace function app.record_sp_write_plan(
  p_plan_text text,
  p_plan_fingerprint_preimage text,
  p_action_proofs jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_plan jsonb;
  v_action jsonb;
  v_proof jsonb;
  v_action_text text;
  v_action_preimage text;
  v_org_id uuid;
  v_profile_id uuid;
  v_plan_id uuid;
  v_direction public.sp_write_plan_direction;
  v_route public.sp_write_route_key;
  v_entity_id text;
  v_index integer;
  v_inserted integer := 0;
  v_logical_changes integer := 0;
  v_existing public.sp_write_plans%rowtype;
begin
  perform app.assert_service_role('record_sp_write_plan');
  v_plan := app.sp_write_verified_artifact(
    p_plan_text, p_plan_fingerprint_preimage, 'openspell.sp-write-plan.v1'
  );
  if not app.sp_write_exact_json_keys(v_plan, array[
    'schemaVersion','id','orgId','profileId','providerScope','direction','source',
    'generatedAt','frozenAt','expiresAt','actions','counts','fingerprint'
  ])
     or v_plan ->> 'schemaVersion' <> 'openspell.sp-write-plan.v1'
     or not app.sp_write_exact_json_keys(v_plan -> 'providerScope', array[
       'amazonProfileId','connectionId','region','marketplaceId','currencyCode','apiDialect'
     ])
     or pg_catalog.jsonb_typeof(v_plan -> 'actions') <> 'array'
     or pg_catalog.jsonb_typeof(p_action_proofs) <> 'array'
     or pg_catalog.jsonb_array_length(v_plan -> 'actions')
        <> pg_catalog.jsonb_array_length(p_action_proofs) then
    raise exception 'SP write plan relational shape mismatch' using errcode = '22023';
  end if;

  begin
    v_org_id := (v_plan ->> 'orgId')::uuid;
    v_profile_id := (v_plan ->> 'profileId')::uuid;
    v_plan_id := (v_plan ->> 'id')::uuid;
    v_direction := (v_plan ->> 'direction')::public.sp_write_plan_direction;
  exception when others then
    raise exception 'SP write plan identity is invalid' using errcode = '22023';
  end;

  select * into v_existing from public.sp_write_plans where plan_id = v_plan_id;
  if found then
    raise exception 'SP write plan identity collision' using errcode = '23505';
  end if;

  insert into public.sp_write_plans (
    plan_id, org_id, profile_id, direction, artifact_text, artifact,
    fingerprint_preimage, fingerprint, amazon_profile_id, connection_id,
    region, marketplace_id, currency_code, api_dialect,
    source_execution_id, source_plan_id, source_plan_fingerprint,
    generated_at, frozen_at, expires_at, logical_changes, provider_rows,
    unique_entities
  ) values (
    v_plan_id, v_org_id, v_profile_id, v_direction, p_plan_text, v_plan,
    p_plan_fingerprint_preimage, v_plan ->> 'fingerprint',
    v_plan #>> '{providerScope,amazonProfileId}',
    (v_plan #>> '{providerScope,connectionId}')::uuid,
    (v_plan #>> '{providerScope,region}')::public.ads_region,
    v_plan #>> '{providerScope,marketplaceId}',
    v_plan #>> '{providerScope,currencyCode}',
    v_plan #>> '{providerScope,apiDialect}',
    case when v_direction = 'inverse'
      then (v_plan #>> '{source,sourceExecutionId}')::uuid end,
    case when v_direction = 'inverse'
      then (v_plan #>> '{source,sourcePlanId}')::uuid end,
    case when v_direction = 'inverse'
      then v_plan #>> '{source,sourcePlanFingerprint}' end,
    (v_plan ->> 'generatedAt')::timestamptz,
    (v_plan ->> 'frozenAt')::timestamptz,
    (v_plan ->> 'expiresAt')::timestamptz,
    (v_plan #>> '{counts,logicalChanges}')::integer,
    (v_plan #>> '{counts,providerRows}')::integer,
    (v_plan #>> '{counts,uniqueEntities}')::integer
  );

  for v_action, v_index in
    select value, (ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(v_plan -> 'actions') with ordinality
  loop
    v_proof := p_action_proofs -> v_index;
    if not app.sp_write_exact_json_keys(v_proof, array['artifactText','fingerprintPreimage']) then
      raise exception 'SP write action proof shape mismatch' using errcode = '22023';
    end if;
    v_action_text := v_proof ->> 'artifactText';
    v_action_preimage := v_proof ->> 'fingerprintPreimage';
    if v_action_text::jsonb <> v_action then
      raise exception 'SP write action text differs from nested plan action'
        using errcode = '22023';
    end if;
    v_action := app.sp_write_verified_artifact(
      v_action_text, v_action_preimage, 'openspell.sp-write-action.v1'
    );
    if not app.sp_write_exact_json_keys(
      v_action, array['actionId','sources','fingerprint','routeKey','entity','changes']
    ) or pg_catalog.jsonb_typeof(v_action -> 'sources') <> 'array' then
      raise exception 'SP write action relational shape mismatch' using errcode = '22023';
    end if;
    v_route := (v_action ->> 'routeKey')::public.sp_write_route_key;
    v_entity_id := app.sp_write_action_entity_id(v_action);
    if v_entity_id is null or v_entity_id = '' then
      raise exception 'SP write action entity is empty' using errcode = '22023';
    end if;
    insert into public.sp_write_plan_actions (
      org_id, profile_id, plan_id, action_id, action_index, route_key,
      amazon_entity_id, artifact_text, artifact, fingerprint_preimage, fingerprint
    ) values (
      v_org_id, v_profile_id, v_plan_id, (v_action ->> 'actionId')::uuid,
      v_index, v_route, v_entity_id, v_action_text, v_action,
      v_action_preimage, v_action ->> 'fingerprint'
    );
    v_inserted := v_inserted + 1;
    v_logical_changes := v_logical_changes
      + pg_catalog.jsonb_array_length(v_action -> 'sources');
  end loop;

  if v_inserted <> (v_plan #>> '{counts,providerRows}')::integer
     or v_logical_changes <> (v_plan #>> '{counts,logicalChanges}')::integer
     or v_inserted <> (v_plan #>> '{counts,uniqueEntities}')::integer
     or exists (
       select 1
       from pg_catalog.jsonb_each_text(v_plan #> '{counts,byRoute}') expected(route, count)
       where (
         select count(*)
         from public.sp_write_plan_actions action
         where action.org_id = v_org_id and action.profile_id = v_profile_id
           and action.plan_id = v_plan_id and action.route_key::text = expected.route
       ) <> expected.count::integer
     ) then
    raise exception 'SP write plan action counts do not close' using errcode = '22023';
  end if;
  return v_plan_id;
end;
$$;

create or replace function app.record_sp_write_bounded_authorization(
  p_authorization_text text,
  p_fingerprint_preimage text,
  p_profile_bindings jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_authorization jsonb;
  v_profile jsonb;
  v_binding jsonb;
  v_entity jsonb;
  v_authorization_id uuid;
  v_org_id uuid;
  v_profile_id uuid;
  v_profile_index integer;
  v_entity_index integer;
  v_profile_count integer := 0;
  v_entity_count integer := 0;
  v_offered_entity_count integer := 0;
  v_existing public.sp_write_bounded_authorizations%rowtype;
begin
  perform app.assert_service_role('record_sp_write_bounded_authorization');
  v_authorization := app.sp_write_verified_bounded_authorization(
    p_authorization_text, p_fingerprint_preimage
  );
  if not app.sp_write_exact_json_keys(v_authorization, array[
    'schemaVersion','authorizationId','issuedAt','expiresAt','profiles','constraints','fingerprint'
  ])
     or v_authorization ->> 'schemaVersion'
        <> 'openspell.sp-write-bounded-authorization.v1'
     or pg_catalog.jsonb_typeof(p_profile_bindings) <> 'array'
     or pg_catalog.jsonb_array_length(p_profile_bindings)
        <> pg_catalog.jsonb_array_length(v_authorization -> 'profiles') then
    raise exception 'SP write bounded authorization relational shape mismatch'
      using errcode = '22023';
  end if;
  v_authorization_id := (v_authorization ->> 'authorizationId')::uuid;
  select * into v_existing
  from public.sp_write_bounded_authorizations
  where authorization_id = v_authorization_id;
  if found then
    raise exception 'SP write bounded authorization identity collision'
      using errcode = '23505';
  end if;

  insert into public.sp_write_bounded_authorizations (
    authorization_id, artifact_text, artifact, fingerprint_preimage, fingerprint,
    issued_at, expires_at, max_logical_changes_per_plan,
    max_provider_rows_per_plan, max_concurrent_mutations, max_cycles,
    max_executions, require_current_value_match,
    require_forward_observation_before_inverse, stop_on_conflict,
    disable_after_cycle
  ) values (
    v_authorization_id, p_authorization_text, v_authorization,
    p_fingerprint_preimage, v_authorization ->> 'fingerprint',
    (v_authorization ->> 'issuedAt')::timestamptz,
    (v_authorization ->> 'expiresAt')::timestamptz,
    (v_authorization #>> '{constraints,maxLogicalChangesPerPlan}')::integer,
    (v_authorization #>> '{constraints,maxProviderRowsPerPlan}')::integer,
    (v_authorization #>> '{constraints,maxConcurrentMutations}')::integer,
    (v_authorization #>> '{constraints,maxCycles}')::integer,
    (v_authorization #>> '{constraints,maxExecutions}')::integer,
    (v_authorization #>> '{constraints,requireCurrentValueMatch}')::boolean,
    (v_authorization #>> '{constraints,requireForwardObservationBeforeInverse}')::boolean,
    (v_authorization #>> '{constraints,stopOnConflict}')::boolean,
    (v_authorization #>> '{constraints,disableAfterCycle}')::boolean
  );

  for v_profile, v_profile_index in
    select value, (ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(v_authorization -> 'profiles') with ordinality
  loop
    v_binding := p_profile_bindings -> v_profile_index;
    if not app.sp_write_exact_json_keys(v_binding, array['orgId','profileId']) then
      raise exception 'SP write authorization profile binding mismatch'
        using errcode = '22023';
    end if;
    v_org_id := (v_binding ->> 'orgId')::uuid;
    v_profile_id := (v_binding ->> 'profileId')::uuid;
    if not exists (
      select 1 from public.ad_profiles profile
      where profile.org_id = v_org_id and profile.id = v_profile_id
        and profile.amazon_profile_id = v_profile #>> '{providerScope,amazonProfileId}'
        and profile.connection_id = (v_profile #>> '{providerScope,connectionId}')::uuid
        and profile.region::text = v_profile #>> '{providerScope,region}'
        and profile.currency_code = v_profile #>> '{providerScope,currencyCode}'
    ) then
      raise exception 'SP write authorization profile does not match the live route'
        using errcode = '22023';
    end if;
    insert into public.sp_write_bounded_authorization_profiles (
      authorization_id, profile_index, org_id, profile_id, amazon_profile_id,
      connection_id, region, marketplace_id, currency_code, api_dialect
    ) values (
      v_authorization_id, v_profile_index, v_org_id, v_profile_id,
      v_profile #>> '{providerScope,amazonProfileId}',
      (v_profile #>> '{providerScope,connectionId}')::uuid,
      (v_profile #>> '{providerScope,region}')::public.ads_region,
      v_profile #>> '{providerScope,marketplaceId}',
      v_profile #>> '{providerScope,currencyCode}',
      v_profile #>> '{providerScope,apiDialect}'
    );
    v_profile_count := v_profile_count + 1;
    v_offered_entity_count := v_offered_entity_count
      + pg_catalog.jsonb_array_length(v_profile -> 'allowedEntities');
    for v_entity, v_entity_index in
      select value, (ordinality - 1)::integer
      from pg_catalog.jsonb_array_elements(v_profile -> 'allowedEntities') with ordinality
    loop
      insert into public.sp_write_bounded_authorization_entities (
        authorization_id, profile_index, entity_index, org_id, profile_id,
        route_key, amazon_entity_id, allowed_change_keys,
        max_absolute_money_delta, max_absolute_placement_delta
      ) values (
        v_authorization_id, v_profile_index, v_entity_index, v_org_id, v_profile_id,
        (v_entity ->> 'routeKey')::public.sp_write_route_key,
        v_entity ->> 'amazonEntityId',
        array(
          select pg_catalog.jsonb_array_elements_text(v_entity -> 'allowedChangeKeys')
        ),
        v_entity ->> 'maxAbsoluteMoneyDelta',
        (v_entity ->> 'maxAbsolutePlacementDelta')::integer
      );
      v_entity_count := v_entity_count + 1;
    end loop;
    if (
      select count(*)
      from public.sp_write_bounded_authorization_entities entity
      where entity.authorization_id = v_authorization_id
        and entity.profile_index = v_profile_index
    ) <> pg_catalog.jsonb_array_length(v_profile -> 'allowedEntities') then
      raise exception 'SP write bounded authorization entity count does not close'
        using errcode = '22023';
    end if;
  end loop;
  if v_profile_count <> pg_catalog.jsonb_array_length(v_authorization -> 'profiles')
     or v_profile_count <> (
       select count(*) from public.sp_write_bounded_authorization_profiles profile
       where profile.authorization_id = v_authorization_id
     )
     or v_entity_count <> v_offered_entity_count
     or v_entity_count <> (
       select count(*) from public.sp_write_bounded_authorization_entities entity
       where entity.authorization_id = v_authorization_id
     ) then
    raise exception 'SP write bounded authorization counts do not close'
      using errcode = '22023';
  end if;
  return v_authorization_id;
end;
$$;

create or replace function app.sp_write_enforce_cycle_plan_binding()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_receipt public.sp_write_authorization_receipts%rowtype;
  v_direction public.sp_write_plan_direction;
begin
  select * into strict v_receipt
  from public.sp_write_authorization_receipts receipt
  where receipt.org_id = new.org_id
    and receipt.profile_id = new.profile_id
    and receipt.execution_id = new.execution_id
    and receipt.approval_id = new.approval_id
    and receipt.generation = new.generation;
  if new.receipt_plan_id <> v_receipt.plan_id
     or new.plan_id not in (v_receipt.plan_id, v_receipt.inverse_plan_id) then
    raise exception 'SP write cycle plan is not bound by its exact receipt'
      using errcode = '23503';
  end if;
  select plan.direction into strict v_direction
  from public.sp_write_plans plan
  where plan.org_id = new.org_id and plan.profile_id = new.profile_id
    and plan.plan_id = new.plan_id;
  if v_direction <> new.direction then
    raise exception 'SP write cycle plan direction mismatch' using errcode = '23503';
  end if;
  return new;
end;
$$;

create trigger sp_write_cycle_plans_exact_binding
before insert on public.sp_write_cycle_plans
for each row execute function app.sp_write_enforce_cycle_plan_binding();

create or replace function app.approve_sp_write_cycle(
  p_plan_id uuid,
  p_approval_request_text text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, app, auth, pg_temp
as $$
declare
  v_plan public.sp_write_plans%rowtype;
  v_inverse public.sp_write_plans%rowtype;
  v_request jsonb;
  v_actor uuid := auth.uid();
  v_environment public.sp_write_environment_gate_versions%rowtype;
  v_grant public.sp_write_profile_grant_versions%rowtype;
  v_authorization public.sp_write_bounded_authorizations%rowtype;
  v_approval_id uuid := gen_random_uuid();
  v_execution_id uuid;
  v_generation uuid := gen_random_uuid();
  v_checked_at timestamptz;
  v_expires_at timestamptz;
  v_gate_preimage text;
  v_gate_fingerprint text;
  v_receipt jsonb;
  v_expected_authorization_binding jsonb;
begin
  if v_actor is null then
    raise exception 'SP write approval requires an authenticated actor'
      using errcode = '42501';
  end if;
  select * into strict v_plan from public.sp_write_plans where plan_id = p_plan_id;
  if not app.has_org_role(v_plan.org_id, array['owner','admin']) then
    raise exception 'SP write approval requires owner or admin'
      using errcode = '42501';
  end if;
  begin
    v_request := p_approval_request_text::jsonb;
  exception when others then
    raise exception 'SP write approval request is not JSON' using errcode = '22023';
  end;
  if not app.sp_write_exact_json_keys(v_request, array[
    'approvalRequestId','plan','approvalMode','confirmationVersion',
    'boundedAuthorization','preapprovedInversePlan'
  ])
     or v_request ->> 'confirmationVersion'
        <> 'openspell.amazon-sp-write-confirmation.v1'
     or v_request ->> 'approvalRequestId'
        <> pg_catalog.lower(((v_request ->> 'approvalRequestId')::uuid)::text)
     or v_request -> 'plan' <> app.sp_write_plan_binding(v_plan.artifact)
     or v_request ->> 'approvalMode' not in ('manual','bounded_live_test') then
    raise exception 'SP write approval request does not bind the exact plan'
      using errcode = '22023';
  end if;

  -- Global head, then profile head. Every future authority mutator must use
  -- this same order before touching bounded authorization or cycle rows.
  select version.* into v_environment
  from public.sp_write_environment_gate_head head
  join public.sp_write_environment_gate_versions version
    on version.version_id = head.version_id
  where head.singleton
  for update of head, version;
  if not found or not v_environment.enabled then
    raise exception 'SP write environment gate is closed' using errcode = '55000';
  end if;

  select version.* into v_grant
  from public.sp_write_profile_grant_heads head
  join public.sp_write_profile_grant_versions version
    on version.org_id = head.org_id and version.profile_id = head.profile_id
   and version.grant_id = head.grant_id and version.version_id = head.version_id
  where head.org_id = v_plan.org_id and head.profile_id = v_plan.profile_id
  for update of head, version;
  if not found or not v_grant.enabled
     or v_grant.amazon_profile_id <> v_plan.amazon_profile_id
     or v_grant.connection_id <> v_plan.connection_id
     or v_grant.region <> v_plan.region
     or v_grant.marketplace_id <> v_plan.marketplace_id
     or v_grant.currency_code <> v_plan.currency_code
     or v_grant.api_dialect <> v_plan.api_dialect then
    raise exception 'SP write profile grant is closed or mismatched'
      using errcode = '55000';
  end if;

  if v_request ->> 'approvalMode' = 'manual' then
    v_checked_at := clock_timestamp();
    if v_checked_at < v_plan.frozen_at or v_checked_at >= v_plan.expires_at then
      raise exception 'SP write plan is expired' using errcode = '55000';
    end if;
    if v_request -> 'boundedAuthorization' <> 'null'::jsonb
       or v_request -> 'preapprovedInversePlan' <> 'null'::jsonb then
      raise exception 'manual SP write approval cannot preapprove an inverse'
        using errcode = '22023';
    end if;
    if v_plan.direction = 'forward' then
      v_execution_id := gen_random_uuid();
      insert into public.sp_write_execution_cycles (
        execution_id, org_id, profile_id, bounded_authorization_id, created_at
      ) values (v_execution_id, v_plan.org_id, v_plan.profile_id, null, v_checked_at);
    else
      v_execution_id := v_plan.source_execution_id;
      if not exists (
        select 1
        from public.sp_write_execution_cycles cycle
        join public.sp_write_cycle_plans child
          on child.org_id = cycle.org_id and child.profile_id = cycle.profile_id
         and child.execution_id = cycle.execution_id
        where cycle.org_id = v_plan.org_id and cycle.profile_id = v_plan.profile_id
          and cycle.execution_id = v_execution_id
          and child.plan_id = v_plan.source_plan_id and child.direction = 'forward'
      ) then
        raise exception 'manual inverse does not join its frozen source cycle'
          using errcode = '22023';
      end if;
    end if;
    v_expires_at := v_plan.expires_at;
  else
    if v_plan.direction <> 'forward'
       or v_request -> 'boundedAuthorization' = 'null'::jsonb
       or v_request -> 'preapprovedInversePlan' = 'null'::jsonb then
      raise exception 'bounded SP write approval requires forward, inverse, and authorization'
        using errcode = '22023';
    end if;
    select * into strict v_inverse
    from public.sp_write_plans inverse
    where inverse.plan_id = (v_request #>> '{preapprovedInversePlan,planId}')::uuid
      and inverse.org_id = v_plan.org_id and inverse.profile_id = v_plan.profile_id;
    if v_request -> 'preapprovedInversePlan' <> app.sp_write_plan_binding(v_inverse.artifact)
       or v_inverse.direction <> 'inverse'
       or v_inverse.source_plan_id <> v_plan.plan_id
       or v_inverse.source_plan_fingerprint <> v_plan.fingerprint
       or v_inverse.amazon_profile_id <> v_plan.amazon_profile_id
       or v_inverse.connection_id <> v_plan.connection_id
       or v_inverse.region <> v_plan.region
       or v_inverse.marketplace_id <> v_plan.marketplace_id
       or v_inverse.currency_code <> v_plan.currency_code
       or v_inverse.logical_changes <> v_plan.logical_changes
       or v_inverse.provider_rows <> v_plan.provider_rows
       or v_inverse.unique_entities <> v_plan.unique_entities then
      raise exception 'bounded SP write inverse binding mismatch' using errcode = '22023';
    end if;
    select * into strict v_authorization
    from public.sp_write_bounded_authorizations bounded
    where bounded.authorization_id =
      (v_request #>> '{boundedAuthorization,authorizationId}')::uuid
    for update;
    v_checked_at := clock_timestamp();
    if v_checked_at < v_plan.frozen_at or v_checked_at >= v_plan.expires_at then
      raise exception 'SP write plan is expired' using errcode = '55000';
    end if;
    v_expected_authorization_binding := pg_catalog.jsonb_build_object(
      'authorizationId', v_authorization.authorization_id::text,
      'authorizationFingerprint', v_authorization.fingerprint,
      'expiresAt', v_authorization.artifact -> 'expiresAt'
    );
    if v_request -> 'boundedAuthorization' <> v_expected_authorization_binding
       or v_checked_at < v_authorization.issued_at
       or v_checked_at >= v_authorization.expires_at
       or exists (
         select 1 from public.sp_write_bounded_authorization_revocations revocation
         where revocation.authorization_id = v_authorization.authorization_id
       )
       or not exists (
         select 1 from public.sp_write_bounded_authorization_profiles profile
         where profile.authorization_id = v_authorization.authorization_id
           and profile.org_id = v_plan.org_id and profile.profile_id = v_plan.profile_id
           and profile.amazon_profile_id = v_plan.amazon_profile_id
           and profile.connection_id = v_plan.connection_id
           and profile.region = v_plan.region
           and profile.marketplace_id = v_plan.marketplace_id
           and profile.currency_code = v_plan.currency_code
       )
       or v_plan.logical_changes > v_authorization.max_logical_changes_per_plan
       or v_plan.provider_rows > v_authorization.max_provider_rows_per_plan
       or v_plan.expires_at > v_authorization.expires_at
       or v_inverse.expires_at > v_authorization.expires_at then
      raise exception 'bounded SP write authorization is not current for exact plans'
        using errcode = '55000';
    end if;
    if exists (
      select 1
      from public.sp_write_plan_actions action
      where action.org_id = v_plan.org_id
        and action.profile_id = v_plan.profile_id
        and action.plan_id = v_plan.plan_id
        and not app.sp_write_action_within_bounded_authorization(
          v_authorization.authorization_id,
          v_plan.org_id,
          v_plan.profile_id,
          action.artifact
        )
    ) then
      raise exception 'bounded SP write authorization does not permit every plan action'
        using errcode = '55000';
    end if;
    if not app.sp_write_inverse_pair_exact(v_plan.plan_id, v_inverse.plan_id) then
      raise exception 'bounded SP write inverse does not exactly swap every plan action'
        using errcode = '55000';
    end if;
    v_execution_id := v_inverse.source_execution_id;
    if exists (
      select 1 from public.sp_write_bounded_authorization_consumptions consumption
      where consumption.authorization_id = v_authorization.authorization_id
         or consumption.execution_id = v_execution_id
    ) or exists (
      select 1 from public.sp_write_execution_cycles cycle
      where cycle.execution_id = v_execution_id
    ) then
      raise exception 'bounded SP write authorization already consumed its cycle'
        using errcode = '55000';
    end if;
    insert into public.sp_write_bounded_authorization_consumptions (
      authorization_id, execution_id, consumed_at
    ) values (
      v_authorization.authorization_id, v_execution_id, v_checked_at
    );
    if (
      select count(*)
      from public.sp_write_bounded_authorization_consumptions consumption
      where consumption.authorization_id = v_authorization.authorization_id
        and consumption.execution_id = v_execution_id
    ) <> 1 then
      raise exception 'bounded SP write authorization consumption count does not close'
        using errcode = '22023';
    end if;
    insert into public.sp_write_execution_cycles (
      execution_id, org_id, profile_id, bounded_authorization_id, created_at
    ) values (
      v_execution_id, v_plan.org_id, v_plan.profile_id,
      v_authorization.authorization_id, v_checked_at
    );
    v_expires_at := least(
      v_plan.expires_at, v_inverse.expires_at, v_authorization.expires_at
    );
  end if;

  v_gate_preimage := app.sp_write_gate_snapshot_preimage(
    v_environment.version_id, v_grant.grant_id, v_grant.version_id, v_checked_at
  );
  v_gate_fingerprint := app.sp_write_sha256(v_gate_preimage);
  v_receipt := pg_catalog.jsonb_build_object(
    'schemaVersion', 'openspell.sp-write-authorization-receipt.v1',
    'approvalId', v_approval_id::text,
    'approvalRequestId', v_request -> 'approvalRequestId',
    'executionId', v_execution_id::text,
    'generation', v_generation::text,
    'approvalMode', v_request -> 'approvalMode',
    'plan', v_request -> 'plan',
    'preapprovedInversePlan', v_request -> 'preapprovedInversePlan',
    'boundedAuthorization', v_request -> 'boundedAuthorization',
    'approvedBy', v_actor::text,
    'approvedAt', app.sp_write_instant(v_checked_at),
    'expiresAt', app.sp_write_instant(v_expires_at),
    'confirmationVersion', v_request -> 'confirmationVersion',
    'gateSnapshot', pg_catalog.jsonb_build_object(
      'environmentGate', 'enabled',
      'environmentGateVersion', v_environment.version_id::text,
      'profileGrantId', v_grant.grant_id::text,
      'profileGrantVersion', v_grant.version_id::text,
      'gateSnapshotFingerprint', v_gate_fingerprint,
      'checkedAt', app.sp_write_instant(v_checked_at)
    )
  );

  insert into public.sp_write_approval_requests (
    approval_request_id, org_id, profile_id, plan_id, plan_fingerprint,
    approval_mode, artifact_text, artifact, bounded_authorization_id,
    inverse_plan_id, confirmation_version, persisted_at
  ) values (
    (v_request ->> 'approvalRequestId')::uuid, v_plan.org_id, v_plan.profile_id,
    v_plan.plan_id, v_plan.fingerprint,
    (v_request ->> 'approvalMode')::public.sp_write_approval_mode,
    p_approval_request_text, v_request,
    case when v_request -> 'boundedAuthorization' <> 'null'::jsonb
      then (v_request #>> '{boundedAuthorization,authorizationId}')::uuid end,
    case when v_request -> 'preapprovedInversePlan' <> 'null'::jsonb
      then (v_request #>> '{preapprovedInversePlan,planId}')::uuid end,
    v_request ->> 'confirmationVersion', v_checked_at
  );

  insert into public.sp_write_authorization_receipts (
    approval_id, org_id, profile_id, execution_id, approval_request_id,
    plan_id, inverse_plan_id, bounded_authorization_id, generation,
    approval_mode, artifact_text, artifact, approved_by, approved_at,
    expires_at, environment_gate_version, profile_grant_id,
    profile_grant_version, gate_snapshot_preimage, gate_snapshot_fingerprint,
    persisted_at
  ) values (
    v_approval_id, v_plan.org_id, v_plan.profile_id, v_execution_id,
    (v_request ->> 'approvalRequestId')::uuid, v_plan.plan_id,
    case when v_request -> 'preapprovedInversePlan' <> 'null'::jsonb
      then (v_request #>> '{preapprovedInversePlan,planId}')::uuid end,
    case when v_request -> 'boundedAuthorization' <> 'null'::jsonb
      then (v_request #>> '{boundedAuthorization,authorizationId}')::uuid end,
    v_generation, (v_request ->> 'approvalMode')::public.sp_write_approval_mode,
    v_receipt::text, v_receipt, v_actor, v_checked_at, v_expires_at,
    v_environment.version_id, v_grant.grant_id, v_grant.version_id,
    v_gate_preimage, v_gate_fingerprint, v_checked_at
  );

  insert into public.sp_write_cycle_plans (
    org_id, profile_id, execution_id, plan_id, receipt_plan_id,
    approval_id, generation, direction, bound_at
  ) values (
    v_plan.org_id, v_plan.profile_id, v_execution_id, v_plan.plan_id,
    v_plan.plan_id, v_approval_id, v_generation, v_plan.direction, v_checked_at
  );
  if v_request ->> 'approvalMode' = 'bounded_live_test' then
    insert into public.sp_write_cycle_plans (
      org_id, profile_id, execution_id, plan_id, receipt_plan_id,
      approval_id, generation, direction, bound_at
    ) values (
      v_plan.org_id, v_plan.profile_id, v_execution_id, v_inverse.plan_id,
      v_plan.plan_id, v_approval_id, v_generation, v_inverse.direction, v_checked_at
    );
  end if;
  return v_receipt;
end;
$$;

create or replace function app.start_sp_write_execution(
  p_approval_id uuid,
  p_plan_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_child public.sp_write_cycle_plans%rowtype;
  v_plan public.sp_write_plans%rowtype;
  v_receipt public.sp_write_authorization_receipts%rowtype;
  v_now timestamptz;
  v_outbox_id uuid;
begin
  perform app.assert_service_role('start_sp_write_execution');
  select child.* into strict v_child
  from public.sp_write_cycle_plans child
  where child.approval_id = p_approval_id and child.plan_id = p_plan_id
  for update;
  select * into strict v_plan from public.sp_write_plans where plan_id = v_child.plan_id;
  select * into strict v_receipt
  from public.sp_write_authorization_receipts where approval_id = v_child.approval_id;
  v_now := clock_timestamp();
  if v_now >= v_receipt.expires_at or v_now >= v_plan.expires_at then
    raise exception 'SP write execution authority is expired' using errcode = '55000';
  end if;
  if v_child.direction = 'inverse' and not exists (
    select 1
    from public.sp_write_plans source_plan
    where source_plan.plan_id = v_plan.source_plan_id
      and source_plan.provider_rows = (
        select count(*)
        from public.sp_write_observations observation
        where observation.org_id = v_child.org_id
          and observation.profile_id = v_child.profile_id
          and observation.execution_id = v_child.execution_id
          and observation.plan_id = v_plan.source_plan_id
          and observation.outcome = 'observed_requested'
      )
  ) then
    raise exception 'SP write inverse source is not completely observed requested'
      using errcode = '55000';
  end if;

  insert into public.sp_write_execution_requests (
    org_id, profile_id, execution_id, plan_id, approval_id, generation, requested_at
  ) values (
    v_child.org_id, v_child.profile_id, v_child.execution_id, v_child.plan_id,
    v_child.approval_id, v_child.generation, v_now
  ) on conflict (org_id, profile_id, execution_id, plan_id) do nothing;

  insert into public.sp_write_outbox (
    org_id, profile_id, execution_id, plan_id, approval_id, generation,
    kind, provider_call_id, intent_id, source_sync_job_id, created_at
  ) values (
    v_child.org_id, v_child.profile_id, v_child.execution_id, v_child.plan_id,
    v_child.approval_id, v_child.generation, 'dispatch', null, null, null, v_now
  ) on conflict (org_id, profile_id, execution_id, plan_id, kind, provider_call_id)
    do nothing
  returning outbox_id into v_outbox_id;
  if v_outbox_id is null then
    select outbox_id into strict v_outbox_id
    from public.sp_write_outbox
    where org_id = v_child.org_id and profile_id = v_child.profile_id
      and execution_id = v_child.execution_id and plan_id = v_child.plan_id
      and kind = 'dispatch';
  end if;
  return v_outbox_id;
end;
$$;

create or replace function app.acquire_sp_write_dispatch_lease(
  p_execution_id uuid,
  p_plan_id uuid,
  p_generation uuid,
  p_route_key public.sp_write_route_key,
  p_lease_seconds integer default 120
)
returns table (lease_id uuid, acquired_at timestamptz, expires_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_request public.sp_write_execution_requests%rowtype;
  v_now timestamptz;
begin
  perform app.assert_service_role('acquire_sp_write_dispatch_lease');
  if p_lease_seconds < 70 or p_lease_seconds > 300 then
    raise exception 'SP write lease must be between 70 and 300 seconds'
      using errcode = '22023';
  end if;
  select request.* into strict v_request
  from public.sp_write_execution_requests request
  where request.execution_id = p_execution_id and request.plan_id = p_plan_id
    and request.generation = p_generation
  for update;
  v_now := clock_timestamp();
  if exists (
    select 1 from public.sp_write_dispatch_leases lease
    where lease.org_id = v_request.org_id and lease.profile_id = v_request.profile_id
      and lease.execution_id = p_execution_id and lease.plan_id = p_plan_id
      and lease.route_key = p_route_key and lease.expires_at > v_now
  ) then
    raise exception 'SP write dispatch lease is unavailable' using errcode = '55P03';
  end if;
  lease_id := gen_random_uuid();
  acquired_at := v_now;
  expires_at := v_now + pg_catalog.make_interval(secs => p_lease_seconds);
  insert into public.sp_write_dispatch_leases (
    lease_id, org_id, profile_id, execution_id, plan_id, approval_id,
    generation, route_key, acquired_at, expires_at
  ) values (
    lease_id, v_request.org_id, v_request.profile_id, p_execution_id, p_plan_id,
    v_request.approval_id, p_generation, p_route_key, acquired_at, expires_at
  );
  return next;
end;
$$;

create or replace function app.sp_write_observed_action_for_side(
  p_action jsonb,
  p_side text
)
returns jsonb
language plpgsql
immutable
strict
set search_path = pg_catalog, app, pg_temp
as $$
declare
  v_values jsonb := '{}'::jsonb;
  v_route text := p_action ->> 'routeKey';
begin
  if p_side not in ('expected', 'requested') then
    raise exception 'invalid SP write observation side' using errcode = '22023';
  end if;
  case v_route
    when 'sp.v3.campaigns.update' then
      if p_action #> '{changes,budget}' is not null then
        v_values := v_values || pg_catalog.jsonb_build_object(
          'budget', p_action #> array['changes','budget',p_side]
        );
      end if;
      if p_action #> '{changes,state}' is not null then
        v_values := v_values || pg_catalog.jsonb_build_object(
          'state', p_action #> array['changes','state',p_side]
        );
      end if;
      if p_action #> '{changes,placement}' is not null then
        v_values := v_values || pg_catalog.jsonb_build_object(
          'placement', p_action #> array['changes','placement',p_side]
        );
      end if;
    when 'sp.v3.ad_groups.update' then
      if p_action #> '{changes,defaultBid}' is not null then
        v_values := v_values || pg_catalog.jsonb_build_object(
          'defaultBid', p_action #> array['changes','defaultBid',p_side]
        );
      end if;
      if p_action #> '{changes,state}' is not null then
        v_values := v_values || pg_catalog.jsonb_build_object(
          'state', p_action #> array['changes','state',p_side]
        );
      end if;
    when 'sp.v3.keywords.update', 'sp.v3.targets.update' then
      if p_action #> '{changes,bid}' is not null then
        v_values := v_values || pg_catalog.jsonb_build_object(
          'bid', p_action #> array['changes','bid',p_side]
        );
      end if;
      if p_action #> '{changes,state}' is not null then
        v_values := v_values || pg_catalog.jsonb_build_object(
          'state', p_action #> array['changes','state',p_side]
        );
      end if;
    when 'sp.v3.product_ads.update' then
      v_values := pg_catalog.jsonb_build_object(
        'state', p_action #> array['changes','state',p_side]
      );
    else
      raise exception 'unsupported SP write observation route' using errcode = '22023';
  end case;
  return pg_catalog.jsonb_build_object(
    'routeKey', p_action -> 'routeKey',
    'actionId', p_action -> 'actionId',
    'actionFingerprint', p_action -> 'fingerprint',
    'amazonEntityId', app.sp_write_action_entity_id(p_action),
    'values', v_values
  );
end;
$$;

create or replace function app.sp_write_disposition_artifact(
  p_disposition_id uuid,
  p_plan_id uuid,
  p_plan_fingerprint text,
  p_approval_id uuid,
  p_execution_id uuid,
  p_generation uuid,
  p_action_id uuid,
  p_action_fingerprint text,
  p_recorded_at timestamptz,
  p_reason public.sp_write_refusal_reason,
  p_provider_observation_fingerprint text
)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog, app, pg_temp
as $$
declare
  v_body text;
  v_preimage text;
  v_fingerprint text;
  v_artifact_text text;
begin
  v_body := '{'
    || '"schemaVersion":"openspell.sp-write-predispatch-disposition.v1",'
    || '"dispositionId":' || pg_catalog.to_jsonb(p_disposition_id::text)::text || ','
    || '"planId":' || pg_catalog.to_jsonb(p_plan_id::text)::text || ','
    || '"planFingerprint":' || pg_catalog.to_jsonb(p_plan_fingerprint)::text || ','
    || '"approvalId":' || pg_catalog.to_jsonb(p_approval_id::text)::text || ','
    || '"executionId":' || pg_catalog.to_jsonb(p_execution_id::text)::text || ','
    || '"generation":' || pg_catalog.to_jsonb(p_generation::text)::text || ','
    || '"actionId":' || pg_catalog.to_jsonb(p_action_id::text)::text || ','
    || '"actionFingerprint":' || pg_catalog.to_jsonb(p_action_fingerprint)::text || ','
    || '"recordedAt":' || pg_catalog.to_jsonb(app.sp_write_instant(p_recorded_at))::text || ','
    || '"outcome":"refused_before_dispatch",'
    || '"reason":' || pg_catalog.to_jsonb(p_reason::text)::text || ','
    || '"providerObservationFingerprint":'
    || coalesce(pg_catalog.to_jsonb(p_provider_observation_fingerprint)::text, 'null')
    || '}';
  v_preimage := '["openspell.sp-write-predispatch-disposition.v1",' || v_body || ']';
  v_fingerprint := app.sp_write_sha256(v_preimage);
  v_artifact_text := pg_catalog.substring(v_body, 1, pg_catalog.length(v_body) - 1)
    || ',"fingerprint":' || pg_catalog.to_jsonb(v_fingerprint)::text || '}';
  return pg_catalog.jsonb_build_object(
    'artifactText', v_artifact_text,
    'artifact', v_artifact_text::jsonb,
    'fingerprintPreimage', v_preimage,
    'fingerprint', v_fingerprint
  );
end;
$$;

create or replace function app.sp_write_action_within_bounded_authorization(
  p_authorization_id uuid,
  p_org_id uuid,
  p_profile_id uuid,
  p_action jsonb
)
returns boolean
language plpgsql
stable
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_allowed public.sp_write_bounded_authorization_entities%rowtype;
  v_key text;
  v_expected numeric;
  v_requested numeric;
  v_placement_key text;
  v_json_key text;
begin
  select entity.* into v_allowed
  from public.sp_write_bounded_authorization_entities entity
  where entity.authorization_id = p_authorization_id
    and entity.org_id = p_org_id
    and entity.profile_id = p_profile_id
    and entity.route_key::text = p_action ->> 'routeKey'
    and entity.amazon_entity_id = app.sp_write_action_entity_id(p_action);
  if not found then return false; end if;

  for v_key in
    select source ->> 'changeKey'
    from pg_catalog.jsonb_array_elements(p_action -> 'sources') source
  loop
    if not (v_key = any(v_allowed.allowed_change_keys)) then return false; end if;
    if v_key in (
      'campaign.budget', 'ad_group.default_bid', 'keyword.bid', 'target.bid'
    ) then
      if v_allowed.max_absolute_money_delta is null then return false; end if;
      case v_key
        when 'campaign.budget' then v_json_key := 'budget';
        when 'ad_group.default_bid' then v_json_key := 'defaultBid';
        else v_json_key := 'bid';
      end case;
      begin
        v_expected := (p_action #>> array['changes', v_json_key, 'expected', 'amount'])::numeric;
        v_requested := (p_action #>> array['changes', v_json_key, 'requested', 'amount'])::numeric;
      exception when others then
        return false;
      end;
      if v_expected is null or v_requested is null
         or pg_catalog.abs(v_expected - v_requested)
          > v_allowed.max_absolute_money_delta::numeric then
        return false;
      end if;
    elsif v_key like 'campaign.placement.%' then
      if v_allowed.max_absolute_placement_delta is null then return false; end if;
      v_placement_key := pg_catalog.substring(v_key, pg_catalog.length('campaign.placement.') + 1);
      v_json_key := case v_placement_key
        when 'top_of_search' then 'topOfSearch'
        when 'product_pages' then 'productPages'
        when 'rest_of_search' then 'restOfSearch'
        when 'amazon_business' then 'amazonBusiness'
        else null
      end;
      if v_json_key is null then return false; end if;
      begin
        v_expected := (p_action #>> array[
          'changes', 'placement', 'expected', 'placements', v_json_key
        ])::numeric;
        v_requested := (p_action #>> array[
          'changes', 'placement', 'requested', 'placements', v_json_key
        ])::numeric;
      exception when others then
        return false;
      end;
      if v_expected is null or v_requested is null
         or pg_catalog.abs(v_expected - v_requested)
            > v_allowed.max_absolute_placement_delta then
        return false;
      end if;
    end if;
  end loop;
  return true;
end;
$$;

create or replace function app.sp_write_inverse_pair_exact(
  p_forward_plan_id uuid,
  p_inverse_plan_id uuid
)
returns boolean
language plpgsql
stable
strict
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_forward public.sp_write_plan_actions%rowtype;
  v_inverse public.sp_write_plan_actions%rowtype;
  v_forward_count integer;
  v_inverse_count integer;
  v_mapped_count integer := 0;
  v_source_count integer;
  v_source_id_count integer;
  v_source_id_text text;
  v_source_id uuid;
  v_seen_source_ids uuid[] := array[]::uuid[];
  v_forward_source_keys text[];
  v_inverse_source_keys text[];
  v_forward_change_keys text[];
  v_inverse_change_keys text[];
  v_placement_key text;
begin
  select count(*) into v_forward_count
  from public.sp_write_plan_actions action
  where action.plan_id = p_forward_plan_id;
  select count(*) into v_inverse_count
  from public.sp_write_plan_actions action
  where action.plan_id = p_inverse_plan_id;
  if v_forward_count < 1 or v_inverse_count <> v_forward_count then
    return false;
  end if;

  for v_inverse in
    select action.*
    from public.sp_write_plan_actions action
    where action.plan_id = p_inverse_plan_id
    order by action.action_index
  loop
    if pg_catalog.jsonb_typeof(v_inverse.artifact -> 'sources') <> 'array'
       or pg_catalog.jsonb_array_length(v_inverse.artifact -> 'sources') < 1
       or exists (
         select 1
         from pg_catalog.jsonb_array_elements(v_inverse.artifact -> 'sources') source
         where not app.sp_write_exact_json_keys(
           source, array['kind','sourceActionId','changeKey']
         )
           or source ->> 'kind' <> 'inverse_action'
           or source ->> 'sourceActionId'
              <> pg_catalog.lower(((source ->> 'sourceActionId')::uuid)::text)
       ) then
      return false;
    end if;
    select count(*), count(distinct source ->> 'sourceActionId'),
      min(source ->> 'sourceActionId')
    into v_source_count, v_source_id_count, v_source_id_text
    from pg_catalog.jsonb_array_elements(v_inverse.artifact -> 'sources') source;
    if v_source_count < 1 or v_source_id_count <> 1 then return false; end if;
    v_source_id := v_source_id_text::uuid;
    if v_source_id = any(v_seen_source_ids) then return false; end if;
    v_seen_source_ids := pg_catalog.array_append(v_seen_source_ids, v_source_id);

    select action.* into v_forward
    from public.sp_write_plan_actions action
    where action.plan_id = p_forward_plan_id and action.action_id = v_source_id;
    if not found
       or v_inverse.action_id = v_forward.action_id
       or v_inverse.route_key <> v_forward.route_key
       or v_inverse.amazon_entity_id <> v_forward.amazon_entity_id then
      return false;
    end if;
    if pg_catalog.jsonb_typeof(v_forward.artifact -> 'sources') <> 'array'
       or pg_catalog.jsonb_array_length(v_forward.artifact -> 'sources') < 1
       or exists (
         select 1
         from pg_catalog.jsonb_array_elements(v_forward.artifact -> 'sources') source
         where not app.sp_write_exact_json_keys(
           source, array['kind','applyRowId','changeKey']
         )
           or source ->> 'kind' <> 'apply_row'
       ) then
      return false;
    end if;

    select pg_catalog.array_agg(value ->> 'changeKey' order by ordinality)
    into v_forward_source_keys
    from pg_catalog.jsonb_array_elements(v_forward.artifact -> 'sources')
      with ordinality source(value, ordinality);
    select pg_catalog.array_agg(value ->> 'changeKey' order by ordinality)
    into v_inverse_source_keys
    from pg_catalog.jsonb_array_elements(v_inverse.artifact -> 'sources')
      with ordinality source(value, ordinality);
    if v_forward_source_keys <> app.sp_write_canonical_text_array(v_forward_source_keys)
       or v_inverse_source_keys <> app.sp_write_canonical_text_array(v_inverse_source_keys)
       or v_inverse_source_keys <> v_forward_source_keys then
      return false;
    end if;

    v_forward_change_keys := array[]::text[];
    v_inverse_change_keys := array[]::text[];
    case v_forward.route_key
      when 'sp.v3.campaigns.update' then
        if (v_forward.artifact -> 'changes') - array['budget','state','placement']
             <> '{}'::jsonb
           or (v_inverse.artifact -> 'changes') - array['budget','state','placement']
             <> '{}'::jsonb then return false; end if;
        if v_forward.artifact #> '{changes,budget}' is not null then
          v_forward_change_keys := pg_catalog.array_append(
            v_forward_change_keys, 'campaign.budget'
          );
        end if;
        if v_inverse.artifact #> '{changes,budget}' is not null then
          v_inverse_change_keys := pg_catalog.array_append(
            v_inverse_change_keys, 'campaign.budget'
          );
        end if;
        if v_forward.artifact #> '{changes,state}' is not null then
          v_forward_change_keys := pg_catalog.array_append(
            v_forward_change_keys, 'campaign.state'
          );
        end if;
        if v_inverse.artifact #> '{changes,state}' is not null then
          v_inverse_change_keys := pg_catalog.array_append(
            v_inverse_change_keys, 'campaign.state'
          );
        end if;
        if v_forward.artifact #> '{changes,placement}' is not null then
          for v_placement_key in
            select value
            from pg_catalog.jsonb_array_elements_text(
              v_forward.artifact #> '{changes,placement,approvedPlacementKeys}'
            ) key(value)
          loop
            v_forward_change_keys := pg_catalog.array_append(
              v_forward_change_keys, 'campaign.placement.' || v_placement_key
            );
          end loop;
        end if;
        if v_inverse.artifact #> '{changes,placement}' is not null then
          for v_placement_key in
            select value
            from pg_catalog.jsonb_array_elements_text(
              v_inverse.artifact #> '{changes,placement,approvedPlacementKeys}'
            ) key(value)
          loop
            v_inverse_change_keys := pg_catalog.array_append(
              v_inverse_change_keys, 'campaign.placement.' || v_placement_key
            );
          end loop;
        end if;
        if v_forward.artifact #> '{changes,placement,approvedPlacementKeys}'
             is distinct from
             v_inverse.artifact #> '{changes,placement,approvedPlacementKeys}' then
          return false;
        end if;
      when 'sp.v3.ad_groups.update' then
        if (v_forward.artifact -> 'changes') - array['defaultBid','state'] <> '{}'::jsonb
           or (v_inverse.artifact -> 'changes') - array['defaultBid','state']
             <> '{}'::jsonb then return false; end if;
        if v_forward.artifact #> '{changes,defaultBid}' is not null then
          v_forward_change_keys := pg_catalog.array_append(
            v_forward_change_keys, 'ad_group.default_bid'
          );
        end if;
        if v_inverse.artifact #> '{changes,defaultBid}' is not null then
          v_inverse_change_keys := pg_catalog.array_append(
            v_inverse_change_keys, 'ad_group.default_bid'
          );
        end if;
        if v_forward.artifact #> '{changes,state}' is not null then
          v_forward_change_keys := pg_catalog.array_append(
            v_forward_change_keys, 'ad_group.state'
          );
        end if;
        if v_inverse.artifact #> '{changes,state}' is not null then
          v_inverse_change_keys := pg_catalog.array_append(
            v_inverse_change_keys, 'ad_group.state'
          );
        end if;
      when 'sp.v3.keywords.update', 'sp.v3.targets.update' then
        if (v_forward.artifact -> 'changes') - array['bid','state'] <> '{}'::jsonb
           or (v_inverse.artifact -> 'changes') - array['bid','state'] <> '{}'::jsonb
          then return false;
        end if;
        if v_forward.artifact #> '{changes,bid}' is not null then
          v_forward_change_keys := pg_catalog.array_append(
            v_forward_change_keys,
            case when v_forward.route_key = 'sp.v3.keywords.update'
              then 'keyword.bid' else 'target.bid' end
          );
        end if;
        if v_inverse.artifact #> '{changes,bid}' is not null then
          v_inverse_change_keys := pg_catalog.array_append(
            v_inverse_change_keys,
            case when v_inverse.route_key = 'sp.v3.keywords.update'
              then 'keyword.bid' else 'target.bid' end
          );
        end if;
        if v_forward.artifact #> '{changes,state}' is not null then
          v_forward_change_keys := pg_catalog.array_append(
            v_forward_change_keys,
            case when v_forward.route_key = 'sp.v3.keywords.update'
              then 'keyword.state' else 'target.state' end
          );
        end if;
        if v_inverse.artifact #> '{changes,state}' is not null then
          v_inverse_change_keys := pg_catalog.array_append(
            v_inverse_change_keys,
            case when v_inverse.route_key = 'sp.v3.keywords.update'
              then 'keyword.state' else 'target.state' end
          );
        end if;
      when 'sp.v3.product_ads.update' then
        if not app.sp_write_exact_json_keys(v_forward.artifact -> 'changes', array['state'])
           or not app.sp_write_exact_json_keys(
             v_inverse.artifact -> 'changes', array['state']
           ) then return false; end if;
        v_forward_change_keys := array['product_ad.state'];
        v_inverse_change_keys := array['product_ad.state'];
      else
        return false;
    end case;
    v_forward_change_keys := app.sp_write_canonical_text_array(v_forward_change_keys);
    v_inverse_change_keys := app.sp_write_canonical_text_array(v_inverse_change_keys);
    if v_forward_change_keys <> v_forward_source_keys
       or v_inverse_change_keys <> v_inverse_source_keys
       or app.sp_write_observed_action_for_side(v_forward.artifact, 'expected') -> 'values'
          <> app.sp_write_observed_action_for_side(v_inverse.artifact, 'requested') -> 'values'
       or app.sp_write_observed_action_for_side(v_forward.artifact, 'requested') -> 'values'
          <> app.sp_write_observed_action_for_side(v_inverse.artifact, 'expected') -> 'values'
      then return false;
    end if;
    v_mapped_count := v_mapped_count + 1;
  end loop;
  return v_mapped_count = v_forward_count
    and pg_catalog.cardinality(v_seen_source_ids) = v_forward_count;
exception when others then
  return false;
end;
$$;

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

create or replace function app.append_sp_write_provider_result(
  p_result_text text,
  p_fingerprint_preimage text,
  p_origin public.sp_write_result_origin
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_result jsonb;
  v_position jsonb;
  v_intent_position public.sp_write_provider_call_positions%rowtype;
  v_intent public.sp_write_provider_call_intents%rowtype;
  v_lease public.sp_write_dispatch_leases%rowtype;
  v_existing public.sp_write_provider_results%rowtype;
  v_now timestamptz := clock_timestamp();
  v_index integer;
  v_offered integer;
  v_inserted integer := 0;
  v_codes text[];
begin
  perform app.assert_service_role('append_sp_write_provider_result');
  v_result := app.sp_write_verified_artifact(
    p_result_text, p_fingerprint_preimage, 'openspell.sp-write-provider-result.v1'
  );
  if not app.sp_write_exact_json_keys(v_result, array[
       'schemaVersion','resultId','intentId','intentFingerprint','providerCallId',
       'requestFingerprint','completedAt','positions','fingerprint'
     ])
     or v_result ->> 'schemaVersion' <> 'openspell.sp-write-provider-result.v1'
     or pg_catalog.jsonb_typeof(v_result -> 'positions') <> 'array'
     or pg_catalog.jsonb_array_length(v_result -> 'positions') < 1
     or pg_catalog.jsonb_array_length(v_result -> 'positions') > 100
     or v_result ->> 'resultId' <>
        pg_catalog.lower(((v_result ->> 'resultId')::uuid)::text)
     or v_result ->> 'intentId' <>
        pg_catalog.lower(((v_result ->> 'intentId')::uuid)::text)
     or v_result ->> 'providerCallId' <>
        pg_catalog.lower(((v_result ->> 'providerCallId')::uuid)::text) then
    raise exception 'SP write provider result shape is invalid' using errcode = '22023';
  end if;
  v_offered := pg_catalog.jsonb_array_length(v_result -> 'positions');

  select * into strict v_intent
  from public.sp_write_provider_call_intents intent
  where intent.intent_id = (v_result ->> 'intentId')::uuid
  for update;
  v_now := clock_timestamp();
  if (v_result ->> 'resultId')::uuid <> v_intent.reserved_result_id
     or v_result ->> 'intentFingerprint' <> v_intent.fingerprint
     or (v_result ->> 'providerCallId')::uuid <> v_intent.provider_call_id
     or v_result ->> 'requestFingerprint' <> v_intent.request_fingerprint
     or (v_result ->> 'completedAt')::timestamptz < v_intent.recorded_at
     or (v_result ->> 'completedAt')::timestamptz > v_now
     or v_offered <> (
       select count(*) from public.sp_write_provider_call_positions position
       where position.intent_id = v_intent.intent_id
     ) then
    raise exception 'SP write provider result does not match its intent'
      using errcode = '22023';
  end if;

  for v_position, v_index in
    select value, (ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(v_result -> 'positions') with ordinality
  loop
    if not app.sp_write_exact_json_keys(v_position, array[
         'requestIndex','actionId','actionFingerprint','actionRequestFingerprint',
         'outcome','providerEntityId','code','message'
       ])
       or (v_position ->> 'requestIndex')::integer <> v_index
       or (v_position ->> 'actionId') <>
          pg_catalog.lower(((v_position ->> 'actionId')::uuid)::text)
       or v_position ->> 'actionFingerprint' !~ '^[a-f0-9]{64}$'
       or v_position ->> 'actionRequestFingerprint' !~ '^[a-f0-9]{64}$'
       or (v_position ->> 'outcome') not in (
         'accepted','authoritative_rejected','ambiguous'
       )
       or (v_position ->> 'code' is not null and (
         v_position ->> 'code' <> pg_catalog.btrim(v_position ->> 'code')
         or pg_catalog.length(v_position ->> 'code') > 160
       ))
       or (v_position ->> 'message' is not null and (
         v_position ->> 'message' <> pg_catalog.btrim(v_position ->> 'message')
         or pg_catalog.length(v_position ->> 'message') > 512
       )) then
      raise exception 'SP write provider result position shape is invalid'
        using errcode = '22023';
    end if;
    select * into v_intent_position
    from public.sp_write_provider_call_positions position
    where position.org_id = v_intent.org_id
      and position.profile_id = v_intent.profile_id
      and position.intent_id = v_intent.intent_id
      and position.request_index = v_index;
    if not found
       or (v_position ->> 'actionId')::uuid <> v_intent_position.action_id
       or v_position ->> 'actionFingerprint' <> v_intent_position.action_fingerprint
       or v_position ->> 'actionRequestFingerprint'
          <> v_intent_position.action_request_fingerprint
       or (v_position ->> 'providerEntityId' is not null
         and v_position ->> 'providerEntityId' <> v_intent_position.amazon_entity_id)
       or (v_position ->> 'outcome' = 'accepted'
         and v_position ->> 'providerEntityId' is null)
       or (v_position ->> 'outcome' = 'ambiguous'
         and v_position ->> 'providerEntityId' is not null) then
      raise exception 'SP write provider result position does not match its intent'
        using errcode = '22023';
    end if;
    if p_origin = 'recovery_synthesized' and (
      v_position ->> 'outcome' <> 'ambiguous'
      or v_position ->> 'providerEntityId' is not null
    ) then
      raise exception 'SP write recovery result must be entirely ambiguous'
        using errcode = '22023';
    end if;
  end loop;

  if p_origin = 'recovery_synthesized' then
    select * into strict v_lease
    from public.sp_write_dispatch_leases lease
    where lease.lease_id = v_intent.dispatch_lease_id;
    if v_now < v_intent.provider_attempt_deadline or v_now < v_lease.expires_at
       or (v_result ->> 'completedAt')::timestamptz <
          greatest(v_intent.provider_attempt_deadline, v_lease.expires_at) then
      raise exception 'SP write recovery is not yet eligible' using errcode = '55000';
    end if;
  end if;

  select * into v_existing
  from public.sp_write_provider_results existing
  where existing.intent_id = v_intent.intent_id;
  if found then
    if v_existing.origin = 'recovery_synthesized'
       and p_origin = 'provider_adapter' then
      select coalesce(pg_catalog.array_agg(code order by request_index)
        filter (where code is not null), array[]::text[])
      into v_codes
      from (
        select (value ->> 'requestIndex')::integer request_index,
          value ->> 'code' code
        from pg_catalog.jsonb_array_elements(v_result -> 'positions') position(value)
      ) diagnostics;
      insert into public.sp_write_late_result_audits (
        org_id, profile_id, intent_id, result_id, submitted_fingerprint,
        completed_at, position_count, diagnostic_codes, persisted_at
      ) values (
        v_intent.org_id, v_intent.profile_id, v_intent.intent_id,
        v_existing.result_id, v_result ->> 'fingerprint',
        (v_result ->> 'completedAt')::timestamptz, v_offered, v_codes, v_now
      ) on conflict on constraint sp_write_late_result_audits_submission_key
        do nothing;
      return 'late_audited';
    end if;
    if v_existing.fingerprint = v_result ->> 'fingerprint'
       and v_existing.artifact_text = p_result_text
       and v_existing.fingerprint_preimage = p_fingerprint_preimage then
      return 'already_recorded';
    end if;
    return 'canonical_result_already_recorded';
  end if;

  insert into public.sp_write_provider_results (
    result_id, org_id, profile_id, intent_id, origin, artifact_text, artifact,
    fingerprint_preimage, fingerprint, intent_fingerprint, provider_call_id,
    request_fingerprint, completed_at, persisted_at
  ) values (
    v_intent.reserved_result_id, v_intent.org_id, v_intent.profile_id,
    v_intent.intent_id, p_origin, p_result_text, v_result,
    p_fingerprint_preimage, v_result ->> 'fingerprint', v_intent.fingerprint,
    v_intent.provider_call_id, v_intent.request_fingerprint,
    (v_result ->> 'completedAt')::timestamptz, v_now
  );
  for v_position, v_index in
    select value, (ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(v_result -> 'positions') with ordinality
  loop
    insert into public.sp_write_provider_result_positions (
      org_id, profile_id, result_id, intent_id, request_index, action_id,
      action_fingerprint, action_request_fingerprint, outcome,
      provider_entity_id, code, message
    ) values (
      v_intent.org_id, v_intent.profile_id, v_intent.reserved_result_id,
      v_intent.intent_id, v_index, (v_position ->> 'actionId')::uuid,
      v_position ->> 'actionFingerprint', v_position ->> 'actionRequestFingerprint',
      (v_position ->> 'outcome')::public.sp_write_provider_outcome,
      v_position ->> 'providerEntityId', v_position ->> 'code',
      v_position ->> 'message'
    );
    v_inserted := v_inserted + 1;
  end loop;
  if v_inserted <> v_offered
     or (select count(*) from public.sp_write_provider_results result
         where result.intent_id = v_intent.intent_id) <> 1
     or (select count(*) from public.sp_write_provider_result_positions position
         where position.intent_id = v_intent.intent_id) <> v_offered then
    raise exception 'SP write provider result counts do not close'
      using errcode = '22023';
  end if;
  return 'recorded';
end;
$$;

create or replace function app.append_sp_write_observation(
  p_observation_text text,
  p_fingerprint_preimage text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_observation jsonb;
  v_observed jsonb;
  v_expected jsonb;
  v_requested jsonb;
  v_intent public.sp_write_provider_call_intents%rowtype;
  v_result public.sp_write_provider_results%rowtype;
  v_result_position public.sp_write_provider_result_positions%rowtype;
  v_authorization public.sp_write_bounded_authorizations%rowtype;
  v_action public.sp_write_plan_actions%rowtype;
  v_outbox public.sp_write_outbox%rowtype;
  v_existing public.sp_write_observations%rowtype;
  v_derived public.sp_write_observation_outcome;
  v_now timestamptz := clock_timestamp();
begin
  perform app.assert_service_role('append_sp_write_observation');
  v_observation := app.sp_write_verified_artifact(
    p_observation_text, p_fingerprint_preimage, 'openspell.sp-write-observation.v1'
  );
  if not app.sp_write_exact_json_keys(v_observation, array[
       'schemaVersion','observationId','planId','planFingerprint','approvalId',
       'executionId','generation','intentId','intentFingerprint','providerCallId',
       'requestFingerprint','actionId','actionFingerprint','routeKey',
       'sourceSyncJobId','observedAt','outcome','observed','fingerprint'
     ])
     or v_observation ->> 'schemaVersion' <> 'openspell.sp-write-observation.v1'
     or v_observation ->> 'observationId' <>
        pg_catalog.lower(((v_observation ->> 'observationId')::uuid)::text)
     or v_observation ->> 'intentId' <>
        pg_catalog.lower(((v_observation ->> 'intentId')::uuid)::text)
     or v_observation ->> 'providerCallId' <>
        pg_catalog.lower(((v_observation ->> 'providerCallId')::uuid)::text)
     or v_observation ->> 'actionId' <>
        pg_catalog.lower(((v_observation ->> 'actionId')::uuid)::text)
     or v_observation ->> 'sourceSyncJobId' <>
        pg_catalog.lower(((v_observation ->> 'sourceSyncJobId')::uuid)::text) then
    raise exception 'SP write observation shape is invalid' using errcode = '22023';
  end if;

  select * into strict v_intent
  from public.sp_write_provider_call_intents intent
  where intent.intent_id = (v_observation ->> 'intentId')::uuid;
  select * into strict v_result
  from public.sp_write_provider_results result
  where result.intent_id = v_intent.intent_id;
  select bounded.* into v_authorization
  from public.sp_write_authorization_receipts receipt
  join public.sp_write_bounded_authorizations bounded
    on bounded.authorization_id = receipt.bounded_authorization_id
  where receipt.org_id = v_intent.org_id
    and receipt.profile_id = v_intent.profile_id
    and receipt.approval_id = v_intent.approval_id
  for update of bounded;
  select * into strict v_result_position
  from public.sp_write_provider_result_positions position
  where position.org_id = v_intent.org_id
    and position.profile_id = v_intent.profile_id
    and position.result_id = v_result.result_id
    and position.intent_id = v_intent.intent_id
    and position.action_id = (v_observation ->> 'actionId')::uuid
  for update;
  v_now := clock_timestamp();
  select * into strict v_action
  from public.sp_write_plan_actions action
  where action.org_id = v_intent.org_id and action.profile_id = v_intent.profile_id
    and action.plan_id = v_intent.plan_id
    and action.action_id = v_result_position.action_id;
  select * into strict v_outbox
  from public.sp_write_outbox outbox
  where outbox.org_id = v_intent.org_id and outbox.profile_id = v_intent.profile_id
    and outbox.execution_id = v_intent.execution_id
    and outbox.plan_id = v_intent.plan_id
    and outbox.approval_id = v_intent.approval_id
    and outbox.generation = v_intent.generation
    and outbox.intent_id = v_intent.intent_id
    and outbox.provider_call_id = v_intent.provider_call_id
    and outbox.source_sync_job_id =
      (v_observation ->> 'sourceSyncJobId')::uuid;

  if (v_observation ->> 'planId')::uuid <> v_intent.plan_id
     or v_observation ->> 'planFingerprint' <>
        (select plan.fingerprint from public.sp_write_plans plan
         where plan.plan_id = v_intent.plan_id)
     or (v_observation ->> 'approvalId')::uuid <> v_intent.approval_id
     or (v_observation ->> 'executionId')::uuid <> v_intent.execution_id
     or (v_observation ->> 'generation')::uuid <> v_intent.generation
     or v_observation ->> 'intentFingerprint' <> v_intent.fingerprint
     or (v_observation ->> 'providerCallId')::uuid <> v_intent.provider_call_id
     or v_observation ->> 'requestFingerprint' <> v_intent.request_fingerprint
     or v_observation ->> 'actionFingerprint' <> v_action.fingerprint
     or v_observation ->> 'actionFingerprint' <>
        v_result_position.action_fingerprint
     or v_observation ->> 'routeKey' <> v_intent.route_key::text
     or v_observation ->> 'routeKey' <> v_action.route_key::text
     or (v_observation ->> 'observedAt')::timestamptz < v_result.completed_at
     or (v_observation ->> 'observedAt')::timestamptz > v_now then
    raise exception 'SP write observation does not match its durable result'
      using errcode = '22023';
  end if;
  if v_result_position.outcome = 'authoritative_rejected' then
    raise exception 'SP write authoritative rejection cannot be observed'
      using errcode = '22023';
  end if;

  v_observed := v_observation -> 'observed';
  if v_observed = 'null'::jsonb then
    v_derived := 'missing';
  else
    if not app.sp_write_exact_json_keys(v_observed, array[
         'routeKey','actionId','actionFingerprint','amazonEntityId','values'
       ])
       or v_observed ->> 'actionId' <> v_observation ->> 'actionId'
       or v_observed ->> 'actionFingerprint' <> v_action.fingerprint
       or v_observed ->> 'routeKey' <> v_action.route_key::text
       or v_observed ->> 'amazonEntityId' <> v_action.amazon_entity_id then
      raise exception 'SP write observed action identity is invalid'
        using errcode = '22023';
    end if;
    v_requested := app.sp_write_observed_action_for_side(v_action.artifact, 'requested');
    v_expected := app.sp_write_observed_action_for_side(v_action.artifact, 'expected');
    if v_observed = v_requested then
      v_derived := 'observed_requested';
    elsif v_result_position.outcome = 'ambiguous' and v_observed = v_expected then
      v_derived := 'observed_expected_after_ambiguous';
    else
      v_derived := 'conflict';
    end if;
  end if;
  if (v_observation ->> 'outcome')::public.sp_write_observation_outcome
      <> v_derived then
    raise exception 'SP write observation outcome is not derived from evidence'
      using errcode = '22023';
  end if;

  if v_authorization.authorization_id is not null
     and v_derived in ('conflict', 'missing') then
    insert into public.sp_write_bounded_authorization_revocations (
      authorization_id, revoked_at, reason
    ) values (
      v_authorization.authorization_id,
      v_now,
      'stopOnConflict: terminal observation was conflict or missing'
    ) on conflict (authorization_id) do nothing;
  end if;

  select * into v_existing
  from public.sp_write_observations observation
  where observation.observation_id = (v_observation ->> 'observationId')::uuid
     or (observation.org_id = v_intent.org_id
       and observation.profile_id = v_intent.profile_id
       and observation.execution_id = v_intent.execution_id
       and observation.plan_id = v_intent.plan_id
       and observation.action_id = v_result_position.action_id);
  if found then
    if v_existing.artifact_text = p_observation_text
       and v_existing.fingerprint_preimage = p_fingerprint_preimage
       and v_existing.fingerprint = v_observation ->> 'fingerprint' then
      return v_existing.observation_id;
    end if;
    raise exception 'SP write observation identity collision' using errcode = '23505';
  end if;

  insert into public.sp_write_observations (
    observation_id, org_id, profile_id, execution_id, plan_id, approval_id,
    generation, intent_id, result_id, provider_call_id, action_id,
    action_fingerprint, intent_fingerprint, request_fingerprint, route_key,
    source_sync_job_id, outcome, observed, observed_at, artifact_text, artifact,
    fingerprint_preimage, fingerprint, persisted_at
  ) values (
    (v_observation ->> 'observationId')::uuid, v_intent.org_id,
    v_intent.profile_id, v_intent.execution_id, v_intent.plan_id,
    v_intent.approval_id, v_intent.generation, v_intent.intent_id,
    v_result.result_id, v_intent.provider_call_id, v_result_position.action_id,
    v_action.fingerprint, v_intent.fingerprint, v_intent.request_fingerprint,
    v_intent.route_key, v_outbox.source_sync_job_id, v_derived,
    case when v_observed = 'null'::jsonb then null::jsonb else v_observed end,
    (v_observation ->> 'observedAt')::timestamptz, p_observation_text,
    v_observation, p_fingerprint_preimage, v_observation ->> 'fingerprint', v_now
  );
  return (v_observation ->> 'observationId')::uuid;
end;
$$;

create view public.sp_write_execution_accounting
with (security_invoker = true)
as
with action_facts as (
  select
    child.org_id,
    child.profile_id,
    child.execution_id,
    child.plan_id,
    plan.provider_rows as approved_rows,
    resolution.resolution_kind,
    position.intent_id,
    coalesce(result_position.outcome, 'ambiguous'::public.sp_write_provider_outcome)
      as provider_outcome,
    result.result_id,
    observation.outcome as observation_outcome
  from public.sp_write_cycle_plans child
  join public.sp_write_plans plan
    on plan.org_id = child.org_id and plan.profile_id = child.profile_id
   and plan.plan_id = child.plan_id
  join public.sp_write_plan_actions action
    on action.org_id = child.org_id and action.profile_id = child.profile_id
   and action.plan_id = child.plan_id
  left join public.sp_write_action_resolutions resolution
    on resolution.org_id = child.org_id and resolution.profile_id = child.profile_id
   and resolution.execution_id = child.execution_id
   and resolution.plan_id = child.plan_id and resolution.action_id = action.action_id
  left join public.sp_write_provider_call_positions position
    on position.org_id = resolution.org_id and position.profile_id = resolution.profile_id
   and position.execution_id = resolution.execution_id
   and position.plan_id = resolution.plan_id
   and position.intent_id = resolution.intent_id and position.action_id = action.action_id
  left join public.sp_write_provider_results result
    on result.org_id = position.org_id and result.profile_id = position.profile_id
   and result.intent_id = position.intent_id
  left join public.sp_write_provider_result_positions result_position
    on result_position.org_id = result.org_id
   and result_position.profile_id = result.profile_id
   and result_position.result_id = result.result_id
   and result_position.intent_id = position.intent_id
   and result_position.action_id = action.action_id
  left join public.sp_write_observations observation
    on observation.org_id = child.org_id and observation.profile_id = child.profile_id
   and observation.execution_id = child.execution_id
   and observation.plan_id = child.plan_id and observation.action_id = action.action_id
), accounting as (
  select
    org_id,
    profile_id,
    execution_id,
    plan_id,
    max(approved_rows)::integer as approved_rows,
    count(*) filter (where resolution_kind is null)::integer as pending_dispatch,
    count(*) filter (where resolution_kind = 'refusal')::integer
      as refused_before_dispatch,
    count(*) filter (where resolution_kind = 'intent')::integer
      as intent_committed,
    count(*) filter (
      where resolution_kind = 'intent' and provider_outcome = 'accepted'
    )::integer as provider_accepted,
    count(*) filter (
      where resolution_kind = 'intent' and provider_outcome = 'authoritative_rejected'
    )::integer as provider_rejected,
    count(*) filter (
      where resolution_kind = 'intent' and provider_outcome = 'ambiguous'
    )::integer as provider_ambiguous,
    count(*) filter (where observation_outcome = 'observed_requested')::integer
      as observed_requested,
    count(*) filter (
      where observation_outcome = 'observed_expected_after_ambiguous'
    )::integer as observed_expected_after_ambiguous,
    count(*) filter (where observation_outcome = 'conflict')::integer
      as observation_conflict,
    count(*) filter (where observation_outcome = 'missing')::integer
      as observation_missing,
    count(*) filter (
      where resolution_kind = 'intent'
        and provider_outcome <> 'authoritative_rejected'
        and observation_outcome is null
    )::integer as pending_observation,
    count(distinct intent_id)::integer as provider_calls_committed,
    count(distinct result_id)::integer as provider_calls_completed
  from action_facts
  group by org_id, profile_id, execution_id, plan_id
)
select accounting.*,
  case
    when observation_conflict > 0 or observation_missing > 0 then 'conflict'
    when pending_dispatch = approved_rows then 'queued'
    when pending_dispatch > 0 then 'running'
    when pending_observation > 0 then 'awaiting_observation'
    when provider_accepted = approved_rows
      and observed_requested = approved_rows then 'succeeded'
    when provider_ambiguous > 0 and provider_rejected = 0
      and refused_before_dispatch = 0
      and observed_requested = provider_accepted + provider_ambiguous
      then 'observed_after_ambiguous'
    when refused_before_dispatch = approved_rows then 'refused'
    when provider_rejected = approved_rows then 'failed'
    when provider_ambiguous > 0 or observed_expected_after_ambiguous > 0
      then 'ambiguous'
    else 'partial'
  end::text as status
from accounting;

-- -------------------------------------------------------------------------
-- Append-only enforcement, tenant reads, and capability-only mutation ACLs
-- -------------------------------------------------------------------------

create or replace function app.reject_sp_write_evidence_change()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE'
     and pg_catalog.to_jsonb(old) ? 'org_id'
     and not exists (
       select 1 from public.orgs org
       where org.id = (pg_catalog.to_jsonb(old) ->> 'org_id')::uuid
     ) then
    return old;
  end if;
  raise exception 'SP write authority and evidence rows are immutable'
    using errcode = '55000';
end;
$$;

create or replace function app.reject_sp_write_evidence_truncate()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'SP write authority and evidence tables must not be truncated'
    using errcode = '55000';
end;
$$;

-- Deleting an organisation is deliberately supported, but an intent without
-- a durable provider result represents an Amazon mutation whose outcome may
-- still be unknown. Reservation holds a KEY SHARE lock on this parent through
-- intent commit, so this check cannot race a newly committed intent.
create or replace function app.guard_org_delete_against_unresolved_sp_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if exists (
    select 1
    from public.sp_write_provider_call_intents intent
    where intent.org_id = old.id
      and not exists (
        select 1
        from public.sp_write_provider_results result
        where result.org_id = intent.org_id
          and result.profile_id = intent.profile_id
          and result.intent_id = intent.intent_id
      )
  ) then
    raise exception 'organisation has unresolved SP write provider call intent'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger orgs_block_unresolved_sp_write_purge
  before delete on public.orgs
  for each row execute function app.guard_org_delete_against_unresolved_sp_write();

create trigger sp_write_environment_gate_versions_immutable
  before update or delete on public.sp_write_environment_gate_versions
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_environment_gate_versions_no_truncate
  before truncate on public.sp_write_environment_gate_versions
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_profile_grant_versions_immutable
  before update or delete on public.sp_write_profile_grant_versions
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_profile_grant_versions_no_truncate
  before truncate on public.sp_write_profile_grant_versions
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_bounded_authorizations_immutable
  before update or delete on public.sp_write_bounded_authorizations
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_bounded_authorizations_no_truncate
  before truncate on public.sp_write_bounded_authorizations
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_bounded_authorization_profiles_immutable
  before update or delete on public.sp_write_bounded_authorization_profiles
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_bounded_authorization_profiles_no_truncate
  before truncate on public.sp_write_bounded_authorization_profiles
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_bounded_authorization_entities_immutable
  before update or delete on public.sp_write_bounded_authorization_entities
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_bounded_authorization_entities_no_truncate
  before truncate on public.sp_write_bounded_authorization_entities
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_bounded_authorization_revocations_immutable
  before update or delete on public.sp_write_bounded_authorization_revocations
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_bounded_authorization_revocations_no_truncate
  before truncate on public.sp_write_bounded_authorization_revocations
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_bounded_authorization_consumptions_immutable
  before update or delete on public.sp_write_bounded_authorization_consumptions
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_bounded_authorization_consumptions_no_truncate
  before truncate on public.sp_write_bounded_authorization_consumptions
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_plans_immutable
  before update or delete on public.sp_write_plans
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_plans_no_truncate
  before truncate on public.sp_write_plans
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_plan_actions_immutable
  before update or delete on public.sp_write_plan_actions
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_plan_actions_no_truncate
  before truncate on public.sp_write_plan_actions
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_approval_requests_immutable
  before update or delete on public.sp_write_approval_requests
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_approval_requests_no_truncate
  before truncate on public.sp_write_approval_requests
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_execution_cycles_immutable
  before update or delete on public.sp_write_execution_cycles
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_execution_cycles_no_truncate
  before truncate on public.sp_write_execution_cycles
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_authorization_receipts_immutable
  before update or delete on public.sp_write_authorization_receipts
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_authorization_receipts_no_truncate
  before truncate on public.sp_write_authorization_receipts
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_cycle_plans_immutable
  before update or delete on public.sp_write_cycle_plans
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_cycle_plans_no_truncate
  before truncate on public.sp_write_cycle_plans
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_execution_requests_immutable
  before update or delete on public.sp_write_execution_requests
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_execution_requests_no_truncate
  before truncate on public.sp_write_execution_requests
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_dispatch_leases_immutable
  before update or delete on public.sp_write_dispatch_leases
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_dispatch_leases_no_truncate
  before truncate on public.sp_write_dispatch_leases
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_predispatch_observations_immutable
  before update or delete on public.sp_write_predispatch_observations
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_predispatch_observations_no_truncate
  before truncate on public.sp_write_predispatch_observations
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_predispatch_observation_items_immutable
  before update or delete on public.sp_write_predispatch_observation_items
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_predispatch_observation_items_no_truncate
  before truncate on public.sp_write_predispatch_observation_items
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_predispatch_dispositions_immutable
  before update or delete on public.sp_write_predispatch_dispositions
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_predispatch_dispositions_no_truncate
  before truncate on public.sp_write_predispatch_dispositions
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_provider_call_intents_immutable
  before update or delete on public.sp_write_provider_call_intents
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_provider_call_intents_no_truncate
  before truncate on public.sp_write_provider_call_intents
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_provider_call_positions_immutable
  before update or delete on public.sp_write_provider_call_positions
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_provider_call_positions_no_truncate
  before truncate on public.sp_write_provider_call_positions
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_action_resolutions_immutable
  before update or delete on public.sp_write_action_resolutions
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_action_resolutions_no_truncate
  before truncate on public.sp_write_action_resolutions
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_provider_results_immutable
  before update or delete on public.sp_write_provider_results
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_provider_results_no_truncate
  before truncate on public.sp_write_provider_results
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_provider_result_positions_immutable
  before update or delete on public.sp_write_provider_result_positions
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_provider_result_positions_no_truncate
  before truncate on public.sp_write_provider_result_positions
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_outbox_immutable
  before update or delete on public.sp_write_outbox
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_outbox_no_truncate
  before truncate on public.sp_write_outbox
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_observations_immutable
  before update or delete on public.sp_write_observations
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_observations_no_truncate
  before truncate on public.sp_write_observations
  for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_late_result_audits_immutable
  before update or delete on public.sp_write_late_result_audits
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_late_result_audits_no_truncate
  before truncate on public.sp_write_late_result_audits
  for each statement execute function app.reject_sp_write_evidence_truncate();

select app.install_tenant_rls('public.sp_write_profile_grant_versions');
select app.install_tenant_rls('public.sp_write_profile_grant_heads');
select app.install_tenant_rls('public.sp_write_plans');
select app.install_tenant_rls('public.sp_write_plan_actions');
select app.install_tenant_rls('public.sp_write_approval_requests');
select app.install_tenant_rls('public.sp_write_execution_cycles');
select app.install_tenant_rls('public.sp_write_authorization_receipts');
select app.install_tenant_rls('public.sp_write_cycle_plans');
select app.install_tenant_rls('public.sp_write_execution_requests');
select app.install_tenant_rls('public.sp_write_dispatch_leases');
select app.install_tenant_rls('public.sp_write_predispatch_observations');
select app.install_tenant_rls('public.sp_write_predispatch_observation_items');
select app.install_tenant_rls('public.sp_write_predispatch_dispositions');
select app.install_tenant_rls('public.sp_write_provider_call_intents');
select app.install_tenant_rls('public.sp_write_provider_call_positions');
select app.install_tenant_rls('public.sp_write_action_resolutions');
select app.install_tenant_rls('public.sp_write_provider_results');
select app.install_tenant_rls('public.sp_write_provider_result_positions');
select app.install_tenant_rls('public.sp_write_outbox');
select app.install_tenant_rls('public.sp_write_observations');
select app.install_tenant_rls('public.sp_write_late_result_audits');

alter table public.sp_write_bounded_authorization_profiles enable row level security;
alter table public.sp_write_bounded_authorization_entities enable row level security;
create policy service_read on public.sp_write_bounded_authorization_profiles
  for select to service_role using (true);
create policy service_read on public.sp_write_bounded_authorization_entities
  for select to service_role using (true);

revoke all on table
  public.sp_write_environment_gate_versions,
  public.sp_write_environment_gate_head,
  public.sp_write_profile_grant_versions,
  public.sp_write_profile_grant_heads,
  public.sp_write_bounded_authorizations,
  public.sp_write_bounded_authorization_profiles,
  public.sp_write_bounded_authorization_entities,
  public.sp_write_bounded_authorization_revocations,
  public.sp_write_bounded_authorization_consumptions,
  public.sp_write_plans,
  public.sp_write_plan_actions,
  public.sp_write_approval_requests,
  public.sp_write_execution_cycles,
  public.sp_write_authorization_receipts,
  public.sp_write_cycle_plans,
  public.sp_write_execution_requests,
  public.sp_write_dispatch_leases,
  public.sp_write_predispatch_observations,
  public.sp_write_predispatch_observation_items,
  public.sp_write_predispatch_dispositions,
  public.sp_write_provider_call_intents,
  public.sp_write_provider_call_positions,
  public.sp_write_action_resolutions,
  public.sp_write_provider_results,
  public.sp_write_provider_result_positions,
  public.sp_write_outbox,
  public.sp_write_observations,
  public.sp_write_late_result_audits
from public, anon, authenticated, service_role;

grant select on table
  public.sp_write_environment_gate_versions,
  public.sp_write_environment_gate_head,
  public.sp_write_profile_grant_versions,
  public.sp_write_profile_grant_heads,
  public.sp_write_bounded_authorizations,
  public.sp_write_bounded_authorization_profiles,
  public.sp_write_bounded_authorization_entities,
  public.sp_write_bounded_authorization_revocations,
  public.sp_write_bounded_authorization_consumptions,
  public.sp_write_plans,
  public.sp_write_plan_actions,
  public.sp_write_approval_requests,
  public.sp_write_execution_cycles,
  public.sp_write_authorization_receipts,
  public.sp_write_cycle_plans,
  public.sp_write_execution_requests,
  public.sp_write_dispatch_leases,
  public.sp_write_predispatch_observations,
  public.sp_write_predispatch_observation_items,
  public.sp_write_predispatch_dispositions,
  public.sp_write_provider_call_intents,
  public.sp_write_provider_call_positions,
  public.sp_write_action_resolutions,
  public.sp_write_provider_results,
  public.sp_write_provider_result_positions,
  public.sp_write_outbox,
  public.sp_write_observations,
  public.sp_write_late_result_audits
to service_role;

grant select on public.sp_write_profile_grant_versions,
  public.sp_write_profile_grant_heads,
  public.sp_write_plans,
  public.sp_write_plan_actions,
  public.sp_write_approval_requests,
  public.sp_write_execution_cycles,
  public.sp_write_authorization_receipts,
  public.sp_write_cycle_plans,
  public.sp_write_execution_requests,
  public.sp_write_dispatch_leases,
  public.sp_write_predispatch_observations,
  public.sp_write_predispatch_observation_items,
  public.sp_write_predispatch_dispositions,
  public.sp_write_provider_call_intents,
  public.sp_write_provider_call_positions,
  public.sp_write_action_resolutions,
  public.sp_write_provider_results,
  public.sp_write_provider_result_positions,
  public.sp_write_outbox,
  public.sp_write_observations,
  public.sp_write_late_result_audits
to authenticated;

revoke all on public.sp_write_execution_accounting
  from public, anon, authenticated, service_role;
grant select on public.sp_write_execution_accounting to authenticated, service_role;

revoke all on function app.record_sp_write_plan(text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function app.record_sp_write_bounded_authorization(text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function app.approve_sp_write_cycle(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function app.start_sp_write_execution(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function app.acquire_sp_write_dispatch_lease(uuid, uuid, uuid, public.sp_write_route_key, integer)
  from public, anon, authenticated, service_role;
revoke all on function app.reserve_sp_write_provider_call(uuid, uuid, uuid, uuid, text, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function app.append_sp_write_provider_result(text, text, public.sp_write_result_origin)
  from public, anon, authenticated, service_role;
revoke all on function app.append_sp_write_observation(text, text)
  from public, anon, authenticated, service_role;

grant execute on function app.record_sp_write_plan(text, text, jsonb)
  to service_role;
grant execute on function app.record_sp_write_bounded_authorization(text, text, jsonb)
  to service_role;
grant execute on function app.approve_sp_write_cycle(uuid, text)
  to authenticated;
grant execute on function app.start_sp_write_execution(uuid, uuid)
  to service_role;
grant execute on function app.acquire_sp_write_dispatch_lease(uuid, uuid, uuid, public.sp_write_route_key, integer)
  to service_role;
grant execute on function app.reserve_sp_write_provider_call(uuid, uuid, uuid, uuid, text, text, text, text, text)
  to service_role;
grant execute on function app.append_sp_write_provider_result(text, text, public.sp_write_result_origin)
  to service_role;
grant execute on function app.append_sp_write_observation(text, text)
  to service_role;

-- PostgreSQL gives PUBLIC execute on new functions by default. Remove that
-- authority from every internal helper and trigger function in this migration.
revoke all on function
  app.sp_write_sha256(text),
  app.sp_write_exact_json_keys(jsonb, text[]),
  app.sp_write_canonical_text_array(text[]),
  app.sp_write_verified_artifact(text, text, text),
  app.sp_write_instant(timestamptz),
  app.sp_write_gate_snapshot_preimage(uuid, uuid, uuid, timestamptz),
  app.sp_write_reserved_result_id(uuid),
  app.sp_write_action_entity_id(jsonb),
  app.sp_write_plan_binding(jsonb),
  app.sp_write_verified_bounded_authorization(text, text),
  app.sp_write_observed_action_for_side(jsonb, text),
  app.sp_write_disposition_artifact(
    uuid, uuid, text, uuid, uuid, uuid, uuid, text, timestamptz,
    public.sp_write_refusal_reason, text
  ),
  app.sp_write_action_within_bounded_authorization(uuid, uuid, uuid, jsonb),
  app.sp_write_inverse_pair_exact(uuid, uuid),
  app.sp_write_enforce_cycle_plan_binding(),
  app.reject_sp_write_evidence_change(),
  app.reject_sp_write_evidence_truncate(),
  app.guard_org_delete_against_unresolved_sp_write()
from public, anon, authenticated, service_role;

create function app.assert_sp_write_install_empty()
returns void
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if exists (select 1 from public.sp_write_environment_gate_head)
     or exists (select 1 from public.sp_write_profile_grant_heads)
     or exists (select 1 from public.sp_write_bounded_authorizations)
     or exists (select 1 from public.sp_write_bounded_authorization_consumptions)
     or exists (select 1 from public.sp_write_execution_cycles)
     or exists (select 1 from public.sp_write_provider_call_intents)
     or exists (select 1 from public.sp_write_outbox) then
    raise exception 'WP-187 persistence ledger must install empty and disabled';
  end if;
end;
$$;

select app.assert_sp_write_install_empty();
drop function app.assert_sp_write_install_empty();
