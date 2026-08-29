# WP-70 — Creative Performance v1 web surface

## Outcome

`/creative` is a read-only Sponsored Brands Video workspace backed by the
authoritative Creative Performance query from `@wizard-ads/db`.

Amazon Asset ID remains the creative identity. The route does not infer an
asset from an ad-group total and keeps legacy, unsupported, ambiguous, and
unmapped performance separate from mapped assets.

## Operator workflow

- Select a profile and date range.
- Search by creative name or Amazon Asset ID.
- Filter by campaign type and attribution state.
- Sort by spend, sales, impressions, CTR, video completes, creative, or
  campaign type.
- Review thumbnail/name, Amazon Asset ID, campaign coverage, placements,
  traffic, all four video milestones, commerce, ACOS, and ROAS.
- Expand an asset into its exact campaign, ad group, ad, creative, and
  placement rows.

Four compact summary signals lead the screen. Attribution explanations sit in
a disclosure instead of competing with the performance table. Loading, source
empty, filter empty, and error states each say what is known and preserve the
read-only boundary.

## Boundaries

- No Amazon client is imported by the web route.
- No API mutation, server action, export, or apply behavior exists on this
  surface.
- No shared contracts, database queries, migrations, worker code, navigation,
  or global theme files changed.
- All fixtures are synthetic.
- No database migration or production/shared data operation was run.

## Verification

- Web typecheck: passed.
- Web Vitest: 50 files passed, 13 skipped; 208 tests passed, 88 skipped.
- Repository lint: passed.
- Public-repository hygiene: passed; the optional local client-name denylist
  was absent, so that one operator-local check was skipped as designed.
- Focused tests assert deterministic filtering/sorting and exact row counts,
  every required Creative Performance metric, explicit legacy presentation,
  and absence of an Amazon client or mutation path.

## Files

- `apps/web/app/creative/page.tsx`
- `apps/web/app/creative/creative-performance.tsx`
- `apps/web/app/creative/creative.module.css`
- `apps/web/app/creative/loading.tsx`
- `apps/web/app/creative/error.tsx`
- `apps/web/app/creative/creative-performance.test.tsx`
- `apps/web/app/creative/read-only.test.ts`
- `apps/web/src/creative/performance.ts`
- `apps/web/src/creative/performance.test.ts`
