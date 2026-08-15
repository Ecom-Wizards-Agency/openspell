---
name: wizardads-ppc-audit
description: Produce a read-only Amazon PPC account audit from the wizard-ads MCP server, with data-quality gates, period comparisons, driver analysis, runtime strategy context, recommendations, and a structured HTML report. Use for PPC audits, account health reviews, advertising efficiency reviews, or requests to identify the most important paid-media problems and opportunities in a connected profile.
---

# WizardAds PPC Audit

Audit one connected advertising profile without changing it. Build every conclusion from MCP evidence, distinguish attributed ad sales from total Amazon sales, and return a self-contained HTML report.

## Required MCP tools

- `list_profiles` — resolve the profile and its runtime goals.
- `get_sync_status` — verify report freshness and load completeness.
- `get_entity_data` — read period metrics and equal-window comparisons.
- `query` — inspect daily movement when a period total hides timing.
- `group_by` — aggregate by ad product, state, match type, or placement.
- `download_data` — export a complete evidence appendix when useful.
- `get_recommendations` — include the latest explainable proposals.
- `get_flags` — include active and suppressed doctrine-engine findings.
- `get_pacing` — assess month-to-date budget pacing.
- `create_goto_link` — hand large evidence sets to the operator in-product.

## Non-negotiable rules

- Stay read-only. Never create, edit, pause, archive, upload, or apply anything.
- Use only profile IDs returned by `list_profiles`. Never guess an ID.
- Use the profile's returned target, goal lens, currency, timezone, and budget. Never substitute universal thresholds.
- Treat `sales` as Amazon Ads attributed sales. Do not label it total account revenue or calculate TACOS.
- Exclude an incomplete current day. Prefer the latest completed day supported by freshness metadata.
- Treat absent rows as unknown, not zero. Amazon omits zero-impression rows.
- Sum base metrics, then recompute ratios. Never average ACOS, CVR, CPC, CTR, or ROAS.
- State when a response is truncated. Never describe a partial result as the whole account.
- Keep active and suppressed flags separate. A suppressed flag is context, not an action item.
- Present recommendations as proposals for human review. Do not invent a proposal when the engine returned none.

## Workflow

### 1. Resolve scope

Call `list_profiles`. If the user named a profile, match it unambiguously. If exactly one profile is visible, use it. If several remain plausible, ask for a choice before profile-scoped calls.

Use the requested date range. Otherwise audit the most recent 30 completed profile-local days against the immediately preceding equal-length period. State both windows explicitly.

### 2. Gate on data quality

Call `get_sync_status` before interpreting metrics. Check every relevant report's status, latest fact date, and rows parsed versus rows loaded.

Stop and report a blocker when the requested window is not loaded, a required load failed, or parsed and loaded counts disagree. Continue with a qualified report when data is merely provisional or a nonessential entity level is unavailable; name the limitation beside every affected finding.

### 3. Establish the account result

Call `get_entity_data` at `profile` level with `compare: true` for impressions, clicks, spend, sales, orders, units, CTR, CVR, CPC, CPA, ACOS, ROAS, RPC, and AOV.

Explain the movement through identities, using the returned values:

- spend = clicks × CPC
- attributed sales = clicks × CVR × AOV
- ACOS = CPC ÷ (CVR × AOV)

Combine changes as multipliers, not by adding percentage deltas. Separate numerator growth from denominator weakness.

### 4. Find the drivers

Work from broad to narrow:

1. Use `group_by` on `campaign` by `ad_product` to show channel mix.
2. Use `get_entity_data` on `campaign` with `compare: true`. Rank contributors by absolute change in spend and sales, not by the most extreme ratio on tiny volume.
3. Use `get_entity_data` on `keyword` and `target` with `compare: true` for the campaigns that explain the result. Keep keyword and product-target findings distinct.
4. Use `group_by` on `search_term` to identify converting demand and spend without attributed orders. Describe candidates for review; do not prescribe negatives from a universal spend cutoff.
5. Use `group_by` on `placement` to compare top of search, rest of search, product pages, off-Amazon, and other placement where present. Treat placement as campaign-level evidence, never keyword-level proof.
6. Use `query` at `profile` level only when daily rows are needed to distinguish a sustained move from a few unusual days.

For product-level evidence, quote the response's excluded multi-ASIN ad-group spend. Do not present the visible ASIN rows as complete attribution when coverage is partial.

### 5. Add engine context

Call `get_flags`, `get_pacing`, and `get_recommendations` for the same profile. Use the runtime strategy embodied in their outputs rather than recreating private decision rules.

- Explain each active flag with corroborating metrics.
- List suppressed flags separately with the supplied reason.
- If no monthly budget is configured, say pacing is unavailable.
- Preserve recommendation provenance and status. Separate proposed from accepted, dismissed, exported, or applied items.

### 6. Verify completeness

Reconcile the profile total against campaign aggregates for the same window. Explain any mismatch before grading the account. Do not sum campaign, target, search-term, placement, and product totals together; they are overlapping views of the same traffic.

When an evidence table is too large for the report, call `create_goto_link` with the closest supported route and the exact profile, entity, date, filter, and sort state. Use `download_data` only when a full CSV appendix adds value, and verify `rowsWritten` equals `rowsOffered` and `truncated` is false before calling it complete.

## HTML report contract

Return one accessible, self-contained HTML document with escaped account-derived text and no remote scripts. Use semantic headings and tables. Include these sections in order:

1. **Title and scope** — profile, marketplace, currency, timezone, current window, comparison window.
2. **Data confidence** — sync status, latest fact date, provisional status, row-count checks, coverage limits.
3. **Executive diagnosis** — three to five evidence-backed conclusions, highest impact first.
4. **Performance scorecard** — current, prior, absolute delta, and percent delta for the headline metrics.
5. **What drove the result** — ad product, campaign, keyword/target, search-term, and placement evidence.
6. **Flags and pacing** — active flags, suppressed flags, and month-to-date pacing.
7. **Proposals for review** — current engine recommendations with provenance; explicitly state when none exist.
8. **Evidence links and exports** — GoTo links and any verified CSV appendix.
9. **Method notes** — attributed-sales scope, ratio recomputation, missing-row semantics, attribution lag, archived-spend inclusion, and product attribution limits.

Use the profile currency for money and label percentages consistently. Never hide a missing value by rendering it as zero. End with: “Read-only audit: no account changes were made.”
