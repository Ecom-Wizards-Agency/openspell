# WP-176 — Creative lifecycle copy

## Outcome

Replace the empty Creative Performance instruction with copy derived from the
automatic producer gate, the latest Creative queue job, and the latest counted
observation. Operators should see what OpenSpell is doing without being told to
run a command that does not exist in the product.

## Scope

- Read the latest `creative.sync` job for one exact organization and profile.
- Combine producer eligibility, job state, and snapshot state in one pure
  lifecycle resolver.
- Keep the previous observation timestamp and counts visible while a newer job
  is queued or running.
- Distinguish inactive, waiting, queued, mapping, report, unsupported, blocked,
  completed-empty, and performance-ready states.
- Keep raw queue failures, deployment values, and profile identifiers out of
  the rendered copy.

## Evidence order

The latest job and latest snapshot share one identity when they belong to the
same observation. A job with a different ID is a newer refresh because the job
query sorts by `created_at`, then ID. The resolver uses this order:

1. A newer queued or running job describes the refresh. Previous counted
   evidence remains visible.
2. A newer terminal job without its own snapshot is blocked. A successful job
   without a matching snapshot is also an integrity failure.
3. A matching blocked or report-pending snapshot describes its stored state.
4. A non-blocked snapshot where every parsed ad is unsupported is explicit.
   Mixed attribution states remain in the counted review total.
5. Completed snapshots distinguish zero attributable facts from promoted
   performance.
6. With no job or snapshot, the deployment gate and profile eligibility decide
   whether automatic sync is inactive or waiting for its first schedule.

## Safety claim

A refresh cannot erase the prior observation from the page. The resolver takes
the previous snapshot as the count and timestamp base before it applies a newer
job state. The lifecycle matrix test calls the shipped resolver with an older
completed snapshot plus newer queued and running jobs, and asserts that both
states retain the prior timestamp, coverage, and four count rows.

## Acceptance

- The pure lifecycle matrix covers every state and the newer-job/older-snapshot
  ordering case.
- A migrated disposable-Postgres test proves the job query selects the newest
  Creative job and refuses a mismatched organization/profile pair.
- The Creative read-only boundary still contains no Amazon client, POST request,
  server action, or mutation control.
- Focused database and web tests pass, followed by `pnpm check`,
  `git diff --check`, and hygiene against the staged files.

## Boundaries

- No shared contract or migration changes.
- No deployment flag, queue row, report, database, credential, or Amazon state
  changes.
- Deployment remains blocked until the already-tracked Creative migrations and
  report-worker ownership gates are proven on the intended hosted target.
