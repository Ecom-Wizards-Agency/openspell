# OpenSpell Advertising API capability map

This map separates four different claims that are easy to blur together:

1. Amazon offers the control or data surface.
2. `packages/ads-api` has a typed client for it.
3. the worker and web application provide a guarded operator workflow.
4. the complete path has been verified against an authoritative live response.

A client method or passing fixture is not a live product capability. “Shipped” below means the
path is reachable from current `origin/main`; it does not imply that the current production
deployment serves that revision.

## Current implementation

| Capability | API client | Worker/data path | Operator surface | Verified status |
|---|---|---|---|---|
| Advertising profiles and regional discovery | Shipped | Shipped | Account connection and selection | Live-used; deployment revision must still be checked |
| Sponsored Products campaigns, ad groups, keywords, targets, negatives and product ads | Shipped, paginated | Shipped current-state mirror | Grid and campaign review | Live-used with counted page/upsert assertions |
| Sponsored Brands campaigns and ad groups | Shipped, v4 pagination | Shipped current-state mirror | Grid and campaign context | Live-used; deeper entity coverage remains incomplete |
| Display campaigns and ad groups | Shipped, offset pagination | Shipped current-state mirror | Grid and campaign context | Live-used; targeting and creative entities are not mirrored |
| SP campaign, targeting, search-term and placement reports | Shipped | Shipped; complete dates replace canonical snapshots under promotion watermarks | Dashboard, Grid, Optimizer and Time Machine evidence | Current core reporting path; live count crosschecks remain a release gate |
| SB and Display campaign reports | Shipped | Shipped through the legacy upsert loader | Dashboard and Grid rollups | Available, but not yet on the same complete-date replacement path as SP |
| SB ad-level video report | Shipped contract and parser | Shipped behind observed mapping gates | Creative Performance | Live authoritative Asset-ID and row-count parity remains open |
| SP suggested keyword and product-target bids | Shipped and batch-counted | Shipped into the bid-corridor series | Target context and optimizer inputs | Read-only evidence; a suggestion is never an instruction to write |
| SP campaign budget-usage reads | Shipped client | Not connected to the product worker | Not exposed | Client-only |
| SB creative media upload, describe, create, update and list | Shipped client | Not connected to a guarded worker workflow | Not exposed in Campaign Builder | Client-only; archive is deliberately unavailable |
| SB ad and Creative Asset Library reads | Narrow probe clients | Current-snapshot observed ingestion | Creative Performance source gate | Not a complete paginated asset catalog or picker |
| SP create/update/archive for campaign structure | Shipped client for campaigns, ad groups, keywords, targets, negatives and product ads | No merged creation executor | Campaign Builder exports a plan | Client-only for creation; no direct create workflow is live |
| SP keyword bid, target bid and campaign placement updates | Shipped client | Guarded runtime remains in open PR #24 | No merged approval/apply UI | Not live; no production migration or Amazon mutation has run |
| SB campaign/ad-group/target/ad creation | Missing as one complete client and compiler | Missing | Missing | Planned |
| SB Video creation from an existing Asset ID | Creative resource client exists, but the full campaign graph does not | Missing | Missing | Planned |
| Display campaign/ad-group/target/ad creation | Missing | Missing | Missing | Planned |
| Automatic scheduled mutation | Mutation policy permits an explicitly enabled, bounded cadence | No live executor | Weekday review scheduling remains preview-only | Not live |
| MCP mutation | MCP has no Amazon client and cannot approve itself | Analytical reads only | Setup exposes read tools | Correctly unavailable |

## What can be built without SP-API

The Amazon Advertising API is enough for the following OpenSpell program. SP-API approval is not
a prerequisite:

- create and manage SP, SB, SB Video and Display campaigns when their product-specific clients and
  dependency-ordered worker plans are implemented;
- update supported bids, budgets, placements, targeting and states through approved worker batches;
- build an Asset-ID picker from a complete, paginated Advertising API asset catalog and use an
  eligible asset in a creative plan;
- ingest sponsored-ads entity mirrors, performance reports, budget usage, suggested bids and
  near-real-time Marketing Stream data;
