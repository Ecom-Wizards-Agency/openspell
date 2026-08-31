-- WP-181: durable, default-off Unified Reporting sidecar.
--
-- Reporting v3 remains the only report_requests/fact/promotion authority. These
-- tables record separate, metadata-only Unified attempts. No trigger creates a
-- sidecar: worker admission must first pass its deployment and feature gates.

-- Parent-ledger DDL below is metadata-only but still needs brief table locks.
-- Fail rather than wait behind live traffic; the operator can retry the inert
-- migration in a quieter window without causing a lock convoy.
set lock_timeout = '5s';

alter type public.sync_job_type add value 'report.unified.advance';

create type public.unified_report_definition_version as enum (
  'campaign-observation-v1'
);

create type public.unified_report_run_state as enum (
  'create_ready',
  'create_dispatching',
  'observing',
  'create_refused',
  'create_ambiguous',
  'retrieve_refused',
  'provider_status_observed',
  'contract_blocked',
  'observation_horizon_reached',
  'paused',
  'local_failed'
);

create type public.unified_report_operation_kind as enum ('create', 'retrieve');
create type public.unified_report_operation_state as enum ('ready', 'dispatching', 'settled');
create type public.unified_report_operation_disposition as enum (
  'provider_success',
  'provider_refused',
  'create_ambiguous',
  'transport_failure',
  'invalid_response',
  'local_refusal',
  'interrupted_dispatch'
);

create table public.unified_reporting_bindings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null,
  -- Explicit provider identifier. It is never inferred from Ads profile/account fields.
  advertiser_account_id text not null,
  enabled boolean not null default false,
  definition_version public.unified_report_definition_version not null
    default 'campaign-observation-v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint unified_reporting_bindings_profile_fkey
    foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint unified_reporting_bindings_profile_key unique (profile_id),
  constraint unified_reporting_bindings_tenant_identity_key unique (org_id, profile_id, id),
  constraint unified_reporting_bindings_advertiser_account_id_bounded
    check (
      advertiser_account_id = btrim(advertiser_account_id)
      and length(advertiser_account_id) between 1 and 256
    )
);

comment on table public.unified_reporting_bindings is
  'Explicit Unified advertiser-account binding per Ads profile. Disabled by default and never inferred from v2 account/profile identifiers.';

create table public.unified_report_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null,
  v3_report_request_id uuid not null,
  binding_id uuid not null,
  -- Immutable snapshot captured at admission; later binding edits cannot alter a run.
  advertiser_account_id text not null,
  report_type public.report_type not null,
  definition_version public.unified_report_definition_version not null,
  start_date date not null,
  end_date date not null,
  state public.unified_report_run_state not null default 'create_ready',
  provider_report_id text,
  provider_status text,
  observation_deadline timestamptz not null,
  operation_count integer not null default 0,
  settled_operation_count integer not null default 0,
  input_count integer not null default 0,
  provider_success_count integer not null default 0,
  provider_refused_count integer not null default 0,
  create_ambiguous_count integer not null default 0,
  transport_failure_count integer not null default 0,
  invalid_response_count integer not null default 0,
  local_refusal_count integer not null default 0,
  interrupted_dispatch_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint unified_report_runs_profile_fkey
    foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint unified_report_runs_v3_request_fkey
    foreign key (v3_report_request_id)
    references public.report_requests (id) on delete cascade,
  constraint unified_report_runs_binding_fkey
    foreign key (org_id, profile_id, binding_id)
    references public.unified_reporting_bindings (org_id, profile_id, id) on delete restrict,
  constraint unified_report_runs_one_per_v3_request unique (v3_report_request_id),
  constraint unified_report_runs_tenant_identity_key unique (org_id, profile_id, id),
  constraint unified_report_runs_window check (end_date >= start_date),
  constraint unified_report_runs_supported_type check (report_type = 'spCampaigns'),
  constraint unified_report_runs_advertiser_account_id_bounded
    check (
      advertiser_account_id = btrim(advertiser_account_id)
      and length(advertiser_account_id) between 1 and 256
    ),
  constraint unified_report_runs_provider_fields_bounded check (
    (provider_report_id is null or (
      provider_report_id = btrim(provider_report_id)
      and length(provider_report_id) between 1 and 256
    ))
    and (provider_status is null or (
      provider_status = btrim(provider_status)
      and length(provider_status) between 1 and 256
    ))
  ),
  constraint unified_report_runs_provider_identity_complete check (
    (provider_status is null and provider_report_id is null)
    or (provider_status is not null and provider_report_id is not null)
  ),
  constraint unified_report_runs_provider_id_state check (
    (state in (
      'observing', 'retrieve_refused', 'provider_status_observed',
      'contract_blocked', 'observation_horizon_reached'
    ) and provider_report_id is not null)
    or (state in ('create_ready', 'create_dispatching', 'create_refused', 'create_ambiguous')
      and provider_report_id is null)
    or state in ('paused', 'local_failed')
  ),
  constraint unified_report_runs_counts_nonnegative check (
    operation_count >= 0 and settled_operation_count >= 0 and input_count >= 0
    and provider_success_count >= 0 and provider_refused_count >= 0
    and create_ambiguous_count >= 0 and transport_failure_count >= 0
    and invalid_response_count >= 0 and local_refusal_count >= 0
    and interrupted_dispatch_count >= 0
  ),
  constraint unified_report_runs_counts_reconciled check (
    input_count = operation_count
    and settled_operation_count <= operation_count
    and settled_operation_count = provider_success_count + provider_refused_count
      + create_ambiguous_count + transport_failure_count + invalid_response_count
      + local_refusal_count + interrupted_dispatch_count
  )
);

