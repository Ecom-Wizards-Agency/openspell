# WP-01 — Database schema, RLS, partitions

**Owner:** Claude Opus · **Phase:** v0 · **Depends on:** WP-00 contracts · **Blocks:** WP-03/04/06/07/08/09/10

## Goal

The full Supabase Postgres schema: multi-tenant tables + RLS, entity mirror, partitioned fact
tables, sync machinery, analysis outputs, v1.x write tables (schema only), and reserved seams.

## Read first

- `docs/PLAN.md` — "Database schema outline" (your table-by-table spec)
- `packages/shared/src` — types your Drizzle schema must align with
- `~/os/amazon-agent/tools/amazon-ppc-management/batches.py` — apply_batches/apply_rows
  semantics (statuses, cooldown query, scoring fields)
- `~/os/amazon-agent/tools/sqp-supa/README.md` — shapes for the reserved SQP/SUPA seam tables

## Spec

1. SQL migrations in `supabase/migrations` (single source of truth); `packages/db` holds the
   Drizzle schema mirroring them + typed query helpers + RLS test utilities.
2. Tables exactly per PLAN.md outline: tenancy (`orgs`, `org_members`, `ads_connections`,
   `ad_profiles`, `profile_strategy`), entity mirror + `entity_changes`, facts
   (`fact_sp_target_daily`, `fact_search_term_daily`, `fact_placement_daily`, `fact_sb_daily`,
   `fact_sd_daily`, `fact_profile_daily`), sync (`sync_schedules`, `sync_jobs`,
   `report_requests`), analysis (`recommendation_runs`, `recommendations`, `insights`,
   `crosscheck_results`), writes-later (`apply_batches`, `apply_rows`, `campaign_maps`),
   product surface (`tags`, `entity_tags`, `dashboards`, `goto_links`, `audit_log`), reserved
   seams (`spapi_connections`, `fact_sales_traffic_daily`, `fact_sqp_weekly`, `supa_flags`,
   `rank_observations`, `keepa_bsr_observations`, `competitor_links`, `creative_assets`,
   `creative_placements`).
3. **Partitioning:** declarative monthly range partitions on `date` for every `fact_*` table;
   BRIN on date + btree (profile_id, date); a pg_cron-driven function that pre-creates next
   month's partitions and drops expired ones per retention (26 months daily, 13 for search
   terms; monthly rollup tables for what's dropped).
4. **RLS:** every tenant table keyed `org_id`; member-of-org read policies, role-gated writes
   (owner|admin|analyst|viewer). Service role bypasses (worker). Refresh tokens in Supabase
   Vault, accessed only via `security definer` RPCs (`store_ads_refresh_token`,
   `get_ads_refresh_token` — service role only).
5. **Queue primitives:** `claim_sync_jobs(worker_id, n)` SQL function using
   `FOR UPDATE SKIP LOCKED`; `dedupe_key` unique constraint; `enqueue_due_schedules()` function
   (pg_cron target — WP-03 defines cadence, you define the function).
6. **Strategy seed:** operator-run script `supabase/seed/import-strategy.ts` reading
   `_local/strategy.<org>.json` (gitignored) → `profile_strategy` rows. Commit only
   `strategy.TEMPLATE.json` (shape from `packages/strategy`).
7. Dev seed: one org, fake profiles, synthetic facts for UI development.

## Acceptance checks

- `supabase db reset` applies all migrations cleanly; Drizzle types compile against shared.
- RLS negative test: user in org A selects org B rows → 0 rows, across every tenant table.
- Partition automation test: inserting a fact for month M+1 works after the pre-create run;
  retention function drops only expired partitions.
- `claim_sync_jobs` under two concurrent claimers never double-claims (test with pg advisory
  of 100 queued jobs).
- Refresh-token RPCs callable only with service role (anon/auth caller rejected).
- Branch `wp-01-db`; report per acceptance check.
