/**
 * Migrations apply cleanly, and the schema they produce is the schema the rest
 * of the system assumes.
 *
 * The first assertion is the acceptance check ("`supabase db reset` applies all
 * migrations cleanly"): `createTestDatabase` runs the real files, in order,
 * against an empty database, and any error fails the suite. What follows are
 * the structural invariants that a passing migration could still violate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, migrationFiles } from './testing/harness.js';
import { tenantTables } from './testing/rls.js';
import type { TestDatabase } from './testing/harness.js';

const available = await databaseAvailable();

describe.skipIf(!available)('migrations', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('migrations');
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('applies every migration file in order', async () => {
    const files = await migrationFiles();
    expect(files.length).toBeGreaterThan(0);
    // Filenames sort chronologically; Supabase applies them in exactly this
    // order, so a file numbered out of sequence would apply out of sequence.
    expect([...files].sort()).toEqual(files);
    expect(files.at(-1)).toBe('20260830100000_optimization_weekday_schedule.sql');
  });

  it('keeps every shared feature job representable in the database queue', async () => {
    const labels = await database.sql<{ enumlabel: string }[]>`
      select e.enumlabel
        from pg_catalog.pg_enum e
        join pg_catalog.pg_type t on t.oid = e.enumtypid
       where t.typname = 'sync_job_type'
       order by e.enumsortorder
    `;
    expect(labels.slice(-5).map((row) => row.enumlabel)).toEqual([
      'creative.sync',
      'sqp.request',
      'history.bootstrap',
      'report.promote',
      'marketing_stream.normalize',
    ]);
  });

  it('adds the integration job labels without weakening the report schedule constraint', async () => {
    const labels = await database.sql<{ enumlabel: string }[]>`
      select e.enumlabel
        from pg_catalog.pg_enum e
        join pg_catalog.pg_type t on t.oid = e.enumtypid
       where t.typname = 'sync_job_type'
       order by e.enumsortorder
    `;
    const integrationLabels = new Set(['keepa.sync', 'rank.sync', 'economics.sync', 'sqp.categorize']);
    expect(labels.map((row) => row.enumlabel).filter((label) => integrationLabels.has(label))).toEqual([
      'keepa.sync',
      'rank.sync',
      'economics.sync',
      'sqp.categorize',
    ]);

    const [constraint] = await database.sql<{ definition: string }[]>`
      select pg_catalog.pg_get_constraintdef(oid) as definition
        from pg_catalog.pg_constraint
       where conname = 'sync_schedules_report_type_required'
    `;
    expect(constraint?.definition).toContain("job_type = 'report.request'::sync_job_type");
    expect(constraint?.definition).toContain('(report_type IS NOT NULL)');
  });

  it('adds sbAds only to the durable worker report ledger enum', async () => {
    const labels = await database.sql<{ enumlabel: string }[]>`
      select e.enumlabel
        from pg_catalog.pg_enum e
        join pg_catalog.pg_type t on t.oid = e.enumtypid
       where t.typname = 'report_type'
       order by e.enumsortorder
    `;
    expect(labels.map((row) => row.enumlabel).at(-1)).toBe('sbAds');
  });

  it('installs constrained weekday schedules and immutable run provenance', async () => {
    const columns = await database.sql<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable
        from information_schema.columns
       where table_schema = 'public'
         and table_name = 'optimization_groups'
         and column_name in (
           'review_weekdays', 'review_local_time',
           'schedule_migration_state', 'next_review_at'
         )
       order by column_name
    `;
    expect(columns).toEqual([
      { column_name: 'next_review_at', is_nullable: 'YES' },
      { column_name: 'review_local_time', is_nullable: 'NO' },
      { column_name: 'review_weekdays', is_nullable: 'NO' },
      { column_name: 'schedule_migration_state', is_nullable: 'NO' },
    ]);

    const constraints = await database.sql<{ conname: string }[]>`
      select conname from pg_catalog.pg_constraint
       where conname in (
         'optimization_groups_review_weekdays_canonical',
         'optimization_groups_needs_review_disabled',
         'recommendation_runs_manual_occurrence_check',
         'recommendation_runs_schedule_context_check',
         'recommendation_runs_scheduled_due_check'
       )
       order by conname
    `;
    expect(constraints.map((row) => row.conname)).toEqual([
      'optimization_groups_needs_review_disabled',
      'optimization_groups_review_weekdays_canonical',
      'recommendation_runs_manual_occurrence_check',
      'recommendation_runs_schedule_context_check',
      'recommendation_runs_scheduled_due_check',
    ]);

    const indexes = await database.sql<{ indexname: string }[]>`
      select indexname from pg_catalog.pg_indexes
       where schemaname = 'public'
         and indexname in (
           'optimization_groups_review_due_idx',
           'recommendation_runs_group_schedule_occurrence_key'
         )
       order by indexname
    `;
    expect(indexes.map((row) => row.indexname)).toEqual([
      'optimization_groups_review_due_idx',
      'recommendation_runs_group_schedule_occurrence_key',
    ]);

    const [guard] = await database.sql<{ count: number }[]>`
      select count(*)::int as count from pg_catalog.pg_trigger
       where tgname = 'recommendation_runs_schedule_evidence_guard'
         and not tgisinternal
    `;
    expect(guard?.count).toBe(1);
  });

  it('keeps one report-pending creative observation and complete report counts', async () => {
    const [pendingIndex] = await database.sql<{ indexdef: string }[]>`
      select indexdef
        from pg_catalog.pg_indexes
       where schemaname = 'public'
         and indexname = 'creative_sync_snapshots_one_report_pending_idx'
    `;
    expect(pendingIndex?.indexdef).toContain('UNIQUE INDEX');
    expect(pendingIndex?.indexdef).toContain("WHERE (status = 'report_pending'::text)");

    const [reportCounts] = await database.sql<{ definition: string }[]>`
      select pg_catalog.pg_get_constraintdef(oid) as definition
        from pg_catalog.pg_constraint
       where conname = 'creative_sync_snapshots_report_counts'
    `;
    const definition = reportCounts?.definition.toLowerCase() ?? '';
    expect(definition).toContain('report_source_rows is null');
    expect(definition).toContain('report_parsed_rows is null');
    expect(definition).toContain('report_refused_rows is null');
    expect(definition).toContain('report_source_rows is not null');
    expect(definition).toContain('report_parsed_rows is not null');
    expect(definition).toContain('report_refused_rows is not null');

    const accountingColumns = await database.sql<{
      column_name: string;
      is_generated: string;
    }[]>`
      select column_name, is_generated
        from information_schema.columns
       where table_schema = 'public'
         and table_name = 'report_requests'
         and column_name in (
           'source_rows', 'refused_rows', 'promoted_rows',
           'unpromoted_rows', 'accounting_complete'
         )
       order by column_name
    `;
    expect(accountingColumns).toEqual([
      { column_name: 'accounting_complete', is_generated: 'ALWAYS' },
      { column_name: 'promoted_rows', is_generated: 'NEVER' },
      { column_name: 'refused_rows', is_generated: 'NEVER' },
      { column_name: 'source_rows', is_generated: 'NEVER' },
      { column_name: 'unpromoted_rows', is_generated: 'NEVER' },
    ]);
  });

  it('creates every table the plan names', async () => {
    const rows = await database.sql<{ relname: string }[]>`
      select c.relname
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relispartition = false
    `;
    const tables = new Set(rows.map((row) => row.relname));

    for (const expected of [
      // tenancy
      'orgs', 'org_members', 'org_invitations', 'ads_connections', 'integration_connections',
      'ad_profiles', 'profile_strategy',
      // entity mirror
      'portfolios', 'campaigns', 'ad_groups', 'product_ads', 'keywords', 'targets',
      'negatives', 'entity_changes',
      // facts
      'fact_sp_target_daily', 'fact_search_term_daily', 'fact_placement_daily',
      'fact_sb_daily', 'fact_sd_daily', 'fact_profile_daily', 'fact_monthly_rollup',
      'product_economics',
      // sync
      'sync_schedules', 'sync_jobs', 'report_requests',
      // analysis
      'recommendation_runs', 'recommendations', 'insights', 'crosscheck_results',
      // writes
      'apply_batches', 'apply_rows', 'campaign_maps',
      // product surface
      'tags', 'entity_tags', 'dashboards', 'goto_links', 'audit_log',
      // reserved seams
      'spapi_connections', 'spapi_profile_bindings',
      'fact_sales_traffic_daily', 'fact_sqp_weekly', 'supa_flags',
      'rank_observations', 'keepa_bsr_observations', 'competitor_links',
      'competitor_price_events',
      'creative_assets', 'creative_placements',
      // operator-intelligence foundations
      'report_coverage', 'historical_bootstrap_progress',
      'report_promotion_watermarks', 'attribution_observations',
      'ad_creative_asset_mappings', 'fact_creative_daily',
      'creative_sync_snapshots',
      'sqp_promotion_runs', 'query_vocabulary', 'contextual_negative_proposals',
      'optimization_groups', 'campaign_optimization_assignments',
      'recommendation_observations', 'marketing_stream_events',
      'marketing_stream_hourly_facts', 'dayparting_schedule_proposals',
    ]) {
      expect(tables, `missing table ${expected}`).toContain(expected);
    }
  });

  it('keeps Keepa observation identity non-null and creates constrained event grain', async () => {
    const columns = await database.sql<{ column_name: string; is_nullable: string; column_default: string | null }[]>`
      select column_name, is_nullable, column_default
        from information_schema.columns
       where table_schema = 'public' and table_name = 'keepa_bsr_observations'
         and column_name in ('category', 'buy_box_price', 'lightning_deal', 'coupon')
       order by column_name
    `;
    expect(columns.map((row) => row.column_name)).toEqual([
      'buy_box_price', 'category', 'coupon', 'lightning_deal',
    ]);
    expect(columns.find((row) => row.column_name === 'category')).toMatchObject({
      is_nullable: 'NO',
      column_default: "''::text",
    });

    const indexes = await database.sql<{ indexdef: string }[]>`
      select indexdef from pg_catalog.pg_indexes
       where schemaname = 'public'
         and tablename in ('keepa_bsr_observations', 'competitor_price_events')
    `;
    const definitions = indexes.map((row) => row.indexdef).join('\n');
    expect(definitions).toContain('(org_id, asin, category, observed_at)');
    expect(definitions).toContain('(org_id, asin, event_kind, detected_at)');
  });

  it('enables row level security on every tenant table', async () => {
    const rows = await database.sql<{ relname: string; relrowsecurity: boolean }[]>`
      select c.relname, c.relrowsecurity
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and a.attnum > 0
      where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relispartition = false
    `;
    const unprotected = rows.filter((row) => !row.relrowsecurity).map((row) => row.relname);
    expect(unprotected).toEqual([]);
  });

  it('gives every tenant table a read policy and no grant to anon', async () => {
    const tables = await tenantTables(database);

    const policies = await database.sql<{ tablename: string; cmd: string }[]>`
      select tablename, cmd from pg_catalog.pg_policies where schemaname = 'public'
    `;
    const readable = new Set(
      policies.filter((row) => row.cmd === 'SELECT').map((row) => row.tablename),
    );
    expect([...tables].filter((table) => !readable.has(table))).toEqual([]);

    const anonGrants = await database.sql<{ table_name: string }[]>`
      select table_name
      from information_schema.role_table_grants
      where table_schema = 'public' and grantee = 'anon'
    `;
    expect(anonGrants.map((row) => row.table_name)).toEqual([]);
  });

  it('partitions every fact table by month, with no default partition', async () => {
    const rows = await database.sql<{ table_name: string; strategy: string }[]>`
      select c.relname as table_name, p.partstrat as strategy
      from pg_catalog.pg_partitioned_table p
      join pg_catalog.pg_class c on c.oid = p.partrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
    `;
    const partitioned = new Map(rows.map((row) => [row.table_name, row.strategy]));

    for (const table of [
      'fact_sp_target_daily',
      'fact_search_term_daily',
      'fact_placement_daily',
      'fact_sb_daily',
      'fact_sd_daily',
      'fact_profile_daily',
      'fact_sales_traffic_daily',
      'fact_sqp_weekly',
      'fact_creative_daily',
    ]) {
      // 'r' is RANGE. LIST or HASH here would mean the retention automation
      // cannot reason about a partition's month at all.
      expect(partitioned.get(table), `${table} is not range-partitioned`).toBe('r');
    }

    const defaults = await database.sql<{ relname: string }[]>`
      select c.relname
      from pg_catalog.pg_class c
      where c.relispartition
        and pg_catalog.pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'
    `;
    expect(defaults.map((row) => row.relname)).toEqual([]);
  });

  it('indexes every fact partition on date (BRIN) and (profile_id, date)', async () => {
    const rows = await database.sql<{ indexdef: string }[]>`
      select indexdef from pg_catalog.pg_indexes
      where schemaname = 'public' and tablename = 'fact_sp_target_daily'
    `;
    const definitions = rows.map((row) => row.indexdef).join('\n');
    expect(definitions).toMatch(/USING brin \(date\)/i);
    expect(definitions).toMatch(/\(profile_id, date\)/i);
  });

  it('registers the maintenance jobs with pg_cron when it is available', async () => {
    const present = await database.sql<{ available: boolean }[]>`
      select to_regprocedure('cron.schedule(text,text,text)') is not null as available
    `;
    if (!present[0]?.available) return;

    const jobs = await database.sql<{ jobname: string; schedule: string }[]>`
      select jobname, schedule from cron.job order by jobname
    `;
    const byName = new Map(jobs.map((row) => [row.jobname, row.schedule]));
    expect(byName.get('wizard-ads-enqueue-due-schedules')).toBe('*/5 * * * *');
    expect(byName.get('wizard-ads-ensure-partitions')).toBe('10 3 * * *');
    expect(byName.get('wizard-ads-fact-retention')).toBe('40 3 * * 0');
    expect(byName.get('wizard-ads-requeue-stale-jobs')).toBe('*/15 * * * *');
  });
});
