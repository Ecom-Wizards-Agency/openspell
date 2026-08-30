# WP-132 — Marketing Stream provider adapter

## Outcome

Replace the undocumented producer-only gap at the SQS boundary with a strict
adapter for Amazon's current sponsored-ads Marketing Stream records. This
package is ingestion-only: it does not create a subscription, change AWS,
apply a migration, or mutate an Amazon advertising entity.

## Source contract

Verified against the Amazon Marketing Stream data guide on 2026-08-30 and the
official reference implementation at commit
`349918ef35aa0f60ef7e74641d17228a61f6df18`:

- [Amazon Marketing Stream data guide](https://advertising.amazon.com/API/docs/en-us/guides/amazon-marketing-stream/data-guide)
- [Sponsored Products performance](https://advertising.amazon.com/API/docs/en-us/guides/amazon-marketing-stream/datasets/sp-performance)
- [Sponsored Brands performance](https://advertising.amazon.com/API/docs/en-us/guides/amazon-marketing-stream/datasets/sb-performance)
- [Sponsored Display performance](https://advertising.amazon.com/API/docs/en-us/guides/amazon-marketing-stream/datasets/sd-performance)
- [Budget usage](https://advertising.amazon.com/API/docs/en-us/guides/amazon-marketing-stream/datasets/budget-usage)
- [Amazon SQS reference implementation](https://github.com/amzn/amazon-marketing-stream-examples/tree/349918ef35aa0f60ef7e74641d17228a61f6df18)

The adapter supports the six traffic/conversion datasets for SP, SB, and SD,
plus campaign-scoped `budget-usage`. The provider record itself is retained in
the raw ledger. `idempotency_id` is the event identity. Sponsored-ads
restatements are incremental records with distinct identities, so the adapter
does not invent a revision number or replace another provider record.

## Identity and normalization rules

- `advertiser_id`, `marketplace_id`, and `dataset_id` must match one active,
  explicitly provisioned subscription binding. Profile/account aliases are not
  used for runtime routing; campaign ids never determine tenant scope.
- Provider timestamps, including an explicit profile-local offset, are stored
  as UTC instants while the original value remains in the raw record.
- Traffic uses impressions, clicks, and cost.
- Conversion uses 14-day click-attributed conversions and sales, the comparable
  window present across current SP, SB, and SD schemas. View attribution stays
  raw and separate.
- Budget usage accepts `CAMPAIGN` only and remains a point-in-time percentage.
  Portfolio notifications are explicitly unsupported by the campaign-grained
  hourly fact.
- Corrections and replay semantics are completed by
  [WP-147](./WP-147-marketing-stream-correctness.md).

## Verification and remaining live gates

Unit coverage includes direct and SNS-wrapped provider records, all three ad
products, budget scope, unsupported datasets, strict timezone offsets, stable
payload hashing, binding resolution, count reconciliation, retry, and
acknowledgement order.

The live path remains gated on an AWS queue/DLQ in the required realm, Amazon
subscription confirmation, worker environment configuration, the already
reviewed database migration set, and a source-to-ledger-to-fact count
crosscheck. No live payload or profile identity is committed as a fixture.
