# WP-11 — AdLabs recon: index, coverage, and session log

**Specs only, no code.** Feeds WP-06 (grid/dashboard UI), WP-07 (recommendations/n-grams),
WP-08 (tags, goto links), WP-12 (staged apply), and WP-05 (strategy).

**Status: complete.** Sessions 1–2 could not reach a browser at all (the Chrome extension never
paired), so the specs were built entirely from the live MCP contract. **Session 3 (14.08.2026)
connected, ran the full UI walkthrough, and executed the whole six-item follow-up priority list.**
`BLOCKED.md` is now a resolution record; read its §Session 3 for the run log.

New evidence is tagged **`UI-verified`** in place. **13 redacted screenshots** now live in
`screenshots/`. No login wall was encountered (wait time: zero). Exactly **one** sanctioned write
was made in the entire programme — one goto link, minted deliberately to settle
`10-goto-links.md`; everything else was read-only and every builder was cancelled.

### The four corrections that matter most

Session 3 did not just fill gaps — it **overturned four headline conclusions**. If you read
nothing else, read these:

| Was | Is |
|---|---|
| "**Alerting does not exist at all**" — ranked Beat #1 | **Alerting exists**: a full rule builder with cross-profile scope, schedules, thresholds, a dry run, and email delivery. The real gap is the *delivery layer* (one channel, a count not the rows, no digest, no state). |
| "**No white-label capability** was found on any evidence path" — called the largest single gap | **A complete white-label stack exists**: custom domain, logo, favicon, accent colour, 8-colour chart palette, and a share view with zero vendor branding plus `Download PDF`. It is an *organization* setting, invisible to the dashboard contract. |
| "**Cross-profile work has no home**" | `Insights → Profiles Overview` **is** a portfolio screen with cross-profile currency normalisation. The gap narrows to grids, optimizer runs, maps, dayparting, tags and saved views. |
| "Every guardrail exists and **every one ships off**" | The optimizer's own defaults are **not** off — `Dynamic` bid ceiling at 1x CPC, ±25% bid change, ±33% placement change. Only the bid floor defaults to `Off`. What ships empty is an *optimization group's* limit fields. |

A fifth, structural: **the navigation map was substantially wrong** (17 flat sections → 6
collapsible groups), and the Automations product sits at an **unlinked route** absent from both
the nav and ⌘K search — which is why two prior sessions and the MCP contract all missed it.

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
| `BLOCKED.md` | Session log: why sessions 1–2 failed, and the session-3 resolution + priority-list outcome |
| `screenshots/` | **13 redacted captures**, numbered `01-`…`13-` |

### Screenshot index

| File | Shows |
|---|---|
| `01-automations-list.jpg` | The Automations list screen, its banner and both create buttons |
| `02-alert-builder-configuration.jpg` | Alert wizard step 1 — schedule, lookback, cooldown |
| `03-alert-builder-frequency-weekly.jpg` | Frequency = Weekly revealing the weekday picker |
| `04-automation-entity-types.png` | The ten trigger entity types |
| `05-automation-filter-operators.png` | The shared Filters modal + the six numeric operators |
| `06-alert-delivery-email-only.png` | Alert delivery — `Send Email` is the only option |
| `07-automation-action-types.png` | The five automated-action types |
| `08-automation-change-budget-modes.png` | Change Budget modes + floor/ceiling |
| `09-optimization-settings-modal.png` | The full Optimization Settings modal and its defaults |
| `10-settings-advanced-feature-flags.png` | Advanced tab — `Placement Mod`, `Delta Filters` |
| `11-white-label-domain-logo-icon.jpg` | White-label: custom domain, logo, favicon |
| `12-white-label-color-palette.jpg` | White-label: accent colour + 8-colour chart palette |
| `13-goto-link-restored-filter-bar.png` | The state a goto link restores |

Client-identifying screens (profiles, dashboards list, members, grids, the rendered share view)
were **deliberately not captured** and are described in prose instead — this repo is public.

