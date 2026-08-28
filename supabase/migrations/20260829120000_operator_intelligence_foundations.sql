-- wizard-ads WP-56: operator-intelligence data foundations.
--
-- This migration is additive except for repairing the creative-assets identity
-- index. It does not seed tenant data and it does not enable any Amazon write
-- path. Raw observations and proposals remain worker-owned; the few operator
-- configuration tables explicitly grant writes to analysts and above.

-- A composite profile key makes a row that names org A and a profile from org
-- B unrepresentable in every new table below.
create unique index if not exists ad_profiles_org_id_id_key
  on public.ad_profiles (org_id, id);

-- ---------------------------------------------------------------------------
-- Reporting coverage, historical bootstrap and attribution revisions
-- ---------------------------------------------------------------------------

create type public.report_data_source as enum (
  'amazon_reporting_v3',
  'amazon_unified_reporting',
  'amazon_marketing_stream',
  'secondary_import'
);

create type public.historical_bootstrap_status as enum (
  'pending', 'loading', 'complete', 'partial', 'unavailable', 'failed'
);

create table public.report_coverage (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null,
  report_type text not null,
  grain text not null,
  source public.report_data_source not null,
  status public.historical_bootstrap_status not null default 'pending',
  earliest_requested_date date,
  earliest_returned_date date,
  latest_loaded_date date,
  latest_settled_date date,
  availability_start_date date,
  missing_dates date[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint report_coverage_profile_fkey foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint report_coverage_report_type_nonempty check (btrim(report_type) <> ''),
  constraint report_coverage_grain_nonempty check (btrim(grain) <> ''),
  constraint report_coverage_loaded_order check (
    earliest_returned_date is null or latest_loaded_date is null
    or earliest_returned_date <= latest_loaded_date
  ),
  constraint report_coverage_settled_order check (
    latest_settled_date is null or latest_loaded_date is null
    or latest_settled_date <= latest_loaded_date
  ),
  unique (profile_id, report_type, grain, source)
);

create index report_coverage_profile_status_idx
  on public.report_coverage (profile_id, status, updated_at desc);
create trigger report_coverage_touch before update on public.report_coverage
  for each row execute function app.touch_updated_at();
select app.install_tenant_rls('public.report_coverage');

create table public.historical_bootstrap_progress (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null,
  report_type text not null,
  grain text not null,
  source public.report_data_source not null,
  status public.historical_bootstrap_status not null default 'pending',
  requested_start_date date,
  requested_end_date date,
  availability_start_date date,
  chunks_planned integer not null default 0,
  chunks_completed integer not null default 0,
  chunks_failed integer not null default 0,
  earliest_returned_date date,
  latest_returned_date date,
  last_request_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint historical_bootstrap_profile_fkey foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint historical_bootstrap_report_type_nonempty check (btrim(report_type) <> ''),
  constraint historical_bootstrap_grain_nonempty check (btrim(grain) <> ''),
  constraint historical_bootstrap_request_window check (
    requested_start_date is null or requested_end_date is null
    or requested_end_date >= requested_start_date
  ),
  constraint historical_bootstrap_returned_window check (
    earliest_returned_date is null or latest_returned_date is null
    or latest_returned_date >= earliest_returned_date
  ),
  constraint historical_bootstrap_counts_nonnegative check (
    chunks_planned >= 0 and chunks_completed >= 0 and chunks_failed >= 0
  ),
  constraint historical_bootstrap_counts_bounded check (
    chunks_completed + chunks_failed <= chunks_planned
  ),
  unique (profile_id, report_type, grain, source)
);

create index historical_bootstrap_profile_status_idx
  on public.historical_bootstrap_progress (profile_id, status, updated_at desc);
create trigger historical_bootstrap_progress_touch
  before update on public.historical_bootstrap_progress
  for each row execute function app.touch_updated_at();
select app.install_tenant_rls('public.historical_bootstrap_progress');

create table public.report_promotion_watermarks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null,
  report_type text not null,
  report_date date not null,
  source public.report_data_source not null,
  -- Feature report ids are UUIDs but are not forced through the legacy
  -- report_requests enum, which cannot represent SQP or unified reports yet.
  report_request_id uuid not null,
  requested_at timestamptz not null,
  promoted_at timestamptz not null default now(),
  source_rows bigint not null,
  parsed_rows bigint not null,
  refused_rows bigint not null,
  promoted_rows bigint not null,
  canonical_rows bigint not null,
  constraint report_promotion_profile_fkey foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint report_promotion_report_type_nonempty check (btrim(report_type) <> ''),
  constraint report_promotion_counts_nonnegative check (
    source_rows >= 0 and parsed_rows >= 0 and refused_rows >= 0
    and promoted_rows >= 0 and canonical_rows >= 0
  ),
  constraint report_promotion_source_reconciled check (
    source_rows = parsed_rows + refused_rows
  ),
  constraint report_promotion_promoted_bounded check (promoted_rows <= parsed_rows),
  constraint report_promotion_canonical_bounded check (canonical_rows <= promoted_rows),
  unique (profile_id, report_type, report_date, source)
);

