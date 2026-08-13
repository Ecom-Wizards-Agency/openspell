# 08 — Automations, dayparting, budget tools, AMC

**WP-11 recon · read-only.** No automation was created, paused, or deleted. No dayparting
schedule was created or assigned. No AMC workflow was executed. Live reads made:
`get_entity_data(entity_type="automation")` and `get_entity_data(entity_type="dayparting_schedule")`.
No UI seen — see `BLOCKED.md`.

---

## 1. Automations

### What exists

`MCP`, verbatim: *"Automations are bid rules and scheduling rules — each row represents one
rule."*

Row shape:

```
id  name  status  entity_type  profiles  action_count  created_by  last_triggered_at
```

| Column | Notes |
|---|---|
| `status` | `ON` / `PAUSED` / `DELETED` — `DELETED` is a **status, not a removal**, so deleted rules are still fetchable |
| `entity_type` | What the rule acts on |
| `profiles` | **Plural.** A single rule spans multiple profiles |
| `action_count` | How many actions the rule performs — so a rule is a container of actions, not a single action |
| `created_by` | Attribution |
| `last_triggered_at` | Last fire time |

**Automations are team-scoped, not profile-scoped** — `get_entity_data(entity_type="automation")`
takes `team_id` and no `profile_id`. Combined with the plural `profiles` column, this is the one
place in the entire product where an object natively spans profiles. Everything else (grids,
dashboards' underlying queries, optimizer runs, campaign maps, dayparting) is single-profile.

That is a strong signal about where their own architecture was heading and it is worth copying
deliberately rather than by accident: **rules are cross-profile objects.**

### The linkage back to entities

`has_opt_rule` is a boolean column on the **campaign, target, and placement** grids. So from any
row you can see whether an automation governs it, and you can filter for governed vs ungoverned
entities. That is the right way to expose automation: not as a separate world, but as a property
of the thing being automated.

### What the MCP surface can do with them

Exactly one write: `update_entities(entity_type="automation", action="update_status", status, reference, note)`
— set `ON` / `PAUSED` / `DELETED` over a reference of automation rows, with a mandatory note.

**Creation and rule-body editing are UI-only.** There is no create action, no condition schema,
no action schema anywhere in the MCP contract. So the rule *definition* language — what
conditions a rule can test, what actions it can take, what schedule it runs on — is not
documented on any evidence path available to this recon, and the UI walkthrough that would have
captured it did not run.

**This is the largest genuine hole in this recon.** Recorded as such rather than guessed at. See
`00-INDEX.md` §coverage.

### Live state

`get_entity_data(entity_type="automation", team_id=<team>)` returned **"No automations found"**
on the operator's team. So this is a feature the operator's own agency does not currently use —
which is itself a finding worth carrying into the product decision. The weekly management loop
is run as attended preview-and-approve, not as unattended rules.

---

## 2. Alerts

**No alerting capability was found on any evidence path.** No alert entity, no notification
action, no threshold-breach object, no delivery channel (email, Slack, webhook), nothing in the
changelog, nothing in the resource index.

The nearest adjacent things, and they are not alerts:

- `analyze(audit_summary)` — a **pull** scorecard you run, covering budget-capped campaigns, bid
  category distribution, placement modifier accuracy, and spend distribution.
- Automations — rules that *act* rather than notify.
- Filters like `DAILY_SPEND_TO_BUDGET > 0.8` or `ACOS_TO_TARGET >= 1.1` — the conditions an alert
  would test, available as filters you have to run yourself.

**Beat, and it is a clean gap.** Every ingredient for alerting already exists in their model:
target-relative ratio filters that are portable across profiles, a team-scoped rule object that
already spans profiles, and a job log with a `note` field. What is missing is the delivery half.
"Every profile where `ACOS_TO_TARGET >= 1.3` or `DAILY_SPEND_TO_BUDGET >= 0.95`, every Monday, to
Slack" is the agency's actual morning question, and answering it today means running a report per
profile.

Note also that our own operating context already solves this outside the tool with a scheduled
daily brief posted to Slack, cross-checked against a second source. That is direct evidence of
the gap being real: when a tool has no alerting, agencies build it around the tool.

---

## 3. Dayparting

### Shape

`get_entity_data(entity_type="dayparting_schedule", team_id, profile_id)` returns **two**
references:

**Reference 1 — schedule summary**, one row per schedule:

```
schedule_id  name  state  created_by
assigned_campaign_count  assigned_campaign_ids
created_at  updated_at
```

**Reference 2 — bid grid**, one row per schedule × day × hour, **168 rows per schedule**:

```
schedule_id  schedule_name  day (MON..SUN)  hour (0-23)  change_pct
```

`change_pct` is a bid adjustment percentage: `78` = +78%, `-50` = -50%, `0` = no change.

### Model observations

- **A dayparting schedule is a named, reusable object**, not a per-campaign setting. One schedule
  is assigned to many campaigns (`assigned_campaign_count`, `assigned_campaign_ids`).
- **Assignment is by campaign ID**, via `update_entities(entity_type="campaign",
  action="assign_dayparting_schedule", schedule_id, reference)`. Not by tag — same "tags classify
  but nothing acts on the classification" gap noted in `06-tags.md`.
- **The campaign grid carries `dayparting_schedule_id`, `dayparting_schedule_name`, and
  `dayparting_schedule_state`** as columns, and `DAYPARTING_SCHEDULE` is a select filter. So
  schedule membership is visible and filterable from the campaign grid, exactly like
  `has_opt_rule`. Consistent, and right.
- **Returning the grid as a flat 168-row table per schedule** rather than a nested structure is
  the correct choice: it makes the grid queryable (`WHERE day='MON' AND change_pct > 0`),
  diffable between schedules, and trivially chart-able as a heatmap.

Live read: **one schedule on the profile inspected**, so this is a feature in light use.

### The interaction with bid optimization

Not documented anywhere on the evidence path, and it matters: dayparting applies a percentage on
top of a bid, and the optimizer recalculates that bid from performance data which was itself
collected under the dayparting modifier. Whether the optimizer's smart bid ceilings account for
the dayparting multiplier is unknown from this recon. This is a real question for our own design
and a specific thing to check if a UI session becomes available.

---

## 4. Budget tools

There is no dedicated budget *tool* — budget is handled as columns, filters, and one audit
section.

| Surface | Detail |
|---|---|
| `budget_amount` | Column on the campaign and placement grids: daily campaign budget |
| `campaign_budget_amount` | The same value carried down onto **target** rows, so a target's context includes its campaign's budget |
| `BUDGET` filter | Metric filter, e.g. `< 10` to find under-funded campaigns |
| `DAILY_SPEND_TO_BUDGET` filter | **Decimal fraction** of budget consumed, e.g. `> 0.8` finds campaigns near their cap. Portable across profiles and currencies |
| `avg_daily_spend_30d`, `spend_trend_pct_30d` | Run-rate context beside the selected period, on every metric grid |
| `analyze(audit_summary)` → budget utilization | "campaigns hitting daily budget caps" as one section of the scorecard |
| `off_amazon_budget_control_strategy` | Campaign column; off-Amazon budget control |
| `is_ended` | Computed: `end_date` before today in **profile timezone**. Ended campaigns **cannot receive budget or bid updates** even when `campaign_state='Enabled'` |

`update_entities(entity_type="campaign")` exposes budget writes (action docs at
`adlabs://docs/actions/campaign`; not read during this recon since no campaign write was in
scope).

### What is absent

- **No budget pacing object.** No monthly budget, no month-to-date pacing, no projected
  end-of-month spend, no portfolio budget cap. `DAILY_SPEND_TO_BUDGET` answers "am I capped
  today", never "am I on pace for the month".
- **No budget scheduling.** Dayparting adjusts bids, not budgets. No "raise budgets for Prime
  Day" object.
- **No cross-profile budget view**, despite the agency shape being N profiles with a combined
  monthly commitment.

**Beat.** A run-rate pacing governor — month-to-date spend vs plan, projected landing, and the
implied daily allowance — is the control an agency actually manages to, and it is entirely
absent. Every input exists (`avg_daily_spend_30d`, `spend_trend_pct_30d`, `budget_amount`,
`DAILY_SPEND_TO_BUDGET`, profile-level totals). Pairing that with alerting (§2) covers most of
what the operator currently does by hand each morning.

---

## 5. AMC (Amazon Marketing Cloud)

Added 2026-07-30, **PRO plan only**.

### Capabilities

| Area | Actions |
|---|---|
| Runs | `create_workflow_execution` (pass `library_query_id` **XOR** `sql`), `list_workflow_executions` (scope to a schedule via `workflow_id`, omit for ad-hoc), `update_workflow_execution` (rename) |
| Library | `list_library_queries` — user-facing IDs **Q1a–Q8**; `list_data_sources` |
| Schedules | create / list / update / delete |
| Results | fetch results, get download URLs |
| Audiences | browse audience library, list / create / delete AMC audiences, `preview_audience_sql`, fetch audience SQL |
| Entity | `amc_execution` is a fetchable `get_entity_data` type with its own filter schema |

Date ranges accept a **named preset** as an alternative to `lookback_days` or explicit
`start_date` + `end_date`. Custom SQL can be validated at Amazon **without creating anything**
via `dry_run=true`.

`dry_run` on a query-authoring surface is the right primitive and we should have it: validate
against the real backend, create nothing.

### The connection-state lesson

This is the most instructive changelog entry in the whole product and it is worth quoting the
substance:

AMC must be connected **per profile** ("Profiles → Connect AMC"), and most profiles are not.
Previously, an unconnected profile produced a **successful-looking empty result** — "No AMC data
sources found for this profile" — indistinguishable from a connected instance whose catalog had
not synced. That is "easily misread as proof that the Amazon Ads account has no AMC instance at
all."

The fix, on 2026-08-04:

- Every action needing an instance now **errors**, naming the profile and how to connect it.
- Actions that work without a connection still work, "with the available column omitted and the
  reason stated."
- `get_data_sources` now distinguishes **"not connected"** from **"connected but not yet
  synced"**, naming the instance in the latter case.
- **`is_amc_connected` became a column on the profiles entity**, so eligibility is visible without
  attempting a call.
- And the principle, stated outright: *"A missing connection is a statement about AdLabs only and
  never evidence about the Amazon account."*

**Clone all five of those, as a general rule, not just for AMC.** Empty-because-not-connected must
never render as empty-because-no-data; connection state belongs as a column on the profile; and
the distinction between "we are not connected", "we are connected but stale", and "there is
genuinely nothing" must survive all the way to the UI. Every integration we build — SP-API,
Ads API, AMC — inherits this rule.

The same principle applies to the sync clock: the profile resource exposes `Sync status` and
`Last synced` (UTC), and the known behavior that same-day totals read zero while a day is in
progress means a stale sync silently produces a wrong answer that looks right.

---

## 6. Verdicts

**Clone.**
- Automations as **team-scoped objects spanning multiple profiles**, with `action_count`,
  `created_by`, and `last_triggered_at`.
- `has_opt_rule` as a boolean column on campaign / target / placement, so automation coverage is
  filterable from the grid rather than a separate world.
- `DELETED` as a status rather than a removal, so rule history survives.
- Dayparting as a **named reusable schedule** assigned to many campaigns, with membership visible
  and filterable from the campaign grid.
- The flat 168-row bid grid (schedule × day × hour × `change_pct`) — queryable, diffable,
  heatmap-able.
- `DAILY_SPEND_TO_BUDGET` as a decimal fraction and `ACOS_TO_TARGET` as a multiplier: thresholds
  that are portable across profiles and currencies.
- 30-day run-rate columns sitting beside period metrics on every grid.
- `is_ended` as a computed write-path gate in **profile timezone**.
- AMC `dry_run=true` — validate at the backend, create nothing.
- The whole AMC connection-state doctrine (§5). Errors that name the profile and the fix;
  connected-vs-synced distinguished; `is_amc_connected` as a profile column; and never letting an
  unconnected integration render as an empty result.

**Skip.**
- Automation rule definition being UI-only with no API surface. If a rule can exist, it is
  expressible in the API on day one.
- Budget as scattered columns and filters with no object behind it.
- PRO-gating a data capability (AMC) rather than gating seats or volume.

**Beat.**
1. **Alerting, which does not exist at all.** Every ingredient is already there — portable
   ratio filters, a cross-profile rule object, a job log with notes. What is missing is delivery.
   Threshold alerts across all profiles, to Slack/email, on a schedule, with the breaching rows
   attached. This is the clearest single product gap found in the whole recon.
2. **A run-rate pacing governor.** Month-to-date vs plan, projected landing, implied daily
   allowance, per profile and rolled up. Budget today answers "capped now", never "on pace".
3. **Cross-profile everything.** Automations prove they can build objects that span profiles.
   Nothing else does. Grids, dashboards, optimizer runs, campaign maps, and dayparting are all
   single-profile, and the agency job is fifteen profiles.
4. **Tag-driven assignment** for dayparting schedules and automations, not ID lists.
5. **Document the dayparting × optimizer interaction.** Bids are recalculated from performance
   collected under a dayparting modifier. Whether smart bid ceilings account for it is unknown
   from this recon and must not be unknown in ours.
6. **Budget scheduling as a first-class object** — a deal-event plan that raises budgets and
   ceilings for a window and reverts automatically, with the revert in the job log.
