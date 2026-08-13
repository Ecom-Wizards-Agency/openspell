-- wizard-ads 0004: fact tables.
--
-- Every fact is one profile, one day, one grain, and every one is a declarative
-- monthly range partition on its date column. Two indexes per table, both
-- earning their keep: BRIN on date (facts arrive in date order, so a BRIN
-- summarises a month in a few kilobytes) and btree on (profile_id, date),
-- which is the shape of literally every query the product makes.
--
-- Three properties of Amazon reporting are baked in on purpose:
--
--  * Zero-impression rows are omitted by the API. Absence is not zero, so
--    freshness is read from `report_requests`, never inferred from facts.
--  * Sales restate for 14+ days, so each attribution window is its own column
--    instead of one "sales" number that quietly changes meaning.
--  * Same-day data is provisional. `fact_profile_daily.provisional` says so,
--    and the crosscheck excludes those days rather than explaining them away.
--
-- There is deliberately NO default partition. An insert for a month nobody
-- pre-created must fail loudly; a default partition would swallow it and then
-- make attaching the real partition require a full scan.

-- ---------------------------------------------------------------------------
-- Registry: which tables the partition automation manages, and for how long
-- ---------------------------------------------------------------------------

create table app.fact_partitions (
  table_name text primary key,
  date_column text not null,
  -- PLAN.md: 26 months of daily facts, 13 for search terms.
  retention_months integer not null check (retention_months > 0),
  -- Null means "drop without rolling up" (reserved seams with no metrics yet).
  rollup_source text,
  rollup_dimensions text[] not null default '{}',
  rollup_metrics text[] not null default '{}',
  created_at timestamptz not null default now()
);

comment on table app.fact_partitions is
  'The partition automation is table-driven: adding a fact table means adding a row here, not editing a function.';

-- Where the numbers from a dropped partition survive. One table rather than one per
-- fact: nothing in v1 reads these except a retention audit, and a single
-- (source, dimensions) shape keeps the automation generic.
create table public.fact_monthly_rollup (
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  month date not null,
  source text not null,
  dimensions jsonb not null default '{}'::jsonb,
  days integer not null default 0,
  impressions bigint,
  clicks bigint,
  cost numeric(16, 4),
  purchases_7d bigint,
  purchases_14d bigint,
  sales_7d numeric(16, 4),
  sales_14d numeric(16, 4),
  units_sold_7d bigint,
  rolled_up_at timestamptz not null default now(),
  primary key (profile_id, month, source, dimensions)
);

comment on table public.fact_monthly_rollup is
  'Monthly aggregate of fact rows whose daily partition passed retention. Written by app.drop_expired_fact_partitions.';

create index fact_monthly_rollup_org_idx on public.fact_monthly_rollup (org_id, month);

select app.install_tenant_rls('public.fact_monthly_rollup');

-- ---------------------------------------------------------------------------
-- Target grain: the spine
-- ---------------------------------------------------------------------------

create type public.target_kind as enum ('keyword', 'target');

create table public.fact_sp_target_daily (
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  date date not null,
  ad_product public.ad_product not null,
  campaign_id text not null,
  ad_group_id text not null,
  target_id text not null,
  target_kind public.target_kind not null,
  match_type public.match_type,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  cost numeric(14, 4) not null default 0,
  purchases_1d bigint not null default 0,
  purchases_7d bigint not null default 0,
  purchases_14d bigint not null default 0,
  purchases_30d bigint not null default 0,
  sales_1d numeric(14, 4) not null default 0,
  sales_7d numeric(14, 4) not null default 0,
  sales_14d numeric(14, 4) not null default 0,
  sales_30d numeric(14, 4) not null default 0,
  units_sold_7d bigint not null default 0,
  top_of_search_impression_share numeric(7, 6),
  -- Which report load produced this row. The provenance the crosscheck reads.
  report_request_id uuid,
  loaded_at timestamptz not null default now(),
  primary key (profile_id, date, ad_product, campaign_id, ad_group_id, target_id)
) partition by range (date);