create index report_promotion_request_idx
  on public.report_promotion_watermarks (report_request_id);

-- Late completion of an older request must never displace newer evidence.
create or replace function app.guard_report_promotion_watermark()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.requested_at < old.requested_at then
    raise exception 'an older report request cannot replace a newer promotion watermark'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger report_promotion_watermark_guard
  before update on public.report_promotion_watermarks
  for each row execute function app.guard_report_promotion_watermark();
select app.install_tenant_rls('public.report_promotion_watermarks');

create table public.attribution_observations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null,
  source_observation_key text not null,
  event_date date not null,
  ad_product public.ad_product not null,
  report_type text not null,
  source public.report_data_source not null,
  observed_at timestamptz not null,
  attribution_window_days integer not null,
  event_date_age_days integer not null,
  impressions bigint not null,
  clicks bigint not null,
  cost numeric(16, 4) not null,
  purchases bigint not null,
  sales numeric(16, 4) not null,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  constraint attribution_observations_profile_fkey foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint attribution_observations_key_nonempty check (btrim(source_observation_key) <> ''),
  constraint attribution_observations_report_type_nonempty check (btrim(report_type) <> ''),
  constraint attribution_observations_window_positive check (attribution_window_days > 0),
  constraint attribution_observations_age_nonnegative check (event_date_age_days >= 0),
  constraint attribution_observations_metrics_nonnegative check (
    impressions >= 0 and clicks >= 0 and cost >= 0 and purchases >= 0 and sales >= 0
  ),
  constraint attribution_observations_traffic_order check (clicks <= impressions),
  constraint attribution_observations_superseded_order check (
    superseded_at is null or superseded_at >= observed_at
  ),
  unique (profile_id, source, source_observation_key)
);

create index attribution_observations_cohort_idx
  on public.attribution_observations
    (profile_id, ad_product, report_type, event_date, observed_at);
select app.install_tenant_rls('public.attribution_observations');

-- ---------------------------------------------------------------------------
-- Creative performance: Amazon Asset ID is authoritative
-- ---------------------------------------------------------------------------

drop index if exists public.creative_assets_key;

alter table public.creative_assets
  add column if not exists amazon_created_at timestamptz,
  add column if not exists amazon_updated_at timestamptz;

create unique index creative_assets_profile_amazon_asset_key
  on public.creative_assets (profile_id, amazon_asset_id)
  where profile_id is not null and amazon_asset_id is not null;
create unique index creative_assets_org_profile_id_key
  on public.creative_assets (org_id, profile_id, id);
create index creative_assets_content_hash_idx
  on public.creative_assets (org_id, content_hash)
  where content_hash is not null;

-- Existing reserved-seam rows are not rewritten by this additive migration.
-- The NOT VALID fence still rejects every new cross-tenant/profile asset; a
-- separately authorized production rollout may validate legacy rows first.
alter table public.creative_assets
  add constraint creative_assets_org_profile_fkey
  foreign key (org_id, profile_id)
  references public.ad_profiles (org_id, id) on delete cascade
  not valid;

