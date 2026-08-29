# WP-110 — Focused operator navigation

## Outcome

Reduce sidebar noise without hiding product capability. Dashboard is a direct entry,
the three high-frequency task areas remain collapsible, and AI/product/admin links sit
in a quiet utility footer with the rail-collapse control.

## Scope

- `apps/web/src/ui/sidebar.tsx`
- `apps/web/src/ui/sidebar.test.ts`
- `apps/web/src/ui/theme.css`

## Acceptance

- Dashboard remains one click away.
- Optimize, Analyze, and Verify are the only disclosure groups.
- Only the group containing the current route opens by default.
- A deliberate operator open/close choice is remembered locally.
- Connect AI, Bugs, Roadmap, Settings, and Collapse remain visible in a quiet footer.
- Every route still carries the selected profile and remains present in the rendered
  navigation.
- Expanded and icon-rail layouts remain keyboard accessible.
