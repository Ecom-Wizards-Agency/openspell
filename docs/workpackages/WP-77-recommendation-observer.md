# WP-77 — Recommendation observation reconciler

## Outcome

Close the optimizer evidence loop after an operator exports a recommendation.
The always-on worker now observes synchronized bid history and settled matched
pre/post facts before another recommendation for the group can proceed.

## Behavior

- Evidence thresholds come only from the tenant strategy's
  `recommendation_evidence` policy. The shared contract contains the shape, and
  the tracked template contains placeholders; application source has no
  numeric defaults.
- A recommendation is eligible only when it has one exact export row, immutable
  optimization-group context and a supported SP keyword or product-target bid
  grain.
- Synchronization evidence must be linked to that export row. A conflicting
  synchronized value holds for review.
- The observation window starts on the next complete profile-local calendar
  day after synchronization, preventing mixed pre/post auctions in one day.
- Equal-length pre/post dates are matched by day offset and use settled
  `purchases_7d` evidence. Missing dates reduce the pair count instead of being
  invented as zeroes.
- The existing pure evaluator produces `continue`, `hold`, or `revert`. A
  reversion retains the exact pre-change value in provenance and remains an
  export proposal; it does not call Amazon.
- Reconciliation is bounded, tenant/profile serialized and idempotent. A retry
  writes no duplicate observation unless synchronized or settled evidence has
  changed.

## Verification

- Disposable PostgreSQL covers awaiting sync → observing → settled reversion,
  supported-lift continuation, missing-policy refusal and retry idempotency.
- Worker, shared-contract and core suites pass with the authoritative policy
  type.
- Full repository typecheck, lint, tests and hygiene pass.

No migration, production data, credential, doctrine value or Amazon write is
part of this package.

## Deliberate boundary

The first evidence adapter supports optimizer-generated SP keyword and
product-target bid rows. Other entities and placement changes fail closed until
their own authoritative matched fact adapters exist.
