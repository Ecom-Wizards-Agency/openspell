# 03 — Dashboards: widgets, periods, drill-downs, share / white-label

**WP-11 recon · read-only.** Structure below is exact: it comes from the live
`adlabs://docs/dashboard_actions` contract, which is the same object model the UI edits. No
dashboard was created, modified, shared, or deleted. Visual layout was not verified — see
`BLOCKED.md`.

---

## 1. Object model

```
Organization
  └── Dashboard            (org-scoped; created under a team; has profiles, currency, week start)
        └── Section        (top-level group of tabs; ordered)
              └── Tab      (ordered; carries per-tab overrides)
                    └── Widget   (placed on a 192-unit-wide grid canvas)
```

Every level is addressed by UUID except the dashboard itself, which uses an integer ID.

**Dashboards are org-scoped, not team-scoped.** `list` takes `org_id`, not `team_id`. But
`create` takes `team_id` (the team it is created *under*). So visibility is org-wide while
ownership is team-level. That split is worth noting before we copy it — it is the kind of thing
that produces "why can they see my dashboard" tickets.

### Dashboard-level settings

| Setting | Notes |
|---|---|
| `title` | |
| `profile_ids` | Comma-separated **internal AdLabs** profile IDs. Not Amazon profile IDs. A dashboard spans multiple profiles. |
| `currency_code` | e.g. USD, EUR. One currency per dashboard — cross-currency profiles are converted, not shown natively. |
| `first_day_of_week` | `MONDAY` (default) or `SUNDAY` |
| `date_range` | `{"start":"YYYY-MM-DD","end":"YYYY-MM-DD"}` — the default for all tabs |
| collaborators | Per-user grant/revoke by AdLabs user ID |

**`profile_composition` is a derived property of the profile set** and it determines which metric
variants are legal. Selling-partner metrics exist in three variants — `seller_*`, `vendor_*`,
and `seller_vendor_combined_*` — and only the variant matching the dashboard's composition
returns data. Changing `profile_ids` can therefore invalidate every widget on the dashboard.
AdLabs handles this by auto-converting mismatched variants and reporting back
`metric_conversions`. That auto-conversion-plus-disclosure pattern is good and we should copy it.

---

## 2. Periods and comparisons

Three levels, each overriding the one above:

1. **Dashboard default** — `date_range` set at create or update time.
2. **Tab override** — `dateRangeOverride` in the tab's `overrides` object.
3. **Widget** — inherits from its tab.

The override object is a single JSON blob with these keys (camelCase):

```
dateRangeOverride   currencyCode   profileIds   dspAttributionConfig
campaignFilters     adGroupFilters   placementFilters   targetFilters
productFilters      searchTermFilters   dspCampaignFilters   dspAdGroupFilters
```

Two things stand out:

- **A tab can override the profile set and the currency, not just the date.** So one dashboard
  can hold a "US" tab and a "DE, in EUR" tab. For a multi-market agency that is the difference
  between one client dashboard and five.
- **Every entity level gets its own filter array on the tab**, using the *same* `FilterKey`
  enum as the grid (`PRODUCT_ASIN`, not a bare `ASIN`). One filter vocabulary across grid,
  dashboard, and API. This is the strongest single design decision in the product and the one we
  should copy hardest: an operator who learns the filter language once can use it everywhere.
- The matching `is*OverrideEnabled` flags are set **automatically** whenever a value is present.
  The caller never manages the boolean separately. Small thing; removes a whole class of "I set
  the value but forgot the flag" bugs.

Comparison periods are not a dashboard-level concept — they come from the underlying metric
model, where every metric carries `_comparison`, `_delta_absolute`, and `_delta_percent`
variants (see `02-data-grid.md`). A widget showing a delta is showing a column, not running a
second query.

---

## 3. Widgets

### Placement model

Widgets sit on a **192-unit-wide grid canvas** with `{x, y, w, h}`. Each widget type declares
default, minimum, and maximum sizes; sizes outside the range are **clamped and the clamping is
reported back**.

Placement is expressed semantically rather than as raw coordinates:

