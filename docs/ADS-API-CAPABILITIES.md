# OpenSpell Advertising API capability map

This map separates claims that must not be collapsed into one “supported” label:

1. Amazon exposes the control or data surface in a named API dialect.
2. `packages/ads-api` has a typed client for that exact surface.
3. the worker and web application provide a guarded operator workflow.
4. the complete path has been verified against an authoritative live response.

A client method or passing fixture is not a live product capability. The repository evidence below
is revision-stamped to `f1b9efc1813247ab72a36dbeca56e1e96bf069d1`, the reviewed `origin/main`
base on 2026-08-30. “Implemented” means present at that revision; it does not imply that production
serves that revision or that Amazon accepted the request.

## API dialect boundary

OpenSpell currently reads and writes typed payloads for the legacy Sponsored Products v3 (`/sp/`)
and Sponsored Brands v4 (`/sb/v4/`) APIs. Amazon's current campaign-management migration target for
SP and SB is the Unified API (`/adsApi/v1/{create|query|update|delete}/...`). OpenSpell has no Unified
SP/SB client at the reviewed revision.

New SP and SB creation work must capability-probe the Unified API per profile and prefer it where
the profile and resource are supported. Legacy product APIs remain necessary for documented seams
that Unified does not replace, including reporting, budget usage and several recommendation APIs.
Sponsored Display remains on its product-specific API. One immutable plan uses one proven dialect
per resource; it never switches dialect after an ambiguous provider outcome.

## Credential boundary

Two server-side paths in `apps/web` handle Amazon credentials at the reviewed revision. The OAuth
callback loads the LWA client ID and client secret, receives the single-use authorization code,
exchanges it for access and refresh tokens, uses the access token to discover profiles, and stores
the refresh token through the Vault-backed database path. Separately, the authenticated Vercel cron
route imports the worker integration, constructs its Ads API client in the web server runtime, and
drains post-connect sync and suggested-bid work. That worker integration loads the LWA application
credentials from server environment variables and each connection's refresh token from Vault.

The Amazon HTTP client implementation remains in `apps/worker`, but the current Vercel deployment
invokes it from `apps/web/app/api/cron/sync`. None of these credentials reaches browser code. The
OAuth callback itself does not import or expose the campaign, reporting or mutation Ads API client.
MCP receives no Amazon credentials and cannot call Amazon directly.

## Current implementation

