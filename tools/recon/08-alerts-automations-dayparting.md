# 08 — Automations, dayparting, budget tools, AMC

**WP-11 recon · read-only.** No automation was created, paused, or deleted. No dayparting
schedule was created or assigned. No AMC workflow was executed. Live reads made:
`get_entity_data(entity_type="automation")` and `get_entity_data(entity_type="dayparting_schedule")`.

> **Session 3 — this file's largest hole is now closed.** The automation rule builder was opened
> in the live UI and walked to the final step of both wizards; **both were cancelled without
> saving** and the automations grid remained empty throughout. §1 and §2 below are rewritten from
> what was actually on screen and are tagged `UI-verified`. §3–§5 are unchanged (still `MCP`).
>
> **The single biggest correction in the whole recon is in §2: alerting DOES exist.**

---

## 1. Automations — `UI-verified`

### Where it lives

**`https://dashboard.adlabs.app/automations`** — org-scoped (no profile in scope), and
**absent from the navigation and from ⌘K search**. It is reachable only by typing the URL or by
following the in-page "Bid Optimizer" link from elsewhere. Two prior recon sessions and the MCP
contract all failed to locate it for this reason.

Screenshot: `screenshots/01-automations-list.jpg`.

### The list screen

Header strip: `Team time: <weekday> <time>` · `Next sync in <h>h <m>m` ·
*"Automations run on scheduled days after data sync finishes — team timezone decides which day."*
plus a **`Change Team Timezone`** button.

A dismissible info callout, verbatim and worth keeping:

> **Automating Bids** — AdLabs recommends using the **Bid Optimizer** for regular bid
> optimizations. Automations apply fixed rules without considering the full picture, which often
> leads to suboptimal results. Use them only for specific, rule-based tasks.

That is the vendor telling you their own rules engine is the worse tool. Note it: they built a
rules engine and then argue against using it for the main job.

Two create buttons — **`+ New Alert`** and **`+ New Automated Action`** — so there are **two
automation kinds**, not one.

Grid columns (`UI-verified`, left to right):

```
☐  Name  Status  Type  Entity Type  Trigger Conditions  Actions
   Cooldown  Frequency  Trigger Time  Last Triggered
```

Grouped by **Profiles** by default (a group-by chip, removable), with a name search box, the
standard **Filters** button, CSV download and a **Columns** panel. Empty state: *"No Rows to
Show"*.

`Trigger Conditions` and `Actions` being **columns** is the right call — the rule body is legible
from the list without opening anything.

### The builder — a three-step wizard

Both kinds share one wizard. The left rail shows the three steps as cards that **fill in with
summary chips as you complete them** (e.g. `<profile>` `Last 30d` `Monday` `Cooldown: 1d`, then
`⚡ ACOS > 40.0%`, then `Send Email`). Clone this: the rail is a live summary, not a progress bar.

| Kind | Steps |
|---|---|
| **Alert** | Configuration → Trigger Conditions → **Alerts** |
| **Automated Action** | Configuration → Trigger Conditions → **Actions & Alerts** |

Footer is always `Cancel` · `Back: <prev>` · `Next: <next>` / `Save`. Validation is inline **and**
summarised: an invalid step gets a red border plus a red "Please fix the following errors:" block
listing `<Step>: <message>` (observed: *"Configuration: At least one profile must be selected"*).

#### Step 1 — Configuration (`screenshots/02`, `03`)

| Field | Detail |
|---|---|
| **Assign to Profiles** | Radio **Sellers** / **Vendors**, then a multi-select `Profile(s)` combobox with **Select All** and one checkbox row per profile (`<name>` + `Seller` badge + `SC` badge). **Cross-profile by construction** — at least one required. |
| **Name** | Free text, "Enter automation name". |
| **Lookback Window** | Preset dropdown (default `Last 30 days`) that also renders the resolved range and length: `Jul 15 - Aug 13, 2026 (30 days)`. Underneath, two explicit controls: **Lookback** `30 days` and **End Date** `Ignore Last` `1 day`. |
| **Trigger Time** | Time-of-day picker (default `13:45`), in **team timezone**. |
| **Cooldown** | `1 day`. |
| **Frequency** | `Daily` / `Weekly` / `Bi-weekly` / `Monthly`, with a live hint ("Runs every day"). Choosing **Weekly** reveals a `Mo Tu We Th Fr Sa Su` toggle row (default `Mo`) and the hint becomes "Runs once a week (Monday)". |

