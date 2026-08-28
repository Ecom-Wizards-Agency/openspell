# WP-58 — Creative Performance v1 backend foundation

## Boundary

This package adds the read-only Sponsored Brands Video ingestion and query
foundation. It owns a strict worker handoff, counted database persistence, and
Asset-ID aggregation with ad-level drilldown. It does not add an Amazon write,
change a shared contract or schema, apply a hosted migration, or add a web
surface.

## Delivered behavior

- Amazon Asset ID is authoritative within one profile. Content hash is optional
  metadata and is never a key or join.
- Every mapped fact must have exactly one explicit current ad -> creative ->
  asset mapping. Facts without that chain are refused before persistence.
- Performance is accepted only at ad/date/placement grain. If a source tries to
  spread one ad result across multiple creatives, every candidate is refused;
  the source must instead retain one explicit `ambiguous` row.
- `legacy`, `unsupported`, `ambiguous`, and `unmapped` facts remain separate
  attribution buckets with no Asset ID. They are not folded into a mapped
  asset's totals.
- One asset aggregates across campaigns, ad groups, ads and placements while
  preserving campaign/ad-group/ad/creative/placement drilldown.
- The read model returns impressions, clicks, CTR, quartiles/completes, spend,
  sales, orders, ACOS and ROAS, plus distinct campaign/ad-group/ad/placement
  counts.
- Asset, mapping and fact writes are transactional and counted. Every offered
  row must be returned by its upsert and found again by exact identity before
  commit.
- Retries are idempotent. A stable mapping key updates the observed mapping,
  and an authoritative fact revision replaces the prior creative attribution
  for that ad/date/placement so the old and new Asset IDs cannot both remain in
  canonical performance.

`CreativeIngestionCounts` has the following concrete meaning in this seam:

- `sourceAssets`: asset source objects offered, including refused objects;
- `parsedRows`: accepted ad-level daily facts;
- `mappedPlacements`: accepted explicit mappings in `mapped` state;
- `unsupportedRows`: accepted facts in any non-mapped attribution state;
- `refusedRows`: rejected asset, mapping, or fact source objects;
- `upserts`: accepted assets + mappings + facts confirmed by database readback.

## External fetch gate

The current repository does not yet have a live-verified Amazon response that
contains the complete ad -> creative -> Amazon Asset-ID relationship alongside
ad-level Sponsored Brands performance. Its Reporting v3 Sponsored Brands
configuration is campaign grain and is explicitly documented as not
live-verified. The existing SB v4 creative list exposes creative and asset
references but does not establish an ad-level performance join by itself.

For that reason this package does not invent an Ads API report type, grouping,
or column list. Wiring the Amazon fetch requires a separately verified adapter
that proves all of the following before calling the new worker seam:

1. the performance row is ad level and carries a stable Amazon ad ID;
2. the ad is explicitly joined to a creative ID and Amazon Asset ID;
3. all report and mapping source rows reconcile with parsed and refused counts;
4. multiple candidate creatives/assets become `ambiguous`, never a guessed
   attribution;
5. retry, throttle and report-reuse behavior is tested against recorded
   synthetic fixtures and then confirmed with a read-only live smoke test.

Campaign- or ad-group-grain reports must never be sent through this seam.

## Verification

The synthetic worker suite covers:

- two assets in one ad group remaining separate by ad;
- multiple candidate assets being refused rather than arbitrarily selected;
- explicit ambiguous rows retained without an Asset ID;
- duplicate ad performance across creatives being refused;
- source/refusal/upsert count reconciliation;
- stable mapping identity across an observed asset revision.

The disposable PostgreSQL suite covers:

- transactional upserts and exact readback counts;
- null content hashes preserving distinct Amazon Asset IDs;
- aggregation across campaigns and placements with drilldown;
- non-mapped attribution states remaining separate;
- exact retry idempotency and metric replacement;
- mapping and fact attribution revisions without duplicate canonical facts;
- missing same-profile assets rolling back the transaction;
- explicit organisation and profile scoping on reads.

No test calls Amazon, uses real account data, or invokes an advertising write.
