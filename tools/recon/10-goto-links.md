# 10 — Goto links: how deep links restore state

**WP-11 recon · read-only, with one sanctioned exception.** In session 3 the manager explicitly
authorised minting **exactly one** goto link to settle this file's open questions.
`create_goto_link` was called **once**, from a deliberately tiny reference (one campaign, a
3-day window), and the resulting link was opened twice in the browser. **No other write of any
kind was made.** The section below marked `UI-verified` records what was actually observed;
this file is **no longer partial coverage**.

---

## 1. What a goto link is

A deep link that opens the AdLabs UI **already showing a specific result set**. It is the bridge
between the tool-driven half of the product (an agent or an analyst working through references)
and the human half (someone reviewing rows in a browser).

`MCP`, from the operating instructions: it sits at the end of the four-stage pipeline as the
final verb.

```
FETCH  → get_entity_data                    row-level reference + aggregate reference
REFINE → query / group_by_column            filter, sort, compute, aggregate
VIEW   → read                               up to 100 rows, inline
ACT    → update_entities / tags / create_goto_link
```

So a link is classed as an **action**, alongside bulk updates and tagging — not as a display
option. That is the correct classification: it creates a durable artifact.

---

## 2. When links appear

### Automatically

*"Call `create_goto_link` for any result with >10 rows (`read` and `group_by_column` auto-attach
it otherwise)."*

So: ≤10 rows → the link comes attached to the result for free; >10 rows → mint one explicitly,
because you cannot show the rows inline. The rule is a threshold on **inline displayability**,
which is exactly the right trigger. When the answer does not fit in the conversation, hand over a
link to where it does fit.

### From every preview

Three preview-producing flows return an explicit **"View in AdLabs"** link alongside their
`preview_id`:

| Flow | What the link opens |
|---|---|
| `optimizer(preview_optimization)` | *"the Optimization Preview Modal in the AdLabs dashboard"* — named explicitly |
| `harvesting(preview_harvest)` | the harvest preview |
| `create_entities(negative_targeting)` | the negatives preview, for review before anything is sent to Amazon |

The negatives contract makes the intent explicit — it presents the link and the programmatic
apply as **two alternative paths from the same `preview_id`**: show the link "so they can review
and confirm in the UI before the negatives are sent to Amazon", or apply directly "for automated
flows without human review."

**This is the most important pattern in the whole product for our purposes.** A preview is a
persisted server-side object with an ID; a link is a view onto it; an apply is an action on it.
The agent prepares, the human approves in a real UI, and there is exactly one artifact between
them. Clone this shape for WP-12's staged apply without modification.

### From ordinary listings

`campaign_mapping(list_mappings)` returned, verbatim and unprompted:

```
View in AdLabs: https://dashboard.adlabs.app/campaign-mapping/?teamId=<team>&profileId=<profile>
```

That is the only literal AdLabs UI URL captured in this recon, and it establishes the route shape
(`01-navigation-map.md`): host `dashboard.adlabs.app`, path per section, tenancy in the query
string.

Dashboards additionally carry their own `view URL` (returned by `list` and `get_structure`) and
separate **public share links** with tokens — a different mechanism, covered in
`03-dashboards.md` §5. Do not conflate the two: a goto link restores a *result* for an
authenticated user; a share link exposes a *dashboard* to anyone holding the URL.

---

## 3. How state is restored — **`UI-verified`, session 3**

### The experiment

1. `get_entity_data(entity_type="campaign", …)` with `DATE 2026-08-10 → 2026-08-12` **and**
   `SPEND >= 50`. Result: **1 campaign**, plus a `COMPARE_DATE` applied automatically.
2. `create_goto_link(reference=<row-level reference>)` → one URL.
3. Opened it, inspected the restored state, then opened the **same URL a second time**.

### The URL shape

```
https://dashboard.adlabs.app/<section>/?goto=mcp_<16 lowercase hex chars>
```

Observed verbatim: `https://dashboard.adlabs.app/optimizer/?goto=mcp_<redacted16>`
(token redacted — this repo is public). Facts:

