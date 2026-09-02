-- WP-195: one operator-visible preview batch, immutable campaign-scoped child runs.
-- Source-only migration. Applying it to a hosted project is a separate operator gate.

set local lock_timeout = '5s';
select pg_advisory_xact_lock(
  pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0)
);

create table public.recommendation_preview_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null,
  client_request_id uuid not null,
  selection_mode text not null,
  request_fingerprint text not null,
  scope_count integer not null,
  scope_fingerprint text not null,
  child_count integer not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint recommendation_preview_batches_profile_fkey
    foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint recommendation_preview_batches_selection_mode_check
    check (selection_mode in ('all', 'selected')),
  constraint recommendation_preview_batches_counts_check
    check (scope_count between 1 and 10000 and child_count > 0 and child_count <= scope_count),
  constraint recommendation_preview_batches_request_fingerprint_check
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint recommendation_preview_batches_scope_fingerprint_check
    check (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint recommendation_preview_batches_tenant_identity_key
    unique (org_id, profile_id, id),
  constraint recommendation_preview_batches_client_request_key
    unique (org_id, profile_id, client_request_id)
);

create index recommendation_preview_batches_profile_created_idx
  on public.recommendation_preview_batches (profile_id, created_at desc);

select app.install_tenant_rls('public.recommendation_preview_batches');

-- Scoped jobs store the already-resolved policy and goal. Historical evidence stays nullable
-- and displayable, but the worker refuses to adopt an unscoped row for execution.
alter table public.recommendation_runs
  add column batch_id uuid,
  add column scope_version smallint,
  add column scope_count integer,
  add column scope_fingerprint text,
  add column strategy_goal text,
  add column job_id uuid;

alter table public.recommendation_runs
  add constraint recommendation_runs_batch_fkey
    foreign key (org_id, profile_id, batch_id)
    references public.recommendation_preview_batches (org_id, profile_id, id) on delete cascade,
  add constraint recommendation_runs_scope_shape_check check (
    (
      scope_version is null and scope_count is null and scope_fingerprint is null
      and strategy_goal is null and job_id is null
    ) or (
      scope_version = 1 and scope_count between 1 and 10000
      and scope_fingerprint ~ '^[0-9a-f]{64}$'
      and strategy_snapshot is not null and btrim(strategy_goal) <> '' and job_id is not null
    )
  ),
  add constraint recommendation_runs_scoped_group_shape_check check (
    scope_version is null or (
      (group_id is null and group_role is null and group_snapshot is null)
      or
      (group_id is not null and group_role is not null and group_snapshot is not null)
    )
  ),
  add constraint recommendation_runs_batch_requires_scope_check
    check (batch_id is null or scope_version = 1),
  add constraint recommendation_runs_tenant_identity_key
    unique (org_id, profile_id, id),
  add constraint recommendation_runs_job_id_key unique (job_id);

create unique index recommendation_runs_batch_group_key
  on public.recommendation_runs (batch_id, group_id) nulls not distinct
  where batch_id is not null;

create unique index recommendation_runs_scope_parent_identity_key
  on public.recommendation_runs (org_id, profile_id, id, batch_id) nulls not distinct;

create unique index sync_jobs_tenant_identity_key
  on public.sync_jobs (org_id, profile_id, id);

alter table public.recommendation_runs
  add constraint recommendation_runs_job_fkey
    foreign key (org_id, profile_id, job_id)
    references public.sync_jobs (org_id, profile_id, id) on delete restrict;

create index recommendation_runs_batch_idx
  on public.recommendation_runs (batch_id);

comment on column public.recommendation_runs.batch_id is
  'Nullable parent for manually requested WP-195 preview batches; scheduled scoped runs have no parent.';
comment on column public.recommendation_runs.scope_fingerprint is
  'SHA-256 over the versioned, domain-separated, bytewise-sorted immutable campaign scope.';
comment on column public.recommendation_runs.strategy_goal is
  'Goal lens resolved with strategy_snapshot at enqueue time for immutable scoped execution.';
comment on column public.recommendation_runs.job_id is
  'Exact sync_jobs ledger row authorized to execute this scoped run.';

create table public.recommendation_run_campaigns (
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null,
  batch_id uuid,
  run_id uuid not null,
  campaign_id text not null,
  created_at timestamptz not null default now(),
  constraint recommendation_run_campaigns_profile_fkey
    foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint recommendation_run_campaigns_run_fkey
    foreign key (org_id, profile_id, run_id)
    references public.recommendation_runs (org_id, profile_id, id) on delete cascade,
  constraint recommendation_run_campaigns_batch_fkey
    foreign key (org_id, profile_id, batch_id)
    references public.recommendation_preview_batches (org_id, profile_id, id) on delete cascade,
  constraint recommendation_run_campaigns_parent_match_fkey
    foreign key (org_id, profile_id, run_id, batch_id)
    references public.recommendation_runs (org_id, profile_id, id, batch_id) on delete cascade,
  constraint recommendation_run_campaigns_campaign_nonempty
    check (btrim(campaign_id) <> ''),
  primary key (run_id, campaign_id)
);

create unique index recommendation_run_campaigns_batch_campaign_key
  on public.recommendation_run_campaigns (batch_id, campaign_id)
  where batch_id is not null;

create index recommendation_run_campaigns_profile_run_idx
  on public.recommendation_run_campaigns (profile_id, run_id, campaign_id);

select app.install_tenant_rls('public.recommendation_run_campaigns');
