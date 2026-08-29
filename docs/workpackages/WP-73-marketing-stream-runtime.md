# WP-73 — Marketing Stream SQS runtime

## Outcome

Add the bounded, read-only Amazon Marketing Stream transport needed by
Dayparting v0.5. The always-on worker long-polls one private AWS SQS queue,
validates an explicit shared batch envelope, appends the raw ledger, replaces
race-safe hourly projections, and deletes the SQS delivery only after all
counts reconcile.

Amazon identifies SQS as a supported Marketing Stream destination and its
reference implementation uses SQS as the default delivery option with an
associated dead-letter queue. The reference also shows that deliveries may be
wrapped as SNS notifications. Sources:

- [Amazon Marketing Stream overview](https://advertising.amazon.com/en-gb/solutions/products/amazon-marketing-stream)
- [Amazon reference implementation](https://github.com/amzn/amazon-marketing-stream-examples)

This package does not create subscriptions, provision AWS resources, or write
any change to Amazon Advertising.

## Ownership

- `packages/shared`: additive job, envelope, and tenant-policy contracts.
- `supabase/migrations`: additive feature labels for `sync_job_type`.
- `packages/db/src/migrations.test.ts`: enum/migration parity assertion.
- `apps/worker`: SQS transport, context loading, process lifecycle, health,
  feature-job dispatch safety, and tests.
- `_local/strategy.TEMPLATE.json`: placeholder-only dayparting policy shape.

No web, navigation, optimizer recommendation, Creative, SQP, or production
deployment file is in scope.

## Shared contract

`MarketingStreamBatchEnvelope` is the only accepted data delivery:

```text
schema = wizard-ads.marketing-stream-batch.v1
orgId
profileId
events[] = MarketingStreamLedgerEvent
```

Every event must repeat the envelope profile id. Each event identifies one of
the supported `SP | SB | SD` products and one of `traffic | conversion |
budget_usage`. The body can be delivered directly through SQS raw message
delivery or inside the standard SNS `Notification.Message` string.

The Amazon subscription/fanout boundary must map the selected provider dataset
version into this envelope. The normalizer intentionally does not guess at
unknown provider fields or infer tenant identity from campaign ids.

## Runtime behavior

1. `MARKETING_STREAM_SQS_QUEUE_URL` enables the consumer. If absent, the worker
   starts exactly as before.
2. `SQSClient({})` uses the standard AWS region and credential provider chain.
   No credential value is accepted by application configuration or logged.
3. Receive uses a 20-second long poll and the SQS maximum batch of 10. Each SQS
   delivery is processed independently so one malformed delivery cannot cause
   a successfully persisted sibling to be replayed.
4. The profile's timezone and currency come from `ad_profiles`. The settling
   window and budget-cap threshold come from the layered tenant/profile
   strategy's `dayparting` section. Missing policy is an error with no numeric
   fallback.
5. The existing Marketing Stream service validates, appends, snapshots the
   latest revisions, normalizes, replaces affected hourly scopes, and reads the
   fact count back.
6. The consumer independently asserts envelope events, ledger offers,
   refusals, normalized writes, and read-back rows. Any refusal leaves the SQS
   delivery unacknowledged.
7. `DeleteMessage` is issued last. A crash before deletion produces a safe
   idempotent redelivery; a delete failure also leaves the delivery for retry.
8. Receive/provider failures retry with bounded exponential backoff. Per-item
   failures are left to the queue's visibility timeout and redrive policy.
9. SIGTERM/SIGINT aborts a pending long poll, waits for in-flight database work,
   and destroys the SQS client before the database pool closes.
10. `/healthz` exposes only counters, timestamps, and an error class. It never
    returns the queue URL, credentials, envelope, profile, or payload.

## Queue contract reconciliation

The five previously separate `FeatureJobPayload` members are now also members
of authoritative `JobType` and `JobPayload`, and the database enum gains the
same labels:

- `creative.sync`
- `sqp.request`
- `history.bootstrap`
- `report.promote`
- `marketing_stream.normalize`

The worker has explicit optional dispatch slots for each. A queued feature job
with no real handler is dead-lettered immediately; it is never parsed as an
unknown job and never reported as successful. WP-73 does not invent handlers
for Creative, SQP, bootstrap, or promotion.

The active SQS runtime processes complete envelopes directly. It does not
enqueue `marketing_stream.normalize` rows, because splitting append and
normalization across two queues would weaken the SQS acknowledgement boundary.

## Verification

- Shared contracts round-trip all 15 queue payloads and reject mixed-profile
  Marketing Stream envelopes.
- Worker unit tests cover raw/SNS delivery, all nine product/dataset
  combinations, count gates, refusal, malformed body, delete failure,
  duplicate redelivery, provider retry, sanitized status, and clean stop.
- PostgreSQL integration covers migration application, layered policy loading,
  ledger/fact counts, budget-cap derivation, a newer revision arriving before
  the older one, and duplicate redelivery.
- Repository typecheck, lint, tests, and hygiene must pass.
- No test or runtime path invokes an Amazon Ads write API.

## Live prerequisites not performed by this work package

1. Apply `20260829140000_feature_job_types.sql` to the authorized hosted
   database. This plan does not authorize that production migration.
2. Provision an AWS standard SQS queue and DLQ/redrive policy in the region
   required by the selected Marketing Stream realm.
3. Grant the worker identity only `sqs:ReceiveMessage`,
   `sqs:DeleteMessage`, and `sqs:GetQueueAttributes` for that queue. Supply the
   identity through the normal AWS provider chain.
4. Complete Amazon's subscription confirmation/provisioning workflow and map
   the selected Stream dataset versions into
   `wizard-ads.marketing-stream-batch.v1` without plaintext credentials.
5. Seed each participating tenant/profile with approved `dayparting` strategy
   values and set `MARKETING_STREAM_SQS_QUEUE_URL` in the deployment secret
   manager.
6. Validate live source-message, ledger-event, affected-scope, normalized-row,
   and acknowledged-delivery counts before treating the heatmap as
   authoritative.
