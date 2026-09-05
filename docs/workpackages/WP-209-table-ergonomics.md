# WP-209 — Table ergonomics for the first four operator workspaces

Owner: Claude Fable 5.1 (frontend design). The implementer must not edit the owned files.

Depends on: no write activation for the initial conversion. Preserve the selection and proposal
controls already present. New bulk proposal revision/editing consumes the backend contract/API
handoff in WP-214; it does not require a live Amazon test. Serialize shared-file handoffs before
editing. This package implements WP-211's requested changes inside `packages/ui/src/**`.

## Definition of done, from the operator's recording of 2026-09-05

Every operator table behaves like the AdLabs grids the operator compared against: continuous
scrolling with no pagination, click-to-sort on every header, drag a column header into a group
bar to group and nest, and full-width layout instead of a narrow centered column. The Campaign
Optimizer table is the first target because it was the one shown. This package delivers Grid,
Optimizer campaigns, Recommendations and N-grams. Inventory remaining tables in the close-out
with follow-up owners; do not report every operator table complete from these four surfaces.

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
  `apps/web/app/ngrams/explorer.tsx`, `apps/web/app/recommendations/page.tsx`,
  `apps/web/app/ngrams/page.tsx`, `apps/web/src/ui/cockpit.tsx`;
- `apps/web/e2e/grid.spec.ts`, `apps/web/e2e/recommendations.spec.ts`;
- this brief.

## Required behavior

Initial conversion, shipped after the recorded checks pass:

1. Split `DataGrid.tsx` into header, totals, body and cell components and `GridToolbar.tsx`
   into filter builder, column picker, grouping levels and saved views, behavior-preserving,
   under the existing tests.
2. Grid first paint: add a hydration-safe synchronous cache path where browser storage supports
   it and debounce persistence. Preserve `ViewStore`'s asynchronous implementation support,
   cancellation on scope changes and the protection against late restoration overwriting user
   input. Measure first paint; removing the gate universally is not the acceptance criterion.
3. Full-width workspace layout for grid, optimizer, recommendations and n-grams; grid height
   fills the viewport with a fullscreen toggle and a density setting.
4. Drag a header into a group bar; the existing dropdown stays as the keyboard path. Group
   chips are reorderable and removable; nesting recomputes ratios from sums as today.
5. Click-to-sort on sortable data columns of the four scoped workspaces, with shift-click
   multi-sort. Selection and action headers do not pretend to have a data ordering.
6. Optimizer campaign table rendered through the Data Grid without its client-side 25-row
   slice; the current loader returns the full campaign set. Preserve selection immediately.
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

After the WP-214 backend proposal/completeness handoff:

12. Preserve existing checkbox selection in the initial conversion. Add a bulk proposal bar
    after its backend exists. Select-all names its exact population: the current grid caps at
    50,000 and reports truncation; recommendations cap at 20,000 without completeness metadata.
    Use the backend's completeness/count contract before calling loaded rows the whole filtered
    set. Reconcile selection, proposal and export counts; retain truncation notices.
13. Editable proposed value uses the backend revision API, decimal contract and concurrency
    token. Show conflicts and invalidated previews; export and the WP-214 builder freeze the
    chosen persisted revision. UI-local edits must not disappear on export.

## Acceptance

1. A recorded click-through on the optimizer page reproduces the operator's video actions:
   scroll the whole campaign list, sort by spend, drag a header to group, nest a second level.
2. Existing `packages/ui` tests and the performance suite stay green; new e2e for sort, drag
   grouping and decision persistence pass.
3. Grid first paint on the reference fixture does not regress; synchronous-cache and delayed
   asynchronous restoration cases preserve interaction and scope safety.
4. Selection remains usable during conversion; truncated result sets never present select-all
   or export counts as a complete population. Remaining operator tables have an explicit inventory.

## Local performance baseline from the handoff audit

On 2026-09-05, the unchanged UI passed 163 functional tests and nine of ten performance tests.
`packages/ui/src/pipeline.perf.test.ts` line 158 failed locally at 149.4 ms, then 144.6 ms in
isolation, against its 125 ms local budget. Record the comparable environment and resolve the
baseline before claiming the conversion preserves performance; do not weaken the assertion
merely to get a green result. Full evidence is in `REPLAN-2026-09-05-AUDIT.md`.
