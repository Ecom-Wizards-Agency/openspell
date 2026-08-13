# WP-03 — Sync worker, queue, scheduler (`apps/worker`)

**Owner:** Codex · **Phase:** v0 · **Depends on:** WP-00, WP-01 (tables), WP-02 (client; mock until ready) · **Blocks:** end-to-end v0 proof

## Goal

The always-on TypeScript worker (Fly.io) that executes all Amazon-facing jobs: entity sync and
the three-pass Reporting v3 pipeline, driven by `sync_jobs` with pg_cron enqueueing.

## Read first

- `docs/PLAN.md` — "Sync architecture" (your spec)
- `packages/db` claim/enqueue functions (WP-01), `packages/ads-api` surface (WP-02)
- `~/os/amazon-agent/tools/amazon-ads-monitor/datasource.py` docstring — the production advice
  this design encodes (request and fetch as separate scheduled passes; up to 3h latency)

## Spec

1. **Claim loop:** poll `claim_sync_jobs(worker_id, n)` (FOR UPDATE SKIP LOCKED, WP-01);
   concurrency capped per region host via token buckets (NA/EU/FE independent; start
   conservative: 2 concurrent report creates per region). Graceful shutdown: running jobs
   finish or are released back to `queued`.
2. **Job handlers** (payload types from shared):
   - `entity.sync` — list endpoints (+ Exports for bulk/name-join) → snapshot-diff against
     entity mirror → upsert + `entity_changes` rows (source `sync`). Count listed vs upserted.
   - `report.request` — create report (profile × type × date window), insert `report_requests`,
     enqueue `report.poll` with `not_before = now()+5min`.
   - `report.poll` — check status; PENDING → reschedule 5→10→20→30min (cap), give up at 4h →
     status error; COMPLETED → enqueue `report.fetch`.
   - `report.fetch` — stream-download, gunzip, parse (typed per ad product), COPY into staging,
     MERGE into fact partition (idempotent on grain key), set `rows_loaded`, assert
     parsed == loaded.
   - `recommendations.run` — call `packages/core` engine over facts + strategy, write
     `recommendation_runs`/`recommendations` (engine from WP-05; stub until it lands).
   - `crosscheck.ingest` — handler shell; logic lands in WP-10.
3. **Schedules:** `enqueue_due_schedules()` (WP-01 function) wired to pg_cron every 5 min
   (migration handed to WP-01 owner if not present). Default cadences: entity sync daily per
   enabled profile; reports daily for trailing 3 days; weekly re-pull trailing 35 days
   (restatement). Profile-local timezone determines "daily" boundary.
4. **Failure handling:** attempts++, exponential `not_before` backoff, `dead` after N attempts
   with `last_error`; a `/healthz` endpoint and an hourly `auth.healthcheck` job hitting
   `/v2/profiles` per region (log failure loudly — Slack alerting is wired later by operator).
5. **Deploy:** Dockerfile + `fly.toml` (single shared-cpu VM, auto-restart). Config via env:
   Supabase service URL/key; LWA creds fetched per connection via the Vault RPC.

## Acceptance checks

- Integration test with fake ads-api + local Postgres: full entity.sync and
  request→poll→fetch→facts cycle; facts idempotent on re-run (restatement simulation).
- Kill-and-resume: SIGKILL mid-job → job re-claimed and completed after restart; no double
  fact rows.
- parsed == loaded asserted in fetch handler tests (deliberate mismatch fixture fails).
- Two worker instances against 100 queued jobs: no double-claims, region caps respected.
- Branch `wp-03-worker`; report per acceptance check.
