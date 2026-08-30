# WP-138 — Chart preference migration

## Outcome

Existing browser profiles receive the current semantic chart presentation once:
Spend remains a left-axis bar and Ad Sales advances from the former left-axis bar
default to a right-axis line. Fresh profiles already receive those defaults.

The migration keeps each account's selected metrics, aggregation, and presentations
that differ from the old defaults. After migration, later operator changes persist
unchanged across Dashboard and Campaign Optimizer.

## Ownership

- `apps/web/src/ui/cockpit.tsx`
- `apps/web/src/ui/cockpit.test.ts`
- `apps/web/e2e/dashboard.spec.ts`

## Acceptance checks

- A valid v1 record is migrated to v2 without losing selected metrics or aggregation.
- Former defaults advance to the current semantic presets.
- A v1 presentation that differed from its former default is preserved.
- Fresh defaults, reload persistence, and Dashboard-to-Optimizer persistence are
  exercised through the authenticated browser suite. The v1-to-v2 migration is
  exercised directly in the jsdom unit suite by seeding the legacy storage key.
- Typecheck, lint, tests, hygiene, production build, and diff checks pass.

No database, Amazon API, credential, or tenant-strategy change is part of this package.

The v1 format did not record whether a saved presentation was a default or an
explicit operator choice. A v1 value equal to the former default therefore advances
once even if an operator deliberately reselected that same value; it can be changed
again and the v2 preference then persists unchanged.
