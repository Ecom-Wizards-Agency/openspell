# WP-74 — Integrated release verification

## Outcome

Integrate the outstanding operator workspaces, close evidence-quality gaps found
by an independent release review, and prove the candidate with synthetic data
before deployment. This package does not authorize a hosted migration, seed,
Amazon Advertising write, AWS resource change, or competitor-product mutation.

## Included candidate

- Persistent optimization groups with atomic campaign assignment and one group
  context per recommendation run.
- Creative Performance, Query Intelligence, Dayparting and Strategy Overview
  routes in the task-oriented navigation.
- Marketing Stream SQS long polling, idempotent ledger retention, counted
  projection and sanitized health state.
- Anti-compounding gates for queued/running previews and exported
  recommendations awaiting synchronized evidence.
- Read-time dayparting maturity so old settling facts do not remain excluded
  forever.
- Profile-only historical PPC attribution until a dated ad-to-ASIN source can
  support an exact weekly SQP join.

## Verified locally

- Full repository typecheck, lint, unit tests and public-repository hygiene.
- Disposable PostgreSQL migrations and tenant tests.
- Worker PostgreSQL suite: 179 of 179.
- Web PostgreSQL suite: 316 of 316.
- Production-build browser suite: 27 of 27.
- Authenticated-development browser suite: 27 of 27, including every guarded
  operator route, OAuth refusal paths and role enforcement.
- The existing synthetic 3,597-row grid performance suite remains within its
  filter/group target.
- No test or runtime path invokes an Amazon Advertising write API.

## Release gates still open

1. Hosted application revision and route click-through after merge.
2. Exact authorization before applying the feature-job enum migration.
3. Live authenticated SQP dispatch and source-to-output reconciliation.
4. AWS SQS/DLQ plus Amazon Marketing Stream subscription/fanout provisioning.
5. Live SB Video ad-to-creative-to-Asset-ID crosscheck.
6. Fresh non-mutating AdLabs and SYNQ comparison through the operator's
   authenticated browser session.
7. Sustained v1 parity evidence before any Amazon write gate can open.
