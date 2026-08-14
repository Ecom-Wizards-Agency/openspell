# Can we backfill deep history out of AdLabs?

**Verdict: yes, for every grain our fact tables carry, with two named caveats.**
Investigated live against the AdLabs MCP on 14.08.2026, read-only. Sample exports for each
entity type are in `_local/backfill-samples/` (gitignored). Nothing was written to AdLabs and
no backfill was run.

The problem this answers: the Amazon Ads API only serves roughly 60 to 95 days of report
history, so a profile we onboard today starts with a three-month memory. AdLabs has been
syncing the same accounts for far longer. This document establishes how much longer, how to
get it out, and how to load it without corrupting the crosscheck.

Profiles are anonymised throughout:

| Label | Shape |
|---|---|
| Profile A | small US seller, recently onboarded |
| Profile B | mid-size US seller, the main measurement subject |
| Profile C | largest US seller in the team, used for volume ceilings |
| Profile D | deepest history in the team (EU) |
| Profile E | a dormant profile that is registered but has never advertised |

---

## 1. History depth

Measured by fetching the `profile` entity over an eight-year window and drilling into
`timeline`, which returns one row per calendar day per profile. The server happily accepts a
range starting years before the account existed and returns a zero-filled row for every day, so
"earliest date with data" is a local `min(date) where impressions > 0 or spend > 0` on the
export, not a server capability question.

### Per profile (advertising metrics, daily)

Across the 15 profiles on the team, relative to the run date:

| Depth of daily ad history | Profiles |
|---|---|
| ~25 months | 1 (Profile D) |
| ~21 to ~22 months | 3 |
| ~16 to ~17 months | 2 |
| ~9 months | 1 |
| ~7 to ~8 months | 2 |
| ~3 to ~4 months | 4 |
| ~2 months | 1 (Profile A) |
| no data at all | 1 (Profile E) |

Median depth is roughly 7.5 months; six profiles reach 16 months or more. Against the Amazon
API's 2 to 3 months, the median profile gains about 4 extra months and the deepest gains about
22. Depth tracks when the profile was connected to AdLabs, not any retention cap: nothing in the
data suggests AdLabs trims old days.

**Seller-side totals go back further than the ad data.** The `seller_*` columns on the profile
timeline (total sales, sessions, page views, Buy Box) start up to ~31 months back on the oldest
profiles, several months before the first advertising day. That is the Seller Central SP-API
link, and it is what `fact_profile_daily.sales_7d` would need alongside ad cost.

### Per entity level

| Grain | Available? | Time basis | How you get one period |
|---|---|---|---|
| Profile daily | yes, full depth | calendar day, profile-local | `profile` fetch → `timeline`. One call pair covers **every profile and every day at once**. |
| Campaign daily | yes | calendar day | one `campaign` fetch per day. No date column in the output. |
| Ad group daily (also the SB/SD carrier) | yes | calendar day | one `ad_group` fetch per day |
| Target / keyword daily | yes | calendar day | one `target` fetch per day |
| Search term daily | yes | calendar day | one `search_term` fetch per day. SP and SB only, SD excluded by the provider. |
| Placement daily | yes | calendar day | one `placement` fetch per day |
| SQP / `search_query` | yes | **week, Sunday-dated** | one `search_query` fetch per week |
| DSP | not exercised (no DSP on these profiles) | — | — |

**`timeline` does not solve the daily problem.** It returns one row per date with metrics
**aggregated across every entity in the source reference** — an 82-campaign reference collapses
to 956 date rows with no `campaign_id` column. It is only per-entity when the reference contains
exactly one entity. So a full-history walk is a loop over days (or weeks for SQP), one fetch per
period, at every grain below profile. Profile grain is the single exception and is essentially
free.

### What `search_query` actually has instead of a date

