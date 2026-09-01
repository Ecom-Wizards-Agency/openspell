import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applySqlFile,
  createTestDatabase,
  databaseAvailable,
} from './testing/harness.js';
import type { TestDatabase } from './testing/harness.js';

const BEFORE = '20260901010000_authenticated_relation_privilege_hardening.sql';
const MIGRATION = fileURLToPath(
  new URL(
    '../../../supabase/migrations/20260901020000_sp_write_persistence_ledger.sql',
    import.meta.url,
  ),
);
const DDL_LOCK_KEY = 'wizard-ads:schema-ddl:v1';
const ORG_PURGE_GUARD_TRIGGER = 'orgs_block_unresolved_sp_write_purge';

const available = await databaseAvailable();
const migrationSource = await readFile(MIGRATION, 'utf8');
const expectedSpWriteTables = [
  ...migrationSource.matchAll(/^create table public\.(sp_write_[a-z0-9_]+)\s*\(/gm),
].map((match) => match[1] ?? '');

interface CatalogIdentity {
  relationIds: string[];
  typeIds: string[];
  functionIds: string[];
  triggerIds: string[];
}

interface CatalogSnapshot {
  relations: unknown[];
  columns: unknown[];
  constraints: unknown[];
  indexes: unknown[];
  triggers: unknown[];
  policies: unknown[];
  types: unknown[];
  enumLabels: unknown[];
  functions: unknown[];
  descriptions: unknown[];
  schemas: unknown[];
  defaultAcl: unknown[];
}

const catalogSnapshotKeys = [
  'relations',
  'columns',
  'constraints',
  'indexes',
  'triggers',
  'policies',
  'types',
  'enumLabels',
  'functions',
  'descriptions',
  'schemas',
  'defaultAcl',
] as const satisfies ReadonlyArray<keyof CatalogSnapshot>;

interface DataSnapshotRow {
  table_name: string;
  row_count: number;
  rows: string;
}

async function seedPopulatedLegacyState(database: TestDatabase): Promise<void> {
  await database.sql`
    insert into public.orgs (id, slug, name, created_at, updated_at)
    values (
      '18700000-0000-4000-8000-000000000001'::uuid,
      'wp187-upgrade',
      'WP 187 Upgrade',
      '2026-09-01T00:00:00Z'::timestamptz,
      '2026-09-01T00:00:00Z'::timestamptz
    )
  `;
  await database.sql`
    insert into public.ads_connections
      (id, org_id, label, status, created_at, updated_at)
    values (
      '18700000-0000-4000-8000-000000000002'::uuid,
      '18700000-0000-4000-8000-000000000001'::uuid,
      'synthetic-ads',
      'active',
      '2026-09-01T00:00:00Z'::timestamptz,
      '2026-09-01T00:00:00Z'::timestamptz
    )
  `;
  await database.sql`
    insert into public.ad_profiles
      (id, org_id, connection_id, amazon_profile_id, region, country_code,
       currency_code, timezone, sync_enabled, first_seen_at, created_at, updated_at)
    values (
      '18700000-0000-4000-8000-000000000003'::uuid,
      '18700000-0000-4000-8000-000000000001'::uuid,
      '18700000-0000-4000-8000-000000000002'::uuid,
      'synthetic-profile',
      'NA',
      'US',
      'USD',
      'UTC',
      false,
      '2026-09-01T00:00:00Z'::timestamptz,
      '2026-09-01T00:00:00Z'::timestamptz,
      '2026-09-01T00:00:00Z'::timestamptz
    )
  `;
  await database.sql`
    insert into public.sync_jobs
      (id, org_id, profile_id, job_type, payload, status, run_after,
       created_at, updated_at)
    values (
      '18700000-0000-4000-8000-000000000004'::uuid,
      '18700000-0000-4000-8000-000000000001'::uuid,
      '18700000-0000-4000-8000-000000000003'::uuid,
      'entity.sync',
      jsonb_build_object(
        'type', 'entity.sync',
        'orgId', '18700000-0000-4000-8000-000000000001',
        'profileId', '18700000-0000-4000-8000-000000000003'
      ),
      'queued',
      '2026-09-01T00:00:00Z'::timestamptz,
      '2026-09-01T00:00:00Z'::timestamptz,
      '2026-09-01T00:00:00Z'::timestamptz
    )
  `;
  await database.sql`
    insert into public.report_requests
      (id, org_id, profile_id, report_type, start_date, end_date, status,
       requested_at, completed_at, rows_parsed, rows_loaded, created_at, updated_at)
    values (
      '18700000-0000-4000-8000-000000000005'::uuid,
      '18700000-0000-4000-8000-000000000001'::uuid,
      '18700000-0000-4000-8000-000000000003'::uuid,
      'spCampaigns',
      '2026-08-31'::date,
      '2026-09-01'::date,
      'completed',
      '2026-09-01T00:00:00Z'::timestamptz,
      '2026-09-01T00:01:00Z'::timestamptz,
      7,
      7,
      '2026-09-01T00:00:00Z'::timestamptz,
      '2026-09-01T00:01:00Z'::timestamptz
    )
  `;
}

async function catalogIdentity(database: TestDatabase): Promise<CatalogIdentity> {
  const relations = await database.sql<{ oid: string }[]>`
    select class.oid::text as oid
      from pg_catalog.pg_class class
      join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
     where namespace.nspname = 'public'
     order by class.oid
  `;
  const types = await database.sql<{ oid: string }[]>`
    select type.oid::text as oid
      from pg_catalog.pg_type type
      join pg_catalog.pg_namespace namespace on namespace.oid = type.typnamespace
     where namespace.nspname = 'public'
     order by type.oid
  `;
  const functions = await database.sql<{ oid: string }[]>`
    select function.oid::text as oid
      from pg_catalog.pg_proc function
      join pg_catalog.pg_namespace namespace on namespace.oid = function.pronamespace
     where namespace.nspname in ('app', 'public')
     order by function.oid
  `;
  const triggers = await database.sql<{ oid: string }[]>`
    select trigger.oid::text as oid
      from pg_catalog.pg_trigger trigger
     where trigger.tgrelid::bigint = any(${relations.map((row) => row.oid)}::bigint[])
     order by trigger.oid
  `;

  return {
    relationIds: relations.map((row) => row.oid),
    typeIds: types.map((row) => row.oid),
    functionIds: functions.map((row) => row.oid),
    triggerIds: triggers.map((row) => row.oid),
  };
}

async function catalogSnapshot(
  database: TestDatabase,
  identity: CatalogIdentity,
): Promise<CatalogSnapshot> {
  const relations = await database.sql`
    select class.oid::text as oid, namespace.nspname, class.relname,
           class.relkind::text, class.relpersistence::text, owner.rolname as owner,
           class.relrowsecurity, class.relforcerowsecurity, class.relispartition,
           class.relreplident::text, class.reloptions, class.relacl::text
      from pg_catalog.pg_class class
      join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
      join pg_catalog.pg_roles owner on owner.oid = class.relowner
     where class.oid::bigint = any(${identity.relationIds}::bigint[])
     order by class.oid
  `;
  const columns = await database.sql`
    select attribute.attrelid::text as relation_oid, attribute.attnum,
           attribute.attname, attribute.atttypid::text as type_oid,
           attribute.atttypmod, attribute.attnotnull, attribute.atthasdef,
           attribute.attidentity::text, attribute.attgenerated::text,
           attribute.attisdropped, attribute.attcollation::text as collation_oid,
           attribute.attacl::text,
           pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid) as default_expression
      from pg_catalog.pg_attribute attribute
      left join pg_catalog.pg_attrdef default_value
        on default_value.adrelid = attribute.attrelid
       and default_value.adnum = attribute.attnum
     where attribute.attrelid::bigint = any(${identity.relationIds}::bigint[])
     order by attribute.attrelid, attribute.attnum
  `;
  const constraints = await database.sql`
    select constraint_row.oid::text as oid, constraint_row.conname,
           constraint_row.contype::text, constraint_row.conrelid::text as relation_oid,
           constraint_row.contypid::text as type_oid,
           constraint_row.confrelid::text as referenced_relation_oid,
           constraint_row.condeferrable, constraint_row.condeferred,
           constraint_row.convalidated,
           pg_catalog.pg_get_constraintdef(constraint_row.oid, true) as definition
      from pg_catalog.pg_constraint constraint_row
     where constraint_row.conrelid::bigint = any(${identity.relationIds}::bigint[])
        or constraint_row.contypid::bigint = any(${identity.typeIds}::bigint[])
     order by constraint_row.oid
  `;
  const indexes = await database.sql`
    select index_row.indexrelid::text as index_oid,
           index_row.indrelid::text as relation_oid,
           index_row.indisunique, index_row.indisprimary, index_row.indisexclusion,
           index_row.indimmediate, index_row.indisclustered, index_row.indisvalid,
           index_row.indisready, index_row.indislive, index_row.indisreplident,
           pg_catalog.pg_get_indexdef(index_row.indexrelid) as definition
      from pg_catalog.pg_index index_row
     where index_row.indrelid::bigint = any(${identity.relationIds}::bigint[])
     order by index_row.indexrelid
  `;
  const triggers = await database.sql`
    select trigger.oid::text as oid, trigger.tgrelid::text as relation_oid,
           trigger.tgname, trigger.tgenabled::text,
           pg_catalog.pg_get_triggerdef(trigger.oid, true) as definition
      from pg_catalog.pg_trigger trigger
     where trigger.tgrelid::bigint = any(${identity.relationIds}::bigint[])
       and trigger.tgname <> ${ORG_PURGE_GUARD_TRIGGER}
       and (
         trigger.oid::bigint = any(${identity.triggerIds}::bigint[])
         or not trigger.tgisinternal
       )
     order by trigger.oid
  `;
  const policies = await database.sql`
    select policy.oid::text as oid, policy.polrelid::text as relation_oid,
           policy.polname, policy.polcmd::text, policy.polpermissive,
           policy.polroles::text, pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) as using_expression,
           pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) as check_expression
      from pg_catalog.pg_policy policy
     where policy.polrelid::bigint = any(${identity.relationIds}::bigint[])
     order by policy.oid
  `;
  const types = await database.sql`
    select type.oid::text as oid, namespace.nspname, type.typname,
           type.typtype::text, type.typcategory::text, type.typnotnull,
           type.typbasetype::text as base_type_oid, type.typtypmod,
           type.typrelid::text as relation_oid, type.typcollation::text as collation_oid,
           type.typdefault, type.typacl::text
      from pg_catalog.pg_type type
      join pg_catalog.pg_namespace namespace on namespace.oid = type.typnamespace
     where type.oid::bigint = any(${identity.typeIds}::bigint[])
     order by type.oid
  `;
  const enumLabels = await database.sql`
    select enum.enumtypid::text as type_oid, enum.enumsortorder, enum.enumlabel
      from pg_catalog.pg_enum enum
     where enum.enumtypid::bigint = any(${identity.typeIds}::bigint[])
     order by enum.enumtypid, enum.enumsortorder
  `;
  const functions = await database.sql`
    select function.oid::text as oid, namespace.nspname, function.proname,
           pg_catalog.pg_get_function_identity_arguments(function.oid) as identity_arguments,
           function.prokind::text, function.prosecdef, function.proleakproof,
           function.provolatile::text, function.proparallel::text,
           function.proconfig, function.proacl::text,
           pg_catalog.pg_get_functiondef(function.oid) as definition
      from pg_catalog.pg_proc function
      join pg_catalog.pg_namespace namespace on namespace.oid = function.pronamespace
     where function.oid::bigint = any(${identity.functionIds}::bigint[])
     order by function.oid
  `;
  const descriptions = await database.sql`
    select description.classoid::text as class_oid,
           description.objoid::text as object_oid,
           description.objsubid, description.description
      from pg_catalog.pg_description description
     where description.objoid::bigint = any(
       ${[...identity.relationIds, ...identity.typeIds, ...identity.functionIds]}::bigint[]
     )
     order by description.classoid, description.objoid, description.objsubid
  `;
  const schemas = await database.sql`
    select namespace.oid::text as oid, namespace.nspname,
           owner.rolname as owner, namespace.nspacl::text
      from pg_catalog.pg_namespace namespace
      join pg_catalog.pg_roles owner on owner.oid = namespace.nspowner
     where namespace.nspname in ('app', 'public')
     order by namespace.nspname
  `;
  const defaultAcl = await database.sql`
    select defaults.oid::text as oid, defaults.defaclrole::text as role_oid,
           defaults.defaclnamespace::text as namespace_oid,
           defaults.defaclobjtype::text, defaults.defaclacl::text
      from pg_catalog.pg_default_acl defaults
     order by defaults.oid
  `;

  return {
    relations,
    columns,
    constraints,
    indexes,
    triggers,
    policies,
    types,
    enumLabels,
    functions,
    descriptions,
    schemas,
    defaultAcl,
  };
}

async function expectOrgPurgeGuardInstalled(database: TestDatabase): Promise<void> {
  const guard = await database.sql<{
    trigger_name: string;
    function_name: string;
    security_definer: boolean;
    definition: string;
    anon_execute: boolean;
    authenticated_execute: boolean;
    service_execute: boolean;
  }[]>`
    select trigger.tgname as trigger_name,
           function.proname as function_name,
           function.prosecdef as security_definer,
           pg_catalog.pg_get_triggerdef(trigger.oid, true) as definition,
           pg_catalog.has_function_privilege('anon', function.oid, 'EXECUTE') as anon_execute,
           pg_catalog.has_function_privilege(
             'authenticated', function.oid, 'EXECUTE'
           ) as authenticated_execute,
           pg_catalog.has_function_privilege(
             'service_role', function.oid, 'EXECUTE'
           ) as service_execute
      from pg_catalog.pg_trigger trigger
      join pg_catalog.pg_proc function on function.oid = trigger.tgfoid
     where trigger.tgrelid = 'public.orgs'::regclass
       and trigger.tgname = ${ORG_PURGE_GUARD_TRIGGER}
       and not trigger.tgisinternal
  `;
  expect(guard).toHaveLength(1);
  expect(guard[0]).toMatchObject({
    trigger_name: ORG_PURGE_GUARD_TRIGGER,
    function_name: 'guard_org_delete_against_unresolved_sp_write',
    security_definer: true,
    anon_execute: false,
    authenticated_execute: false,
    service_execute: false,
  });
  expect(guard[0]?.definition).toContain('BEFORE DELETE ON orgs');
}

async function dataSnapshot(database: TestDatabase): Promise<DataSnapshotRow[]> {
  const tables = await database.sql<{ table_name: string }[]>`
    select class.relname as table_name
      from pg_catalog.pg_class class
      join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
     where namespace.nspname = 'public'
       and class.relkind in ('r', 'p')
       and not class.relispartition
     order by class.relname
  `;
  const snapshot: DataSnapshotRow[] = [];

  for (const { table_name: tableName } of tables) {
    const [row] = await database.sql<{ row_count: number; rows: string }[]>`
      select count(*)::integer as row_count,
             coalesce(
               jsonb_agg(row_value order by row_value::text),
               '[]'::jsonb
             )::text as rows
        from (
          select to_jsonb(table_row) as row_value
            from ${database.sql(tableName)} table_row
        ) table_rows
    `;
    snapshot.push({
      table_name: tableName,
      row_count: row?.row_count ?? -1,
      rows: row?.rows ?? '',
    });
  }

  return snapshot;
}

async function legacyCounts(database: TestDatabase) {
  const [counts] = await database.sql<{
    tenant_count: number;
    profile_count: number;
    queue_count: number;
    evidence_count: number;
    parsed_count: string;
    loaded_count: string;
  }[]>`
    select
      (select count(*)::integer from public.orgs) as tenant_count,
      (select count(*)::integer from public.ad_profiles) as profile_count,
      (select count(*)::integer from public.sync_jobs) as queue_count,
      (select count(*)::integer from public.report_requests) as evidence_count,
      (select coalesce(sum(rows_parsed), 0)::text from public.report_requests) as parsed_count,
      (select coalesce(sum(rows_loaded), 0)::text from public.report_requests) as loaded_count
  `;
  return counts;
}

async function spWriteTableCounts(database: TestDatabase) {
  const installed = await database.sql<{ table_name: string }[]>`
    select class.relname as table_name
      from pg_catalog.pg_class class
      join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
     where namespace.nspname = 'public'
       and class.relkind in ('r', 'p')
       and not class.relispartition
       and class.relname like 'sp_write_%'
     order by class.relname
  `;
  const counts: Array<{ table_name: string; row_count: number }> = [];
  for (const { table_name: tableName } of installed) {
    const [row] = await database.sql<{ row_count: number }[]>`
      select count(*)::integer as row_count from ${database.sql(tableName)}
    `;
    counts.push({ table_name: tableName, row_count: row?.row_count ?? -1 });
  }
  return counts;
}

async function spWriteSurface(database: TestDatabase) {
  return database.sql<{ kind: string; name: string }[]>`
    select 'relation' as kind, class.relname as name
      from pg_catalog.pg_class class
      join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
     where namespace.nspname = 'public'
       and class.relname like 'sp_write_%'
    union all
    select 'type', type.typname
      from pg_catalog.pg_type type
      join pg_catalog.pg_namespace namespace on namespace.oid = type.typnamespace
     where namespace.nspname = 'public'
       and type.typname like 'sp_write_%'
    union all
    select 'function', function.proname
      from pg_catalog.pg_proc function
      join pg_catalog.pg_namespace namespace on namespace.oid = function.pronamespace
     where namespace.nspname = 'app'
       and function.proname like 'sp_write_%'
     order by kind, name
  `;
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function expectCatalogUnchanged(
  before: CatalogSnapshot,
  after: CatalogSnapshot,
): void {
  for (const key of catalogSnapshotKeys) {
    expect(after[key], `legacy catalog drift in ${key}`).toEqual(before[key]);
  }
}

describe.skipIf(!available)('SP write migration safety', () => {
  it('upgrades populated pre-WP-187 state without legacy schema or data drift', async () => {
    const database = await createTestDatabase('sp_write_populated_upgrade', {
      throughMigration: BEFORE,
      applyFixture: false,
    });
    try {
      await seedPopulatedLegacyState(database);
      const identity = await catalogIdentity(database);
      const beforeCatalog = await catalogSnapshot(database, identity);
      const beforeData = await dataSnapshot(database);
      const beforeCounts = await legacyCounts(database);

      expect(beforeCounts).toEqual({
        tenant_count: 1,
        profile_count: 1,
        queue_count: 1,
        evidence_count: 1,
        parsed_count: '7',
        loaded_count: '7',
      });

      await applySqlFile(database, MIGRATION);

      expectCatalogUnchanged(beforeCatalog, await catalogSnapshot(database, identity));
      await expectOrgPurgeGuardInstalled(database);
      expect(await dataSnapshot(database)).toEqual([
        ...beforeData,
        ...(await spWriteTableCounts(database)).map((row) => ({
          table_name: row.table_name,
          row_count: row.row_count,
          rows: '[]',
        })),
      ].sort((left, right) => left.table_name.localeCompare(right.table_name)));
      expect(await legacyCounts(database)).toEqual(beforeCounts);

      const tableCounts = await spWriteTableCounts(database);
      expect(new Set(expectedSpWriteTables).size).toBe(expectedSpWriteTables.length);
      expect(tableCounts.map((row) => row.table_name)).toEqual([...expectedSpWriteTables].sort());
      expect(tableCounts).toHaveLength(expectedSpWriteTables.length);
      expect(tableCounts.every((row) => row.row_count === 0)).toBe(true);

      const [accounting] = await database.sql<{ row_count: number }[]>`
        select count(*)::integer as row_count from public.sp_write_execution_accounting
      `;
      expect(accounting?.row_count).toBe(0);
    } finally {
      await database.drop();
    }
  }, 60_000);

  it('fails at five seconds under the shared DDL lock, rolls back, then replays', async () => {
    const database = await createTestDatabase('sp_write_ddl_contention', {
      throughMigration: BEFORE,
      applyFixture: false,
    });
    try {
      const identity = await catalogIdentity(database);
      const beforeCatalog = await catalogSnapshot(database, identity);
      const beforeData = await dataSnapshot(database);
      const acquired = deferred();
      const release = deferred();
      const holder = database.sql.begin(async (transaction) => {
        await transaction`
          select pg_advisory_xact_lock(
            pg_catalog.hashtextextended(${DDL_LOCK_KEY}, 0)
          )
        `;
        acquired.resolve();
        await release.promise;
      });

      await acquired.promise;
      const startedAt = performance.now();
      let migrationError: unknown;
      try {
        await applySqlFile(database, MIGRATION);
      } catch (error) {
        migrationError = error;
      } finally {
        release.resolve();
        await holder;
      }
      const elapsedMs = performance.now() - startedAt;

      expect(migrationError).toMatchObject({ code: '55P03' });
      expect(elapsedMs).toBeGreaterThanOrEqual(4_500);
      expect(elapsedMs).toBeLessThan(8_000);
      expect(await spWriteSurface(database)).toEqual([]);
      expectCatalogUnchanged(beforeCatalog, await catalogSnapshot(database, identity));
      expect(await dataSnapshot(database)).toEqual(beforeData);

      await applySqlFile(database, MIGRATION);

      const tableCounts = await spWriteTableCounts(database);
      expect(tableCounts.map((row) => row.table_name)).toEqual([...expectedSpWriteTables].sort());
      expect(tableCounts).toHaveLength(expectedSpWriteTables.length);
      expect(tableCounts.every((row) => row.row_count === 0)).toBe(true);
      expect((await spWriteSurface(database)).length).toBeGreaterThan(tableCounts.length);
      await expectOrgPurgeGuardInstalled(database);
    } finally {
      await database.drop();
    }
  }, 60_000);
});
