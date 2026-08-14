# 04 — Optimizer: preview, reasons, ceilings, approval flow, groups, revert

**WP-11 recon · STRICTLY READ-ONLY.** No optimization was previewed, applied, or scheduled. No
optimization group was created, updated, or deleted. The only optimizer call made was
`list_groups`, which reads.

Sources: `VID` = AdLabs' own two tutorial videos (quick and advanced) for the bid optimizer, so
UI labels are as spoken. `MCP` = the live `adlabs://docs/optimizer_actions` contract plus a live
`list_groups` read. Nothing here was visually confirmed — see `BLOCKED.md`.

---

## 1. The workflow, as steps

1. **Open the Optimizer view.**
2. **Pick a date range.** `VID` calls this "very important" and spends the first quarter of the
   short tutorial on it. The stated tradeoff: long enough for click volume, short enough to catch
   recent conversion-rate trend.
3. **Read the trend chart.** A **daily / weekly toggle** smooths the line. The operator in the
   video starts at 60–90 days, sees conversion rate trending down, and shortens to ~2.5 weeks so
   the optimization is calculated on the lower recent CVR.
4. **Select campaigns** — some or all. **Shift-click selects a range** (`VID`).
5. **Click "Optimize bids".**
6. **Settings modal:**
   - Target ACOS (entered as a percentage).
   - Prioritization: **Balanced / Reduce ACOS / Increase sales**.
   - Optimization-group settings toggle: *use them* or *ignore them*.
   - **"Show advanced"** reveals the four optimization targets, the zero-impression toggle, and
     the bid ceiling controls.
7. **Preview.** "It'll take a couple of seconds for our calculator to basically work its magic."
   Result: a table of ~4,000 rows on their demo account, 12,000 with zero-impression rows
   included.
8. **QA the preview** — sort, filter, inspect reasons, and hand-edit or bulk-edit individual
   rows. This is described as the manager's job, explicitly: "it's now your job as the manager to
   come through here and QA everything."
