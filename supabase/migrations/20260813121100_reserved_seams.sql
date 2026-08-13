-- wizard-ads 0012: reserved seams.
--
-- Tables for lanes that are blocked on an external dependency: SP-API access
-- (sales and traffic, search query performance), DataDive (organic rank), Keepa
-- (BSR proximity), and the creative hub. No code reads or writes these in v1.
--
-- They exist now for one reason: each one is a lane whose shape is already
-- known, and adding a partitioned fact table to a live database with 26 months
-- of data in it is a maintenance window. Adding it now is a migration nobody
-- notices.
--
-- Anything unknown is deliberately jsonb rather than guessed columns.

-- ---------------------------------------------------------------------------
-- SP-API
-- ---------------------------------------------------------------------------

create table public.spapi_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  label text not null,
  selling_partner_id text,
  marketplace_ids text[] not null default '{}',
  vault_secret_id uuid,
  status public.connection_status not null default 'pending',
  connected_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, label)
);

comment on table public.spapi_connections is
  'Reserved: SP-API authorization. Same custody rule as ads_connections, the token in Vault.';

create trigger spapi_connections_touch before update on public.spapi_connections
  for each row execute function app.touch_updated_at();

select app.install_tenant_rls('public.spapi_connections', array['owner', 'admin']);

-- Total sales and traffic: the missing denominator for TACOS.
create table public.fact_sales_traffic_daily (
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  date date not null,
  asin text not null,
  sku text,
  sessions bigint not null default 0,
  page_views bigint not null default 0,
  units_ordered bigint not null default 0,
  ordered_product_sales numeric(14, 4) not null default 0,
  total_order_items bigint not null default 0,
  buy_box_percentage numeric(7, 6),
  loaded_at timestamptz not null default now(),
  primary key (profile_id, date, asin)
) partition by range (date);

create index fact_sales_traffic_daily_date_brin
  on public.fact_sales_traffic_daily using brin (date);
create index fact_sales_traffic_daily_profile_date
  on public.fact_sales_traffic_daily (profile_id, date);

select app.install_tenant_rls('public.fact_sales_traffic_daily');

-- Search Query Performance, weekly. Partitioned monthly on the week start for
-- the same reason as everything else: one automation, one convention.
create table public.fact_sqp_weekly (
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  week_start date not null,
  asin text not null,
  search_query text not null,
  search_volume bigint,
  impressions bigint,
  impression_share numeric(9, 6),
  clicks bigint,
  click_share numeric(9, 6),
  purchases bigint,
  purchase_share numeric(9, 6),
  median_price numeric(14, 4),
  loaded_at timestamptz not null default now(),
  primary key (profile_id, week_start, asin, search_query)
) partition by range (week_start);

comment on table public.fact_sqp_weekly is
  'Reserved: SQP, Sunday-Saturday weeks, top 100 queries per ASIN. SV totals are floors, never sums.';

create index fact_sqp_weekly_week_brin on public.fact_sqp_weekly using brin (week_start);
create index fact_sqp_weekly_profile_week on public.fact_sqp_weekly (profile_id, week_start);

select app.install_tenant_rls('public.fact_sqp_weekly');

-- The SUPA analyzer's output: SQP share against ad spend, per keyword per ASIN.
create type public.supa_rule as enum ('P1', 'P2', 'P3', 'O1', 'O2', 'E1');

create table public.supa_flags (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  week_start date not null,
  asin text not null,
  search_query text not null,
  rule public.supa_rule not null,
  score numeric(12, 4),
  -- Stock is evaluated before rank and CVR, because it causes both.
  out_of_stock_days integer,
  organic_rank integer,
  cvr_gap numeric(9, 6),
  advice text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index supa_flags_key
  on public.supa_flags (profile_id, week_start, asin, search_query, rule);

select app.install_tenant_rls('public.supa_flags');

-- ---------------------------------------------------------------------------
-- Organic rank (DataDive) and BSR proximity (Keepa)
-- ---------------------------------------------------------------------------

create table public.rank_observations (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid references public.ad_profiles (id) on delete cascade,
  asin text not null,
  keyword text not null,
  observed_on date not null,
  organic_rank integer,
  sponsored_rank integer,
  marketplace text,
  source text not null default 'rank_radar',
  created_at timestamptz not null default now()
);

comment on table public.rank_observations is
  'Reserved: organic rank. SQP cannot replace it (absence is data, and ads inflate SQP share), hence a separate source.';

create unique index rank_observations_key
  on public.rank_observations (org_id, asin, keyword, observed_on, source);
create index rank_observations_lookup_idx
  on public.rank_observations (org_id, asin, keyword, observed_on desc);

select app.install_tenant_rls('public.rank_observations');

create table public.keepa_bsr_observations (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  asin text not null,
  observed_at timestamptz not null,
  category text,
  bsr integer,
  price numeric(14, 4),
  rating numeric(4, 2),
  review_count integer,
  created_at timestamptz not null default now()
);

create unique index keepa_bsr_observations_key
  on public.keepa_bsr_observations (org_id, asin, category, observed_at) nulls not distinct;

select app.install_tenant_rls('public.keepa_bsr_observations');

create table public.competitor_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid references public.ad_profiles (id) on delete cascade,
  our_asin text not null,
  competitor_asin text not null,
  category text,
  -- Alert when the relative subcategory BSR gap closes past this.
  proximity_threshold numeric(9, 6),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (org_id, our_asin, competitor_asin)
);

select app.install_tenant_rls('public.competitor_links', array['owner', 'admin', 'analyst']);

-- ---------------------------------------------------------------------------
-- Creative hub
-- ---------------------------------------------------------------------------

create table public.creative_assets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid references public.ad_profiles (id) on delete cascade,
  amazon_asset_id text,
  kind text not null,
  url text,
  -- One row per asset, not per placement: dedupe is the whole point of an
  -- asset-centric creative table.
  content_hash text,
  name text,
  first_seen_at timestamptz not null default now(),
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index creative_assets_key
  on public.creative_assets (org_id, content_hash) nulls not distinct;
create index creative_assets_profile_idx on public.creative_assets (profile_id);

select app.install_tenant_rls('public.creative_assets');

create table public.creative_placements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  asset_id uuid not null references public.creative_assets (id) on delete cascade,
  profile_id uuid references public.ad_profiles (id) on delete cascade,
  campaign_id text,
  ad_group_id text,
  ad_id text,
  state public.entity_state,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

create index creative_placements_asset_idx on public.creative_placements (asset_id);
create index creative_placements_campaign_idx
  on public.creative_placements (profile_id, campaign_id);

select app.install_tenant_rls('public.creative_placements');

-- ---------------------------------------------------------------------------
-- Register the two partitioned seams. No rollup: nothing writes them yet, so
-- there is nothing to aggregate and a guessed aggregate would be worse.
-- ---------------------------------------------------------------------------

insert into app.fact_partitions (table_name, date_column, retention_months)
values
  ('fact_sales_traffic_daily', 'date', 26),
  ('fact_sqp_weekly', 'week_start', 26);

select app.ensure_fact_partitions(current_date, 2);