| Capability | Amazon platform surface | API client in reviewed main | Worker/data path | Operator surface | Live evidence |
|---|---|---|---|---|---|
| Advertising profiles and regional discovery | Profiles API | Implemented | Implemented | Account connection and selection | Live-used; deployed revision still requires proof |
| SP campaigns, ad groups, keywords, targets, negatives and product ads | Legacy SP v3 is used; Unified SP is available but absent from OpenSpell | Legacy client implemented and paginated | Current-state mirror implemented | Grid and campaign review | Legacy read path live-used with page/upsert counts |
| SB campaigns and ad groups | Legacy SB v4 is used; Unified SB is available but absent from OpenSpell | Legacy client implemented with v4 pagination | Current-state mirror implemented | Grid and campaign context | Legacy read path live-used; ads and targets remain incomplete |
| Display campaigns and ad groups | Product-specific SD API; Amazon also exposes product ads, targets and creatives | Campaign/ad-group client implemented with offset pagination | Current-state mirror implemented for those two resources | Grid and campaign context | Read path live-used; deeper entities are not mirrored |
| SP campaign, targeting, search-term and placement reports | Reporting v3 | Implemented | Complete dates replace canonical snapshots under promotion watermarks | Dashboard, Grid, Optimizer and Time Machine evidence | Current core path; live count crosschecks remain a release gate |
| SB and Display campaign reports | Reporting v3 | Implemented | Legacy upsert loader, not complete-date replacement | Dashboard and Grid rollups | Available with weaker restatement semantics than SP |
| SB ad-level video report | Reporting v3 | Contract and parser implemented | Observed ad-to-asset mapping gates implemented | Creative Performance | Authoritative live Asset-ID/version and row-count parity remains open |
| SP suggested keyword and product-target bids | Product-specific recommendation APIs | Implemented and batch-counted | Bid-corridor evidence implemented | Target context and optimizer inputs | Read-only evidence; a suggestion is never a write instruction |
| SP/SB/SD campaign budget usage | `/sp/campaigns/budget/usage`, `/sb/campaigns/budget/usage` and `/sd/campaigns/budget/usage` | Current client instead calls `/budgets/usage/campaigns`, contradicting the pinned Amazon collection | Not connected | Not exposed | **Not provider-verified; do not count as usable** |
| Asset Library search and lookup | `/assets`, `/assets/search` | Narrow, page-scoped `/assets/search` probe | Current-snapshot observed ingestion | Creative Performance source gate | Not a complete catalog, picker or moderation gate |
| Asset Library upload and registration | `/assets/upload`, pre-signed object upload, then `/assets/register`; registration returns `versionId` | Missing. Existing `/media/upload` is deprecated; `/media/describe` is legacy original-video retrieval. Neither implements Asset Library registration | Missing | Missing | Not usable |
| Legacy SB media and creative resources | Deprecated `/media/upload`, legacy `/media/describe` original-video retrieval, plus legacy SB v4 creative resources | Implemented client | No guarded worker workflow | Not exposed | Client presence is not current Asset Library support |
| SP structure creation and update | Unified SP is the migration target; legacy SP seams still exist | Legacy client implemented for campaigns, ad groups, keywords, targets, negatives and product ads | No merged creation executor | Campaign Builder exports a plan | Client-only; no direct creation workflow is live |
| SP keyword bid, target bid and campaign placement updates | Unified and product-specific SP surfaces, depending on the resource | Legacy client implemented | Guarded runtime remains in open PR #24 | No merged approval/apply UI | Not live; no production migration or Amazon mutation has run |
| SB campaign/ad-group/target/ad creation | Unified SB | No complete Unified client or compiler | Missing | Missing | Planned |
| SB Video creation from an Asset Library reference | Unified SB ad creative uses `assetId` plus `assetVersion` from the registered asset version | No complete current client graph | Missing | Missing | Planned |
| Display campaign/ad-group/target/ad creation | Product-specific SD API | Missing | Missing | Missing | Planned |
| Marketing Stream ingestion | Amazon subscriptions deliver SP/SB/SD datasets to AWS SQS or Firehose; SQS subscriptions require confirmation, Firehose subscriptions do not | No subscription/provisioning client | SQS ledger and normalizer accept an OpenSpell envelope; raw Amazon translation and SQS subscription confirmation are missing | Dayparting reads normalized facts | Provider-to-ledger path not live-verified |
| Automatic scheduled mutation | OpenSpell policy allows an explicitly enabled, bounded cadence | Not applicable | No live executor | Weekday review scheduling remains preview-only | Not live |
| MCP Amazon mutation | OpenSpell product boundary, not an Amazon API limitation | MCP has no Amazon client | No Amazon mutation path | Advertising-data tools are read-only; audit and key-usage bookkeeping remain internal | Correctly unavailable |

## What can be built without SP-API

SP-API approval is not a prerequisite for this Advertising API program:

- create and manage SP and SB/SB Video through capability-probed Unified endpoints, and Display
  through its product-specific endpoints, after their clients and dependency-ordered worker plans
  are implemented;
- update supported bids, budgets, placements, targeting and states through approved worker batches;
- build a version-aware Asset Library picker from complete, counted pagination and use only assets
  proven eligible for the intended ad program and marketplace;
- ingest sponsored-ads entity mirrors, performance reports, budget usage and suggested bids; and
- provide Time Machine observation and conflict-safe inverse writes for reversible scalar changes.

Marketing Stream also does not require SP-API, but it is not “Advertising API alone”: it requires
AWS SQS or Firehose infrastructure, dataset subscriptions and exact raw-provider-to-ledger
translators. The SQS destination additionally requires subscription confirmation; Firehose does
not.

SP-API is still required for Brand Analytics Search Query Performance and other retail/brand data
that does not come from the Advertising API. OpenSpell must not approximate those sources from PPC
reports.

## Reporting availability and gaps

