-- wizard-ads 0019: experiments (A/B test tracking).
--
-- WP-19 HANDOFF TO WP-01. Additive: two tables, three enums, two triggers, one
-- guard. Nothing existing is altered, so WP-01 should review this file rather
-- than rewrite it.
--
-- An experiment is a deliberate test somebody chose to run — "push spend on
-- these keywords", "new main image on this ASIN", "raise the price" — recorded
-- as a first-class row so its window is visible on every chart and its outcome
-- is measurable in the facts later, instead of living in one person's memory.
--
-- Org-scoped like everything else. The write rules follow feedback's shape: an
-- org reads; an analyst or better creates and edits their own; an admin edits
-- anyone's. That last distinction ("who may write WHICH row, and beyond that
-- WHICH columns") is finer than `app.install_tenant_rls` can express, so the
-- policies decide who may touch a row and `app.experiment_guard_update` decides
-- what they may change — neither is sufficient alone.
--
-- SEAM (WP-12, not built here): when the staged-apply engine lands, it will gain
-- a nullable `experiment_id` on `apply_batches`, so a push IS the experiment's
-- start. That column is deliberately NOT added now — this migration only records
-- the intention so the later one is a one-line addition, not a surprise.

create type public.experiment_type as enum (
  'bid_push', 'creative', 'listing_content', 'price', 'placement', 'other'
);

comment on type public.experiment_type is
  'What kind of change the test is. bid_push/placement are ads levers; creative/listing_content/price are catalog levers whose ad-facts move only indirectly.';

create type public.experiment_metric as enum ('acos', 'cvr', 'ctr', 'sales', 'share');

comment on type public.experiment_metric is
  'The metric the experiment is trying to move. The comparison view leads with it.';

create type public.experiment_status as enum (
  'planned', 'running', 'ended', 'analyzed', 'aborted'
);

comment on type public.experiment_status is
  'planned -> running -> ended -> analyzed, or aborted from anywhere. end_at is null while running; the comparison view has no after-window until it is set.';

-- ---------------------------------------------------------------------------
-- experiments
-- ---------------------------------------------------------------------------

create table public.experiments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  name text not null,
  -- What we expect to happen, in the operator's own words. Kept, because a test
  -- whose hypothesis nobody wrote down is a change nobody can learn from.
  hypothesis text not null default '',
  type public.experiment_type not null,
  -- Entity refs the test touches: campaign / ad-group / target ids, ASINs,
  -- search terms. jsonb rather than a join table because a scope is read whole,
  -- written once, and never queried across experiments.
  scope jsonb not null default '{}'::jsonb,
  metric_focus public.experiment_metric not null,
  start_at timestamptz not null default now(),
  -- Null while the experiment is still running. Set when it ends.
  end_at timestamptz,
  status public.experiment_status not null default 'planned',
  result_note text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status_changed_at timestamptz not null default now(),
  constraint experiments_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint experiments_hypothesis_length check (char_length(hypothesis) <= 20000),
  constraint experiments_result_note_length check (result_note is null or char_length(result_note) <= 20000),
  -- A window that ends before it starts is a data-entry error, not a test.
  constraint experiments_window_order check (end_at is null or end_at >= start_at)
);

comment on table public.experiments is
  'Deliberate tests, tracked as first-class records so their windows shade every chart and their outcomes are measurable in the facts. Org-scoped.';

-- The unique key the events table points at, so an event cannot name an
-- experiment in another org.
alter table public.experiments add constraint experiments_id_org_key unique (id, org_id);

create index experiments_org_status_idx
  on public.experiments (org_id, status, start_at desc);
create index experiments_profile_window_idx
  on public.experiments (profile_id, start_at desc);
create index experiments_created_by_idx on public.experiments (created_by);

create trigger experiments_touch before update on public.experiments
  for each row execute function app.touch_updated_at();

-- `status_changed_at` follows the status, not the row: an edited hypothesis is
-- not a state change, so the roadmap-style "since when" stays honest.
create or replace function app.experiment_touch_status_changed()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;
  return new;