---

## Nav-map coverage

Every section in `01-navigation-map.md` is either specced or explicitly skipped with a reason.

### Specced

| Section | Spec file | Confidence |
|---|---|---|
| Dashboards | `03` | High — model exact; **white-label + share view now `UI-verified`** |
| Optimizer | `04` | High — contract exact, tutorials cover workflow step by step |
| Optimization Groups | `04` | High — contract exact plus a live `list_groups` read |
| Campaign Mapping | `05` | High — contract exact plus a live `list_mappings` read |
| Harvesting | `05` | High — contract exact |
| Data grids (9 PPC levels + SQP) | `02` | **Highest** — exact column sets read off live fetches |
| Analyze — the grids (Advertised Products, Placements, Ad Groups, Audiences, Tags, Change Logs) | `02` | High |
| Analyze — n-grams / brand leak / audit scorecard | `04`, `07` | **Downgraded: contract exact, but no nav item exists for any of them** — see gaps |
| Search Query Performance | `07` | High — exact columns from a live fetch |
| AMC | `08` | Moderate — action list and connection doctrine known, query bodies not |
| Automations | `08` | **Highest — full rule builder `UI-verified`** (was: Low) |
| Dayparting | `08` | High — two-reference shape confirmed by a live read |
| Tags | `06` | High on model; assignment UX still unseen. Tag-scoped automations `UI-verified` |
| Time Machine / Logs | `04` | High — exact job-log columns |
| Profiles | `09` | High — exact field set; **two screens**, `Manage Profiles` + `Profiles Overview` |
| Settings / teams / roles / MCP keys | `09` | **High — `UI-verified`.** Roles are Owner+Admin only; MCP key is one unscoped button; a previously unknown Advanced feature-flags tab exists |
| Navigation | `01` | **High — `UI-verified` and heavily corrected** |
| Context Manager | `09` | High — contract exact, delivery pattern confirmed live |
| Goto links | `10` | High — URL shape and restore semantics `UI-verified` (was: Partial) |

### Explicitly skipped

| Section | Reason |
|---|---|
| Help / Messages | Vendor support surface. Nothing to clone; no in-app chat in v0. Their public "white box bidding algorithm" article is competitive reading for WP-05, not a UI to build. |
| Billing / plan management | **Correction:** it *does* surface — `Subscription & Billing` in the Settings popover, a `Plan` badge per team, and "each team has separate billing". Still out of scope for v0, but no longer unobserved. |
| Legacy Sponsored Brands | AdLabs explicitly does not support SB campaigns created before Oct 2022. We inherit the exclusion. |
| Amazon TV | Appears only as a `CAMPAIGN_AD_TYPE` filter value. No dedicated surface, not in our book. |
| DSP screens | `dsp_campaign` / `dsp_ad_group` / `dsp_flight` entities and filter schemas confirmed to exist. Out of v0 scope (we ship SP/SB/SD). Recorded so the nav has a documented hole, not an unnoticed one. |

### Known gaps in coverage

**Five of the six gaps recorded after session 2 are now closed.** What remains:

| Gap | Why it is still open | Recoverable by |
|---|---|---|
| **What an alert email actually contains** | Verifying it requires *firing* a rule, which is a write and outside the read-only envelope. The subject template implies a count (`"triggered for X Campaigns"`), not the rows — but the body is unconfirmed. | Creating one throwaway alert on a disposable filter and letting it fire |
| **Goto links from a *preview* reference** | `create_goto_link` accepts an optimizer-preview reference and may restore the preview *modal* rather than a grid filter — a possibly snapshot-backed second mechanism. Producing an optimizer preview is itself out of the read-only envelope. | One preview + one link, with the manager's sign-off |
| **Whether `query`-computed columns survive a goto link** | The test reference carried none. | 2 minutes, next time a computed reference exists |
| **Dayparting × optimizer interaction** | Bids are recomputed from performance collected *under* a dayparting modifier. Whether smart ceilings account for it is documented nowhere. | Vendor question, or an experiment |
| **Tag assignment UX** | The Tags grid was not opened; how you attach a tag while looking at a grid row is still unseen. | 5 minutes in `Analyze → Tags` |
| **n-grams / brand leak / audit scorecard surfaces** | These exist in the MCP `analyze` contract but **have no nav item at all**. Whether they are UI features, API-only, or reachable from inside another screen is now an open question that session 3 *created*. | 10 minutes hunting inside the grids |