create type public.creative_attribution_state as enum (
  'mapped', 'legacy', 'unsupported', 'ambiguous', 'unmapped'
);

create table public.ad_creative_asset_mappings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null,
  source_mapping_key text not null,
  ad_product public.ad_product not null,
  campaign_id text not null,
  ad_group_id text not null,
  ad_id text not null,
  creative_id text,
  creative_asset_id uuid,
  amazon_asset_id text,
  placement public.placement,
  attribution_state public.creative_attribution_state not null,
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint ad_creative_asset_mappings_profile_fkey foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint ad_creative_asset_mappings_asset_fkey
    foreign key (org_id, profile_id, creative_asset_id)
    references public.creative_assets (org_id, profile_id, id) on delete restrict,
  constraint ad_creative_asset_mappings_source_key_nonempty
    check (btrim(source_mapping_key) <> ''),
  constraint ad_creative_asset_mappings_ids_nonempty check (
    btrim(campaign_id) <> '' and btrim(ad_group_id) <> '' and btrim(ad_id) <> ''
  ),
  constraint ad_creative_asset_mappings_mapped_asset check (
    attribution_state <> 'mapped'
    or (creative_asset_id is not null and amazon_asset_id is not null)
  ),
  unique (profile_id, source_mapping_key)
);

create index ad_creative_asset_mappings_asset_idx
  on public.ad_creative_asset_mappings (profile_id, amazon_asset_id, observed_at desc);
create index ad_creative_asset_mappings_ad_idx
  on public.ad_creative_asset_mappings (profile_id, ad_product, ad_id, observed_at desc);
select app.install_tenant_rls('public.ad_creative_asset_mappings');

create table public.fact_creative_daily (
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null,
  date date not null,
  ad_product public.ad_product not null,
  campaign_id text not null,
  ad_group_id text not null,
  ad_id text not null,
  creative_id text,
  amazon_asset_id text,
  placement public.placement,
  attribution_state public.creative_attribution_state not null,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  cost numeric(16, 4) not null default 0,
  purchases bigint not null default 0,
  sales numeric(16, 4) not null default 0,
  video_first_quartile_views bigint,
  video_midpoint_views bigint,
  video_third_quartile_views bigint,
  video_complete_views bigint,
  loaded_at timestamptz not null default now(),
  constraint fact_creative_daily_profile_fkey foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint fact_creative_daily_metrics_nonnegative check (
    impressions >= 0 and clicks >= 0 and cost >= 0 and purchases >= 0 and sales >= 0
    and (video_first_quartile_views is null or video_first_quartile_views >= 0)
    and (video_midpoint_views is null or video_midpoint_views >= 0)
    and (video_third_quartile_views is null or video_third_quartile_views >= 0)
    and (video_complete_views is null or video_complete_views >= 0)
  ),
  constraint fact_creative_daily_traffic_order check (clicks <= impressions),
  constraint fact_creative_daily_mapped_asset check (
    attribution_state <> 'mapped' or amazon_asset_id is not null
  )
) partition by range (date);

create unique index fact_creative_daily_grain_key
  on public.fact_creative_daily
    (profile_id, date, ad_product, campaign_id, ad_group_id, ad_id,
     creative_id, amazon_asset_id, placement)
  nulls not distinct;
create index fact_creative_daily_date_brin on public.fact_creative_daily using brin (date);
create index fact_creative_daily_profile_date
  on public.fact_creative_daily (profile_id, date);
select app.install_tenant_rls('public.fact_creative_daily');

insert into app.fact_partitions (table_name, date_column, retention_months)
values ('fact_creative_daily', 'date', 26);

-- ---------------------------------------------------------------------------
-- SQP vocabulary, categories and contextual review proposals
-- ---------------------------------------------------------------------------

create type public.query_category as enum (
  'own_brand', 'competitor', 'core', 'head', 'excluded', 'unreviewed'
);
create type public.query_vocabulary_kind as enum (
  'own_brand_term', 'own_brand_alias', 'competitor_brand',
  'competitor_asin', 'core_term', 'exclusion'
);
create type public.query_vocabulary_source as enum (
  'operator', 'import', 'ai_suggestion'
);

