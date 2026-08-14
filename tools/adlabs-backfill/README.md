# adlabs-backfill — deep history out of the incumbent

The Amazon Ads API serves roughly 60 to 95 days of report history. A profile we
onboard today therefore starts with a three-month memory, no matter how long the
account has existed. AdLabs has been syncing the same accounts for far longer,
and this tool is how that history gets into our fact tables without corrupting
anything already in them.

Phases 0 and 1 only. Phase 2 is gated — see the last section.

Evidence base: `docs/research/adlabs-backfill-feasibility.md`. Brief:
`docs/workpackages/WP-18-adlabs-backfill.md`.

---

## What this tool is, and what it is not

It does **not** talk to AdLabs. The exports are pulled by an operator-side agent
over the AdLabs MCP — `get_entity_data` → `query` → `download_data` → one HTTPS
GET, strictly read-only — exactly as the crosscheck's exports are. This package
is everything after the file lands:

```
AdLabs MCP  ──▶  raw CSV archive  ──▶  normaliser  ──▶  fact tables
 (the agent)     _local/backfill/      (typed,          (+ provenance
                                        reconciled)      per file)
```

Three verbs write nothing and one reads nothing:

```
depth   --timeline <csv> [--as-of YYYY-MM-DD]
phase0  --timeline <csv> --roster <csv> [--only <amazonProfileId>] [--dry-run]
phase1  --grain <campaign|target|placement|search_term> --file <csv>
        --profile <amazonProfileId> --start YYYY-MM-DD --end YYYY-MM-DD
        [--expect-spend N] [--expect-sales N] [--dry-run]
verify  [--profile <amazonProfileId>]
```

Exit code 2 means a count or a total did not reconcile. The database comes from
`DATABASE_URL` and is never defaulted: a backfill that guesses which database it
is writing to is a backfill nobody should run.

---

## The three rules that keep this safe

### 1. Backfilled rows are invisible to the crosscheck

The crosscheck compares our facts against a fresh AdLabs export and reports
`verified` when they agree. Feed it facts that came **from** AdLabs and it
compares AdLabs against AdLabs, agrees with itself, and returns a confident
verdict that means nothing — a failure shaped exactly like success.

So provenance is a column. `report_requests.source` is `'amazon_api'` or
`'adlabs_backfill'`; every fact row this tool writes points at a ledger row that
says `adlabs_backfill`; and `tools/crosscheck-cli/src/facts.ts` excludes any fact
whose request names a non-Amazon source. A day with only backfilled rows falls
out as `missing_ours`, which is the truth: we hold no independently-sourced
figure for it.

`fact_monthly_rollup` needs none of this — it has its own `source` column and the
crosscheck never reads it.

Proved by `tools/crosscheck-cli/src/backfill-isolation.test.ts` and, on real
data, by a live spot-check: an export built from the backfilled figures
themselves, ingested against the profile that holds them, returned
`missing_ours`.

### 2. The archive cannot be mistaken for the crosscheck's inbox

The crosscheck ingests `adlabs_<grain>_<profileId>_<start>_<end>[_marker].csv`
and ignores everything else. A backfill file called `adlabs_campaign_…_bf.csv`
**would** match — `bf` reads as the optional marker — and would be compared as
though somebody had just exported it.

Backfill files are therefore `adlabsbf_<grain>_<scope>_<start>_<end>.csv` under
`_local/backfill/`, a different prefix in a different root, and
`src/naming.test.ts` asserts across the package boundary that no name this tool
can produce matches the crosscheck's pattern. Structurally impossible beats
carefully avoided.

```
_local/backfill/
  all/profile/          adlabsbf_profile_all_<start>_<end>.csv     (every profile, every day)
                        adlabsbf_profiles_all_<start>_<end>.csv    (roster: id → currency)
  <amazonProfileId>/
    campaign/           adlabsbf_campaign_<id>_<monthStart>_<monthEnd>.csv
    target/             adlabsbf_target_…
    placement/          adlabsbf_placement_…
    search_term/        adlabsbf_search_term_…
  manifest.jsonl        grain, scope, period, rows, bytes, sha256, pulled_at, rows loaded
```