comment on table public.unified_report_runs is
  'One immutable Unified sidecar request snapshot per Reporting v3 request. It never promotes facts or changes report_requests state.';

create index unified_report_runs_profile_state_idx
  on public.unified_report_runs (profile_id, state, updated_at desc);
create index unified_report_runs_binding_idx
  on public.unified_report_runs (binding_id, created_at desc);

create table public.unified_report_operations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null,
  run_id uuid not null,
  dispatch_job_id uuid not null,
  kind public.unified_report_operation_kind not null,
  sequence integer not null,
  state public.unified_report_operation_state not null default 'ready',
  disposition public.unified_report_operation_disposition,
  dispatch_token uuid,
  dispatched_at timestamptz,
  settled_at timestamptz,
  provider_code text,
  input_count integer not null default 1,
  provider_success_count integer not null default 0,
  provider_refused_count integer not null default 0,
  create_ambiguous_count integer not null default 0,
  transport_failure_count integer not null default 0,
  invalid_response_count integer not null default 0,
  local_refusal_count integer not null default 0,
  interrupted_dispatch_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint unified_report_operations_run_fkey
    foreign key (org_id, profile_id, run_id)
    references public.unified_report_runs (org_id, profile_id, id) on delete cascade,
  constraint unified_report_operations_dispatch_job_fkey
    foreign key (dispatch_job_id)
    references public.sync_jobs (id) on delete restrict,
  constraint unified_report_operations_dispatch_job_key unique (dispatch_job_id),
  constraint unified_report_operations_run_sequence_key unique (run_id, sequence),
  constraint unified_report_operations_sequence_kind check (
    (kind = 'create' and sequence = 0)
    or (kind = 'retrieve' and sequence > 0)
  ),
  constraint unified_report_operations_disposition_kind check (
    (disposition is distinct from 'create_ambiguous' or kind = 'create')
    and (disposition is distinct from 'interrupted_dispatch' or kind = 'retrieve')
  ),
  constraint unified_report_operations_input_exactly_one check (input_count = 1),
  constraint unified_report_operations_provider_code_bounded check (
    provider_code is null or (
      provider_code = btrim(provider_code) and length(provider_code) between 1 and 128
    )
  ),
  constraint unified_report_operations_counts_binary check (
    provider_success_count between 0 and 1
    and provider_refused_count between 0 and 1
    and create_ambiguous_count between 0 and 1
    and transport_failure_count between 0 and 1
    and invalid_response_count between 0 and 1
    and local_refusal_count between 0 and 1
    and interrupted_dispatch_count between 0 and 1
  ),
  constraint unified_report_operations_state_accounting check (
    (state = 'ready'
      and disposition is null and dispatch_token is null and dispatched_at is null and settled_at is null
      and provider_success_count + provider_refused_count + create_ambiguous_count
        + transport_failure_count + invalid_response_count + local_refusal_count
        + interrupted_dispatch_count = 0)
    or (state = 'dispatching'
      and disposition is null and dispatch_token is not null and dispatched_at is not null and settled_at is null
      and provider_success_count + provider_refused_count + create_ambiguous_count
        + transport_failure_count + invalid_response_count + local_refusal_count
        + interrupted_dispatch_count = 0)
    or (state = 'settled'
      and disposition is not null and settled_at is not null
      and provider_success_count + provider_refused_count + create_ambiguous_count
        + transport_failure_count + invalid_response_count + local_refusal_count
        + interrupted_dispatch_count = 1
      and (
        (disposition = 'provider_success' and provider_success_count = 1)
        or (disposition = 'provider_refused' and provider_refused_count = 1)
        or (disposition = 'create_ambiguous' and create_ambiguous_count = 1)
        or (disposition = 'transport_failure' and transport_failure_count = 1)
        or (disposition = 'invalid_response' and invalid_response_count = 1)
        or (disposition = 'local_refusal' and local_refusal_count = 1)
        or (disposition = 'interrupted_dispatch' and interrupted_dispatch_count = 1)
      )
    )
  ),
  constraint unified_report_operations_dispatch_fence check (
    (state = 'settled' and disposition = 'local_refusal'
      and dispatch_token is null and dispatched_at is null)
    or (state <> 'settled' or disposition <> 'local_refusal')
  ),
  constraint unified_report_operations_provider_settlement_fence check (
    state <> 'settled' or disposition = 'local_refusal'
    or (dispatch_token is not null and dispatched_at is not null)
  )
);

