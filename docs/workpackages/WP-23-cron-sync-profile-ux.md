# WP-23 — Vercel-Cron sync + profile selection & scheduling

**Owner:** Opus · **Phase:** v0→live · **Depends on:** WP-03/22 (merged) · Unlocks live daily data

See the approved plan (`~/.claude/plans/…`) for full context. Operator decisions locked:
per-account preferred sync hour in each account's own timezone; a manual timezone set in the tool
STICKS (Amazon re-sync never overwrites); bulk multi-select + keep the per-row On/Off dropdown.

## A. Cron drain (host the daily pull on Vercel — no Fly, no local machine)

- `vercel.json` (new, repo root or apps/web): one cron → `/api/cron/sync` every 5 minutes.
- `apps/web/app/api/cron/sync/route.ts` (new): reject unless the request bears `CRON_SECRET`
  (Vercel Cron sends it in the Authorization header). Use the service-role DB path
  (`apps/web/src/data/db.ts`). Per tick: `select enqueue_due_schedules()` then
  `select requeue_stale_sync_jobs()` (both idempotent, service-role RPCs), then loop the worker's
  existing `drainOnce()` (`apps/worker/src/worker.ts:93`, import `SyncWorker` +
  `PostgresWorkerStore` from `@wizard-ads/worker`) until it returns 0 OR a ~50s wall-budget, then
  `store.release()` + close the handle. Call `provisionSchedules()` once per tick (replaces the
  always-on ScheduleProvisioner). `log()` if the budget is hit with jobs still queued.
- Parameterize `drainOnce(maxJobs?, deadlineMs?)` if needed; keep the always-on `start()` intact
  for anyone who still runs the worker as a process.
- ads-api factory env: make `createAdsApiClientFromEnv` (`apps/worker/src/ads-api.ts`) accept
  `AMAZON_LWA_CLIENT_ID`/`AMAZON_LWA_CLIENT_SECRET` as fallbacks for `LWA_CLIENT_ID`/`SECRET`
  (Vercel already has the AMAZON_-prefixed ones).

## B. Per-account scheduling (the data buffer)

- Additive migration: `ad_profiles.preferred_sync_hour smallint` (nullable, 0–23) +
  `ad_profiles.timezone_locked boolean not null default false`. Mirror in
  `packages/db/src/schema/tenancy.ts`. Apply to hosted (flag for manager) — dev/local first.
- Make the OAuth upsert (`apps/web/app/api/amazon/oauth/_lib/connect.ts` `upsertProfiles`)
  conditional: on conflict, `timezone = case when ad_profiles.timezone_locked then
  ad_profiles.timezone else excluded.timezone end`.
- Anchor `next_run_at` to `preferred_sync_hour` in the profile timezone (default hour when unset)
  in `enqueue_due_schedules()` and/or the provisioner. Report window stays "trailing N days in
  profile timezone" (already done). Keep `variant` schedules working.

## C. Profile roster UX

- Sort: `apps/web/src/data/profiles.ts` `loadRoster` ORDER BY → lead with
  `coalesce(account_name, amazon_profile_id)`; same for the switcher `app/_lib/profiles.ts`
  `listProfiles`. Add a sort control (name/country/region), default name.
- Keep the existing search (`q`), make it prominent.
- Bulk multi-select: row checkboxes + a bulk enable/disable-sync action (new server action beside
  `toggleSync` in `settings/profiles/actions.ts`), role-gated. Keep per-row `SyncControl`.
- Editable timezone + preferred sync hour per profile (roster row or edit modal), new role-gated
  server action; setting timezone sets `timezone_locked=true`.

## D. Active-profile default (from the video)

- Default the dashboard/grid profile selector to the first sync-enabled profile (or a stored
  last-selected) instead of "All profiles"; consistent across pages.

## Acceptance

- `pnpm check` + all web e2e green; new tests: bulk action, sticky-timezone upsert (locked row not
  overwritten), hour-anchored next_run_at, cron-route auth (401 without secret).
- Provide operator run steps: set `CRON_SECRET` on Vercel, deploy, enable profiles via bulk UI, set
  tz+hour; a verification SQL that shows `fact_*` filling with `counts_match`.
- Branch `wp-23-cron-sync`. Postgres for tests: reuse 127.0.0.1:55435 if up, else start Homebrew
  postgresql@17; stop only what you start.
