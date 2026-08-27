# wizard-ads design system — brand mapping v1 (2026-08-27)

Source of truth: Ecom Wizards Brand Guides V2.3 (pCloud, not in repo). This file maps the
brand onto the app's `--wa-*` custom properties and component rules. Implementation target:
`apps/web/src/ui/theme.css` (token values), `packages/ui` (components), `viz.tsx` (charts).

## Tokens (dark, primary system)

| Token | Value | Use |
|---|---|---|
| `--wa-bg` | `#0F1318` (Obsidian) | app background |
| `--wa-surface` | `#171C24` (Carbon) | cards, panels, table headers |
| `--wa-surface-2` | `#1C232D` | raised/hover surfaces |
| `--wa-border` | `#2A323D` (Slate) | hairlines, card borders |
| `--wa-text` | `#F5F6F8` (Cloud) | primary text |
| `--wa-text-dim` | `#9AA5B4` (Mist) | secondary text, labels |
| `--wa-text-faint` | `#5B6573` (Steel) | tertiary, disabled |
| `--wa-accent` | `#FD4807` (Signal Orange solid) | THE primary action, active highlights |
| `--wa-accent-grad` | `linear-gradient(#FF8A2B, #E2120A)` | the one gradient CTA per view |
| `--wa-indigo` | `#3322E0` (Electric Indigo) | data series 1, selection, focus ring |
| `--wa-indigo-soft` | `#3322E0` @ 12% | active nav background, selected rows |
| `--wa-good` | `#22C55E` | positive deltas |
| `--wa-bad` | `#EF4444` | negative deltas |
| `--wa-series-3` | `#868A96` | comparison/neutral series |

Light mode: White bg, Cloud `#F5F6F8` panels, Ink `#11151C` text, same accents. Both modes
ship together; verify contrast (AA on text, 3:1 on chart strokes).

Neutrals carry ~70% of every surface; accents ≤5%. Ruby Red is campaign collateral only —
never in product UI.

## Type

- Inter via `next/font` (variable), self-hosted; no substitute faces.
- Scale: eyebrow 11px/600/caps/+6% tracking · body 14px/400 · table 13px/400 ·
  page title 24px/700/−2% · KPI value 28px/800 · section title 16px/600.
- `font-variant-numeric: tabular-nums` on every table cell, KPI value, and axis tick.

## Component rules

- **One primary action per view**, orange gradient. Everything else ghost (border
  `--wa-border`, text `--wa-text`) or link. Per route: dashboard → none; optimizer →
  "Run now"; grid → "Export CSV"; experiments → "New experiment"; recommendations →
  "Open review"; members → "Invite"; feedback → "File something new".
- **KPI card**: eyebrow label (Mist, caps) · value (800, tabular) · one delta line
  (green/red arrow + settled-window comparison). No second delta line; detail on hover.
- **Empty state card**: centered, max-w 28rem, eyebrow + one sentence + one button;
  distinguish "never ran" vs "ran, nothing to report" (timestamp + narrative).
- **Charts** (`viz.tsx`): series1 indigo, highlight orange, comparison `--wa-series-3`
  dashed; y-gridlines only, 3–5 ticks, 12px tabular ticks; endpoint value labels; trailing
  ~14 unsettled days rendered at 45% opacity with a "settling" legend note.
- **Nav active item**: `--wa-indigo-soft` fill + 2px orange left rule; icons inherit text
  color.
- **Tables**: header Mist caps 11px; row hover `--wa-surface-2`; selected row
  `--wa-indigo-soft`; numeric cells right-aligned tabular.
- **Focus**: 2px `--wa-indigo` ring, offset 2px, everywhere.
- **Topbar**: brand left; profile switcher; theme toggle; avatar-initials menu (email +
  sign out inside) — no raw email string in the bar.

## Voice in UI copy

Direct, data-first, no hype (brand voice rules). Empty states say what ran and when, not
apologies. Buttons are verbs: "Run now", "Invite", "Export".