The whole tree is gitignored. It holds real client metrics and never leaves the
operator's machine or the client's pCloud `_Data` archive.

**Download URLs are bearer credentials.** `download_data` returns a plain HTTPS
link with the token inside it, valid fifteen minutes. It never reaches the
manifest, a log, or a run note.

### 3. API wins, and nothing is written without a count

A day already held from our own Reporting v3 pull is never touched — the
backfill fills the gap in front of the API window, it does not restate what we
measured ourselves. Only rows the backfill itself wrote are overwritten, which
is what makes a rerun idempotent rather than destructive.

Every load counts rows offered against rows written and writes both to the
ledger row, where `counts_match` is a stored column. The profile's own
in-progress day is excluded using `ad_profiles.timezone`, not the machine's
clock: on the current local day the ad columns are populated while every seller
total reads 0.

---

## Phase 0 — profile grain, full depth

One `profile` fetch, one `timeline` drill-down, one download: every profile's
complete daily history in a single file, for the cost of three MCP calls. It
lands in `fact_profile_daily` and is the reference series every other grain
reconciles against.

The server zero-fills the requested range, so "earliest date with data" is a
local `min(date)` over rows with a nonzero ad metric — not a server capability.
Currency comes from the roster export, because entity exports carry no currency
column.

### Depth actually loaded

Fourteen of fifteen profiles had data; one is registered and has never
advertised. Relative to the run date, in whole months back:

| Months of daily history | Profiles |
|---|---|
| ~25 | 1 |
| ~21 | 3 |
| ~15 to ~17 | 2 |
| ~9 | 1 |
| ~7 | 2 |
| ~3 | 3 |
| ~2 | 2 |
| none | 1 |

Median about 8 months; six profiles reach 15 months or more. Against the API's
2 to 3 months the median profile gains roughly 5 extra months and the deepest
gains about 22. Depth tracks when each profile was connected to AdLabs, not any
retention cap.

Days actually written: **4,453** across 14 profiles, every one of them counted
and reconciled, none of them overwriting an API-sourced day.

Two profiles' figures are worth knowing about: one stopped reporting a fortnight
before the run (an account that went quiet, not a gap in the pull), and the
deepest profile's history begins mid-week rather than at a month boundary. Both
are properties of the accounts, not of the loader.

---

## Phase 1 — monthly rollups, four grains

One fetch per profile-month per grain into `fact_monthly_rollup` with
`source = 'adlabs_backfill'` and `dimensions` carrying the grain plus the ids
the matching daily table keys on. Roughly 1,800 MCP calls for the whole team
against the ~55,000 a daily walk needs, and zero risk to the crosscheck because
it is a different table.

**Always filter server-side before downloading.** Inserting
`WHERE impressions > 0 OR spend > 0 OR clicks > 0` between the fetch and the
download cut one month of campaign grain from 1,371 rows to 175 and one month of
target grain from 8,860 to 508. That one extra call is the difference between a
2 TB and a 200 GB archive at the deep grains.

### The attribution window, and why two columns stay null

Every AdLabs entity exposes a single `sales` and a single `orders` and does not
say which attribution window they are. Our tables carry 1/7/14/30-day columns
precisely because Amazon restates. Guessing would be a silent, permanent error,
so the figures land in the 7-day columns and `purchases_14d` / `sales_14d` are
left **null** — a question mark, not a claim. Nothing can add a real 14-day
figure to a fabricated one. When the overlap window resolves which window AdLabs
means, the fix is an update over `source = 'adlabs_backfill'` rows.

`days` on a backfilled rollup is the length of the window that was pulled, not
the count of days with data: a monthly window has no date column to count.

### Which grain reconciles against which

Campaign grain is the baseline. On the sampled months, target grain summed to
the campaign total **exactly** — same spend, same sales, same impressions,
clicks and orders. The other two are legitimately smaller and must not be
compared to it:

- **placement** excludes Sponsored Display (which has no placement modifiers),
  and its `SITE_AMAZON_BUSINESS` rows are in the file but out of AdLabs' own
  aggregate. Kept raw, with the label intact, so the difference stays visible.
- **search_term** excludes Sponsored Display entirely, by the provider.

### The two-month check

Two complete months on the deepest profile, at all four grains, cross-checked
four ways. For each month, all of these agreed **to the cent**:

