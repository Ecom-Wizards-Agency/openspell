# WP-173 — Unified Reporting client boundary

## Status

Client boundary implemented and locally verified. No worker, database, schedule, download, or production behavior changes in this package.

## Problem

OpenSpell's production report lane uses Reporting v3, while Amazon's Unified Reporting API is the successor surface and exposes cross-product report queries. The first package must model the new transport without pretending it is interchangeable with Reporting v3: the request scope, batch accounting, status response, and eventual report parts are different. This work is read-only. It creates and retrieves analytical reports; it never mutates advertising entities.

Official protocol evidence comes from Amazon's public [Unified API Postman collection](https://github.com/amzn/ads-advanced-tools-docs/blob/main/postman/Amazon_Ads_Unified_API.postman_collection.json). The collection currently proves the create and retrieve request/response envelope, but its completed-report example leaves `completedReportParts` null. Download-part decoding therefore remains gated on a documented or bounded read-only contract probe instead of being guessed.

## Phase A grounding

### Existing Reporting v3 call path

1. `apps/worker` schedules a typed `report.request` job for one of seven `WorkerReportType` values.
2. `DbAdsApiClient.createReport` resolves one profile's regional `AdsApiClient` and calls `createReport`.
3. `AdsApiClient.createReport` sends one profile-scoped request to `POST /reporting/reports` and returns one report id.
4. The worker persists the id, polls `GET /reporting/reports/{id}`, and enqueues `report.fetch` only when Amazon supplies a download URL.
5. The fetch path decompresses one JSON array, parses a known report schema, reconciles source/parsed/refused/promoted/canonical counts, and promotes it with source `amazon_reporting_v3`.

Ownership is deliberate: `packages/ads-api` owns authentication, regional HTTP, retry, protocol validation, and transport-domain adaptation. `apps/worker` owns waiting, scheduling, profile/database joins, parsing into facts, count reconciliation, and promotion. `apps/web` cannot import the Ads API client.

### Unified Reporting protocol differences

- Create is `POST /adsApi/v1/create/reports`; retrieve is `POST /adsApi/v1/retrieve/reports`.
- Requests use the regional Ads API host and client/access-token headers but identify advertiser accounts in `accessRequestedAccounts`, not the profile-scope header.
- Create accepts a batch of `reports`. Retrieve accepts a batch of `reportIds`.
- Responses account for submitted entries by index across `success` and `error` buckets.
- A query is field-driven rather than selected from Reporting v3's report-type/grouping/column table.
- The official create example supports `CSV`; other examples also name `GZIP_JSON`.
- The official example proves pending metadata but does not prove the non-null shape of `completedReportParts`.

### Constraints the design must encode

- Keep the current Reporting v3 interface unchanged during dual run.
- Do not add duplicate shapes to `apps/worker` or `apps/web`; protocol-domain types belong in `packages/ads-api` unless a later worker job requires an approved shared contract.
- Batch results must account for every submitted request exactly once. Missing, duplicate, negative, or out-of-range response indices are parse failures.
- A create request is not blindly retryable; a transport failure is ambiguous. Retrieve is an idempotent read despite being a `POST`.
- Advertiser ids, fields, periods, and filters are caller inputs; access tokens and profile rosters never enter logs or fixtures.
- The first client must not invent completed-part download fields or hourly period shapes that the accessible primary contract does not prove.
- Worker integration, capability probing against a real advertiser, download parsing, history promotion, and hosted activation are separate later packages.

## Acceptance boundary

This package is complete only when it has a synthesized interface, synthetic protocol fixtures, exact input/output accounting, retry classification tests, and the repository-wide quality gate. It does not prove account eligibility, live Unified Reporting availability, report completion, hourly availability, or parity with Reporting v3.

## Synthesized design

The selected design keeps one `AdsApiClient` so Reporting v3 and Unified Reporting share authentication, regional routing, throttling, and retry state. It adds two provider-native methods rather than a false common report abstraction:

```ts
const created = await client.createUnifiedReports({
  advertiserAccountIds,
  reports,
});

const statuses = await client.retrieveUnifiedReports(reportIds);
```

Each method returns one ordered outcome for every submitted item. The prepared operation snapshots the input and binds it to the response decoder. A response fails closed when either bucket is missing, an index is invalid or repeated, an input is unaccounted for, retrieve metadata names the wrong report, or completed parts use an unproven shape.

Create is non-idempotent. Transport failures, server responses, and malformed success responses become a sanitized ambiguous-create error and are never replayed blindly. Retrieve is an idempotent analytical read even though its transport method is POST, so bounded read retries remain available. Provider response bodies and raw item messages are not retained by this boundary because they may echo account or query input.

Reporting v3 remains unchanged and authoritative. A later worker package may dual-run both capabilities and persist their outcomes independently; it must not collapse a successful v3 request and an ambiguous Unified request into one status.

## Module ownership

- `packages/ads-api/src/unified-reporting.ts` owns provider request encoding, defensive snapshots, response adaptation, and exact indexed accounting.
- `packages/ads-api/src/client.ts` owns the two HTTP operations and retry classification.
- `packages/ads-api/src/unified-reporting.test.ts` and its synthetic fixture cover request shape, count corruption, ambiguous creation, safe error handling, and idempotent retrieval.
- The package root exports caller-facing domain types and the ambiguous-create error. Wire codecs remain internal.

The package intentionally does not change shared contracts, worker jobs, database tables, web routes, report downloads, or promotion logic.

## Tradeoffs and redesign triggers

- Provider-native calls are more explicit than a generic report interface, but avoid hiding materially different scope and lifecycle semantics.
- One ordered outcome array is marginally less convenient than separate success/error arrays, but makes exact accounting structural.
- Non-null completed parts are rejected until primary evidence proves their schema. This delays downloads but avoids inventing a contract.
- Client-side batch splitting is excluded because no authoritative limit or safe global-index/retry contract has been established.

Re-ground and redesign if primary evidence introduces an idempotency key for create, completed parts have their own indexed partial failures, or callers require raw wire records. Do not add escape hatches to the public interface.

## Verification evidence

- package typecheck passed;
- all Ads API tests passed: 16 files, 260 tests;
- focused ESLint passed for every changed source and test file;
- repository-wide typecheck, lint, tests, hygiene, and migration checks remain the final pre-merge gate.
