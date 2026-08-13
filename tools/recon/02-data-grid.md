# 02 — Data grid: entity levels, columns, filters, group-by, views, export

**WP-11 recon · read-only.** Column sets below are exact: they were read off live
`get_entity_data` responses against the operator's own org, not transcribed from documentation.
Filter semantics come from the live filter schema resources. UI chrome (widths, chips, menus)
is from AdLabs' own tutorial videos and is marked `VID`; it was not visually verified because
the browser session never came up — see `BLOCKED.md`.

---

## 1. Entity levels

Nine PPC grids, three DSP grids, one profile-level SQP grid.

| Grid | Row granularity | Notes |
|---|---|---|
| Profile | one row per advertising profile | The only cross-profile view in the product. Returns PPC + `seller_*` + `vendor_*` + `dsp_*` metric families side by side. |
| Campaign | one row per campaign | SP / SB / SD / TV. |
| Ad group | one row per ad group | |
| Placement | one row per campaign × placement type | Top of Search, Rest of Search, Product Page. A bid *modifier*, not a child entity. |
| Target | one row per keyword or product target | Column is `match_types` **plural** here. |
| Search term | one row per search term × ad group | SP and SB only; **SD excluded**. |
| Negative target | one row per negative | No date filter — it is not a metric entity. |
| Advertised product | one row per product ad (`ad_id`) in a campaign/ad group | SP and SD only; **SB excluded**. |
| Product | one row per ASIN, summed across every campaign | SP and SD only. Carries the Seller Central / Vendor business columns. |
| Search query (SQP) | one row per query × ASIN, **weekly** | Sunday–Saturday, snapped. Profile-level, organic + paid. |
| DSP campaign / DSP ad group / DSP flight | parallel hierarchy | Never mixed with PPC in one query. |

### Two hard traps in the level model

1. **`match_types` (target) vs `match_type` (negative_targeting).** Plural on one entity,
   singular on the other. AdLabs' own docs call this out explicitly. Our schema should use one
   name.
2. **`product` vs `advertised_product` are not the same ASIN view.** `product` is the ASIN
   aggregate across all ads and is the only place the business-report columns exist;
   `advertised_product` is per ad instance, so one ASIN appears many times. Their ad-type
   coverage is *different* (`product`: SP+SD, no SB — same as advertised_product; but `product`
   is where organic/total sales live). Anyone reaching for "product performance" and landing on
   the wrong one gets a plausible wrong number.

---

## 2. Column sets

### The suffix rule (applies to every metric column, every grid)

Each metric ships as **four** columns:

```
<metric>                     value in the selected period
<metric>_comparison          value in the comparison period
<metric>_delta_absolute      difference
<metric>_delta_percent       percent change
```

The comparison period defaults to *the immediately preceding period of the same length* when the
user does not set one. This is why every AdLabs grid can show a delta without the operator
choosing a baseline — a good default we should copy.

**Known delta inconsistency (carried over from prior team findings, worth re-verifying):** the
profile entity returns `*_delta_percent` as a ratio while the product aggregate returns a true
percent. Do not assume one convention.

### Shared metric family (identical on campaign / ad group / placement / target / search term)

```
acos  actc  aov  clicks  cpa  cpc  cpm  ctr  cvr  impressions  orders
other_sku_sales  roas  rpc  sales  same_sku_orders  same_sku_sales  spend  units
sales_of_profile_total   spend_of_profile_total
```

Plus two 30-day context columns that are *not* period-scoped and carry no suffix variants:
`avg_daily_sales_30d`, `avg_daily_spend_30d`, `sales_trend_pct_30d`, `spend_trend_pct_30d`.
These are quietly the most useful columns in the grid: they give a run-rate baseline next to the
selected period without making the operator open a second view.

### Campaign grid — non-metric columns (exact)

```
campaign_id  campaign_global_id  campaign_name  campaign_state  campaign_state_raw
campaign_ad_type  campaign_ad_type_raw  targeting_type  bid_strategy  cost_type  creative_type
goal  budget_amount  placement_mod  start_date  end_date  is_ended
portfolio_id  portfolio_name  campaign_group_id  campaign_group_name
dayparting_schedule_id  dayparting_schedule_name  dayparting_schedule_state
has_opt_rule  last_optimized_at  last_optimized_note
audience_name  site_restrictions  off_amazon_budget_control_strategy
sponsored_brands_version_multi_ad_groups_enabled
```

