import { CreativeAttributionState, Uuid } from '@wizard-ads/shared';
import type { DbHandle } from '../client.js';

const REQUIRED_COLUMNS = {
  ad_profiles: ['id', 'org_id', 'sync_enabled', 'timezone'],
  sync_jobs: ['org_id', 'profile_id', 'job_type', 'payload', 'run_after', 'dedupe_key', 'status'],
  creative_assets: [
    'id', 'org_id', 'profile_id', 'amazon_asset_id', 'kind', 'url', 'content_hash', 'name',
    'amazon_created_at', 'amazon_updated_at',
  ],
  ad_creative_asset_mappings: [
    'id', 'org_id', 'profile_id', 'source_mapping_key', 'ad_product', 'campaign_id',
    'ad_group_id', 'ad_id', 'creative_id', 'creative_version', 'creative_asset_id',
    'amazon_asset_id', 'placement', 'attribution_state', 'mapping_provenance',
    'creative_sync_snapshot_id', 'observed_at',
  ],
  fact_creative_daily: [
    'org_id', 'profile_id', 'date', 'ad_product', 'campaign_id', 'ad_group_id', 'ad_id',
    'creative_id', 'creative_version', 'amazon_asset_id', 'placement', 'attribution_state',
    'mapping_provenance', 'creative_sync_snapshot_id', 'impressions', 'clicks', 'cost',
    'purchases', 'sales', 'video_first_quartile_views', 'video_midpoint_views',
    'video_third_quartile_views', 'video_complete_views', 'loaded_at',
  ],
  creative_sync_snapshots: [
    'id', 'org_id', 'profile_id', 'start_date', 'end_date', 'observed_at',
    'mapping_provenance', 'historical_validity', 'status', 'pagination_complete',
    'fact_promotion_allowed', 'source_assets', 'parsed_assets', 'source_ads', 'parsed_ads',
    'mapped', 'legacy', 'unsupported', 'ambiguous', 'unmapped', 'report_source_rows',
    'report_parsed_rows', 'report_refused_rows', 'mapped_fact_rows', 'unpromoted_report_rows',
    'assets_upserted', 'mappings_upserted', 'facts_upserted', 'assets_read_back',
    'mappings_read_back', 'facts_read_back',
  ],
  report_requests: [
    'id', 'org_id', 'profile_id', 'report_type', 'status', 'creative_sync_snapshot_id',
    'source_rows', 'rows_parsed', 'refused_rows', 'promoted_rows', 'unpromoted_rows',
    'rows_loaded', 'accounting_complete',
  ],
} as const satisfies Record<string, readonly string[]>;

const REQUIRED_ENUMS = {
  creative_attribution_state: {
    values: CreativeAttributionState.options,
    allowAdditional: false,
  },
  sync_job_type: {
    values: ['creative.sync', 'report.request', 'report.poll', 'report.fetch'],
    allowAdditional: true,
  },
  ad_product: {
    values: ['SB'],
    allowAdditional: true,
  },
} as const;

export interface CreativePilotSchemaInventory {
  columns: ReadonlyArray<{ tableName: string; columnName: string }>;
  enumValues: ReadonlyArray<{ enumName: string; value: string }>;
}

export interface CreativePilotSchemaCheck {
  passed: boolean;
  requiredTables: number;
  verifiedTables: number;
  requiredColumns: number;
  verifiedColumns: number;
  requiredEnumValues: number;
  verifiedEnumValues: number;
  missingTables: string[];
  missingColumns: string[];
  enumMismatches: Array<{ enumName: string; missing: string[]; unexpected: string[] }>;
}

export interface CreativePilotDatabasePreflight {
  schema: CreativePilotSchemaCheck;
  cohort: {
    requestedProfiles: number;
    existingProfiles: number;
    syncEnabledProfiles: number;
  };
  pendingSnapshots: {
    cohort: number;
    total: number;
  };
  amazonApiCalls: 0;
  amazonWriteCalls: 0;
  migrationsApplied: 0;
}

interface RawCohortCounts {
  requested_profiles: string | number;
  existing_profiles: string | number;
  sync_enabled_profiles: string | number;
  cohort_pending_snapshots: string | number;
  total_pending_snapshots: string | number;
}

