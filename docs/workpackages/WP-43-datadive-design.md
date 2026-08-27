# WP-43 DataDive design

## Problem

DataDive rank data must cross a pure HTTP-client boundary, an organisation-scoped
Vault connection, a profile marketplace designation, and an idempotent database
grain without letting any of those concerns leak into the others. The frozen job
contract carries only an org, profile, and optional radar ids; the worker therefore
has to resolve the credential and storage policy behind the existing `rankSync`
handler port. DataDive's published OpenAPI confirms the three endpoints but leaves
some rank and quota scalar types described only as generic objects, so those fields
need conservative parsing and a live-smoke checkpoint.

## Usage (caller's view)

The transport package has one client and three endpoint-shaped methods:

```ts
const client = new DataDiveClient({ apiKey, fetch, sleep, now, random });
const quota = await client.getQuota();
const radars = await client.listRankRadars();
const ranks = await client.getRankRadarData(radar.id, {
  startDate: '2026-08-27',
  endDate: '2026-08-27',
});
```

The worker wires one bound handler into the queue shell:

```ts
const rankSync = createDataDiveRankSyncHandler({ handle });
const worker = new SyncWorker({
  workerId,
  store,
  integrations: { rankSync },
});
```

Tests replace only effects or the client port; neither package reads credentials
from the environment inside its implementation.

## Shape

`packages/datadive-api` owns authentication, URL construction, response parsing,
pagination, and bounded retry through one HTTP function. Its public domain types do
not expose wire DTOs; unmodeled response properties survive under `details`. The
three methods are a deep enough interface because callers do not coordinate pages,
headers, retry delays, JSON decoding, or response validation themselves, per
boundary-discipline and interface-depth.

`apps/worker/src/datadive.ts` owns one complete rank-sync operation. It selects one
eligible active connection, reads its key through the worker-only Vault RPC, checks
the Rank Radar quota, resolves payload radar ids before connection-config radar ids,
lists the radar metadata, and rejects every radar whose marketplace differs from the
profile country. Only after all remote reads and validations succeed does it flatten
the keyword/rank history into the database grain. Duplicate grain keys with equal
values collapse with an explicit count; conflicting duplicates fail. The loader then
chunks, upserts, and asserts offered equals written. This keeps the queue call chain
short and gives every invariant one owner.

No migration is planned. Search volume remains available in the client result but is
not part of `rank_observations`; impression/click share remains the SQP lane.

## Synthesis decision

The smallest-public-surface candidate is the base: three endpoint methods and one
worker handler factory. The isolation-first candidate contributed an injected
worker-side client factory and exported pure normalization/grain helpers for tests.
The alternative that exposed page reads and loader stages was rejected as shallow;
the alternative that put a tenant-aware `syncRanks` method in the API package was
rejected because it mixed database, Vault, and marketplace policy into transport.

## Tradeoffs accepted

- We accept one complete radar-list walk per job in exchange for validating selected
  ids, ASINs, and marketplaces before any row is written.
- We accept package-local DataDive domain types in exchange for respecting the frozen
  shared contract explicitly imposed by WP-43.
- We accept strict scalar parsing in exchange for failing visibly if the live API's
  underspecified rank fields differ from its examples.
- We accept a single profile-local calendar day per daily job in exchange for an
  idempotent, bounded pull whose returned dates remain provider-authored.

## Alternatives considered

- Standalone `listRankRadars`, `getRankRadarData`, and `getQuota` functions would make
  every caller repeat auth, base URL, and effects, exposing more policy than they hide.
- A client-level `syncAllRanks` would hide more calls but also require connection,
  profile, and storage policy, violating the pure package boundary.
- Separate resolver, validator, mapper, and loader services would be temporal
  decomposition: each would expose the same radar and observation representation.

## Open questions and risks

- Does the live API encode `organicRank`, `searchVolume`, quota counts, and an unranked
  result as numbers or null exactly as its examples imply?
- Does `marketplace` use the same two-letter country code as `ad_profiles.country_code`?
- Does the current endpoint return variation-level ASINs, or only the radar's primary
  ASIN as its published schema says?

## Next implementation step

Build the pure client and recorded fixture suite before adding any worker persistence.
