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
import { asServiceRole, asUser, tenantTables } from './testing/rls.js';
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
    expect(files.at(-1)).toBe('20260901060000_recommendation_claim_custody.sql');
  });

  it('keeps every shared feature job representable in the database queue', async () => {
    const labels = await database.sql<{ enumlabel: string }[]>`
      select e.enumlabel
        from pg_catalog.pg_enum e
        join pg_catalog.pg_type t on t.oid = e.enumtypid
       where t.typname = 'sync_job_type'
       order by e.enumsortorder
    `;
    expect(labels.slice(-6).map((row) => row.enumlabel)).toEqual([
      'creative.sync',
      'sqp.request',
      'history.bootstrap',
      'report.promote',
      'marketing_stream.normalize',
      'report.unified.advance',
    ]);
  });

  it('installs canonical weekday scheduling and immutable run context', async () => {
    const columns = await database.sql<{
      table_name: string;
      column_name: string;
      is_nullable: string;
    }[]>`
      select table_name, column_name, is_nullable
        from information_schema.columns
       where table_schema = 'public'
         and (
           (table_name = 'optimization_groups' and column_name = 'review_weekdays')
           or (table_name = 'recommendation_runs' and column_name = 'schedule_context')
         )
       order by table_name, column_name
    `;
    expect(columns).toEqual([
      { table_name: 'optimization_groups', column_name: 'review_weekdays', is_nullable: 'NO' },
      { table_name: 'recommendation_runs', column_name: 'schedule_context', is_nullable: 'YES' },
    ]);

    const [functionRow] = await database.sql<{ volatility: string }[]>`
      select provolatile as volatility
        from pg_catalog.pg_proc
       where pronamespace = 'app'::regnamespace
         and proname = 'next_optimization_review_at'
    `;
    expect(functionRow?.volatility).toBe('i');

    const triggers = await database.sql<{ tgname: string }[]>`
      select tgname from pg_catalog.pg_trigger
       where not tgisinternal
         and tgname in (
           'optimization_groups_schedule',
           'ad_profiles_refresh_optimization_schedules'
         )
       order by tgname
    `;
    expect(triggers.map((row) => row.tgname)).toEqual([
      'ad_profiles_refresh_optimization_schedules',
      'optimization_groups_schedule',
    ]);
  });

  it('installs tenant-closed immutable recommendation preview scope evidence', async () => {
    const columns = await database.sql<{
      table_name: string;
      column_name: string;
      is_nullable: string;
    }[]>`
      select table_name, column_name, is_nullable
        from information_schema.columns
       where table_schema = 'public'
         and (
           (table_name = 'recommendation_preview_batches' and column_name in (
             'client_request_id', 'request_fingerprint', 'scope_count',
             'scope_fingerprint', 'child_count'
           ))
           or
           (table_name = 'recommendation_runs' and column_name in (
             'batch_id', 'scope_version', 'scope_count', 'scope_fingerprint',
             'strategy_goal', 'job_id'
           ))
           or
           (table_name = 'recommendation_run_campaigns' and column_name in (
             'org_id', 'profile_id', 'batch_id', 'run_id', 'campaign_id'
           ))
         )
       order by table_name, column_name
    `;
    expect(columns).toHaveLength(16);
    expect(columns).toContainEqual({
      table_name: 'recommendation_run_campaigns',
      column_name: 'campaign_id',
      is_nullable: 'NO',
    });
    expect(columns).toContainEqual({
      table_name: 'recommendation_runs',
      column_name: 'scope_version',
      is_nullable: 'YES',
    });

    const constraints = await database.sql<{ conname: string }[]>`
      select conname
        from pg_catalog.pg_constraint
       where conrelid in (
         'public.recommendation_preview_batches'::regclass,
         'public.recommendation_runs'::regclass,
         'public.recommendation_run_campaigns'::regclass
       )
    `;
    expect(constraints.map((row) => row.conname)).toEqual(expect.arrayContaining([
      'recommendation_preview_batches_client_request_key',
      'recommendation_runs_scope_shape_check',
      'recommendation_runs_job_fkey',
      'recommendation_run_campaigns_run_fkey',
      'recommendation_run_campaigns_batch_fkey',
      'recommendation_run_campaigns_parent_match_fkey',
    ]));

    const indexes = await database.sql<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef
        from pg_catalog.pg_indexes
       where schemaname = 'public'
         and indexname in (
           'recommendation_runs_batch_group_key',
           'recommendation_run_campaigns_batch_campaign_key'
         )
       order by indexname
    `;
    expect(indexes).toHaveLength(2);
    expect(indexes.find((row) => row.indexname === 'recommendation_runs_batch_group_key')?.indexdef)
      .toContain('NULLS NOT DISTINCT');
    expect(indexes.find((row) => row.indexname === 'recommendation_run_campaigns_batch_campaign_key')?.indexdef)
      .toContain('WHERE (batch_id IS NOT NULL)');

    const policies = await database.sql<{ tablename: string; cmd: string }[]>`
      select tablename, cmd from pg_catalog.pg_policies
       where schemaname = 'public'
         and tablename in ('recommendation_preview_batches', 'recommendation_run_campaigns')
       order by tablename, cmd
    `;
    expect(policies).toEqual([
      { tablename: 'recommendation_preview_batches', cmd: 'SELECT' },
      { tablename: 'recommendation_preview_batches', cmd: 'SELECT' },
      { tablename: 'recommendation_run_campaigns', cmd: 'SELECT' },
      { tablename: 'recommendation_run_campaigns', cmd: 'SELECT' },
    ]);
    const [privileges] = await database.sql<{
      batch_insert: boolean;
      scope_update: boolean;
      scope_delete: boolean;
    }[]>`
      select
        has_table_privilege('authenticated', 'public.recommendation_preview_batches', 'insert')
          as batch_insert,
        has_table_privilege('authenticated', 'public.recommendation_run_campaigns', 'update')
          as scope_update,
        has_table_privilege('authenticated', 'public.recommendation_run_campaigns', 'delete')
          as scope_delete
    `;
    expect(privileges).toEqual({ batch_insert: false, scope_update: false, scope_delete: false });
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

  it('keeps Unified sidecar lifecycle and one-input accounting closed', async () => {
    const [fixture] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture(
        'unified-migration',
        '81818181-8181-4818-8818-818181818181'::uuid,
        'owner'
      )
    `;
    const enums = await database.sql<{ typname: string; enumlabel: string }[]>`
      select t.typname, e.enumlabel
        from pg_catalog.pg_enum e
        join pg_catalog.pg_type t on t.oid = e.enumtypid
       where t.typname in (
         'unified_report_run_state', 'unified_report_operation_kind',
         'unified_report_operation_state', 'unified_report_operation_disposition'
       )
       order by t.typname, e.enumsortorder
    `;
    const byType = new Map<string, string[]>();
    for (const row of enums) byType.set(row.typname, [...(byType.get(row.typname) ?? []), row.enumlabel]);
    expect(byType.get('unified_report_operation_kind')).toEqual(['create', 'retrieve']);
    expect(byType.get('unified_report_operation_state')).toEqual(['ready', 'dispatching', 'settled']);
    expect(byType.get('unified_report_operation_disposition')).toEqual([
      'provider_success', 'provider_refused', 'create_ambiguous', 'transport_failure',
      'invalid_response', 'local_refusal', 'interrupted_dispatch',
    ]);
    expect(byType.get('unified_report_run_state')).toContain('create_ambiguous');
    expect(byType.get('unified_report_run_state')).toContain('provider_status_observed');

    const constraints = await database.sql<{ conname: string }[]>`
      select conname from pg_catalog.pg_constraint
       where conrelid in (
         'public.unified_report_runs'::regclass,
         'public.unified_report_operations'::regclass
       )
    `;
    const names = new Set(constraints.map((row) => row.conname));
    expect([...names]).toEqual(expect.arrayContaining([
      'unified_report_runs_counts_reconciled',
      'unified_report_runs_provider_id_state',
      'unified_report_runs_provider_identity_complete',
      'unified_report_operations_input_exactly_one',
      'unified_report_operations_state_accounting',
      'unified_report_operations_dispatch_fence',
      'unified_report_operations_disposition_kind',
    ]));

    const [operation] = await database.sql<{ id: string }[]>`
      select o.id
        from public.unified_report_operations o
        join public.unified_report_runs r on r.id = o.run_id
       where r.org_id = ${fixture?.seed_tenant_fixture ?? null}::uuid
       limit 1
    `;
    expect(operation?.id).toBeDefined();
    await expect(database.sql`
      update public.unified_report_operations
         set provider_success_count = 0
       where id = ${operation?.id ?? null}::uuid
    `).rejects.toThrow(/unified_report_operations_state_accounting/i);
  });

  it('lets the parent v3 ledger delete its sidecar without deleting the queue ledger', async () => {
    const [fixture] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture(
        'unified-v3-lifecycle',
        '82828282-8282-4828-8828-828282828282'::uuid,
        'owner'
      )
    `;
    const orgId = fixture?.seed_tenant_fixture ?? null;
    const [before] = await database.sql<{
      request_count: string;
      run_count: string;
      operation_count: string;
      unified_job_count: string;
    }[]>`
      select
        (select count(*) from public.report_requests where org_id = ${orgId}::uuid)::text
          as request_count,
        (select count(*) from public.unified_report_runs where org_id = ${orgId}::uuid)::text
          as run_count,
        (select count(*) from public.unified_report_operations where org_id = ${orgId}::uuid)::text
          as operation_count,
        (select count(*) from public.sync_jobs
          where org_id = ${orgId}::uuid and job_type = 'report.unified.advance')::text
          as unified_job_count
    `;
    expect(before).toEqual({
      request_count: '1',
      run_count: '1',
      operation_count: '1',
      unified_job_count: '1',
    });

    await database.sql`delete from public.report_requests where org_id = ${orgId}::uuid`;

    const [after] = await database.sql<{
      request_count: string;
      run_count: string;
      operation_count: string;
      unified_job_count: string;
    }[]>`
      select
        (select count(*) from public.report_requests where org_id = ${orgId}::uuid)::text
          as request_count,
        (select count(*) from public.unified_report_runs where org_id = ${orgId}::uuid)::text
          as run_count,
        (select count(*) from public.unified_report_operations where org_id = ${orgId}::uuid)::text
          as operation_count,
        (select count(*) from public.sync_jobs
          where org_id = ${orgId}::uuid and job_type = 'report.unified.advance')::text
          as unified_job_count
    `;
    expect(after).toEqual({
      request_count: '0',
      run_count: '0',
      operation_count: '0',
      unified_job_count: '1',
    });
  });

  it('enforces Unified parent scope without indexing the populated v3 and queue ledgers', async () => {
    const indexes = await database.sql<{ indexname: string }[]>`
      select indexname
        from pg_catalog.pg_indexes
       where schemaname = 'public'
         and indexname in (
           'sync_jobs_org_profile_id_key',
           'report_requests_org_profile_id_key'
         )
    `;
    expect(indexes).toEqual([]);

    const triggers = await database.sql<{ tgname: string }[]>`
      select tgname
        from pg_catalog.pg_trigger
       where not tgisinternal
         and tgname in (
           'unified_report_runs_v3_scope',
           'unified_report_operations_job_scope',
           'report_requests_unified_scope_guard',
           'sync_jobs_unified_scope_guard'
         )
       order by tgname
    `;
    expect(triggers.map((row) => row.tgname)).toEqual([
      'report_requests_unified_scope_guard',
      'sync_jobs_unified_scope_guard',
      'unified_report_operations_job_scope',
      'unified_report_runs_v3_scope',
    ]);

    const [left] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture(
        'unified-scope-left',
        '83838383-8383-4838-8838-838383838383'::uuid,
        'owner'
      )
    `;
    const [right] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture(
        'unified-scope-right',
        '84848484-8484-4848-8848-848484848484'::uuid,
        'owner'
      )
    `;
    const leftOrg = left?.seed_tenant_fixture ?? null;
    const rightOrg = right?.seed_tenant_fixture ?? null;
    const [leftRows] = await database.sql<{
      run_id: string;
      operation_id: string;
      request_id: string;
      job_id: string;
    }[]>`
      select r.id as run_id, o.id as operation_id,
             r.v3_report_request_id as request_id, o.dispatch_job_id as job_id
        from public.unified_report_runs r
        join public.unified_report_operations o on o.run_id = r.id
       where r.org_id = ${leftOrg}::uuid
    `;
    const [rightRows] = await database.sql<{
      request_id: string;
      job_id: string;
      profile_id: string;
    }[]>`
      select r.id as request_id, r.profile_id,
             (select o.dispatch_job_id from public.unified_report_operations o
               where o.org_id = r.org_id
               order by o.id limit 1) as job_id
        from public.report_requests r
       where r.org_id = ${rightOrg}::uuid
       limit 1
    `;

    await expect(database.sql`
      update public.unified_report_runs
         set v3_report_request_id = ${rightRows?.request_id ?? null}::uuid
       where id = ${leftRows?.run_id ?? null}::uuid
    `).rejects.toThrow(/tenant-scoped v3 request/i);
    await expect(database.sql`
      update public.unified_report_operations
         set dispatch_job_id = ${rightRows?.job_id ?? null}::uuid
       where id = ${leftRows?.operation_id ?? null}::uuid
    `).rejects.toThrow(/tenant-scoped queue job/i);
    await expect(database.sql`
      update public.report_requests
         set org_id = ${rightOrg}::uuid,
             profile_id = ${rightRows?.profile_id ?? null}::uuid
       where id = ${leftRows?.request_id ?? null}::uuid
    `).rejects.toThrow(/v3 request tenant scope is immutable/i);
    await expect(database.sql`
      update public.sync_jobs
         set org_id = ${rightOrg}::uuid,
             profile_id = ${rightRows?.profile_id ?? null}::uuid
       where id = ${leftRows?.job_id ?? null}::uuid
    `).rejects.toThrow(/queue job tenant scope is immutable/i);
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
      'unified_reporting_bindings', 'unified_report_runs', 'unified_report_operations',
      // analysis
      'recommendation_preview_batches', 'recommendation_runs', 'recommendation_run_campaigns',
      'recommendations', 'insights', 'crosscheck_results',
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
      'contextual_negative_exports',
      'optimization_groups', 'campaign_optimization_assignments',
      'recommendation_observations', 'marketing_stream_subscription_bindings',
      'marketing_stream_events', 'marketing_stream_projection_blocks',
      'marketing_stream_projection_block_scopes',
      'marketing_stream_hourly_facts', 'dayparting_schedule_proposals',
    ]) {
      expect(tables, `missing table ${expected}`).toContain(expected);
    }
  });

  it('installs the immutable one-row contextual-negative artifact contract', async () => {
    const columns = await database.sql<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }[]>`
      select column_name, data_type, is_nullable
        from information_schema.columns
       where table_schema = 'public'
         and table_name = 'contextual_negative_exports'
       order by ordinal_position
    `;
    expect(columns).toEqual([
      { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'org_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'profile_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'marketplace_id', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'note', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'row_count', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'json_artifact', data_type: 'bytea', is_nullable: 'NO' },
      { column_name: 'json_sha256', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'csv_artifact', data_type: 'bytea', is_nullable: 'NO' },
      { column_name: 'csv_sha256', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'created_by', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
    ]);

    const [scopeForeignKey] = await database.sql<{ definition: string }[]>`
      select pg_get_constraintdef(oid) as definition
        from pg_constraint
       where conname = 'contextual_negative_exports_profile_fkey'
    `;
    expect(scopeForeignKey?.definition).toContain(
      'FOREIGN KEY (org_id, profile_id) REFERENCES ad_profiles(org_id, id) ON DELETE CASCADE',
    );

    const policies = await database.sql<{ tablename: string; cmd: string }[]>`
      select tablename, cmd from pg_policies
       where schemaname = 'public'
         and tablename in ('contextual_negative_exports', 'contextual_negative_proposals')
       order by tablename, cmd
    `;
    expect(policies).toEqual([
      { tablename: 'contextual_negative_exports', cmd: 'SELECT' },
      { tablename: 'contextual_negative_proposals', cmd: 'SELECT' },
    ]);
    const [grants] = await database.sql<{
      proposal_insert: boolean;
      proposal_update: boolean;
      proposal_delete: boolean;
      artifact_insert: boolean;
      artifact_update: boolean;
      artifact_delete: boolean;
      artifact_truncate: boolean;
      audit_truncate: boolean;
    }[]>`
      select
        has_table_privilege('authenticated', 'public.contextual_negative_proposals', 'insert')
          as proposal_insert,
        has_table_privilege('authenticated', 'public.contextual_negative_proposals', 'update')
          as proposal_update,
        has_table_privilege('authenticated', 'public.contextual_negative_proposals', 'delete')
          as proposal_delete,
        has_table_privilege('authenticated', 'public.contextual_negative_exports', 'insert')
          as artifact_insert,
        has_table_privilege('authenticated', 'public.contextual_negative_exports', 'update')
          as artifact_update,
        has_table_privilege('authenticated', 'public.contextual_negative_exports', 'delete')
          as artifact_delete,
        has_table_privilege('service_role', 'public.contextual_negative_exports', 'truncate')
          as artifact_truncate,
        has_table_privilege('service_role', 'public.audit_log', 'truncate')
          as audit_truncate
    `;
    expect(grants).toEqual({
      proposal_insert: false,
      proposal_update: false,
      proposal_delete: false,
      artifact_insert: false,
      artifact_update: false,
      artifact_delete: false,
      artifact_truncate: false,
      audit_truncate: false,
    });

    const triggers = await database.sql<{ tgname: string }[]>`
      select tgname from pg_trigger
       where not tgisinternal
         and tgname in (
           'contextual_negative_exports_immutable',
           'contextual_negative_exports_no_truncate',
           'audit_log_contextual_negative_immutable',
           'audit_log_contextual_negative_no_truncate'
         )
       order by tgname
    `;
    expect(triggers.map((row) => row.tgname)).toEqual([
      'audit_log_contextual_negative_immutable',
      'audit_log_contextual_negative_no_truncate',
      'contextual_negative_exports_immutable',
      'contextual_negative_exports_no_truncate',
    ]);
  });

  it('guards evidence from service tampering and permits only a cascading organisation purge', async () => {
    const actor = '85858585-8585-4858-8858-858585858585';
    const [fixture] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('contextual-guard', ${actor}::uuid, 'owner')
    `;
    const orgId = fixture?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId}::uuid limit 1
    `;
    const profileId = profile?.id ?? '';
    const jsonArtifact = Buffer.from('{"fixture":true}\n', 'utf8');
    const csvArtifact = Buffer.from('fixture\n', 'utf8');
    await database.sql`
      insert into public.contextual_negative_exports
        (org_id, profile_id, marketplace_id, note, row_count,
         json_artifact, json_sha256, csv_artifact, csv_sha256, created_by)
      values (
        ${orgId}::uuid, ${profileId}::uuid, 'guard-marketplace', 'guard artifact', 1,
        ${jsonArtifact}, ${'218589323cbe80b7ed077e3ee36f1663e7cb5f8f4e4ad02c938ad8a5c2c5a6b9'},
        ${csvArtifact}, ${'e80b71cd14d3cbd65f4173abcbfcf01a545dbca32a72d575108b553a648cc96f'},
        ${actor}
      )
    `;
    const [artifact] = await database.sql<{ id: string }[]>`
      select id from public.contextual_negative_exports where org_id = ${orgId}::uuid
    `;
    const artifactId = artifact?.id ?? '';
    const [audit] = await database.sql<{ id: number }[]>`
      insert into public.audit_log
        (org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
      values (
        ${orgId}::uuid, 'user', ${actor}, 'query_negative.accepted',
        'contextual_negative_proposal', 'fixture', '{"before":{}}', 'test'
      )
      returning id
    `;

    await asServiceRole(database, async (sql) => {
      await sql`select set_config('app.contextual_negative_purge', 'on', false)`;
      await sql`select set_config('app.contextual_negative_purge_org_id', ${orgId}, false)`;
      await expect(sql`
        update public.contextual_negative_exports set note = 'changed' where id = ${artifactId}::uuid
      `).rejects.toThrow(/artifacts are immutable/i);
      await expect(sql`
        delete from public.contextual_negative_exports where id = ${artifactId}::uuid
      `).rejects.toThrow(/artifacts are immutable/i);
      await expect(sql`
        update public.audit_log set payload = '{}' where id = ${audit?.id ?? 0}
      `).rejects.toThrow(/audit evidence is immutable/i);
      await expect(sql`
        delete from public.audit_log where id = ${audit?.id ?? 0}
      `).rejects.toThrow(/audit evidence is immutable/i);
      await expect(sql`truncate public.contextual_negative_exports`).rejects.toThrow(/permission denied/i);
      await expect(sql`truncate public.audit_log`).rejects.toThrow(/permission denied/i);
      await expect(sql`truncate public.orgs cascade`).rejects.toThrow(/permission denied/i);
      await sql`select set_config('app.contextual_negative_purge', '', false)`;
      await sql`select set_config('app.contextual_negative_purge_org_id', '', false)`;
    });

    await expect(database.sql`truncate public.contextual_negative_exports`)
      .rejects.toThrow(/must not be truncated/i);
    await expect(database.sql`truncate public.audit_log`)
      .rejects.toThrow(/must not be truncated/i);
    await expect(database.sql`truncate public.orgs cascade`)
      .rejects.toThrow(/must not be truncated/i);

    const spTenantTables = await database.sql<{ table_name: string }[]>`
      select c.relname as table_name
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        join pg_catalog.pg_attribute a
          on a.attrelid = c.oid
         and a.attname = 'org_id'
         and not a.attisdropped
       where n.nspname = 'public'
         and c.relkind = 'r'
         and c.relname like 'sp_write_%'
       order by c.relname
    `;
    expect(spTenantTables).toHaveLength(23);
    for (const { table_name: tableName } of spTenantTables) {
      const [beforePurge] = await database.sql<{ count: number }[]>`
        select count(*)::int as count
          from ${database.sql(tableName)}
         where org_id = ${orgId}::uuid
      `;
      expect(beforePurge?.count, `${tableName} fixture coverage before org purge`)
        .toBeGreaterThan(0);
    }
    await expect(database.sql`
      delete from public.sp_write_late_result_audits where org_id = ${orgId}::uuid
    `).rejects.toThrow(/immutable/i);

    await database.sql`delete from public.orgs where id = ${orgId}::uuid`;
    const [remaining] = await database.sql<{ artifacts: number; audits: number }[]>`
      select
        (select count(*)::int from public.contextual_negative_exports where org_id = ${orgId}::uuid)
          as artifacts,
        (select count(*)::int from public.audit_log where org_id = ${orgId}::uuid)
          as audits
    `;
    expect(remaining).toEqual({ artifacts: 0, audits: 0 });
    for (const { table_name: tableName } of spTenantTables) {
      const [afterPurge] = await database.sql<{ count: number }[]>`
        select count(*)::int as count
          from ${database.sql(tableName)}
         where org_id = ${orgId}::uuid
      `;
      expect(afterPurge?.count, `${tableName} survived org purge`).toBe(0);
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

  it('matches every authenticated relation privilege to an applicable RLS policy', async () => {
    const mismatches = await database.sql<{
      mismatch: string;
      table_name: string;
      privilege: string;
    }[]>`
      with protected_relations as (
        select class.oid, class.relname, class.relowner
          from pg_catalog.pg_class class
          join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
         where namespace.nspname = 'public'
           and class.relkind in ('r', 'p')
           and class.relrowsecurity
      ),
      expected as (
        select distinct
               policy.tablename as table_name,
               privilege.value as privilege
          from pg_catalog.pg_policies policy
          cross join lateral unnest(
            case policy.cmd
              when 'ALL' then array['SELECT', 'INSERT', 'UPDATE', 'DELETE']::text[]
              else array[policy.cmd]::text[]
            end
          ) privilege(value)
         where policy.schemaname = 'public'
           and policy.roles && array['authenticated', 'public']::name[]
      ),
      actual as (
        select distinct
               relation.relname as table_name,
               upper(privilege.privilege_type) as privilege
          from protected_relations relation
          join pg_catalog.pg_class relation_acl on relation_acl.oid = relation.oid
          cross join lateral pg_catalog.aclexplode(
            coalesce(relation_acl.relacl, pg_catalog.acldefault('r', relation.relowner))
          ) privilege
         where privilege.grantee in (
           0::oid,
           (select oid from pg_catalog.pg_roles where rolname = 'authenticated')
         )
        union all
        select 'sync_jobs'::name as table_name, 'SELECT'::text as privilege
         where (
           select bool_and(
             case
               when attribute.attname = 'claim_token' then
                 not has_column_privilege(
                   'authenticated', 'public.sync_jobs', attribute.attname, 'SELECT'
                 )
               else
                 has_column_privilege(
                   'authenticated', 'public.sync_jobs', attribute.attname, 'SELECT'
                 )
             end
           )
             from pg_catalog.pg_attribute attribute
            where attribute.attrelid = 'public.sync_jobs'::regclass
              and attribute.attnum > 0
              and not attribute.attisdropped
         )
      ),
      missing as (
        select table_name, privilege from expected
        except
        select table_name, privilege from actual
      ),
      unexpected as (
        select table_name, privilege from actual
        except
        select table_name, privilege from expected
      )
      select 'missing' as mismatch, table_name, privilege from missing
      union all
      select 'unexpected' as mismatch, table_name, privilege from unexpected
      order by table_name, privilege, mismatch
    `;

    expect(mismatches).toEqual([]);
  });

  it('keeps API-role sequences and repository creator defaults at the exact minimum', async () => {
    const sequencePrivileges = await database.sql<{
      sequence_name: string;
      grantee: string;
      privilege: string;
    }[]>`
      select sequence.relname as sequence_name,
             case privilege.grantee
               when 0 then 'public'
               else grantee.rolname
             end as grantee,
             upper(privilege.privilege_type) as privilege
        from pg_catalog.pg_class sequence
        join pg_catalog.pg_namespace namespace on namespace.oid = sequence.relnamespace
        cross join lateral pg_catalog.aclexplode(
          coalesce(sequence.relacl, pg_catalog.acldefault('S', sequence.relowner))
        ) privilege
        left join pg_catalog.pg_roles grantee on grantee.oid = privilege.grantee
       where namespace.nspname = 'public'
         and sequence.relkind = 'S'
         and (
           privilege.grantee = 0
           or grantee.rolname in ('anon', 'authenticated')
         )
       order by sequence.relname, grantee, privilege
    `;
    expect(sequencePrivileges).toEqual([
      {
        sequence_name: 'experiment_events_id_seq',
        grantee: 'authenticated',
        privilege: 'USAGE',
      },
    ]);

    const defaultPrivileges = await database.sql<{
      creator: string;
      grantor: string;
      scope: string;
      object_type: string;
      grantee: string;
      privilege: string;
      grantable: boolean;
    }[]>`
      select creator.rolname as creator,
             grantor.rolname as grantor,
             case defaults.defaclnamespace
               when 0 then 'global'
               else namespace.nspname
             end as scope,
             defaults.defaclobjtype as object_type,
             case privilege.grantee
               when 0 then 'public'
               else grantee.rolname
             end as grantee,
             upper(privilege.privilege_type) as privilege,
             privilege.is_grantable as grantable
        from pg_catalog.pg_default_acl defaults
        cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
        join pg_catalog.pg_roles creator on creator.oid = defaults.defaclrole
        join pg_catalog.pg_roles grantor on grantor.oid = privilege.grantor
        left join pg_catalog.pg_namespace namespace on namespace.oid = defaults.defaclnamespace
        left join pg_catalog.pg_roles grantee on grantee.oid = privilege.grantee
       where defaults.defaclnamespace in (0::oid, 'public'::regnamespace::oid)
         and defaults.defaclobjtype in ('r', 'S')
         and (
           privilege.grantee = 0
           or grantee.rolname in ('anon', 'authenticated')
         )
       order by creator,
                case defaults.defaclobjtype when 'S' then 0 else 1 end,
                grantee, privilege, grantor, scope, grantable
    `;
    const [server] = await database.sql<{ version: number }[]>`
      select current_setting('server_version_num')::integer as version
    `;
    const tablePrivileges = [
      'DELETE',
      'INSERT',
      ...((server?.version ?? 0) >= 170000 ? ['MAINTAIN'] : []),
      'REFERENCES',
      'SELECT',
      'TRIGGER',
      'TRUNCATE',
      'UPDATE',
    ];
    const expectedDefaults = [
      ...['anon', 'authenticated'].flatMap((grantee) =>
        ['SELECT', 'UPDATE', 'USAGE'].map((privilege) => ({
          creator: 'supabase_admin',
          grantor: 'supabase_admin',
          scope: 'public',
          object_type: 'S',
          grantee,
          privilege,
          grantable: false,
        })),
      ),
      ...['anon', 'authenticated'].flatMap((grantee) =>
        tablePrivileges.map((privilege) => ({
          creator: 'supabase_admin',
          grantor: 'supabase_admin',
          scope: 'public',
          object_type: 'r',
          grantee,
          privilege,
          grantable: false,
        })),
      ),
    ];
    expect(defaultPrivileges).toEqual(expectedDefaults);

    await asUser(database, '18618618-6186-4186-8186-186186186186', async (sql) => {
      const [advanced] = await sql<{ value: string }[]>`
        select nextval('public.experiment_events_id_seq')::text as value
      `;
      const [sessionValue] = await sql<{ value: string }[]>`
        select currval('public.experiment_events_id_seq')::text as value
      `;
      expect(sessionValue?.value).toBe(advanced?.value);
      await expect(
        sql`select setval('public.experiment_events_id_seq', 1, false)`,
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        sql`select last_value from public.experiment_events_id_seq`,
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('closes repository-created relations while preserving the platform creator baseline', async () => {
    const relationPrivileges = async (tableName: string) =>
      database.sql<{ grantee: string; privilege: string }[]>`
        select grantee.rolname as grantee,
               upper(privilege.privilege_type) as privilege
          from pg_catalog.pg_class relation
          cross join lateral pg_catalog.aclexplode(
            coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
          ) privilege
          join pg_catalog.pg_roles grantee on grantee.oid = privilege.grantee
         where relation.oid = ${`public.${tableName}`}::regclass
           and grantee.rolname in ('anon', 'authenticated')
         order by grantee, privilege
      `;

    try {
      await database.sql`
        create table public.wp186_default_probe (
          id bigint generated always as identity primary key,
          org_id uuid not null
        )
      `;
      expect(await relationPrivileges('wp186_default_probe')).toEqual([]);
      const defaultSequencePrivileges = await database.sql<{ privilege: string }[]>`
        select upper(privilege.privilege_type) as privilege
          from pg_catalog.pg_class sequence
          cross join lateral pg_catalog.aclexplode(
            coalesce(sequence.relacl, pg_catalog.acldefault('S', sequence.relowner))
          ) privilege
          join pg_catalog.pg_roles grantee on grantee.oid = privilege.grantee
         where sequence.oid = 'public.wp186_default_probe_id_seq'::regclass
           and grantee.rolname in ('anon', 'authenticated')
      `;
      expect(defaultSequencePrivileges).toEqual([]);

      await database.sql.begin(async (sql) => {
        await sql`set local role supabase_admin`;
        await sql`
          create table public.wp186_platform_default_probe (
            id bigint generated always as identity primary key
          )
        `;
      });
      const [platformAuthority] = await database.sql<{
        table_truncate: boolean;
        sequence_update: boolean;
      }[]>`
        select
          has_table_privilege(
            'authenticated', 'public.wp186_platform_default_probe', 'truncate'
          ) as table_truncate,
          has_sequence_privilege(
            'authenticated', 'public.wp186_platform_default_probe_id_seq', 'update'
          ) as sequence_update
      `;
      expect(platformAuthority).toEqual({ table_truncate: true, sequence_update: true });

      await database.sql`create table public.wp186_read_probe (org_id uuid not null)`;
      await database.sql`create table public.wp186_write_probe (org_id uuid not null)`;
      await database.sql`
        grant all on table public.wp186_read_probe, public.wp186_write_probe
        to anon, authenticated
      `;
      await database.sql`select app.install_tenant_rls('public.wp186_read_probe')`;
      await database.sql`
        select app.install_tenant_rls(
          'public.wp186_write_probe', array['owner', 'admin']
        )
      `;

      expect(await relationPrivileges('wp186_read_probe')).toEqual([
        { grantee: 'authenticated', privilege: 'SELECT' },
      ]);
      expect(await relationPrivileges('wp186_write_probe')).toEqual([
        { grantee: 'authenticated', privilege: 'DELETE' },
        { grantee: 'authenticated', privilege: 'INSERT' },
        { grantee: 'authenticated', privilege: 'SELECT' },
        { grantee: 'authenticated', privilege: 'UPDATE' },
      ]);

      const [helperGrants] = await database.sql<{
        anon: boolean;
        authenticated: boolean;
        service_role: boolean;
      }[]>`
        select
          has_function_privilege(
            'anon', 'app.install_tenant_rls(regclass,text[])', 'execute'
          ) as anon,
          has_function_privilege(
            'authenticated', 'app.install_tenant_rls(regclass,text[])', 'execute'
          ) as authenticated,
          has_function_privilege(
            'service_role', 'app.install_tenant_rls(regclass,text[])', 'execute'
          ) as service_role
      `;
      expect(helperGrants).toEqual({
        anon: false,
        authenticated: false,
        service_role: true,
      });
    } finally {
      await database.sql`drop table if exists public.wp186_read_probe`;
      await database.sql`drop table if exists public.wp186_write_probe`;
      await database.sql`drop table if exists public.wp186_default_probe`;
      await database.sql`drop table if exists public.wp186_platform_default_probe`;
    }
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