Note the `_raw` twins (`campaign_state_raw`, `campaign_ad_type_raw`, `placement_type_raw`,
`target_entity_type_raw`): AdLabs keeps both a display value and the Amazon-native enum in the
same row. That is a deliberate choice and a good one — it means a filter or an export never has
to reverse-engineer a label back into an API value.

`is_ended` is a computed boolean: true when `end_date` is strictly before today in the *profile
timezone*. Campaigns with `is_ended=true` cannot take budget or bid updates even when
`campaign_state='Enabled'`. That is a real write-path gate and our staged-apply engine (WP-12)
must replicate it, not discover it at 400.

### Target grid — non-metric columns (exact)

```
target_id  targeting  target_state  target_entity_type  target_entity_type_raw
match_types  is_theme  bid  max_cpc  suggested_bids
diff_from_suggested_bid  diff_from_max_cpc  recommended_bid_by_current_date_range
rpc_category
ad_group_id  ad_group_name  ad_group_state
campaign_id  campaign_global_id  campaign_name  campaign_state  campaign_ad_type
campaign_ad_type_raw  campaign_budget_amount  campaign_cost_type  campaign_goal
campaign_is_video  campaign_group_id  campaign_group_name
portfolio_id  portfolio_name  end_date
has_opt_rule  last_optimized_at  last_optimized_note
```

Four of these are the whole reason their bid workflow feels different from a bulksheet:

- `rpc_category` — the bid classification: **High ACOS, High Spend, No Sales, Low ACOS, Low
  Visibility**. Each has its own correction formula. This is a *stored column on every target
  row*, not something computed inside the optimizer. So an operator can filter the plain grid to
  "show me every low-visibility target" without running an optimization at all.
- `suggested_bids` — Amazon's suggested bid band, carried inline.
- `diff_from_suggested_bid` / `diff_from_max_cpc` — the gap, precomputed. The operator never
  does the subtraction.
- `recommended_bid_by_current_date_range` — AdLabs' own recommendation, recalculated against
  whatever date range is currently selected.

**Removed 2026-07-28:** `top_of_search_impression_share` was deleted from the target entity with
no replacement anywhere. Per-target top-of-search impression share is currently unavailable in
AdLabs. That is a live gap we can beat.

### Placement grid — extra columns

```
placement_id  placement_type  placement_type_raw  percentage
cvr_lift  placement_recommendation
placement_last_optimized_at  placement_last_optimized_note
campaign_last_optimized_at  campaign_last_optimized_note
```

`percentage` is the current modifier, `placement_recommendation` is the suggested one, and
`cvr_lift` is the *reason*. AdLabs' stated doctrine: "Placement adjustments are based on CVR
lift between placements, NOT ACOS." The grid puts current, recommended, and the driver in three
adjacent columns. Clone this pattern for every recommendation we ever show.

**Quiet aggregate trap:** on the test profile, 301 placement rows were fetched but
`number_of_entities` read 260 — 41 `SITE_AMAZON_BUSINESS` rows are included in the row-level
reference and **excluded from the aggregate totals**. Row count and aggregate count legitimately
disagree. Any crosscheck we build (WP-10) has to know this or it will report a false mismatch.

### Search term grid — extra columns

```
search_term_id  search_term  targeting  match_types  target_state
entity_id  entity_type  harvested_targets  is_brand_asin  bid
campaign_start_date  campaign_targeting_type  campaign_is_video  campaign_goal  campaign_cost_type
```

`harvested_targets` is the one to copy: the grid tells you, per search term, whether you have
already harvested it. Without that column an operator re-harvests the same winners every week.
`is_brand_asin` supports brand/non-brand segmentation directly in the grid.

Search terms carry **three independent tag layers** as columns simultaneously: search-term tags,
campaign tags, and target/keyword tags. See `06-tags.md`.

### Product grid — extra columns (the business-report layer)

This is the grid that makes AdLabs more than an ads tool. On **seller** profiles:

