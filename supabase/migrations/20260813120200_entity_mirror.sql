-- wizard-ads 0003: the entity mirror.
--
-- One table per entity kind, every one keyed `(profile_id, amazon_id)` exactly
-- as the contract in packages/shared says. The mirror is a snapshot of what
-- Amazon currently reports, plus `entity_changes`, which is the diff between
-- successive snapshots and the only place the question "who changed this bid,
-- us or somebody in Seller Central" can be answered.
--
-- Entities are never hard-deleted by the sync: an entity that stops appearing
-- gets `deleted_at`, because a fact row from last month still points at it.

create type public.ad_product as enum ('SP', 'SB', 'SD');
create type public.entity_state as enum ('enabled', 'paused', 'archived');
create type public.entity_type as enum (
  'portfolio', 'campaign', 'ad_group', 'product_ad', 'keyword', 'target', 'negative'
);
create type public.match_type as enum (
  'exact', 'phrase', 'broad',
  'negative_exact', 'negative_phrase',
  'asin_same_as', 'asin_expanded_from', 'asin_brand_same_as', 'asin_category_same_as',
  'close_match', 'loose_match', 'substitutes', 'complements'
);
create type public.budget_type as enum ('daily', 'lifetime');
create type public.targeting_type as enum ('manual', 'auto');
create type public.bidding_strategy as enum (
  'legacy_for_sales', 'auto_for_sales', 'manual', 'rule_based'
);
create type public.negative_scope as enum ('campaign', 'ad_group');

-- Columns every mirrored entity carries. Written out per table rather than
-- inherited, because table inheritance and RLS are a bad pairing.

create table public.portfolios (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  amazon_id text not null,
  ad_product public.ad_product not null default 'SP',
  name text,
  state public.entity_state not null,
  budget_amount numeric(14, 2),
  budget_policy text,
  first_seen_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (profile_id, amazon_id)
);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  amazon_id text not null,
  ad_product public.ad_product not null,
  name text,
  state public.entity_state not null,
  portfolio_amazon_id text,
  budget_amount numeric(14, 2) not null,
  budget_type public.budget_type not null,
  targeting_type public.targeting_type,
  bidding_strategy public.bidding_strategy,
  -- {topOfSearch, productPages, restOfSearch} as Amazon stores them (percent).
  placement_bidding jsonb,
  start_date date,
  end_date date,
  first_seen_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (profile_id, amazon_id)
);

create table public.ad_groups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  amazon_id text not null,
  ad_product public.ad_product not null,
  name text,
  state public.entity_state not null,
  campaign_id text not null,
  default_bid numeric(12, 4),
  first_seen_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (profile_id, amazon_id)
);

create table public.product_ads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  amazon_id text not null,
  ad_product public.ad_product not null,
  name text,
  state public.entity_state not null,
  campaign_id text not null,
  ad_group_id text not null,
  asin text,
  sku text,
  first_seen_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (profile_id, amazon_id)
);

create table public.keywords (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  amazon_id text not null,
  ad_product public.ad_product not null,
  name text,
  state public.entity_state not null,
  campaign_id text not null,
  ad_group_id text not null,
  keyword_text text not null,
  match_type public.match_type not null,
  bid numeric(12, 4),
  first_seen_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (profile_id, amazon_id)
);

create table public.targets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  amazon_id text not null,
  ad_product public.ad_product not null,
  name text,
  state public.entity_state not null,
  campaign_id text not null,
  ad_group_id text not null,
  -- [{type, value}] per TargetExpression in packages/shared.
  expression jsonb not null default '[]'::jsonb,
  -- Amazon's own rendering, kept verbatim so the grid can show what they show.
  resolved_expression text,
  bid numeric(12, 4),
  first_seen_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (profile_id, amazon_id)
);

create table public.negatives (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  amazon_id text not null,
  ad_product public.ad_product not null,
  name text,
  state public.entity_state not null,
  campaign_id text not null,
  -- Null for a campaign-scoped negative, which is the point of `scope`.
  ad_group_id text,
  scope public.negative_scope not null,
  keyword_text text,
  expression jsonb,
  match_type public.match_type not null,
  first_seen_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (profile_id, amazon_id)
);

comment on table public.negatives is
  'Negative keywords and negative product targets, campaign- or ad-group-scoped.';

create index portfolios_org_profile_idx on public.portfolios (org_id, profile_id);
create index campaigns_org_profile_idx on public.campaigns (org_id, profile_id);
create index campaigns_state_idx on public.campaigns (profile_id, state) where deleted_at is null;
create index ad_groups_org_profile_idx on public.ad_groups (org_id, profile_id);
create index ad_groups_campaign_idx on public.ad_groups (profile_id, campaign_id);
create index product_ads_org_profile_idx on public.product_ads (org_id, profile_id);
create index product_ads_ad_group_idx on public.product_ads (profile_id, ad_group_id);
create index product_ads_asin_idx on public.product_ads (profile_id, asin);
create index keywords_org_profile_idx on public.keywords (org_id, profile_id);
create index keywords_ad_group_idx on public.keywords (profile_id, ad_group_id);
create index targets_org_profile_idx on public.targets (org_id, profile_id);
create index targets_ad_group_idx on public.targets (profile_id, ad_group_id);
create index negatives_org_profile_idx on public.negatives (org_id, profile_id);
create index negatives_campaign_idx on public.negatives (profile_id, campaign_id);

select app.install_tenant_rls('public.portfolios');
select app.install_tenant_rls('public.campaigns');
select app.install_tenant_rls('public.ad_groups');
select app.install_tenant_rls('public.product_ads');
select app.install_tenant_rls('public.keywords');
select app.install_tenant_rls('public.targets');
select app.install_tenant_rls('public.negatives');

-- ---------------------------------------------------------------------------
-- Diff audit
-- ---------------------------------------------------------------------------

create type public.entity_change_source as enum ('sync', 'apply');

create table public.entity_changes (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  entity_type public.entity_type not null,
  amazon_id text not null,
  entity_name text,
  field text not null,
  old_value jsonb,
  new_value jsonb,
  source public.entity_change_source not null,
  -- Set when the change came from one of our own staged applies (v1.x).
  apply_batch_id uuid,
  observed_at timestamptz not null default now()
);

comment on table public.entity_changes is
  'Snapshot-to-snapshot diff of the mirror. source=sync means somebody changed it outside wizard-ads.';

create index entity_changes_profile_time_idx
  on public.entity_changes (profile_id, observed_at desc);
create index entity_changes_entity_idx
  on public.entity_changes (profile_id, entity_type, amazon_id, observed_at desc);

select app.install_tenant_rls('public.entity_changes');
