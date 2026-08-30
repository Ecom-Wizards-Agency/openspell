-- WP-147: authoritative Marketing Stream subscription routing and provider identity.
--
-- This migration is additive. Existing internal-envelope ledger rows remain
-- valid with null provider columns; provider-native rows must carry the whole
-- immutable identity selected by an active binding.

create table public.marketing_stream_subscription_bindings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null,
  subscription_id text not null,
  provider_dataset_id text not null,
  advertiser_id text not null,
  marketplace_id text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketing_stream_bindings_profile_fkey
    foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint marketing_stream_bindings_tenant_identity_key
    unique (org_id, profile_id, id),
  constraint marketing_stream_bindings_full_identity_key unique (
    org_id, profile_id, id, subscription_id, provider_dataset_id,
    advertiser_id, marketplace_id
  ),
  constraint marketing_stream_bindings_subscription_key
    unique (subscription_id),
  constraint marketing_stream_bindings_subscription_nonempty
    check (btrim(subscription_id) <> ''),
  constraint marketing_stream_bindings_advertiser_nonempty
    check (btrim(advertiser_id) <> ''),
  constraint marketing_stream_bindings_marketplace_nonempty
    check (btrim(marketplace_id) <> ''),
  constraint marketing_stream_bindings_dataset_check check (
    provider_dataset_id in (
      'sp-traffic', 'sp-conversion',
      'sb-traffic', 'sb-conversion',
      'sd-traffic', 'sd-conversion',
      'budget-usage'
    )
  )
);

create unique index marketing_stream_bindings_active_provider_identity_key
  on public.marketing_stream_subscription_bindings
    (advertiser_id, marketplace_id, provider_dataset_id)
  where active;

create unique index marketing_stream_bindings_active_profile_dataset_key
  on public.marketing_stream_subscription_bindings (profile_id, provider_dataset_id)
  where active;

create trigger marketing_stream_subscription_bindings_touch
  before update on public.marketing_stream_subscription_bindings
  for each row execute function app.touch_updated_at();

select app.install_tenant_rls('public.marketing_stream_subscription_bindings');

alter table public.marketing_stream_events
  add column binding_id uuid,
  add column provider_subscription_id text,
  add column provider_dataset_id text,
  add column provider_event_id text,
  add column provider_advertiser_id text,
  add column provider_marketplace_id text,
  add constraint marketing_stream_events_binding_fkey
    foreign key (
      org_id, profile_id, binding_id, provider_subscription_id,
      provider_dataset_id, provider_advertiser_id, provider_marketplace_id
    ) references public.marketing_stream_subscription_bindings (
      org_id, profile_id, id, subscription_id,
      provider_dataset_id, advertiser_id, marketplace_id
    )
    on delete restrict,
  add constraint marketing_stream_events_provider_identity_complete check (
    (
      binding_id is null
      and provider_subscription_id is null
      and provider_dataset_id is null
      and provider_event_id is null
      and provider_advertiser_id is null
      and provider_marketplace_id is null
    ) or (
      binding_id is not null
      and btrim(provider_subscription_id) <> ''
      and provider_dataset_id is not null
      and btrim(provider_event_id) <> ''
      and btrim(provider_advertiser_id) <> ''
      and btrim(provider_marketplace_id) <> ''
    )
  ),
  add constraint marketing_stream_events_provider_dataset_check check (
    provider_dataset_id is null or provider_dataset_id in (
      'sp-traffic', 'sp-conversion',
      'sb-traffic', 'sb-conversion',
      'sd-traffic', 'sd-conversion',
      'budget-usage'
    )
  );

create unique index marketing_stream_events_provider_identity_key
  on public.marketing_stream_events
    (binding_id, provider_dataset_id, provider_event_id)
  where binding_id is not null;
