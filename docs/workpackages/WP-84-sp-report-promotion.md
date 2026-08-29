# WP-84 — Sponsored Products report-date promotion

## Goal

Replace the upsert-only Sponsored Products Reporting v3 load with a complete-date,
transaction-safe promotion path. A report may replace canonical facts only after every source row
and every date in its requested window are accounted for.

## Boundary

- Covers `spCampaigns`, `spTargeting`, `spSearchTerm` and `spPlacement` only.
- Keeps Sponsored Brands and Sponsored Display on their previous loader.
- Uses the existing report-request ledger, promotion watermarks, attribution observations,
  partition functions and canonical fact tables. It adds no contract or migration.
- Recovers an expired report download URL by returning to Reporting v3 polling while the original
  report request is still within its bounded provider horizon.
- Calls analytical report endpoints only. It exposes and invokes no Amazon advertising mutation.

## Behavior

- All four SP parsers return exact input, parsed and refused accounting.
- Any refused SP row fails the report ledger before canonical deletion.
- Raw source dates must be valid daily dates inside the report-request window.
- The worker stages the entire window before promotion, including complete dates with zero rows.
- Historical monthly partitions are prepared and counted before the first date is promoted.
- Each date is locked and replaced in one database transaction. Inserts are chunked below the
  PostgreSQL bind-parameter limit and counted after promotion.
- A Reporting v3 promotion must match an Amazon API report-request ledger by tenant, profile,
  report type, date window and request timestamp.
- A late overlapping request older than the current watermark is recorded as superseded and makes
  no canonical or observation mutation. An idempotent retry also makes no mutation.
- Every accepted result reconciles staged, inserted, observation and canonical row counts before
  the report ledger is completed.
- Expired download URLs enqueue a fresh scoped poll with a new dedupe generation. Once the original
  request horizon has elapsed, the report is failed and the job is dead-lettered.

## Safety proof

The critical invariant is: no partial, malformed, foreign-ledger or superseded SP report reaches
canonical deletion. Synthetic tests exercise this through the real parsers and worker. The real
database suite additionally proves transaction rollback/retention, newer-overlap precedence,
idempotency, a 3,000-row chunked promotion and scoped-ledger rejection against a disposable,
fully migrated Postgres database.

## Acceptance

- [x] SP reports use complete-date transactional promotion; SB and SD are unchanged.
- [x] Every input row is parsed or refused, and one refusal blocks replacement.
- [x] Duplicate canonical grain is rejected before deletion.
- [x] Empty complete dates are promoted and can clear stale canonical activity.
- [x] Historical partition preparation covers every requested month and exact fact table.
- [x] Late overlapping reports are superseded without compounding or retry failure.
- [x] Large date batches are inserted in bounded chunks with exact canonical counts.
- [x] Report ledgers are tenant/profile scoped and validated again inside the transaction.
- [x] Expired fetch recovery is bounded, retryable inside the horizon and terminal outside it.
- [x] Tests use synthetic data and a disposable local database only.
- [x] No Amazon advertising write API is present or invoked.

## Deployment gate

This package changes the worker loader but requires no schema application. Production verification
still needs one read-only SP report per supported grain, with source, promoted, superseded and
canonical counts reviewed in sanitized worker logs and the report ledger. No live verification is
part of this work package.