alter table public.fact_sqp_weekly
  add column if not exists marketplace_id text,
  add column if not exists week_end date generated always as (week_start + 6) stored,
  add column if not exists normalized_query text,
  add column if not exists category public.query_category not null default 'unreviewed',
  add column if not exists search_query_score numeric(16, 6),
  add column if not exists total_impressions bigint,
  add column if not exists asin_impressions bigint,
  add column if not exists total_clicks bigint,
  add column if not exists asin_clicks bigint,
  add column if not exists total_cart_adds bigint,
  add column if not exists asin_cart_adds bigint,
  add column if not exists asin_cart_add_share numeric(9, 6),
  add column if not exists total_purchases bigint,
  add column if not exists asin_purchases bigint;

alter table public.fact_sqp_weekly
  add constraint fact_sqp_weekly_sunday_start
    check (extract(dow from week_start) = 0) not valid,
  add constraint fact_sqp_weekly_new_counts_nonnegative check (
    (search_query_score is null or search_query_score >= 0)
    and (total_impressions is null or total_impressions >= 0)
    and (asin_impressions is null or asin_impressions >= 0)
    and (total_clicks is null or total_clicks >= 0)
    and (asin_clicks is null or asin_clicks >= 0)
    and (total_cart_adds is null or total_cart_adds >= 0)
    and (asin_cart_adds is null or asin_cart_adds >= 0)
    and (total_purchases is null or total_purchases >= 0)
    and (asin_purchases is null or asin_purchases >= 0)
  ),
  add constraint fact_sqp_weekly_new_counts_bounded check (
    (asin_impressions is null or total_impressions is null or asin_impressions <= total_impressions)
    and (asin_clicks is null or total_clicks is null or asin_clicks <= total_clicks)
    and (asin_cart_adds is null or total_cart_adds is null or asin_cart_adds <= total_cart_adds)
    and (asin_purchases is null or total_purchases is null or asin_purchases <= total_purchases)
  ),
  add constraint fact_sqp_weekly_shares_bounded check (
    (impression_share is null or impression_share between 0 and 1)
    and (click_share is null or click_share between 0 and 1)
    and (asin_cart_add_share is null or asin_cart_add_share between 0 and 1)
    and (purchase_share is null or purchase_share between 0 and 1)
  ),
  -- Legacy reserved-seam rows remain explicit (marketplace_id is null). Once
  -- a worker identifies a marketplace it must write the full v1 contract; a
  -- half-new row cannot masquerade as complete SQP evidence.
  add constraint fact_sqp_weekly_contract_complete check (
    marketplace_id is null
    or (
      btrim(marketplace_id) <> '' and normalized_query is not null
      and btrim(normalized_query) <> ''
      and total_impressions is not null and asin_impressions is not null
      and impression_share is not null
      and total_clicks is not null and asin_clicks is not null
      and click_share is not null
      and total_cart_adds is not null and asin_cart_adds is not null
      and asin_cart_add_share is not null
      and total_purchases is not null and asin_purchases is not null
      and purchase_share is not null
    )
  );

create index fact_sqp_weekly_category_idx
  on public.fact_sqp_weekly (profile_id, week_start, category);
create unique index fact_sqp_weekly_normalized_grain_key
  on public.fact_sqp_weekly
    (profile_id, marketplace_id, week_start, asin, normalized_query)
  where marketplace_id is not null and normalized_query is not null;

create table public.query_vocabulary (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  marketplace_id text not null,
  kind public.query_vocabulary_kind not null,
  value text not null,
  normalized_value text not null,
  source public.query_vocabulary_source not null,
  approved boolean not null default false,
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint query_vocabulary_marketplace_nonempty check (btrim(marketplace_id) <> ''),
  constraint query_vocabulary_value_nonempty check (btrim(value) <> ''),
  constraint query_vocabulary_normalized_nonempty check (btrim(normalized_value) <> ''),
  constraint query_vocabulary_review_state check (
    not approved or reviewed_at is not null
  ),
  unique (org_id, marketplace_id, kind, normalized_value)
);

