# WP-210 — Creative Performance pilot activation

Owner: implementer. Operational steps may run autonomously under one scoped authorization.

Depends on: decision D3 in `docs/workpackages/REPLAN-2026-09-05.md`. Runbook preparation can
start immediately. Prefer activation after Claude completes WP-207; the interim pre-migration
pilot below is optional and must use the exact reviewed historical revision.

## Objective

Make `/creative` show real Sponsored Brands Video rows for one pilot profile by switching on the
producer that already exists in deployed web `44da7ac` and giving the queue a process that owns
the creative and report jobs. Finding F3 explains why this needs no new code.

## Plain-language summary for the operator

Today the Vercel website itself downloads all Amazon reports every five minutes. Creative
Performance needs an extra kind of job that the website cannot run. Switching it on means:

1. One always-on program runs on the Evo computer and takes over report downloads for every
   account, not just the pilot, because the switch is global. If that program stops, reports stop
   for everyone until the switch is turned back off. Turning it off is one Vercel setting.
2. That program needs two secrets injected into its runtime: the Amazon API application
   secret and the database connection string. Use the approved runtime credential mechanism and verify it before startup; no secret is
   copied into a repository or local `.env` file.
3. You name one client account that runs Sponsored Brands Video ads. Its identifier is looked up
   in the database and placed in a Vercel setting; it never enters Git.

## Owned files

- `docs/deploy/creative-pilot-pinned-worker.md` (new runbook);
- `docs/deploy/creative-pilot-reconcile.sql` (new, read-only count queries);
- `_local/creative-pilot.TEMPLATE.env` (variable names only, tracked);
- this brief.

## Read first

1. `apps/worker/src/deployment-role.ts` (lane flag, producer gate, job types).
2. `packages/db/src/queries/creative-sync-producer.ts` (dedupe key, `report_pending` deferral).
3. `apps/worker/src/sb-video-ingestion.ts` and `apps/worker/src/worker.ts` (creative.sync,
   sbAds fetch promotion, count reconciliation).
4. `apps/web/src/server/sync-tick.ts` (creativeSync counts in the tick response).
5. `docs/workpackages/WP-165-creative-pilot-gate.md` and `WP-160-creative-visibility.md`.

## Required behavior

1. Profile selection: the operator names the client. Run a read-only query to get the profile
   UUID, confirm `sync_enabled`, and confirm there is no `creative_sync_snapshots` row in status
   `report_pending` for it. Keep the UUID in `_local/` only.
2. Pinned worker: on the Evo host, use an immutable release pinned to `397eff8`, a reviewed
   worker revision before `ed7cb78`. Do not substitute `44da7ac`: its configuration/health
   interface differs. Resolve and record the full commit and artifact identity. Run
   `pnpm install --frozen-lockfile` and start `pnpm --filter @wizard-ads/worker start` with:
   `DATABASE_URL`, `LWA_CLIENT_ID`, `LWA_CLIENT_SECRET`,
   `WORKER_JOB_TYPES` set to the four types `creative.sync`, `report.request`, `report.poll`
   and `report.fetch` as one comma-separated value,
   `WORKER_DEPLOYMENT_ROLE=evo-report-lane`, `WORKER_CLAIM_BATCH_SIZE=1`,
   `WORKER_MAX_CONCURRENT_JOBS=1`, `WORKER_HEALTH_HOST=127.0.0.1`, an explicit unused `PORT`,
   `OPENSPELL_WORKER_REVISION` set to the resolved commit. At this pre-fencing revision the
   report role disables independent background passes while using legacy claims. The same role
   on current main selects fenced claims and is not a drop-in replacement. Stage a dedicated
   systemd release with injected credentials and a verified loopback health binding. Never run
   current main against the pre-WP-207 schema.
3. Verify the worker's health endpoint reports the four job types and that it claims nothing
   while no such jobs exist.
4. Vercel: set `OPENSPELL_EVO_REPORT_LANE_READY=1`, `OPENSPELL_CREATIVE_SYNC_PRODUCER_READY=1`,
   `OPENSPELL_CREATIVE_SYNC_PROFILE_ALLOWLIST=<uuid>` on the production environment and redeploy
   the existing `44da7ac` deployment with the new environment only. A malformed value returns
   503 from the cron route and throws on the Creative page, so test the values before redeploying.
