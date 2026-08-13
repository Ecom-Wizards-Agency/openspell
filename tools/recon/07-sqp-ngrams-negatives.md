# 07 — SQP reports, n-grams / search-term tools, negatives workflow

**WP-11 recon · STRICTLY READ-ONLY.** No negative was previewed or created. No n-gram analysis
was run against a live reference. SQP structure below is exact — read off a live
`get_entity_data(entity_type="search_query")` response. No UI seen — see `BLOCKED.md`.

---

## 1. SQP: what it is and where the data comes from

### The data-source question, answered

The brief asks what AdLabs can show in an SQP section "without SP-API of their own". The answer
from the evidence is that **they do have a Seller Central data link, and it is a per-profile
connection, not an ads-API side effect.**

Three independent proofs:

1. **The `product` entity carries Business Report columns** that exist nowhere in the Amazon Ads
   API: `organic_traffic`, `total_views`, `ups` (unit-session rate), `buy_box_views`,
   `featured_offer_percent`, `total_sales`, `total_units`, `best_seller_rank`,
   `fulfillable_units`, `days_of_cover`, `out_of_stock_days`, `scarce_stock_days`,
   `availability`. Those are Seller Central / SP-API figures. The contract states it plainly:
   `total_sales` = "Seller Central total sales per ASIN".
2. **The `search_query` entity carries the full SQP surface** including market-wide totals
   (`total_query_impression_count`, `total_purchase_rate`) and shipping-speed splits. Brand
   Analytics Search Query Performance is a Seller Central report, not an ads report.
3. **Vendor profiles get a different column set** (`shipped_revenue`, `shipped_units`,
   `shipped_cogs`, `acogs`, `shipped_tacos`, `ordered_revenue_b2b`) — a distinction that only
   exists on the selling-partner side.

So the claim to document is: **AdLabs joins Amazon Ads data with a per-profile selling-partner
data connection**, and the profile resource exposes a `Sync status` and `Last synced` UTC
timestamp covering both. Whether a given profile has the link is a per-profile fact — the same
shape as AMC, where `is_amc_connected` is a column on the profiles entity.

**Implication for us (WP-02/WP-03):** SQP and Business Report data are not free. Cloning this
grid means standing up an SP-API connection per profile with its own auth, its own sync, and its
own freshness surface. That is a real work package, and the fact that AdLabs makes the connection
state visible per profile is the pattern to copy.

### Granularity and its consequences

`MCP`, verbatim: *"SQP data uses WEEKLY granularity (Sunday–Saturday). Dates are automatically
snapped to full week boundaries."*

Three consequences, all confirmed:

- **`COMPARE_DATE` is not supported on this entity at all.** So the standard four-column
  metric model (value / comparison / delta absolute / delta percent) still appears in the column
  list, but the comparison baseline is the auto-derived preceding period only — you cannot pick
  it.
- **The entity has no date column.** A single multi-week pull aggregates the weeks into one row
  per query. To see week-over-week movement you must pull once per week and stitch. This is the
  most consequential SQP trap in the product and it is not signposted in the column list.
- **No `portfolio_id` and no campaign columns.** SQP is profile-level and not campaign-linked.
  `MCP`: "use `portfolio_name` or the search_term entity for campaign-linked data." So SQP tells
  you about the *market for a query*, and the search-term entity tells you about *your ads on
  that query*, and joining them is the operator's job.

### The paired-column model

Every funnel step has an `asin_*` column (this ASIN) beside a `total_*` column (the whole market
for that query). Full pairing table in `02-data-grid.md` §2. The four shares —
`asin_impression_share`, `asin_click_share`, `asin_cart_add_share`, `asin_purchase_share` — are
the funnel expressed as market position.

**Why this matters more than it looks:** because both sides are in the same row,
*CTR gap vs market* and *CVR gap vs market* are free. `asin_ctr` beside `total_ctr`,
`asin_conversion_rate` beside `total_conversion_rate`. Those two gaps separate a traffic problem
from a listing problem in one glance, and every tool that stores only your own numbers requires
a second source to compute them.

Also present and useful: `search_query_volume`, `search_query_score`, `parent_asin`, `brand`,
`title`, the median price triple (`asin_median_click_price` / `_cart_add_price` /
`_purchase_price` beside their `total_*` twins — i.e. your price vs the market's clearing price
at each funnel step), and shipping-speed splits.

### `existing_targets` — the closing column

Per query, whether you already target it. This is the same idea as `harvested_targets` on the
search-term grid (see `05-harvesting-and-campaign-maps.md`): the row tells you whether you have
already acted on it.

So the SQP grid answers, in one place: this query has *this much* volume, we hold *this* share of
its impressions, we convert *worse/better* than the market, we price *above/below* the market —
and we do/don't target it. That is a keyword-opportunity workflow with no export step. **Clone
the whole shape.**

### Known limitation to carry forward

Per-ASIN, query-level SQP is available and rich. What is *not* available: **`top_of_search_
impression_share` was removed from the target entity on 2026-07-28 with no replacement anywhere**
(see `02-data-grid.md`). So paid top-of-search share is currently a hole, while organic/total
query share is well covered.

