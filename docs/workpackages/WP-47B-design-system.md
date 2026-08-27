# WP-47B — Implement the brand design system

**Status:** open · **Owner:** Codex (gpt-5.6-sol xhigh) · **Branch:** `wp-47b-design-system`

## Why

Operator verdict on the live product: "UI and UX still sucks." The design system is
already specified — this WP implements it. Read FIRST, in order:
1. `docs/design/DESIGN-SYSTEM.md` — the token table, type scale, and component rules.
   It is the contract for this WP; follow it exactly.
2. `docs/design/AUDIT-2026-08-27.md` — P2/P3 findings (brand adoption, one-primary-action,
   charts, topbar, nav, empty states, roster save bar, grid toolbar rows, feedback cards).

## Scope

1. **Tokens**: replace the current `--wa-*` values in `apps/web/src/ui/theme.css` (and any
   fallbacks in `packages/ui`) with the DESIGN-SYSTEM.md dark + light tables. Every
   surface/text/border/accent color flows from tokens — grep for hardcoded hexes in
   apps/web + packages/ui styles and migrate them.
2. **Type**: Inter variable via `next/font` (self-hosted, no network font at runtime);
   apply the scale (eyebrow/body/table/title/KPI); `font-variant-numeric: tabular-nums`
   on tables, KPI values, axis ticks.
3. **Components** per the spec: KPI card (eyebrow/value/one delta line); empty-state card
   (centered, one action); nav active = indigo-soft fill + 2px orange left rule; tables
   (header caps, hover, selected, right-aligned numerics); focus ring; buttons — ONE
   orange gradient primary per view (per-route mapping in the spec), everything else
   ghost. Topbar: replace the raw email string with an avatar-initials menu (email +
   sign out inside); theme toggle gets a labelled affordance.
4. **Charts** (`apps/web/src/ui/viz.tsx`): series1 indigo #3322E0, highlight orange
   #FD4807, comparison #868A96 dashed; 3–5 y-gridlines only; 12px tabular ticks;
   endpoint value labels. (Settling shading is WP-47A's — don't collide; if 47A already
   merged, build on it.)
5. **Both themes** verified: keep contrast AA for text, 3:1 for chart strokes.
6. Do NOT redesign flows/IA (WP-48/49 own those); this is visual system adoption. Where
   a WP-48/49 file would conflict (optimizer-view, bugs/roadmap pages), keep changes
   token/class-level so merges stay trivial.

## Constraints

- AGENTS.md rules bind; no `packages/shared` edits; roadmap items stay in_progress.
- Branch `wp-47b-design-system`; commits `feat(wp-47b): ...`; no push/merge.
- Verify: `pnpm typecheck && pnpm lint && pnpm test` green (update snapshot/visual
  assertions that pin old colors); production build passes.
- Final message: token migration coverage (files touched, hardcoded-hex count before/
  after), per-route primary-action map as implemented, anything deliberately deferred.
