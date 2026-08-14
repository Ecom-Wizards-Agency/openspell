# 09 — Settings: profiles, target ACOS levels, teams/users, MCP keys, Context Manager

**WP-11 recon · read-only.** No setting was changed. No MCP key was created, rotated, or viewed.
No context instruction was written or deleted. Live reads: `teams`, `profiles`, one profile
resource, and `get_context` was **not** called (it reads, but the stored content is client
context and this repo is public). All tenant identifiers below are redacted to placeholders.
No UI seen — see `BLOCKED.md`.

---

## 1. Tenancy model

```
Organization  (org_id)
  └── Team    (team_id)          ← the unit almost every API call is scoped to
        └── Profile              ← one Amazon advertising account
              └── Brand          (brand_id = an amzn1.ads-account.g.* identifier)
```

Confirmed live: a `teams` fetch returns the org name and `org_id`, then each team with its
member name and the list of profile names it can see.

Three facts that shape everything:

- **`team_id` is required on almost every call**; `profile_id` on almost every profile-scoped
  one. There is a mandated discovery order: `teams` → `profiles` → everything else, with an
  explicit instruction not to guess or hardcode either.
- **"The same profile may appear under multiple team IDs."** So the profile↔team relation is
  many-to-many. A profile is not owned by a team; it is visible to teams.
- **Dashboards break the pattern** — they are listed by `org_id` but created under a `team_id`
  (see `03-dashboards.md`). Two scoping rules in one product.

### Two ID spaces for "profile"

Called out here because it is the single most repeated warning in AdLabs' own documentation:

| ID | Where used | How to get it |
|---|---|---|
| **Amazon advertising profile ID** (long numeric) | `get_entity_data`, all grids, the UI's `?profileId=` query param | Inside the profile resource body |
| **Internal AdLabs profile ID** (numeric row ID) | `dashboards(create / update_settings / duplicate)` `profile_ids` | Also inside the profile resource body |

And the resource **URI** uses a third thing entirely — an opaque slug (`adlabs://profiles/<slug>`)
that is neither ID. The docs have to say, twice, that "the numeric profile ID is inside the
resource, not in the URI."

**Beat this.** One stable public identifier per profile, used in routes, links, API, and exports.

---

## 2. Profile settings

Exact field set, read live from a profile resource (values redacted):

```
Profile ID          <amazon numeric profile id>
Name                <profile name>
Country             <2-letter marketplace>
Currency            <ISO code>
Type                seller | vendor
Target ACOS         <percent>
Target Total ACOS   <percent>
Target Ad Spend     <currency amount>
Target Ad Sales     <currency amount>
Target Total Sales  <currency amount>
Brand ID            amzn1.ads-account.g.<...>
Brand Name          <brand>
Sync status         completed | ...
Last synced         <UTC timestamp>
```

Writable via `update_entities(entity_type="profile")`.

Two observations:

- **`Type: seller | vendor` is a profile-level switch that changes the available column set**
  across the whole product. Seller profiles get `total_sales` / `organic_sales` /
  `featured_offer_percent`; vendor profiles get `shipped_revenue` / `shipped_cogs` / `acogs` /
  `shipped_tacos` instead. Same grid, different columns, decided by one field.
- **`Sync status` and `Last synced` (UTC) live here and nowhere else.** Every number in the
  product depends on them and they are two levels down from any screen showing a number. Combined
  with the known behavior that same-day totals read zero while a day is in progress, a stale sync
  produces a plausible wrong answer. **Surface last-synced in the chrome of every screen** — this
  is the same argument made in `01-navigation-map.md` and it is the recurring theme of this recon.
- The list of profiles also carries `is_amc_connected` (added 2026-08-04) so integration
  eligibility is visible without attempting a call. Right pattern; see
  `08-alerts-automations-dayparting.md` §5.

---

## 3. Target ACOS: four configuration levels

This is the most important structural finding in this file. Target ACOS is set in **four** places,
in three different units, with resolution rules that are only partly documented.

| Level | Field(s) | Unit | Scope |
|---|---|---|---|
| **Profile** | `Target ACOS`, `Target Total ACOS`, plus `Target Ad Spend`, `Target Ad Sales`, `Target Total Sales` | percent (`30.0%`) | Whole account. Also the reference for the `ACOS_TO_TARGET` filter and for `acos_to_target` style comparisons |
| **Product (ASIN)** | `target_acos`, `target_acots`, `target_ad_sales`, `target_ad_spend`, `target_total_sales`, `target_shipped_cogs`, `target_shipped_rev` | columns on the product grid | Per ASIN. Writable via `update_entities(entity_type="product")` — "updating target goal values" |
| **Optimization group** | `tacos` | **decimal fraction** (`0.25`) | The campaigns assigned to the group |
| **Optimizer run** | `tacos` | **decimal fraction** | This run only |

