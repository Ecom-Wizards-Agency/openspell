# @wizard-ads/ads-api

The Amazon Ads API, typed. LWA tokens, profiles, entity lists, Exports,
Reporting v3, budget usage — with regional hosts, throttle-aware retry, and one
parser per report schema.

A pure client: no database, no filesystem, no scheduling. Every Amazon call in
the system happens in `apps/worker`, which is the only package allowed to import
this one. `apps/web` may import the LWA code exchange and the profile fetch for
its OAuth callback, and nothing else; `eslint.config.js` enforces that.

Ported from `amazon-agent`'s `SPAdsApiDataSource` and `ads-auth/exchange_token.py`,
which are read-only ground truth. The two gaps those files document — the
campaign-name join and budget usage — are closed here.

## What the worker gets

```ts
const client = new AdsApiClient({ credentials, region: 'NA' });

const campaigns = await client.listSpCampaigns(profileId);
// campaigns.items    -> mirror rows, minus profileId (the worker's uuid)
// campaigns.raw      -> what Amazon sent
// campaigns.skipped  -> what could not be mapped, and why
// items + skipped === raw. Assert it. That is Rule 4 as data.

const created = await client.createReport(profileId, {
  reportType: 'spTargeting', startDate: day, endDate: day,
});
const meta = await client.getReport(profileId, created.reportId);   // poll: worker's job
const download = await client.downloadReport(meta.url!);            // gunzip + JSON
const parsed = parseSpTargetingReport(download.rows);               // rows + skipped + input
```

Three deliberate absences:

- **No polling.** Reporting v3 takes up to three hours. `createReport`,
  `getReport` and `downloadReport` are three calls so a killed worker resumes
  from a report id instead of losing the report.
- **No `profileId` on the rows.** The contract's `profileId` is our database
  uuid; this package only knows Amazon's. The worker holds both halves.
- **No writes.** v1 is read-only: it proposes, the operator applies.

## Retry, and who owns what

The client owns *per-request* retry: exponential backoff with jitter on 429
(honouring `Retry-After` when Amazon sends one, which is not always), a retry on
5xx and transport failures for reads only, and a single forced token refresh on
401. Writes are never re-sent on an ambiguous failure.

The worker owns *pacing*. It reads `client.throttleState` between jobs and gets
an `onRetry` callback as each decision is made. Amazon publishes no quota
headers, so an observed throttle rate is the only signal that exists.

## Report types

`spCampaigns` is campaign grain; `spTargeting` is the target grain that is the
spine of the product. `spPlacement` is not an Amazon report type — placement is
a *grouping* on `spCampaigns`, which is why a placement report cannot also ask
for `topOfSearchImpressionShare`. Column lists for Sponsored Brands and
Sponsored Display are documentation-derived and unverified live; every call
takes a `columns` override so an operator can correct a rejected column set
without a code change.

## Live smoke test

```bash
cp _local/ads-api.config.TEMPLATE.json _local/ads-api.config.json   # then fill it in
cd packages/ads-api && pnpm smoke
```

Read-only, but it creates exactly one report, which costs quota. It prints
profile counts, the request/poll/download cycle, rows downloaded against rows
parsed against rows skipped, byte counts either side of decompression, and the
campaign-name join coverage. It never prints a credential.

The fixture suite proves the client agrees with what Amazon documents; the smoke
test proves Amazon agrees with the client. Report completion, report download
and the whole Exports contract have never been confirmed against a live account.