### Closed by session 3

| Was | Now |
|---|---|
| Automation rule definition — "the single real hole in the recon" | **Closed in full** — `08` §1 |
| Goto link token format and snapshot-vs-live semantics | **Closed** — `10` §3 |
| User / role / permission management | **Closed** — `09` §4. Owner + Admin, nothing else |
| MCP key management screen | **Closed** — `09` §5. One unscoped `Generate Key` button |
| All visual chrome | **Closed** for every area walked; 13 screenshots |

---

## Read-only confirmation (session log)

Per the brief's acceptance check: **exactly one state change was made in AdLabs across all three
sessions — one goto link, explicitly sanctioned by the manager for session-3 priority item 3.**
Nothing else was created, modified, applied, shared or deleted.

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
- ~~`create_goto_link`~~ — **called exactly once in session 3**, under explicit manager
  authorisation, from a one-row reference. It has **no delete affordance** in the UI or the MCP
  contract, so the link persists; it points at a 3-day, single-campaign view. This is the only
  write in the programme.
- `logs(revert_job)`
- MCP key creation — explicitly out of scope; the `Generate Key` button was **seen, not clicked**
- `submit_bug_report`

### Session 3 — MCP calls

`start_chat_session` · `read_resource` (one profile resource) · `get_entity_data` (`teams`,
`profiles`, `campaign`) — all reads — then the single `create_goto_link` above.

### Browser

**Session 1:** `tabs_context_mcp` once (failed: extension not connected), then
`list_connected_browsers` polled roughly twenty times across the session — empty every time.

**Session 2:** `tabs_context_mcp` four times over ~4 minutes (including one after a deliberate
75-second wait) and `list_connected_browsers` once — same error string every time, empty list.
Plus a read-only inspection of the local browser profile on disk, which touched no AdLabs
surface.

**Session 3: connected on the first attempt** (`select_browser` with the operator-confirmed
deviceId, then `tabs_context_mcp{createIfEmpty:true}`). **No login wall** — the app host resolved
straight into an authenticated session, so the 10-minute wait-and-recheck procedure was never
needed. **Login-wall wait time: zero.**

Pages walked (all read-only): `/getting-started` · `/profiles` · `/profiles-overview` ·
`/optimizer` · **`/automations`** (+ both wizards, cancelled) · `/dashboards/overview` · one
`/external/dashboard/<token>` share view · `/configuration/settings/{user,teams,advanced,dashboards}`
· the Manage Members modal · the Optimization Settings modal · one goto link, opened twice.

Modals opened and **cancelled without saving**: Create New Alert, Create New Action, Optimization
Settings, Filters, Manage Members. Two MCP tabs were opened and both were closed.

### Repository hygiene

- Everything written lives under `tools/recon/` — the directory WP-11 owns. Nothing else touched.
- **Nothing committed.** Files are left untracked in the working tree, which is on another WP's
  branch (`wp-00-scaffold`). No branch was created, switched, or modified.
- **No client names, profile names, brand names, team IDs, org IDs, profile IDs, ASINs, or
  absolute local paths appear in any spec file.** Live values that informed the specs were read
  in-session and redacted to placeholders on the way out, per the public-repo rule.
- **Screenshots follow the same rule.** No demo/obfuscation mode exists in AdLabs, so captures
  were taken only of frames free of client data, or cropped to exclude it; client-identifying
  screens were described in prose instead. The goto-link token and the dashboard share token are
  redacted everywhere they appear.

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

