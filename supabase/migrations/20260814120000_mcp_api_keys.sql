-- wizard-ads 0015: MCP API keys.
--
-- WP-09 HANDOFF TO WP-01. This file is additive and touches nothing WP-01 owns;
-- it lives here because `apps/mcp` cannot authenticate without a key store and
-- the migration directory is the only place a table can be created for real.
-- WP-01 should review it, not rewrite it.
--
-- Two deliberate departures from the tenant-table pattern, both structural:
--
--  1. The table lives in its own `mcp` schema, not in `public`. PostgREST
--     exposes `public` and nothing else, so a credential table in `public` is
--     one forgotten grant away from being readable over the REST API. Nothing
--     but the MCP server (service role) ever touches these rows, and the RLS
--     suite's "every tenant table needs a member-visible fixture row" invariant
--     correctly does not apply to a credential store.
--  2. The token is stored as a SHA-256 hash, never as plaintext, and the server
--     looks a key up BY that hash. The token is high-entropy (32 random bytes),
--     so a slow password KDF buys nothing here and would cost a table scan.
--
-- Scoping is the thing AdLabs does not have and the recon named as the first
-- thing to beat (`tools/recon/09-settings-and-admin.md` §5): a key is read-only
-- in v1, may be limited to a subset of the org's profiles, may expire, and can
-- be revoked. Every call it makes lands in `public.audit_log` with its id.

create schema if not exists mcp;

comment on schema mcp is
  'MCP server internals: API keys. Not exposed over PostgREST, never readable by an end user role.';

grant usage on schema mcp to service_role;

-- Read-only is the only scope v1 issues. The enum exists so v1.x can add a
-- write scope without a column rewrite, and so a scope is a value the database
-- checks rather than a convention the server remembers.
create type mcp.key_scope as enum ('read', 'write');

create table mcp.api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  label text not null,
  -- The first characters of the token, so an operator can identify a key in a
  -- list without the plaintext existing anywhere.
  key_prefix text not null,
  token_hash text not null unique,
  scope mcp.key_scope not null default 'read',
  -- Null means every profile in the org. A non-null array is a hard allowlist,
  -- enforced in the tool layer as well as here.
  profile_ids uuid[],
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint api_keys_prefix_len check (char_length(key_prefix) between 4 and 16),
  constraint api_keys_hash_len check (char_length(token_hash) = 64)
);

comment on table mcp.api_keys is
  'Per-org MCP credentials. Hashed, scoped, revocable, expirable. Read-only in v1; every call using one is written to public.audit_log.';

create index api_keys_org_idx on mcp.api_keys (org_id, created_at desc);

-- Belt and braces: RLS on, no policy, no grant to anon or authenticated. Only
-- the service role and a direct superuser connection can see a row at all.
alter table mcp.api_keys enable row level security;
revoke all on mcp.api_keys from anon, authenticated;
grant select, insert, update on mcp.api_keys to service_role;