Unified Reporting is generally available in Ads Console, while its Reporting API and Marketing
Stream access remain beta. Amazon currently documents up to two weeks of hourly history, 15 months
at daily or weekly grain, and six years at monthly, yearly or summary grain. Amazon has also
announced that the existing Sponsored Ads and DSP report experiences will sunset by 2026-12-31.
OpenSpell must capability-probe and dual-run the API before promoting it; the hourly history is an
optional bootstrap and parity source, not a substitute for a forward Marketing Stream ledger.

Before adding any report, OpenSpell must prove marketplace availability, supported columns, grain,
retention, row accounting and join cardinality. The next useful families are:

1. **Advertised and purchased product performance.** This improves ASIN-level budget allocation and
   prevents profile-only query joins from pretending to have product attribution.
2. **SB targeting/search-term and SD target/audience detail where documented.** Do not imply that
   every product supports the same keyword or search-term grain.
3. **Placement and audience detail for SB and Display.** Keep placement evidence at its valid grain;
   do not infer keyword-by-placement performance.
4. **Budget rules and product-specific budget usage.** Correct and prove each endpoint before using
   it as pacing or budget-capped-hour evidence.
5. **Unified hourly reporting.** Enforce the two-week limit and beta/capability state; retain the
   forward stream ledger as authoritative for durable hourly history.
6. **Creative/ad reporting beyond SB Video.** Add only where an authoritative
   ad-to-creative-to-Asset-ID-and-version mapping exists; never assign an ad group's totals to one
   guessed asset.

## Asset, eligibility, moderation and delivery gates

An asset's generic `ACTIVE` status is not proof that it can be used in a specific campaign or that
an ad will serve. The builder must preserve these distinct provider states:

- product advertising eligibility from `/eligibility/product/list`;
- available brands, Stores and Store-page products from `/brands`, `/v2/stores` and `/pageAsins`;
- Asset Library spec and policy state, including failed spec checks, approved programs, moderation
  policy results and moderation-request state;
- SB creative `moderationStatus`; and
- ad delivery status and delivery reasons after creation.

Amazon Asset ID is the authoritative root creative identity for aggregation. The Asset Library
search/detail response identifies a stored version as `version`, while registration returns that
version as `versionId`; a Unified SB creative input supplies the corresponding value as
`assetVersion`. OpenSpell must map those fields explicitly and retain the exact version lineage.
Names and headlines are display metadata only. Missing, rejected, unsupported and pending states
remain visible and fail closed instead of being silently treated as eligible.

## Safe implementation order

1. Add capability probes and choose the exact Unified or product-specific dialect per profile and
   resource before compiling a plan.
2. Finish and prove the one-row SP scalar mutation gateway, including inverse reservation,
   observation, conflict handling and an exact reversion.
3. Replace the deprecated upload and legacy media-retrieval seams with the current Asset Library
   upload/register flow and build a complete read-only catalog with counted pagination, version,
   eligibility, moderation, freshness and preview URLs.
4. Add authoritative shared creation-plan contracts. A plan is an immutable dependency graph, not a
   loose JSON payload.
5. Add pure SP, SB/SB Video and Display compilers with exact node and refusal counts. Do not combine
   legacy and Unified payloads inside one plan.
6. Implement a worker creation executor with OpenSpell-side request deduplication. It stops on an
   ambiguous provider outcome and never blindly retries a create.
7. Add the guided web workflow: recipe, targeting, asset selection, naming preview, validation,
   immutable review, exact confirmation, execution and resynchronization.
8. Run separate one-resource live tests per ad product. Creation cannot be “rolled back” by deletion;
   a pause or archive is a separately reviewed follow-up action.

## Operator guardrails

- Browser code and MCP never receive Amazon credentials. Server-side `apps/web` has two documented
  credential paths: the OAuth callback exchanges the authorization code without importing the Ads
  API client, while the authenticated Vercel cron route invokes the worker Ads integration and
  therefore loads LWA and Vault-backed credentials for post-connect sync. Amazon client code remains
  owned by `apps/worker` even though this deployment runs it inside the web server process.