The known "no date column" behaviour is confirmed, and this is the mechanism behind it: SQP is
weekly, snapped to Sunday–Saturday, and a multi-week request returns one row per query with the
weeks summed. Running `timeline` on an SQP reference returns weekly rows — every date is a
Sunday, every gap is exactly seven days — so weekly pulls are the correct and only unit.
`COMPARE_DATE` is rejected on this entity.

SQP depth is **not** the same as ad depth and has holes. Profile B has an unbroken run of ~59
weekly periods starting ~22 months back, then a five-month hole, then one isolated recent week.
That pattern follows Brand Analytics / SP-API authorisation, not advertising activity. Any SQP
backfill must be driven off the observed non-empty weeks rather than a date range, and a
single-week fetch inside a hole returns a plain "no data found" message with no reference at all
— which the pipeline must treat as "empty", not "failed".

---

## 2. Export mechanics

- **`download_data` takes a reference and returns a plain HTTPS URL** valid for 15 minutes. No
  auth header is needed: the bearer is inside the URL. Treat the URL as a credential — never log
  it, never write it into a run record.
- **Format is CSV only.** One header row, comma-delimited, one row per entity in the reference.
- **No observed row cap.** The largest single export pulled here was 47,205 rows / 21 MB and it
  came down in under 9 seconds over `curl`. There is no pagination and none appeared to be
  needed.
- **No date column on any entity export.** The day is a property of the *request*, not the file.
  A backfill therefore has to stamp the date itself, from the filename or a sidecar.
- **No server-side date slicing beyond the filter.** You cannot ask for "daily breakdown of this
  range"; you re-ask per day.
- **Entity rosters are current-state, metrics are date-filtered.** A `campaign` fetch for a
  single day two months ago returned all 82 campaigns that exist *today*, of which 25 had
  non-zero metrics. Same for `target`: identical 171-row roster whether the window is one day or
  two and a half years. Consequences in §3.
- **Filter before downloading.** Inserting a `query` step with
  `WHERE impressions > 0 OR spend > 0 OR clicks > 0` cut Profile C's single-day target export
  from 8,375 rows to **328** — a 96% reduction — and Profile B's from 171 to 49. This one extra
  call per period is the difference between a 2 TB and a 200 GB archive at target grain. Do it
  always.
- **Row size** is ~650 to 920 bytes uncompressed across all grains (these exports are wide: 104
  to 123 columns, most of them comparison and delta columns we do not need).

### Rough volume, per profile-month, after the zero-row filter

| Grain | Mid-size profile (B) | Largest profile (C) |
|---|---|---|
| campaign | ~750 rows | ~2,000 rows (est.) |
| ad group | ~750 rows | ~2,000 rows (est.) |
| target | ~1,500 rows | ~10,000 rows |
| search term | ~600 rows | ~9,000 rows |
| placement | ~1,500 rows | ~6,000 rows (est.) |

Call it ~5,000 rows (~4 MB) per profile-month for a mid profile and ~29,000 rows (~25 MB) for
the largest. Gzipped, roughly a tenth of that.

---

## 3. Fidelity

### Grains reconcile exactly

One completed day on Profile B, pulled independently at four grains:

| Grain | impressions | clicks | spend | orders | sales | units |
|---|---|---|---|---|---|---|
| campaign | 6,250 | 27 | ✓ | 2 | ✓ | 2 |
| target | 6,250 | 27 | ✓ (identical) | 2 | ✓ (identical) | 2 |
| placement | 5,081 | 27 | ✓ (identical) | 2 | ✓ (identical) | 2 |
| search term | 622 | 27 | ✓ (identical) | 2 | ✓ (identical) | 2 |

Spend, clicks, orders, sales and units agree **to the cent and the unit** across all four, and
the summed campaign day equals the profile-timeline row for that date exactly. Impressions
legitimately differ by grain (a search term only counts impressions where the query matched; the
placement grain excludes some inventory). This is a strong result: the grains are one dataset
sliced four ways, not four independent reports.

### What does not reconcile, and what is missing

