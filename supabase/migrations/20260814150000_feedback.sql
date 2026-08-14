-- wizard-ads 0017: product feedback and the roadmap.
--
-- WP-15 HANDOFF TO WP-01. Additive: two tables, three enums, one guard trigger.
-- Nothing existing is altered, so WP-01 should review this file rather than
-- rewrite it.
--
-- Feedback is org-scoped like everything else, which is the whole of what
-- "SaaS-ready" means here: internally the org is the team, and no code path
-- reads an item without naming an org.
--
-- Two things are deliberate:
--
--  * The write rules are finer than `app.install_tenant_rls` can express. Three
--    parties may change a row for three different reasons — an admin triages
--    it, its author corrects it while it is still untriaged, and the service
--    role does whatever migrations and the MCP server need — and "who may write
--    WHICH COLUMNS" is not something an RLS policy can say. So the policies
--    decide who may touch a row and `app.feedback_guard_update` decides what
--    they may change; neither is sufficient alone.
--  * A vote carries its own `org_id`, and the composite foreign key
--    `(item_id, org_id)` makes a vote in the wrong org unrepresentable rather
--    than merely unlikely. It also keeps the table inside the RLS suite's
--    catalog walk, which only sees tables with an `org_id`.

create type public.feedback_type as enum ('bug', 'feature');

create type public.feedback_severity as enum ('low', 'medium', 'high', 'critical');

create type public.feedback_status as enum (
  'new', 'triaged', 'planned', 'in_progress', 'shipped', 'declined'
);

comment on type public.feedback_status is
  'new -> triaged -> planned -> in_progress -> shipped, or declined. The roadmap board is the last three of those, plus declined under "not planned".';

create table public.feedback_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  -- Null when the author's account is gone, or when the MCP server filed it:
  -- an item with no human behind it is still an item worth keeping.
  author_id uuid references auth.users (id) on delete set null,
  type public.feedback_type not null,
  title text not null,
  body text not null default '',
  severity public.feedback_severity,
  status public.feedback_status not null default 'new',
  admin_note text,
  -- Route, profile, app version, actor type. Captured at submit time so a bug
  -- report says where it happened without anyone having to remember to ask.
  page_context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status_changed_at timestamptz not null default now(),
  constraint feedback_items_title_length check (char_length(btrim(title)) between 1 and 200),
  constraint feedback_items_body_length check (char_length(body) <= 20000),
  -- Severity is a bug's field. A "critical" feature request is a negotiation,
  -- not a datum.
  constraint feedback_items_severity_is_bugs_only check (severity is null or type = 'bug')
);

comment on table public.feedback_items is
  'Bug reports and feature requests, from the web widget or the MCP submit_feedback tool. Org-scoped; voted on in feedback_votes.';

-- The unique key the votes table points at, so a vote cannot name an item in
-- another org.
alter table public.feedback_items add constraint feedback_items_id_org_key unique (id, org_id);

create index feedback_items_org_status_idx
  on public.feedback_items (org_id, status, created_at desc);
create index feedback_items_org_type_idx
  on public.feedback_items (org_id, type, created_at desc);
create index feedback_items_author_idx on public.feedback_items (author_id);

create trigger feedback_items_touch before update on public.feedback_items
  for each row execute function app.touch_updated_at();

-- `status_changed_at` is the roadmap's "since when", so it has to follow the
-- status rather than the row: an edited title is not a state change.
create or replace function app.feedback_touch_status_changed()
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

create trigger feedback_items_status_changed before update on public.feedback_items
  for each row execute function app.feedback_touch_status_changed();

-- ---------------------------------------------------------------------------
-- Who may change what
-- ---------------------------------------------------------------------------

create or replace function app.feedback_guard_update()
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

  -- Triage is an owner/admin act, and it is the only path that may move a
  -- status or write a note.
  if app.has_org_role(new.org_id, array['owner', 'admin']) then
    return new;
  end if;

  -- Everyone else is the author correcting their own submission, and only
  -- while nobody has acted on it yet.
  if old.status <> 'new' then
    raise exception 'a feedback item can only be edited by its author while it is new'
      using errcode = '42501';
  end if;

  if new.status is distinct from old.status
     or new.admin_note is distinct from old.admin_note
     or new.org_id is distinct from old.org_id
     or new.author_id is distinct from old.author_id
     or new.type is distinct from old.type
     or new.page_context is distinct from old.page_context
     or new.created_at is distinct from old.created_at then
    raise exception 'only an owner or admin may change a feedback item beyond its title, body and severity'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function app.feedback_guard_update() is
  'Column-level authorization for feedback_items: RLS decides who may write a row, this decides what they may change.';

create trigger feedback_items_guard before update on public.feedback_items
  for each row execute function app.feedback_guard_update();

alter table public.feedback_items enable row level security;

-- Everyone in the org reads everything: a tracker nobody can read is a mailbox.
create policy tenant_read on public.feedback_items for select to authenticated
  using (app.is_org_member(org_id));

-- A member files their own items, and files them as new.
create policy feedback_insert_own on public.feedback_items for insert to authenticated
  with check (
    app.is_org_member(org_id)
    and author_id = auth.uid()
    and status = 'new'
    and admin_note is null
  );

create policy feedback_admin_update on public.feedback_items for update to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin']))
  with check (app.has_org_role(org_id, array['owner', 'admin']));

create policy feedback_author_update on public.feedback_items for update to authenticated
  using (app.is_org_member(org_id) and author_id = auth.uid() and status = 'new')
  with check (app.is_org_member(org_id) and author_id = auth.uid() and status = 'new');

create policy feedback_admin_delete on public.feedback_items for delete to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin']));

revoke all on public.feedback_items from anon;
grant select, insert, update, delete on public.feedback_items to authenticated;
grant all on public.feedback_items to service_role;

-- ---------------------------------------------------------------------------
-- Votes
-- ---------------------------------------------------------------------------

create table public.feedback_votes (
  item_id uuid not null,
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  -- One vote per person per item, as a constraint rather than as a convention
  -- the UI happens to respect.
  primary key (item_id, user_id),
  constraint feedback_votes_item_fkey foreign key (item_id, org_id)
    references public.feedback_items (id, org_id) on delete cascade
);

comment on table public.feedback_votes is
  'One row per person per item. The roadmap orders on count(*) of this table; the primary key is what makes a double vote impossible.';

create index feedback_votes_org_item_idx on public.feedback_votes (org_id, item_id);
create index feedback_votes_user_idx on public.feedback_votes (user_id);

alter table public.feedback_votes enable row level security;

create policy tenant_read on public.feedback_votes for select to authenticated
  using (app.is_org_member(org_id));

-- A vote is cast and withdrawn by the person casting it, and by nobody else:
-- viewer and analyst included, admin excluded.
create policy feedback_votes_insert_own on public.feedback_votes for insert to authenticated
  with check (app.is_org_member(org_id) and user_id = auth.uid());

create policy feedback_votes_delete_own on public.feedback_votes for delete to authenticated
  using (app.is_org_member(org_id) and user_id = auth.uid());

revoke all on public.feedback_votes from anon;
grant select, insert, delete on public.feedback_votes to authenticated;
grant all on public.feedback_votes to service_role;
