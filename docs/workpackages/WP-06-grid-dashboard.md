# WP-06 — Data grid + dashboard UI (`packages/ui`, `apps/web` dash routes)

**Owner:** Codex · **Phase:** v1 · **Depends on:** WP-00/01; recon specs (WP-11) for columns/layout; core outputs (WP-05) for widgets

## Goal

The AdLabs-grade analytics surface: a no-pagination virtualized data grid and the per-profile
dashboard.

## Read first

- `tools/recon/` — AdLabs screen specs from WP-11 (grid columns, filters, dashboard layouts).
  Grid shell can start before recon lands; column sets and dashboard composition wait for it.
- `docs/PLAN.md` — "v1 module scope" items 4–5.
- WP-01 typed queries; WP-05 output types (flags, pacing, deltas).

## Spec

1. **Grid** (`packages/ui` DataGrid on TanStack Table + Virtual): virtualized (50k+ rows
   smooth), multi-sort, filter DSL (numeric/text/enum conditions, AND groups), column sets per
   entity level (campaigns/ad groups/keywords/targets/search terms), saved views (per user),
   group-by with **recalculated derived metrics** (ACOS = sum(cost)/sum(sales), CVR/CPC/CTR
   likewise from sums — never averaged ratios), CSV export of the filtered set (counts shown:
   exported N of M).
2. **Dashboard** (per profile): spend/sales/ACOS/CPC trend charts vs prior period + trailing-7
   (analyze outputs), pacing widget (MTD run-rate vs monthly budget, cut-order aware), flags
   panel (active + suppressed shown separately as "noted, not flagged"), data-freshness banner
   (from `report_requests`, NOT inferred from facts) + crosscheck verdict chip (WP-10 data).
3. Profile switcher + tag-scoped filtering hooks (tags land in WP-08 — consume via a filter
   interface, don't build tag UI).
4. Currency/timezone correctness: single-profile views render profile currency; no cross-
   currency aggregation anywhere in v1 UI.

## Acceptance checks

- 50k-row search-term fixture scrolls/sorts/filters without jank (perf test budget: <16ms
  frame on M-series).
- Group-by ACOS/CVR verified against SQL aggregates in tests (sum/sum, not avg of ratios).
- Freshness banner sourced from `report_requests` (test: facts present but stale request row →
  banner shows stale).
- Manager visual review against recon screenshots.
- Branch `wp-06-grid-dash`; report per acceptance check.