1. **No attribution-window split.** Every entity exposes a single `sales` and `orders`. Our fact
   tables carry `sales_1d/7d/14d/30d` and `purchases_1d/7d/14d/30d` precisely because Amazon
   restates. AdLabs collapses that to one number and does not say which window it is. This is the
   single largest fidelity gap.
   *Resolution path:* we have an overlap. For the ~60 to 95 days both sources cover, compare
   AdLabs `sales` against our own `sales_7d` and `sales_14d` for the same campaign-day. Whichever
   matches is the window, and if none matches cleanly the backfill lands in one designated column
   with the rest null.
2. **`same_sku_sales` is populated at campaign grain and reads 0 on the profile timeline** for
   the same day. Do not cross-source that column.
3. **Archived entities are invisible.** The `campaign` entity never returns ARCHIVED; `target`
   returns today's roster only. On the day sampled, target-grain spend still summed to the
   campaign total exactly, so nothing was lost there — but that is luck of that day, not a
   guarantee. **Every backfilled day must be reconciled target-sum against campaign-sum at load
   time**, and a day that does not reconcile is loaded with a shortfall recorded, never silently.
4. **No top-of-search impression share** anywhere on the target entity, so
   `fact_sp_target_daily.top_of_search_impression_share` stays null for backfilled rows.
5. **No SB video or viewability metrics**, so `fact_sb_daily.metrics` stays `{}`.
6. **`SITE_AMAZON_BUSINESS` placement rows are in the rows and out of the aggregate.** The
   server says so explicitly in the fetch response (65 rows in, `number_of_entities` reduced
   accordingly). Known already from the crosscheck contract; still true.
7. **The in-progress day is confirmed.** On the most recent day the ad columns are populated
   while every `seller_*` / total column reads 0. Never backfill or compare the profile's current
   local day.

### Currency and timezone

`currency_code` is a profile property (the team spans USD, EUR, CAD, AUD) and is on the profile
export; entity exports carry no currency column, so it must be attached from the profile at load
time. Dates are the profile's own calendar day — the campaign-day fetch and the profile timeline
agreed on the same date boundary, and `ad_profiles.timezone` is the right thing to interpret them
against. No timestamps appear anywhere in the metric exports.

---

## 4. Proposed backfill pipeline

### 4.1 Shape

```
AdLabs MCP  ──(1)──▶  raw CSV archive  ──(2)──▶  normaliser  ──(3)──▶  fact tables
 per period            _local/backfill/            (typed,              (+ provenance
 per grain             or pCloud                    reconciled)          row per file)
```

**(1) Export.** Per profile, per grain, per period:
`get_entity_data` → `query` (drop zero rows) → `download_data` → `curl`. Three MCP calls and one
HTTPS GET per period. Write the file, then move on; never hold a reference across periods
(references expire after ~2 hours).

**(2) Archive.** Raw files are the evidence and are never deleted, exactly like the crosscheck's
`processed/`. Layout:

```
_local/backfill/
  <amazonProfileId>/
    target/       adlabsbf_target_<profileId>_<YYYY-MM-DD>.csv
    search_term/  adlabsbf_search_term_<profileId>_<YYYY-MM-DD>.csv
    placement/    …
    ad_group/     …
    search_query/ adlabsbf_search_query_<profileId>_<weekStartSunday>.csv
    profile/      adlabsbf_profile_<profileId>_<start>_<end>.csv
  manifest.jsonl   one line per file: grain, profile, period, rows, bytes, sha256, pulled_at
```

Anything over a few GB moves to pCloud under the client's `_Data` archive with the manifest
staying local.

**(3) Load.** Normalise wide CSV to the fact columns, attach `currency_code` and `org_id` from
`ad_profiles`, reconcile, insert.

### 4.2 The filename prefix is deliberately NOT `adlabs_`