- provide Time Machine observation and conflict-safe inverse writes for reversible scalar changes.

SP-API is still required for Brand Analytics Search Query Performance and other retail/brand data
that does not come from the Advertising API. OpenSpell must not approximate those sources from PPC
reports.

## Reporting gaps worth implementing

The existing report set is intentionally narrow. Before adding a report, OpenSpell must prove its
marketplace availability, supported columns and grain, retention window, row accounting, and join
cardinality. The next useful families are:

1. **Advertised and purchased product performance.** This improves ASIN-level budget allocation and
   prevents profile-only query joins from pretending to have product attribution.
2. **SB and Display targeting/search-term detail where the provider supports it.** Campaign totals
   alone are not enough for optimization or contextual negatives.
3. **Placement and audience detail for SB and Display.** Keep placement evidence at its valid grain;
   do not infer keyword-by-placement performance.
4. **Budget rules and budget-usage history.** This supports pacing and budget-capped-hour evidence.
5. **Unified hourly reporting.** Amazon documents a bounded hourly history. Treat it as an optional
   bootstrap and parity source, not a substitute for the forward Marketing Stream ledger.
6. **Creative/ad reporting beyond SB Video.** Add only where an authoritative ad-to-creative-to-Asset
   ID mapping exists; never assign an ad group's totals to one guessed asset.

## Safe implementation order

1. Finish and prove the one-row SP scalar mutation gateway, including inverse reservation,
   observation, conflict handling and an exact reversion.
2. Build a complete read-only asset catalog with eligibility, moderation state, pagination,
   freshness and preview URLs.
3. Add authoritative shared creation-plan contracts. A plan is an immutable dependency graph, not a
   loose JSON payload.
4. Add pure SP, SB/SB Video and Display compilers with exact node and refusal counts.
5. Implement a worker creation executor that stops on ambiguous provider outcomes and never blindly
   retries a create.
6. Add the guided web workflow: recipe, targeting, asset selection, naming preview, validation,
   immutable review, exact confirmation, execution and resynchronization.
7. Run separate one-resource live tests per ad product. Creation cannot be “rolled back” by deletion;
   a pause or archive is a separately reviewed follow-up action.

## Operator guardrails

- Web and MCP never receive Amazon credentials or import the Ads API client.
- Viewing, syncing, analyzing and generating recommendations never mutates Amazon.
- Every manual write uses an immutable preview, exact profile/entity/value/count, explicit approval,
  environment and profile allowlists, durable audit, idempotency, resynchronization and conflict
  reporting.
- Time Machine may automatically execute only an exact pre-approved inverse inside a bounded live
  test. Normal reversions are new guarded writes.
- Asset-ID is authoritative creative identity. Names and headlines are display metadata only.
- Unsupported formats and partial mappings remain visible instead of being silently combined.

## Source anchors

Repository evidence is in `packages/ads-api/src/client.ts`, `packages/ads-api/src/endpoints.ts`,
`packages/ads-api/src/reports.ts`, `packages/ads-api/src/writes.ts`,
`packages/ads-api/src/sb-media.ts`, `apps/worker/src/ads-api.ts`,
`apps/worker/src/sb-video-ingestion.ts`, and `packages/campaigns/src/`.

Amazon's public product documentation confirms the operator-level controls and formats, but the API
reference and a counted response remain authoritative for implementation:

- [Sponsored Products controls and reports](https://advertising.amazon.com/en-us/library/guides/sponsored-products-best-practices/)
- [Sponsored Brands formats](https://advertising.amazon.com/library/guides/sponsored-brands-what-to-know)
- [Sponsored Brands video](https://advertising.amazon.com/library/guides/getting-started-with-sponsored-brands-video)
- [Creative Asset Library](https://advertising.amazon.com/help/GHACCZ3SEF3E6ZHX)
- [Display ads and video](https://advertising.amazon.com/library/guides/display-ads-video-creative)
- [Reporting data availability](https://advertising.amazon.com/help/G8A5Z6UD9ME5W3GZ)
- [Amazon Marketing Stream](https://advertising.amazon.com/library/guides/amazon-marketing-stream)
