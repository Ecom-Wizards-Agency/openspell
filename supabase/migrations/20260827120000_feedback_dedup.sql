-- wizard-ads WP-35: deterministic and out-of-band duplicate detection seams.
--
-- The web request only offers deterministic title matches. A separate service-role
-- job owns semantic evaluation: rows with dedup_checked_at is null are pending, and
-- every evaluated row gets that timestamp whether or not a duplicate was found.

alter table public.feedback_items
  add column duplicate_of uuid references public.feedback_items (id) on delete set null,
  add column dedup_checked_at timestamptz,
  add constraint feedback_items_duplicate_not_self check (duplicate_of is distinct from id),
  add constraint feedback_items_duplicate_is_declined
    check (duplicate_of is null or status = 'declined');

comment on column public.feedback_items.duplicate_of is
  'Canonical feedback item when this row is a duplicate. Setting it also requires status declined and an explanatory admin note.';
comment on column public.feedback_items.dedup_checked_at is
  'Null until the out-of-band duplicate checker has evaluated this item; set for both matches and non-matches.';

create index feedback_items_duplicate_of_idx
  on public.feedback_items (duplicate_of)
  where duplicate_of is not null;

-- The simple self-reference provides on-delete behaviour. This trigger adds the
-- tenant invariant a one-column foreign key cannot express.
create or replace function app.feedback_duplicate_same_org()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.duplicate_of is null then
    return new;
  end if;

  if not exists (
    select 1
      from public.feedback_items target
     where target.id = new.duplicate_of
       and target.org_id = new.org_id
  ) then
    raise exception 'duplicate target must be a feedback item in the same organisation'
      using errcode = '23503';
  end if;

  return new;
end;
$$;

create trigger feedback_items_duplicate_same_org
  before insert or update of duplicate_of, org_id on public.feedback_items
  for each row execute function app.feedback_duplicate_same_org();

-- The new columns are operational/admin fields. Replacing the guard closes the
-- direct PostgREST path as well as the application's narrower query helpers.
create or replace function app.feedback_guard_update()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if app.is_service_role() then
    return new;
  end if;

  if app.has_org_role(new.org_id, array['owner', 'admin']) then
    return new;
  end if;

  if old.status <> 'new' then
    raise exception 'a feedback item can only be edited by its author while it is new'
      using errcode = '42501';
  end if;

  if new.status is distinct from old.status
     or new.admin_note is distinct from old.admin_note
     or new.duplicate_of is distinct from old.duplicate_of
     or new.dedup_checked_at is distinct from old.dedup_checked_at
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

