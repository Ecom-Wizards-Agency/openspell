# 06 — Tags (Data Groups): nesting, assignment, where they filter

**WP-11 recon · read-only.** No tag was created, updated, assigned, or deleted. Structure below
is from the live `adlabs://docs/tag_actions` contract and from tag columns observed on live
entity fetches. No UI seen — see `BLOCKED.md`.

---

## 1. What a tag is

AdLabs calls them **Data Groups** in the UI and **tags** in the API. Both names appear in the
same contract, which is itself worth noting: `list_tags` is documented as listing "tag
definitions", the assignment action takes "the exact name of the data group (tag)", and the
filter key is `*_DATA_GROUP_ITEM`. Two vocabularies for one object.

The model is **two levels, not a tree**:

```
Tag (Data Group)          e.g. "Funnel Stage"
  └── Tag value (Data Item)   e.g. "Discovery", "Shield", "Brand Defense"  — each with a colour
```

**There is no nesting.** A tag value cannot contain another tag value, and a tag cannot contain
another tag. The apparent hierarchy an operator wants ("Product line → Variant → Market") is
expressed by creating several independent tags and assigning one value from each. That is a
faceted model, not a tree, and it is the right choice: facets compose in filters, trees do not.

### Properties of a tag

| Property | Notes |
|---|---|
| `tag` (name) | Unique-ish, but **not enforced unique** — see the `tag_id` disambiguation below |
| `tag_type` | The entity type it applies to: `ad_group`, `campaign`, `product`, `profiles`, `search_term`, `target` |
| `tag_values` | Comma-separated list of value names |
| `tag_colors` | One colour per value, in order. 22 named colours: `red, orange, amber, yellow, lime, green, emerald, teal, cyan, sky, blue, indigo, violet, purple, fuchsia, pink, rose, slate, gray, zinc, neutral, stone` |
| `profile_ids` | **Which profiles can see this tag.** Required for every type except `profiles`, enforced server-side |
| `tag_id` | Numeric. Needed because "multiple tags share the same name and type across the org" |

Two structural facts:

- **A tag is bound to exactly one entity type.** You cannot have one "Brand" tag that applies to
  both campaigns and products; you need two. This is why search terms end up carrying three
  separate tag layers (below) rather than one.
- **Tags are defined at team level but listed across the whole org.** `list_tags` "lists tag
  definitions across the team's entire organisation (all teams sharing the same org)". Visibility
  is then narrowed per tag by `profile_ids`. So the scoping story is: created in a team, visible
  across the org, gated per profile.

`tag_colors` is optional and the contract says to omit it unless the user explicitly asks for
specific colours — defaults are assigned. Small thing, right default: nobody wants to pick 8
colours to make a tag.

---

## 2. Assignment

Two actions, both taking a **data reference** rather than a list of IDs:

- `assign_entities_from_reference(reference, tag, tag_value)`
- `remove_assignments_from_reference(reference, tag, tag_value)`

**The entity type is derived automatically from the reference metadata.** You filter the grid,
you tag the result. There is no separate tagging UI, no entity picker, no ID list. Supported on
`ad_group`, `advertised_product`, `campaign`, `product`, `search_term`, `target`.

This is the same interaction shape as harvesting (select via a filtered grid reference) and
optimizing (select campaigns, run over the reference). **One selection mechanism for every bulk
operation in the product.** That is the pattern to clone above all others here: the grid *is* the
selector, everywhere.

### Assignment semantics

- **Idempotent.** "Entities already holding the requested tag value count as success."
- **Tolerant.** "Entities missing from the database are skipped."
- **Counted.** "Returns how many requested entities were successfully processed."

Requested / succeeded / skipped, reported back. Same discipline as the job log and the harvest
warnings.

### The exact-name requirement

`MCP`, verbatim: *"If the tag name was not obtained from a prior list_tags call in this session,
call list_tags first to get the exact tag and value names — they must match exactly
(case-insensitive) and abbreviations/guesses will fail."*

And `tag_id` exists specifically to "disambiguate when multiple tags share the same name and type
across the org", taking precedence over `tag` when both are given.

So: names are the primary key in the API, names are not unique, and there is a numeric ID bolted
on to resolve the collisions. **Skip this.** Address tags by ID; resolve names to IDs once, at
the edge.

---

## 3. Where tags filter

### As a grid filter

Every taggable entity gets a `*_DATA_GROUP_ITEM` filter key — confirmed on the campaign schema
as `CAMPAIGN_DATA_GROUP_ITEM` (type: select, operators `=`, `<>`, `IN`, `NOT_IN`).

Critically, you filter by **`value_id`**, not by name: *"To fetch entities by tag, use
get_entity_data with a `*_DATA_GROUP_ITEM` filter and the `value_id` from this result."*
`list_tags` returns metadata only — names, value names, colours, profile scopes — **never which
entities are tagged**. The assignment lives on the entity, and you reach it by filtering.

`IN` / `NOT_IN` on tag values means multi-select and exclusion both work, which is what makes
faceted filtering usable.

### As grid columns — the three-layer search-term case

The search-term entity carries **three independent tag layers simultaneously**, all as columns:

1. search-term tags
2. campaign tags
3. target/keyword tags

