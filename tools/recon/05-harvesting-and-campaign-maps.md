# 05 — Harvesting and campaign maps

**WP-11 recon · STRICTLY READ-ONLY.** No harvest was previewed or applied. No mapping was
created, updated, or deleted. The only mapping call made was `list_mappings`, which reads (it
returned "No campaign mappings found for this profile" on the profile inspected).

Sources: `MCP` = live `adlabs://docs/harvesting_actions` and `adlabs://docs/mapping_actions`
contracts plus a live `list_mappings` read. `URL` = a UI URL returned verbatim by the server.
No UI was seen — see `BLOCKED.md`.

---

## 1. The model in one paragraph

A **campaign map** is a persistent routing rule: *search terms discovered in this source ad group
get promoted into that destination ad group, as these match types, at these bids, and get negated
back in the source.* A **harvest** is a run over selected search terms that consults the maps,
computes a bid for every (search term × mapping) combination, shows you a preview, and on apply
creates the targets in the destinations and the negatives in the sources.

The separation is the whole design. Routing policy is configured once and lives in the profile;
the weekly act is just "select terms, preview, apply." **Clone this split.** Most competitors
make you re-specify the destination on every harvest, which is why nobody does it weekly.

UI route (`URL`): `https://dashboard.adlabs.app/campaign-mapping/?teamId=<team>&profileId=<profile>`

---

## 2. Campaign map builder

### Discovering what you can map

`list_mapping_targets` returns every campaign and ad group available for mapping:

```
campaign_id  campaign_name  campaign_ad_type
ad_group_id  ad_group_name  entity_type  map_count
```

Two columns here are the good idea:

- **`entity_type`** — `KEYWORD` or `PRODUCT_TARGET`, declared per ad group. The map builder
  therefore knows, before you pick anything, which match types are even legal for a destination.
- **`map_count`** — how many times this ad group is already used as a source. So the builder can
  show you your coverage gaps: which ad groups are producing search terms that nothing routes.
  That is the question an operator actually has ("what am I not harvesting?") and it is answered
  in the picker rather than in a report.

### A mapping row

`list_mappings` returns **one row per match-type entry** for a source→destination ad group pair:

```
source_campaign_id  source_campaign_name  source_ad_group_id  source_ad_group_name  source_entity_type
dest_campaign_id    dest_campaign_name    dest_ad_group_id    dest_ad_group_name    dest_entity_type
match_type
bidding_method  bidding_method_value  bid_floor  bid_ceiling
campaign_neg_exact  campaign_neg_phrase  campaign_neg_product_target
ad_group_neg_exact  ad_group_neg_phrase  ad_group_neg_product_target
```

So a single source→destination pair with EXACT and PHRASE produces two rows, each carrying its
own bid settings. Bids are per match type, negations are per pair.

### Per-map settings

**Match types**, constrained by destination entity type:

| Destination | Legal match types |
|---|---|
| `KEYWORD` ad group | `EXACT`, `PHRASE`, `BROAD` — at least one required |
| `PRODUCT_TARGET` ad group | `INDIVIDUAL`, `EXPANDED` — at least one required |

Additional constraints, all `MCP`:

- **SD (Display) destinations are not allowed.** SD can be a source, never a destination.
- **SB (Brands) destinations cannot use `EXPANDED` or `BROAD`** — EXACT and PHRASE only.
- **A BRANDS source cannot take campaign-level negatives.** Ad-group negatives only.
- Keyword entities take only exact/phrase negatives; product-target entities take only
  product-target negatives.

**Starting bid** — `bidding_method` with an optional `bidding_method_value`:

| Method | Value |
|---|---|
| `ADLABS` | value must be **null** — AdLabs computes the bid |
| `CPC_PLUS` | positive currency amount, added to CPC |
| `CPC_MINUS` | positive currency amount, subtracted from CPC |
| `CPC_TIMES` | positive multiplier |
| `CUSTOM` | positive currency amount, used flat |

Note this is the **same enum as the `BIDDING_METHOD` campaign filter** (`ADLABS`, `CPC_PLUS`,
`CPC_MINUS`, `CPC_TIMES`, `CUSTOM`), so bidding method is a first-class, filterable property of a
campaign, not a harvest-only setting. One vocabulary reused across surfaces again.

Plus `bid_floor` and `bid_ceiling` per match type — so a harvested EXACT can be floored higher
than a harvested BROAD from the same source.

**Source negation** — six independent booleans per pair:

```
campaign_neg_exact     campaign_neg_phrase     campaign_neg_product_target
ad_group_neg_exact     ad_group_neg_phrase     ad_group_neg_product_target
```

Three negative types × two levels (campaign and ad group). Both levels exist because campaign
negatives stop the term across every ad group in the source while ad-group negatives are surgical
— and because a BRANDS source cannot use the campaign level at all.

**Destructive default worth flagging:** *"An upsert fully replaces the touched pairs' negative
flags — a pair with negatives left at false has its existing negative rows deleted."* So editing
a mapping's bid and forgetting to re-send the negative flags silently removes the negatives. That
is PUT semantics on a nested collection, in a product that uses merge-patch elsewhere. Same
inconsistency as the optimizer groups (see `04-optimizer.md`). **We go merge patch.**

### Bulk template

Two modes for creating mappings:

**JSON mode** — an array of mapping objects, each with its own match types, bids, and negation
flags. Use when pairs differ.

**Reference mode** — pass a data reference with exactly two columns, `source_ad_group_id` and
`destination_ad_group_id`, plus scalar args that apply uniformly to every pair. This is the bulk
template, and it is genuinely clever: the *pairing* comes from a SQL query over your own account
structure, and the *config* comes from a handful of scalars.

AdLabs' own documented recipe — map every "<base> - Auto" ad group to its "<base> - Exact"
sibling:

```sql
SELECT src.ad_group_id AS source_ad_group_id, dst.ad_group_id AS destination_ad_group_id
FROM reference_data src
JOIN reference_data dst
  ON replace(src.campaign_name, ' - Auto', '') = replace(dst.campaign_name, ' - Exact', '')
WHERE src.campaign_name LIKE '% - Auto' AND dst.campaign_name LIKE '% - Exact'
```

then one `upsert_mapping` call with `match_types=["EXACT"]`.

**This is the payoff for a disciplined naming convention.** An account named consistently can
have its entire harvest topology generated from a self-join. An account named ad hoc cannot. We
run a naming convention, so this is directly usable — and it is a strong argument for making
map generation a first-class "generate from naming pattern" feature rather than an SQL trick
buried in an API doc.

Bulk-mode error behavior: null/blank/non-numeric IDs are rejected **atomically** (filter with
`WHERE ... IS NOT NULL` and retry); duplicate pairs are silently deduped. For pairs needing
different config, split the reference with `query` and call once per variant.

### Deletion

`delete_mapping` takes pairs with a `match_types` array; an **empty array deletes the whole
pair's mapping**. Or `delete_all=true` wipes every mapping for the profile. A `note` is required
either way.

`delete_all` with no confirmation step in the contract is a foot-gun on an object that may
represent hours of setup. Ours should require typed confirmation and be revertible via the job
log.

---

## 3. Harvest run

### Preview

`preview_harvest(reference, start_date, end_date, tacos, override_group_settings)` where
`reference` is a **search-term reference from the grid**. So the selection mechanism is: filter
the search-term grid however you like, then harvest exactly that set. No separate selection UI,
no separate filter language. Clone that.

Same discipline as the optimizer: *"Always ask the user for the harvest date range before calling
this tool — never assume or default them."* And `tacos` is required (decimal fraction, >0 and
≤1), so a harvest is always priced against a target.

`override_group_settings` — optimization groups govern harvest bidding too, not just
optimization. The same group that carries a campaign's target ACOS prices its harvested keywords.
That coherence is worth clone-ing: one policy object, applied everywhere the policy is relevant.

### Preview columns (exact)

```
search_term_id  search_term  match  bid  bid_floor  bid_ceiling
bidding_method  bidding_method_value
source_campaign_id  source_campaign_name  source_campaign_ad_type
source_ad_group_id  source_ad_group_name  source_entity_type
dest_campaign_id  dest_campaign_name  dest_campaign_ad_type
dest_ad_group_id  dest_ad_group_name  dest_entity_type
campaign_neg_exact  campaign_neg_phrase  campaign_neg_product_target
ad_group_neg_exact  ad_group_neg_phrase  ad_group_neg_product_target
impressions  clicks  spend  sales  orders  acos
warning
```

One row per **(search term × campaign mapping)** combination — so a term whose source ad group
maps to two destinations, at two match types each, produces four rows. The preview is the full
cross product, which is exactly right: you are approving individual entity creations, not a term.

### The `warning` column

