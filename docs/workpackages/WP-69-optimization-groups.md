# WP-69 — persistent optimization groups

## Outcome

Replace campaign-shaped review stand-ins with tenant-scoped optimization groups that own strategy
settings, cadence, and an exact campaign assignment set. A group preview evaluates only assigned
campaigns and remains an internal Wizard Ads job: it does not call an Amazon write API.

## Owned files

- `packages/shared/src/recommendations.ts`
- `packages/shared/src/strategy.ts`
- `packages/db/src/queries/optimization-groups.ts`
- `apps/worker/src/recommendations-run.ts`
- `apps/web/app/optimizer/groups/**`
- focused tests and the navigation/theme additions needed by that surface

The additive optimization tables and run-context columns already exist in the operator-intelligence
foundation migration. This package adds no migration and does not apply or seed a database.

## Behavior

- One campaign has at most one optimization-group assignment.
- Saving a group replaces its full settings and assignment set in one transaction.
- Selecting a campaign owned by another group moves it atomically and records a counted audit row.
- Each scheduled or manual group run stores an immutable group snapshot and due time.
- A group run loads target and campaign facts only for its assigned campaigns.
- Due runs are enqueued one group at a time. Profiles with no persisted groups retain the legacy
  profile-level preview during migration.
- Group role selects the existing strategy objective; group bounds and caps constrain proposals.
- Mechanical-value avoidance is activated only by tenant strategy data. A legal directional
  one-cent change and its provenance are persisted; hard bounds still win.
- The web surface is guided and compact, with campaign search and explicit assignment movement.
- Save and preview controls state that Amazon remains unchanged.

## Verification

- Web, worker, database, and shared-package typechecks passed.
- Web tests: 206 passed; environment-gated suites skipped as designed.
- Worker tests: 140 passed without a database; 34 focused tests passed against disposable
  PostgreSQL, including group scheduling and immutable context.
- Database tests: 32 passed without a database; the three optimization-group transaction and
  tenant-isolation tests passed against disposable PostgreSQL.
- Shared tests: 34 passed.
- Repository lint and hygiene passed.
- No production/shared migration, seed, Amazon write, or live account mutation was executed.

## Remaining release gates

- Exercise group creation, campaign movement, and group preview in an authenticated deployed build.
- Observe a queued group run complete on synchronized facts and inspect its exact proposal count.
- Connect recommendation observation and reversion evidence before any repeated proposal can be
  considered stateful optimization rather than a fresh preview.
