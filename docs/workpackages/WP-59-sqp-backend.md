# WP-59 — SQP ingestion and persistence backend

## Problem

Wizard Ads needs a weekly
`GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT` workflow without forcing
the new report through the legacy Advertising report ledger. The existing
shared contracts already define the job payload, six-category vocabulary,
weekly fact and proposal shapes. The database already has the canonical facts,
vocabulary and proposal tables. However, the live queue enum and dispatcher do
not yet include `sqp.request`, and there is no durable feature-report request
checkpoint table. Those are explicit deployment gates, not reasons to create a
second local contract.

Amazon's current documentation confirms that the report accepts a
space-separated ASIN list with a 200-character option limit. Reports are
retained for at most 90 days by `getReports`, and report-processing completion
uses the `DONE`, `CANCELLED` and `FATAL` states. The implementation uses these
published constraints while requiring exact local request identity before a
completed report can be reused:

- [Search Query Performance multi-ASIN update](https://developer-docs.amazon.com/sp-api/lang-en_EN/changelog/update-search-query-performance-report-now-includes-support-to-query-multiple-asins)
- [Reports API `getReports`](https://developer-docs.amazon.com/sp-api/reference/getreports)
- [Report processing notifications](https://developer-docs.amazon.com/sp-api/docs/notification-type-values)

## Usage from the future dispatcher

The dispatcher parses the existing shared `SqpRequestJob`, supplies a durable
checkpoint adapter, an SP-API Reports client, the rate gate and the Postgres
data adapter, then invokes one deep workflow:

```ts
const result = await runSqpRequestWorkflow(payload, {
  api: reportsClient,
  providerGate,
  checkpoints,
  data: new PostgresSqpWorkflowDataStore(database),
  resolveRouting,
});

if (result.status === 'pending') {
  // Requeue the same shared payload after result.nextPollAfterSeconds.
}
```

The same request key resumes provider report IDs and returns a stored completed
result without making another provider call. The workflow never exposes an
Amazon advertising mutation method.

## Shape

Three designs were considered:

1. A single resumable workflow behind injected provider, checkpoint and data
   interfaces. This hides batching, polling, parsing, classification, joins and
   count reconciliation from the dispatcher.
2. Public plan, acquire, parse, classify and persist stages. This was rejected
   because callers would have to preserve temporal invariants and could promote
   a partial report accidentally.
3. A new queue and report-ledger state machine in this package. This was
   rejected because it would modify frozen shared contracts and the shared
   database migration lane without the required ownership gate.

The first design is implemented. It borrows the explicit durable checkpoint
state from the third design, but keeps its storage interface injectable until
the authoritative migration lands. One invocation performs at most one status
poll per report and yields `pending`; it does not hold a worker open while an
Amazon report generates.

The load-bearing behavior is:

- request periods are exactly Sunday through Saturday;
- every request carries one marketplace;
- ASINs are canonicalized, deduplicated, sorted and batched under Amazon's
  report-option limit;
- a stable request key includes profile, marketplace, week and the exact ASIN
  batches;
- a reused report is trusted only through that checkpoint key, not merely
  because it has the same type and date;
- additive Amazon fields are tolerated, while missing or malformed known
  structures, wrong weeks, unrequested ASINs and conflicting normalized grains
  are refused;
- any refused source row blocks canonical promotion;
- `CANCELLED` never clears canonical rows on status alone because Amazon uses
  it for both automatic no-data and manual cancellation; an injected provider
  check must independently confirm no-data first;
- canonical facts are transactionally replaced for every requested ASIN,
  including ASINs that return no rows;
- source, parsed, refused, deduplicated, promoted, upserted and canonical counts reconcile
  before commit;
- approved vocabulary is never made pending by a later suggestion refresh;
- AI suggestions remain pending until a human records review evidence;
- detailed categories are retained while branded/non-branded and addressable
  rollups are derived; Generic Head stays in raw totals and outside addressable
  opportunity;
- PPC is aggregated before advertised-ASIN resolution, so a multi-ASIN ad group
  becomes ambiguous instead of duplicating spend;
- Sponsored Brands and every other ad product are classified by customer search
  term because the input is the canonical search-term fact;
- contextual negatives remain ad-group, review-only proposals, and an existing
  accepted, dismissed or exported decision is never reset by refresh;
- tenant routing policy must be supplied explicitly. Without it, the workflow
  creates no contextual proposals.

## Files

- `packages/sp-api/src/sqp.ts` — strict request planning and document parsing.
- `packages/db/src/queries/sqp.ts` — counted facts, vocabulary, proposal and PPC
  query persistence.
- `apps/worker/src/sqp.ts` — resumable report orchestration and Postgres adapter.
- matching package tests — synthetic provider, retry/throttle, idempotency,
  count, tenant and failure coverage.

## Deployment gates

This package deliberately does not edit shared contracts or migrations.
Production execution still requires:

1. add `sqp.request` to the authoritative Postgres queue enum and dispatcher;
2. add a tenant-scoped durable feature-report checkpoint/ledger capable of
   storing the workflow checkpoint and exact request identity;
3. wire the SP-API connection and regional endpoint in the worker without
   exposing credentials to web;
4. persist explicit tenant routing-policy fields before enabling contextual
   proposal generation;
5. supply authoritative no-data confirmation for cancelled reports, or retain
   the fail-closed behavior that preserves prior canonical evidence;
6. apply the already-reviewed operator-intelligence migration to the exact
   authorized target before any worker uses these tables;
7. run an authoritative live row/count parity check before treating the report
   as product evidence.

Provider-wide `getReports` discovery is not a substitute for the checkpoint:
the list filters do not prove that a completed report used the same ASIN option
batch. Reusing it without exact local identity could load a correct-looking
report for the wrong requested set.

## Verification

No live SP-API call, hosted migration, seed or Amazon advertising write was
performed. Tests use synthetic rows and a disposable PostgreSQL instance.

Required release checks:

```bash
pnpm --filter @wizard-ads/sp-api test
pnpm --filter @wizard-ads/db exec vitest run src/queries/sqp.test.ts --maxWorkers=1
pnpm --filter @wizard-ads/worker exec vitest run src/sqp.test.ts
pnpm check
```

The database command must receive `WIZARD_ADS_TEST_DATABASE_URL` pointing to a
throwaway local PostgreSQL instance. Final counts and commit SHAs belong in the
integration evidence report after the branch is merged.