```
asin  parent_asin  sku  title  title_alias  display_name  brand  category
availability  availability_trend  eligibility  basis_price  price_to_pay
best_seller_rank  bsr_change  bsr_trend
fulfillable_units  days_of_cover  out_of_stock_days  scarce_stock_days  limited_available_days
buy_box_views  featured_offer_percent
organic_traffic  organic_units  organic_sales  total_views  unit_view  ups
total_sales  total_sales_b2b  total_units  total_orders  total_clicks
total_acos  total_actc  total_aov  total_asp  total_cpa  total_cvr  total_roas  total_sat
ad_sales_of_total
cogs  profit  profit_margin
target_acos  target_acots  target_ad_sales  target_ad_spend
target_total_sales  target_shipped_cogs  target_shipped_rev
```

Three semantics that are easy to get wrong and that AdLabs prints a warning about on every fetch:

- `sales` = ad-attributed only.
- `total_sales` = Seller Central total (ad + organic). **This is the source of truth.**
- `organic_sales` = `max(total_sales - sales, 0)` — a *derived* column. Never sum `sales` +
  `organic_sales` to reconstruct `total_sales`.

On **vendor** profiles the seller-only columns disappear and are replaced by
`shipped_revenue` / `shipped_units` / `shipped_cogs`, `acogs` (spend ÷ shipped_cogs) and
`shipped_tacos`. B2B columns (`total_sales_b2b`, `ordered_revenue_b2b`, `shipped_revenue_b2b`)
are a **subset** of their parent column, never an addition to it.

**The one real gap is margin.** `profit`, `cogs`, and `profit_margin` exist only when profit
tracking is enabled on the profile, and they never break out FBM against FBA fees.

### Search query (SQP) grid — column structure

The SQP grid is built on a **paired** column model: for every funnel step there is an
`asin_*` column (our share) beside a `total_*` column (the whole market for that query).

| Funnel step | Ours | Market |
|---|---|---|
| Impressions | `asin_impression_count`, `asin_impression_share` | `total_query_impression_count` |
| Clicks | `asin_click_count`, `asin_click_share`, `asin_ctr` | `total_click_count`, `total_click_rate`, `total_ctr` |
| Cart adds | `asin_cart_add_count`, `asin_cart_add_share` | `total_cart_add_count`, `total_cart_add_rate` |
| Purchases | `asin_purchase_count`, `asin_purchase_share`, `asin_conversion_rate` | `total_purchase_count`, `total_purchase_rate`, `total_conversion_rate` |
| Price | `asin_median_click_price`, `asin_median_cart_add_price`, `asin_median_purchase_price` | `total_median_*` equivalents |

Plus `search_query`, `search_query_volume`, `search_query_score`, `asin`, `parent_asin`, `brand`,
`title`, `existing_targets`, and shipping-speed splits
(`total_{same,one,two}_day_shipping_{click,cart_add,purchase}_count`).

Because both sides are present, **CTR and CVR gaps against the market are free** — no join, no
second source. `existing_targets` closes the loop by telling you, per query, whether you already
target it. Full treatment in `07-sqp-ngrams-negatives.md`.

---

## 3. Filter UI semantics

The campaign filter schema has **54 filter keys**. The shape is uniform across entities, which
is what makes the filter UI learnable.

### Filter grammar

```json
{"key": "ACOS",
 "conditions": [{"operator": ">", "values": ["30"]}],
 "logical_operator": "AND"}
```

- Keys are **uppercase**; column names in results are lowercase. Two casings for one concept.
- Multiple conditions on the same key combine with an explicit `logical_operator` (`AND` / `OR`).
- `values` is **always an array**, even for a single scalar.

### Filter types and their operators

| Type | Operators | Example keys |
|---|---|---|
| date | `>=`, `<=` (exactly two conditions) | `DATE`, `COMPARE_DATE`, `CAMPAIGN_START_DATE`, `CAMPAIGN_END_DATE`, `CAMPAIGN_LAST_OPTIMIZED_AT` |
| metric | `>`, `<`, `>=`, `<=`, `=` | `IMPRESSIONS`, `CLICKS`, `SPEND`, `SALES`, `ORDERS`, `UNITS`, `ACOS`, `ROAS`, `CTR`, `CVR`, `CPC`, `RPC`, `CPA`, `AOV`, `ACTC`, `CPM`, `BUDGET`, `SAME_SKU_ORDERS`, `SAME_SKU_SALES`, `OTHER_SKU_SALES` |
| select | `=`, `<>`, `IN`, `NOT_IN` | `CAMPAIGN_STATE`, `CAMPAIGN_AD_TYPE`, `TARGETING_TYPE`, `BID_STRATEGY`, `COST_TYPE`, `CREATIVE_TYPE`, `BIDDING_METHOD`, `PORTFOLIO_ID`, `CAMPAIGN_GROUP`, `DAYPARTING_SCHEDULE`, `CAMPAIGN_DATA_GROUP_ITEM` |
| string | `LIKE`, `NOT_LIKE`, `=`, `<>` | `CAMPAIGN_NAME`, `CAMPAIGN_NAME_NOT`, `PORTFOLIO_NAME`, `CAMPAIGN_GROUP_NAME`, `CAMPAIGN_GROUP_NAME_NOT` |

