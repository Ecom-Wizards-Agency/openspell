# WP-11 — AdLabs recon: index, coverage, and session log

**Specs only, no code.** Feeds WP-06 (grid/dashboard UI), WP-07 (recommendations/n-grams),
WP-08 (tags, goto links), WP-12 (staged apply), and WP-05 (strategy).

**Read `BLOCKED.md` first.** The browser half of this work package did not run: the Chrome
extension never connected, so no AdLabs page was ever loaded and no screenshot was taken. The
MCP/data half was completed in full against the operator's own live org, strictly read-only.

**A second session (follow-up) hit the identical blocker and also produced no UI evidence.** It
did narrow the cause — the extension is installed, enabled and fully permissioned, so the failure
is at the account-pairing layer. `BLOCKED.md` §Session 2 has the detail. **Nothing in the specs
below has been UI-verified, and no screenshot exists.**

---

## Files

| File | Checklist area |
|---|---|
| `01-navigation-map.md` | 1 — every top-level section and subpage |
| `02-data-grid.md` | 2 — entity levels, exact columns, filter semantics, group-by, views, export |
| `03-dashboards.md` | 3 — widgets, periods/comparisons, drill-downs, share/white-label |
| `04-optimizer.md` | 4 — preview table, reason labels, ceilings, approval UX, group settings |
| `05-harvesting-and-campaign-maps.md` | 5 — map builder, per-map settings, bulk template, run/history |
| `06-tags.md` | 6 — nesting UX, assignment flows, where tags filter |
| `07-sqp-ngrams-negatives.md` | 7 — SQP + data-source claims, n-grams, negatives workflow |
| `08-alerts-automations-dayparting.md` | 8 — alerts/automations, dayparting, budget tools, AMC |
| `09-settings-and-admin.md` | 9 — profiles, target ACOS levels, teams/users, MCP keys, Context Manager |
| `10-goto-links.md` | 10 — deep links and state restoration |
| `BLOCKED.md` | Why the UI walkthrough did not run, what it cost, how to unblock |
| `screenshots/` | **Empty.** No screenshot could be taken — see `BLOCKED.md` |

---

## Nav-map coverage

Every section in `01-navigation-map.md` is either specced or explicitly skipped with a reason.

### Specced

| Section | Spec file | Confidence |
|---|---|---|
| Dashboards | `03` | High on model, unverified visually |
| Optimizer | `04` | High — contract exact, tutorials cover workflow step by step |
| Optimization Groups | `04` | High — contract exact plus a live `list_groups` read |
| Campaign Mapping | `05` | High — contract exact plus a live `list_mappings` read |
| Harvesting | `05` | High — contract exact |
| Data grids (9 PPC levels + SQP) | `02` | **Highest** — exact column sets read off live fetches |
| Analyze (placements, n-grams, brand leak, audit summary) | `02`, `04`, `07` | High |
| Search Query Performance | `07` | High — exact columns from a live fetch |
| AMC | `08` | Moderate — action list and connection doctrine known, query bodies not |
| Automations | `08` | **Low — see gaps** |
| Dayparting | `08` | High — two-reference shape confirmed by a live read |
| Data Groups (Tags) | `06` | High on model, assignment UX unseen |
| Time Machine / Logs | `04` | High — exact job-log columns |
| Profiles | `09` | High — exact field set from a live profile resource |
| Context Manager | `09` | High — contract exact, delivery pattern confirmed live |
| Goto links | `10` | **Partial — see gaps** |

### Explicitly skipped

