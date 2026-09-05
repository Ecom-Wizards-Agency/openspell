# WP-208 — Sidebar layout and icon rail

Owner: Claude Fable 5.1 (frontend design). The implementer must not edit the owned files.

Depends on: no runtime package. Finish and hand off `theme.css` before WP-211 edits it. Rides on the WP-213 deploy because the bug is live in `44da7ac`.

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
- this brief's close-out for HANDOVER items 1 and 12; the current WP-207/WP-213 document
  owner integrates it, avoiding concurrent edits;
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
3. `pnpm check` passes; close-out evidence for HANDOVER items 1 and 12 names the corrected
   mechanism and is handed to the document owner.

Out of scope: a mobile drawer under 960 pixels and a pre-paint script for the rail state; both
are listed as follow-ups, not built here.

## Close-out

Delivered on branch `wp-208-sidebar-layout`. This section is the evidence the WP-207/WP-213
document owner needs to close `docs/HANDOVER.md` "Known UX and performance follow-ups" item 1 and
"Recommended continuation order" item 12; this package did not edit `docs/HANDOVER.md`.

### Corrected mechanism for HANDOVER item 1

The HANDOVER diagnosis ("the entire sidebar owns scrolling while the footer is also pushed with
auto margin") named the symptom, not the cause. The cause was `.wa-sidebar-main { min-height: 0 }`
with no overflow rule: on a short viewport the flex algorithm shrank the nav box below its
content, and the rows spilled in normal paint order under `footer.wa-sidebar-utilities`. The
footer has no background, so nothing looked wrong, but it is later in the DOM and hit-tests over
the spilled rows, so it took the clicks. Playwright's own actionability diagnostic on the
unmodified CSS reads: the footer's `Bugs` link "intercepts pointer events" on the `Verify`
summary.

The fix makes the column three flex items with exactly one flexible, scrolling member:

- `.wa-brand` and `.wa-sidebar-utilities` are `flex: none`;
- `.wa-sidebar-main` is `flex: 1 1 auto; min-height: 0; overflow-y: auto;
  overscroll-behavior: contain; scrollbar-gutter: stable`;
- `.wa-sidebar` is `overflow: hidden` at desktop widths, so the column can never scroll and the
  footer's `margin-top: auto` pins it inside the viewport.

"Simplify the active marker" resolved to deleting the dead `.wa-navlink-dot` rules; the active
marker is the left border on `.wa-navlink[aria-current='page']` and is unchanged. `.wa-frame` and
every `.wa-sidebar-foot` selector were also dead and are gone. The narrow block (`max-width:
60rem`) now resets `.wa-sidebar-main { flex: none; overflow: visible }`, styles
`.wa-sidebar-utilities` as one wrapped row, and no longer inflates closed groups with
`.wa-navgroup { flex: 1 1 10rem }`. The no-op `.wa-nav-collapse` is hidden by a second
`max-width: 60rem` block placed directly after the base `.wa-nav-collapse` rule: the two share a
specificity, so a hide rule inside the earlier layout block loses to the base `display: flex`.
The first cut made exactly that mistake and passed source inspection; review caught it with a
computed-style probe, and the spec now asserts the computed display at a narrow width.

Rail: with `DEFAULT_CLOSED` covering all three workflow groups and the rail hiding group
summaries, links inside a closed `<details>` were unreachable. `display: flex !important` on the
list never helped, because a closed `<details>` does not render its content at all. The
component now renders `open={collapsed || holdsCurrent || !closed.includes(group.id)}` and skips
`remember()` while collapsed, so the forced-open state is never written into the operator's
stored closed set; the CSS hack is deleted.

### Regression evidence for HANDOVER item 12

`apps/web/e2e/sidebar-layout.spec.ts` runs in the `profile-context` process
(`pnpm --filter @wizard-ads/web test:e2e:profile-context`). Five tests: 1280x720, 1440x860 and
1440x1000 with every `details.wa-navgroup` forced open, the icon rail, and an 800x900 narrow case.
Occlusion is asserted with `document.elementFromPoint` at each link's centre after
`scrollIntoViewIfNeeded`, the footer's box must end inside the viewport, no link box may intersect
the footer box, the nav is the only scroll container (the column's `scrollTop` cannot move), and
at 720 and 860 the nav must actually scroll. The rail case collapses through the real control and
requires a visible link for every `NAV_LINKS` entry with `localStorage` untouched. The narrow case
asserts computed styles, not source order: `.wa-nav-collapse` is `display: none` and hidden, the
column is `position: static`, and the nav is `flex: 0 0 auto` with `overflow-y: visible`.

Proof the spec fails on the old behavior and passes on the branch, from the same runner command
with `--grep sidebar-layout`:

- `origin/main` `theme.css`, new component: 1280x720 and 1440x860 fail at the `Sync status` hit
  test (`elementFromPoint` returns the footer); 1440x1000 fails because `.wa-sidebar-main`
  computes `overflow-y: visible`; the narrow case fails at `toBeHidden` on the collapse control;
  rail passes.
- unmodified `theme.css` and `sidebar.tsx`: the viewport cases fail as above and the rail case
  fails because `/optimizer` has no visible link.
- first-cut `theme.css` (hide rule inside the earlier narrow block): only the narrow case fails,
  at `toBeHidden`, because the control computes `display: flex`.
- branch: all five pass; the whole `profile-context` suite is 8 of 8.

One measured fact worth carrying: at 1440x1000 with every group open the nav box is 730px and the
current nav fits inside it, so the original bug did not reproduce at 1000px tall and the spec does
not demand overflow there. 720 tall reproduces it, and 860 tall overflows by 33px, which is why the
860 case demands a scroll too.

### Not done here

- `docs/HANDOVER.md` items 1 and 12 remain for the document owner to close with the text above.
- `apps/web/src/e2e-suite-registry.ts` still lists `profile-context` as owning only
  `profile-context.spec.ts` with 3 tests; it is outside this package's scope and its unit test
  checks only internal consistency, so nothing breaks, but the owner should add
  `sidebar-layout.spec.ts` and move the count to 8 (total 75).
- The mobile drawer under 960px and a pre-paint script for the rail state remain follow-ups.
