# WP-21 — UI redesign (design system + AdLabs-style shell)

**Owner:** Claude Opus · **Phase:** v1 polish · **Requested by operator 2026-08-14**
("the UI looks horrible; make the sync toggle a dropdown; improve it overall; copy AdLabs")

## Goal

Turn the functional-but-raw web app into something that reads like AdLabs: a real design
system, a proper app shell, and polished screens. Match AdLabs' layout patterns and
information architecture (we have UI-verified specs for them); do NOT copy their logo, name,
brand colors, or any distinctive branding — this stays wizard-ads' own neutral identity so it
never launches looking like a clone.

## Sources (read first)

- `tools/recon/00-INDEX.md` then `01-navigation-map.md`, `02-data-grid.md`, `03-dashboards.md`,
  `04-optimizer.md`, `06-tags.md`, `09-settings-and-admin.md` — UI-verified AdLabs layout.
- `tools/recon/screenshots/` — 13 real screenshots for visual reference.
- Load the **ecom-wizards-brand visual-quality review** before designing, and the **dataviz skill**
  before touching any chart/metric-tile styling.
- Current frame: `apps/web/src/ui/{nav.tsx,tokens.ts,shell.tsx}`, `app/layout.tsx`, and the
  per-route pages under `app/`.

## Spec

1. **Design system** (`src/ui/`): a coherent token set (color scale with proper light/dark,
   spacing, radius, typography scale, elevation), a small primitives library (Button,
   Select/Dropdown, Input, Card, Table shell, Tabs, Badge/Pill, Toast, Modal, KPI tile) —
   all themeable, accessible (focus states, keyboard), and consistent. Replace ad-hoc inline
   styles across the app with these.
2. **App shell like AdLabs**: replace the flat top bar with AdLabs' pattern — a **left sidebar
   with collapsible nav groups** (per `01-navigation-map.md`: 6 groups, not a flat list), a
   top bar carrying the **profile switcher** + account/sign-out, and a content area. Keep our
   route set. Preserve the signed-in/anonymous states WP-fix-prod-1 added.
3. **Sync control → dropdown** (the operator's specific ask): on `/settings/profiles`, the
   per-profile sync control becomes a proper Select (e.g. Sync: On / Off / cadence options)
   instead of a bare click-toggle, with optimistic UI + a toast on save. Keep the role gate
   (admin+ toggles) and the existing server action.
4. **Polish the key screens** to their recon layouts: dashboard (KPI tile row + trend cards +
   flags panel + freshness/crosscheck chips), the data grid chrome (toolbar, filter chips,
   column controls, the `Change Reasons`/`Limit Reasons` split, group-by), recommendations
   review (reason pills, provenance panel), roadmap (three columns + vote controls),
   settings. Empty states must look intentional ("no data yet — connect Amazon / sync
   pending"), not broken.
5. **Dark mode** parity throughout (AdLabs has it; tokens make it cheap).

## Constraints

- You own `apps/web` (and may add to `src/ui/`). Do not change server actions, queries, auth,
  or anything outside presentation. Do not touch other packages.
- Every existing e2e test must stay green — many assert `data-testid`s and visible text; keep
  those hooks and copy, restructure around them. Update a test only for a deliberate,
  documented markup change, never to drop coverage.
- No new heavy UI dependency without noting it; prefer the existing stack (React 19, CSS/
  CSS-modules or a tiny utility layer). If you add one, it must build under `--webpack` and
  keep `pnpm check` + `next build` green.

## Acceptance checks

- `pnpm check` green; `next build` (webpack) green; ALL web e2e suites green.
- Sidebar shell renders on every route, both auth states; profile switcher works.
- Sync control is a dropdown with a toast; role gate intact (viewer sees it read-only).
- Screens visually match their recon references (manager reviews against screenshots).
- Dark mode has no unstyled/contrast-broken surfaces.
- Branch `wp-21-ui-redesign`; report with before/after notes per screen.
