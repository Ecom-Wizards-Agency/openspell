# WP-35 — "Bug" widget, /bugs board, duplicate-check seam

**Status:** open · **Owner:** Codex (gpt-5.6-sol) · **Branch:** `wp-35-bug-widget`

## Why

The floating feedback button currently navigates to a full-page form. Victor wants: a small
chat-window-style popover labeled **"Bug"** (bug reports only), a public **/bugs board**
(sibling of /roadmap) so duplicates are visible before filing, and an AI duplicate-check
that runs on the 24/7 machine when a bug is submitted. WP-34 (merged) already fixed
profileId capture on the full form; build on current main.

## Scope

1. **Bug widget** `apps/web/src/ui/bug-widget.tsx` (client), replacing the floating
   `FeedbackEntry` link in `apps/web/app/layout.tsx` (keep it off /login — WP-34 added the
   session gate; preserve it):
   - Floating button labeled "Bug". Click → anchored popover (chat-window feel): severity
     select (reuse options from `apps/web/app/feedback/new/submit-form.tsx`), textarea
     (first line becomes the title; keep it simple — one field), captured-context line
     (`describePageContext`), submit, and a "Full form →" link to `/feedback/new?from=…`
     for feature requests / long reports.
   - `type: 'bug'` hardcoded. POST to `/api/feedback` (exists). Success → toast
     (`ToastProvider`) + close + link to the new item on /bugs.
   - Popover mechanics copied from the ProfileSwitcher in
     `apps/web/src/ui/topbar-controls.tsx` (outside-click, Escape, focus trap,
     `role="dialog"`, focus returns to trigger). Styling via `wa-*` custom properties in
     `apps/web/src/ui/theme.css`, both themes.
2. **/bugs board** `apps/web/app/bugs/page.tsx` (+ board component): the /roadmap pattern
   (`apps/web/app/roadmap/board.tsx`, `listRoadmap` query) filtered to `type='bug'`.
   Columns: Open (new/triaged), In progress, Fixed (shipped), plus collapsed
   Declined/Duplicate. Vote chips as on roadmap. Nav: add under the `product` group in
   `apps/web/src/ui/nav-links.ts` ("Bugs"). Cards link into the tracker item.
3. **Duplicate model + seam** (the AI check itself is NOT in this WP):
   - Migration: add `duplicate_of uuid references feedback_items(id) on delete set null`
     to `feedback_items` (+ partial index on `duplicate_of where duplicate_of is not
     null`), and a `dedup_checked_at timestamptz` column. RLS unchanged.
   - Tracker/admin: allow an admin to mark an item as duplicate-of (small control in
     `apps/web/app/feedback/tracker.tsx`), which sets status `declined` with the admin
     note auto-filled "duplicate of #…" and `duplicate_of` set. Board renders duplicates
     collapsed under their target.
   - Widget submit response: if the API finds `duplicate_of` already set later, nothing
     changes client-side — but DO return the created item id and render "similar bugs"
     client-side BEFORE submit when title text matches existing open bugs
     (cheap ilike/trigram query via a new `/api/feedback/similar?q=` route, org-scoped,
     read-only, debounced). This is the deterministic half of dedup; the AI half runs
     out-of-band on the 24/7 machine against `dedup_checked_at is null` rows (separate
     WP; leave the column and a doc note).
4. **Tests**: widget payload unit test (bug-only, profileId from route — WP-34's
   `page-context.ts` already parses it); /bugs page render test; similar-endpoint
   org-scoping test; update `apps/web/e2e/feedback.spec.ts` (open widget → submit → item
   appears in /feedback and /bugs; admin marks duplicate → board collapses it).

## Constraints

- Program rules in /AGENTS.md bind. No `packages/shared` edits.
- Roadmap/feedback items: never set anything `shipped`; keep `in_progress` pending Victor.
- Branch `wp-35-bug-widget`; commits `feat(wp-35): ...`; no push, no merge.
- Verify: `pnpm typecheck && pnpm lint && pnpm test` green at the end.
- Final message: what shipped, migration notes (hosted-apply required), the dedup seam
  contract for the 24/7 job, test results.
