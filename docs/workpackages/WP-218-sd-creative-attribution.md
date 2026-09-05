# WP-218 — Sponsored Display creative attribution

Owner: implementer, after WP-210 phase 2 and WP-213. Contract widening in `packages/shared`
is pre-approved by the manager as an additive change described below.

## Objective

Extend Creative Performance from Sponsored Brands Video to Sponsored Display, so the Creative
page shows Sponsored Display creatives with their assets and performance the same way it shows
Sponsored Brands Video ads. The operator asked for this on 2026-09-05.

## What exists

The creative contract already types `adProduct` generically for mappings and facts
(`packages/shared/src/creative.ts`), and the Creative page already labels `SD` as Sponsored
Display. Everything else is Sponsored Brands only: the `creative.sync` job is
`adProduct: z.literal('SB')` in `packages/shared/src/jobs.ts`, the worker ingestion in
`apps/worker/src/sb-video-ingestion.ts` reads SB ads and the Asset Library, and the report spec
is `sbAds`. `packages/ads-api/src/endpoints.ts` has Sponsored Display list endpoints for
campaigns and ad groups only.

## Phase 1: capability probe, read-only, before any build

1. From the pinned Advertising API documentation, record in `docs/ADS-API-CAPABILITIES.md`:
   the Sponsored Display creatives list endpoint and its response shape, whether creatives carry
   Asset Library asset ids and versions, and whether Reporting v3 offers a Sponsored Display
   report at ad or creative grain. If no ad-level report exists, the feature can show creative
   inventory and mapping but not per-creative performance; say so explicitly.
2. With one authorized read-only probe on one profile, confirm the documented shapes with
   count-only output, following the pattern of `apps/worker/src/sb-video-probe.ts`.
3. Stop and report the findings; the build phase is scoped from them.

## Phase 2: build, scoped by the probe

1. `packages/shared`: widen `CreativeSyncJob.adProduct` to `z.enum(['SB', 'SD'])` and add any
   SD-specific creative fields as optional. Additive only; existing SB behavior unchanged.
2. `packages/ads-api`: paginated, count-reconciled SD creatives reader; SD report spec if the
   probe found one.
3. `apps/worker`: SD branch of the ingestion with the same snapshot, mapping, ambiguity and
   same-day fact gates; producer enqueues `SB` and `SD` jobs per profile per day.
4. Inspect snapshot uniqueness, pending deferral and daily dedupe for product scoping before
   assuming no schema change. SB pending work must not block or overwrite SD work. Declare
   any required additive migration after the probe. The implementer owns DB/worker contracts;
   Claude Fable 5.1 owns Creative-page filter/lifecycle design against those contracts.
5. Tests: fixture-driven count identities for the SD reader and ingestion; Playwright for the
   product filter.

## Acceptance

1. Phase 1 findings recorded and one read-only probe reconciled.
2. For one profile with Sponsored Display creatives, the Creative page shows SD creatives with
   assets and, if the report exists, performance rows joined by asset id, with every count
   identity from WP-210 holding for the SD branch.