| Section | Reason |
|---|---|
| Help / Messages | Vendor support surface. Nothing to clone; no in-app chat in v0. Their public "white box bidding algorithm" article is competitive reading for WP-05, not a UI to build. |
| Billing / plan management | Never surfaced on any evidence path. Visible only as capability gates (AMC is PRO-only). Out of scope for v0. |
| Legacy Sponsored Brands | AdLabs explicitly does not support SB campaigns created before Oct 2022. We inherit the exclusion. |
| Amazon TV | Appears only as a `CAMPAIGN_AD_TYPE` filter value. No dedicated surface, not in our book. |
| DSP screens | `dsp_campaign` / `dsp_ad_group` / `dsp_flight` entities and filter schemas confirmed to exist. Out of v0 scope (we ship SP/SB/SD). Recorded so the nav has a documented hole, not an unnoticed one. |

### Known gaps in coverage

| Gap | Why | Recoverable by |
|---|---|---|
| **Automation rule definition** | Conditions, actions, and schedule language are **UI-only with no MCP surface whatsoever**. No substitute source exists. **This is the single real hole in the recon.** | 20 minutes in the rule builder |
| Goto link token format and semantics | `create_goto_link` mints a persisted token, i.e. a write. Deliberately not called. Snapshot-vs-live-query behavior therefore unknown. | 5 minutes: mint one, change a filter, reopen |
| User / role / permission management | Not observable from MCP; only per-dashboard collaborator grants and implicit team membership were visible. May be UI-only. | 10 minutes in settings |
| MCP key management screen | Explicitly out of scope (no key creation). | 5 minutes, read-only |
| All visual chrome | No page was ever rendered. | The whole follow-up session |

---

## Read-only confirmation (session log)

Per the brief's acceptance check: **no state was changed in AdLabs.**

### Calls made — reads only

| Call | Kind |
|---|---|
| `start_chat_session` | session init |
| `read_resource` × 14 — instructions, docs index, entities, optimizer/harvesting/mapping/dashboard/tag/analyze/logs/context actions, campaign filter schema, changelog, automation actions, negative-target create actions, one profile resource | read |
| `get_entity_data` — `teams`, `profiles`, `campaign`, `target`, `placement`, `search_term`, `search_query`, `product`, `automation`, `dayparting_schedule` | read |
| `optimizer(list_groups)` | read |
| `campaign_mapping(list_mappings)` | read |
| `read(reference)` on the optimization-groups reference | read |

### Calls deliberately NOT made

- `optimizer(preview_optimization)` and `apply_optimization` — no optimization previewed or applied
- `optimizer(create_group / update_group / delete_groups / assign_campaigns)`
- `harvesting(preview_harvest)` and `apply_harvest`
- `campaign_mapping(upsert_mapping / delete_mapping)`
- `create_entities(negative_targeting)` and `negative_targeting_apply`
- `update_entities(...)` — any entity, any action
- `tags(create_tag / update_tag / assign_* / remove_* / delete_*)`
- `dashboards(create / update_settings / add_widget / create_link / delete / ...)` — nothing created, changed, shared, or deleted
- `context_and_prompts(set_core_context / delete_context)` — and `get_context` was skipped too, because stored context is client material and this repo is public
- `create_goto_link` — minting a token is a write
- `logs(revert_job)`
- MCP key creation — explicitly out of scope
- `submit_bug_report`

### Browser

**Session 1:** `tabs_context_mcp` once (failed: extension not connected), then
`list_connected_browsers` polled roughly twenty times across the session — empty every time.

**Session 2:** `tabs_context_mcp` four times over ~4 minutes (including one after a deliberate
75-second wait) and `list_connected_browsers` once — same error string every time, empty list.
Plus a read-only inspection of the local browser profile on disk, which touched no AdLabs
surface.

Across both sessions: **no AdLabs page was loaded, navigated, clicked, or screenshotted**, and no
MCP call of any kind was made in session 2. No login page was ever reached, because no browser was
ever reachable. `screenshots/` is still empty.

### Repository hygiene

- Everything written lives under `tools/recon/` — the directory WP-11 owns. Nothing else touched.
- **Nothing committed.** Files are left untracked in the working tree, which is on another WP's
  branch (`wp-00-scaffold`). No branch was created, switched, or modified.