9. **Select rows** (some or all), tick **"I confirm changes"**, click **Apply**.
10. Escape or Back exits without applying (`VID`: "I like hitting just the escape key, just a
    little bit faster").
11. Changes go to Amazon; a snapshot is written to the **Time Machine** before they are sent.

The confirmation gesture is worth naming precisely: **an explicit "I confirm changes" checkbox
that is separate from the Apply button, and separate again from the row selection.** Three
distinct acts — choose rows, affirm intent, execute. Clone that shape exactly for our staged
apply (WP-12).

---

## 2. Settings: exact inputs

### 2.0 The Optimization Settings modal, as rendered — `UI-verified`, session 3

Screenshot: `screenshots/09-optimization-settings-modal.png`. Captured from the automation
builder's `AdLabs Bid Optimizer` action (see `08-alerts-automations-dayparting.md` §1), which
opens the same modal the interactive optimizer uses. **Nothing was saved.**

Layout: a **basic block always visible**, then a `— Hide / Show Advanced Options` expander
revealing **three named columns**. This confirms the guardrails are advanced-only and therefore
easy to never see.

**Basic block**

| Control | Rendered as | Default |
|---|---|---|
| `OPT GROUP SETTINGS` | checkbox **"Use Opt Group Settings"** | **checked** |
| `TARGET ACOS` | numeric + `%` suffix | `30` |
| `PRIORITIZATION` | dropdown — exactly **`Balanced` · `Reduce ACOS` · `Increase Sales`** | `Balanced` |

with the live explainer: *"Applying Opt Group Targets when present. Campaigns without an Opt
Group receive 30% Target ACOS (Balanced)."* — i.e. the modal states the fallback for unassigned
campaigns inline. Clone that sentence pattern.

Note the **unit split confirmed visually**: Target ACOS is a **percent** here (`30 %`) while the
MCP `tacos` parameter is a **decimal fraction** (`0.30`). Two units for one concept, exactly as
`00-INDEX.md` §Skip records.

**Advanced — column 1, `Optimize Targets`**

| Section | Control | Default |
|---|---|---|
| IMPROVE EFFICIENCY | ☑ `High ACOS` | on |
| | ☑ `High Spend, No Sales` | on |
| IMPROVE SALES | ☑ `Low ACOS` | on |
| | ☑ `Low Visibility` | on |
| | ↳ ☐ `Include 0 Impressions` (nested under Low Visibility) | **off** |

Two corrections to §"The four optimization targets" below:

- The four toggles are **all on by default**, so the default run is maximally broad.
- `Include 0 Impressions` is **off by default** here. The MCP contract's
  `exclude_no_impressions` defaults to `false` (i.e. zero-impression rows *included*) — the UI
  default is the **opposite and safer** one. Note the double negative in the API name; ours
  should be positively named, as the UI's is.
- The UI renders it **indented under `Low Visibility`**, correctly expressing that it only
  modifies that one target rather than the whole run.

**Advanced — column 2, `Bid Change Limits`**

| Control | Rendered as | Default |
|---|---|---|
| `BID FLOOR` | dropdown — **`Dynamic` · `Manual` · `Off`** | **`Off`** |
| `BID CEILING` | same three-mode dropdown | **`Dynamic`** |
| `TARGET CPC` (companion to a Dynamic ceiling) | dropdown | `1x CPC` |
| `MAX INCREASE` | mode dropdown (`Max %`) + numeric + `%` | `Max %` / **`25`** |
| `MAX DECREASE` | mode dropdown (`Max %`) + numeric + `%` | `Max %` / **`25`** |

**Advanced — column 3, `Placement Settings`**

| Control | Default |
|---|---|
| ☑ `Optimize Placements` | **on** |
| `MAX INCREASE` — `Max %` + numeric | **`33`** |
| `MAX DECREASE` — `Max %` + numeric | **`33`** |

Footer: an **`AdLabs Algorithm Docs`** link (their public "white box" algorithm page), `Cancel`,
`Save →`.

#### This corrects a headline recon verdict

`00-INDEX.md` §Beat #4 said *"every guardrail exists and every one ships **off** — confirmed on a
live profile where all four optimization groups had every limit unset."*

**Half of that is wrong.** The *optimization-group* records on the live profile did indeed have
their limits unset — but the **optimizer's own defaults are not off**: a `Dynamic` bid ceiling at
`1x CPC`, ±25% max bid change per cycle, and ±33% placement change per cycle all apply out of the
box. Only the **bid floor** genuinely defaults to `Off`.

The corrected statement: **AdLabs ships sane per-cycle rate limits by default and no bid floor,
and an optimization group created through the API starts with every limit null** — so the
dangerous path is not the default UI run, it is a group whose unset fields silently replace the
defaults. That is a subtler and more useful lesson for WP-05/WP-12 than "everything ships off",
and it argues for our group records to carry explicit inherited values rather than nulls.

Still absent, and the beat that stands: **nowhere does this modal or the preview state the
projected spend impact** of the settings it is about to apply.

### Core

| Input | Values | Notes |
|---|---|---|
| Optimization period | `start_date`, `end_date` | `MCP` is emphatic: "Always ask the user for the optimization period dates before calling this tool — never assume or default them." |
| Comparison period | `compare_start_date`, `compare_end_date` | Optional; defaults to the equal-length period immediately preceding. |
| Target ACOS | `tacos`, decimal fraction (0.25 = 25%) | Required. |
| Prioritization | `preset`: `BALANCED` (default) / `REDUCE_ACOS` / `INCREASE_SALES` | |
| Use group settings | `override_group_settings` (false = groups apply) | |

`VID` on prioritization, and this is their own guidance, not ours: **Balanced is used "probably
95% or more of the time."** Reduce ACOS is for "ACOS needs to come down today". Increase sales is
"quicker on the gas pedal" and "will err on the side of overshooting that target ACOS". Their
stated preference is to raise the target ACOS and stay Balanced rather than switch preset —
"that increased sales isn't really meant to be something that you're doing perpetually".

### The four optimization targets

Presented in two pairs, and the pairing is the interface:

| Group | Toggle | What it does |
|---|---|---|
| **Improve efficiency** | `optimize_high_acos` | Targets overshooting target ACOS get bids recalculated down to where they should be to hit target. |
| | `optimize_high_spend` | High-spend, no-sales targets. Bid derived from ad-group AOV and target ACOS → target CPA. `VID` worked example: $10 AOV at 30% target ACOS = $3 affordable per order; a keyword that spent $3 with no sale gets its bid brought toward affordability, **not paused or archived** — "the keyword might be relevant, but we do know that you can't afford a $3 CPC when your average order value is $10." Floors out at $0.02. |
| **Improve sales** | `optimize_low_acos` | Raise bids on low-ACOS targets. |
| | `optimize_low_visibility` | Raise bids on low-impression targets. |

Plus `exclude_no_impressions` (default false, i.e. zero-impression rows are **included**). `VID`
quantifies the blast radius: on their demo, low-visibility alone produced ~4,000 rows; including
zero-impression rows took it to ~12,000. "Even though it's a small incremental adjustment, just
the sheer quantity of volume of keywords that are being adjusted, that could really cause your
total spend to blow up."

These four toggles map one-to-one onto the `rpc_category` column that sits on every target row in
the plain grid (see `02-data-grid.md`). **The optimizer is not a separate engine with its own
classification — it is a bulk action over a classification the grid already shows you.** That
coherence is the single best idea in the product.

### Limits (the guardrail block)

| Limit | Units | Range |
|---|---|---|
| `bid_ceiling` | `CURRENCY_AMT` or `TIMES_CPC` | TIMES_CPC: 1–3 |
| `bid_floor` | `CURRENCY_AMT` or `TIMES_CPC` | TIMES_CPC: 0.2–1 |
| `bid_max_increase` | `CURRENCY_AMT` or `PERCENT` | PERCENT as decimal fraction (0.10 = 10%); **0 blocks all increases** |
| `bid_max_decrease` | `CURRENCY_AMT` or `PERCENT` | as above; 0 blocks all decreases |
| `placement_max_increase` | decimal multiplier | 0.5 = +50%, 1 = +100%; group form allows up to 9 (+900%); 0 blocks all increases |
| `placement_max_decrease` | decimal multiplier | as above |
| `skip_placement_optimization` | boolean | Bids still optimized, placements untouched |

**A note on drift between the videos and the current product.** `VID` states plainly: "We don't
currently have a bid floor option." The live contract has `bid_floor_unit` / `bid_floor_value`,
and also per-cycle max increase/decrease and placement modifier caps that the videos never
mention. The videos describe an earlier, thinner guardrail set. Two consequences: (a) treat the
transcripts as directionally right on *workflow* and out of date on *controls*; (b) the direction
of travel is unambiguous — they keep adding rate limits, which is exactly what an operator asks
for after their first runaway optimization.

### Smart bid ceilings

The named feature. `VID` describes the problem first, and it is a real one: a low-volume keyword
that is "low visibility" because search volume is low, not because the bid is low, gets raised
5–10% every week forever. "I've seen these bids get up to like $20 and $30 by softwares that are
just perpetually increasing the bids on these keywords ... those keywords aren't going to flag
any major spend issues because they're only ever getting one click ... but cumulatively, all of
those keywords together can really drain and bleed your account."

The mechanism: compute the ad group's affordable CPC from its **average order value and average
conversion rate**, then cap the bid at a multiple of it that depends on the prioritization.

| Prioritization | Ceiling (AdLabs' published behavior) |
|---|---|
| `REDUCE_ACOS` | 1× the ad group's target CPC — a hard stop. A low-visibility keyword above it is *reduced* to it. |
| `BALANCED` | 2× — "we're going to make room for if a keyword happens to convert twice as good as the rest of the ad group average." |
| `INCREASE_SALES` | 3× |

**Fallback cascade when the ad group has too little data:** ad group → campaign → campaign
group (optimization group). Same cascade the low-data placement logic uses.

Toggle it off and it becomes a flat currency ceiling instead ("a flat two dollar kind of max
bid"). Their own recommendation is to leave it on.

**Bid floors are per ad type, and they are Amazon's minimums, not AdLabs':** ~$0.02 Sponsored
Products, ~$0.10 Sponsored Brands, ~$0.25 Sponsored Brands Video (`VID`).

---

## 3. The preview table

### Columns (exact, `MCP`)

```
entity_id  bidding_entity  ad_type  is_theme
campaign_id  campaign_name  ad_group_name  targeting
old_value  new_value  algo_new_value
change_reasons  limit_reasons
```

Plus, per `VID`, the optimization group's **target ACOS and prioritization are shown as columns**
on the preview rows, so you can see which rows used group settings and which used the modal
values.

Three of these columns carry the whole design:

- **`old_value` / `new_value` / `algo_new_value`.** Three values, not two. `algo_new_value` is
  what the algorithm wanted; `new_value` is what will actually be applied after limits and after
  any manual edit. Keeping the algorithm's raw opinion alongside the clamped result means you can
  always see *that* a cap bound, not just infer it.
- **`change_reasons`** — why a change was proposed.
- **`limit_reasons`** — why it was clamped. Separate column from the reason for the change.

That separation is the thing to clone. "This bid went up because low visibility" and "it did not
go up as far as we wanted because the smart ceiling bound" are two different facts and they get
two different columns.

### Reason labels

`VID` gives these verbatim or near-verbatim; they align with the five `rpc_category` values:

- **High ACOS** (spoken as "high cost keywords") — bid recalculated toward target.
- **Low ACOS** ("low cost keywords") — bid raised.
- **High Spend, No Sales** — bid brought to affordability.
- **Low Visibility** — bid raised, ceiling-bound.
- **Campaign performance** — placement/campaign-level adjustments computed from that campaign's
  own data.
- **Campaign group reference** — used when a campaign has too little data; the optimization
  group's aggregated data supplies the placement decision. `VID`: "if there's a scenario in which
  a campaign has low data, we'll be referencing a group of campaigns."

The reasons are stated as a design goal: "we try to be as descriptive as possible under this
reasons column for why certain adjustments are being made."

### Why bids can move counterintuitively

`VID` explains, and it is worth recording because it will come up in our own QA:

**A high-ACOS keyword can get a bid *increase*.** Because AdLabs recalculates the bid from
scratch — from the keyword's own conversion rate, AOV, and revenue per click — rather than
applying a percentage decrement to the current bid. Their reasoning, quoted: *"the keyword bid
under this current value ... is not a data point. It's just a status."* If someone dropped the
bid to $0.02 yesterday, the historical ACOS over the last two weeks is still high, but cutting
an already-floored bid by another 15% is meaningless. Also, a changed campaign placement modifier
feeds back into the individual keyword bid, which can push it up.

**Clone the principle, not just the feature:** current bid is state, not evidence. Every
recommendation we produce should be computed from performance, never from the previous
recommendation. This is also why their revert story has to be a snapshot rather than an inverse
operation.

### QA affordances

- **Sort** by any column. `VID` sorts by spend first ("the most influential elements in my
  account") and by delta second.
- **Filter** on any column, including `change_reasons` — type "reason", pick a condition, and
  the table narrows to just the high-cost keywords.
- **Filter on `new_value`** — e.g. everything below $0.10.
- **Manual per-row edit** of `new_value`.
- **Bulk edit** of a selected set. `VID` uses exactly this to implement a bid floor by hand back
  when the feature did not exist: filter to `new_value < $0.10`, select all, bulk-set to $0.10.
- Full-set infinite scroll, no pagination, instant sort — see `02-data-grid.md`.

**The bulk-edit-over-a-filtered-preview pattern is the single most valuable interaction in the
product.** It turns any missing guardrail into a two-minute workaround, and it is why an operator
trusts the tool: they can always overrule it in bulk, in place, before anything ships.

---

## 4. Optimization groups

### What they are

Named groups of campaigns, created by the operator, that serve **two distinct purposes** — and
conflating them is easy:

1. **A data pool for low-data decisions.** Campaigns with a handful of clicks cannot support a
   placement decision, so the group's aggregated data is used instead. `VID`: "taking a group of
   campaigns and aggregating that data so that we can have a lot more data to basically just
   calculate the placement settings off of."
2. **A settings carrier.** Per-group target ACOS, prioritization, and every limit from the table
   above, plus `no_optimize` and `skip_placement_optimization`.

### Rules

- A campaign belongs to **at most one** group (`assign_campaigns` with `group_id=0` unassigns).
- **SP and SB campaigns cannot be grouped together** — "just because the placement settings are
  different, and so these optimization groups are limited to a specific type" (`VID`).
- Grouping advice from AdLabs: group campaigns with **similar products, similar tactic
  (non-brand vs brand defense), similar conversion rate, and similar AOV**. Explicitly predicated
  on the account already having a decent campaign structure.
- Deleting a group unassigns its campaigns rather than deleting them.

### Settings precedence (exact)

With `override_group_settings = false` (the default, "use my optimization group settings"):

| Campaign | Setting used |
|---|---|
| In a group, group value **set** | The group's value |
| In a group, group value **not set** | The modal value |
| Not in a group ("ungrouped campaigns") | The modal value |

With `override_group_settings = true`: the modal's `tacos` and `preset` win everywhere — **but
the group is still used as a data pool for low-data campaigns.** `VID` is explicit: "we will
still use the data from the campaign groups to inform those low campaign data decisions ... this
toggle is basically just for the target ACOS and prioritization."

That is a genuinely good separation: the group's *identity* (which campaigns belong together) is
independent of the group's *policy* (what target to hit). One toggle suspends the policy without
suspending the identity. Clone it.

### Live shape (`MCP`, from a real `list_groups` read)

Columns: `id`, `name`, `preset`, `tacos`, `total_campaigns`, `no_optimize`,
`skip_placement_optimization`, `created_at`, `updated_at`, and for each of the six limits a
`*_unit`, `*_value`, and `*_off` triple.

Two observations from the live read:

- On the profile inspected, all four groups had **every limit left unset** (`*_off = false` with
  null unit/value) — i.e. limits default to inactive, and the guardrails ship off. That matches
  `VID`'s own advice to leave smart ceilings on and everything else alone, but it means the
  advanced controls are, in practice, unused surface.
- `tacos` is stored as a decimal fraction (0.20, 0.25, 0.35), while the filter schema's `ACOS`
  key takes whole percents (`30` = 30%). **Two representations of a percentage in one product.**

### Update semantics: a real hazard

`MCP`, verbatim: *"WARNING: PUT semantics — omitting an optional field silently resets it to its
default. Always call list_groups first and include all current values in the update."*

Meanwhile `dashboards(configure_widget)` is a merge patch that preserves omitted fields. Same
product, opposite contracts, and only one of them is documented with a warning. **We go merge
patch everywhere.**

---

## 5. Approval, apply, and revert

### Apply

`apply_optimization` takes the `preview_id` — it **re-reads the original preview from the
database** and applies every row where `new_value` differs from `old_value`. Optionally it takes
a `reference` from a filtered/edited query on the preview rows, in which case only those rows
apply and `new_value` comes from the reference.

**A `note` is required.** Not optional, not defaulted — "Required for audit logs". Every mutating
action in the AdLabs surface demands one, and several say "if the goal or intention of the change
is not clear, ask the user." Clone this without exception: no bulk change lands without a reason
string.

### Time Machine

`VID` calls it the Time Machine; `MCP` exposes it as `logs`.

`job_overview` columns (exact):

```
composite_id  job_id  log_type  job_type_label  entity_type  change_type  flow_type
created_at  success_count  total_count  failed_count
username  automation_name  has_been_reverted  note
```

- `composite_id` disambiguates the two log families (`"42_job"` vs `"42_opt"`) because manual
  jobs and optimizer jobs have independent ID spaces.
- **Three counts, not one**: `success_count`, `total_count`, `failed_count`. A partially applied
  job is visible as such. That directly satisfies our own program rule about verifying the
  artifact rather than the exit code — count outputs against inputs. Clone it.
- `username` and `automation_name` — human or machine, recorded per job.
- `has_been_reverted` is a stored flag on the job.
- `LOG_ENTITY_ID` + `LOG_ENTITY_TYPE` filters (both required together) retrieve the change
  history for a specific target. So "what has happened to this keyword" is answerable.

`job_details` returns per-entity old/new values for manual jobs, and bid/placement adjustments
with algorithm values and change reasons for optimizer jobs.

### Revert

`VID`: *"we take a snapshot of your account before we send those changes through, and then we'll
save that ... we store this data permanently. So you can come back a year from today and come
back and hit this revert button and set things back to the way they were back then."*

`MCP` confirms: `revert_job(job_id, log_type, note)` works for both optimizer and manual bulk
jobs, and a `note` is required for the revert too.

**Snapshot-before-write with unbounded retention and one-click revert is the feature that makes
bulk bid changes psychologically possible.** It is also the direct answer to why bids must be
recomputed rather than decremented (§3): an inverse operation would not be reliable, so they
store the state instead. Clone the whole shape — snapshot, permanent retention, revert by job,
mandatory note, reverted-flag on the original.

Related read-only surface: `target_bid_history` reproduces the "View bid history" panel for a
single target — daily base bid, Amazon suggested bid band (low/med/high), max CPC, bid modifier
percentages, and daily performance. Per-target forensics without leaving the grid.

---

## 6. Adjacent: the audit scorecard

`analyze(audit_summary)` returns a precomputed account health scorecard in one call, covering:

- Ad type spend distribution (SP / SB / SD)
- Product-level total ACOS and spend distribution
- **Budget utilization** — campaigns hitting daily budget caps
- **Target bid category distribution** — High ACOS / Low ACOS / High Spend No Sales / Low
  Visibility
- Match type spend distribution (Exact / Phrase / Broad / Auto)
- **Placement modifier accuracy** — current adjustment % vs recommended `cvr_lift` %

The last one is the interesting one: it scores how wrong your placement modifiers currently are,
which is a diagnosis nothing else in the product surfaces directly.

This exists because the alternative was "multiple get_entity_data + group_by_column calls". It is
a good precomputed-diagnosis pattern and it belongs in our WP-05 strategy layer.

---

## 7. Verdicts

**Clone.**
- The three-act approval gesture: select rows → tick "I confirm changes" → Apply. Escape backs
  out.
- `old_value` / `algo_new_value` / `new_value` as three columns, with `change_reasons` and
  `limit_reasons` as *separate* columns.
- Optimizer targets that map one-to-one onto a classification already visible in the plain grid.
- Bulk edit over a filtered preview. This single interaction is why the tool is trusted.
- Smart bid ceilings derived from ad-group AOV and CVR with an ad group → campaign → group
  fallback cascade, and a per-prioritization multiplier.
- Recompute bids from performance; never decrement the previous bid. Current bid is state, not
  evidence.
- Optimization groups as a data pool *and* a settings carrier, with one toggle that suspends the
  policy while keeping the pooling.
- Mandatory `note` on every mutating action, including reverts.
- Snapshot-before-write, permanent retention, one-click revert, `has_been_reverted` flag, and
  success/total/failed counts per job.
- The `exclude_no_impressions` toggle framed by its blast radius (4,000 rows → 12,000).

**Skip.**
- PUT semantics on group update. Merge patch, always.
- Two representations of a percentage (0.25 in group settings, 30 in filters).
- Independent ID spaces for manual and optimizer jobs, papered over with a `composite_id`.
- Preset-as-aggression. Their own guidance is that Balanced covers 95%+ of cases and that the
  other two presets are for one-off scenarios — a three-way preset whose correct answer is almost
  always the same one is a control that mostly generates wrong choices. Prefer explicit levers
  (target ACOS, rate caps, which categories to touch) over a mood setting.

**Beat.**
1. **Bounded blast radius by default.** Their guardrails (max increase/decrease per cycle,
   placement caps, floors) all exist and all ship **off** — confirmed on a live profile where
   every limit was unset across all four groups. A per-cycle change cap and a spend-delta
   estimate should be on by default, and the preview should state the projected daily spend
   change before you tick the box, not after Amazon tells you.
2. **Simulated outcome, not just changed rows.** The preview says "4,000 adjustments". It does not
   say "projected daily spend +18%". Every input for that estimate is already in the row set.
3. **Guardrails that persist as policy, not as modal state.** Ours should be a per-profile
   policy object with an audit trail of who changed a limit and when.
4. **Reason coverage as a QA metric.** With 4,000 rows the operator samples. We can report "97%
   of rows fall into 4 reason clusters; 3% are outliers" and put the outliers first, which is
   what a manager is actually hunting for.
5. **Cross-profile optimization runs.** Everything here is single-profile. The weekly job is
   fifteen profiles.
6. **Revert to a point in time, not just a job.** They store snapshots permanently and expose
   revert per job. With the same data you can offer "restore this campaign's bids to what they
   were on the 1st", which is what someone actually asks for after a bad week.