The crosscheck ingests `adlabs_<grain>_<profileId>_<start>_<end>[_marker].csv` from its inbox and
ignores anything that does not match. A backfill file named `adlabs_campaign_…_bf.csv` **would**
match — `bf` reads as the optional marker — and would be ingested as an incumbent export. Using
`adlabsbf_` and a separate root makes that mistake structurally impossible rather than merely
discouraged. This is an extension of the export contract, not a change to it: §2 of
`docs/adlabs-export-contract.md` is untouched.

### 4.3 Marking backfilled rows

The daily fact tables have no `source` column; they have `report_request_id`, which is the
provenance hook. So:

- **Insert one `report_requests` row per exported file**, with `report_type` set to the matching
  grain, `start_date`/`end_date` the period, `status = 'completed'`, `rows_parsed` / `rows_loaded`
  filled from the file and the load, and `amazon_report_id` set to `adlabs:<reference-uuid>`.
  Every fact row then points at a request that names its origin.
- **Add a `source` column to `report_requests`** (`'amazon_api' | 'adlabs_backfill'`, default
  `'amazon_api'`). One column, one migration, and it makes "is this row ours or theirs" a join
  rather than a string-prefix guess. `amazon_report_id` prefixing works without the migration but
  is the weaker version and should not be the only marker.
- `fact_monthly_rollup` already has `source text` — use `'adlabs_backfill'` there directly.

### 4.4 Not poisoning the crosscheck

`tools/crosscheck-cli/src/facts.ts` reads `fact_profile_daily` and the SP/SB/SD dailies with **no
source filter**. If AdLabs-derived rows sit in those tables, the crosscheck compares AdLabs
against AdLabs and returns a confident `verified` that means nothing. Two mechanisms, both
cheap, and we should have both:

1. **Filter at read time.** The fact readers join `report_requests` and exclude
   `source = 'adlabs_backfill'`. A day with no API-sourced row then correctly falls out as
   `missing_ours` instead of silently agreeing.
2. **Bound the job by date.** The crosscheck job carries the profile's API-sync start date and
   refuses windows that begin before it. A crosscheck of a period the API never covered is not a
   check.

The `profile` grain deserves a third guard: backfilled `fact_profile_daily` rows should be
written with `provisional = false` only for days that were complete at pull time, and the
crosscheck already skips provisional days.

### 4.5 Suggested sequencing

**Phase 0 — profile grain, immediately.** Three MCP calls total (`profile` fetch → `timeline` →
`download_data`) return every profile's complete daily history in one 47k-row file. This is
already done and sitting in `_local/backfill-samples/`. It backfills `fact_profile_daily` for
every profile to its full depth for the cost of a single request, and it is the reference series
every other grain reconciles against.

**Phase 1 — monthly rollups, full depth, all grains.** One fetch per profile-month per grain into
`fact_monthly_rollup` (`source = 'adlabs_backfill'`, `dimensions` carrying campaign/target ids).
Roughly 150 profile-months × 4 grains × 3 calls ≈ **1,800 calls**, minutes of runtime, zero risk
to the crosscheck because it is a different table. This buys long-run trend charts almost for
free and should ship before anyone commits to the daily walk.

**Phase 2 — daily grain, prioritised.** Walk days for `ad_group`, `target`, `placement`,
`search_term`, oldest-first per profile, on the profiles where the depth gain is largest. Resume
from the manifest; a rerun of a completed period is a no-op.

**Phase 3 — SQP weekly**, driven off the observed non-empty weeks.

---

## 5. Call and volume estimates for ten managed profiles

Summed ad-active spans for the ten profiles worth backfilling come to roughly **4,600
profile-days** and **650 profile-weeks**.

| Phase | Unit | Units | MCP calls (3/unit) |
|---|---|---|---|
| 0 — profile daily, all profiles, full depth | one-off | 1 | **3** |
| 1 — monthly rollups, 4 grains | profile-month × grain | ~600 | **~1,800** |
| 2 — daily, `ad_group` | profile-day | 4,600 | ~13,800 |
| 2 — daily, `target` | profile-day | 4,600 | ~13,800 |
| 2 — daily, `placement` | profile-day | 4,600 | ~13,800 |
| 2 — daily, `search_term` | profile-day | 4,600 | ~13,800 |
| 3 — SQP weekly | profile-week | ~650 | ~1,950 |
| **Full daily backfill** | | | **~59,000 calls** |

