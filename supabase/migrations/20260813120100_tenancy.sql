-- wizard-ads 0002: tenancy.
--
-- orgs, membership, the Amazon connection, the profile roster and the tenant's
-- doctrine document. Every other table in the schema hangs off `orgs.id`.
--
-- Two things are deliberate here:
--
--  * `ads_connections` stores a Vault secret *id*, never a token. The refresh
--    token itself only ever moves through the two security-definer RPCs in
--    migration 0010.
--  * `profile_strategy.doc` is jsonb and this repo is public, so not one
--    threshold value can live in a migration. The document arrives from a
--    gitignored local file through the operator-run seeder.

-- ---------------------------------------------------------------------------
-- orgs
-- ---------------------------------------------------------------------------

create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.orgs is 'A tenant. v1 has one; the schema never assumes that.';

create trigger orgs_touch before update on public.orgs
  for each row execute function app.touch_updated_at();

create table public.org_members (
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.org_role not null default 'viewer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

comment on table public.org_members is 'Membership and role. The source of truth every RLS policy consults.';

create index org_members_user_idx on public.org_members (user_id);

create trigger org_members_touch before update on public.org_members
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Tenancy predicates
--
-- `security definer` is load-bearing rather than convenient: a policy on
-- org_members that reads org_members recurses forever. Reading membership
-- through a definer function that bypasses RLS breaks the cycle, which is why
-- these two functions live here and not in the platform migration.
-- ---------------------------------------------------------------------------

create or replace function app.is_org_member(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1
    from public.org_members m
    where m.org_id = p_org_id
      and m.user_id = auth.uid()
  );
$$;

comment on function app.is_org_member(uuid) is
  'Is the current JWT subject a member of this org. security definer to avoid recursive RLS on org_members.';

create or replace function app.has_org_role(p_org_id uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1
    from public.org_members m
    where m.org_id = p_org_id
      and m.user_id = auth.uid()
      and m.role::text = any (p_roles)
  );
$$;

comment on function app.has_org_role(uuid, text[]) is
  'Does the current JWT subject hold one of these roles in this org.';

grant execute on function app.is_org_member(uuid) to authenticated, service_role;
grant execute on function app.has_org_role(uuid, text[]) to authenticated, service_role;

-- orgs and org_members carry their own policies: `orgs` has no `org_id`
-- column, and membership writes are owner/admin business.
alter table public.orgs enable row level security;
create policy orgs_read on public.orgs for select to authenticated
  using (app.is_org_member(id));
create policy orgs_update on public.orgs for update to authenticated
  using (app.has_org_role(id, array['owner', 'admin']))
  with check (app.has_org_role(id, array['owner', 'admin']));
revoke all on public.orgs from anon;
grant select, update on public.orgs to authenticated;
grant all on public.orgs to service_role;

alter table public.org_members enable row level security;
create policy org_members_read on public.org_members for select to authenticated
  using (app.is_org_member(org_id));
create policy org_members_insert on public.org_members for insert to authenticated
  with check (app.has_org_role(org_id, array['owner', 'admin']));
create policy org_members_update on public.org_members for update to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin']))
  with check (app.has_org_role(org_id, array['owner', 'admin']));
create policy org_members_delete on public.org_members for delete to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin']));
revoke all on public.org_members from anon;
grant select, insert, update, delete on public.org_members to authenticated;
grant all on public.org_members to service_role;

-- ---------------------------------------------------------------------------
-- Amazon connection
-- ---------------------------------------------------------------------------

create type public.connection_status as enum ('pending', 'active', 'error', 'revoked');

create table public.ads_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  label text not null,
  -- The LWA application's client id is not a secret; the refresh token is, and
  -- it is not here. This column points at a row in Supabase Vault.
  lwa_client_id text,
  vault_secret_id uuid,
  status public.connection_status not null default 'pending',
  scope text,
  connected_by uuid references auth.users (id) on delete set null,
  connected_at timestamptz,
  last_health_check_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, label)
);

comment on table public.ads_connections is
  'One Amazon Ads authorization. The refresh token lives in Supabase Vault; this row holds only its id.';
comment on column public.ads_connections.vault_secret_id is
  'vault.secrets.id. Written and read only by store_ads_refresh_token / get_ads_refresh_token.';

create trigger ads_connections_touch before update on public.ads_connections
  for each row execute function app.touch_updated_at();

select app.install_tenant_rls('public.ads_connections', array['owner', 'admin']);

-- ---------------------------------------------------------------------------
-- Profile roster
-- ---------------------------------------------------------------------------

create type public.ads_region as enum ('NA', 'EU', 'FE');
create type public.profile_account_type as enum ('seller', 'vendor', 'agency');

create table public.ad_profiles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  connection_id uuid references public.ads_connections (id) on delete set null,
  -- Amazon's profileId. Numeric today, a string here, because every Amazon id
  -- in this schema is a string and a mixed convention is how joins rot.
  amazon_profile_id text not null,
  region public.ads_region not null,
  country_code text not null,
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  timezone text not null,
  account_type public.profile_account_type,
  account_name text,
  amazon_account_id text,
  -- The cost gate. 211 profiles synced daily is a bill; sync_enabled is how the
  -- ramp stays deliberate.
  sync_enabled boolean not null default false,
  target_acos numeric(6, 4),
  goal_lens text,
  monthly_budget numeric(14, 2),
  first_seen_at timestamptz not null default now(),
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, amazon_profile_id)
);

comment on table public.ad_profiles is
  'The advertiser roster. sync_enabled gates cost; target_acos and goal_lens are per-profile doctrine inputs.';

create index ad_profiles_org_sync_idx on public.ad_profiles (org_id, sync_enabled) where sync_enabled;
create index ad_profiles_region_idx on public.ad_profiles (region);

create trigger ad_profiles_touch before update on public.ad_profiles
  for each row execute function app.touch_updated_at();

-- Analysts may retune a profile's targets; only admins add or remove profiles
-- (and in practice the sync worker does, as the service role).
alter table public.ad_profiles enable row level security;
create policy tenant_read on public.ad_profiles for select to authenticated
  using (app.is_org_member(org_id));
create policy tenant_update on public.ad_profiles for update to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin', 'analyst']))
  with check (app.has_org_role(org_id, array['owner', 'admin', 'analyst']));
create policy tenant_insert on public.ad_profiles for insert to authenticated
  with check (app.has_org_role(org_id, array['owner', 'admin']));
create policy tenant_delete on public.ad_profiles for delete to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin']));
revoke all on public.ad_profiles from anon;
grant select, insert, update, delete on public.ad_profiles to authenticated;
grant all on public.ad_profiles to service_role;

-- ---------------------------------------------------------------------------
-- Doctrine
-- ---------------------------------------------------------------------------

create table public.profile_strategy (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  -- Null means "the org default". A profile row overrides it wholesale.
  profile_id uuid references public.ad_profiles (id) on delete cascade,
  schema_version text not null,
  doc jsonb not null,
  refreshed_at date,
  source text,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profile_strategy is
  'Per-tenant doctrine as jsonb (shape: TenantStrategy in packages/shared). Seeded from a gitignored local file; never from a migration.';

-- `nulls not distinct` is what makes "one default row per org" a constraint
-- rather than a hope.
create unique index profile_strategy_scope_key
  on public.profile_strategy (org_id, profile_id) nulls not distinct;

create trigger profile_strategy_touch before update on public.profile_strategy
  for each row execute function app.touch_updated_at();

select app.install_tenant_rls('public.profile_strategy', array['owner', 'admin']);
