# WP-75 — Weekly SQP worker runtime

## Outcome

The existing weekly SQP workflow is now queue-safe across normal retries and
worker restarts. Each `sqp.request` job stores its report ids and provider state
in an envelope on its own `sync_jobs.result` ledger row. The queue's existing
`finish_sync_job` behavior preserves that result when a failed attempt is
requeued, so no migration is required.

An unfinished Amazon report now produces an explicit pending error. The worker
requeues it at the workflow's poll interval rather than incorrectly marking the
job successful or consuming its bounded failure budget. Actual API and network
failures still consume attempts. A replacement process loads the same
checkpoint, polls the same report id, and does not create a duplicate. A replay
after completion does not download or promote the report again.

The checkpoint read and write require an exact match on job id, organization,
profile, job type, and running state. Malformed or foreign checkpoint envelopes
are permanent failures rather than trusted input.

## Verified inherited behavior

Current `origin/main` already supplied these parts and their synthetic tests:

- Sunday-through-Saturday weekly validation;
- one marketplace in every report request;
- canonical, deduplicated ASIN batches under the report-option character limit;
- Reports API retry handling for throttling and server failures;
- parsed/refused/promoted/canonical row count assertions;
- transactional, out-of-order-safe, idempotent weekly promotion;
- vocabulary classification, PPC spend conservation, and review-only contextual
  negative proposals;
- no Amazon Advertising write API.

WP-75 adds durable orchestration around those parts rather than creating a
second SQP model.

## Remaining production gate

The handler factory is intentionally not bound in `apps/worker/src/main.ts`.
The repository does not yet contain an authoritative relationship from an ad
profile to an `spapi_connections` row, nor an SP-API Vault retrieval function.
An organization can legitimately have more than one seller account in one
marketplace, so choosing a connection by organization or marketplace would risk
reading the wrong account. No environment-secret shortcut was added.

The scheduler also builds a week payload only for `sqp.categorize`; it does not
yet derive authoritative profile marketplace and ASIN inputs for a weekly
`sqp.request` job. Production activation therefore needs, in order:

1. an approved profile-to-SP-API connection contract and database relationship;
2. service-role-only SP-API secret custody and access-token refresh;
3. an authoritative profile marketplace/ASIN source for the completed week;
4. binding `createPostgresSqpRequestHandler` only in a runtime that can resolve
   those inputs without ambiguity.

No production or shared database migration was run in this package.

## Narrow provider limitation

Amazon's current Reports API returns report type, marketplaces, and data range
when reports are listed, but not the original `reportOptions`. SQP ASIN batches
live in those omitted options. A report discovered after a process dies between
Amazon accepting `createReport` and the checkpoint write therefore cannot be
proven identical from list metadata alone. WP-75 does not reuse a merely similar
report, because doing so could attribute the wrong ASIN batch. The authoritative
model is the public [Reports API schema](https://github.com/amzn/selling-partner-api-models/blob/main/models/reports-api-model/reports_2021-06-30.json).

## Acceptance evidence

- a pending report is requeued with the workflow poll delay;
- normal provider processing does not consume a failure attempt;
- a reconstructed handler creates one report across pending and completed runs;
- completed replay performs no provider calls and no second promotion;
- a foreign tenant/profile ledger row is rejected;
- the completed result retains source, parsed, upsert, and canonical counts;
- all fixtures are synthetic;
- no credential, client data, private threshold, or Amazon Agent material is
  present.