- **No client names, profile names, brand names, team IDs, org IDs, profile IDs, ASINs, or
  absolute local paths appear in any spec file.** Live values that informed the specs were read
  in-session and redacted to placeholders on the way out, per the public-repo rule.

---

## The verdicts, in one place

### Clone — the ideas worth taking wholesale

1. **One filter vocabulary everywhere.** The same `FilterKey` enum drives the grid, dashboard tab
   overrides, and the API. Learn it once, use it everywhere. This is the strongest design
   decision in the product.
2. **The grid is the selector for every bulk operation.** Optimize, harvest, tag, and negate all
   take a *reference* produced by filtering a grid. There is no second selection UI anywhere.
3. **Preview as a persisted, addressable object with two exits** — a "View in AdLabs" link for a
   human, or a programmatic apply — both keyed on the same `preview_id`, with the rows stored so
   nothing is recomputed between showing and applying. This is exactly the primitive WP-12 needs.
4. **The three-act approval gesture:** select rows → tick "I confirm changes" → Apply. Escape
   backs out.
5. **`group_by_column` as the only aggregation path**, with derived ratio metrics always
   recomputed from summed numerators and denominators. Never average an ACOS.
6. **Four columns per metric** (value / comparison / delta absolute / delta percent) with the
   comparison period defaulting to the immediately preceding equal-length period.
7. **Reason and limit as separate columns**, and `old_value` / `algo_new_value` / `new_value` as
   three values — so you can always see *that* a cap bound, not just infer it.
8. **Classification stored on the row, not computed in a workflow.** `rpc_category` on every
   target means "show me every low-visibility target" is a filter, not an optimization run.
9. **"Have I already acted on this?" as a column** — `harvested_targets`, `existing_targets`,
   `has_opt_rule`, `map_count`.
10. **Recompute bids from performance; never decrement the previous bid.** Current bid is state,
    not evidence.
11. **Warn-and-skip with a receipt**, never fail-the-batch; and success / total / failed counts on
    every job.
12. **Snapshot-before-write, permanent retention, one-click revert by job**, with a
    `has_been_reverted` flag.
13. **Mandatory `note` on every mutating action**, including reverts, with "ask the user if the
    intent is unclear."
14. **Context delivered inline with the data it qualifies** — org context on `teams`, team context
    on `profiles`, profile context on the profile resource. An agent cannot forget to load it.
15. **Connection state as data, never as an empty result.** `is_amc_connected` as a profile
    column; "not connected" distinguished from "connected but not synced"; and the principle that
    a missing connection is a statement about the tool, never evidence about the account.
16. **Semantic layout placement** (`below`, `right_of`, `replace`) over raw coordinates, with
    atomic ordered writes and clamping that reports what it clamped.
17. **Full-set infinite scroll**, no pagination, with auto-persisted column layout — the only way
    QA-ing 4,000 rows is physically possible.
18. **Target-relative filters** (`ACOS_TO_TARGET`, `DAILY_SPEND_TO_BUDGET`) that port across
    profiles and currencies, and **delta filters** that take the metric name as an argument.
19. **Reference-valued filters** (`CONTAINS_ASINS` accepting a prior result set) — set algebra
    between grids.
20. **`_raw` twins**: display value and Amazon-native enum side by side in the same row.

### Skip — deliberately not reproducing

- Three identifiers for one profile (Amazon ID, internal AdLabs ID, resource slug), warned about
  twice in their own docs.
- Two units for target ACOS (percent at profile/product, decimal fraction at group/run), and two
  casings for one concept (uppercase filter keys, lowercase columns).
- `match_types` plural vs `match_type` singular on entities that are always used together.
- **Three different update semantics in one product**: merge patch (`configure_widget`),
  PUT-with-a-warning (`update_group`), and destructive overwrite (`set_core_context`). Plus
  upserts that silently delete nested negative rows. We go merge patch, everywhere.