create index query_vocabulary_review_idx
  on public.query_vocabulary (org_id, marketplace_id, approved, kind);
create trigger query_vocabulary_touch before update on public.query_vocabulary
  for each row execute function app.touch_updated_at();
select app.install_tenant_rls(
  'public.query_vocabulary', array['owner', 'admin', 'analyst']
);

create table public.contextual_negative_proposals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null,
  marketplace_id text not null,
  campaign_id text not null,
  ad_group_id text not null,
  search_term text not null,
  normalized_query text not null,
  category public.query_category not null,
  source_group_role text not null,
  match_type text not null,
  reason text not null,
  status text not null default 'proposed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contextual_negative_profile_fkey foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint contextual_negative_source_group_role_check
    check (source_group_role in ('rank', 'discovery', 'profit', 'shield')),
  constraint contextual_negative_match_type_check
    check (match_type in ('negative_exact', 'negative_phrase')),
  constraint contextual_negative_status_check
    check (status in ('proposed', 'accepted', 'dismissed', 'exported')),
  constraint contextual_negative_text_nonempty check (
    btrim(marketplace_id) <> '' and btrim(campaign_id) <> ''
    and btrim(ad_group_id) <> '' and btrim(search_term) <> ''
    and btrim(normalized_query) <> '' and btrim(reason) <> ''
  ),
  unique (profile_id, campaign_id, ad_group_id, normalized_query, match_type)
);

create index contextual_negative_review_idx
  on public.contextual_negative_proposals (profile_id, status, category, created_at desc);
create trigger contextual_negative_proposals_touch
  before update on public.contextual_negative_proposals
  for each row execute function app.touch_updated_at();
select app.install_tenant_rls(
  'public.contextual_negative_proposals', array['owner', 'admin', 'analyst']
);

-- ---------------------------------------------------------------------------
-- Persistent optimization groups and recommendation observations
-- ---------------------------------------------------------------------------

create type public.optimization_group_role as enum ('rank', 'discovery', 'profit', 'shield');
create type public.optimization_prioritization as enum (
  'efficiency_first', 'growth_first', 'balanced'
);
create type public.recommendation_evidence_state as enum (
  'awaiting_sync', 'observing', 'complete', 'insufficient', 'conflict'
);
create type public.recommendation_evidence_decision as enum ('hold', 'continue', 'revert');

create table public.optimization_groups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null,
  name text not null,
  role public.optimization_group_role not null,
  target_acos numeric(9, 6) not null,
  bid_floor numeric(12, 4),
  bid_ceiling numeric(12, 4),
  bid_increase_cap numeric(9, 6) not null,
  bid_decrease_cap numeric(9, 6) not null,
  placement_increase_cap numeric(9, 6) not null,
  placement_decrease_cap numeric(9, 6) not null,
  exclusions text[] not null default '{}',
  cadence interval not null,
  prioritization public.optimization_prioritization not null,
  enabled boolean not null default true,
  next_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint optimization_groups_profile_fkey foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint optimization_groups_name_nonempty check (btrim(name) <> ''),
  constraint optimization_groups_values_nonnegative check (
    target_acos >= 0
    and (bid_floor is null or bid_floor >= 0)
    and (bid_ceiling is null or bid_ceiling >= 0)
    and bid_increase_cap >= 0 and bid_decrease_cap >= 0
    and placement_increase_cap >= 0 and placement_decrease_cap >= 0
  ),
  constraint optimization_groups_bid_bounds check (
    bid_floor is null or bid_ceiling is null or bid_floor <= bid_ceiling
  ),
  constraint optimization_groups_cadence_positive check (cadence > interval '0 seconds'),
  unique (profile_id, name),
  unique (org_id, profile_id, id)
);

create index optimization_groups_due_idx
  on public.optimization_groups (next_run_at) where enabled;
create trigger optimization_groups_touch before update on public.optimization_groups
  for each row execute function app.touch_updated_at();
select app.install_tenant_rls(
  'public.optimization_groups', array['owner', 'admin', 'analyst']
);

