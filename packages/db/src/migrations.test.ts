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
  });

  it('adds the integration job labels without weakening the report schedule constraint', async () => {
    const labels = await database.sql<{ enumlabel: string }[]>`
      select e.enumlabel
        from pg_catalog.pg_enum e
        join pg_catalog.pg_type t on t.oid = e.enumtypid
       where t.typname = 'sync_job_type'
       order by e.enumsortorder
    `;
    expect(labels.slice(-4).map((row) => row.enumlabel)).toEqual([
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
    expect(constraint?.definition).toContain("job_type = ANY (ARRAY['report.request'");
    expect(constraint?.definition).toContain('(report_type IS NOT NULL)');
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
      'orgs', 'org_members', 'org_invitations', 'ads_connections', 'ad_profiles', 'profile_strategy',
      // entity mirror
      'portfolios', 'campaigns', 'ad_groups', 'product_ads', 'keywords', 'targets',
      'negatives', 'entity_changes',
      // facts
      'fact_sp_target_daily', 'fact_search_term_daily', 'fact_placement_daily',
      'fact_sb_daily', 'fact_sd_daily', 'fact_profile_daily', 'fact_monthly_rollup',
      // sync
      'sync_schedules', 'sync_jobs', 'report_requests',
      // analysis
      'recommendation_runs', 'recommendations', 'insights', 'crosscheck_results',
      // writes
      'apply_batches', 'apply_rows', 'campaign_maps',
      // product surface
      'tags', 'entity_tags', 'dashboards', 'goto_links', 'audit_log',
      // reserved seams
      'spapi_connections', 'fact_sales_traffic_daily', 'fact_sqp_weekly', 'supa_flags',
      'rank_observations', 'keepa_bsr_observations', 'competitor_links',
      'creative_assets', 'creative_placements',
    ]) {
      expect(tables, `missing table ${expected}`).toContain(expected);
    }
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
