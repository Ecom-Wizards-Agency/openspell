# WP-34 — Quick-fix batch (switcher filter, profile persistence, feedback context)

**Status:** open · **Owner:** Codex (gpt-5.6-sol) · **Branch:** `wp-34-quickfix-batch`

## Why

Live-verified 2026-08-27: the top-right profile switcher lists every profile in the org
(~100) instead of the actively-syncing ones, and profile selection is lost on any
param-less navigation (the brand/logo link is a bare `/`; there is no server-side cookie
fallback). Plus four small known bugs. One PR, seven fixes.

## Fixes

1. **Switcher shows syncing profiles by default.**
   Data path: `apps/web/src/ui/nav.tsx` → `apps/web/src/ui/nav-context.ts` →
   `apps/web/app/_lib/profiles.ts::listProfiles`. `listProfiles` already returns
   `syncEnabled`; `nav-context.ts` (~line 40) drops it. Carry it into the `NavProfile` type
   (`apps/web/src/ui/topbar-controls.tsx`), default the dropdown list to
   `syncEnabled === true`, and add a "Show all profiles (N)" toggle row that reveals the
   rest dimmed with a `· sync off` hint (copy the treatment from the dead
   `packages/ui/src/ProfileSwitcher.tsx`, then DELETE that dead file and its export from
   `packages/ui/src/index.ts` — it is imported by nothing; confirm before deleting).
   Do NOT filter inside `listProfiles` itself — `/dashboard`, `/grid`, `/optimizer`,
   `/crosscheck` and `selectProfile()` depend on the full roster.
2. **Experiments profile options filter**: `apps/web/src/experiments/data.ts::
   listProfileOptions` (~line 19) — add the `sync_enabled` predicate (partial index
   `ad_profiles_org_sync_idx` exists).
3. **Brand/logo link keeps `?profile=`**: the `wa-brand` anchor in the shell/nav renders
   `href="/"`. Small client component (pattern: `apps/web/src/ui/feedback-entry.tsx`) that
   appends the current `?profile=` on mount.
4. **Server-side PROFILE_COOKIE fallback**: when a page gets no `?profile=` search param,
   fall back to the cookie (`apps/web/src/cookies.ts`; the switcher already writes it —
   `topbar-controls.tsx` ~line 78) validated against the roster, in the
   `selectProfile()` call sites (`apps/web/app/_lib/profiles.ts` consumers). Result: brand
   link, bookmarks, and direct visits keep the selected profile.
5. **Feedback profileId capture**: `apps/web/src/ui/feedback-entry.tsx` forwards only
   `from`; `page_context.profileId` is always null. Parse the `profile` param out of the
   captured route in `/feedback/new` (`apps/web/app/feedback/new/page.tsx` +
   `apps/web/src/feedback/page-context.ts`) so submitted items carry the profile.
6. **Declare `jsdom`** in `apps/web/package.json` devDependencies (currently resolves via
   hoisting only).
7. **Hide the feedback entry on `/login`** (it renders on every route via
   `apps/web/app/layout.tsx` ~line 49): render only when a session exists.

## Tests

- Extend `apps/web/src/feedback/page-context.test.ts` for the profileId path.
- Unit coverage for the nav-context filter mapping (existing test file if present).
- e2e assertions belong to WP-36; do not add e2e here.

## Constraints

- Program rules in /AGENTS.md bind. No `packages/shared` edits. `packages/ui` edit is
  limited to deleting the dead ProfileSwitcher (and its export).
- Roadmap/feedback items: never set `shipped`; anything you'd update stays `in_progress`
  pending Victor's approval.
- Branch `wp-34-quickfix-batch` only; commits `fix(wp-34): ...`; no push, no merge.
- Verify: `pnpm typecheck && pnpm lint && pnpm test` green at the end.
- Final message: per-fix summary, files touched, test results, anything found adjacent but
  deliberately not fixed.
