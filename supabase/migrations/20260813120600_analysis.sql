-- wizard-ads 0007: analysis outputs.
--
-- `recommendations.inputs` is the differentiator and therefore not optional:
-- the RPC, the click count, which level of the data-confidence hierarchy
-- supplied the CVR, which ceiling bound the result, whether a cap clamped it.
-- A recommendation nobody can audit is a black box with better manners, so the
-- column is `not null` and the shape is RecommendationInputs in
-- packages/shared.

create type public.recommendation_reason as enum (
  'high_acos', 'high_spend_no_sales', 'low_acos', 'low_visibility', 'flag', 'pacing'
);

create type public.recommendation_status as enum (
  'proposed', 'accepted', 'dismissed', 'exported', 'applied', 'superseded'
);

create type public.run_status as enum ('queued', 'running', 'succeeded', 'failed');

create table public.recommendation_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  status public.run_status not null default 'queued',
  lookback_days integer not null,
  window_start date,
  window_end date,
  -- The doctrine document as it was when the run happened. A proposal is only
  -- reproducible if the thresholds that produced it are pinned to the run.
  strategy_snapshot jsonb,
  engine_version text,
  proposals_count integer not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.recommendation_runs.strategy_snapshot is
  'Copy of profile_strategy.doc at run time. Without it a six-week-old proposal cannot be explained.';

create index recommendation_runs_profile_idx
  on public.recommendation_runs (profile_id, created_at desc);

create trigger recommendation_runs_touch before update on public.recommendation_runs
  for each row execute function app.touch_updated_at();

select app.install_tenant_rls('public.recommendation_runs');

create table public.recommendations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.recommendation_runs (id) on delete cascade,
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  reason public.recommendation_reason not null,
  -- EntityRef, flattened: resolvable without a join, exactly as the contract says.
  entity_type public.entity_type not null,
  entity_id text not null,
  ad_product public.ad_product,
  campaign_id text,
  ad_group_id text,
  entity_name text,
  field text not null,
  current_value jsonb,
  proposed_value jsonb,
  -- RecommendationInputs. Not null: provenance is the product.
  inputs jsonb not null,
  status public.recommendation_status not null default 'proposed',
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  export_batch_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index recommendations_run_idx on public.recommendations (run_id);
create index recommendations_open_idx
  on public.recommendations (profile_id, status, created_at desc);
create index recommendations_entity_idx
  on public.recommendations (profile_id, entity_type, entity_id, created_at desc);

create trigger recommendations_touch before update on public.recommendations
  for each row execute function app.touch_updated_at();

-- Analysts accept and dismiss proposals; that is the whole v1 write surface for
-- a human. The rows themselves are created by the engine as the service role.
alter table public.recommendations enable row level security;
create policy tenant_read on public.recommendations for select to authenticated
  using (app.is_org_member(org_id));
create policy tenant_update on public.recommendations for update to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin', 'analyst']))
  with check (app.has_org_role(org_id, array['owner', 'admin', 'analyst']));
revoke all on public.recommendations from anon;
grant select, update on public.recommendations to authenticated;
grant all on public.recommendations to service_role;

-- ---------------------------------------------------------------------------
-- Headless analyst output (v1.x writes it, v1 ships the table)
-- ---------------------------------------------------------------------------

create table public.insights (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid references public.ad_profiles (id) on delete cascade,
  date date not null,
  kind text not null,
  title text not null,
  body text not null,
  -- The numbers the prose refers to, so a claim can be checked without rerunning it.
  figures jsonb not null default '{}'::jsonb,
  source text not null default 'headless_analyst',
  created_at timestamptz not null default now()
);

create index insights_org_date_idx on public.insights (org_id, date desc);
create index insights_profile_date_idx on public.insights (profile_id, date desc);

select app.install_tenant_rls('public.insights');

-- ---------------------------------------------------------------------------
-- Crosscheck: the gate on every write feature
-- ---------------------------------------------------------------------------

create type public.crosscheck_verdict as enum (
  'verified', 'mismatch', 'missing_ours', 'missing_theirs', 'skipped_provisional'
);

create table public.crosscheck_results (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  date date not null,
  grain text not null,
  entity_id text,
  metric text not null,
  ours numeric(16, 4),
  theirs numeric(16, 4),
  delta_pct numeric(10, 6),
  tolerance numeric(10, 6) not null,
  verdict public.crosscheck_verdict not null,
  source text,
  run_id uuid,
  created_at timestamptz not null default now()
);

comment on table public.crosscheck_results is
  'Per-profile, per-day comparison against the incumbent tool. 14 consecutive verified profile-grain days is the v1 exit gate.';

create unique index crosscheck_results_grain_key
  on public.crosscheck_results (profile_id, date, grain, entity_id, metric) nulls not distinct;
create index crosscheck_results_verdict_idx
  on public.crosscheck_results (profile_id, date desc, verdict);

select app.install_tenant_rls('public.crosscheck_results');