end;
$$;

create trigger experiments_status_changed before update on public.experiments
  for each row execute function app.experiment_touch_status_changed();

-- ---------------------------------------------------------------------------
-- Who may change what
-- ---------------------------------------------------------------------------

create or replace function app.experiment_guard_update()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  -- The worker, the migrations and the MCP server run as the service role and
  -- are trusted with the whole row.
  if app.is_service_role() then
    return new;
  end if;

  -- An admin may change anything about anyone's experiment.
  if app.has_org_role(new.org_id, array['owner', 'admin']) then
    return new;
  end if;

  -- Everyone else is the creator editing their own. The tenant, the profile and
  -- the provenance columns are not theirs to rewrite; the test's fields are.
  if new.org_id is distinct from old.org_id
     or new.profile_id is distinct from old.profile_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'only an owner or admin may move an experiment between profiles, tenants or authors'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function app.experiment_guard_update() is
  'Column-level authorization for experiments: RLS decides who may write a row, this decides what they may change.';

create trigger experiments_guard before update on public.experiments
  for each row execute function app.experiment_guard_update();

alter table public.experiments enable row level security;

-- Everyone in the org reads every experiment: a shared log nobody can read is a
-- private notebook.
create policy tenant_read on public.experiments for select to authenticated
  using (app.is_org_member(org_id));

-- An analyst or better files one, and files it as their own.
create policy experiments_insert_own on public.experiments for insert to authenticated
  with check (
    app.has_org_role(org_id, array['owner', 'admin', 'analyst'])
    and created_by = auth.uid()
  );

-- An admin edits anyone's; a creator edits their own. Two policies because a
-- single one would have to conflate the two rules.
create policy experiments_admin_update on public.experiments for update to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin']))
  with check (app.has_org_role(org_id, array['owner', 'admin']));

create policy experiments_creator_update on public.experiments for update to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin', 'analyst']) and created_by = auth.uid())
  with check (app.has_org_role(org_id, array['owner', 'admin', 'analyst']) and created_by = auth.uid());

create policy experiments_admin_delete on public.experiments for delete to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin']));

create policy experiments_creator_delete on public.experiments for delete to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin', 'analyst']) and created_by = auth.uid());

revoke all on public.experiments from anon;
grant select, insert, update, delete on public.experiments to authenticated;
grant all on public.experiments to service_role;

-- ---------------------------------------------------------------------------
-- experiment_events — the status-transition log
-- ---------------------------------------------------------------------------

create table public.experiment_events (
  id bigint generated always as identity primary key,
  experiment_id uuid not null,
  org_id uuid not null references public.orgs (id) on delete cascade,
  -- Null for the creation event: there is no status a planned row moved from.
  from_status public.experiment_status,
  to_status public.experiment_status not null,
  note text,
  actor_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint experiment_events_note_length check (note is null or char_length(note) <= 20000),
  -- The composite key makes an event in the wrong org unrepresentable rather
  -- than merely unlikely, and keeps the table inside the RLS suite's catalog
  -- walk (which only sees tables with an org_id).
  constraint experiment_events_experiment_fkey foreign key (experiment_id, org_id)
    references public.experiments (id, org_id) on delete cascade
);

comment on table public.experiment_events is
  'Append-only log of an experiment''s status transitions, so the detail page can show a timeline of who moved it when.';

create index experiment_events_experiment_idx
  on public.experiment_events (org_id, experiment_id, created_at);

alter table public.experiment_events enable row level security;

create policy tenant_read on public.experiment_events for select to authenticated
  using (app.is_org_member(org_id));

-- Analyst or better logs a transition (the same roles that may edit the
-- experiment). Append-only: no update, no delete for a member.
create policy experiment_events_insert on public.experiment_events for insert to authenticated
  with check (app.has_org_role(org_id, array['owner', 'admin', 'analyst']));

revoke all on public.experiment_events from anon;
grant select, insert on public.experiment_events to authenticated;
grant all on public.experiment_events to service_role;