comment on table public.fact_sp_target_daily is
  'Target-day grain (keyword or product target). The spine of the product.';

create index fact_sp_target_daily_date_brin on public.fact_sp_target_daily using brin (date);
create index fact_sp_target_daily_profile_date on public.fact_sp_target_daily (profile_id, date);
create index fact_sp_target_daily_org_date on public.fact_sp_target_daily (org_id, date);

-- ---------------------------------------------------------------------------
-- Search-term grain: n-grams and negative candidates
-- ---------------------------------------------------------------------------

create table public.fact_search_term_daily (
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  date date not null,
  ad_product public.ad_product not null,
  campaign_id text not null,
  ad_group_id text not null,
  -- Null where the report attributes a term to an auto target it does not name.
  target_id text,
  search_term text not null,
  match_type public.match_type,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  cost numeric(14, 4) not null default 0,
  purchases_7d bigint not null default 0,
  sales_7d numeric(14, 4) not null default 0,
  units_sold_7d bigint not null default 0,
  report_request_id uuid,
  loaded_at timestamptz not null default now()
) partition by range (date);

comment on table public.fact_search_term_daily is
  'Search-term-day grain. 13-month retention: the widest table and the shortest half-life.';

-- `nulls not distinct` (PG15+) is what makes the upsert idempotent despite the
-- nullable target_id. Without it two loads of the same auto-target row both
-- insert, and the count check in the fetch handler passes while the data lies.
create unique index fact_search_term_daily_grain
  on public.fact_search_term_daily (profile_id, date, campaign_id, ad_group_id, target_id, search_term)
  nulls not distinct;

create index fact_search_term_daily_date_brin on public.fact_search_term_daily using brin (date);
create index fact_search_term_daily_profile_date on public.fact_search_term_daily (profile_id, date);
create index fact_search_term_daily_term on public.fact_search_term_daily (profile_id, search_term);

-- ---------------------------------------------------------------------------
-- Placement grain: adjustments today, off-Amazon leakage later
-- ---------------------------------------------------------------------------

create type public.placement as enum (
  'top_of_search', 'rest_of_search', 'product_pages', 'off_amazon', 'other'
);

create table public.fact_placement_daily (
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  date date not null,
  ad_product public.ad_product not null,
  campaign_id text not null,
  placement public.placement not null,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  cost numeric(14, 4) not null default 0,
  purchases_7d bigint not null default 0,
  sales_7d numeric(14, 4) not null default 0,
  report_request_id uuid,
  loaded_at timestamptz not null default now(),
  primary key (profile_id, date, ad_product, campaign_id, placement)
) partition by range (date);

comment on column public.fact_placement_daily.placement is
  'off_amazon is a real placement in the report, not a synthetic bucket: it is the leakage seam.';

create index fact_placement_daily_date_brin on public.fact_placement_daily using brin (date);
create index fact_placement_daily_profile_date on public.fact_placement_daily (profile_id, date);

-- ---------------------------------------------------------------------------
-- Sponsored Brands and Sponsored Display, campaign grain
-- ---------------------------------------------------------------------------

create table public.fact_sb_daily (
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  date date not null,
  campaign_id text not null,
  ad_group_id text,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  cost numeric(14, 4) not null default 0,
  purchases_7d bigint not null default 0,
  sales_7d numeric(14, 4) not null default 0,
  units_sold_7d bigint not null default 0,
  -- SB reports carry video and viewability metrics no other grain has; they
  -- stay in jsonb until something consumes them.
  metrics jsonb not null default '{}'::jsonb,
  report_request_id uuid,
  loaded_at timestamptz not null default now()
) partition by range (date);

create unique index fact_sb_daily_grain
  on public.fact_sb_daily (profile_id, date, campaign_id, ad_group_id) nulls not distinct;