create table public.campaign_optimization_assignments (
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null,
  campaign_id text not null,
  group_id uuid not null,
  assigned_at timestamptz not null default now(),
  assigned_by uuid references auth.users (id) on delete set null,
  constraint campaign_optimization_assignments_profile_fkey
    foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint campaign_optimization_assignments_group_fkey
    foreign key (org_id, profile_id, group_id)
    references public.optimization_groups (org_id, profile_id, id) on delete cascade,
  constraint campaign_optimization_assignments_campaign_nonempty
    check (btrim(campaign_id) <> ''),
  primary key (profile_id, campaign_id)
);

create index campaign_optimization_assignments_group_idx
  on public.campaign_optimization_assignments (group_id, campaign_id);
select app.install_tenant_rls(
  'public.campaign_optimization_assignments', array['owner', 'admin', 'analyst']
);

alter table public.recommendation_runs
  add column if not exists group_id uuid,
  add column if not exists group_role public.optimization_group_role,
  add column if not exists group_snapshot jsonb,
  add column if not exists due_at timestamptz;

alter table public.recommendation_runs
  add constraint recommendation_runs_group_fkey
  foreign key (org_id, profile_id, group_id)
  references public.optimization_groups (org_id, profile_id, id) on delete restrict;

create unique index recommendations_org_profile_id_key
  on public.recommendations (org_id, profile_id, id);

create table public.recommendation_observations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null,
  recommendation_id uuid not null,
  prior_recommendation_id uuid,
  group_id uuid not null,
  expected_value numeric(16, 6) not null,
  synchronized_value numeric(16, 6),
  synchronized_at timestamptz,
  observation_window_start date not null,
  observation_window_end date not null,
  evidence_state public.recommendation_evidence_state not null,
  decision public.recommendation_evidence_decision not null,
  pre_incremental_volume numeric(16, 6),
  post_incremental_volume numeric(16, 6),
  evidence_note text not null,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint recommendation_observations_profile_fkey foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint recommendation_observations_recommendation_fkey
    foreign key (org_id, profile_id, recommendation_id)
    references public.recommendations (org_id, profile_id, id) on delete cascade,
  constraint recommendation_observations_prior_recommendation_fkey
    foreign key (org_id, profile_id, prior_recommendation_id)
    references public.recommendations (org_id, profile_id, id) on delete restrict,
  constraint recommendation_observations_group_fkey
    foreign key (org_id, profile_id, group_id)
    references public.optimization_groups (org_id, profile_id, id) on delete restrict,
  constraint recommendation_observations_window check (
    observation_window_end >= observation_window_start
  ),
  constraint recommendation_observations_volumes_nonnegative check (
    (pre_incremental_volume is null or pre_incremental_volume >= 0)
    and (post_incremental_volume is null or post_incremental_volume >= 0)
  ),
  constraint recommendation_observations_note_nonempty check (btrim(evidence_note) <> ''),
  constraint recommendation_observations_sync_state check (
    (synchronized_at is null) = (synchronized_value is null)
  ),
  unique (recommendation_id, observed_at)
);

create index recommendation_observations_state_idx
  on public.recommendation_observations (profile_id, evidence_state, observed_at desc);
select app.install_tenant_rls('public.recommendation_observations');

-- ---------------------------------------------------------------------------
-- Marketing Stream ledger, hourly facts and read-only dayparting proposals
-- ---------------------------------------------------------------------------

create type public.marketing_stream_dataset as enum (
  'traffic', 'conversion', 'budget_usage'
);
create type public.hour_settling_state as enum ('settling', 'settled', 'revised');

create table public.marketing_stream_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null,
  message_id text not null,
  dataset public.marketing_stream_dataset not null,
  ad_product public.ad_product not null,
  event_time timestamptz not null,
  received_at timestamptz not null,
  revision integer not null,
  payload_hash text not null,
  raw_payload jsonb not null,
  created_at timestamptz not null default now(),
  constraint marketing_stream_events_profile_fkey foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint marketing_stream_events_message_nonempty check (btrim(message_id) <> ''),
  constraint marketing_stream_events_hash_nonempty check (btrim(payload_hash) <> ''),
  constraint marketing_stream_events_revision_nonnegative check (revision >= 0),
  constraint marketing_stream_events_receive_order check (received_at >= event_time),
  unique (profile_id, dataset, message_id, revision)
);