- Org-scoped listing with team-scoped creation for dashboards.
- Preset-as-aggression, when their own guidance is that one preset covers 95%+ of cases.
- Capabilities that exist in the UI but not in the API (automation rule bodies, AMC and
  custom-table widgets).
- Unscoped, non-expiring, read-write-by-default API keys in a product designed to be driven by
  agents.
- DSP, TV, legacy SB, in-app chat, billing — v0 scope.

### Beat — where wizard-ads should win

Ranked by the gap between value and effort.

1. **Alerting, which does not exist at all.** Every ingredient is present — portable ratio
   filters, a rule object that already spans profiles, a job log with notes — and the delivery
   half is simply absent. "Every profile above target ACOS or near budget cap, Monday, to Slack,
   with the rows attached" is the agency's actual morning question. Direct evidence the gap is
   real: agencies build this around the tool rather than in it.
2. **Cross-profile everything.** Automations prove they can build objects spanning profiles.
   Nothing else does — grids, dashboards, optimizer runs, campaign maps, dayparting, and tags are
   all single-profile, while the job is fifteen profiles across four countries and three
   currencies. A portfolio-of-accounts home screen is the clearest single gap in the navigation.
3. **White-label and real sharing.** No logo, no palette, no custom domain, no named recipient,
   no expiry, no passcode, no view log. `dark_mode` is the entire presentation surface on a
   client-facing share link, and the link is an unauthenticated token that lives forever. For an
   agency the dashboard *is* the deliverable.
4. **Bounded blast radius by default.** Every guardrail exists (bid floors and ceilings, per-cycle
   max increase and decrease, placement caps) and every one ships **off** — confirmed on a live
   profile where all four optimization groups had every limit unset. And the preview says "4,000
   adjustments" without ever saying "projected daily spend +18%", though every input for that
   estimate is in the row set.
5. **Preview as a diff, always.** Their negatives preview count is a raw cross-product that is
   explicitly *not* checked against existing state — so re-previewing after an apply returns the
   same number and proves nothing. "312 new, 88 already exist, 14 skipped" belongs *before* the
   apply. This is our own program rule 4 rendered as UI.
6. **Join SQP to ads.** SQP is profile-level and not campaign-linked; search terms are
   campaign-linked. "Did our click share fall because we quietly cut spend on that query?" needs
   both, and answering it today requires an external toolchain.
7. **Make tags actionable.** Optimization groups, campaign maps, and dayparting schedules all take
   explicit ID lists, so a taxonomy you have already built cannot drive any of them. Tag-driven
   membership plus tag rules that fire on sync turns classification into policy.
8. **A run-rate pacing governor.** `DAILY_SPEND_TO_BUDGET` answers "am I capped today", never "am
   I on pace for the month". Month-to-date vs plan, projected landing, implied daily allowance.
9. **Named, shareable, cross-profile saved views** — columns + filters + date range as one named
   object — and goto links that carry that lens rather than only a frozen result. Build them as
   the same thing.
10. **Surface the sync clock everywhere.** `Sync status` and `Last synced` live two levels down in
    a profile resource, while same-day totals read zero mid-day. Every number in the product
    depends on a timestamp almost nobody sees.
11. **Scoped API keys** — read-only vs read-write, per-profile scope, expiry, rotation, last-used,
    and per-key entries in the existing job log. A prompt instruction is not a permission model.
12. **Click-through drill-down** from any dashboard widget to the filtered grid behind it. The
    shared filter vocabulary makes this nearly free, and they did not do it.
13. **SQP with a real time axis**, so week-over-week share movement does not cost one pull per
    week plus a manual stitch.
14. **Archived is not optional.** The campaign grid cannot see ARCHIVED at all, so any period
    total silently excludes archived spend.
15. **Per-target top-of-search impression share**, removed by AdLabs on 2026-07-28 with no
    replacement anywhere.
16. **Dashboard templates with live instances**, not duplication. Fifteen client dashboards should
    be one object.