| Placement | Meaning |
|---|---|
| `"append_row"` (default) | New row below all content, at x=0 |
| `"append_inline"` | Fill gaps in existing rows |
| `{"below": "<widget_id>"}` | |
| `{"right_of": "<widget_id>"}` | |
| `{"replace": "<widget_id>"}` | Removes that widget |
| `{"absolute": {"x": N, "y": N}}` | Escape hatch |

`set_layout` applies several placements in **one atomic write**, and items are applied in order
so later items see the effect of earlier ones. That ordering guarantee is what makes scripted
layout deterministic.

**Clone the semantic placement vocabulary.** It is the difference between a dashboard an agent
can build correctly and one it can only build by trial and error. `{"right_of": id}` is a
statement of intent; `{x: 96, y: 24}` is a guess that breaks the moment anything above it
resizes.

### Widget types

Named types confirmed in the contract: `MetricWidget`, `ComboGraphWidget`, `TableWidget`. The
full list is enumerated at runtime by `list_widget_types`, which also returns each type's
default / min / max size.

Two types are **explicitly not creatable through the API**: AMC widgets and custom-table
widgets, "because they need a data source configured in the UI." So the UI is strictly more
capable than the API here. Worth noting as a thing we should *not* replicate: if a widget can
exist, it should be expressible in the API.

### Widget configuration

```
entityType        "PROFILE" | "CAMPAIGN" | "AD_GROUP" | "PRODUCT" | ...
selectedMetric    single-metric widgets
selectedMetrics   multi-metric widgets
title
isConfigured
<entity>Filters   FilterKey-keyed arrays, same enum as the grid
```

Metric names are validated per entity type via `list_metrics`, which returns each metric with an
`is_percent_scale` flag — so the renderer knows to format `24.3` as `24.3%` rather than
guessing from the name. Clone that: carrying scale as data rather than inferring it from a
suffix is how you stop a dashboard from showing "2430%".

`configure_widget` is a **merge patch**: omitted fields keep their values, and explicit nulls on
defaulted fields are ignored and reported back as `ignored_null_keys`. Contrast with
`optimizer(update_group)`, which is documented as PUT semantics where "omitting an optional
field silently resets it to its default". **Two different update semantics in the same product.**
That inconsistency is a bug factory; we should be PATCH everywhere and say so.

### Building a widget correctly (the documented recipe)

1. `list_widget_types` → valid types and sizes.
2. `list_metrics(entity_type, dashboard_id)` → valid metrics *for this dashboard's profile
   composition*.
3. `get_widget` on an existing widget of the same type → a complete config to use as a template.
4. `add_widget` with `config` + `placement` + optional `size`.

Step 3 is telling: the recommended way to learn a widget's full config is to read an existing
one, because the field set is type-specific and not otherwise enumerated. That is a
discoverability failure we can beat with a typed schema per widget type.

---

## 4. Drill-downs

No drill-down action exists in the dashboard contract. The dashboard is a **read/display
surface**; navigating from a widget into the underlying rows is not part of its object model.

The mechanism that fills this role is the **goto link** (`create_goto_link`), which produces a
deep link into the AdLabs UI restoring a result set — see `10-goto-links.md`. Analysis tools
(`read`, `group_by_column`) auto-attach one; the optimizer preview and the campaign-mapping list
both return an explicit "View in AdLabs" link.

So AdLabs' drill-down story is: *the thing that produced the number hands you a link back to the
rows*. That is a good pattern for tool-driven flows and a poor one for a dashboard a client is
looking at, where the natural gesture is clicking the number.

- **Beat:** click-through from any widget to the filtered grid behind it, carrying the widget's
  entity type, filters, date range, and profile set. We already have a filter vocabulary shared
  between widget and grid, which is exactly what makes this cheap for us and would have been
  cheap for them.

---

## 5. Sharing and white-label

### Share links

