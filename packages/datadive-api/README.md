# `@wizard-ads/datadive-api`

Pure DataDive REST client for Rank Radar metadata, daily keyword ranks, and quota
usage. It has no database, filesystem, environment, or tenant awareness. Credentials
and all effects arrive as constructor arguments.

```ts
import { DataDiveClient } from '@wizard-ads/datadive-api';

const client = new DataDiveClient({ apiKey });
const quota = await client.getQuota();
const radars = await client.listRankRadars();
const data = await client.getRankRadarData(radars.items[0]!.id, {
  startDate: '2026-08-27',
  endDate: '2026-08-27',
});
```

The client sends `x-api-key` to `https://api.datadive.tools`, walks Rank Radar
pagination to completion, and retries bounded GET failures. A 429 honours
`Retry-After`; exhausted retries throw `DataDiveThrottleError` with the observed
delay for worker pacing.

## Published contract and live-smoke assumptions

The implementation was checked against DataDive's public OpenAPI at
`https://developer.datadive.tools/docs` on 2026-08-27. The paths, API-key header,
pagination envelope, and required date range are published. Several scalar fields
are underspecified there as generic `object` values even though their examples are
numbers. Until the operator runs a live call, the parser deliberately assumes:

- `organicRank`, `searchVolume`, quota `used`, and quota `capacity` are finite
  numbers or `null`; ranks are non-negative integers;
- `marketplace` is the same two-letter country code stored on the designated ads
  profile;
- rank history belongs to the Rank Radar's primary `asin`; the published response
  does not identify a different ASIN per rank point;
- an unranked keyword is represented by `organicRank: null`.

Any different live shape fails with `DataDiveParseError` instead of being coerced or
silently dropped. Unknown response fields are retained on each domain object's
`details` property for smoke-test inspection.

## Out of scope

Impression share, click share, and their derived ranks belong to Search Query
Performance (WP-46). This package does not use DataDive as an SQP workaround and the
rank-sync handler persists organic rank only.
