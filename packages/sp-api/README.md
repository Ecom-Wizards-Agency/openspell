# `@wizard-ads/sp-api`

Pure Selling Partner API transport and report parsing for worker-owned jobs. It
depends only on `@wizard-ads/shared`, performs no database I/O, and never owns or
persists Amazon credentials. The web application must not import this package.

The first supported workflow is weekly Brand Analytics Search Query Performance:

- one marketplace per report;
- Sunday-through-Saturday periods;
- report reuse can be implemented by the worker around the request identity;
- ASIN report options are batched to Amazon's 200-character limit;
- parsing accounts for every source row as parsed or refused, then reports
  deduplication and output counts explicitly.

The worker injects an access-token provider and the configured SP-API endpoint.
No token reaches request logs or returned errors.
