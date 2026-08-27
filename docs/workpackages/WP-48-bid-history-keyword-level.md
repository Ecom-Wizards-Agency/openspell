# WP-48 — Bid history at keyword level + grid fidelity quick wins

**Status:** open · **Owner:** Codex (gpt-5.6-sol) · **Branch:** `wp-48-bid-history`

## Why

Operator verdict: "the Bid Corridor makes only sense on keyword level." The recon
(`tools/recon/04-optimizer.md` §3 — read it in full first; it is visually confirmed)
shows AdLabs' corridor as a per-target **"view bid history" modal** opened from a row:
near-fullscreen, titled with the targeting expression, breadcrumb, per-target KPI tiles,
D·W·M toggle, band chart. Never a campaign-level card. Our current placement (a card at
the top of /optimizer with a 50-pill raw-ID chooser) is wrong.

## Scope

1. **Remove** the CorridorSection card + pill chooser from
   `apps/web/app/optimizer/page.tsx` + `apps/web/app/optimizer/optimizer-view.tsx`
   (and its `?target=` param handling).
2. **Bid-history modal** — new client component (e.g. `apps/web/src/ui/bid-history-modal.tsx`):
   - Title: `targeting` text + match type; subtitle breadcrumb: ad product | target kind |
     campaign name (link to /grid filtered to that campaign or the campaign row).
   - Per-target KPI tiles (impressions, clicks, orders, spend, sales, ACOS, CTR, CVR,
     CPC — reuse `deriveMetric` / the KPI tile component from the optimizer view) computed
     from `fact_sp_target_daily` for the same window.
   - The existing `BidCorridorChart` (`apps/web/src/ui/viz.tsx`) inside, with a D·W·M
     granularity toggle (follow TrendChart's `aggregatable` pattern; weekly/monthly
     aggregate band = min low / max high / mean median, bid/cpc = mean).
   - Async loading state ("Loading bid history…"); the chart's existing
     "no corridor synced" empty state for targets without series (SB/SD/paused).
   - Data via a small org-scoped API route (e.g. `GET /api/bid-history?profile=&target=`)
     reusing `apps/web/app/_lib/bid-corridor.ts` loaders + a target-label lookup (the
     join in `apps/web/app/_lib/grid-data.ts::loadTargets` shows how to resolve
     targeting/match/campaign names). Auth per existing API-route pattern; org_id from
     the actor, always.
   - A11y: role=dialog, focus trap, Escape (copy mechanics from bug-widget/ProfileSwitcher).
3. **Attach points**:
   - Grid Targets tab: pass `onRowClick` from `GridWorkspace`
     (`apps/web/app/grid/grid-client.tsx`) → open modal for `row.dimensions.target_id`
     (rows already carry targeting/campaign labels). Only for entity=targets.
   - Optimizer proposal rows (`OptimizerGroupTable` in optimizer-view.tsx): a
     "view bid history" affordance per row (ProposalView.entityId/entityType exist;
     keyword/target entities only).
4. **Grid columns** (targets tab, `packages/ui/src/columns.ts` DIMENSIONS.targets +
   `loadTargets` join): `suggested_bid` two-line cell (median on line 1; `low – high`
   smaller/dimmer beneath — see the recon's two-line cell), `max_potential_cpc`, and
   derived `diff_from_suggested_bid` (bid − median). Values from the LATEST
   `bid_series_daily` row per target (add a query helper in
   `packages/db/src/queries/bid-series.ts`; don't N+1). Sortable/filterable like other
   numeric columns; absent series ⇒ em-dash.
5. **Fidelity quick wins**:
   - `rpc_category` column on targets rows: classification via
     `packages/core` `classifyCampaignCategory` on the campaign name (filterable
     dimension — classification is a filter, not a run).
   - Column aggregate under the sorted header in `packages/ui/src/DataGrid.tsx`
     (sum for additive metrics, derived for ratios — reuse the existing totals logic).

## Constraints

- Read AGENTS.md; program rules bind. No `packages/shared` edits, no schema/migrations.
- Roadmap/feedback items stay `in_progress`.
- Branch `wp-48-bid-history`; commits `feat(wp-48): ...`; no push/merge.
- Verify: `pnpm typecheck && pnpm lint && pnpm test` green; update/extend affected unit
  tests (columns, view models) and the smoke e2e if it asserts optimizer content.
- Final message: what shipped, the API route contract, screenshots-worthy states, test
  results.