| Action | Behavior |
|---|---|
| `create_link` | Creates a public share link; returns a token and share URL. **Anyone with the URL can view the dashboard without logging in.** Scoped/billed to a team. |
| `list_links` | Lists tokens, share URLs, and `dark_mode` flags. A dashboard can have **many** links. |
| `update_link` | `dark_mode` is the **only** updatable field. |
| `remove_link` | Deletes a link, immediately invalidating its URL. Takes the *link* ID, not the dashboard ID. |

### What the sharing model actually is

- **Unauthenticated, token-in-URL, no expiry, no password, no view log.** Possession of the URL
  is the entire authorization model.
- **Multiple links per dashboard** — the only reason to have several is to revoke one without
  breaking the others. So per-recipient links are the intended pattern, but nothing in the model
  records *who* a link was for. There is no label field on a link.
- `dark_mode` per link. So the same dashboard can be served light to one recipient and dark to
  another.

### White-label — **CORRECTED: it exists, and it is thorough**

> **This section previously said "No white-label capability was found on any evidence path."
> That was wrong**, and it was the single biggest error in the recon. White-label is an
> **organization setting**, not a property of the dashboard object — which is exactly why it is
> invisible to the dashboard contract that session 1 read.

#### The surface — `UI-verified`, session 3

**Settings → Dashboards** (`/configuration/settings/dashboards`), headed
*"EDIT SETTINGS FOR ORGANIZATION:"*. Screenshots:
`screenshots/11-white-label-domain-logo-icon.jpg`, `screenshots/12-white-label-color-palette.jpg`.

| Setting | Detail (verbatim where quoted) |
|---|---|
| **Connect your own domain** | *"Share Dashboards with your own branding — no more 'adlabs.app' URLs."* A `Domain` field (placeholder `dashboards.my-agency.com`), a `Start Setup` button, and a "Learn how to connect a subdomain" doc link. |
| **Custom Logo** | *"Upload a custom logo for your external Dashboards. Maximum size is **1.5MB**."* `Select Logo` / `Remove Logo`. |
| **Custom Icon** | Favicon for external dashboards. Max **100KB**, *"Recommended size is 32x32 or 64x64 pixels."* |
| **Custom Color** | Brand/accent colour — swatch picker **plus a hex field** (default `#155dfc`). |
| **Custom Graph Color Palette** | **Eight** chart series colours, each a swatch + hex field, with `Update Palette` and a reset-to-defaults path. Defaults: `#0284c7 · #E97B20 · #10b981 · #586182 · #8b5cf6 · #ec4899 · #84cc16 · #ef4444`. |

The dashboards list page carries a **`⚙ White-label Sharing Settings`** button pointing here, and
the banner *"You can share each dashboard with your customers via a unique link"*.

#### The rendered share view — `UI-verified`

A live share link was opened (read-only). Findings:

- URL shape: **`https://dashboard.adlabs.app/external/dashboard/<token>`**, where the token is a
  ~128-character mixed-case alphanumeric string. Unauthenticated, as the contract says. (Token
  not recorded here — this repo is public.)
- **Zero AdLabs branding.** No logo, no footer, no "powered by", no attribution anywhere in the
  accessibility tree. The agency's own logo renders in the sidebar footer. The browser tab title
  is the generic *"Dashboard"*.
- Chrome observed: dashboard name as the sidebar heading; the date range **with its comparison
  period beneath it**; a **`Download PDF`** button; and a collapsible section → tab tree
  (`General → Overview`) matching the object model in §1.
- The widget canvas rendered stat tiles with comparison values and deltas, a **gauge/meter widget
  with a target marker** (a "TACOS Meter" showing target vs actual on an arc), a dual-axis
  combo chart, and a donut — i.e. the widget catalogue in §3 renders in the share view unchanged.

**`Download PDF` on the client-facing view is a real finding** and is not in the MCP contract at
all: the share link is not just a page, it is a self-serve report export.

#### What is still missing — the narrowed beat

The branding half of the old beat is **retired**: logo, favicon, palette, accent colour and a
custom domain all exist, and the output carries no vendor marks. What remains missing is the
**link governance** half, and it is unchanged:

