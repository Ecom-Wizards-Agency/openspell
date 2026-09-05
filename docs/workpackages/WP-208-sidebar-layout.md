# WP-208 — Sidebar layout and icon rail

Owner: Claude (design). The implementer must not edit the owned files.

Depends on: nothing. Rides on the WP-213 deploy because the bug is live in `44da7ac`.

## Objective

Make the sidebar usable at every desktop height: the navigation scrolls inside its own box, the
utility footer stays pinned and never covers a link, and the collapsed icon rail shows every
link again.

## Root cause

Commit `5cedb62` (WP-110) added `.wa-sidebar-main { min-height: 0 }` in
`apps/web/src/ui/theme.css:428-432` without an overflow rule, so on short viewports the flex
algorithm shrinks the nav box and its rows spill under `footer.wa-sidebar-utilities`, which has
no background but takes the clicks. The same commit changed `DEFAULT_CLOSED` in
`apps/web/src/ui/sidebar.tsx` to close all three workflow groups, and the rail hides group
summaries, so links inside closed `details` are unreachable in rail mode.

## Owned files

- `apps/web/src/ui/theme.css` (sidebar, rail and narrow-viewport rules only);
- `apps/web/src/ui/sidebar.tsx`;
- `apps/web/e2e/sidebar-layout.spec.ts` (new) and `apps/web/playwright.profile-context.config.ts`
  `testMatch`;
- `docs/HANDOVER.md` "Known UX and performance follow-ups" items 1 and 12 (close-out only);
- this brief.

## Required behavior

1. `.wa-brand` and `.wa-sidebar-utilities` get `flex: none`; `.wa-sidebar-main` gets
   `flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain` and keeps `min-height: 0`;
   `.wa-sidebar` becomes `overflow: hidden` at desktop widths with a stable scrollbar gutter so
   labels do not shift.
2. In the narrow block (`max-width: 60rem`) reset `.wa-sidebar-main { flex: none; overflow:
   visible }`, delete `.wa-navgroup { flex: 1 1 10rem }` (it inflates closed groups vertically),
   replace the dead `.wa-sidebar-foot` rule with a deliberate `.wa-sidebar-utilities` style, and
   hide `.wa-nav-collapse`, which is a no-op there.
3. Rail mode: force every group open while collapsed
   (`open={collapsed || holdsCurrent || !closed.includes(group.id)}`), skip `remember()` while
   collapsed so the operator's stored closed set is not overwritten, and delete the
   `display: flex !important` hack.
4. Delete dead CSS: `.wa-navlink-dot`, `.wa-frame`, all `.wa-sidebar-foot` selectors.
5. Regression spec at 1280 by 720 and 1440 by 1000 with every group open: the footer's bounding
   box ends inside the viewport, `Sync status` after `scrollIntoViewIfNeeded` is the element at
   its own center point, no nav link box intersects the footer box, `.wa-sidebar-main` scrolls
   while `.wa-sidebar` does not. Rail case: after collapsing, every entry in `NAV_LINKS` has a
   visible link. Occlusion is asserted with `elementFromPoint`, not `toBeInViewport` alone.

## Acceptance

1. Manual check in both themes at about 860 and 1000 pixels tall with all groups open.
2. The new spec fails on current main and passes on the branch; CI serial e2e is green.
3. `pnpm check` passes; HANDOVER items 1 and 12 are closed with the corrected mechanism.

Out of scope: a mobile drawer under 960 pixels and a pre-paint script for the rail state; both
are listed as follow-ups, not built here.