**Added in session 3, all `UI-verified`:**

21. **`Test Trigger`** — a dry run on a rule that reports the match count, restates the resolved
    window in words, says whether the rule *would* fire against its threshold, and drills through
    to the matching rows. The best-designed single control found in the whole product.
22. **Trigger filters vs scope filters**, marked with a badge inside one shared filter picker, so
    "what can fire this" and "what narrows this" are legible without documentation.
23. **The wizard rail as a live summary** — each completed step's card fills with chips describing
    what you set, so the whole rule is readable while you edit any part of it.
24. **A lookback window expressed twice** — as a preset *and* as `Lookback N days` +
    `Ignore Last N days` — with the resolved absolute date range rendered beside the preset.
25. **The whole white-label stack**: org-level custom domain, logo, favicon, accent colour, an
    **eight-colour chart palette** with hex entry, a share view carrying **no vendor branding at
    all**, and a `Download PDF` button for the client.
26. **The comparison period rendered under the date range**, everywhere — grid toolbar and client
    share view alike — so nobody has to ask what "-12%" is measured against.
27. **Column aggregate under the sorted column header** in the grid.
28. **Stating the fallback inline**: *"Campaigns without an Opt Group receive 30% Target ACOS
    (Balanced)"*, printed in the settings modal rather than buried in docs.
29. **Guardrails on the action, not only the algorithm** — `Budget Floor` / `Budget Ceiling` on an
    automated budget change.
30. **Excluding archived and ended entities from automations, and saying so in the builder** —
    a runtime rule surfaced at authoring time.

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
- Capabilities that exist in the UI but not in the API (automation rule bodies — an agent can
  pause a rule but cannot author one — plus AMC and custom-table widgets).
- **Shipping a whole product at an unlinked route.** Automations is complete, cross-profile and
  fully functional at `/automations`, and appears in neither the nav nor ⌘K search. Every surface
  gets a nav home.
- **Org-wide "advanced" feature flags, defaulted off**, that silently change which filters and
  columns exist (`Delta Filters`, `Placement Mod`) with no per-user override and no hint elsewhere
  that a capability is being withheld.
- **A two-role permission model** (Owner + Admin) where the only role operation is transferring
  ownership. No viewer, no read-only seat, no per-profile scope, no client login.
- **Consuming the deep-link state parameter on load**, so copying the URL after opening it yields
  a link to nothing.
- **Arguing against your own feature in its own banner.** The Automations page tells you to use
  the Bid Optimizer instead. Either ship it or don't.
- Unscoped, non-expiring, read-write-by-default API keys in a product designed to be driven by
  agents.
- DSP, TV, legacy SB, in-app chat, billing — v0 scope.

### Beat — where wizard-ads should win

Ranked by the gap between value and effort.

1. **Alert delivery.** ~~"Alerting does not exist at all"~~ — **corrected: the rule engine
   exists and is good.** What is thin is the postbox: **one channel** (`Send Email`), a subject
   that carries a *count* rather than the rows, **no digest** (fifteen profiles × six checks is
   ninety emails, not one Monday brief), **no alert state** between runs (no firing / acked /
   resolved), and the whole feature hidden from the nav and from search. Clone their engine
   including `Test Trigger`; replace their delivery with Slack-first multi-channel, row-level
   payloads, one scheduled cross-profile digest, and durable alert state.
2. **An approval gate on unattended optimization.** They ship `AdLabs Bid Optimizer` as a
   scheduled automation action with **no preview and no confirmation** — on the same object model
   whose interactive path insists on preview-then-confirm. WP-12's thesis, validated by their own
   product: staged apply with a diff and a revert, *especially* when the run is scheduled.
3. **Cross-profile beyond overview and rules.** ~~"Cross-profile everything"~~ — **corrected:
   `Profiles Overview` is a real portfolio screen with currency normalisation, and automations
   already span profiles.** The remaining gap is narrower and still real: grids, optimizer runs,
   campaign maps, dayparting, tags and saved views are all single-profile.