create index fact_sb_daily_date_brin on public.fact_sb_daily using brin (date);
create index fact_sb_daily_profile_date on public.fact_sb_daily (profile_id, date);

create table public.fact_sd_daily (
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  date date not null,
  campaign_id text not null,
  ad_group_id text,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  cost numeric(14, 4) not null default 0,
  purchases_7d bigint not null default 0,
  sales_7d numeric(14, 4) not null default 0,
  units_sold_7d bigint not null default 0,
  metrics jsonb not null default '{}'::jsonb,
  report_request_id uuid,
  loaded_at timestamptz not null default now()
) partition by range (date);

create unique index fact_sd_daily_grain
  on public.fact_sd_daily (profile_id, date, campaign_id, ad_group_id) nulls not distinct;
create index fact_sd_daily_date_brin on public.fact_sd_daily using brin (date);
create index fact_sd_daily_profile_date on public.fact_sd_daily (profile_id, date);

-- ---------------------------------------------------------------------------
-- Profile rollup: currency, timezone and the provisional flag live here
-- ---------------------------------------------------------------------------

create table public.fact_profile_daily (
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  date date not null,
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  cost numeric(14, 4) not null default 0,
  purchases_7d bigint not null default 0,
  sales_7d numeric(14, 4) not null default 0,
  units_sold_7d bigint not null default 0,
  -- True while sales are still attributing. The crosscheck skips these days.
  provisional boolean not null default false,
  report_request_id uuid,
  loaded_at timestamptz not null default now(),
  primary key (profile_id, date)
) partition by range (date);

create index fact_profile_daily_date_brin on public.fact_profile_daily using brin (date);
create index fact_profile_daily_org_date on public.fact_profile_daily (org_id, date);

-- ---------------------------------------------------------------------------
-- RLS: members read; only the service role writes a fact
-- ---------------------------------------------------------------------------

select app.install_tenant_rls('public.fact_sp_target_daily');
select app.install_tenant_rls('public.fact_search_term_daily');
select app.install_tenant_rls('public.fact_placement_daily');
select app.install_tenant_rls('public.fact_sb_daily');
select app.install_tenant_rls('public.fact_sd_daily');
select app.install_tenant_rls('public.fact_profile_daily');

-- ---------------------------------------------------------------------------
-- Register them
-- ---------------------------------------------------------------------------

insert into app.fact_partitions
  (table_name, date_column, retention_months, rollup_source, rollup_dimensions, rollup_metrics)
values
  ('fact_sp_target_daily', 'date', 26, 'sp_target',
   array['ad_product', 'campaign_id', 'ad_group_id', 'target_id'],
   array['impressions', 'clicks', 'cost', 'purchases_7d', 'purchases_14d', 'sales_7d', 'sales_14d', 'units_sold_7d']),
  ('fact_search_term_daily', 'date', 13, 'search_term',
   array['campaign_id', 'ad_group_id', 'search_term'],
   array['impressions', 'clicks', 'cost', 'purchases_7d', 'sales_7d', 'units_sold_7d']),
  ('fact_placement_daily', 'date', 26, 'placement',
   array['ad_product', 'campaign_id', 'placement'],
   array['impressions', 'clicks', 'cost', 'purchases_7d', 'sales_7d']),
  ('fact_sb_daily', 'date', 26, 'sb',
   array['campaign_id'],
   array['impressions', 'clicks', 'cost', 'purchases_7d', 'sales_7d', 'units_sold_7d']),
  ('fact_sd_daily', 'date', 26, 'sd',
   array['campaign_id'],
   array['impressions', 'clicks', 'cost', 'purchases_7d', 'sales_7d', 'units_sold_7d']),
  ('fact_profile_daily', 'date', 26, 'profile',
   array[]::text[],
   array['impressions', 'clicks', 'cost', 'purchases_7d', 'sales_7d', 'units_sold_7d']);
