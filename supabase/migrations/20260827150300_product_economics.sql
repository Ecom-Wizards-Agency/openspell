-- wizard-ads WP-44: My Real Profit per-ASIN product economics.
--
-- HOSTED-APPLY REQUIRED after merge. This migration is additive: one table,
-- indexes and standard tenant RLS. The implementation only applies it to the
-- throwaway database used by the migration tests; an operator applies it to a
-- hosted Supabase project through the normal reviewed migration procedure.

create table public.product_economics (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  asin text not null,
  captured_on date not null,
  sale_price numeric,
  cogs numeric,
  fba_fees numeric,
  referral_fees numeric,
  other_fees numeric,
  margin numeric,
  ltv_revenue numeric,
  ltv_orders numeric,
  repeat_rate numeric,
  currency char(3),
  source text not null default 'mrp',
  details jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  constraint product_economics_currency_check
    check (currency is null or currency ~ '^[A-Z]{3}$'),
  unique (profile_id, asin, captured_on)
);

comment on table public.product_economics is
  'Daily per-ASIN sale price, costs, fees, margin and LTV imported from product-economics providers.';

create index product_economics_org_profile_date_idx
  on public.product_economics (org_id, profile_id, captured_on desc);

select app.install_tenant_rls('public.product_economics');