Plus one HTTPS GET per unit (~19,700 downloads). At the observed latency (1 to 3 s per MCP call,
under 9 s for a 21 MB download) a strictly sequential full run is on the order of **30 hours**;
with four workers, under a day. Phases 0 and 1 together are **under half an hour**.

Archive size after the zero-row filter: roughly **2 to 3 GB uncompressed**, ~250 MB gzipped, for
all four daily grains across ten profiles. Row count into the fact tables: order of **2 to 3
million**.

### Throttling

None observed. Roughly 35 MCP calls in 25 minutes, including a 47k-row export, produced no rate
limit, no backoff, and no degraded response. The only cooldown seen anywhere is on the profile's
own **data sync** (`Next allowed` about 40 minutes after the last sync) — that governs AdLabs
refreshing itself from Amazon, not our reads. Because the ceiling is unknown rather than absent, a
real backfill should still pace itself (a small delay between calls, exponential backoff on any
non-200) and be resumable from the manifest.

---

## 6. Open risks

1. **The attribution window is unknown.** Blocking for `fact_sp_target_daily` and friends until
   resolved against the overlap window. Do not guess.
2. **Archived campaigns and deleted targets are invisible**, so a backfilled day can under-report
   relative to what actually happened. The campaign-vs-target reconciliation catches it; nothing
   recovers it. Historical spend on entities that no longer exist may simply be unrecoverable
   from this source.
3. **This is a second-hand source.** Everything here is Amazon data as AdLabs stored it, with
   whatever their pipeline did to it. Backfilled rows are lower-confidence than API rows and the
   `source` marker must survive into any chart or export that mixes them.
4. **Depth is a function of onboarding, not policy.** A newly onboarded client gets no benefit
   from this at all, and a client we lose takes their history with them when access ends. The
   backfill should run **once, early, on every profile** rather than being treated as an
   on-demand capability.
5. **SQP holes are silent.** An empty week returns prose, not an empty reference. A naive loop
   that treats "no reference" as an error will stall; one that treats it as zero will write false
   zeros.
6. **Download URLs are bearer credentials** with a 15-minute life. They must never reach a log,
   a manifest, or a run note.
7. **`get_entity_data` still returns all team profiles for the `profiles`/`profile` entities**
   regardless of `profile_id`. The profile-grain backfill must filter post-fetch on
   `profile_id`, exactly as the crosscheck ingest already does.
8. **Legal and contractual.** Bulk-extracting an incumbent tool's stored history for loading into
   a competing in-house product is a question for the operator, not for the pipeline. Worth
   settling before Phase 2, which is the phase that looks like bulk extraction.

---

## 7. Sample exports produced (proof, gitignored)

`_local/backfill-samples/`:

| File | What it proves |
|---|---|
| `profiles_8y.csv` | profile roster with currency; 15 rows |
| `profile_timeline_8y.csv` | 47,205 rows, every profile × every day over 8 years — the full profile-grain backfill in one file |
| `campaign_day_2025-06-10.csv` | campaign grain, one day, SP + SB + SD in one export |
| `ad_group` (fetched, not downloaded) | carries `campaign_ad_type`, `campaign_id`, `ad_group_id` — the SB/SD carrier |
| `target_day_2025-06-10.csv` | target grain, one day, mid profile |
| `target_day_filtered_profileC_2025-06-10.csv` | the same grain on the largest profile **after** the zero-row filter: 8,375 → 328 rows |
| `searchterm_day_2025-06-10.csv` | search term grain, one day |
| `placement_day_2025-06-10.csv` | placement grain, one day, including the `SITE_AMAZON_BUSINESS` rows |
| `sqp_timeline_weekly.csv` | SQP weekly cadence, Sunday-dated, and the coverage holes |
