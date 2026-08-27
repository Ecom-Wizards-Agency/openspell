# WP-47B implementation architecture

## Problem

The application already has a useful seam: app chrome and primitives read CSS custom
properties, while `packages/ui` uses inline styles with custom-property fallbacks. The
design-system implementation must replace the visual language without moving route
ownership, changing data flow, or making the UI package aware of Next.js routing.

## Usage (caller's view)

Routes keep choosing their own action hierarchy explicitly:

```tsx
<PageHeader actions={<Button variant="primary">Run now</Button>} />
<Button>Open review</Button>
```

Presentation components expose only the state they can render:

```tsx
<KpiTile label="Sales" value={sales} delta={comparison} />
<EmptyState title="This run proposed nothing" meta={<time>Run …</time>} body="…" />
<DataGrid selectedRowIds={selectedIds} {...gridProps} />
```

Standalone `@wizard-ads/ui` consumers need no stylesheet. Its inline styles resolve
host `--wa-*` variables when present and otherwise use the light brand palette.

## Shape

`apps/web/src/ui/theme.css` is the single source of truth for palette aliases, type
scale, state styling, and app-level component classes. `apps/web/app/layout.tsx`
provides Inter through `next/font`; the CSS graph consumes its variable. App primitives
remain presentational and route-agnostic. `packages/ui/src/theme.ts` mirrors only the
fallback boundary needed for standalone rendering, while DataGrid and GridToolbar keep
their existing behavior and add selected-row and primary-export presentation directly.

This is the deepest available interface: callers choose semantic variants and pass
render state, while theme mechanics, theme switching, contrast adaptations, and visual
states stay hidden behind tokens.

## Synthesis decision

The CSS-first candidate became the base because it preserves ownership and keeps route
call sites shallow. A component-first candidate usefully contributed cardinality at
the KPI and grid-selection boundaries. A route-provider candidate was rejected because
it would make low-level buttons inspect URL state and expose routing policy throughout
the component layer.

## Tradeoffs accepted

- We accept a small fallback palette in `packages/ui` in exchange for standalone use.
- We accept explicit primary variants at route call sites in exchange for keeping the
  component layer independent of routing.
- We accept a contrasting under-stroke for indigo charts in dark mode in exchange for
  retaining the exact brand series color while meeting non-text contrast.

## Alternatives considered

- A route-aware `PrimaryAction` provider hid little and forced every button consumer to
  understand route policy, so it lost on interface depth.
- Rebuilding all app screens on `packages/ui` would centralize more markup but cross
  work-package ownership and turn a visual migration into a flow rewrite.

## Open questions and risks

- Will future chart roles need more than primary, highlight, and comparison? If so, the
  role belongs on `TrendSeries`, not in route-specific color selection.
- Will a future interactive grid require keyboard row selection? This package exposes
  selected rendering now; interaction should arrive with the owning workflow.

## Next implementation step

Land the canonical token/type foundation, then adopt component states and route actions
against it.
