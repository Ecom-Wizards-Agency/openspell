# WP-114 — Date-range interaction gate

## Outcome

The authenticated browser suite proves that Dashboard and Data Grid expose one working
date-range disclosure with every supported preset. This covers the live regression where
Data Grid rendered without the control even though the source contained it.

## Acceptance

- The date trigger is visible and opens on click.
- Exactly seven presets are visible: 7, 14, 30, 60, and 90 days, month to date, and
  previous month.
- The disclosure closes again through the same keyboard-operable trigger.
- Dashboard and Data Grid run the assertion during their existing route visits, without
  adding another expensive full-route traversal to CI.
