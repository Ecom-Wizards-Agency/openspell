# WP-83 — Sponsored Brands Video contract probe

## Goal

Prove the current Amazon ad, creative, Asset ID and ad-report shapes without persisting client
data or inventing a creative identity Amazon does not return.

## Verified provider contract

- Amazon's current Sponsored Brands v4 OpenAPI defines `POST /sb/v4/ads/list` with
  `ads[].adId`, a nested `creative`, `creative.videoAssetIds` and `creative.creativeVersion`.
- Legacy and non-multi-ad-group ads may omit `adId`, and responses can contain legacy media IDs
  instead of Creative Asset Library IDs.
- The response does not define a separate `creativeId`; Wizard Ads must not manufacture one.
- Reporting v3 defines `sbAds`, `groupBy: ["ads"]`, daily ad-grain dimensions and the four video
  quartile/completion columns represented by the shared creative fact contract.
- The `sbAds` surface is preview and excludes legacy non-multi-ad-group campaigns, so unsupported
  coverage remains explicit.

Primary sources:

- [Sponsored Brands v4 OpenAPI](https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-brands/4-0/openapi.json)
- [Reporting v3 ad report](https://d3a0d0y2hgofx6.cloudfront.net/en-us/guides/reporting/v3/report-types/ad.md)
- [Reporting v3 columns](https://d3a0d0y2hgofx6.cloudfront.net/en-us/guides/reporting/v3/columns.md)
- [Official Amazon Ads Postman collection](https://github.com/amzn/ads-advanced-tools-docs/blob/main/postman/Amazon_Ads_API.postman_collection.json)

## Boundary

- Adds pure, page-scoped readers for Sponsored Brands ads and Creative Asset Library rows.
- Adds the documented `sbAds` request specification and a strict, non-persisting report parser.
- Adds sanitized count-only reconciliation for exact `adId` joins.
- Does not register a `creative.sync` production handler, write a database row, create a report,
  expose source identifiers, or call an Amazon advertising mutation endpoint.
- Existing creative persistence remains gated because its mapped state requires `creativeId`,
  which the authoritative ad response does not supply.

## Acceptance

- [x] Optional legacy `adId` and creative payloads remain visible instead of failing the page.
- [x] Asset Library and legacy media references are classified separately.
- [x] Versioned asset references join on the stable Amazon Asset ID while preserving the original
  reference and version.
- [x] Null content hashes never participate in identity.
- [x] `sbAds` uses the documented ad grain and video columns.
- [x] Explicit zero metrics remain zero; absent metrics remain unavailable.
- [x] Every report source row is parsed or counted as refused.
- [x] Report/list reconciliation uses exact `adId`, detects duplicate ad-date grains and returns
  counts only.
- [x] Probe results assert zero persisted rows and zero Amazon write calls.

## Live gate

The next live action is a read-only, non-persisting probe on an authorized profile, including an
existing completed `sbAds` report or an operator-approved analytical report request. Promotion
requires a separate additive model decision for `adId + creativeVersion`; it must not reuse
`adId` as a fictional `creativeId`.