comment on table public.unified_report_operations is
  'Append-only one-input Unified create/retrieve operation ledger. Worker transactions reconcile its settled dispositions into unified_report_runs.';

create index unified_report_operations_run_state_idx
  on public.unified_report_operations (run_id, state, sequence);
create unique index unified_report_operations_one_create_per_run
  on public.unified_report_operations (run_id)
  where kind = 'create';
create index unified_report_operations_dispatching_idx
  on public.unified_report_operations (dispatched_at)
  where state = 'dispatching';

-- The referenced v3 and queue tables are established, high-write ledgers.
-- Scope triggers preserve tenant/profile matching through their primary keys
-- without lock-heavy composite unique-index builds during hosted rollout.
create or replace function app.assert_unified_run_v3_scope()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform 1
    from public.report_requests r
   where r.id = new.v3_report_request_id
     and r.org_id = new.org_id
     and r.profile_id = new.profile_id
   for share;
  if not found then
    raise exception 'Unified run does not match its tenant-scoped v3 request'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger unified_report_runs_v3_scope
before insert or update of org_id, profile_id, v3_report_request_id
on public.unified_report_runs
for each row execute function app.assert_unified_run_v3_scope();

create or replace function app.assert_unified_operation_job_scope()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform 1
    from public.sync_jobs j
   where j.id = new.dispatch_job_id
     and j.org_id = new.org_id
     and j.profile_id = new.profile_id
   for share;
  if not found then
    raise exception 'Unified operation does not match its tenant-scoped queue job'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger unified_report_operations_job_scope
before insert or update of org_id, profile_id, dispatch_job_id
on public.unified_report_operations
for each row execute function app.assert_unified_operation_job_scope();

create or replace function app.guard_unified_v3_parent_scope()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if (
    new.org_id is distinct from old.org_id
    or new.profile_id is distinct from old.profile_id
  ) then
    raise exception 'V3 request tenant scope is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger report_requests_unified_scope_guard
before update of org_id, profile_id
on public.report_requests
for each row execute function app.guard_unified_v3_parent_scope();

create or replace function app.guard_unified_job_parent_scope()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if (
    new.org_id is distinct from old.org_id
    or new.profile_id is distinct from old.profile_id
  ) then
    raise exception 'Queue job tenant scope is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger sync_jobs_unified_scope_guard
before update of org_id, profile_id
on public.sync_jobs
for each row execute function app.guard_unified_job_parent_scope();

select app.install_tenant_rls('public.unified_reporting_bindings', array['owner', 'admin']);
select app.install_tenant_rls('public.unified_report_runs');
select app.install_tenant_rls('public.unified_report_operations');

reset lock_timeout;