- **The route is the destination grid**, chosen by the reference's entity type — a campaign
  reference produced `/optimizer/` (which *is* the campaign grid; see `01-navigation-map.md`).
  It is **not** a dedicated `/go/<token>` route.
- **State travels in a single opaque query parameter**, `goto`, whose value is namespaced `mcp_`
  — so the token space is explicitly tagged by producer.
- **No `teamId` or `profileId` in the URL.** The link carries neither, yet correctly switched the
  active profile. Tenancy is resolved **from the token**, not from the query string. This
  corrects `01-navigation-map.md`'s "tenancy is in the query string" claim.
- **The parameter is consumed on load**: after hydration the address bar reads
  `https://dashboard.adlabs.app/optimizer/` with no query string. The link is not idempotent in
  the address bar — copying the URL *after* opening it gives you a plain grid.

### What it restores

| Restored | Detail |
|---|---|
| **Active profile** | Switched the top-right profile switcher to the reference's profile. |
| **An ID filter** | A single filter chip: **`Select Campaigns: 1 selected ✕`** — the materialised entity IDs from the reference. Removable like any other filter. |
| **Date range** | `10 Aug - 12 Aug, 2026`, exactly the reference's `DATE`. |
| **Comparison range** | `7 Aug - 9 Aug, 2026` — the auto-applied `COMPARE_DATE`, i.e. the immediately preceding equal-length period. |

Screenshot: `screenshots/13-goto-link-restored-filter-bar.png`.

### The answer to the file's central question

**A goto link is a live query, not a frozen snapshot** — but a live query over a **frozen ID
list**. On open, the grid re-runs against current data (metrics, the trend chart, the stat tiles
and the comparison deltas were all computed fresh); what is preserved is *which entities* and
*which window*.

Two consequences, both load-bearing:

1. **The predicate is lost; only its result survives.** The originating filter was
   `SPEND >= 50`. The restored view carries **no spend filter at all** — just
   `Select Campaigns: 1 selected`. So the link cannot answer "which campaigns spend over $50
   today"; it answers "these specific campaigns, over this window". It is a *materialised* view,
   not a saved search. This is precisely the "carries a result, not a lens" problem this file
   already suspected — now confirmed by observation.
2. **It is therefore not evidence either.** Because metrics re-run live, reopening the link
   tomorrow shows different numbers for the same rows. It is neither an immutable snapshot nor a
   reusable lens — it sits in between, and the UI gives you no way to tell which you are holding.

### Lifetime

**The token persists and is reusable.** Opening the same URL a second time restored identical
state. It notably **outlives the underlying MCP reference**, which expires after ~2 hours —
confirming the earlier inference that a goto link is backed by its own persisted record.

No expiry, revocation, last-opened or listing surface for goto links was found anywhere in the
UI or the MCP contract, and there is **no delete affordance** — the one link minted for this test
cannot be removed. Whether it is authenticated was not tested (it was only ever opened in a
logged-in session), but since it restores a filter in an authenticated grid rather than rendering
a standalone page, it almost certainly is.

### Still not established

- Whether computed columns added via `query` survive into the restored view (the test reference
  had none).
- Goto links produced from a *preview* reference (`optimizer(preview_optimization)`), which the
  contract says take an explicit `entity_type` and which may restore the preview **modal** rather
  than a grid filter — a different and possibly snapshot-backed mechanism. Not exercised, because
  producing an optimizer preview is out of the read-only envelope.

---

## 3b. Prior inferences, for the record

**Known before session 3:**

- Section routes carry `teamId` and `profileId` as query parameters, so tenancy is always
  restorable from the URL alone.
- Preview links restore a **stored server-side object** addressed by `preview_id`. The optimizer
  contract says `apply_optimization` "re-reads the original preview data from the database using
  `preview_id`", and the harvest contract says the same. So the preview rows — including every
  `new_value`, `change_reasons`, and `limit_reasons` — are persisted, not recomputed. A preview
  link therefore restores exactly what was previewed, even hours later, regardless of what has
  changed in the account since.