- AdLabs' own aggregate reference for the month,
- the sum of the downloaded campaign-grain rows,
- what came back out of `fact_monthly_rollup` after the load,
- the sum of `fact_profile_daily` for the same month — a Phase 0 pull made
  hours earlier from a different entity.

Target grain matched the same figures independently. Rows read equalled rows
written on all eight loads; the search-term loads folded a handful of duplicate
dimension tuples and said so rather than letting one row win the primary key.

---

## Running it

Local proving runs and the hosted run use the same commands; only
`DATABASE_URL` differs. It must point at a connection with service-role rights:
`app.ensure_fact_partitions` is `security definer` and asserts the role, and
there is deliberately no default partition, so a month nobody opened fails
loudly instead of landing somewhere wrong.

```sh
# 1. what the export holds, before writing anything
pnpm --filter @wizard-ads/adlabs-backfill backfill depth \
  --timeline _local/backfill/all/profile/adlabsbf_profile_all_<start>_<end>.csv

# 2. Phase 0, all profiles, one command
DATABASE_URL=… pnpm --filter @wizard-ads/adlabs-backfill backfill phase0 \
  --timeline _local/backfill/all/profile/adlabsbf_profile_all_<start>_<end>.csv \
  --roster   _local/backfill/all/profile/adlabsbf_profiles_all_<start>_<end>.csv

# 3. Phase 1, one profile-month-grain at a time
DATABASE_URL=… pnpm --filter @wizard-ads/adlabs-backfill backfill phase1 \
  --grain campaign --profile <amazonProfileId> \
  --file _local/backfill/<amazonProfileId>/campaign/adlabsbf_campaign_<id>_<from>_<to>.csv \
  --start <from> --end <to> --expect-spend <adlabs aggregate> --expect-sales <adlabs aggregate>

# 4. what is in there now
DATABASE_URL=… pnpm --filter @wizard-ads/adlabs-backfill backfill verify
```

`--dry-run` parses, counts and reports without writing. Use it first on any
database you would mind being wrong.

Pacing: no throttling has ever been observed on these reads, but the ceiling is
unknown rather than absent. Pull sequentially, one profile at a time, and back
off on any non-200. The only cooldown anywhere is on AdLabs refreshing itself
from Amazon, which is not our read.

---

## Phase 2 is gated

The daily walk — `ad_group`, `target`, `placement` and `search_term` one day at
a time, about 55,000 MCP calls and 2 to 3 GB of archive — is **not** in this
tool and must not be started without an explicit operator decision. Two things
gate it:

1. **The attribution window is unresolved.** Monthly rollups can park an
   unwindowed figure in one column and null the rest. The daily fact tables
   cannot: `fact_sp_target_daily` and its siblings are the tables the optimizer
   reads, and a wrong window there is a wrong bid. The resolution path exists —
   for the 60 to 95 days both sources cover, compare AdLabs `sales` against our
   own `sales_7d` and `sales_14d` for the same campaign-day — and it has to be
   walked first.
2. **It is a contract question, not a pipeline question.** Bulk-extracting an
   incumbent's stored history for a competing in-house product is for the
   operator to settle. Phase 2 is the phase that looks like bulk extraction.

Phase 3 (SQP weekly) additionally has to be driven off the observed non-empty
weeks: coverage has holes that follow Brand Analytics authorisation rather than
advertising activity, and an empty week returns prose with no reference at all.
A loop that treats that as an error stalls; one that treats it as zero writes
false zeros.

---

## Known limits

- **Archived entities are invisible.** The `campaign` entity never returns
  ARCHIVED and `target` returns today's roster only, so a backfilled period can
  under-report what actually happened. Nothing in this source recovers it.
- **Second-hand data.** These are Amazon's numbers as AdLabs stored them, with
  whatever their pipeline did on the way. Backfilled rows are lower-confidence
  than API rows and the `source` marker must survive into anything that mixes
  them.
- **No top-of-search impression share, no SB video or viewability metrics.**
  Not exposed at any grain.
- **Depth is a function of onboarding.** A newly onboarded client gains nothing
  here, and a client we lose takes their history with them when access ends.
  Run this once, early, on every profile.