Four standing help bullets, verbatim — all four are real semantics we must reproduce:

- *"For day-over-day automations, use a 1-day lookback window."*
- *"Filters like Current Availability, State, Budget, and Bid, use the current value and are not affected by the lookback window."*
- *"Cooldown applies only to entities that have triggered within this automation."*
- *"Frequency controls which days of the week the automation is eligible to run."*

The second bullet is the load-bearing one: **the filter vocabulary is split into
window-evaluated metrics and current-state attributes**, and the UI does not mark which is which
outside this sentence. We should mark it per filter.

#### Step 2 — Trigger Conditions (`screenshots/04`, `05`)

| Control | Detail |
|---|---|
| **Entities** | The scope selector. Exactly ten values: **Profiles, Optimization Groups, Campaigns, Ad Groups, Targets, Audiences, Products, Advertised Products, Search Terms, Placements**. (Note: no Negative Targeting, no Search Query/SQP, no DSP.) |
| **Minimum Match Count** | A toggle; when on, a numeric input (default `1`) with the live sentence *"Alert triggers when at least N entity matches the filters"*. Tooltip: *"Minimum number of entities that must meet the filter criteria to trigger this automation."* |
| **Trigger Conditions** | Opens **the same `Filters` modal used by every data grid** — same "Filter / Operator / Value" rows, same `+ Add New Filter`, `Clear All`, `Cancel` / `Apply N Filter(s)`. This is direct UI confirmation of the "one filter vocabulary everywhere" clone verdict. |
| **Test Trigger** | *"Check how many entities currently match these conditions."* → a green result panel. |

Two more standing notes, both `UI-verified` and both material:

- *"Archived and ended Campaigns are excluded from automations."*
- *"To trigger on data changes, enable **Delta filters** in Advanced settings. You must refresh
  the page after enabling the setting to see delta filters in the filter list."*
  → **Delta filters are an off-by-default feature flag**, not part of the base grammar. See
  `09-settings-and-admin.md` §Advanced.

##### Trigger Filters vs scope filters — the key concept

In the filter list, some entries carry a **lightning-bolt badge whose accessible label is
literally `Trigger Filter`**. The rest do not. So the grammar has two classes:

- **Trigger filters** — may fire the rule.
- **Plain filters** — narrow *which* entities are in scope, but cannot themselves trigger.

Complete filter list for **Entities = Campaigns** (`UI-verified`, ⚡ = Trigger Filter):