/** Read-only catalog and cohort evidence. This function never claims or inserts queue work. */
export async function inspectCreativePilotDatabase(
  handle: Pick<DbHandle, 'sql'>,
  profileIds: readonly string[],
): Promise<CreativePilotDatabasePreflight> {
  assertProfileCohort(profileIds);
  const tableNames = Object.keys(REQUIRED_COLUMNS);
  const enumNames = Object.keys(REQUIRED_ENUMS);
  const [columnRows, enumRows, countRows] = await Promise.all([
    handle.sql<Array<{ table_name: string; column_name: string }>>`
      select table_name, column_name
        from information_schema.columns
       where table_schema = 'public'
         and table_name = any(${tableNames}::text[])
       order by table_name, ordinal_position
    `,
    handle.sql<Array<{ enum_name: string; value: string }>>`
      select t.typname as enum_name, e.enumlabel as value
        from pg_catalog.pg_type t
        join pg_catalog.pg_namespace n on n.oid = t.typnamespace
        join pg_catalog.pg_enum e on e.enumtypid = t.oid
       where n.nspname = 'public'
         and t.typname = any(${enumNames}::text[])
       order by t.typname, e.enumsortorder
    `,
    handle.sql<RawCohortCounts[]>`
      with requested as materialized (
        select requested.profile_id
          from unnest(${[...profileIds]}::uuid[]) as requested(profile_id)
      ), matched as materialized (
        select p.id, p.sync_enabled
          from requested r
          join public.ad_profiles p on p.id = r.profile_id
      )
      select (select count(*) from requested) as requested_profiles,
             (select count(*) from matched) as existing_profiles,
             (select count(*) from matched where sync_enabled) as sync_enabled_profiles,
             (select count(*)
                from public.creative_sync_snapshots s
                join requested r on r.profile_id = s.profile_id
               where s.status = 'report_pending') as cohort_pending_snapshots,
             (select count(*)
                from public.creative_sync_snapshots
               where status = 'report_pending') as total_pending_snapshots
    `,
  ]);
  const counts = countRows[0];
  if (counts === undefined) throw new Error('Creative pilot preflight returned no count row');
  return {
    schema: evaluateCreativePilotSchemaInventory({
      columns: columnRows.map((row) => ({
        tableName: row.table_name,
        columnName: row.column_name,
      })),
      enumValues: enumRows.map((row) => ({ enumName: row.enum_name, value: row.value })),
    }),
    cohort: {
      requestedProfiles: Number(counts.requested_profiles),
      existingProfiles: Number(counts.existing_profiles),
      syncEnabledProfiles: Number(counts.sync_enabled_profiles),
    },
    pendingSnapshots: {
      cohort: Number(counts.cohort_pending_snapshots),
      total: Number(counts.total_pending_snapshots),
    },
    amazonApiCalls: 0,
    amazonWriteCalls: 0,
    migrationsApplied: 0,
  };
}

export function evaluateCreativePilotSchemaInventory(
  inventory: CreativePilotSchemaInventory,
): CreativePilotSchemaCheck {
  const actualColumns = new Map<string, Set<string>>();
  for (const row of inventory.columns) {
    const columns = actualColumns.get(row.tableName) ?? new Set<string>();
    columns.add(row.columnName);
    actualColumns.set(row.tableName, columns);
  }
  const actualEnums = new Map<string, Set<string>>();
  for (const row of inventory.enumValues) {
    const values = actualEnums.get(row.enumName) ?? new Set<string>();
    values.add(row.value);
    actualEnums.set(row.enumName, values);
  }

  const missingTables: string[] = [];
  const missingColumns: string[] = [];
  let verifiedColumns = 0;
  for (const [tableName, required] of Object.entries(REQUIRED_COLUMNS)) {
    const actual = actualColumns.get(tableName);
    if (actual === undefined) missingTables.push(tableName);
    for (const column of required) {
      if (actual?.has(column)) verifiedColumns += 1;
      else missingColumns.push(`${tableName}.${column}`);
    }
  }

  const enumMismatches: CreativePilotSchemaCheck['enumMismatches'] = [];
  let verifiedEnumValues = 0;
  for (const [enumName, requirement] of Object.entries(REQUIRED_ENUMS)) {
    const actual = actualEnums.get(enumName) ?? new Set<string>();
    const missing = requirement.values.filter((value) => !actual.has(value));
    verifiedEnumValues += requirement.values.length - missing.length;
    const expected = new Set<string>(requirement.values);
    const unexpected = requirement.allowAdditional
      ? []
      : [...actual].filter((value) => !expected.has(value)).sort();
    if (missing.length > 0 || unexpected.length > 0) {
      enumMismatches.push({ enumName, missing: [...missing], unexpected });
    }
  }

  const requiredColumns = Object.values(REQUIRED_COLUMNS)
    .reduce((total, columns) => total + columns.length, 0);
  const requiredEnumValues = Object.values(REQUIRED_ENUMS)
    .reduce((total, requirement) => total + requirement.values.length, 0);
  return {
    passed: missingTables.length === 0 && missingColumns.length === 0 && enumMismatches.length === 0,
    requiredTables: Object.keys(REQUIRED_COLUMNS).length,
    verifiedTables: Object.keys(REQUIRED_COLUMNS).length - missingTables.length,
    requiredColumns,
    verifiedColumns,
    requiredEnumValues,
    verifiedEnumValues,
    missingTables,
    missingColumns,
    enumMismatches,
  };
}

function assertProfileCohort(profileIds: readonly string[]): void {
  if (
    profileIds.length === 0 ||
    profileIds.some((profileId) => !Uuid.safeParse(profileId).success) ||
    new Set(profileIds.map((profileId) => profileId.toLowerCase())).size !== profileIds.length
  ) {
    throw new Error('Creative pilot preflight requires a non-empty unique UUID cohort');
  }
}