- Reference-based links must be different in kind, because **references expire after ~2 hours**
  ("on 'reference expired' re-fetch with the same parameters"). A goto link that outlived its
  reference would be broken, so a goto link is presumably backed by its own persisted record
  rather than by the reference URI.

**Resolved in session 3** (see §3 above): the token format and route (`/<section>/?goto=mcp_<hex16>`,
not `/go/<token>`); resolved-row-set vs query (**both** — frozen ID list, live metrics); and
lifetime (persistent, reusable, no expiry or revocation surface). The one guess that was **wrong**
was "tenancy is always restorable from the URL alone" — the goto URL carries no tenancy at all.

---

## 4. What goto links are not

- **Not a saved view.** They capture a result, not a lens. See `02-data-grid.md` §5 — there is no
  named, shareable bundle of columns + filters + date range. Column layout persists per user,
  implicitly, and travels with the user rather than with the link.
- **Not a drill-down.** Dashboard widgets have no click-through to the rows behind them
  (`03-dashboards.md` §4); the goto link fills that role only for tool-driven flows, where the
  thing that computed the number hands you a link back. Good for an agent, poor for a client
  looking at a chart.
- **Not a share link.** Share links are unauthenticated, dashboard-scoped, tokenized, and
  revocable per link. Goto links are, as far as the evidence goes, for the authenticated user.

---

## 5. Verdicts

**Clone.**
- **The link as the fourth verb**, classed as an action alongside update and tag, not as a
  formatting option.
- **The >10-row threshold**: inline when it fits, link when it does not. A simple, correct rule
  that an agent can follow without judgement.
- **Preview as a persisted, addressable object with two exits** — a "View in AdLabs" link for a
  human and a programmatic apply — both keyed on the same `preview_id`. This is the exact
  primitive WP-12 needs: the agent prepares, the human approves in a real UI, one artifact
  between them, and nothing recomputed between preview and apply.
- **Persisting preview rows rather than recomputing them**, so an approval decides on precisely
  what was shown.
- **Tenancy in the query string**, making every route trivially deep-linkable.

**Skip.**
- Goto links standing in for drill-down. Widgets should click through to the grid directly.
- Two link mechanisms with overlapping names ("View in AdLabs" for goto links, "view URL" and
  "share URL" for dashboards) and no shared vocabulary for lifetime or authentication.

**Beat.** *(Items 1 and 2 are now backed by observation rather than inference.)*
1. **A link should carry a lens, not just a result.** **Confirmed by test:** their link
   materialises the reference into a `Select Campaigns: N selected` ID filter and **discards the
   predicate that produced it**. Ours should encode entity type + filters + columns + date range
   + profile set, so the recipient can move the date range or swap the profile and the link still
   means something. That is one object away from being the named saved view that
   `02-data-grid.md` argues for — build them as the same thing.
2. **Say which kind of link it is, on the link.** **Confirmed by test:** theirs is a hybrid —
   frozen rows, live metrics — and nothing in the URL or the UI tells you that. Frozen snapshot
   (evidence, immutable, for approvals and audit) versus live query (a saved search that re-runs)
   are both useful; a link whose behavior you cannot tell from looking at it is not.
3. **Do not consume the state parameter on load.** Theirs strips `?goto=` from the address bar
   after hydration, so copying the URL from a browser you already opened it in silently yields a
   link to nothing. Keep the state in the URL.
4. **Links with a lifetime and an audit trail.** Expiry, revocation, and last-opened, consistent
   across goto links and dashboard share links, recorded against the same job log that already
   carries `username` and `note`.
5. **Approval as a first-class object.** They have preview + link + apply. Add: who approved,
   when, what note, and which rows they excluded — recorded on the preview, so the job log entry
   and the human decision are one record rather than two.
6. **Deep links into any grid state, not only tool-produced results.** Anything an operator can
   see should be linkable; today only pipeline outputs and a handful of section routes are.