| Group | Filters |
|---|---|
| **Campaigns** | Avg Daily Spend vs Budget · Budget · Campaign Ad Type · Campaign End Date · Campaign ID · Campaign Is Global · Campaign Last Optimized · ⚡Campaign Name (contains) · ⚡Campaign Name (doesn't contain) · ⚡Campaign Start Date · Campaign State · ⚡Campaign Targeting Type · Dayparting Schedule · Exclude Campaigns · Optimization Groups · Select Campaigns · Total Products · Total Targets |
| **Portfolio** | Select Portfolios |
| **Tags** | Tag (Campaigns) |
| **General** | Cost Type · Creative Type |
| **Bid Management** | Bid Strategy |
| **Ad Groups** | SB Campaign Version |
| **Performance Metrics** (⚡ **all of them**) | ACOS (Ad Cost of Sales) · ACOS vs Target ACOS · aCTC (Average Clicks to Conversion) · AOV · Clicks · CPA · CPC · CPM · CTR · CVR · Impressions · Orders · ROAS · RPC · Sales · Spend · Units |
| **Product** | Contains ASINs · Contains SKUs |

`ACOS vs Target ACOS` carries a tooltip: *"Target ACOS is sourced from the Opt Group assigned to
the campaign. If the campaign has no Opt Group…"* — i.e. the target-relative filter resolves its
denominator from optimization-group membership.

**Note for `06-tags.md`:** `Tag (Campaigns)` is available here, so **tags CAN scope an
automation**. That partially refutes the "tags classify but nothing acts on the classification"
verdict — tags drive automation scope, just not optimization groups, campaign maps or dayparting.

**Operators** (`screenshots/05`), for a numeric metric filter — six, no more:
`Less than` · `Less than or equal` · `Equal to` · `Between` · `Greater than` · `Greater than or equal`.
The value input is unit-aware (a `%` suffix for ACOS). A completed condition renders as a chip:
`⚡ ACOS > 40.0%`.

##### Test Trigger is a real dry run

With `ACOS > 40%` on Campaigns, `Test Trigger` returned:

> **8 campaigns currently match**
> Requires 1 match • Trigger would run • 30 days of data • starting 1 day ago
> **`View Matching ↗`**

That is a genuine pre-commit preview: the match count, whether the rule *would* fire against the
minimum-match threshold, the resolved window, and a **drill-through link into the filtered grid**.
It is the "preview as a diff" primitive we wanted — for automations they already built it. Clone
the whole panel, including the one-line restatement of the resolved window.

#### Step 3a — Alerts (Alert kind) (`screenshots/06`)

| Field | Detail |
|---|---|
| **Alert Type** | Dropdown with **exactly one option: `Send Email`**. No Slack, no webhook, no in-app, no SMS. |
| **Email Recipients** | Text input + `Add` button → a recipient list. Arbitrary addresses, not limited to team members. |
| **Subject** *(optional)* | Placeholder `e.g. High ACOS Alert`. Hint: *"If left empty, the subject will be generated based on the name and the entities triggered, e.g. 'Alert: High ACOS Alert triggered for X Campaigns'."* |

`Save` commits. **Not clicked.**

What the email body contains could not be established without firing a rule, and firing one is a
write. Recorded as the one remaining unknown in this area.

#### Step 3b — Actions & Alerts (Automated Action kind) (`screenshots/07`, `08`, `09`)

Header note: *"Automated Actions will only apply to the filtered entities defined in the Trigger
section."* Below the action row: **`+ Add New Action`** and **`+ Add New Alert`** — so one
automation can carry **multiple actions and alerts together**. An alert is therefore a *kind of
action*, and "New Alert" is just the action-less shortcut.

**Action Type vocabulary — five values** (for Entities = Campaigns):

| Action | Parameters (`UI-verified`) |
|---|---|
| **Change State** | `State`: `Enabled` (default; the enum is the campaign-state enum) |
| **Change Budget** | `Budget` mode: **No change · Set budget to ($) · Increase budget by ($) · Decrease budget by ($) · Decrease budget by (%) · Increase budget by (%)** (default *Increase budget by (%)*), `Adjust (%)`: `10`, plus **`Budget Floor` ($) and `Budget Ceiling` ($) — both default to "No limit"** |
| **Add Tag** | Tag assignment |
| **Assign Opt Group** | Optimization-group assignment |
| **AdLabs Bid Optimizer** | Runs the full bid optimizer as an unattended action — see below |

**`AdLabs Bid Optimizer` as an automation action is the most significant single finding here.**
Selecting it:

- collapses the row to a settings chip: **`⚙ Settings · Target ACOS 30% · Balanced`**
- shows *"No other actions can be added alongside the optimizer action"* — it is **exclusive**
- shows a warning: *"We recommend running bid optimization no more than once per week to allow
  bids time to take effect before the next run."*
- still permits `+ Add New Alert`

So AdLabs **does** ship fully unattended, scheduled, cross-profile bid optimization with **no
human approval step** — while simultaneously telling you on the same page not to automate bids.
That is a direct and important input to WP-12: the staged-apply engine is not us inventing
something they lack; it is us adding the approval gate they chose to omit.

The settings chip opens the **Optimization Settings** modal — the same modal as the interactive
optimizer. Its full field set and *defaults* are recorded in `04-optimizer.md` §Optimization
Settings modal (screenshot `screenshots/09-optimization-settings-modal.png`).

### Corrections to the `MCP`-derived model above

| Session-1 claim (`MCP`) | Session-3 reality (`UI-verified`) |
|---|---|
| "Automations are bid rules and scheduling rules" | Two named kinds in the UI: **Alerts** and **Automated Actions**, sharing one wizard and one row model. |
| Rule definition is "not documented on any evidence path" | **Fully captured** — condition vocabulary, operator set, trigger-vs-scope filter classes, action vocabulary, schedule model, scope selector. |
| `entity_type` — "what the rule acts on" | Confirmed, and the enum is the ten values listed above. |
| `profiles` plural / team-scoped | **Confirmed visually**: multi-select profile picker, Sellers/Vendors split, and the list grid groups by Profiles. |
| `action_count` — "a rule is a container of actions" | **Confirmed**: `+ Add New Action` / `+ Add New Alert` on one automation. |
| Schedule model unknown | `Frequency` (Daily/Weekly/Bi-weekly/Monthly + weekday picker) × `Trigger Time` × `Cooldown` × `Lookback Window` (+ `Ignore Last N days`), all in **team timezone**, all running **after data sync completes**. |

---

## 2. Alerts — **CORRECTED: they exist**

> **This section previously said "No alerting capability was found on any evidence path."
> That was wrong.** It was an artefact of the MCP contract exposing no alert object and the
> Automations page being unreachable from the nav. Alerting is a first-class, shipped feature.

### What actually exists

- A dedicated **`+ New Alert`** builder (§1 above).
- Cross-profile scope, ten entity types, the full grid filter grammar as conditions.
- A schedule (frequency + weekday + time-of-day + cooldown + lookback).
- A **minimum match count** threshold.
- A **dry-run** (`Test Trigger`) with a match count and a drill-through to the matching rows.
- Delivery to **an arbitrary list of email recipients**, with an auto-generated or custom subject.

So the "every ingredient exists but the delivery half is absent" framing is **retired**. The
delivery half exists.

### What is genuinely still missing — the narrowed beat

| Gap | Detail |
|---|---|
| **One channel only** | `Send Email`. No Slack, no webhook, no Teams, no in-app inbox, no digest. For an agency running its morning routine in Slack this is the whole ballgame — and it is exactly why our operating context already rebuilds this outside the tool. |
| **No rows in the notification (unconfirmed but strongly implied)** | The subject template is *"Alert: X triggered for N Campaigns"* — a **count**, not a row set. Whether the body carries the breaching rows could not be verified without firing a rule. `Test Trigger` proves they can produce the rows; the alert appears to send the number. |
| **No digest / no rollup** | One rule fires one email. Fifteen profiles × six checks is ninety emails, not one Monday brief. The grid groups by profile; the delivery does not. |
| **No escalation, ack, or state** | Nothing to say "still breaching", "resolved", or "someone is on it". `Last Triggered` is the entire memory. |
| **Buried** | Not in the nav, not in search, and the page's own banner argues against using the feature. Discoverability is a product decision and they made it badly. |

**Beat, restated.** Not "build alerting" — **build the delivery layer they stopped short of**:
multi-channel (Slack first), row-level payloads, one scheduled cross-profile digest instead of
N emails, and alert state that survives between runs. The rule engine underneath is genuinely
good and should be cloned closely, including `Test Trigger`.

Adjacent surfaces, unchanged and still not alerts: `analyze(audit_summary)` is a pull scorecard;
filters like `DAILY_SPEND_TO_BUDGET > 0.8` are the conditions such a rule would test.

---

## 2b. The MCP-side automation surface (`MCP`, unchanged)

`MCP`, verbatim: *"Automations are bid rules and scheduling rules — each row represents one
rule."* Row shape:

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
no action schema anywhere in the MCP contract.

**Session 3: the rule definition language is now fully captured from the UI (§1) — but the
asymmetry stands and is itself the finding.** A rules engine that an agent can pause but cannot
author is half a product, in a tool explicitly marketed as agent-drivable. Our automation object
must be creatable and editable through the API on day one. Keep this in the Skip list.

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
