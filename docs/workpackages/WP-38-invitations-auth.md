# WP-38 — Teams: invitations schema, password login, acceptance flow

**Status:** open · **Owner:** Codex (gpt-5.6-sol) · **Branch:** `wp-38-invitations-auth`

## Why

Victor needs to invite Joao and Danica into his org (they inherit the org's Amazon
connection — already org-scoped + Vault-held, zero extra work). Nothing exists today: no
invitations table, no members UI, no password login. This WP is the schema + auth + accept
flow; WP-39 (separate, later) is the members UI + e2e. Invite-only: public signup stays
off.

## Design decisions (already made — implement, don't relitigate)

- Copyable invite link, no email sending. Invitation row = source of truth; token shown
  exactly once at creation (the `apps/web/app/connect-claude/manager.tsx` UX).
- DB-backed random token: 32 random bytes → base64url in URL; SHA-256 hex at rest;
  `token_prefix` for display. Copy the pattern from `apps/web/src/data/mcp-keys.ts`.
- New capability `manageMembers` (owner/admin) — do NOT reuse `manageConnection`.
- The ONE legitimate signup path is `auth.admin.createUser` from the acceptance action.
  `shouldCreateUser: false` in `apps/web/app/login/actions.ts` and `enable_signup = false`
  in `supabase/config.toml` STAY as they are.
- Email-pinned: existing signed-in user may accept only if session email matches
  (case-insensitive); new-user form shows the pinned email read-only. Role pinned;
  `role <> 'owner'` check constraint.

## Scope

1. **Migration `supabase/migrations/<timestamp>_invitations.sql`** — `public.org_invitations`:
   id uuid pk; org_id FK cascade; email text not null + `check (email = lower(email))`;
   role public.org_role not null default 'viewer' + `check (role <> 'owner')`;
   token_prefix text not null; token_hash text not null unique +
   `check (char_length(token_hash) = 64)`; invited_by FK auth.users set null;
   expires_at timestamptz not null; accepted_at / accepted_by / revoked_at (status derived
   from nullable timestamps — no enum); created_at/updated_at + `app.touch_updated_at`;
   index `(org_id, created_at desc)`. RLS bespoke admin-only (mirror `audit_log`'s shape):
   all four verbs for `authenticated` gated on
   `app.has_org_role(org_id, array['owner','admin'])`; revoke from anon; grant all to
   service_role.
2. **Test fixtures (CI fails without these)**: add one `org_invitations` row per org in
   `app.seed_tenant_fixture` (`supabase/tests/tenant-fixture.sql`); add
   `'org_invitations'` to the `adminOnly` set in `packages/db/src/rls.test.ts` + a test
   (analyst cannot read; owner sees own org's only).
3. **Capability**: `manageMembers` in `apps/web/src/auth/roles.ts` → owner/admin; update
   `roles.test.ts` with `rolesWith('manageMembers')` agreement vs the `org_members`
   policies' role array.
4. **Service-role auth client** `apps/web/src/auth/admin.ts`: `supabaseAdminClient()`
   (`SUPABASE_SERVICE_ROLE_KEY`, persistSession:false) + `supabaseAdminConfigured()`. Add
   the key to `apps/web/env.TEMPLATE` marked server-only, with its single purpose stated.
5. **Data modules**:
   - `apps/web/src/data/invitations.ts` (structure of `mcp-keys.ts`): `newInviteToken`/
     `hashInviteToken`; `createInvitation` (lowercases; refuses existing member or live
     pending invite for the email; expires now()+7d); `listPendingInvitations`;
     `revokeInvitation`; `findInvitationByTokenHash` (unscoped — visitor is anonymous;
     returns derived status pending|expired|revoked|accepted); `claimInvitation` (atomic
     single-use: `update ... where accepted_at is null and revoked_at is null and
     expires_at > now() returning *`); `unclaimInvitation` (compensation).
   - `apps/web/src/data/members.ts`: `listMembers` (join auth.users for email);
     `updateMemberRole` / `removeMember` (last-owner invariant enforced in SQL, changed
     counts returned); `addMember` (on conflict do nothing). All mutations write
     `audit_log` rows (`invitation.created/.revoked/.accepted`, `member.role_changed`,
     `member.removed`).
   - Web tier is service-role: every org-scoped query carries org_id explicitly.
6. **Password login**: server action `signInWithPassword` in
   `apps/web/app/login/actions.ts` (non-oracle error copy, same discipline as
   `sendMagicLink`); password field + submit on `apps/web/app/login/page.tsx` matching the
   page's existing style; copy updated (passwords exist for invited accounts; still no
   public signup).
7. **Acceptance route** `apps/web/app/invite/[token]/page.tsx` + `actions.ts` (public —
   NOT in the guards list): hash token → status outcomes rendered as calm one-liners
   (invalid / expired / no-longer-open); signed-in + email match → "Join {org} as {role}"
   accept button; signed-in + mismatch → "issued to a different address" + sign-out link;
   anonymous → create-account form (pinned email read-only, password ≥10 chars
   server-enforced) with "already have an account? sign in first" →
   `/login?next=/invite/<token>`. Actions do NOT use `gateAction` (pre-membership);
   org_id always from the invitation row: `acceptAsExistingUser` (re-verify → claim →
   addMember → audit → set ORG_COOKIE → redirect /dashboard); `acceptAsNewUser` (claim
   FIRST to win the race → `admin.createUser({email, password, email_confirm:true})` →
   addMember → audit → anon-client `signInWithPassword` (server action = writable cookie
   store) → ORG_COOKIE → redirect; on createUser failure: unclaim + non-oracle copy, one
   nameable case "account already exists — sign in, then reopen this link").

## Tests

- Unit: token round-trip/hash length/status derivation/claim-once (+unclaim) in a
  colocated test; roles.test.ts additions; rls.test.ts + fixture (step 2);
  `packages/db/src/migrations.test.ts` picks up the migration — run it.
- e2e comes in WP-39; do not write members.spec.ts here.

## Constraints

- Program rules in /AGENTS.md bind. No `packages/shared` edits.
- Roadmap/feedback items: never set `shipped`; keep `in_progress` pending Victor.
- Branch `wp-38-invitations-auth`; commits `feat(wp-38): ...`; no push, no merge.
- Verify: `pnpm typecheck && pnpm lint && pnpm test` green (DB suites need local PG; if
  unavailable, say so explicitly).
- Final message: schema decisions taken, the acceptance-flow edge cases covered, test
  results, operator steps remaining (dashboard config, hosted migration, service key).
