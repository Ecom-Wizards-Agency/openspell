-- Keepa market observations and competitor promotion transitions.

alter table public.keepa_bsr_observations
  add column buy_box_price numeric(14, 4),
  add column lightning_deal boolean,
  add column coupon jsonb;

-- Category participates in the observation identity. A nullable key would make
-- "unknown category" a special SQL case forever; preserve existing rows as the
-- explicit empty-category bucket before tightening it.
update public.keepa_bsr_observations set category = '' where category is null;
alter table public.keepa_bsr_observations
  alter column category set default '',
  alter column category set not null;

create table public.competitor_price_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  asin text not null,
  event_kind text not null check (
    event_kind in (
      'deal_start', 'deal_end', 'price_drop', 'price_restore',
      'coupon_start', 'coupon_end'
    )
  ),
  detected_at timestamptz not null,
  price numeric(14, 4),
  baseline_price numeric(14, 4),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (org_id, asin, event_kind, detected_at)
);

create index competitor_price_events_org_asin_time_idx
  on public.competitor_price_events (org_id, asin, detected_at desc);

select app.install_tenant_rls('public.competitor_price_events');