### Five filter ideas worth stealing outright

1. **Delta filters as first-class keys.** `DELTA_PERCENT` and `DELTA_ABSOLUTE` take the metric
   name as the *first condition* and the threshold as the rest:
   `{"key":"DELTA_PERCENT","conditions":[{"values":["ACOS"]},{"operator":">","values":["10"]}]}`
   — "show me everything whose ACOS got more than 10% worse". One key covers every metric.
2. **Ratio filters that encode intent.** `ACOS_TO_TARGET` is ACOS ÷ target ACOS, so `>= 1.1`
   means "10% above target" regardless of which profile you are on and what its target is.
   `DAILY_SPEND_TO_BUDGET` is a decimal fraction, so `> 0.8` finds budget-capped campaigns.
   These are portable across profiles in a way that absolute thresholds never are.
3. **Explicit negative twins.** `CAMPAIGN_NAME_NOT`, `CAMPAIGN_ID_NOT`,
   `CAMPAIGN_GROUP_NAME_NOT`, `CAMPAIGN_ID_ONLY`. Exclusion is a separate key rather than a
   modifier, which removes the classic "does NOT_LIKE apply before or after the OR" ambiguity.
4. **Reference-valued filters.** `CAMPAIGN_ID`, `PORTFOLIO_ID`, `CONTAINS_ASINS`,
   `CONTAINS_SKUS` accept either an array of IDs **or a single reference URI from a previous
   query**. That is set algebra between grids: filter the product grid, feed the result straight
   into the campaign grid as "campaigns containing these ASINs".
5. **Structural counts as filters.** `CAMPAIGN_TOTAL_TARGETS` and `CAMPAIGN_TOTAL_PRODUCTS`
   let you find "campaigns with more than 100 targets" or "single-ASIN campaigns" without
   opening the child grid.

### Default view

`MCP`, verbatim: "When the user has not specified which entities to show (beyond the date range),
apply these filters to match the AdLabs UI default view: `CAMPAIGN_STATE = ENABLED`."

So the grid defaults to enabled-only. Related and important: **the campaign entity returns only
ENABLED and PAUSED, never ARCHIVED.** Archived spend is invisible on this path. A month-total
built here will not reconcile against Amazon if anything was archived mid-period.

---

## 4. Group-by behavior

A dedicated `group_by_column` operation, separate from filtering and separate from SQL.

The rule that justifies its existence, `MCP` verbatim: *"Do not use GROUP BY in query. Use
group_by_column — it correctly recalculates derived metrics (ACOS, ROAS, CTR, CVR, CPC, RPC,
CPA, CPM, AOV, ACTC)."*

That is the whole point. A naive `GROUP BY` averages the derived metrics and produces an ACOS
that is the mean of ACOSes rather than total spend ÷ total sales. AdLabs made the correct path
the only path by refusing aggregation in the query layer.

**Clone this exactly.** Ratio metrics must be recomputed from summed numerators and
denominators at every aggregation level in wizard-ads — grid group-by, dashboard widgets,
exports, and the n-gram roll-up alike. It is the single most common source of quietly wrong
numbers in ads tooling.

The same recalculation is applied by the n-gram tool: "Derived metrics (CTR, ACOS, ROAS, etc.)
are recalculated correctly from summed base metrics, not naively averaged."

---

## 5. Saved views and column presets

`VID`, from AdLabs' own walkthrough:

- Columns are **drag-and-drop reorderable**.
- Column widths are drag-resizable; **double-clicking the vertical separator auto-fits** the
  column to its content.
- A **vertical pin line** divides the grid. Drag a column to the left of it and it pins there.
- A column picker at the bottom of the grid adds fields (their example: adding Optimization
  Groups as a visible column).
