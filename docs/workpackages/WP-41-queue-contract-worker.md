# WP-41 — Queue contract extension + always-on worker deployment

**Status:** open · **Owner:** Codex (gpt-5.6-sol) · **Branch:** `wp-41-queue-contract`

## Why

WP-42 (Keepa), WP-43 (DataDive), WP-44 (MRP) and WP-46 (SQP categorize) each need a queue
job type. Minting them one at a time means four contract changes; this WP mints all four
at once, adds a job-type claim filter so integrations can run on the operator's 24/7 Linux
box while Amazon sync stays on the Vercel cron, and documents the always-on deployment.

**Contract-change authorization:** `packages/shared` is frozen per AGENTS.md; the manager
has signed off on exactly the addition described here (four new JobType members + payload
schemas). Nothing else in `packages/shared` may change.

## Scope

1. **Contract (`packages/shared/src/jobs.ts`)**: extend `JobType` with `'keepa.sync' |
   'rank.sync' | 'economics.sync' | 'sqp.categorize'`; add four Zod payload objects to the
   `JobPayload` discriminated union, all with the standard `jobBase` (orgId, profileId):
   - `KeepaSyncJob { type:'keepa.sync', asins?: string[], includeCompetitors: boolean }`
   - `RankSyncJob { type:'rank.sync', radarIds?: string[] }`
   - `EconomicsSyncJob { type:'economics.sync' }`
   - `SqpCategorizeJob { type:'sqp.categorize', weekStart: <the repo's ISO-date type> }`
   Round-trip tests beside the existing ones.
2. **DB enum migration** (own file, timestamp after 20260827130000, `alter type
   public.sync_job_type add value` ×4 — keep the ALTERs in their own migration per
   Postgres transaction rules; verify the constraint at `20260813120500_sync.sql`
   `(job_type in ('report.request')) = (report_type is not null)` still holds — it should,
   new types carry null report_type). Mirror in `packages/db/src/schema/enums.ts` (+
   `sync.ts` if it enumerates).
3. **Worker switch** (`apps/worker/src/worker.ts` — WP-33 just landed there; read the
   current shape first): inject an `IntegrationHandlers` port (`{ keepaSync?, rankSync?,
   economicsSync?, sqpCategorize? }`) via SyncWorker options (same pattern as
   `crosscheckIngest` and WP-33's runner). Four exhaustive cases delegate to it; a missing
   handler → `PermanentJobError` with a clear "handler not deployed in this runtime"
   message.
4. **Claim filter**: config `WORKER_JOB_TYPES` (comma list; absent = all) in
   `apps/worker/src/config.ts`, threaded into the claim path
   (`PostgresWorkerStore.claim`) as a job_type allowlist predicate; the cron drain
   (`apps/web/src/server/sync-tick.ts`) gets the complementary default (Amazon job types +
   recommendations.run only — enumerate explicitly). Tests for both filters.
5. **`ensureIntegrationSchedules` pass** (modeled on `repairOverlongLookbacks`,
   `apps/worker/src/store.ts:452`): idempotently upsert per-provider schedules ONLY where
   an active `integration_connections` row exists (table lands in WP-40 — if WP-40 is not
   merged when you start, code against the migration in
   `docs/workpackages/WP-40-integration-connections.md` and guard with a table-exists
   check OR coordinate via the drizzle schema if present; state what you did). Cadences:
   keepa/rank/economics '1 day', sqp.categorize '7 days'. Designated profile per
   marketplace: the org's first sync-enabled profile per marketplace, overridable via
   `integration_connections.config.profile_id`. Wire into both `main.ts` periodic passes
   and the cron tick (deadline-aware).
6. **Always-on deployment**: make ads-api wiring lazy in `apps/worker/src/main.ts` so an
   integration-only worker needs no ADS_* env; add `docs/deploy/always-on-worker.md`: a
   systemd unit template (`node apps/worker/dist/main.js` or pnpm equivalent), env file
   (DATABASE_URL service-role, WORKER_ID, WORKER_JOB_TYPES=keepa.sync,rank.sync,
   economics.sync,sqp.categorize), Restart=always, and the coexistence story (atomic
   claims make cron + always-on safe; the filter prevents Amazon-concurrency doubling).

## Constraints

- Program rules bind; the `packages/shared` edit is limited to the four job types above.
- Roadmap/feedback items: never `shipped`; keep `in_progress` pending Victor.
- Branch `wp-41-queue-contract`; commits `feat(wp-41): ...`; no push, no merge.
- Verify: `pnpm typecheck && pnpm lint && pnpm test` green; state which DB suites ran.
- Final message: contract diff summary, filter semantics, schedule-provisioning behavior,
  systemd runbook location, and the handler interface WP-42/43/44 implement.