create index marketing_stream_events_normalize_idx
  on public.marketing_stream_events (profile_id, event_time, received_at);
select app.install_tenant_rls('public.marketing_stream_events');

create table public.marketing_stream_hourly_facts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null,
  ad_product public.ad_product not null,
  campaign_id text not null,
  utc_hour timestamptz not null,
  profile_timezone text not null,
  local_date date not null,
  local_hour smallint not null,
  local_day_of_week smallint not null,
  currency_code text not null,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  cost numeric(16, 4) not null default 0,
  purchases bigint not null default 0,
  sales numeric(16, 4) not null default 0,
  budget_usage_percent numeric(9, 6),
  budget_capped boolean not null default false,
  settling_state public.hour_settling_state not null,
  source_events bigint not null,
  loaded_at timestamptz not null default now(),
  constraint marketing_stream_hourly_profile_fkey foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint marketing_stream_hourly_campaign_nonempty check (btrim(campaign_id) <> ''),
  constraint marketing_stream_hourly_timezone_nonempty check (btrim(profile_timezone) <> ''),
  constraint marketing_stream_hourly_currency check (currency_code ~ '^[A-Z]{3}$'),
  constraint marketing_stream_hourly_hour check (local_hour between 0 and 23),
  constraint marketing_stream_hourly_day check (local_day_of_week between 0 and 6),
  constraint marketing_stream_hourly_utc_truncated check (utc_hour = date_trunc('hour', utc_hour)),
  constraint marketing_stream_hourly_metrics_nonnegative check (
    impressions >= 0 and clicks >= 0 and cost >= 0 and purchases >= 0
    and sales >= 0 and source_events >= 0
    and (budget_usage_percent is null or budget_usage_percent >= 0)
  ),
  constraint marketing_stream_hourly_traffic_order check (clicks <= impressions),
  unique (profile_id, ad_product, campaign_id, utc_hour)
);

create index marketing_stream_hourly_heatmap_idx
  on public.marketing_stream_hourly_facts
    (profile_id, local_day_of_week, local_hour, local_date);
create index marketing_stream_hourly_settling_idx
  on public.marketing_stream_hourly_facts (profile_id, settling_state, utc_hour);
select app.install_tenant_rls('public.marketing_stream_hourly_facts');

create table public.dayparting_schedule_proposals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null,
  campaign_id text not null,
  baseline_label text not null,
  evidence_start date not null,
  evidence_end date not null,
  settled_hours bigint not null,
  blocks jsonb not null,
  status text not null default 'proposed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dayparting_schedule_proposals_profile_fkey foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint dayparting_schedule_proposals_campaign_nonempty check (btrim(campaign_id) <> ''),
  constraint dayparting_schedule_proposals_baseline_nonempty check (btrim(baseline_label) <> ''),
  constraint dayparting_schedule_proposals_window check (evidence_end >= evidence_start),
  constraint dayparting_schedule_proposals_hours_nonnegative check (settled_hours >= 0),
  constraint dayparting_schedule_proposals_blocks_array
    check (jsonb_typeof(blocks) = 'array'),
  constraint dayparting_schedule_proposals_status_check
    check (status in ('proposed', 'accepted', 'dismissed', 'exported'))
);

create index dayparting_schedule_proposals_review_idx
  on public.dayparting_schedule_proposals (profile_id, status, created_at desc);
create trigger dayparting_schedule_proposals_touch
  before update on public.dayparting_schedule_proposals
  for each row execute function app.touch_updated_at();
select app.install_tenant_rls(
  'public.dayparting_schedule_proposals', array['owner', 'admin', 'analyst']
);

-- Open current and next-month creative partitions after registration. This is
-- local migration work only; applying this file to any hosted database remains
-- a separately authorized operator action.
select app.ensure_fact_partitions(current_date, 2);
