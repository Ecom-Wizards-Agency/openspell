# WP-57 — Report-date promotion and history planning foundations

## Boundary

This package owns focused typed queries in `packages/db`, pure ingestion and
history-planning helpers in `apps/worker`, and this brief. It reuses the WP-56
schema without changing or applying a migration. It does not call Amazon,
enable an Amazon write, alter the active report loader, seed data, or claim that
unified reporting is available for a profile.

## Delivered behavior

`stageReportDate` validates one complete reporting date before database work:

- tenant, profile, date and request provenance are identical on every fact;
- source rows equal parsed plus refused rows;
- one-to-one report grains produce exactly one fact per parsed row;
- the profile rollup may aggregate multiple parsed campaign rows into one fact;
- attribution metrics are derived from the promoted facts and must match the
  report's explicit attribution window.

`promoteReportDate` then performs one transaction:

1. acquire a profile/report/date advisory lock;
2. reject an older request watermark across authoritative reporting sources;
3. supersede the previous attribution observation and append the new revision;
4. remove the exact canonical fact-table scope for that profile/report/date;
5. insert the complete replacement, including a valid empty day;
6. read the canonical count back and reconcile it with promoted rows;
7. insert or update the WP-56 promotion watermark.

An equal request is an idempotent no-op only when its counts and current
canonical row count still match. A different request with the same timestamp is
rejected instead of receiving nondeterministic precedence. Canonical daily fact
replacement is limited to Reporting v3 and unified-report sources; Marketing
Stream and secondary imports cannot silently replace these source-less fact
tables.

The worker handoff requires explicit source/parsed/refused accounting for every
date, reconciles it against the downloaded range, and includes zero-row dates.
It is not connected to `fetchReport` yet. The current parser records an index and
reason for a refused row but not always its report date, so activating exact-day
replacement now could incorrectly delete a partial day.

Pure historical helpers:

- accept an externally verified source capability and availability boundary;
- clamp desired history to that boundary;
- make contiguous, newest-first windows no larger than the supplied request
  maximum;
- deduplicate returned dates while retaining exact gaps and a separate settled
  cutoff;
- refuse out-of-window returned dates.

No history depth or settling threshold is embedded as tenant doctrine.

## Verification

- DB and worker TypeScript compile with strict mode.
- Pure tests cover count reconciliation, mixed-date refusal, report-kind
  refusal, exact per-date handoff, zero-row dates, bounded contiguous history
  windows, missing dates and settling.
- A disposable-PostgreSQL test is present for stale-row removal, two attribution
  revisions, idempotency and late-request rejection. It uses only synthetic
  tenants and is skipped when no local test database is available.
- Package tests, lint and public-repository hygiene are required before handoff.

## Remaining integration gates

- Retain each refused source row's date (or an explicit unscoped refusal state)
  in the parser before replacing the legacy range upsert.
- Add a generic feature-report request ledger before SQP or unified report ids
  become relationally constrained.
- Decide and test canonical precedence when Reporting v3 and unified reports
  overlap after a profile passes a side-by-side parity gate.
- Run the disposable-PostgreSQL transaction test in CI or a local database job;
  a skipped test is not evidence that the SQL transaction executed.
- Promote coverage/progress rows only from the orchestrator that can assert
  request, response and canonical counts for the full bootstrap.
