-- WP-86: human review and immutable export evidence for contextual negatives.
--
-- This is an offline/export surface only. No table or function in this migration
-- can call Amazon or represent an applied Amazon state.

alter table public.contextual_negative_proposals
  add column decided_at timestamptz,
  add column decided_by uuid references auth.users (id) on delete set null;

-- Rows decided before this audit metadata existed retain the only timestamp the
-- old schema can prove. `decided_by` deliberately remains unknown.
update public.contextual_negative_proposals
   set decided_at = updated_at
 where status <> 'proposed' and decided_at is null;

alter table public.contextual_negative_proposals
  add constraint contextual_negative_decision_state check (
    (status = 'proposed' and decided_at is null and decided_by is null)
    or (status <> 'proposed' and decided_at is not null)
  );

-- Browser clients retain tenant-scoped reads, but every review mutation must
-- pass through the capability-checked server route so it is locked, version
-- checked, counted, and audited atomically. The connection behind that route
-- is service-backed; authenticated JWTs cannot bypass it with direct SQL.
drop policy if exists tenant_insert on public.contextual_negative_proposals;
drop policy if exists tenant_update on public.contextual_negative_proposals;
drop policy if exists tenant_delete on public.contextual_negative_proposals;
revoke insert, update, delete on public.contextual_negative_proposals from authenticated;

create unique index contextual_negative_proposals_org_profile_id_key
  on public.contextual_negative_proposals (org_id, profile_id, id);

create table public.contextual_negative_exports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null,
  marketplace_id text not null,
  note text not null,
  row_count integer not null,
  artifact_sha256 text not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint contextual_negative_exports_profile_fkey
    foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint contextual_negative_exports_text_nonempty check (
    btrim(marketplace_id) <> '' and btrim(note) <> ''
  ),
  constraint contextual_negative_exports_row_count_positive check (row_count > 0),
  constraint contextual_negative_exports_sha256 check (
    artifact_sha256 ~ '^[0-9a-f]{64}$'
  ),
  unique (org_id, profile_id, id)
);

create index contextual_negative_exports_profile_time_idx
  on public.contextual_negative_exports
  (profile_id, marketplace_id, created_at desc);

create table public.contextual_negative_export_items (
  export_id uuid not null,
  ordinal integer not null,
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null,
  proposal_id uuid not null,
  marketplace_id text not null,
  campaign_id text not null,
  ad_group_id text not null,
  search_term text not null,
  normalized_query text not null,
  category public.query_category not null,
  source_group_role text not null,
  match_type text not null,
  reason text not null,
  decision_note text,
  snapshot_sha256 text not null,
  created_at timestamptz not null default now(),
  primary key (export_id, ordinal),
  constraint contextual_negative_export_items_export_fkey
    foreign key (org_id, profile_id, export_id)
    references public.contextual_negative_exports (org_id, profile_id, id)
    on delete cascade,
  constraint contextual_negative_export_items_proposal_fkey
    foreign key (org_id, profile_id, proposal_id)
    references public.contextual_negative_proposals (org_id, profile_id, id)
    on delete restrict,
  constraint contextual_negative_export_items_ordinal_positive check (ordinal > 0),
  constraint contextual_negative_export_items_source_group_role_check
    check (source_group_role in ('rank', 'discovery', 'profit', 'shield')),
  constraint contextual_negative_export_items_match_type_check
    check (match_type in ('negative_exact', 'negative_phrase')),
  constraint contextual_negative_export_items_text_nonempty check (
    btrim(marketplace_id) <> '' and btrim(campaign_id) <> ''
    and btrim(ad_group_id) <> '' and btrim(search_term) <> ''
    and btrim(normalized_query) <> '' and btrim(reason) <> ''
  ),
  constraint contextual_negative_export_items_sha256 check (
    snapshot_sha256 ~ '^[0-9a-f]{64}$'
  ),
  unique (proposal_id)
);

create index contextual_negative_export_items_org_export_idx
  on public.contextual_negative_export_items (org_id, export_id, ordinal);

-- Both the review queue and export path retrieve the newest per-proposal audit
-- note. Without this access path a queue of N rows performs N scans ordered by
-- timestamp over the tenant's full audit history.
create index audit_log_contextual_negative_target_time_idx
  on public.audit_log
  (org_id, target_type, target_id, created_at desc, id desc);

-- Members can read the evidence. Only the service connection behind the
-- capability-checked web route inserts it; no application role can edit it.
select app.install_tenant_rls('public.contextual_negative_exports');
select app.install_tenant_rls('public.contextual_negative_export_items');

create or replace function app.guard_query_negative_export_header_update()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  -- `created_by` deliberately uses ON DELETE SET NULL. Permit only that FK
  -- retention transition; every byte of export evidence remains unchanged.
  if old.created_by is not null
     and new.created_by is null
     and (to_jsonb(new) - 'created_by') = (to_jsonb(old) - 'created_by') then
    return new;
  end if;
  raise exception 'contextual negative export evidence is immutable';
end;
$$;

create or replace function app.refuse_query_negative_export_item_update()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'contextual negative export evidence is immutable';
end;
$$;

create trigger contextual_negative_exports_immutable
  before update on public.contextual_negative_exports
  for each row execute function app.guard_query_negative_export_header_update();

create trigger contextual_negative_export_items_immutable
  before update on public.contextual_negative_export_items
  for each row execute function app.refuse_query_negative_export_item_update();

comment on table public.contextual_negative_exports is
  'Immutable headers for operator-reviewed contextual-negative export artifacts. Export does not mean Amazon was updated.';

comment on table public.contextual_negative_export_items is
  'Frozen proposal snapshots rendered as CSV or JSON; never re-read from mutable proposal data.';