- Viewing, syncing, analyzing and generating recommendations never mutates Amazon.
- Every manual write uses an immutable preview, exact profile/entity/value/count, explicit approval,
  environment and profile allowlists, durable audit, resynchronization and conflict reporting.
- OpenSpell provides stable batch/row identities and job deduplication. No general idempotency key
  was found in the reviewed Amazon Unified specifications, so a provider-ambiguous create is
  reconciled rather than replayed.
- Indexed HTTP 207 responses are reconciled row by row. Requested, accepted, attempted, succeeded,
  failed, refused and resynchronized counts must agree before completion is claimed.
- Time Machine may automatically execute only an exact pre-approved inverse inside a bounded live
  test. Normal reversions are new guarded writes.
- Amazon Asset ID is the aggregation identity; exact mappings preserve Asset Library `version`,
  registration `versionId` and Unified creative input `assetVersion` without conflating their JSON
  field names.
- Unsupported formats and partial mappings remain visible instead of being silently combined.

## Primary source anchors

Repository evidence is in `packages/ads-api/src/client.ts`, `packages/ads-api/src/endpoints.ts`,
`packages/ads-api/src/reports.ts`, `packages/ads-api/src/writes.ts`,
`packages/ads-api/src/budgets.ts`, `packages/ads-api/src/sb-media.ts`,
`packages/ads-api/src/sb-ad-assets.ts`, `apps/worker/src/ads-api.ts`,
`apps/worker/src/report-promotion.ts`, `apps/worker/src/sb-video-ingestion.ts`,
`apps/worker/src/marketing-stream-sqs.ts`, `apps/web/app/api/amazon/oauth/_lib/lwa.ts`,
`apps/web/app/api/amazon/oauth/_lib/connect.ts`, `apps/web/app/api/cron/sync/route.ts`, and
`packages/campaigns/src/`.

Amazon implementation claims were checked on 2026-08-30 against these primary sources. API sources
are pinned to Amazon's `ads-advanced-tools-docs` revision
`5c1c432c3dbe676a571780aa0c4d0217659a5f3a`:

- [Unified API migration guide](https://github.com/amzn/ads-advanced-tools-docs/blob/5c1c432c3dbe676a571780aa0c4d0217659a5f3a/unified-campaign-management-migration-skills/skills/unified-api-migration-guide/SKILL.md)
- [Unified Sponsored Products OpenAPI](https://github.com/amzn/ads-advanced-tools-docs/blob/5c1c432c3dbe676a571780aa0c4d0217659a5f3a/unified-campaign-management-migration-skills/api-specs/unified-api-sp.json)
- [Unified Sponsored Brands OpenAPI](https://github.com/amzn/ads-advanced-tools-docs/blob/5c1c432c3dbe676a571780aa0c4d0217659a5f3a/unified-campaign-management-migration-skills/api-specs/unified-api-sb.json)
- [Sponsored Brands formats and migration guide](https://github.com/amzn/ads-advanced-tools-docs/blob/5c1c432c3dbe676a571780aa0c4d0217659a5f3a/unified-campaign-management-migration-skills/skills/amazon-ads-sb-collections/SKILL.md)
- [Amazon Ads API Postman collection](https://github.com/amzn/ads-advanced-tools-docs/blob/5c1c432c3dbe676a571780aa0c4d0217659a5f3a/postman/Amazon_Ads_API.postman_collection.json)
- [Media Library upload deprecation and original-video describe retrieval](https://github.com/amzn/ads-advanced-tools-docs/discussions/139)
- [Unified Reporting general availability and lifecycle](https://advertising.amazon.com/resources/whats-new/streamline-campaign-analysis-with-unified-reporting)
- [Unified Reporting hourly and historical windows](https://advertising.amazon.com/resources/whats-new/unboxed-2025-campaign-analysis-with-unified-reporting)
- [Marketing Stream SQS/Firehose architecture and datasets](https://github.com/amzn/amazon-marketing-stream-examples/blob/349918ef35aa0f60ef7e74641d17228a61f6df18/README.md)
- [Sponsored Brands and Display moderation](https://advertising.amazon.com/library/guides/sponsored-brands-display-ads-moderation)