---

## 2. N-gram tool

`analyze(search_terms_to_ngrams, reference, n)`.

| Property | Detail |
|---|---|
| Input | A **search-term reference** — i.e. any filtered slice of the search-term grid |
| `n` | Arbitrary N-gram length (1 = unigrams, 2 = bigrams, …) |
| Output | A new reference, one row per distinct N-gram |
| Aggregation | **All** metric columns summed across every search term containing the N-gram |
| `number_of_entities` | How many search terms contain each N-gram |
| Derived metrics | *"recalculated correctly from summed base metrics, not naively averaged"* |
| Cap | Source reference must be ≤ 50,000 rows; filter down with `query` first |

Three things worth stating plainly:

- **Input is a reference, so the n-gram tool inherits the grid's whole filter language.** N-grams
  over non-brand campaigns, over one product line, over last month, over targets tagged Rank —
  all expressible without the n-gram tool knowing anything about filters. This is the reference
  architecture paying off.
- **The output is a reference too**, so you can filter, sort, group, tag, export, or feed it into
  the negatives flow. N-grams are not a dead-end report.
- **Derived metrics are recomputed, not averaged.** Same rule as `group_by_column`. An n-gram's
  ACOS is total spend over total sales across every term containing it, which is the only correct
  answer and the one most implementations get wrong.

The output columns are the summed search-term metric set plus `number_of_entities`. Note there is
no position or ordering information — an N-gram is a bag of adjacent words, so "cases containing
this bigram at the start" is not answerable.

### Brand leak detection

`analyze(brand_spend_leak_detection, reference, campaign_reference, brand_name)`.

Takes a search-term reference **and** a campaign reference pre-filtered to non-brand campaigns,
plus a brand name. Returns only the search terms containing the brand name that fired in those
campaigns.

The stated rationale is correct and worth recording: brand terms convert very well, so when they
leak into generic discovery campaigns they *inflate that campaign's apparent performance* and
cannibalize budget meant for new-customer acquisition. The campaign looks like a winner because
it is quietly buying your own name.

**Known defect, carried from prior team findings:** the match is a case-insensitive **substring**
on `brand_name`, so it silently misses misspellings, spacing variants, and phonetic variants that
do not contain the root string. Scan variants manually before trusting the total. That is exactly
the kind of thing we should fix rather than reproduce — a brand-alias list per profile, with the
matched-variant set reported alongside the total.

Note also that the analysis depends on the operator correctly pre-filtering "non-brand campaigns"
by hand. If campaigns were tagged Brand / Non-Brand (see `06-tags.md`), this would be a one-click
analysis instead of a two-reference setup — another instance of "tags classify but nothing acts
on the classification."

---

## 3. Negatives workflow

A two-step preview → apply flow, same shape as the optimizer and harvest.

### Step 1: preview

`create_entities(entity_type="negative_targeting", reference, match_types, keywords?, expressions?)`
→ returns a `preview_id` and a **"View in AdLabs"** link.

**Two modes**, chosen by what kind of reference you pass:

| Mode | Reference | Behavior |
|---|---|---|
| **A** | `search_term` rows | Keywords are read from the `search_term` column of each row. Pass keyword match types to control how each term is negated. **Product-target match types are not supported in this mode.** |
| **B** | `campaign` or `ad_group` rows | You supply explicit `keywords` and/or `expressions` plus match types. Keyword match types create negative keywords; `*_NEGATIVE_PRODUCT_TARGET` creates negative product targets (expressions like `asin="B0..."`). |

Mode A is the weekly workflow: filter the search-term grid to the waste, negate it. Mode B is the
deliberate one: apply a known list of negatives across a set of campaigns.

**Eight match types**, three negative kinds × two levels (minus the campaign/broad interactions):

```
CAMPAIGN_NEGATIVE_EXACT   CAMPAIGN_NEGATIVE_PHRASE   CAMPAIGN_NEGATIVE_BROAD   CAMPAIGN_NEGATIVE_PRODUCT_TARGET
AD_GROUP_NEGATIVE_EXACT   AD_GROUP_NEGATIVE_PHRASE   AD_GROUP_NEGATIVE_BROAD   AD_GROUP_NEGATIVE_PRODUCT_TARGET
```

### Constraints (all `MCP`, all enforced by silent skipping)

- **Sponsored Display is not supported** — SD rows are skipped automatically.
- **`BROAD` match types are Sponsored Products only** — non-SP rows are skipped and reported in
  the receipt. Pre-filter by `campaign_ad_type_raw = 'PRODUCTS'` to avoid surprises.
- **Campaign-level negatives are Sponsored Products only** — Sponsored Brands supports only
  `AD_GROUP_NEGATIVE_*`.
- `AD_GROUP_NEGATIVE_*` requires `ad_group_id` in the reference.
- Amazon's keyword limits, enforced: **max 80 characters**, **max 4 words for PHRASE**, **max 10
  words for EXACT**.

### The count honesty problem — and it is a good example for our program rule 4

`MCP`, verbatim and unusually candid:

> *"The previewed count is the raw rows × match_types × keywords/expressions cross-product and is
> NOT checked against negatives that already exist, so re-creating a preview always returns the
> same count and never proves whether an earlier apply worked. Negatives that already exist are
> skipped at apply time and reported in the apply receipt."*

So: the preview count is a **cross-product, not a diff.** Preview 400, apply, preview again →
still 400. The only trustworthy number is the apply receipt.

This is precisely our own rule "verify the artifact, not the exit code", and it is a defect worth
beating rather than cloning: **the preview should be a diff against existing state**, showing
"312 new, 88 already exist". Every input for that is available — the `negative_targeting` entity
is fetchable for the whole profile.

### Step 2: apply

Two paths, and the contract is explicit that the choice is about human review:

| Path | When |
|---|---|
| Show the **"View in AdLabs"** link | The user should review and confirm in the UI before anything is sent to Amazon |
| `create_entities(entity_type="negative_targeting_apply", preview_id, note)` | "Automated flows without human review" |

A `note` is required on apply. The apply receipt reports skipped rows (already exist, wrong ad
type, SD).

**Clone the two-path shape.** A preview object that can be handed to a human via a link *or*
applied programmatically, with the same `preview_id` either way, is exactly the right primitive
for an agent-driven tool: the agent prepares, the human approves, and there is one artifact
between them. This is also the correct model for our own staged-apply engine (WP-12).

### Reading existing negatives

`get_entity_data(entity_type="negative_targeting")` is a **non-metric entity**: no `DATE` filter,
no `COMPARE_DATE` — omit `filters` entirely or pass `[]` to fetch all. It uses `match_type`
**singular**, unlike `match_types` plural on the target entity.

---

## 4. How the three tools compose

The workflow the architecture implies, and it is coherent end to end:

```
search_term grid  ──filter──►  reference
       │                          │
       ├── analyze(ngrams, n=2) ──► ngram reference ──► filter to wasteful grams
       │                                                      │
       ├── analyze(brand_leak) ────► leaked terms ─────────────┤
       │                                                      ▼
       └──────────────────────────────────► create_entities(negative_targeting) ──► preview_id
                                                                                      │
                                            ┌─────────────────────────────────────────┤
                                            ▼                                         ▼
                                   "View in AdLabs" link                    negative_targeting_apply
                                     (human approves)                          (agent applies)
```

And in parallel, the *positive* branch of the same grid feeds harvesting
(`05-harvesting-and-campaign-maps.md`). One search-term selection, two destinations: promote the
winners, negate the losers.

That symmetry is the best thing in this area of the product.

---

## 5. Verdicts

**Clone.**
- The SQP paired-column model (`asin_*` beside `total_*` at every funnel step), which makes
  CTR-gap and CVR-gap against the market free.
- Median price at each funnel step, ours vs market's.
- `existing_targets` on SQP and `harvested_targets` on search terms — "have I already acted on
  this row" as a column.
- N-grams over a *reference*, so they inherit the grid's whole filter language, and returning a
  *reference*, so they are not a dead end.
- Derived metrics recomputed from summed bases at every aggregation, n-grams included.
- The eight-way negative match-type matrix (3 kinds × 2 levels) with ad-type constraints
  enforced.
- Preview → apply with a `preview_id` that can be handed to a human as a link **or** applied
  programmatically. Same artifact, two paths.
- Warn-and-skip with a receipt, rather than failing the batch.
- Per-profile selling-partner connection state made visible (the AMC `is_amc_connected` pattern).

**Skip.**
- SQP without a date column. Aggregating weeks into one row by default, with week-over-week
  requiring N separate pulls, is a trap rather than a design.
- `match_types` plural vs `match_type` singular across two entities that are always used together.
- Brand-leak detection driven by a single substring.
- Preview counts that are cross-products rather than diffs.

**Beat.**
1. **SQP with a real time axis.** Store weeks as weeks. Week-over-week share movement is *the*
   SQP question and it currently costs one API pull per week plus a manual stitch.
2. **Preview as a diff, always.** "312 new, 88 already exist, 14 skipped (SB cannot take campaign
   negatives)" before you apply, not in the receipt after. This applies to negatives, harvests,
   and optimizations alike — it is our program rule 4 rendered as UI.
3. **Brand aliases as a per-profile object.** A list of brand variants, misspellings, and
   phonetic forms, with the matched set reported beside the leak total, replacing a substring
   match that silently under-reports.
4. **Join SQP to ads.** SQP is profile-level and not campaign-linked; the search-term entity is
   campaign-linked. The operator's real question — "did our click share fall because we quietly
   cut spend on that query?" — needs both and currently requires an external toolchain to answer.
   Doing that join natively is the single highest-value differentiator in this area.
5. **Paid top-of-search share.** Removed from AdLabs on 2026-07-28 with no replacement.
6. **Negatives driven by tags and rules**, not one-shot bulk actions against a snapshot — same
   argument as `06-tags.md`.
7. **N-gram position awareness.** Leading vs trailing occurrence of a gram changes intent
   materially ("case for x" vs "x case") and a bag-of-grams cannot express it.