Resolution at run time (`04-optimizer.md` §4): group value if set → else the run value; ungrouped
campaigns always use the run value; `override_group_settings=true` makes the run value win
everywhere while still using the group as a data pool.

What is **not** documented on any evidence path: how the *profile* target and the *product*
targets interact with the optimizer's group/run resolution. The profile target visibly drives
`ACOS_TO_TARGET` filtering and `target_acos` in aggregates; whether it is a fallback for
optimization is unstated. Recorded as an open question rather than guessed.

Also note `Target Total ACOS` (TACOS, i.e. against total sales rather than ad sales) exists at
profile level and as `target_acots` at product level — but the **optimizer only takes `tacos`
(ad ACOS)**. So the total-ACOS target is a reporting and filtering concept, never an optimization
input. For a business actually managed to TACOS, that is a meaningful disconnect.

**Verdicts on this specifically:**

- **Clone:** targets as a hierarchy with a documented resolution order, and target-relative
  filters (`ACOS_TO_TARGET`) that are portable across profiles and currencies.
- **Skip:** two units for one quantity (percent at profile/product, decimal fraction at
  group/run). One unit, everywhere.
- **Beat:** (a) publish the full resolution order including profile and product levels, and show
  the *effective* target on every row that is optimized — the preview already has room for it and
  already shows group target ACOS; (b) let the optimizer take a total-ACOS target, since that is
  what several of these accounts are actually managed to.

---

## 4. Users and teams

Direct user-management surface found in this recon:

| Surface | What it does |
|---|---|
| `dashboards(add_collaborator / remove_collaborator)` | Grant or revoke a user's access to a dashboard, by **AdLabs user ID**. `get_structure` lists current collaborators |
| `created_by` | On automations and dayparting schedules |
| `username` | On every job-log row, beside `automation_name` — human or machine, per job |
| Team membership | Implicit: `teams` returns the teams the authenticated user belongs to; "Must be a team you are a member of" gates dashboard creation and share-link creation |

### The real settings surface — `UI-verified`, session 3

Reached via the sidebar footer **Settings** → a popover (Organization name · **Settings** ·
**Subscription & Billing** · **Dark Mode** toggle · signed-in user · sign out), then a four-tab
page at `/configuration/settings/*`:

| Tab | Route | Holds |
|---|---|---|
| **Personal** | `/user` | Organization Details (org name, `Update Organization`) · User Details (e-mail **read-only**, first/last name) · Update Password · **Multi-Factor Authentication (MFA)** via TOTP · **MCP API Key** (see §5) |
| **Teams** | `/teams` | The team admin grid (below) |
| **Advanced** | `/advanced` | Feature flags (below) |
| **Dashboards** | `/dashboards` | The **white-label** surface — see `03-dashboards.md` §White-label |

