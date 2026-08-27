# WP-47A QA fix architecture

## Problem

The default UI comparison needs two adjacent 30-day windows, but scheduled
Reporting v3 ingestion only covers the newest 32 days and currently includes the
profile's still-open current day. A newly synced profile therefore has one day of
the named prior window at best. Grid rows honestly map that absence to `null`, while
the optimizer folds an empty row set into zero totals. The same batch also needs
settled KPI comparisons, chart settling/collision treatment, and narrower profile
pickers without changing shared contracts or the worker-only Amazon boundary.

## Usage (caller's view)

```ts
// Worker scheduling: two legal 32-day report ranges cover both UI windows.
defaultSchedules(['spCampaigns']);
// default: yesterday back 3 days
// restatement: yesterday back 32 days
// comparison: the preceding 32-day block

// Web comparison arithmetic: an empty row set stays absent.
const current = totalsOf(currentRows);
const prior = totalsOf(priorRows);
const tiles = kpiTiles(current, prior);

// One settling policy supplies both KPI clipping and chart annotation.
const windows = settledComparisonWindows(selectedPeriod, today);
<TrendChart settlingWindow={windows.settling} />;
```

## Shape

- `sync_schedules.window_offset_days` owns report-window placement. The scheduler
  always ends report windows yesterday, then applies the offset. A `comparison`
  variant at offset 32 is contiguous with the current restatement window and keeps
  each request within Amazon's range limit.
- `totalsOf(rows)` returns `BaseTotals | null`; `kpiTiles` accepts nullable current
  and comparison totals. Absence is encoded once instead of inferred from zero
  metrics by every tile.
- `settledComparisonWindows(period, today)` returns the settled portion of the
  selected period, its immediately preceding equal-length period, and the trailing
  14-day settling band. Dashboard and optimizer consume the same policy.
- `TrendChart` receives one optional settling window and owns its rendering.
  `stackEndLabelYs` owns endpoint collision layout as a pure, unit-tested function.
- Profile option formatting remains local to each surface. Experiments add country
  code to their existing option model; the competitor form gets a small client
  selector so only that control pays for show-all state.

Callers provide a period, row set, or settling window. The helpers own date
arithmetic, missing-data handling, shading, and label layout.

## Synthesis decision

The fix starts with ingestion coverage rather than a UI fallback. Clipping the displayed
30-day range to whatever happens to be loaded was rejected because the header and
delta grain would diverge. Enqueuing history from a page read was rejected because
it leaks report orchestration into the web tier. The chosen schedule fix is combined
with the nullable optimizer model so the UI remains honest while a new comparison
window is still loading.

## Tradeoffs accepted

- We accept one additional weekly report request per report type in exchange for a
  complete default comparison window on newly connected profiles.
- We accept a small client component in the integrations form in exchange for
  keeping the rest of the settings page server-rendered.
- We accept clipping KPI values to settled dates in exchange for comparing equal,
  trustworthy windows; charts still show the selected period and mark its tail.

## Alternatives considered

- Shorten the default UI period: smaller implementation, but it exposes ingestion
  limits as product semantics and silently changes the requested analysis grain.
- Load on demand from the page: could fill the exact range, but violates the worker
  ownership boundary and turns a read into asynchronous external work.
- Render partial prior totals: simplest surface, but a one-day baseline labeled as
  30 days is the trust failure this batch exists to remove.

## Open questions and risks

- Will an older marketplace reject the offset comparison block despite accepting
  the same dates manually? The existing failure/dead-letter path will make that
  visible; no UI fallback will fabricate a delta.
- Can a selected period contain no settled day? Yes; the KPI model returns no
  comparison data while the chart still renders the explicitly shaded selection.

## Implementation order

Add and test the offset schedule first, then change the web comparison model. This
keeps the UI honest while historical facts are still arriving.
