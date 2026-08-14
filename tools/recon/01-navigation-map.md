# 01 — AdLabs navigation map

**WP-11 recon · read-only · source legend below**

## Evidence legend

Every row carries how it was established.

**Session 3 (UI-verified).** The Chrome extension connected and the rendered nav was read
directly. The section list below has been **corrected against the real nav** — the session-1/2
list was assembled from capabilities and URL shape and got the grouping, the naming and the
section count wrong. Rows now marked `UI-verified` were read off the rendered page.

| Tag | Meaning |
|---|---|
| `UI-verified` | Read directly off the rendered AdLabs UI in session 3. Authoritative. |
| `MCP` | Proven by a live read-only call against the AdLabs MCP server on the operator's own org. The capability demonstrably exists and its parameters are exact. |
| `URL` | An absolute AdLabs UI URL returned verbatim by the MCP server. |
| `VID` | Described in AdLabs' own tutorial videos (their walkthroughs of the bid optimizer). Labels are as spoken, so treat wording as approximate. |
| `INF` | Inferred: a capability exists in the API/MCP layer, so a surface for it almost certainly exists, but its placement in the nav is unverified. |

## Host and URL shape

- Application host: `dashboard.adlabs.app` — `UI-verified`. Hitting the bare host redirects to
  `/getting-started`. (`app.adlabs.app` is the marketing/login host only.)
- **Routes are plain paths with no tenancy in the query string** — `UI-verified`. Observed:
  `/getting-started`, `/profiles`, `/profiles-overview`, `/optimizer`, `/automations`,
  `/dashboards/overview`, `/configuration/settings/{user,teams,advanced,dashboards}`.
  The active profile is held in app state and shown in a **top-right profile switcher**, not in
  the URL. **This corrects the session-1 claim** that every route carries
  `?teamId=&profileId=`; that shape appears only on MCP-generated deep links.
- Legacy/deep-link shape: `https://dashboard.adlabs.app/<section>/?teamId=<int>&profileId=<amazon_profile_id>`
  — `URL`. Still emitted by the MCP server's "View in AdLabs" links. Two things follow and both
  are load-bearing for our clone:
  1. **Tenancy is in the query string, not the path.** Team and profile are switchable
     parameters on every screen rather than a path prefix. Any screen can therefore be
     re-pointed at another profile without changing route.
  2. `profileId` is the **Amazon** advertising profile ID (a long numeric, e.g. 16 digits), not
     AdLabs' internal profile row ID. AdLabs' *internal* numeric profile ID is a different
     value and is the one dashboards use for `profile_ids`. Two ID spaces for the same noun is
     a genuine trap — see `09-settings-and-admin.md`.

## Entity hierarchy the nav must express

`MCP` (verbatim from `adlabs://instructions`):

```
Organization → Team → Profile (Amazon advertising account)

Under each Profile:
  PPC: Portfolio (optional) → Campaign (SP/SB/SD) → Ad Group → Target / Search Term / Advertised Product
       Campaign also has: Placement (bid modifier), Audience (modifier), Negative Target
  DSP: DSP Campaign → DSP Ad Group
  Profile-level: Product (ASIN aggregate), Search Query (SQP — organic+paid, weekly)
```

Three structural facts that shape the nav:

- **Portfolios are not a fetchable entity.** `MCP` — "Portfolios are not a fetchable entity —
  scope campaigns with PORTFOLIO_ID/PORTFOLIO_NAME filters." So there is no Portfolio grid;
  portfolio is a *filter dimension* on the campaign grid. Our nav should do the same.
- **Placement and Audience are campaign-level modifiers, not child entities.** `MCP` They get
  their own grids anyway (a placement grid exists — 301 rows fetched on one test profile), but
  they hang off campaign, not ad group.
- **DSP and PPC are parallel branches that must never be mixed in one query.** `MCP` This
  argues for DSP as a separate top-level nav branch rather than an ad-type filter.

## Top-level sections

