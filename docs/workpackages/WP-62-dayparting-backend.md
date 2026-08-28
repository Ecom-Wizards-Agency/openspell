# WP-62 — Marketing Stream and Dayparting v0.5 backend

## Boundary

This package owns focused persistence in `packages/db`, pure normalization and
proposal logic in `apps/worker`, and this brief. It reuses the additive WP-56
tables and the frozen shared contracts. It does not alter `packages/shared`,
the live job enum, the web application, Amazon campaigns, bids, placements, or
budgets. No hosted migration, seed, AWS subscription, or Amazon write is part
of this package.

Amazon supports Amazon Marketing Stream delivery through AWS SQS or Firehose;
the official reference implementation uses SQS as its default and provisions
dead-letter queues. The source datasets include SP/SB/SD traffic and conversion
plus budget usage. The implementation here is the storage and normalization
backend behind that SQS boundary, not a second queue system.

- [Amazon Marketing Stream product overview](https://advertising.amazon.com/solutions/products/amazon-marketing-stream)
- [Official SQS reference implementation](https://github.com/amzn/amazon-marketing-stream-examples)

## Usage (caller's view)

An SQS receiver validates its transport envelope, calculates the payload hash,
and hands shared-contract ledger events to one operation:

```ts
const result = await processMarketingStreamBatch(
  new DbMarketingStreamStore(database),
  {
    orgId,
    profileId,
    events,
    policy: {
      profileTimeZone: profile.timezone,
      currencyCode: profile.currencyCode,
      settlingWindowHours: strategy.settlingWindowHours,
      budgetCappedAtPercent: strategy.budgetCappedAtPercent,
      now: clock.now(),
    },
  },
);
```

The caller receives source counts, duplicate/revision/refusal counts, exact
projection counts, and refusals. An unsupported raw metric payload remains in
the ledger for diagnosis, while its contaminated hour keeps the previous
canonical projection.

Proposal generation is pure and accepts every modeling value as tenant data:

```ts
const proposal = proposeDaypartingSchedule(settledFacts, tenantModel);
const preview = exportDaypartingSchedule(proposal); // JSON and CSV only
await store.persistProposal({ orgId, proposal });
```

Nothing in either call applies a change to Amazon.

## Shape

The raw ledger is append-only and unique by profile, dataset, message, and
revision. An exact redelivery is counted and ignored. A later or out-of-order
revision is retained, never folded into the prior payload.

Normalization works by complete `(profile, ad product, UTC hour)` scope:

1. append valid ledger messages under a profile advisory lock;
2. collect every old and new UTC hour touched by those logical messages;
3. select only the latest numeric revision of each logical message;
4. validate the payload and aggregate SP/SB/SD traffic, conversion, and budget
   usage by campaign and UTC hour;
5. derive profile-local date, hour, and weekday with `Intl` time-zone rules, so
   DST fall-back hours remain two UTC facts with one repeated local hour;
6. lock each affected scope and re-read its exact latest event IDs;
7. replace the complete canonical scope only when those IDs still match;
8. read the canonical row count back before commit.

The exact event-ID comparison is the concurrency guard. A worker that
normalized before a newer revision arrived fails with
`StaleMarketingStreamProjection`; it cannot overwrite the newer evidence even
when the old and new scopes contain the same number of source events.

Recent hours are `settling`. An older hour with a newly received revision is
`revised` for the supplied settling interval and later becomes `settled` on a
fresh normalization pass. Final proposal generation accepts `settled` facts
only.

The proposal model groups settled evidence by profile-local weekday and hour,
calculates either conversion rate or ROAS, shrinks sparse cells toward an
explicit approved baseline, clamps and quantizes using supplied tenant values,
and merges adjacent hours carrying the same adjustment. Missing or
insufficient cells remain at baseline and are omitted. Exports are review-only
CSV and JSON representations of the shared proposal contract.

This is a deep three-operation database surface—append, snapshot, replace—so
callers do not coordinate revision precedence, stale-row deletion, or
concurrency themselves. Amazon wire data remains inside the worker boundary;
storage rows are not exposed as transport types.

## Synthesis decision

The selected shape recomputes complete affected-hour projections from the
append-only ledger and guards replacement with exact source IDs. It combines
the smallest caller surface with a testable pure normalizer and makes revision
ordering a database invariant.

Two alternatives were rejected:

- Incrementally adding each message to the current hourly row had a smaller
  first write, but a revision would require every caller to know how to subtract
  prior traffic, conversion, and budget values. It leaked ledger semantics and
  could compound redeliveries.
- Persisting one normalized contribution row per event before aggregation would
  provide an equally strong replay model, but requires an additive schema and
  migration outside this package's ownership. The existing raw ledger plus
  source-ID guarded recomputation provides the invariant without widening the
  schema.

We accept recomputing the touched hour in exchange for exact revision behavior,
stale-row removal, and a substantially smaller public interface.

## Verification

Synthetic worker tests cover:

- SP, SB, and SD traffic, conversion, and budget-usage aggregation;
- source-event counts, unsupported-payload refusal, and partial-scope safety;
- DST fall-back with two UTC hours mapped to one local hour;
- settling, recently revised, and settled evidence;
- explicit-baseline shrinkage, adjustment bounds and increments supplied by
  the tenant, adjacent-hour merging, and exclusion of unsettled facts;
- JSON/CSV exports that contain no Amazon apply action.

Disposable PostgreSQL tests cover exact redelivery, numeric latest-revision
selection when revisions arrive out of order, old/new scope discovery when an
event moves hours, stale projection rejection, exact replacement/read-back
counts, tenant-scoped reads, and idempotent proposal persistence. The final
verification used a disposable PostgreSQL 17 server bound to localhost:

- focused worker suite: 8 of 8 tests passed;
- focused database suite: 5 of 5 tests passed;
- complete worker suite: 16 files and 132 tests passed; the 24 existing live
  integration cases remained intentionally skipped without credentials;
- complete database suite with migrations: 24 files and 188 tests passed;
- repository `pnpm check`: all 18 workspace typechecks and test tasks passed,
  followed by lint, public-repository hygiene, and skill lint.

No hosted database or Amazon endpoint was invoked.

## Remaining integration gates

- `MarketingStreamNormalizeJob` exists in `FeatureJobPayload`, but the live
  worker and database queue accept only `JobPayload`/`JobType`, and
  `sync_job_type` does not contain `marketing_stream.normalize`. The owning
  contract and migration packages must widen those three surfaces together;
  this package does not invent a parallel job type.
- Deploy the official SQS subscription, least-privilege receiver, visibility
  timeout, retry, and DLQ configuration after the queue contract lands. Verify
  live Amazon payloads against the strict `metrics` parser before acknowledging
  SQS messages. Unknown shapes must remain refused rather than guessed.
- Benchmark real ledger volume before selecting retention and partitioning.
  WP-56 deliberately left these tables unpartitioned so global message
  idempotency remains enforceable.
- A scheduler must re-normalize old revised hours after their supplied settling
  interval so they can transition to settled evidence.
- The heatmap, confidence display, schedule review, and download controls belong
  to the selected frontend work package. Automatic execution remains deferred
  behind the global Amazon write gate.