*"The `warning` column is non-empty for rows that would be skipped (e.g. entity already exists,
invalid keyword). Filter these out before applying."* And on apply: *"Rows with a non-empty
`warning` column are automatically skipped."*

**Warn-and-skip rather than fail-the-batch.** A harvest of 400 terms where 30 already exist
proceeds with 370 and tells you about the 30. Combined with the job log's
success/total/failed counts, you get a complete account of what happened. Clone this exactly; it
is the difference between a weekly habit and a quarterly ordeal.

Also note `harvested_targets` on the search-term grid itself (see `02-data-grid.md`) — you can
see what has already been harvested *before* you build the preview, so the warnings should be
rare rather than routine.

### Editing the preview

On apply, if you pass a `reference` from a filtered or edited query on the preview rows, only
those rows apply and the **editable columns are taken from the reference: `bid` and the six
negative flags.** The identifying columns — `search_term`, `dest_ad_group_id`, `match` — must
not be modified.

Explicitly declaring which columns are editable and which are identity is a good contract. It
means "edit the preview then apply" is safe by construction rather than by convention.

### Apply

`apply_harvest(preview_id, note, reference?)`. Re-reads the stored preview by ID. Creates
keywords/product targets in destinations and negatives in sources. `note` required.

Because it lands in the same job log as everything else (`logs(job_overview)` covers "all jobs,
manual and optimizer"), a harvest is revertible by job like any other bulk change — see
`04-optimizer.md` §5.

---

## 4. History views

No harvest-specific history surface exists. Harvest jobs live in the shared job log with
`job_type_label`, `entity_type`, `change_type`, and `flow_type` distinguishing them, plus
`success_count` / `total_count` / `failed_count` and the `note`.

- **Clone:** one job log for every bulk mutation, typed by columns rather than split into
  per-feature histories.
- **Beat:** a harvest-shaped view over it. "What did I promote from Auto last month, and how have
  those keywords performed since" is the question, and answering it currently means joining the
  job log to the target grid by hand. We already store both.

---

## 5. Verdicts

**Clone.**
- The map/harvest split: persistent routing policy configured once, a light weekly run over it.
- `entity_type` and `map_count` in the ad-group picker, so coverage gaps are visible while you
  build rather than discovered later.
- Per-match-type bid settings (method, value, floor, ceiling) on a single source→destination pair.
- Six independent negation flags across two levels and three negative types.
- The five bidding methods (`ADLABS` / `CPC_PLUS` / `CPC_MINUS` / `CPC_TIMES` / `CUSTOM`), and
  reusing that same enum as a filterable campaign property.
- Reference-mode bulk mapping driven by a self-join over the account's own naming.
- Harvest selection = a filtered search-term grid reference. No second selection UI.
- One preview row per (term × mapping) cross product.
- `warning` column with warn-and-skip semantics rather than batch failure.
- Explicit editable-vs-identity column contract on the preview.
- Optimization groups governing harvest bidding as well as optimization.
- Mandatory `note`; harvest lands in the same revertible job log.

**Skip.**
- `delete_all` as a plain boolean parameter on a destructive operation.
- Upsert that silently deletes negative rows when flags are omitted.
- The bulk-template-as-SQL-recipe presentation. The capability is excellent; requiring the
  operator to write a self-join with `replace()` to use it is not.

**Beat.**
1. **Generate maps from the naming convention.** We run a naming convention, and their own
   documented recipe proves the topology is derivable from it. Make "generate maps from pattern"
   a UI action with a preview and a diff, not an SQL snippet in an API doc.
2. **Coverage as a first-class view.** `map_count` exists; nobody surfaces "these 12 ad groups
   produced 3,400 search terms last month and route nowhere". That is the highest-value harvest
   report and it is one group-by away.
3. **Harvest outcome tracking.** Every harvested target has a birth record in the job log and a
   performance record in the target grid. Join them and you can answer "our EXACT harvests from
   Auto convert at X, our PHRASE harvests at Y" — i.e. whether the harvest policy itself is
   right. Nobody does this.
4. **Negation preview.** The preview shows which negatives *will* be created but not what they
   will cost you — a term negated at campaign level in the source kills it across every ad group
   there, including ones still learning. Show the affected surface before applying.
5. **Non-destructive map editing.** Merge patch on nested collections; an upsert should never
   silently delete negatives.
6. **Cross-profile map templates.** Fifteen profiles with the same campaign architecture
   currently need fifteen hand-built map sets.
