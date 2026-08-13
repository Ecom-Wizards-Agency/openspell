-- wizard-ads 0008: the write path's tables (schema now, unused in v1).
--
-- A port of the staged-apply ledger the Python flow already runs on
-- (amazon-agent/tools/amazon-ppc-management/batches.py). Its rules, kept
-- verbatim because they are what makes writing to a client account survivable:
--
--  * A batch is ONE opt group, never a whole account. Several levers may land
--    together inside a group's batch, each row labelled with its lever.
--  * The snapshot is written BEFORE the apply. It is the revert source and the
--    cooldown ledger, in that order of importance.
--  * A cooldown conflict blocks the batch unless a reason is recorded. The
--    reason is a string, not a boolean, because "why did we override the
--    cooldown" is the question anyone asks six weeks later.
--  * Caps are ceilings, never steps. `apply_rows` keeps clicks and revenue so
--    the rpc x target-ACOS check can run against the row it judges.
--
-- v1 writes none of this: the export bridge produces the rows JSON and the
-- Python flow applies it. The tables exist so the v1.x engine has somewhere to
-- land without a migration under a running system.

create type public.apply_entity_type as enum (
  'keyword', 'target', 'campaign', 'ad_group', 'placement'
);

comment on type public.apply_entity_type is
  'Includes placement, which is not an EntityType: a placement modifier is a field of a campaign, but batches.py addresses it as its own row type.';

create type public.apply_batch_status as enum ('staged', 'applied', 'reverted', 'abandoned');

create table public.apply_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  -- `<client>-<YYYY>W<ww>-<group>-<lever>` in the Python flow. Unique per org
  -- so a tag identifies a batch in conversation.
  tag text not null,
  opt_group text not null,
  lever text not null,
  note text not null,
  status public.apply_batch_status not null default 'staged',
  applied_on date,
  cooldown_days integer not null default 7,
  cooldown_bypass text,
  score jsonb,
  reverted_at timestamptz,
  revert_note text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, tag),
  constraint apply_batches_applied_needs_date
    check (status <> 'applied' or applied_on is not null)
);

create index apply_batches_profile_idx on public.apply_batches (profile_id, applied_on desc);

create trigger apply_batches_touch before update on public.apply_batches
  for each row execute function app.touch_updated_at();

select app.install_tenant_rls('public.apply_batches', array['owner', 'admin']);

create table public.apply_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.apply_batches (id) on delete cascade,
  org_id uuid not null references public.orgs (id) on delete cascade,
  entity_type public.apply_entity_type not null,
  entity_id text not null,
  entity_name text,
  field text not null,
  -- jsonb, not numeric: a staged field can be a bid, a budget or a state.
  old_value jsonb,
  new_value jsonb,
  lever text,
  -- Provenance the caps-are-ceilings validator reads.
  clicks bigint,
  revenue numeric(14, 4),
  created_at timestamptz not null default now()
);

create index apply_rows_batch_idx on public.apply_rows (batch_id);
create index apply_rows_entity_idx on public.apply_rows (org_id, entity_type, entity_id);

select app.install_tenant_rls('public.apply_rows', array['owner', 'admin']);

-- The cooldown query, ported from batches.py's cooldown_conflicts: which of
-- these candidate entities did an applied batch touch inside the cooldown.
create or replace function public.apply_cooldown_conflicts(
  p_profile_id uuid,
  p_entity_keys text[],
  p_cooldown_days integer default 7,
  p_today date default current_date
)
returns table (
  entity_key text,
  entity_name text,
  batch_tag text,
  applied_on date,
  days_ago integer,
  free_on date
)
language sql
stable
set search_path = pg_catalog, public, pg_temp
as $$
  select
    r.entity_type::text || ':' || r.entity_id as entity_key,
    r.entity_name,
    b.tag as batch_tag,
    b.applied_on,
    (p_today - b.applied_on)::integer as days_ago,
    (b.applied_on + p_cooldown_days)::date as free_on
  from public.apply_rows r
  join public.apply_batches b on b.id = r.batch_id
  where b.profile_id = p_profile_id
    and b.status = 'applied'
    and b.applied_on is not null
    and (p_today - b.applied_on) < p_cooldown_days
    and (r.entity_type::text || ':' || r.entity_id) = any (p_entity_keys)
  order by b.applied_on desc, entity_key;
$$;

comment on function public.apply_cooldown_conflicts(uuid, text[], integer, date) is
  'Port of batches.py cooldown_conflicts: applied batches inside the cooldown that touched these entities.';

grant execute on function public.apply_cooldown_conflicts(uuid, text[], integer, date)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Harvesting
-- ---------------------------------------------------------------------------

create table public.campaign_maps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  name text not null,
  enabled boolean not null default false,
  -- Which search terms qualify: a filter document, evaluated by the engine.
  source_filter jsonb not null default '{}'::jsonb,
  -- Where a harvested term lands. When the destination does not exist yet this
  -- template is enough to create it, which is the limitation of the incumbent
  -- tool this feature exists to beat.
  destination_template jsonb not null default '{}'::jsonb,
  match_types public.match_type[] not null default '{}',
  negate_source boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, name)
);

comment on column public.campaign_maps.destination_template is
  'Auto-create the destination campaign/ad group when it is missing, rather than skipping the harvest.';

create trigger campaign_maps_touch before update on public.campaign_maps
  for each row execute function app.touch_updated_at();

select app.install_tenant_rls('public.campaign_maps', array['owner', 'admin', 'analyst']);