- **Layout persists automatically per user.** Verbatim: "we're going to be saving these
  settings ... the next time you log in and run some optimizations, it's all kind of saved
  where it last left off."

Note what this is *not*: it is a single implicit remembered layout, not named saved views. No
evidence of multiple named view presets, per-view filter sets, or sharing a view with a
teammate was found on any evidence path.

- **Clone:** auto-persisted layout, drag-reorder, pin line, double-click auto-fit.
- **Beat:** named, shareable saved views that bundle *columns + filters + date range* together.
  For an agency running one weekly routine across 15 profiles, "my Monday pacing view" being a
  thing you can name, share with a teammate, and apply to any profile is worth more than any
  single column. Their goto-link feature (see `10-goto-links.md`) is halfway to this already —
  it shares a *result*, where what an operator wants to share is a *lens*.

---

## 6. Rendering and scale

`VID`, verbatim and unambiguous: *"everything is loaded. There's no pagination, so you don't
have to scroll through a thousand pages that are only showing you the first 100 results. All
4,000 are here. You can scroll down, it's infinite scroll and it'll all be there. And even when
you sort this table in any way you want, it's going to be real quick."*

Confirmed by the API shape: references hold whole result sets (n-gram input capped at 50,000
rows; preview tables routinely 4,000–12,000 rows) and sorting/filtering happens client-side
against the loaded set.

**Clone.** Full-set client-side grid with virtualized infinite scroll, sized for ~50k rows. This
is not a nicety. QA-ing an optimization means sorting 4,000 rows by spend, filtering to one
change reason, and scanning — a server-paginated grid makes that workflow physically impossible,
which is why every bulksheet-based competitor loses here.

---

## 7. Export

- CSV export off any reference (`download_data`) — the entire result set, not the visible page.
- Because export takes a *reference*, an export inherits whatever filtering, computed columns,
  or group-by produced that reference. Export is not a separate "download this table" action
  bolted onto the grid; it is a terminal operation on the same pipeline. Clone that.

---

## 8. Verdicts

**Clone.**
- The four-column metric model (value / comparison / delta absolute / delta percent) with an
  automatic preceding-period default.
- `group_by_column` as the only aggregation path, with derived metrics always recomputed from
  summed bases.
- `rpc_category` stored on every target row, so bid classification is a filter, not a workflow.
- Current / recommended / driver as adjacent columns (`percentage`, `placement_recommendation`,
  `cvr_lift`).
- `harvested_targets` and `existing_targets` — "have I already acted on this row".
- Reference-valued filters (`CONTAINS_ASINS` taking a result set), delta filters, and
  target-relative ratio filters (`ACOS_TO_TARGET`, `DAILY_SPEND_TO_BUDGET`).
- Full-set infinite scroll with auto-persisted column layout.
- `_raw` twins: display value and Amazon enum in the same row.
- Export as a terminal operation on a reference.

**Skip.**
- DSP grids (v0 scope).
- The `product` / `advertised_product` split as *named*. We need both views; we should not ship
  two nouns three characters apart. Name them by what they answer.
- The 30-day trend columns as always-on. Useful, but they are a second date context living
  inside a grid that already has one; make them an explicit toggle.

**Beat.**
- **One casing, one name.** `match_types` vs `match_type`, uppercase filter keys vs lowercase
  columns, `profile_id` meaning two different numbers. Every one of these is documented in
  AdLabs' own docs as a warning to the caller, which is the clearest possible signal that the
  model leaked.
- **Archived is not optional.** The campaign grid cannot see ARCHIVED at all, so any period
  total silently excludes archived spend. We should include archived with an explicit filter and
  state the exclusion on the face of the grid when it is applied, so a reconciliation gap is
  visible rather than discovered.
- **Aggregate/row disagreement must be visible.** 301 rows, 260 in the aggregate, with the
  reason (`SITE_AMAZON_BUSINESS`) only in a footnote. When we drop rows from a total, say so in
  the total.
- **Per-target top-of-search impression share.** AdLabs removed it on 2026-07-28 with no
  replacement. It is the column you need to answer "am I actually winning the placement I am
  paying a modifier for". We can have it.
- **Named, shareable, cross-profile saved views.** Their layout memory is per-user and implicit.
  Ours should be an object: columns + filters + date range, named, shared, and applicable to any
  profile.
