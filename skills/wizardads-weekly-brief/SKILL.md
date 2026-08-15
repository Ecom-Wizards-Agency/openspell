---
name: wizardads-weekly-brief
description: Create a structured, read-only weekly Amazon PPC performance brief from the wizard-ads MCP server, covering completed-week results, week-over-week drivers, goal-aware flags, budget pacing, current recommendations, data confidence, and operator links. Use for weekly ads reviews, recurring PPC briefings, week-over-week account summaries, or Monday performance updates for a connected profile.
---

# WizardAds Weekly Brief

Produce one evidence-led brief per connected profile. Report what happened, why it moved, and what the operator should review without changing the account.

## Required MCP tools

- `list_profiles` — resolve profiles, currencies, timezones, and runtime goals.
- `get_sync_status` — anchor the brief on complete data.
- `get_entity_data` — compare the completed week with the prior week.
- `query` — inspect daily shape when the weekly total needs explanation.
- `group_by` — summarize channel, search-term, and placement mix.
- `get_flags` — report active and suppressed goal-aware findings.
- `get_pacing` — report month-to-date budget pacing.
- `get_recommendations` — present current explainable proposals.
- `create_goto_link` — link detailed evidence and proposal views.

## Rules

- Stay read-only. Every action is a proposal for human review.
- Resolve profile IDs with `list_profiles`; never guess them.
- Anchor on the latest seven fully completed profile-local days and compare with the immediately preceding seven days unless the user supplies two equal windows.
- Use the returned target, goal lens, currency, timezone, and monthly budget. Never supply private or universal thresholds.
- Call `sales` attributed ad sales. Do not infer total revenue, organic sales, TACOS, profit, or margin.
- Sum base metrics and recompute ratios. Never average ratios across entities or days.
- Show missing, provisional, suppressed, partial, and truncated data explicitly.
- Do not fabricate a test, recommendation, or positive finding to fill a section.

## Workflow

### 1. Resolve profiles and weeks

Call `list_profiles`. If the user requests all visible profiles, create separate profile sections and never combine currencies. Otherwise resolve one unambiguous profile.

Call `get_sync_status` for each selected profile. Choose a week end supported by completed facts, not the in-progress current day. State current and prior windows.

If required reports failed, parsed and loaded row counts differ, or the week is not covered, report the profile as blocked rather than filling it with zeros. Continue other profiles independently.

### 2. Build the scorecard

Call `get_entity_data` at `profile` level with `compare: true` for impressions, clicks, spend, sales, orders, units, CTR, CVR, CPC, CPA, ACOS, ROAS, RPC, and AOV.

Explain the week through base movements first. Use `query` for daily profile rows only when the weekly comparison is dominated by one or two dates or the latest completed date needs validation.

### 3. Explain the drivers

Use `group_by` at `campaign` level by `ad_product` for the completed week and prior week. Then call `get_entity_data` on `campaign` with `compare: true` and sort by absolute spend and attributed-sales deltas.

Drill into `keyword` and `target` only for the campaigns that explain the movement. Use `group_by` on `search_term` for concrete shopper-query evidence and on `placement` for campaign-level delivery mix.

Name exact entities when evidence supports them. Keep tables short and prioritize contribution over extreme low-volume ratios. Use a GoTo link for the long tail.

### 4. Add strategy and pacing

Call `get_flags` and report both lists:

- **Active** — severity, evidence, and supplied goal context.
- **Suppressed** — what was suppressed and why; never re-promote it manually.

Call `get_pacing`. State month-to-date spend, budget-to-date, projected pace, and status when returned. When no monthly budget exists, say “Pacing unavailable: no monthly budget is configured.” Preserve any returned cut-order guidance as review context, not an instruction to execute.

### 5. Add current proposals

Call `get_recommendations`. Group returned items by status and reason. For proposed items, show the entity, proposed direction, evidence, and provenance fields supplied by the engine. Do not imply that accepted or exported means applied. If no successful run exists, say so; that is not evidence that the account is clean.

### 6. Create operator links

Call `create_goto_link` for the most useful detailed views, normally:

- `/grid` for campaign, keyword, target, or placement drivers;
- `/search-terms` for query evidence;
- `/recommendations` for proposals;
- `/sync` for a freshness concern.

Include the exact profile and date/filter state in each link. Do not paste more than about ten detail rows when a link communicates the same evidence better.

## Brief contract

Return Markdown with this fixed structure:

1. `# Weekly PPC Brief — <profile> — <week end>`
2. **Scope and data confidence** — marketplace, currency, timezone, both windows, freshness, provisional status, and load checks.
3. **Executive read** — one sentence on attributed sales, one on efficiency, and one on the most important driver.
4. **Weekly scorecard** — current, prior, absolute delta, and percent delta.
5. **What changed** — channel mix and the named campaigns/entities that explain it.
6. **Shopper-query and placement signals** — evidence only; omit unsupported subsections.
7. **Flags** — active first, suppressed separately.
8. **Pacing** — returned status or the explicit unavailable note.
9. **Proposals for operator review** — engine output with provenance, never executed changes.
10. **Links and follow-ups** — GoTo links and unresolved external questions.

Use the profile currency and consistent percent formatting. If several profiles were requested, order their sections by active-flag severity and keep each currency separate. End with: “Read-only brief: no account changes were made.”
