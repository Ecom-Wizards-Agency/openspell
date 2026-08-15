---
name: wizardads-rising-acos
description: Diagnose why Amazon Ads attributed ACOS rose in a connected wizard-ads profile using a fixed-order, read-only decomposition from data freshness through CPC, conversion, mix, entities, placements, flags, pacing, and recommendations. Use when ACOS increased, efficiency deteriorated, spend rose faster than attributed sales, or an operator needs the exact campaigns and targets driving the change.
---

# WizardAds Rising ACOS

Explain a confirmed ACOS increase without changing the account. Follow the order below even when an early clue looks obvious.

## Required MCP tools

- `list_profiles` — resolve the profile and runtime target.
- `get_sync_status` — rule out freshness and load failures first.
- `get_entity_data` — compare equal periods at each entity level.
- `query` — test whether the change is sustained or date-concentrated.
- `group_by` — measure channel, match-type, and placement mix.
- `get_flags` — read active and suppressed goal-aware findings.
- `get_pacing` — identify budget-pacing context.
- `get_recommendations` — surface existing engine proposals and provenance.
- `create_goto_link` — link the operator to large driver tables.

## Rules

- Stay read-only and use only IDs returned by `list_profiles`.
- Use completed, equal-length windows in the profile timezone. Default to the most recent completed 7 days versus the preceding 7 days.
- Use the profile's runtime target and goal lens. Do not introduce fixed efficiency or volume cutoffs.
- Treat sales as attributed ad sales, not total revenue.
- Recompute ratios from summed bases and treat missing rows as unknown.
- Rank drivers by contribution to the account-level change, not by extreme ACOS alone.

## Fixed-order diagnostic

### 0. Prove the data is usable

Call `get_sync_status`. Verify the relevant facts cover both windows and parsed rows equal loaded rows. If the latest days are provisional, shift both windows back or qualify the result. Stop if the comparison cannot be made safely.

### 1. Confirm the symptom

Call `get_entity_data` at `profile` level with `compare: true` for spend, sales, clicks, orders, CPC, CVR, AOV, RPC, ACOS, and ROAS.

Confirm ACOS actually rose. If it did not, report the observed movement and stop this diagnostic. Quantify how much of the change came from spend rising, attributed sales falling, or both.

### 2. Split price, conversion, and basket effects

Use the identity `ACOS = CPC ÷ (CVR × AOV)`.

Evaluate in this order:

1. CPC movement.
2. CVR movement.
3. AOV movement.
4. Click-volume movement and its effect on spend.

Combine percentage movements multiplicatively. Do not add deltas. Label the primary driver only after comparing its contribution with the others.

### 3. Test timing and mix

Use `query` at `profile` level for daily spend, sales, clicks, CPC, CVR, and ACOS when the period result may be event-driven. Identify whether the move is broad or concentrated on particular completed days.

Use `group_by` at `campaign` level by `ad_product`, then compare current and prior channel results. A mix shift toward a higher-ACOS channel can raise account ACOS even when every channel is stable.

### 4. Locate campaign contributors

Call `get_entity_data` on `campaign` with `compare: true`. Sort and discuss campaigns by absolute spend delta and lost attributed-sales contribution. Separate:

- more clicks at a higher CPC;
- stable CPC with lower CVR or AOV;
- new or reactivated spend with limited attribution;
- lower attributed sales on similar spend;
- harmless mix changes already explained by the profile's goal lens.

Do not grade zero-spend or trivially sampled rows using a universal cutoff. Use returned flags and strategy context for materiality.

### 5. Trace the responsible traffic

For the campaigns that explain the movement:

1. Compare `keyword` rows.
2. Compare `target` rows separately.
3. Use `group_by` on `search_term` to inspect the customer queries receiving spend.
4. Use `group_by` on `placement` to determine whether placement mix or CPC moved.

Never claim keyword-by-placement causality; placement data is campaign-grain. Avoid calling a query waste solely because it has no attributed order in a thin window.

### 6. Reconcile strategy context

Call `get_flags`, `get_pacing`, and `get_recommendations`.

- Explain active flags using the entity evidence.
- Preserve suppressed flags and their reasons; do not revive them as warnings.
- State whether pacing pressure contributed to the spend mix.
- Cite existing proposals with their provenance. If none exist, say so rather than manufacturing an action.

### 7. Hand off the evidence

When the contributor table exceeds about ten rows, call `create_goto_link` for `/grid`, `/search-terms`, or `/recommendations` with the matching date and filters.

## Output

Return a concise diagnostic with these headings:

1. **Verdict** — one sentence naming the dominant driver and its magnitude.
2. **Data confidence** — freshness, final date, and any qualification.
3. **ACOS equation** — current versus prior CPC, CVR, AOV, spend, and attributed sales.
4. **Driver waterfall** — timing/mix, campaigns, traffic, and placements in fixed order.
5. **Strategy context** — active flags, suppressed flags, pacing, and current proposals.
6. **Operator review** — prioritized evidence to review, with GoTo links; no executed changes.

End with the comparison windows and: “Read-only diagnostic: no account changes were made.”