| # | Section | Evidence | What it holds | Spec file |
|---|---|---|---|---|
| 1 | Dashboards | `MCP` | Org-scoped custom dashboards: sections → tabs → widgets, per-tab overrides, public share links, dark mode | `03-dashboards.md` |
| 2 | Optimizer | `VID` `MCP` | Date-range picker + trend chart (daily/weekly toggle), campaign multi-select, "Optimize bids" → settings modal → preview table → apply | `04-optimizer.md` |
| 3 | Optimization Groups | `VID` `MCP` | Named campaign groups carrying target ACOS, prioritization, and all bid/placement limits | `04-optimizer.md` |
| 4 | Campaign Mapping | `URL` `MCP` | Source ad group → destination ad group routing for harvested search terms, with per-match-type bid settings and negation flags | `05-harvesting-and-campaign-maps.md` |
| 5 | Harvesting | `MCP` | Search-term promotion: preview (per search term × mapping) → apply | `05-harvesting-and-campaign-maps.md` |
| 6 | Data grids (Campaigns / Ad Groups / Targeting / Search Terms / Placements / Products / Advertised Products / Negatives / Audiences) | `MCP` `VID` | The entity tables. Infinite scroll, no pagination, drag-reorder + pinnable columns, persisted per-user presets | `02-data-grid.md` |
| 7 | Analyze | `MCP` + operator's own AdLabs-derived reporting standard, which cites "AdLabs Analyze > Placements" | Placement analysis, n-grams, brand-leak detection, audit summary scorecard | `07-sqp-ngrams-negatives.md`, `04-optimizer.md` |
| 8 | Search Query Performance (SQP) | `MCP` | Weekly Sunday–Saturday query data, per-ASIN share vs market total | `07-sqp-ngrams-negatives.md` |
| 9 | AMC (Amazon Marketing Cloud) | `MCP` | PRO-plan only. Query library (Q1a–Q8), custom SQL, schedules, audience library. Per-profile connection ("Profiles → Connect AMC") | `08-alerts-automations-dayparting.md` |
| 10 | Automations | `MCP` | Team-scoped bid rules and scheduling rules; status ON / PAUSED / DELETED | `08-alerts-automations-dayparting.md` |
| 11 | Dayparting | `MCP` | Named schedules, 7×24 bid-adjustment grid, assigned to campaigns | `08-alerts-automations-dayparting.md` |
| 12 | Data Groups (Tags) | `MCP` | Custom labels per entity type with coloured values, org-visible, profile-scoped | `06-tags.md` |
| 13 | Time Machine / Logs | `VID` `MCP` | Every job (manual + optimizer) with success/fail counts, note, author, and a one-click revert. Stored permanently | `04-optimizer.md` |
| 14 | Profiles | `MCP` | Per-profile Target ACOS / Target Total ACOS / target spend / target sales, sync status, AMC connect | `09-settings-and-admin.md` |
| 15 | Context Manager | `MCP` | Stored AI instructions at USER / ORGANIZATION / TEAM / BRAND / PROFILE scope, one "core context" per entity, 5000 char cap | `09-settings-and-admin.md` |
| 16 | Help / Messages | `VID` | "I need help" → Help (documentation incl. the "white box bidding algorithm" article) and Messages (live chat to the AdLabs team) | not specced — see skips |
| 17 | Goto links | `MCP` | `create_goto_link` produces a deep link that restores a result set in the UI | `10-goto-links.md` |

## Sections deliberately NOT specced, with reason

| Section | Why skipped |
|---|---|
| Help / Messages (#16) | Vendor support surface. Nothing to clone; we do not ship an in-app chat in v0. Its one artefact worth having is AdLabs' public "white box bidding algorithm" article, which documents their per-prioritization thresholds — that is competitive reading for WP-05, not a UI to build. |
| Billing / plan management | Never surfaced in any evidence path. Plan tiers are visible only as capability gates (`AMC ... available to all team members on a PRO plan` — `MCP`). Our billing is out of scope for v0 entirely. |
| Legacy Sponsored Brands | `VID`: "We don't support the legacy sponsored brand campaigns ... created before October 2022." Explicitly unsupported by AdLabs. We inherit the same exclusion; nothing to build. |
| Amazon TV ad type | Appears only as a `CAMPAIGN_AD_TYPE` filter value (`PRODUCTS, BRANDS, DISPLAY, TV` — `MCP`). No dedicated surface observed and no TV work in our book. Filter value only. |
| DSP screens | `MCP` confirms `dsp_campaign`, `dsp_ad_group`, and `dsp_flight` entities exist with their own filter schemas. Skipped for v0 because our own scope is SP/SB/SD; recorded here so the nav has a documented hole rather than an unnoticed one. |

## Verdicts

**Clone.**
- The query-string tenancy model (`?teamId=&profileId=`). It makes every screen profile-agnostic
  and makes deep links trivially shareable, which is exactly what the goto-link feature needs.
- The entity list as the nav's spine. Their nav is a direct projection of the entity hierarchy,
  which is why an operator can predict where anything lives.
- Portfolio-as-filter rather than portfolio-as-screen. One fewer grid to build and it matches
  how portfolios are actually used.

**Skip.**
- DSP branch, TV, legacy SB, in-app chat, billing — per the table above.
- A separate "Analyze" top-level section. Their analysis surface is a grab-bag (placements,
  n-grams, brand leak, audit scorecard) whose only common property is "computed, not fetched".
  We should attach each of those to the grid it analyses instead of building a fourth home for
  data the operator has already got open.

**Beat.**
- **Two ID spaces for "profile" is a defect, not a feature.** AdLabs' own MCP docs have to warn
  twice that dashboard `profile_ids` are "internal AdLabs IDs, not Amazon profile IDs" and that
  the internal ID is not even in the resource URI — you must read the resource body to find it.
  We should carry exactly one profile identifier through routes, links, and API.
- **Cross-profile work has no home.** Every screen is scoped to one `profileId`. An agency
  managing 15 profiles across 4 countries and 3 currencies (the operator's actual shape) has to
  visit 15 screens to answer "which accounts are off target this week". The profile-level
  entity exists in the API (`entity_type="profile"` returns metrics for *all* profiles) but the
  nav gives it no first-class surface. A portfolio-of-accounts home screen is the single
  clearest gap.
- **Nav does not expose the sync clock.** Profile freshness (`Sync status: completed / Last
  synced: <UTC timestamp>` — `MCP`) is buried in the profile resource. Every number on every
  screen is only as good as that timestamp, and the known behavior that same-day totals read
  zero while a day is in progress means a stale or in-progress sync silently produces a wrong
  answer that looks right. Surface last-synced in the chrome of every screen.
