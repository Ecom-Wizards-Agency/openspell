# WP-39 — Members UI, set-password page, members e2e

**Status:** open · **Owner:** Codex (gpt-5.6-sol) · **Branch:** `wp-39-members-ui`

## Why

WP-38 (merged) shipped the invitation schema, data modules, password login, and the
/invite/[token] acceptance flow. What's missing is the admin surface to actually create
and manage invitations and members, a self-service set-password page, and e2e coverage.
After this WP, Victor invites Joao and Danica from the UI.

## Build on (all merged, read first)

- `apps/web/src/data/invitations.ts` + `apps/web/src/data/members.ts` (complete data layer:
  create/list/revoke invitations, listMembers, updateMemberRole, removeMember with SQL
  last-owner protection, audit writes).
- `manageMembers` capability in `apps/web/src/auth/roles.ts` (owner/admin).
- Design doctrine: `docs/workpackages/WP-38-invitations-auth-design.md`,
  `docs/design/DESIGN-SYSTEM.md` (voice + one-primary-action rule: the page's primary is
  "Invite").
- Shown-once token UX pattern: `apps/web/app/connect-claude/manager.tsx`.
- Settings page pattern: `apps/web/app/settings/profiles/` (gate() in page,
  gateAction()+authorize in every action).

## Scope

1. **`/settings/members`** (`apps/web/app/settings/members/page.tsx` + `actions.ts` +
   client components as needed):
   - Members roster: email, role select, joined date; save role (updateMemberRole), remove
     (removeMember). Rules in actions: only owners assign/strip `owner`; acting on yourself
     is refused for remove; last-owner invariant already in SQL — surface its error nicely.
   - Pending invitations: email, role, `token_prefix…`, expires, invited-by, revoke.
   - Create invitation: email + role picker (viewer/analyst/admin — no owner) → shows the
     full invite URL (`WIZARD_ADS_APP_URL + /invite/<token>`) EXACTLY ONCE with copy
     affordance + "this link will not be shown again".
   - Non-admins reaching the URL see the read-only refusal pattern (`members-forbidden`
     testid, mirroring connections). `data-testid`s: `member-row`, `member-role`,
     `remove-member`, `invite-row`, `revoke-invite`, `create-invite`, `invite-url`.
2. **Settings tab bar**: add Members to the settings nav (`Connections · Profiles · Sync
   status` bar in `apps/web/app/settings/*` pages) and to the Admin nav group if the
   pattern fits (`apps/web/src/ui/nav-links.ts` — check how settings subpages are linked;
   follow the existing tab pattern, don't invent a new one).
3. **`/settings/account`**: self-service set/change password via
   `supabase.auth.updateUser({ password })` on the server client; gate() any role; min 10
   chars server-side (match WP-38's rule); calm confirmation; link from the settings tabs.
   This is how existing magic-link/Google users (Victor) acquire password login.
4. **e2e `apps/web/e2e/members.spec.ts`** (mirror `roles.spec.ts` style, serial):
   - guards.spec.ts: replace the WP-39 placeholder with `/settings/members` +
     `/settings/account`.
   - Viewer/analyst: refusal visible, no controls; bypass attempt refused.
   - Admin creates invitation → shown-once URL captured from DOM → appears in pending →
     revoke second one → revoked link renders "no longer open" page.
   - Existing-user acceptance: the e2e auth seam has no email — extend the seam minimally
     so the session carries an email (check `apps/web/src/auth/session.ts` e2e branch +
     `e2e/support/`), then: outsider fixture user opens link, accepts, lands on /dashboard
     with org cookie switched, roster shows them.
   - Expired invitation (seed directly via the e2e DB handle) renders expired copy.
   - Last-owner: sole owner cannot be removed/demoted (control absent AND action refuses).
   - New-user password signup path is OUT of e2e scope (no Supabase Auth in harness) —
     covered by WP-38 unit tests.

## Constraints

- Program rules in /AGENTS.md bind. No `packages/shared` edits, no schema changes (the
  table exists and is applied hosted).
- Roadmap/feedback items: never set `shipped`; keep `in_progress` pending Victor.
- Branch `wp-39-members-ui`; commits `feat(wp-39): ...`; no push, no merge.
- Verify: `pnpm typecheck && pnpm lint && pnpm test` green; run the e2e suites locally
  (they work without Postgres for the session-auth harness — check e2e/run.ts) and report
  exactly what ran.
- Final message: what shipped, screenshots-worthy states (list them), test results,
  operator steps remaining.