So one search-term row shows you how its term, its campaign, and its keyword are each classified.
That is the payoff of the faceted model and of tags being bound to one entity type: joining the
layers happens in the row, not in the operator's head.

**Clone this.** "Show me search terms tagged Discovery, in campaigns tagged Non-Brand, on
keywords tagged Rank" is a single filter expression against a single grid.

### In dashboards

Dashboard tab overrides take per-entity filter arrays using the same `FilterKey` enum as the grid
(`campaignFilters`, `targetFilters`, `searchTermFilters`, `productFilters`, …). Since
`*_DATA_GROUP_ITEM` is a normal filter key, **tags filter dashboard widgets too** — a tab can be
scoped to one tag value.

That closes the loop: tag once in the grid, filter by it in the grid, in the dashboard, and in
the API, with one vocabulary. This is the strongest cross-surface consistency in the product and
it should be a hard requirement for us.

### Where tags do NOT reach

- **Optimization groups are a separate mechanism.** A campaign's optimization group is not a tag;
  it is its own object with its own settings and its own `CAMPAIGN_GROUP` / `CAMPAIGN_GROUP_NAME`
  filter keys. So a campaign carries both a tag set *and* a group membership, and the two do not
  interoperate. You cannot assign an optimization group by tag.
- **Campaign maps do not consult tags.** Mapping is by explicit ad-group ID pair (or by SQL over
  names), never by tag.
- **Dayparting schedules** are assigned to campaigns by ID, not by tag.

Those three gaps are the same gap: *tags classify, but nothing acts on the classification.*

### Where tags DO reach — `UI-verified`, session 3 (partial correction)

**Automations can be scoped by tag.** The automation trigger-condition filter list carries a
`Tags` group with **`Tag (Campaigns)`** as a selectable filter
(`08-alerts-automations-dayparting.md` §1). So a taxonomy you have already built *can* drive a
scheduled rule's scope — and, transitively, an automated `Assign Opt Group` or
`AdLabs Bid Optimizer` action.

That is a real hole in the "nothing acts on the classification" claim, and it points at how they
would have closed the rest: **the filter grammar is the join, and tags are in it.** Anything that
takes a filter set can be tag-driven; only the things that take bare ID lists (optimization
group membership, campaign maps, dayparting assignment) cannot.

The corrected statement: *tags classify, and only the rules engine acts on the classification —
every direct-assignment surface still demands IDs.*

---

## 4. Lifecycle

| Action | Behavior |
|---|---|
| `create_tag` | name + type + values (+ colours, + profile scope) |
| `update_tag` | rename, and/or add values, and/or recolour existing values. At least one of the three required |
| `delete_tag_values` | removes values **and all their entity assignments** |
| `delete_tag` | removes the tag, all values, and all assignments |

Note what `update_tag` cannot do: **there is no rename-a-value and no delete-a-single-assignment
by name.** You add values or you delete values (destroying assignments). Renaming a value means
create-new, reassign, delete-old — and the reassign has to be done through a reference, which
means you must first find every entity carrying the old value.

Also absent: no archive/deprecate state on a tag or value, so retiring a taxonomy is destructive.

---

## 5. Verdicts

**Clone.**
- Two-level faceted model (tag → values), not a tree. Compose facets in filters.
- Tag bound to one entity type, with multiple layers surfacing as columns on child entities —
  the three-layer search-term row is the best expression of this.
- Assignment from a filtered grid reference, with entity type derived from the reference. The
  grid is the selector for every bulk operation.
- Idempotent, tolerant, counted assignment (already-tagged = success; missing = skipped; totals
  returned).
- Colours on values, with sensible defaults so nobody has to choose.
- `*_DATA_GROUP_ITEM` as a normal filter key with `IN` / `NOT_IN`, usable identically in the
  grid, in dashboard tab overrides, and in the API.
- Per-profile visibility scoping on a team-defined tag.

**Skip.**
- Two names for one object (Data Group / tag, Data Item / value). Pick one.
- Names as the API's primary key with a numeric ID bolted on for collisions. Address by ID.
- Destructive-only value lifecycle. No rename, no archive.

**Beat.**
1. **Make tags actionable, not just descriptive.** The single biggest gap: optimization groups,
   campaign maps, and dayparting schedules all take explicit IDs, so a classification you have
   already built cannot drive any of them. Tag-driven membership ("every campaign tagged Rank
   belongs to the Rank optimization group") turns the taxonomy from a filter into policy, and it
   is the thing that makes fifteen profiles manageable.
2. **Tag rules.** Assignment is a one-shot bulk action against a snapshot reference, so a campaign
   created tomorrow is untagged. A saved rule ("name matches `- Auto` → tag Discovery") applied on
   sync keeps the taxonomy true without a weekly re-tag chore.
3. **Cross-profile tags.** `profile_ids` gates *visibility* of a definition, but assignments are
   per entity per profile. One taxonomy, applied consistently across fifteen profiles, with
   coverage reporting ("83% of campaigns in this profile are untagged") is straightforwardly
   better and straightforwardly absent.
4. **Non-destructive taxonomy edits.** Rename a value; archive a tag; move assignments between
   values. Today, correcting a taxonomy mistake means losing the assignments.
5. **Untagged as a first-class filter and a health metric.** With `NOT_IN` you can approximate it;
   it should be a chip on the grid and a number on the account health view.
