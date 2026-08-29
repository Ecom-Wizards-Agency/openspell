# WP-85 — Sponsored Brands Video observed-attribution ingestion

## Goal

Promote the WP-83 read-only probe into the smallest production worker foundation that can persist
current Sponsored Brands Video asset mappings honestly, while keeping historical attribution and
Amazon writes disabled.

## Verified provider boundary

- Sponsored Brands ads expose `adId`, `creative.creativeVersion` and
  `creative.videoAssetIds`.
- The provider does not expose a separate `creativeId`. Wizard Ads stores `creative_id = null` and
  never copies `adId`, `creativeVersion` or Asset ID into that field.
- Amazon Asset ID is the asset identity. A nullable content hash is metadata only and never a key.
- `sbAds`, grouped by `ads`, provides daily ad-grain performance and the four stored video funnel
  metrics. It does not provide placement, so persisted facts keep `placement = null` and the UI says
  `Placement not reported`.
- A current ad listing does not prove that its mapping was valid on an earlier report date.

## Delivered behavior

### Contracts and storage

- The base `ReportType` remains unchanged. `WorkerReportType` adds `sbAds`, and the durable report
  enum/ledger accepts it without widening schedule and report-promotion consumers that still require
  the base type.
- Creative mappings and facts preserve nullable `creativeVersion`, mapping provenance and the
  creative snapshot UUID. A mapped SB row may use `creativeId` or `creativeVersion`; WP-85 rows use
  `creativeId = null` plus the exact provider version.
- `creative_sync_snapshots` is a tenant/RLS table with source, parsed and coverage counts for
  `mapped`, `legacy`, `unsupported`, `ambiguous` and `unmapped`, plus report accounting and exact
  upsert/readback evidence.
- `(profile_id, amazon_asset_id)` remains the Asset Library uniqueness boundary. Content-hash nulls
  and duplicate non-null hashes do not collapse separate assets.
- A report request may reference a creative snapshot only when its durable report type is `sbAds`.
  Its additive ledger accounting stores source, parsed, refused, promoted, unpromoted and canonical
  counts; partial attribution is complete only when both arithmetic identities reconcile.

PostgreSQL enum additions must commit before a constraint can use the new label, so WP-85 uses one
enum migration followed by one schema migration. Neither migration was applied to a hosted,
production or shared database by this package.

### Current snapshot classification

Every parsed SB ad is assigned to exactly one state:

- `mapped`: one ad ID, one Asset Library video reference, one matching video asset row and a present
  `creativeVersion`;
- `legacy`: missing `adId` or a legacy media reference;
- `unsupported`: no video creative/reference or a reference to a non-video asset;
- `ambiguous`: duplicate ad identity or more than one candidate video asset;
- `unmapped`: a single Asset Library reference with no matching asset row, or no provider creative
  version.

Rows without `adId` remain count-only. No placeholder ID is generated. Non-mapped rows with a real
ad ID may be stored as explicit current mapping evidence with no Asset ID; they are never aggregated
into a mapped asset.

### Worker lifecycle

- `creative.sync` reads exactly one SB ads page and one Creative Asset Library page through the
  read-only WP-83 client seam, classifies all rows, and atomically persists the snapshot, video assets
  and current mappings.
- Mapping-only is the default. It writes no report request.
- `allowObservedAttributionFacts: true` is an explicit gate and is accepted only when
  `startDate === endDate` and that date equals `observedAt` in the profile timezone. Earlier and
  later dates are rejected before any Amazon read. The gate enqueues an `sbAds` `report.request`
  tied to the snapshot.
- Only one report-pending creative snapshot may exist per profile. Profile-scoped transaction
  serialization rejects any different mapping observation while that report is pending, so a later
  current-key upsert cannot move the evidence before promotion. A terminal failed, cancelled or
  expired report marks its snapshot blocked and releases that guard.
- The existing request → poll → fetch jobs create, wait for and download the report. WP-85 does not
  add a poller or a schedule.
- Fetch promotion uses only mappings still attached to the exact snapshot. A fact is written only
  for an exact campaign/ad-group/ad match in `mapped` state with complete stored metrics. The fact
  carries `current_sb_ad_snapshot` and `unproven_current_snapshot` lineage, `creativeId = null`, the
  exact creative version, the Asset ID and `placement = null`.
- Report rows that are legacy, unsupported, ambiguous, unmapped, unmatched or missing complete
  metrics remain counted as unpromoted. They are not spread or silently aggregated.
- The report ledger keeps `rows_parsed` as the actual parsed count. Expected unpromoted rows do not
  masquerade as loaded rows: source equals parsed plus refused, parsed equals promoted plus
  unpromoted, and promoted equals canonical `rows_loaded`. Sync Status labels this as complete
  attribution accounting instead of a silent-load-loss mismatch.
- Any parser refusal, repeated ad/date report grain, out-of-scope report date, incomplete pagination,
  source/parsed count mismatch or duplicate Asset Library identity fails closed before canonical fact
  promotion. The count-only snapshot records the blocked state where its own contract is valid.
- Retries upsert the same snapshot, Asset IDs, mapping source keys and ad/date fact grain. A later
  observed mapping replaces that ad/date fact rather than retaining both Asset IDs. A fetch retry
  after successful promotion reuses the snapshot's already-reconciled durable counts and does not
  rewrite the fact.

### Read-only surface

The existing Creative Performance page labels mappings as current observations, states that
historical validity is not established, exposes mapping provenance in drilldown, and treats null
placement as not reported. It still contains no Amazon client, server action or mutation path.

## Count gates

Before success:

1. asset source rows equal parsed asset rows or canonical writes are blocked;
2. ad source rows equal parsed ad rows or canonical writes are blocked;
3. parsed ads equal the sum of all five coverage states;
4. every offered asset, mapping, fact and snapshot is returned by its upsert;
5. every offered object is read back at its exact tenant-scoped identity;
6. report source rows equal parsed plus refused rows;
7. report parsed rows equal promoted facts plus explicitly unpromoted rows;
8. promoted facts equal canonical rows loaded, facts upserted and facts read back.

## Safety and live gate

- No Amazon advertising write method is called or exposed by the ingestion adapter.
- No `sbAds` schedule or historical-bootstrap handler is enabled.
- Multi-day, earlier-day and later-day observed-fact requests are rejected before an Amazon read;
  only the profile-local observation date can pass the gate.
- Overlapping current observations are blocked while an explicitly gated report is in flight.
- This package does not claim historical Asset-ID attribution is authoritative.
- Historical backfill remains blocked until an operator authorizes a live, read-only probe that proves
  a time-valid provider mapping. If that proof does not exist, future work must retain the current
  observed label rather than infer history.

## Synthetic acceptance coverage

- one video asset maps with `creativeId = null` and `creativeVersion` preserved;
- multiple candidate assets are ambiguous;
- a missing `adId` is legacy and receives no fake ID;
- a missing Asset Library row is unmapped;
- a non-video asset is unsupported;
- null content hashes preserve separate Asset IDs;
- retries remain idempotent;
- earlier and later fact dates fail before any Amazon read, while timezone-local observation dates
  are resolved from the profile timezone;
- a current mapping change leaves one canonical fact;
- incomplete pagination writes no canonical asset, mapping or fact;
- report refusals and duplicate ad/date grains promote zero facts;
- all facts retain null placement and observed provenance;
- partial attribution retains truthful source/parsed/refused/promoted/unpromoted/canonical ledger
  counts and a distinct complete-accounting Sync Status label;
- Amazon write-call count remains zero.
