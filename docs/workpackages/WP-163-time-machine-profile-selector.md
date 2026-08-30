# WP-163 — Compact Time Machine account selector

## Trigger

Time Machine rendered every accessible advertising profile as visible link
navigation before the history. Large rosters increased the initial document and
made the active account hard to identify.

## Outcome

- Replace the link roster with one labeled Active account select and an explicit
  Switch button.
- Show the server-selected account and marketplace in the closed control.
- Reset profile-specific filters, pagination cursors, and batch selection when
  switching accounts, matching the previous profile-link behavior.
- Keep timeline, export-batch, and reversion behavior unchanged.

## Authorization boundary

The selector receives only the roster returned by the existing organization-scoped
profile query. The server still resolves the requested profile against that roster,
then sends both organization ID and selected profile ID to every Time Machine query.
The control adds no database access, client-side data fetch, Amazon call, or write.

## Acceptance evidence

- Synthetic component tests reconcile offered profiles to select options, retain
  the exact active value, and prove the roster is not link navigation.
- The authenticated production-build Time Machine suite covers the selector,
  bounded history, pagination, filters, reversion export, and cross-tenant
  isolation.
- Repository typecheck, lint, tests, hygiene, and skill lint pass.

## Live changes

None. This package changes repository source and synthetic tests only. It does not
deploy the web application, migrate data, call Amazon, or modify a live account.
