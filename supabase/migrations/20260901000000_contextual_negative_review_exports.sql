-- WP-182: contextual-negative human review and immutable offline exports.
--
-- These artifacts prove what an operator reviewed and downloaded. Nothing in
-- this migration represents an Amazon mutation or can enqueue one.

-- The proposal-policy changes and audit index below need brief relation locks.
-- Fail closed instead of waiting behind an active reader or writer; an
-- attended operator can reconcile the ledger and retry safely.
set local lock_timeout = '5s';

create table public.contextual_negative_exports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null,
  marketplace_id text not null,
  note text not null,
  row_count integer not null,
  json_artifact bytea not null,
  json_sha256 text not null,
  csv_artifact bytea not null,
  csv_sha256 text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  constraint contextual_negative_exports_profile_fkey
    foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint contextual_negative_exports_text_nonempty check (
    btrim(marketplace_id) <> ''
    and btrim(note) <> ''
    and btrim(created_by) <> ''
  ),
  constraint contextual_negative_exports_row_count_positive check (row_count > 0),
  constraint contextual_negative_exports_artifacts_nonempty check (
    octet_length(json_artifact) > 0 and octet_length(csv_artifact) > 0
  ),
  constraint contextual_negative_exports_json_sha256 check (
    json_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint contextual_negative_exports_csv_sha256 check (
    csv_sha256 ~ '^[0-9a-f]{64}$'
  )
);

create index contextual_negative_exports_scope_time_idx
  on public.contextual_negative_exports
  (org_id, profile_id, marketplace_id, created_at desc, id desc);

comment on table public.contextual_negative_exports is
  'Immutable exact-byte JSON and CSV evidence for reviewed contextual negatives. Export does not mean Amazon was updated.';
comment on column public.contextual_negative_exports.created_by is
  'Historical actor identifier retained as text even if the originating identity is later deleted.';

-- Members may replay their tenant's artifacts. Inserts come only from the
-- service-backed, capability-checked route; no authenticated role can mutate
-- either proposals or artifacts directly.
select app.install_tenant_rls('public.contextual_negative_exports');
revoke truncate on public.contextual_negative_exports from service_role;
revoke truncate on public.audit_log from service_role;

create or replace function app.guard_contextual_negative_export_artifact()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  -- A cascading organisation purge reaches this trigger only after its parent
  -- org row is gone. That database fact is tenant-bound and cannot be spoofed
  -- by leaving a custom session setting enabled.
  if tg_op = 'DELETE'
     and not exists (select 1 from public.orgs where id = old.org_id) then
    return old;
  end if;

  raise exception 'contextual negative export artifacts are immutable';
end;
$$;

create trigger contextual_negative_exports_immutable
  before update or delete on public.contextual_negative_exports
  for each row execute function app.guard_contextual_negative_export_artifact();

-- Contextual-negative audit evidence is append-only. The only exception is a
-- deliberate organisation purge whose parent row has already been deleted.
-- Testing both OLD and NEW prevents an update from moving an event into or out
-- of the protected action namespace. Updates are never a purge operation.
create or replace function app.guard_query_negative_audit_evidence()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.action like 'query_negative.%'
     or (tg_op = 'UPDATE' and new.action like 'query_negative.%') then
    if tg_op = 'DELETE'
       and not exists (select 1 from public.orgs where id = old.org_id) then
      return old;
    end if;
    raise exception 'contextual negative audit evidence is immutable';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger audit_log_contextual_negative_immutable
  before update or delete on public.audit_log
  for each row execute function app.guard_query_negative_audit_evidence();

create or replace function app.reject_contextual_negative_evidence_truncate()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'contextual negative evidence tables must not be truncated';
end;
$$;

create trigger contextual_negative_exports_no_truncate
  before truncate on public.contextual_negative_exports
  for each statement execute function app.reject_contextual_negative_evidence_truncate();

create trigger audit_log_contextual_negative_no_truncate
  before truncate on public.audit_log
  for each statement execute function app.reject_contextual_negative_evidence_truncate();

create index audit_log_contextual_negative_target_time_idx
  on public.audit_log
  (org_id, target_type, target_id, created_at desc, id desc)
  where action like 'query_negative.%';

-- Revoke proposal writes only after all additive storage, policies, and guards
-- exist so an older deployed reader remains compatible throughout migration.
drop policy if exists tenant_insert on public.contextual_negative_proposals;
drop policy if exists tenant_update on public.contextual_negative_proposals;
drop policy if exists tenant_delete on public.contextual_negative_proposals;
revoke insert, update, delete on public.contextual_negative_proposals from authenticated;
