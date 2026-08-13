-- wizard-ads 0009: product surface.
--
-- Tags, saved dashboards, deep links, and the audit log.
--
-- Tags are nested because they are also how 211 profiles get grouped into
-- something a human can navigate: a client is a tag, its markets are children.
-- The hierarchy is a parent pointer plus a recursive `tag_subtree` function
-- rather than a materialised path, so renaming a parent is one UPDATE and not
-- a cascade nobody remembers to run.

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  parent_id uuid references public.tags (id) on delete cascade,
  name text not null,
  slug text not null,
  color text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tags_not_own_parent check (parent_id is null or parent_id <> id)
);

-- Siblings are unique; the same name under two parents is the point of nesting.
create unique index tags_sibling_slug_key
  on public.tags (org_id, parent_id, slug) nulls not distinct;
create index tags_parent_idx on public.tags (parent_id);

create trigger tags_touch before update on public.tags
  for each row execute function app.touch_updated_at();

select app.install_tenant_rls('public.tags', array['owner', 'admin', 'analyst']);

create or replace function public.tag_subtree(p_tag_id uuid)
returns table (id uuid, org_id uuid, parent_id uuid, name text, slug text, depth integer)
language sql
stable
set search_path = pg_catalog, public, pg_temp
as $$
  with recursive walk as (
    select t.id, t.org_id, t.parent_id, t.name, t.slug, 0 as depth
      from public.tags t
     where t.id = p_tag_id
    union all
    select c.id, c.org_id, c.parent_id, c.name, c.slug, w.depth + 1
      from public.tags c
      join walk w on c.parent_id = w.id
  )
  select * from walk;
$$;

comment on function public.tag_subtree(uuid) is
  'A tag and every tag under it. Tag-scoped views filter on this, so tagging a client covers its markets.';

grant execute on function public.tag_subtree(uuid) to authenticated, service_role;

create table public.entity_tags (
  tag_id uuid not null references public.tags (id) on delete cascade,
  org_id uuid not null references public.orgs (id) on delete cascade,
  -- A tag can address a profile itself (entity_type = null is not allowed, so
  -- profiles are tagged through their own row in ad_profiles by id).
  profile_id uuid references public.ad_profiles (id) on delete cascade,
  entity_type public.entity_type,
  entity_id text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint entity_tags_target
    check ((entity_type is null) = (entity_id is null))
);

create unique index entity_tags_key
  on public.entity_tags (tag_id, profile_id, entity_type, entity_id) nulls not distinct;
create index entity_tags_entity_idx
  on public.entity_tags (org_id, entity_type, entity_id);
create index entity_tags_profile_idx on public.entity_tags (profile_id);

select app.install_tenant_rls('public.entity_tags', array['owner', 'admin', 'analyst']);

-- ---------------------------------------------------------------------------
-- Saved dashboards
-- ---------------------------------------------------------------------------

create table public.dashboards (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null,
  layout jsonb not null default '{}'::jsonb,
  filters jsonb not null default '{}'::jsonb,
  -- Logo, palette, client-facing title. v1.x ships the sharing; the column is
  -- here so a shared dashboard is not a schema change later.
  white_label jsonb,
  share_token text unique,
  share_expires_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);

create trigger dashboards_touch before update on public.dashboards
  for each row execute function app.touch_updated_at();

select app.install_tenant_rls('public.dashboards', array['owner', 'admin', 'analyst']);

-- ---------------------------------------------------------------------------
-- Deep links
-- ---------------------------------------------------------------------------

create table public.goto_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  token text not null unique,
  route text not null,
  -- Filter and grid state, restored verbatim on resolve.
  state jsonb not null default '{}'::jsonb,
  label text,
  expires_at timestamptz,
  uses integer not null default 0,
  last_used_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.goto_links is
  'A token that resolves to a route plus filter state. Resolution happens server-side; an expired token is a 404, not a redirect.';

create index goto_links_org_idx on public.goto_links (org_id, created_at desc);

select app.install_tenant_rls('public.goto_links', array['owner', 'admin', 'analyst']);

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------

create type public.audit_actor_type as enum ('user', 'service', 'mcp', 'system');

create table public.audit_log (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  actor_type public.audit_actor_type not null,
  actor_id text,
  action text not null,
  target_type text,
  target_id text,
  payload jsonb not null default '{}'::jsonb,
  source text,
  created_at timestamptz not null default now()
);

comment on table public.audit_log is
  'Every MCP call and every write. The headless analyst''s "zero write calls" claim is checked here, not asserted.';

create index audit_log_org_time_idx on public.audit_log (org_id, created_at desc);
create index audit_log_action_idx on public.audit_log (org_id, action, created_at desc);

-- Reading the audit log is an admin act; writing it is the service role's job.
alter table public.audit_log enable row level security;
create policy tenant_read on public.audit_log for select to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin']));
revoke all on public.audit_log from anon;
grant select on public.audit_log to authenticated;
grant all on public.audit_log to service_role;
