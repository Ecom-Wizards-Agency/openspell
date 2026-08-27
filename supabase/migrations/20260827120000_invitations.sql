-- WP-38: invite-only organisation membership.
--
-- The plaintext token never reaches this table. The acceptance URL carries 32
-- random bytes as base64url; only its SHA-256 hex digest and a display prefix
-- are stored. Status is derived from the lifecycle timestamps rather than kept
-- in a second column that can disagree with them.

create table public.org_invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  email text not null check (email = lower(email)),
  role public.org_role not null default 'viewer' check (role <> 'owner'),
  token_prefix text not null,
  token_hash text not null unique check (char_length(token_hash) = 64),
  invited_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.org_invitations is
  'Email- and role-pinned organisation invitations. Plaintext tokens are shown once and never stored.';

create index org_invitations_org_time_idx
  on public.org_invitations (org_id, created_at desc);

create trigger org_invitations_touch before update on public.org_invitations
  for each row execute function app.touch_updated_at();

-- Unlike ordinary tenant tables, invitations are membership administration:
-- analysts and viewers cannot even list them. Public acceptance is performed
-- by the server-side service role after hashing the route token.
alter table public.org_invitations enable row level security;
create policy org_invitations_read on public.org_invitations for select to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin']));
create policy org_invitations_insert on public.org_invitations for insert to authenticated
  with check (app.has_org_role(org_id, array['owner', 'admin']));
create policy org_invitations_update on public.org_invitations for update to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin']))
  with check (app.has_org_role(org_id, array['owner', 'admin']));
create policy org_invitations_delete on public.org_invitations for delete to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin']));
revoke all on public.org_invitations from anon;
grant select, insert, update, delete on public.org_invitations to authenticated;
grant all on public.org_invitations to service_role;
