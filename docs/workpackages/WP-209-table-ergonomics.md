# WP-209 — Table ergonomics across every operator table

Owner: Claude (design). The implementer must not edit the owned files.

Depends on: nothing for the first five days. Row selection with bulk actions and inline
proposed-value editing wait for WP-214 so that edits are captured before export and flow into
the plan builder.

## Definition of done, from the operator's recording of 2026-09-05

Every operator table behaves like the AdLabs grids the operator compared against: continuous
scrolling with no pagination, click-to-sort on every header, drag a column header into a group
bar to group and nest, and full-width layout instead of a narrow centered column. The Campaign
Optimizer table is the first target because it was the one shown.

## Findings

`packages/ui` Data Grid already has sticky header, pinned first column, resize, reorder, totals,
multi-sort, nested group-by through a dropdown, categorical filters, saved views and CSV export on
a sound pipeline with a 50,000-row performance suite. It is missing selection, inline editing,
tiles and chart, entity search, density, keyboard navigation and a viewport-filling height. The
other tables do not use it: `apps/web/app/optimizer/campaign-workspace.tsx` paginates at 25 rows
without sorting, `apps/web/app/recommendations/review.tsx` calls `window.location.reload()` on
every decision, and `apps/web/app/ngrams/explorer.tsx` prints raw numbers. WP-24 ordered the
dense grid chrome, tile row and chart for the grid and it was never delivered there. Two grid
gates delay first paint: the row fetch and a saved-layout restore that could be synchronous.

## Owned files

- `packages/ui/src/**`;
- `apps/web/app/grid/**`, `apps/web/app/optimizer/page.tsx`,
  `apps/web/app/optimizer/campaign-workspace.tsx`, `apps/web/app/recommendations/review.tsx`,
  `apps/web/app/ngrams/explorer.tsx`, `apps/web/src/ui/cockpit.tsx`;
- `apps/web/e2e/grid.spec.ts`, `apps/web/e2e/recommendations.spec.ts`;
- this brief.

## Required behavior

Days 1 to 5, shipped on the first main deploy where possible:

1. Split `DataGrid.tsx` into header, totals, body and cell components and `GridToolbar.tsx`
   into filter builder, column picker, grouping levels and saved views, behavior-preserving,
   under the existing tests.
2. Grid first paint: read the saved layout synchronously on first render and debounce layout
   persistence so resize does not write on every mouse move.
3. Full-width workspace layout for grid, optimizer, recommendations and n-grams; grid height
   fills the viewport with a fullscreen toggle and a density setting.
4. Drag a header into a group bar; the existing dropdown stays as the keyboard path. Group
   chips are reorderable and removable; nesting recomputes ratios from sums as today.
5. Click-to-sort on every header of every table, with the existing multi-sort on shift-click.
6. Optimizer campaign table rendered through the Data Grid with no pagination.
7. Recommendations queue rendered through the Data Grid; decisions update in place with
   `router.refresh()` and optimistic status so filters, selection and scroll survive.
8. N-gram drill-down uses the shared formatters and the Data Grid.
9. Tiles and chart above the grid through the existing cockpit and daily loaders, streamed
   outside the row path.
10. Toolbar: free-text entity search, clickable filter chips that prefill the builder, view
    delete, grouped and searchable column picker; rename the `RPC category` header to
    `Campaign role` keeping the column id.
11. Keyboard navigation: roving focus on rows, arrow and home and end movement, Enter opens,
    Space toggles selection, Escape clears.

After WP-214:

12. Checkbox column with header select-all over the filtered set and a bulk action bar that
    creates proposals, never a direct write.
13. Editable proposed value on the review page, persisted as a proposal revision with the prior
    value, so the export and the WP-214 plan builder carry the edited number.

## Acceptance

1. A recorded click-through on the optimizer page reproduces the operator's video actions:
   scroll the whole campaign list, sort by spend, drag a header to group, nest a second level.
2. Existing `packages/ui` tests and the performance suite stay green; new e2e for sort, drag
   grouping and decision persistence pass.
3. Grid first paint on the reference fixture does not regress; the restore gate is gone.
