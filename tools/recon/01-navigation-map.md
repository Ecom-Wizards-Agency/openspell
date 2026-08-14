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

## The real nav — `UI-verified`, session 3

The nav is a **collapsed icon rail that expands on hover**, with six collapsible groups plus a
pinned footer. Screenshot references: the rail was read live; no capture is stored because the
expanded rail is clean but the pages behind it are not (see `README.md`'s public-repo rule).

```
Search                              ⌘K
Getting Started                     /getting-started

Insights            ▾
  Profiles Overview                 /profiles-overview
  Products Overview
  Custom Dashboards                 /dashboards/overview

Optimize            ▾
  Campaign Optimizer                /optimizer          (page title: "Bid Optimizer")
  Optimization Groups
  Time Machine
  Dayparting

Search Terms & Targeting  ▾
  Search Terms
  SQP Reports
  Targeting
  Negative Targeting
  KW Harvesting Map

Analyze             ▾
  Advertised Products
  Placements
  Ad Groups
  Audiences
  Tags
  Change Logs

AI                  ▾
  MCP                               [BETA]
  Context Manager                   [BETA]

— footer —
Report a Bug
Become an Affiliate
Amazon Ads Masterclass
AdLabs Roadmap
Manage Profiles                     /profiles
Manage Teams                        /configuration/settings/teams
Settings                            → popover: Settings / Subscription & Billing / Dark Mode / <user> / sign out
```

### Corrections this forces on the session-1 list

| Session-1 claim | Reality (`UI-verified`) |
|---|---|
| 17 flat top-level sections | **6 collapsible groups** (Insights, Optimize, Search Terms & Targeting, Analyze, AI) + Getting Started + a footer block. Grouping and naming were both wrong. |
| "Dashboards" is a top-level section | It is **Insights → Custom Dashboards**. |
| "Optimizer" | It is **Optimize → Campaign Optimizer**; the page's own H1 is **"Bid Optimizer"**. Three names for one screen. |
| "Campaign Mapping" and "Harvesting" are two sections | One nav item: **Search Terms & Targeting → KW Harvesting Map**. |
| "Data grids" is one section | The grids are **split across two groups**: Search Terms / Targeting / Negative Targeting under *Search Terms & Targeting*; Advertised Products / Placements / Ad Groups / Audiences under *Analyze*. There is **no "Campaigns" nav item at all** — the campaign grid *is* the Campaign Optimizer page. |
| "Analyze" holds n-grams, brand leak, audit scorecard | Analyze holds **entity grids** (Advertised Products, Placements, Ad Groups, Audiences, Tags, Change Logs). No n-gram, brand-leak or audit-scorecard nav item exists. |
| "Time Machine / Logs" | Two separate items in two groups: **Optimize → Time Machine** and **Analyze → Change Logs**. |
| "Data Groups (Tags)" | Named simply **Tags**, under Analyze. |
| "AMC" is a top-level section | **No AMC nav item exists** on this org. AMC surfaces only as a `Connect AMC` button on `/profiles`. |
| **"Automations" is a top-level section** | **There is no Automations item in the nav.** The page exists and is fully functional at **`/automations`**, but it is unlinked from the navigation and does not appear in ⌘K search results either (searching "automation" returns only "Search help docs for…"). See `08-alerts-automations-dayparting.md`. |
| "Profiles" is a nav section | **Two different screens**: `Manage Profiles` (`/profiles`, the admin list) in the footer, and `Insights → Profiles Overview` (`/profiles-overview`, the cross-profile performance grid). |
| "Context Manager" is top-level | It is **AI → Context Manager**, tagged `[BETA]`, alongside **AI → MCP** `[BETA]`. |
| Billing "never surfaced" | **Subscription & Billing** is in the Settings popover, and each team carries a `Plan` badge. |

### Newly discovered surfaces not in any prior spec

| Surface | Note |
|---|---|
| **Getting Started** (`/getting-started`) | Landing page. Global search box ("Search pages, profiles, actions…", ⌘K), three quick-launch chips (Campaign Optimizer / Products Overview / AdLabs Academy), and a tutorial-video wall. |
| **Global ⌘K search** | Searches pages, profiles and actions. Notable negative result: it does **not** index the Automations page. |
| **Insights → Profiles Overview** | The cross-profile portfolio grid. Carries Target ACOS, Target TACOS, ACOS, TACOS, Ad Sales % of Total, Last 30d Total Sales, Last 30d Ad Sales **and a currency selector that normalises across profiles**. Materially weakens the session-1 "cross-profile work has no home" verdict — see Verdicts below. |
| **Insights → Products Overview** | Product-level rollup; also a Getting-Started quick-launch chip. |
| **AI → MCP** `[BETA]` | In-app surface for the MCP integration. Key generation itself lives in Settings → Personal → MCP API Key. |
| **Dark Mode** | Global app-level toggle in the Settings popover (not just a dashboard-share flag). |
| **Sync clock in the top bar** | Every profile-scoped page shows `Sync · <time> <GMT offset>` in the header, plus a manual refresh button next to the profile switcher. Partially answers the session-1 "nav does not expose the sync clock" beat. |

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
- **The nav has an orphan.** A complete, working, cross-profile Automations product sits at
  `/automations` with no nav entry and no search-index entry. Two prior recon sessions and the
  MCP contract both failed to locate it. Whatever we build, every surface gets a nav home.
- **Three names for one screen** (`Optimize → Campaign Optimizer` / URL `/optimizer` / H1
  "Bid Optimizer"), and two screens called some form of "Profiles". Pick one noun per surface.
- **Two ID spaces for "profile" is a defect, not a feature.** AdLabs' own MCP docs have to warn
  twice that dashboard `profile_ids` are "internal AdLabs IDs, not Amazon profile IDs" and that
  the internal ID is not even in the resource URI — you must read the resource body to find it.
  We should carry exactly one profile identifier through routes, links, and API.
- ~~**Cross-profile work has no home.**~~ **CORRECTED, session 3.** `Insights → Profiles
  Overview` *is* a portfolio-of-accounts home screen, and it normalises currency across
  profiles via a `$ USD` selector. Automations are cross-profile too (multi-select profile
  picker). The narrower and still-true version of this beat: **cross-profile stops at
  read-only overview and rule scope.** Grids, the optimizer, campaign maps, dayparting and tags
  are all still single-profile, and there is no cross-profile *saved view*. Aim at those, not
  at "they have no portfolio screen" — they do.
- **Nav does not expose the sync clock.** Profile freshness (`Sync status: completed / Last
  synced: <UTC timestamp>` — `MCP`) is buried in the profile resource. Every number on every
  screen is only as good as that timestamp, and the known behavior that same-day totals read
  zero while a day is in progress means a stale or in-progress sync silently produces a wrong
  answer that looks right. Surface last-synced in the chrome of every screen.