4. **Sharing as a governed object.** ~~"White-label and real sharing"~~ — **corrected: white-label
   is complete** (custom domain, logo, favicon, accent colour, 8-colour chart palette, no vendor
   marks, PDF export) and belongs in Clone. What is missing is **link governance**: named
   recipient, expiry, passcode, view log, locked date range, and branding resolvable per client
   rather than only per organization. Today a share link is an unauthenticated ~128-character
   token that lives forever with no record of who holds it.
5. **Bounded blast radius, and say what it costs.** ~~"every guardrail ships off"~~ —
   **corrected: the optimizer's own defaults are sane** (`Dynamic` bid ceiling at 1x CPC, ±25%
   bid change, ±33% placement change; only the bid floor defaults to `Off`). What *does* ship
   empty is an **optimization group's** limit fields, and a group's nulls silently replace those
   defaults — so the dangerous path is a group, not a default run. Our group records should carry
   explicit inherited values, never nulls. The unqualified half of this beat stands: the preview
   says "4,000 adjustments" and **never** says "projected daily spend +18%", though every input
   for that estimate is in the row set — and neither does the settings modal.
6. **Preview as a diff, always.** Their negatives preview count is a raw cross-product that is
   explicitly *not* checked against existing state — so re-previewing after an apply returns the
   same number and proves nothing. "312 new, 88 already exist, 14 skipped" belongs *before* the
   apply. This is our own program rule 4 rendered as UI.
7. **Join SQP to ads.** SQP is profile-level and not campaign-linked; search terms are
   campaign-linked. "Did our click share fall because we quietly cut spend on that query?" needs
   both, and answering it today requires an external toolchain.
8. **Make tags actionable.** **Partially corrected:** automations *can* be scoped by
   `Tag (Campaigns)`, so the rules engine does act on the taxonomy. But optimization groups,
   campaign maps and dayparting schedules still take explicit ID lists. The lesson their own
   product teaches: **the filter grammar is the join** — anything that accepts a filter set can be
   tag-driven. Make every assignment surface accept one, and add tag rules that fire on sync.
9. **A run-rate pacing governor.** `DAILY_SPEND_TO_BUDGET` answers "am I capped today", never "am
   I on pace for the month". Month-to-date vs plan, projected landing, implied daily allowance.
10. **Named, shareable, cross-profile saved views** — columns + filters + date range as one named
    object — and goto links that carry that lens. **Now confirmed by experiment:** their goto link
    materialises a reference into a `Select Campaigns: N selected` ID filter and **throws away the
    predicate that produced it**, then re-queries metrics live. So it is neither a snapshot nor a
    saved search, and nothing tells you which you hold. Build the view and the link as one object,
    and label its kind on its face.
11. **Surface the sync clock everywhere.** **Partially corrected:** a `Sync · HH:MM GMT±N`
    indicator *is* in the header of every profile-scoped page, with a manual refresh beside the
    profile switcher. But it shows a *time*, not a freshness state — `Sync status` and
    `Last synced` still live two levels down in a profile resource, and same-day totals read zero
    mid-day. Show staleness, not a clock face.
12. **Scoped API keys** — read-only vs read-write, per-profile scope, expiry, rotation, last-used,
    and per-key entries in the existing job log. A prompt instruction is not a permission model.
13. **Click-through drill-down** from any dashboard widget to the filtered grid behind it. The
    shared filter vocabulary makes this nearly free, and they did not do it.
14. **SQP with a real time axis**, so week-over-week share movement does not cost one pull per
    week plus a manual stitch.
15. **Archived is not optional.** The campaign grid cannot see ARCHIVED at all, so any period
    total silently excludes archived spend.
16. **Per-target top-of-search impression share**, removed by AdLabs on 2026-07-28 with no
    replacement anywhere.
17. **Dashboard templates with live instances**, not duplication. Fifteen client dashboards should
    be one object.