MFA is TOTP-based and gated on email verification (*"You must verify your email address before
enabling MFA"* + `Send Verification Email`). Note the shape: **org name lives on the Personal
tab**, which is a small but real information-architecture error worth not copying.

### Teams tab

Banner: *"Each team has separate billing. To share billing across profiles, add them to the same
team."* — so **team is the billing boundary**, and that is why an agency ends up with one team.

`+ Create New Team`, and a grid with columns:

```
Organization  Name  Team Owner  Amazon Auth  Plan  # of profiles
Daily sync time  Timezone  Members  Actions
```

- `Plan` renders as a badge (`Pro`).
- `Amazon Auth` is the authorising Amazon account e-mail — one LWA identity per team.
- `Daily sync time` and `Timezone` are **team-level** and editable inline. This is the clock that
  `08-alerts-automations-dayparting.md` §1 shows automations run against.
- `Members` is an avatar stack; `Actions` holds `✎ Members` and `🗑 Delete`.

### The role model — **exactly two roles**

`✎ Members` opens a **Manage Members** modal: `+ Add New Member`, then rows of
`MEMBER · EMAIL · ROLE · ACTIONS`.

- The owner row carries a non-editable **`⭐ Owner`** badge, the subtitle *"Primary billing and
  team owner"*, and a disabled delete.
- Every other member is subtitled *"Team member"* and carries a **ROLE dropdown**.
- Opening that dropdown reveals the entire role vocabulary: **`Admin (current)` (disabled) and
  `Owner — "Transfer ownership to this member"`**.

**So there are two roles, Owner and Admin, and the only role operation is ownership transfer.**
Every non-owner is an Admin with full write access to every profile in the team. This
**confirms** the session-1 inference and removes its hedge: there is **no read-only role, no
viewer, no client user, no per-profile permission, and no seat concept**. It is not UI-only and
invisible to MCP — it genuinely does not exist. This area is no longer partial coverage.

For an agency with staff, contractors and clients that is a real problem: you cannot give a
client a login, and you cannot give a junior a look-but-don't-touch seat. The only lever is
excluding them from the team entirely, which also excludes them from the billing boundary.

### Advanced tab — feature flags

Screenshot: `screenshots/10-settings-advanced-feature-flags.png`. Banner: *"Use with caution:
These settings are for advanced users only. Make sure you understand what each setting does
before enabling it."*

| Flag | Default | Description (verbatim) |
|---|---|---|
| **Placement Mod** | **off** | *"Enable editing placement modifiers for campaigns (new columns and bulk edit actions)"* |
| **Delta Filters** | **off** | *"Enable delta filtering options (%, #) for metric filters to compare changes between time periods"* |

Both matter to earlier specs:

- **Delta filters are not part of the base filter grammar** — they are an opt-in flag, and the
  automation builder warns you must reload the page after enabling it before they appear in the
  filter list. `02-data-grid.md` should not present delta filters as always-available.
- **Placement-modifier editing is off by default**, which is why `placement_mod` reads as a
  passive column rather than an editable one.

**Skip this pattern.** Two org-wide boolean flags, defaulted off, hidden behind a "use with
caution" banner, that silently change which filters and columns exist — with no per-user
override and no indication anywhere else in the product that a capability is being withheld.
Either a feature is ready or it is not.

Attribution, by contrast, is good: every job carries `username`, every mutating action requires a
`note`, and several action docs say outright *"if the goal or intention of the change is not
clear, ask the user."* **Clone the attribution discipline wholesale.** Who, what, when, and why,
on every bulk change, with no way to skip the why.

---

## 5. MCP key management

### The screen — `UI-verified`, session 3

**Settings → Personal → MCP API Key.** No key was generated; the button was not clicked.

The entire surface is three elements:

> **MCP API Key** — *"Use this key to authenticate MCP (Model Context Protocol) integrations.
> Keep it secret."*
> ⓘ *"MCP access is disabled. Generate a key to enable it."*
> **[ Generate Key ]**

That is all of it. **No scope selector, no per-profile picker, no read-only option, no expiry, no
rotation control, no last-used timestamp, and no key list** — a single button that turns on full
access. The key is **per user** (it sits on the Personal tab, not on the team), which matches the
contract's "authenticates as a user" behaviour, so one key inherits that user's access to every
profile in every team they belong to.

MCP access is also **off until you press it**, which is a reasonable default and the only
guardrail present.

This **confirms** everything inferred below and closes `00-INDEX.md`'s "MCP key management
screen" gap. There is also a separate **AI → MCP `[BETA]`** nav item for the integration itself;
key issuance lives only here.

### What the contract already told us

What can be stated from the evidence:

- The MCP server authenticates as a **user**, not as a profile or team: `teams` "lists all teams
  the authenticated user belongs to", `get_context` for `USER` "automatically uses the
  authenticated user", and `create_link` / `create` are gated on team membership. So a key
  carries a user's full team-scoped access.
- No scoping, expiry, rotation, or per-key permission concept appeared anywhere in the contract.
- No read-only key concept. The same session that reads a grid can apply an optimization, create
  negatives, and delete a dashboard. **The only thing standing between a read and a write is the
  caller's discipline.**

**Beat.** Scoped keys are table stakes for an agent-driven product: read-only vs read-write,
per-profile or per-team scoping, expiry, rotation, last-used timestamp, and a per-key audit trail
in the same job log that already records `username`. Given that this whole product is designed to
be driven by an LLM, a key that cannot be issued read-only is the wrong default.

Worth noting how carefully the MCP contract compensates for the missing technical guardrail with
procedural ones: *"Before update_entities, summarize what will change and how many entities are
affected, then get explicit user confirmation"*, plus mandatory notes, plus preview-then-apply on
every destructive path. Good instincts, but instructions in a prompt are not a permission model.

---

## 6. Context Manager

A first-class stored-instruction system — this is AdLabs' "AI memory" surface.

### Model

| Aspect | Detail |
|---|---|
| Scopes | `USER`, `ORGANIZATION`, `TEAM`, `BRAND`, `PROFILE` (BRAND is keyed by `ads_account_id`) |
| Cardinality | **Exactly one "core context" per entity** |
| Size | **5000 characters** max; longer merged content must be compacted |
| Write semantics | `set_core_context` **overwrites** — "the previous content will be permanently replaced". To update you must `get_context` first and merge by hand |
| Delete | `delete_context(instruction_id)` — "cannot be undone", confirm first |
| Search | `context_and_prompts(search)` covers docs, guides, filter schemas, **and** the user's accessible instructions and prompts, returning ranked TSV |

### How context is delivered

This is the clever part and it is worth copying:

- **ORG-level instructions are embedded inline in the `teams` response.**
- **TEAM-level instructions are embedded inline in the `profiles` response.**
- **PROFILE-level instructions are embedded inside the profile resource.**

So context arrives **attached to the data it qualifies**, at the moment you fetch that data.
There is no separate "load my instructions" step to forget. Confirmed live: the `profiles` fetch
returned a `<team_context>` block ahead of the profile table.

**Clone this delivery pattern exactly.** An agent that fetches profiles cannot fail to receive
the team's operating rules, because they are in the same response. That is a far better design
than a system prompt the caller has to remember to load.

### Scope discipline

`MCP` insists: *"Always use the MOST SPECIFIC entity type that applies. If the conversation is
about a specific profile, use PROFILE level (not team). If about a team, use TEAM level (not
org)."* And `set_core_context` is named the default action for any memory change, with
`get_context` required first to check for existing content.

### Problems

- **Overwrite semantics on a single 5000-char blob** is the weakest part. Merging is the caller's
  job, there is no versioning, and one careless write destroys accumulated context. Contrast
  again with `configure_widget`'s merge patch — three different update semantics now catalogued
  in this product (merge patch, PUT-with-warning, and destructive overwrite).
- **One core context per entity** means an org's rules, a team's reporting standard, and a
  client's quirks all compress into one string per level. Live evidence: the team context read
  during this recon was a dense multi-paragraph reporting standard occupying a substantial share
  of the 5000-character budget at a single level.
- **No versioning, no diff, no attribution** on context, despite `created_by` and `username`
  existing elsewhere.

**Beat.** Multiple named, composable instruction documents per scope; append and patch rather
than overwrite; version history with attribution; and a resolved-context view showing which
scopes contributed what to the final instruction set for a given call.

---

## 7. Verdicts

**Clone.**
- The Organization → Team → Profile → Brand hierarchy, with mandated discovery order and an
  explicit "never guess or hardcode IDs" rule.
- Profile-level `Type: seller | vendor` switching the available column set.
- `Sync status` + `Last synced` (UTC) as first-class profile fields, and `is_amc_connected` as a
  profile column so integration eligibility is visible without a call.
- A target hierarchy (profile → product → group → run) with a documented resolution order.
- Target-relative filters (`ACOS_TO_TARGET`, `DAILY_SPEND_TO_BUDGET`) that are portable across
  profiles and currencies.
- Attribution discipline: `created_by`, `username` on every job, mandatory `note` on every
  mutation, and "ask the user if the intent is unclear."
- **Context delivered inline with the data it qualifies** — org context on `teams`, team context
  on `profiles`, profile context on the profile resource.
- Scope discipline: always write context at the most specific applicable level.
- A search that spans docs, schemas, and the user's own stored instructions together.

**Skip.**
- Three identifiers for one profile (Amazon ID, internal ID, resource slug), with the docs warning
  about it twice.
- Two units for target ACOS (percent vs decimal fraction) in one product.
- Org-scoped listing with team-scoped creation for dashboards.
- Destructive overwrite as the default write semantic for accumulated context.
- Unscoped, non-expiring, read-write-by-default API keys in a product designed for agents.

**Beat.**
1. **Scoped API keys.** Read-only vs read-write, per-profile scope, expiry, rotation, last-used,
   and per-key entries in the existing job log. A prompt instruction is not a permission model.
2. **One profile identifier**, everywhere.
3. **A real permission model** — roles, read-only users, and a client-user that can see one
   dashboard and nothing else. Currently: team membership plus per-dashboard collaborators.
4. **Composable, versioned, attributed context** instead of one 5000-character overwrite per
   scope, with a resolved-context view.
5. **Publish the full target-ACOS resolution order** and show the *effective* target on every
   optimized row; let the optimizer accept a total-ACOS target, since several accounts are
   managed to TACOS and the field already exists at profile and product level.
6. **Last-synced in the chrome of every screen.** It is the precondition for trusting every number
   in the product and it currently lives two levels down in a resource body.
