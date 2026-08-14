# RESOLVED — the AdLabs UI walkthrough ran in session 3

**Status: UNBLOCKED.** Sessions 1 and 2 could not reach a browser at all; this file recorded why.
**Session 3 (14.08.2026) connected successfully and executed the entire six-item priority list.**

The historical record below is kept intact — the diagnosis in §Session 2 was correct, and the fix
(pairing the extension to the same claude.ai account) is worth remembering. **Read
[§Session 3](#session-3--unblocked-priority-list-executed) first; everything above it is history.**

---

## Session 3 — UNBLOCKED, priority list executed

**Browser connected on the first attempt.** `select_browser` with the operator-confirmed
deviceId, then `tabs_context_mcp{createIfEmpty:true}` returned a live tab group. The
account-pairing hypothesis from session 2 was the correct one.

**No login wall was hit.** `https://dashboard.adlabs.app/` redirected straight to
`/getting-started` in an authenticated session. **Total wait time at a login wall: zero.** The
10-minute wait-and-recheck procedure was never invoked.

### Priority list outcome

| # | Item | Outcome |
|---|---|---|
| 1 | **Automations** — condition, action, schedule and scope vocabulary | **Done, and it was the right call to rank it first.** Whole rule builder captured. Found at the unlinked route `/automations`. **Alerting turned out to exist**, which reverses the recon's headline "Beat #1". `08-alerts-automations-dayparting.md` §1–§2 rewritten. |
| 2 | **Navigation** — confirm/correct the section list | **Done — heavily corrected.** The session-1 list of 17 flat sections was wrong in grouping, naming and count. Real nav is 6 collapsible groups + footer. `01-navigation-map.md` rewritten. |
| 3 | **Goto link** — mint one, capture URL shape, settle snapshot-vs-live | **Done.** Exactly one link minted (the sanctioned write). Shape `/<section>/?goto=mcp_<hex16>`; restores profile + materialised ID filter + date + comparison; **re-queries live over a frozen ID list**. `10-goto-links.md` §3 rewritten; no longer partial coverage. |
| 4 | **Settings** — user/role/permission management, MCP-key screen | **Done, both gaps closed.** Role model is exactly **Owner + Admin** with ownership transfer as the only role operation — no read-only role exists. MCP key screen is a single unscoped `Generate Key` button. Also found a previously unknown **Advanced feature-flags tab**. `09-settings-and-admin.md` §4–§5 rewritten. |
| 5 | **Dashboard share view** — confirm the white-label verdict | **Done — verdict reversed.** A full white-label stack exists (custom domain, logo, favicon, accent colour, 8-colour chart palette) as an *organization* setting, which is why the dashboard contract never showed it. Share view carries **zero AdLabs branding** and a `Download PDF` button. `03-dashboards.md` §5 rewritten. |
| 6 | **Screenshots**, redacted, numbered into `screenshots/` | **Done — 13 captures**, all redacted or cropped. See below. |

### Screenshot policy actually applied

No demo/obfuscation mode was found in the product, so the rule used was: **capture only frames
that contain no client-identifying data, and crop where a client name would otherwise be in
frame.** Concretely —

- Builder modals were captured **before** a profile was selected, or **cropped** to the right-hand
  pane so the left rail's profile chip is out of frame.
- The automations list, the Advanced settings tab and the white-label settings tab are captured
  whole; they contain no client data (the automations grid is empty).
- **Deliberately not captured, described in prose instead:** the profiles list, `Profiles
  Overview`, the dashboards list, the Manage Members modal, the Teams grid, the campaign grid,
  and the rendered client share view. All carry client or staff names, e-mails, or figures.
- The goto-link token and the dashboard share token are **redacted** in the specs.

13 files, `01-` … `13-`, in `tools/recon/screenshots/`.

### Read-only confirmation for session 3

**One sanctioned write, and nothing else.** `create_goto_link` was called exactly once (priority
item 3, explicitly authorised). It has **no delete affordance** in either the UI or the MCP
contract, so the link persists; it points at a 3-day, single-campaign view.

Everything else was read-only. Specifically, both automation wizards were opened and walked to
their final step and then **cancelled** — the automations grid still reads "No Rows to Show".
`Generate Key`, `Save`, `Apply`, `Update Organization`, `Update Color`, `Update Palette`,
`Start Setup`, `Delete` and every role-change control were **not** clicked. Form fields typed
into (a profile selection, an ACOS threshold of 40, a frequency of Weekly) existed only inside
cancelled modals. `Test Trigger` was run — it is a read-only match count.

---

## History — sessions 1 and 2 (kept for the record)

## What happened

The recon was set up on the premise that the operator was logging into `app.adlabs.app` in Chrome
and that the agent would drive the session through the Claude-in-Chrome browser tools.

**The browser extension never connected.** Not once, at any point in the session.

- The first call, `tabs_context_mcp{createIfEmpty: true}`, returned:
  *"Browser extension is not connected. Please ensure the Claude browser extension is installed
  and running, and that you are logged into claude.ai with the same account as Claude Code."*
- `list_connected_browsers` was then polled repeatedly throughout the session, spaced across the
  whole of the MCP recon work. **It returned an empty list `[]` on every single call** — roughly
  twenty checks over the full session duration, well beyond the five retries the brief called for.

### The important distinction

This is **not** "AdLabs showed a login page and the operator had not logged in yet." That failure
mode would have produced a connected browser showing a login screen, and the brief's wait-and-
retry procedure would have covered it.

What actually happened is one level earlier: **zero browsers were ever visible to the tooling.**
The agent could not see a tab, could not open one, and could not navigate anywhere. Whether the
operator was logged into AdLabs is therefore unknown and unknowable from here — the question was
never reachable.

### Most likely causes, in rough order

1. The Claude browser extension is not installed, not enabled, or Chrome has not been restarted
   since installing it.
2. Chrome is signed into a different claude.ai account than the one Claude Code is running as.
3. The extension is installed but the site-level permission for `adlabs.app` / `dashboard.adlabs.app`
   has not been granted (the extension requires per-site permission before it will act).

None of these are diagnosable or fixable from the agent side. All three are one-minute operator
checks.

---

## What was NOT done, and must not be assumed

- **No screenshots were taken.** `tools/recon/screenshots/` was created and is **empty**. Every
  spec file's screenshot-reference obligation is unmet, and each file says so rather than
  pretending otherwise.
- **No AdLabs UI page was loaded, rendered, read, or navigated.**
- Consequently: no UI labels, button texts, menu structures, modal layouts, empty states, error
  states, colour treatments, or screen-level information architecture were visually verified.

Every claim in the spec files is tagged with its evidence source. Nothing is tagged `UI` except
one literal URL that the MCP server itself returned.

---

## What was completed instead

The MCP half of the brief ("MCP surface — merge, don't duplicate") was executed in full against
the operator's own live AdLabs org, strictly read-only. That turned out to carry most of the
weight, because the MCP contract is a direct projection of the same object model the UI edits:
entity types, exact column sets, the full filter grammar, optimizer inputs and preview columns,
harvest and mapping settings, tag model, dashboard structure, job log, and the context system.

The specs are therefore **structurally complete and behaviourally exact**, and **visually
unverified**. That is a real limitation but a narrower one than it first appears: what we need to
clone is the model, and the model is fully in hand.

Sources actually used:

| Source | Weight |
|---|---|
| Live read-only AdLabs MCP calls (contracts, schemas, live entity fetches) | Primary — the bulk of every file |
| AdLabs' own two bid-optimizer tutorial transcripts | Secondary — workflow and UI labels, and demonstrably out of date on controls (see `04-optimizer.md` §2) |
| Prior team findings on the AdLabs MCP path | Corroboration and known traps |
| One literal UI URL returned by the MCP server | The only direct UI evidence |

---

## Cost, by checklist area

| Area | Impact of no UI |
|---|---|
| 1 Navigation map | **Material.** Section list is assembled from capabilities and URL shape, not from a rendered nav. Ordering, grouping, and naming are unverified. |
| 2 Data grid | **Low.** Column sets are exact from live fetches; filter grammar is exact. Only chrome (chips, menus, pickers) is unverified. |
| 3 Dashboards | **Low–moderate.** Object model is exact. Widget *rendering* and the share view's appearance are unseen — which matters for the white-label verdict, though the absence of any branding field in the contract is itself strong evidence. |
| 4 Optimizer | **Low.** Contract is exact and the tutorials cover the workflow step by step. Modal layout unverified. |
| 5 Harvesting / maps | **Low.** Contract is exact. Map-builder UI unverified. |
| 6 Tags | **Low–moderate.** Model is exact. The assignment UX (how you pick a tag while looking at a grid) is unseen. |
| 7 SQP / n-grams / negatives | **Low.** Column model and workflow contracts are exact. |
| 8 Automations / dayparting / budget | **HIGH, and this is the real loss.** Automation *rule definition* — the conditions, actions, and schedule language — is **UI-only with no API surface at all**. It could not be recovered from any other source. This is the one genuine hole in the recon. |
| 9 Settings / admin | **Moderate.** Profile and target model exact; user/role/permission management and the MCP-key screen were not observable from MCP and remain partly unknown. |
| 10 Goto links | **Moderate.** Behavior is inferred from the contract; token format and snapshot-vs-live-query semantics unverified — and `create_goto_link` was deliberately not called because minting a token is a write. |

---

## Session 2 — retry, also blocked

A second session was run specifically to execute the six-item priority list below, on the premise
that the operator had fixed the extension and was logged in at the application host. **It failed
at exactly the same point, with the same error string.**

### What was tried

| Attempt | Call | Result |
|---|---|---|
| 1 | `tabs_context_mcp{createIfEmpty: true}` | "Browser extension is not connected…" |
| 2 | `tabs_context_mcp{createIfEmpty: true}` | same |
| — | `list_connected_browsers` | `[]` |
| 3 | `tabs_context_mcp{createIfEmpty: true}` | same |
| 4 | `tabs_context_mcp{createIfEmpty: true}`, after a deliberate 75-second wait | same |

Spread over roughly four minutes. No tab was ever visible, so again **no AdLabs page was loaded,
navigated, read, or screenshotted**, and `screenshots/` remains empty.

### New information: three of the four suspected causes are now ruled out

Session 1 listed three likely causes. A local, read-only inspection of the Chrome profile in
session 2 eliminates them:

- **The extension is installed.** The Claude extension (`fcoeoabgfenejglbffodgkkbkcdhcgfn`) is
  present in the browser profile that is actually running.
- **It is enabled.** Its stored settings carry an **empty `disable_reasons` list**.
- **It is fully permissioned.** Its granted host permissions include `<all_urls>` for both
  explicit and scriptable hosts — so a missing per-site grant for the AdLabs host is *not* the
  blocker.
- **A restart is not pending.** The extension directory predates the running browser process by
  several days, so the browser has been restarted since installation.

### What that leaves

The failure is therefore **not** installation, enablement, site permission, or a stale process.
It is one level up, at the pairing layer: the extension is not associated with the claude.ai
account this agent session runs as, or the extension's connection to the CLI is not established.
That is the only remaining hypothesis consistent with an installed, enabled, fully permissioned
extension reporting "not connected" while `list_connected_browsers` returns an empty list.

**This is not diagnosable further from the agent side, and a session 3 should not be scheduled
until a connection is confirmed independently** — for example by checking that the extension's own
UI reports a connected state, and that the claude.ai account signed in inside the browser is the
same one the CLI is authenticated as. Two sessions have now been spent discovering the same thing.

---

## To unblock — ~~outstanding~~ **COMPLETED IN SESSION 3**

> Kept for the record. Step 2 was the correct diagnosis: pairing the extension to the same
> claude.ai account resolved it, and session 3 connected on the first call. All six follow-up
> priorities below were executed — see [§Session 3](#session-3--unblocked-priority-list-executed).

**Operator, in order** (steps 1 and 3 were verified locally in session 2 and are already
satisfied — start at step 2):

1. ~~Confirm the Claude browser extension is installed and enabled, and restart Chrome.~~
   **Verified in session 2: installed, enabled, no disable reasons, browser restarted since
   install. Not the blocker.**
2. Confirm that Chrome's claude.ai session uses the **same account** Claude Code runs as, and that
   the extension's own UI reports a *connected* state. **This is now the only remaining
   hypothesis** — see §Session 2.
3. ~~Grant the extension site permission for `dashboard.adlabs.app`.~~ **Verified in session 2:
   the extension already holds `<all_urls>` explicit and scriptable host permissions. Not the
   blocker.** (Note for the eventual session: the application host is `dashboard.adlabs.app`, not
   `app.adlabs.app` — see `01-navigation-map.md`.)
4. Open `https://dashboard.adlabs.app/` and confirm a logged-in screen is showing.
5. **Prove the connection before booking a session.** A one-line check that
   `list_connected_browsers` returns a non-empty list is worth more than a third agent session
   that rediscovers the same failure.

**Then a follow-up session should, in priority order:**

1. **Automations** — open the rule builder and capture the condition vocabulary, the action
   vocabulary, the schedule/trigger model, and the scope selector. This is the only area where no
   substitute source exists. Highest value by a wide margin.
2. **Navigation** — one screenshot of the full expanded nav, to confirm or correct
   `01-navigation-map.md`'s section list, grouping, and naming.
3. **Goto link** — mint one from a small result and capture the URL shape, then reopen it after
   changing a filter to settle whether it restores a frozen snapshot or re-runs a query.
4. **Settings** — user/role/permission management and the MCP-key screen, to close
   `09-settings-and-admin.md` §4 and §5.
5. **Dashboard share view** — open a share link and confirm the branding surface (the contract
   says `dark_mode` is the only presentation control; a look would make the white-label verdict
   airtight).
6. **Screenshots** for every area, numbered into `tools/recon/screenshots/` — but note the
   standing constraint in this directory's `README.md`: *"Screenshots and any capture that
   identifies an account stay out of this directory. This repo is public."* So every capture must
   be taken on an obfuscated view or redacted before it lands here. AdLabs' own tutorial videos
   are recorded against an account with obfuscated campaign names, which suggests the product has
   a demo/obfuscation mode worth finding before the capture pass.

Each spec file already carries a verdict; a UI pass should **confirm or correct**, not restart.