5. First cycle: reconcile the cron response and durable rows for the profile-local date.
   A controlled first offer with no previous job should produce 1/1/1. If regular cron wins the
   race, a deduplicated or deferred-pending result is valid only when exactly one matching daily
   job and its snapshot are verified. Record enqueued, deduplicated and deferred counts; a
   successful HTTP response alone does not prove the cycle.
6. Watch `creative.sync`, then `report.request` for `sbAds`, then `report.poll` on its five-minute
   cadence, then `report.fetch`. Reconcile the logged counts with the queries in
   `creative-pilot-reconcile.sql`: source ads equal parsed ads; mapped plus legacy plus unsupported
   plus ambiguous plus unmapped equal parsed ads; assets and mappings upserted equal read back;
   source rows equal parsed plus refused; parsed equal promoted plus unpromoted; promoted equal
   canonical. `report_pending` is the intermediate snapshot state. Successful promotion must
   reach snapshot status `completed`; the UI derives lifecycle `complete` from the evidence.
   Account separately for refused, blocked, pending and terminal zero-row outcomes.
7. Open `/creative` for the pilot profile with a period that includes profile-local today.
   Expect lifecycle `complete` and rows joined by Amazon Asset ID. If mapped is above zero and
   promoted is zero, Amazon returned no same-day rows; that is a valid outcome, not a code fault.
8. Stop conditions: stop the pilot worker before the WP-207 window and restart it after
   postflight. Never call `activate_report_worker_fenced_claims()` while this worker runs; after
   activation the legacy claim overload excludes report jobs.
9. Keep the pinned report claimant until a replacement has its own reviewed startup policy.
   General role on main starts unrelated background passes; report role selects fenced claims.
   Neither is a safe automatic upgrade of this pilot. Any replacement must prove legacy queue
   compatibility, no duplicate timers, exact job ownership and rollback before deployment.
10. Phase 2, every profile: the operator wants Creative Performance on for all accounts. The
    allowlist parser accepts any number of comma-separated profile UUIDs with no cap
    (`apps/worker/src/deployment-role.ts`, `parseProfileAllowlist`). After the first profile has
    completed one counted observation and its counts reconcile, widen the Vercel allowlist to
    every `sync_enabled` profile in one redeploy. Each profile then costs one `creative.sync`,
    one `sbAds` report request and one fetch per local day; watch the worker for 429 responses
    during the first two days and shrink the list if throttling appears. Optional code slice for
    a later main deploy: accept the token `all-sync-enabled` in the parser so the list does not
    have to be maintained by hand.
11. Sponsored Display is out of scope here: the `creative.sync` job is `adProduct: 'SB'` only
    (`packages/shared/src/jobs.ts`) and no SD creatives client or SD ad-level report exists.
    WP-218 covers it.

## Authorization

After runbook verification, request one scoped activation authorization naming the private
profile, immutable worker artifact, credential injection, unit startup, Vercel variables and
redeploy, the read-only Amazon cycle and rollback. Covered steps can run without attendance or
repeated confirmation. Widening to every sync-enabled profile must be within the recorded scope
or receive its own authorization. No Amazon mutation is part of this package.

## Acceptance

1. Health endpoint reports the pinned revision, report role and exactly four types on loopback.
   This revision does not expose a protocol field; prove legacy custody from source and the
   counted claim cycle rather than inventing a health field.
2. Exactly one durable daily job exists for the pilot and the offer/deduplication/pending counts
   reconcile, including a concurrent cron offer.
3. Every count identity in step 6 holds and is recorded in the runbook with the values.
4. `/creative` shows lifecycle `complete` for the pilot profile with rows, or a recorded
   zero-row outcome with the reason.
5. Rollback disables the creative producer first, drains or explicitly resolves every creative-
   linked `sbAds` job and snapshot while the SB-capable worker remains available, then disables
   the lane flag and redeploys. Producer-on/lane-off is forbidden. Confirm generic report claims
   return to Vercel, reconcile outstanding creative work and only then stop the pilot. A worker
   failure that prevents draining is a stop condition needing a bounded recovery procedure;
   Vercel has no SB Video ingestion runtime to silently finish those jobs.

## Do not

- Use `docs/deploy/install-report-worker-evo-systemd.sh` for the pilot; it forces the fenced
  protocol whose functions are not hosted before WP-207.
- Touch the legacy integration worker unit; it owns different job types.
- Put the profile UUID, client name or secrets in any tracked file.