| Still absent | Consequence |
|---|---|
| Named recipient per link | Multiple links per dashboard exist solely so you can revoke one, but nothing records who it was for. There is no label field. |
| Expiry | A link lives forever until manually removed. |
| Passcode / any second factor | Possession of the URL remains the entire authorization model. |
| View log | No "client opened this 3 times before the call". |
| Locked date range | A client can wander into a bad month. |
| Per-link branding | Branding is org-wide, so a single agency cannot present differently to two clients. |

- **Beat, restated.** Not "build white-label" — theirs is good and should be cloned closely,
  including the eight-colour chart palette, the favicon, the PDF export and the vendor-mark-free
  output. Beat them on **the link as a governed object**: named recipient, expiry, passcode,
  view log, locked range, and branding resolvable per link (or per client) rather than only per
  organization.

---

## 6. Duplication and reuse

- `duplicate` (dashboard) — copies all sections, tabs, and widgets under fresh IDs, keeping
  currency, first day of week, and collaborators. Optionally re-points `profile_ids`.
- `duplicate_tab` — clones a tab with all its widgets into the same or a different section.
- `clone_widget` — copies a widget within its tab or into another tab of the same dashboard,
  keeping size, optionally applying a config patch and new title.

`duplicate(dashboard_id, profile_ids=<new set>)` is the multi-client template mechanism: build
one client dashboard, duplicate it per profile. It works, but it is a **copy, not a
subscription** — there is no template object, so a change to the "master" never propagates and
15 client dashboards drift apart from the day they are created.

- **Beat:** a real dashboard template with live instances. Edit the template, every client
  dashboard updates. For an agency this is the difference between a reporting product and 15
  copies of last quarter's layout.

---

## 7. Verdicts

**Clone.**
- Sections → tabs → widgets, with per-tab overrides of date range, currency, **profile set**,
  and per-entity filters.
- One `FilterKey` vocabulary shared by grid, dashboard widget, and API.
- Semantic placement (`below`, `right_of`, `replace`, `append_inline`) over raw coordinates, plus
  atomic ordered `set_layout`.
- Size clamping that reports what it clamped; metric-variant auto-conversion that reports what it
  converted. Correct-and-tell-me beats reject-and-explain for layout work.
- `is_percent_scale` carried as metric metadata rather than inferred.
- `duplicate` / `duplicate_tab` / `clone_widget` for fast composition.
- Auto-managing the `is*OverrideEnabled` flags from value presence.
- **The whole white-label stack** (`UI-verified`): org-level custom domain, logo, favicon, accent
  colour, and an **eight-colour chart palette** with hex entry — plus a share view that carries
  **no vendor branding at all** and a **`Download PDF`** button for the client.
- **Comparison period rendered under the date range** in the share view, so a client sees what
  "-12%" is measured against without asking.

**Skip.**
- Org-scoped visibility with team-scoped creation. Pick one scope.
- The internal-vs-Amazon profile ID split (see `01-navigation-map.md`).
- Widget types that exist in the UI but cannot be created through the API. If we ship a widget,
  it is expressible in the API on day one.
- PUT semantics anywhere. `configure_widget` already proves they know the merge-patch pattern.

**Beat.**
1. ~~**White-label.**~~ **CORRECTED — it exists and it is good.** Custom domain, logo, favicon,
   accent colour, an eight-colour chart palette, a vendor-mark-free share view, and `Download
   PDF`. **Moved to Clone** — see the Clone list above. What survives of this item: branding is
   **org-wide only**, so one agency cannot present two clients differently.
2. **Real sharing.** Named recipients, expiry, optional passcode, revocation per recipient, a
   view log, and a locked date range. Today: an unauthenticated ~128-char token in a URL, forever,
   with no record of who has it. **This half of the old beat stands unchanged** and is now the
   whole of it.
3. **Click-through drill-down** from widget to the filtered grid behind it. The shared filter
   vocabulary makes this nearly free and they did not do it.
4. **Templates with live instances**, not duplication. Fifteen client dashboards should be one
   object.
5. **Native multi-currency.** One `currency_code` per dashboard forces conversion for an agency
   whose profiles span USD, EUR, CAD, and AUD. Show native and converted, and say which is which.
