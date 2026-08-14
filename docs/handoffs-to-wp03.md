# WP-10 → WP-03: wiring the `crosscheck.ingest` handler

**From:** WP-10 (crosscheck harness) · **To:** WP-03 (worker + queue) · **Status:** ready, nothing blocking

WP-03's brief says the `crosscheck.ingest` handler is a shell and "logic lands in WP-10". The
logic has landed, as a function you call rather than code you copy: `apps/worker` was not touched
by this work package and does not need to be edited by it.

## The call

```ts
import { runCrosscheckIngest } from '@wizard-ads/crosscheck-cli';
import type { CrosscheckIngestJob } from '@wizard-ads/shared';

// inside the claim loop, once the payload is discriminated to crosscheck.ingest
const result = await runCrosscheckIngest(handle, payload, {
  archive: true,          // move ingested exports into <inbox>/processed/
  runId: job.id,          // groups the rows this run wrote
  // tolerance and reportDay default to 0.07 and the payload's `date`
});
```

Add `"@wizard-ads/crosscheck-cli": "workspace:*"` to `apps/worker/package.json`. The dependency
direction holds: the package sits with `db`/`core`, imports `@wizard-ads/core` for the verdict
model and `@wizard-ads/db` for the fact reads, and never touches `ads-api`.

`handle` is the `DbHandle` from `@wizard-ads/db` (`createDb(...)`), the same one the other
handlers use. The function opens no connection of its own and starts no transaction: if you want
one ingest to be atomic, wrap the call.

## What it does

1. Resolves the profile, so an export naming a different Amazon profile is refused rather than
   compared (`ExportContractError`).
2. Reads every export at `payload.sourcePath` — a single file or a directory to scan. A directory
   is the normal case: the profile-grain and campaign-grain exports for one night arrive together.
3. Compares against `fact_profile_daily` (per day) and the SP-target/SB/SD union (per
   campaign-week), at ±7% tolerance, excluding the provisional day.
4. Upserts `crosscheck_results` on `(profile_id, date, grain, entity_id, metric)` and asserts rows
   written against rows offered.
5. With `archive: true`, moves the exports into `<inbox>/processed/`. Never deletes them.

## What it returns, and what to log

```ts
interface CrosscheckIngestResult {
  profile: ProfileIdentity;
  files: { name: string; grain: string; rowsParsed: number; rowsKept: number }[];
  filesParsed: number; rowsParsed: number; rowsKept: number;
  findings: CrosscheckFinding[];
  summary: {
    profileDaysCompared: number; profileDaysSkipped: number;
    campaignsCompared: number; campaignsSkippedIdle: number;
    headline: 'verified' | 'mismatch' | 'missing_ours' | 'missing_theirs' | 'no_data';
  };
  written: number;
}
```

Log `rowsParsed` against `rowsKept` and `written` against `findings.length` — that is program
rule 4 for this job, and `rowsParsed > rowsKept` is normal (the incumbent's export carries every
profile the team can see).

**A `mismatch` headline is not a job failure.** The job's product is a verdict; recording
"mismatch" is a success. Fail the job only when it throws.

## Errors, and what each one means for a retry

| Thrown | Meaning | Retry? |
|---|---|---|
| `NoExportsFound` | nothing at `sourcePath` matching the naming contract | yes, with backoff — the pull may be late |
| `ExportContractError` | wrong profile, missing column, unreadable date | no — dead-letter it, a human must fix the export |
| `ProfileNotFound` | the payload's `profileId` is not in `ad_profiles` | no |
| `ResultWriteCountMismatch` | rows offered ≠ rows written | yes, then escalate; this should never happen |
| `CsvParseError` | truncated or ragged file | yes once (a partial upload), then dead-letter |

## Scheduling and enqueueing

The payload needs a `sourcePath`, so somebody has to notice the file. Two options, both fine:

- **Directory per profile-night (simplest).** A `sync_schedules` row per pilot profile with
  `job_type = 'crosscheck.ingest'`, daily, and a payload whose `sourcePath` is
  `<inbox>/<amazonProfileId>`. Late exports are picked up by the next night's run because
  ingestion is idempotent.
- **Watcher.** Call `scanInbox(dir, { amazonProfileId })` from `@wizard-ads/crosscheck-cli`; it
  returns the exports matching the naming contract, oldest window first, with the grain, profile
  and window already parsed. Enqueue one job per entry (or one per directory).

Suggested cadence: nightly, after the day's `report.fetch` jobs have landed. Comparing before our
own facts exist produces a truthful but useless `missing_ours`.

## Configuration

One value: the inbox root. It is a path (a mounted bucket works), it belongs in the worker's env
(`CROSSCHECK_INBOX_DIR` or whatever your config module calls it), and it must not be a tracked
default containing a home directory.

## Tests you do not need to write

`tools/crosscheck-cli/src/job.test.ts` covers the handler end to end against a migrated database:
both grains ingested, the corrupted fixture flagged on exactly one campaign, the provisional day
skipped, idempotency on re-run, and the wrong-profile refusal. Your integration test only needs to
prove the wiring — that a claimed `crosscheck.ingest` job reaches `runCrosscheckIngest` and that a
thrown error moves the job the way your retry policy says it should.
