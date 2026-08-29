# WP-72 — Dayparting v0.5 operator surface

## Outcome

Expose the existing Marketing Stream hourly-fact and schedule-proposal foundations as a compact,
read-only operator workspace. The surface never schedules, applies, or writes an Amazon bid or
budget. Its only outbound artifact is CSV or JSON.

## Owned files

- `apps/web/app/dayparting/**`
- `apps/web/app/api/dayparting/export/**`
- `apps/web/src/dayparting/**`

No shared contract, database schema, worker, provider integration, global navigation, or global
theme file changes in this package.

## Behavior

- Aggregates profile-local day of week × hour across SP, SB, and SD hourly facts.
- Supports ROAS, conversion rate, ACOS, CTR, CPC, spend, sales, and orders.
- Defaults to settled evidence and requires an explicit operator choice to include settling or
  recently revised hours.
- Marks budget-capped cells and unsettled evidence without hiding the underlying metrics.
- Displays exact raw-ledger, settled, settling, revised, and capped coverage counts.
- Filters by campaign and date window while keeping the account timezone visible.
- Lists persisted confidence-shrunk, adjacent-merged schedule proposals.
- Exports an exact persisted proposal as CSV or JSON after tenant/profile authorization.
- Labels automatic execution as off and Amazon as unchanged.
- States plainly when SQS-delivered Marketing Stream evidence or tenant modelling inputs are absent.

## Verification

- Pure view tests cover row-preserving aggregation, settlement states, budget caps, source counts,
  and metric formatting with synthetic data.
- The export contract test proves only CSV/JSON output is accepted and declares `export-only`.
- Web typecheck and unit tests pass.
- Repository lint and hygiene pass before handoff.
- No migration, seed, Amazon API call, production data change, or competitor mutation occurs.

## Remaining operational gate

The backend normalization and persistence logic exists, but the always-on worker still needs an
authorized AWS SQS subscription, queue/DLQ configuration, provider payload validation, and a
settling-hour reprocessing schedule. This surface will remain honestly empty until those messages
arrive; it does not substitute an unvalidated unified-report bootstrap.
