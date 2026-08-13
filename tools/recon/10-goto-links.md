# 10 — Goto links: how deep links restore state

**WP-11 recon · read-only.** `create_goto_link` was **deliberately not called** — it mints a
persisted token, which is a write. So the token format and the restored-state payload were not
observed directly. Everything below is from the live contract, from links the server returned
unprompted, and from the surrounding architecture. Marked **partial coverage** in `00-INDEX.md`.

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

## 3. How state is restored — what is known and what is not

**Known:**

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

**Not known, because the link was not minted:**

- The token format and route (whether `/go/<token>` or a section route with a state parameter).
- Whether a goto link stores **the resolved row set** or **the query that produced it** — i.e.
  whether reopening it tomorrow shows yesterday's rows or today's. This is the single most
  consequential unknown in this file: it is the difference between a link that is *evidence*
  and a link that is a *saved search*.
- Expiry, revocation, and whether a goto link is authenticated (a share link explicitly is not).
- Whether computed columns added via `query` survive into the restored view.

Recorded honestly as open questions. Each is a one-minute check in a live UI session.

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

**Beat.**
1. **A link should carry a lens, not just a result.** Ours should encode entity type + filters +
   columns + date range + profile set, so the recipient can move the date range or swap the
   profile and the link still means something. That is one object away from being the named saved
   view that `02-data-grid.md` argues for — build them as the same thing.
2. **Say which kind of link it is, on the link.** Frozen snapshot (evidence, immutable, for
   approvals and audit) versus live query (a saved search that re-runs). Both are useful; a link
   whose behavior you cannot tell from looking at it is not.
3. **Links with a lifetime and an audit trail.** Expiry, revocation, and last-opened, consistent
   across goto links and dashboard share links, recorded against the same job log that already
   carries `username` and `note`.
4. **Approval as a first-class object.** They have preview + link + apply. Add: who approved,
   when, what note, and which rows they excluded — recorded on the preview, so the job log entry
   and the human decision are one record rather than two.
5. **Deep links into any grid state, not only tool-produced results.** Anything an operator can
   see should be linkable; today only pipeline outputs and a handful of section routes are.
