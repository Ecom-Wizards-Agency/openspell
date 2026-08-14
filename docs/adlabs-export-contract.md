# AdLabs export contract (crosscheck inbox)

**Owner:** WP-10. The machine-readable half is `tools/crosscheck-cli/src/contract.ts`; this
document and that file are one contract described twice, so they change together.

The crosscheck compares our synced facts against the incumbent's numbers. The incumbent's
numbers arrive as CSV exports, pulled on a schedule by an operator-side agent through the AdLabs
MCP (`download_data` on a filtered reference) and dropped into an inbox directory. Nothing in
wizard-ads calls AdLabs: the inbox is the whole interface.

## 1. Where files land

```
<inbox>/                       # configured per deployment, e.g. a mounted bucket
  adlabs_profile_….csv         # waiting to be ingested
  adlabs_campaign_….csv
  processed/                   # ingested. Kept, never deleted.
```

An export is the evidence for a verdict. When somebody disputes a mismatch six weeks later, the
answer is the file, so ingestion **moves** files into `processed/` and never removes them.

## 2. File name

```
adlabs_<grain>_<amazonProfileId>_<startDate>_<endDate>[_<marker>].csv
```

| Part | Values | Why it is in the name |
|---|---|---|
| `grain` | `profile` · `campaign` | Decides which comparison runs and which grain the verdict is written at. |
| `amazonProfileId` | Amazon's profile id, as in `ad_profiles.amazon_profile_id` | A CSV in a shared inbox is otherwise unattributable, and an export compared against the wrong profile produces a confident wrong verdict. |
| `startDate`, `endDate` | `YYYY-MM-DD`, inclusive | The window the export covers. Campaign grain compares the window as one total. |
| `marker` | optional, alphanumeric | Free space for the pulling agent (a run id, a pull timestamp). Ignored. |

Examples:

```
adlabs_profile_1234567890_2026-08-01_2026-08-07.csv
adlabs_campaign_1234567890_2026-08-01_2026-08-07_r7d9.csv
```

A file whose name does not match is **ignored**, not rejected: an inbox is a shared folder and a
stray README is not an incident. A file whose name names a different profile than the job asking
for it **is** an error — that is a mis-filed export, not a wide one.

## 3. Columns

Header names are matched case-insensitively after trimming. The first alias found wins.

| Field | Accepted column names | profile grain | campaign grain |
|---|---|---|---|
| Day | `date`, `report_date`, `day` | **required** | optional |
| Profile | `profile_id`, `amazon_profile_id`, `profile`, `profile_amazon_id` | optional, used as a filter | optional, used as a filter |
| Campaign id | `campaign_id`, `campaign_global_id` | — | **required** |
| Campaign name | `campaign_name`, `campaign` | — | optional, shown in the drill-down |
| Ad spend | `spend`, `ad_spend`, `cost` | **required** | **required** |
| Ad sales | `sales`, `ad_sales`, `attributed_sales` | **required** | **required** |
| Total sales | `total_sales` | optional, read but not compared in v1 | — |

Extra columns are ignored. A missing required column fails the ingest with the names it looked
for and the names it found, because "missing column" without either is a support ticket.

### Formats the reader accepts

- Delimiter `,`, `;` or tab, **sniffed** from the header. A semicolon file read as comma parses
  into one column per row with no error and no data.
- In a semicolon file, `,` is the decimal separator (`1.234,56` is one number). Where both
  separators appear, the last one is the decimal point.
- A leading byte-order mark, quoted fields containing the delimiter, doubled quotes, CRLF.
- Currency symbols, thousands separators, parenthesised negatives.
- An empty cell, `-` or `n/a` means **no figure**, which the verdict model records as
  `missing_theirs` — never a silent zero.

## 4. Grain semantics

**`profile`** — one row per day. The comparison is per day, against `fact_profile_daily`.

**`campaign`** — one row per campaign, covering the whole window. If the export was pulled with
a daily breakdown, include the `date` column and one row per campaign-day; rows are summed over
the window before comparison, and both shapes must produce the same verdict. The verdict is
written at `campaign_week` grain, dated the window's start.

## 5. Two provider quirks the ingest handles

1. **`get_entity_data` returns every profile the team can see**, whatever `profile_id` was
   requested. So when a profile column is present, rows for other profiles are dropped and the
   drop is counted (`rowsParsed` against `rowsKept`); when it is absent, the filename is the only
   claim of scope and is checked against the job.
2. **The in-progress day reads 0 in the `total_*` columns.** A window that includes today is
   accepted, and today is recorded as `skipped_provisional` with both figures kept rather than
   compared. Our own `fact_profile_daily.provisional` flag does the same thing from our side.
   Either is enough to exclude a day.

A third quirk is worth knowing when reading a placement-level export, which v1 does not compare:
row counts and aggregate counts legitimately disagree there (`SITE_AMAZON_BUSINESS` rows are in
the rows and out of the totals). Do not build a crosscheck on that grain without handling it.

## 6. What the pulling agent should produce, nightly

Per pilot profile, two files:

- `adlabs_profile_<id>_<D-8>_<D-1>.csv` — daily breakdown, last complete week.
- `adlabs_campaign_<id>_<D-8>_<D-2>.csv` — campaign totals for one complete week.

Both windows end on a **complete** day. Including today is allowed and safe (it is excluded), but
a window that ends today buys nothing.
