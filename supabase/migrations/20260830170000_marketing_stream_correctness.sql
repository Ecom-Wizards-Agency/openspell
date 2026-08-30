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
    num_nonnulls(
      binding_id, provider_subscription_id, provider_dataset_id,
      provider_event_id, provider_advertiser_id, provider_marketplace_id
    ) = 0 or (
      num_nonnulls(
        binding_id, provider_subscription_id, provider_dataset_id,
        provider_event_id, provider_advertiser_id, provider_marketplace_id
      ) = 6
      and nullif(btrim(coalesce(provider_subscription_id, '')), '') is not null
      and nullif(btrim(coalesce(provider_dataset_id, '')), '') is not null
      and nullif(btrim(coalesce(provider_event_id, '')), '') is not null
      and nullif(btrim(coalesce(provider_advertiser_id, '')), '') is not null
      and nullif(btrim(coalesce(provider_marketplace_id, '')), '') is not null
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

-- One durable profile-level block accumulates every scope whose projection
-- could not run because tenant dayparting policy was missing. Retry jobs are
-- bounded; the row remains alerted until policy returns and a later job
-- successfully replays and clears all accumulated scopes.
create table public.marketing_stream_projection_blocks (
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null,
  scope_keys text[] not null default '{}',
  first_blocked_at timestamptz not null,
  last_blocked_at timestamptz not null,
  retry_count integer not null default 0,
  alert_state text not null default 'pending',
  last_reason text not null,
  updated_at timestamptz not null default now(),
  primary key (org_id, profile_id),
  constraint marketing_stream_projection_blocks_profile_fkey
    foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint marketing_stream_projection_blocks_scopes_nonempty
    check (cardinality(scope_keys) > 0),
  constraint marketing_stream_projection_blocks_retry_nonnegative
    check (retry_count >= 0),
  constraint marketing_stream_projection_blocks_alert_state_check
    check (alert_state in ('pending', 'alerted')),
  constraint marketing_stream_projection_blocks_reason_nonempty
    check (btrim(last_reason) <> ''),
  constraint marketing_stream_projection_blocks_time_order
    check (last_blocked_at >= first_blocked_at)
);

create trigger marketing_stream_projection_blocks_touch
  before update on public.marketing_stream_projection_blocks
  for each row execute function app.touch_updated_at();

select app.install_tenant_rls('public.marketing_stream_projection_blocks');
