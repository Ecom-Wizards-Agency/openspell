---
name: wizardads-falling-sales
description: Diagnose why Amazon Ads attributed sales fell in a connected wizard-ads profile using a fixed-order, read-only funnel decomposition from data freshness through impressions, CTR, clicks, CVR, AOV, campaign mix, targets, search terms, placements, flags, pacing, and recommendations. Use when attributed ad sales, orders, or units declined or an operator asks which paid-media drivers caused a sales drop.
---

# WizardAds Falling Sales

Explain a decline in Amazon Ads attributed sales without changing the account. This skill cannot diagnose total Amazon revenue, organic demand, stock, Buy Box ownership, listing suppression, or retail price directly; name those as follow-up gaps when the ad data points outside the observable surface.

## Required MCP tools

- `list_profiles` — resolve the profile and runtime goals.
- `get_sync_status` — rule out incomplete or failed data first.
- `get_entity_data` — compare equal periods through the funnel.
- `query` — locate the completed days on which the loss occurred.
- `group_by` — measure channel, match-type, search-term, and placement mix.
- `get_flags` — read active and suppressed doctrine-engine findings.
- `get_pacing` — identify underpacing or budget context.
- `get_recommendations` — surface existing proposals and their evidence.
- `create_goto_link` — link the operator to detailed loss-contributor views.

## Rules

- Stay read-only and use only profile IDs returned by `list_profiles`.
- Use completed, equal-length windows in the profile timezone. Default to the most recent completed 7 days versus the preceding 7 days.
- Use runtime profile strategy; do not embed universal thresholds.
- Call the metric “attributed ad sales,” never total sales or organic sales.
- Sum base metrics and recompute ratios. Never add percentage deltas or average ratios.
- Treat absent rows as unknown and expose truncated or partial coverage.
- Rank loss contributors by absolute attributed-sales change, not by the lowest current sales.

## Fixed-order diagnostic

### 0. Prove the decline is not a data artifact

Call `get_sync_status`. Confirm both windows are covered, relevant reports succeeded, and rows parsed equal rows loaded. Shift away from provisional days when possible. Stop if freshness or load integrity can explain the apparent decline.

### 1. Confirm the size and shape of the loss

Call `get_entity_data` at `profile` level with `compare: true` for impressions, clicks, spend, sales, orders, units, CTR, CVR, CPC, AOV, RPC, ACOS, and ROAS.

Confirm attributed sales fell. Determine whether orders, AOV, or both fell, and whether spend moved in the same direction. If attributed sales did not fall, report the observed metric change and stop this diagnostic.

### 2. Decompose the funnel

Use these identities:

- clicks = impressions × CTR
- attributed sales = clicks × CVR × AOV

Inspect in this order:

1. impressions — available ad opportunity and visibility;
2. CTR — ability to turn impressions into visits;
3. clicks — the combined traffic result;
4. CVR — ability to turn ad clicks into attributed orders;
5. AOV — attributed revenue per order.

Combine changes as multipliers. Separate a smaller traffic pool from weaker account capture. Impressions are not a direct market-demand measure, so label demand conclusions as hypotheses.

### 3. Locate the timing

Use `query` at `profile` level for daily impressions, clicks, spend, sales, orders, CTR, CVR, and AOV. Determine whether the decline is sustained, concentrated on one or more completed days, or caused by the comparison base.

### 4. Find the campaign and channel losses

Use `group_by` at `campaign` level by `ad_product` for each period. Then call `get_entity_data` on `campaign` with `compare: true` and sort by absolute attributed-sales delta.

For each material contributor, classify the evidence as:

- visibility loss: impressions fell;
- engagement loss: CTR fell;
- traffic/cost constraint: clicks fell alongside spend or CPC movement;
- conversion loss: clicks held but CVR fell;
- basket loss: orders held better than sales because AOV fell;
- mix shift: traffic moved between channels or campaigns with different economics.

Do not attribute the result to inventory, Buy Box, pricing, indexing, or listing changes without evidence outside this MCP surface.

### 5. Trace targets and shopper queries

For the campaigns responsible:

1. Compare `keyword` rows by attributed-sales delta.
2. Compare `target` rows separately.
3. Use `group_by` on `search_term` to show which customer queries lost clicks, orders, or sales.
4. Use `group_by` on `placement` to test whether delivery moved between placements.

Treat a missing entity as ambiguous until sync status is sound. Never infer that a target was paused merely because it disappeared from a report.

### 6. Check operational context

Call `get_flags`, `get_pacing`, and `get_recommendations`.

- Report underpacing or other pacing context without inventing a budget when none exists.
- Use active flags as doctrine-aware corroboration.
- Keep suppressed flags separate and preserve their supplied explanation.
- Cite current proposals and provenance; do not turn them into executed actions.

### 7. State what the data cannot decide

When traffic or CVR falls without an ad-side cause, list the narrow external checks needed: stock availability, Buy Box/featured offer, listing eligibility, price or promotion changes, retail sessions, and market demand. Present these as unresolved hypotheses, not findings.

For large contributor tables, call `create_goto_link` for `/grid`, `/search-terms`, or `/recommendations` with the matching profile, dates, filters, and sort.

## Output

Return a concise diagnostic with these headings:

1. **Verdict** — the dominant observable cause and magnitude.
2. **Data confidence** — freshness, final date, and coverage qualifications.
3. **Funnel decomposition** — impressions → CTR → clicks → CVR → orders → AOV → attributed sales.
4. **Loss contributors** — channel, campaign, keyword/target, search-term, and placement evidence.
5. **Strategy context** — flags, suppressed flags, pacing, and recommendations.
6. **Unresolved hypotheses** — only checks the MCP evidence cannot decide.
7. **Operator review** — GoTo links and proposed next investigations; no executed changes.

End with both comparison windows and: “Read-only diagnostic: no account changes were made.”
