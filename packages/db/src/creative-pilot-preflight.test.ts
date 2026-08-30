import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreativeAttributionState } from '@wizard-ads/shared';
import { createTestDatabase, databaseAvailable, type TestDatabase } from './testing/index.js';
import {
  evaluateCreativePilotSchemaInventory,
  inspectCreativePilotDatabase,
} from './queries/creative-pilot-preflight.js';

const available = await databaseAvailable();
const USER = '12121212-3434-4567-8899-aaaaaaaaaaaa';
const UNKNOWN_PROFILE = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

describe('Creative pilot schema inventory', () => {
  it('fails closed with exact missing catalog evidence', () => {
    const result = evaluateCreativePilotSchemaInventory({ columns: [], enumValues: [] });
    expect(result.passed).toBe(false);
    expect(result.verifiedTables).toBe(0);
    expect(result.verifiedColumns).toBe(0);
    expect(result.verifiedEnumValues).toBe(0);
    expect(result.missingTables).toContain('creative_sync_snapshots');
    expect(result.missingColumns).toContain('fact_creative_daily.amazon_asset_id');
    expect(result.enumMismatches.map((row) => row.enumName)).toEqual([
      'creative_attribution_state',
      'sync_job_type',
      'ad_product',
    ]);
  });

  it('rejects an unexpected authoritative Creative attribution state', () => {
    const result = evaluateCreativePilotSchemaInventory({
      columns: [],
      enumValues: [
        ...CreativeAttributionState.options.map((value) => ({
          enumName: 'creative_attribution_state',
          value,
        })),
        { enumName: 'creative_attribution_state', value: 'synthetic_extra_state' },
      ],
    });
    expect(result.enumMismatches.find(
      (row) => row.enumName === 'creative_attribution_state',
    )?.unexpected).toEqual(['synthetic_extra_state']);
  });
});

describe.skipIf(!available)('Creative pilot database preflight', () => {
  let database: TestDatabase;
  let orgId: string;
  let enabledProfileId: string;
  let disabledProfileId: string;

  beforeAll(async () => {
    database = await createTestDatabase('creative_pilot_preflight');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('creative-pilot-preflight', ${USER}, 'owner')
    `;
    orgId = org?.seed_tenant_fixture ?? '';
    const [enabled] = await database.sql<{ id: string }[]>`
      update public.ad_profiles
         set sync_enabled = true, timezone = 'UTC'
       where org_id = ${orgId}
      returning id
    `;
    enabledProfileId = enabled?.id ?? '';
    const [disabled] = await database.sql<{ id: string }[]>`
      insert into public.ad_profiles
        (org_id, amazon_profile_id, region, country_code, currency_code, timezone, sync_enabled)
      values
        (${orgId}, 'synthetic-disabled-preflight', 'NA', 'US', 'USD', 'UTC', false)
      returning id
    `;
    disabledProfileId = disabled?.id ?? '';
    await database.sql`
      insert into public.creative_sync_snapshots
        (id, org_id, profile_id, start_date, end_date, observed_at,
         mapping_provenance, historical_validity, status, pagination_complete,
         fact_promotion_allowed, source_assets, parsed_assets, source_ads, parsed_ads,
         mapped, legacy, unsupported, ambiguous, unmapped)
      values
        ('abababab-cdcd-4efe-8a8a-bcbcbcbcbcbc', ${orgId}, ${enabledProfileId},
         '2026-08-30', '2026-08-30', now(), 'current_sb_ad_snapshot',
         'unproven_current_snapshot', 'report_pending', true, true,
         0, 0, 0, 0, 0, 0, 0, 0, 0)
    `;
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('proves migrated schema and counted cohort state without writing a row', async () => {
    const before = await tableCounts(database);
    const result = await inspectCreativePilotDatabase(
      database,
      [enabledProfileId, disabledProfileId, UNKNOWN_PROFILE],
    );
    const after = await tableCounts(database);

    expect(result.schema).toMatchObject({ passed: true, verifiedTables: 7 });
    expect(result.schema.verifiedColumns).toBe(result.schema.requiredColumns);
    expect(result.schema.verifiedEnumValues).toBe(result.schema.requiredEnumValues);
    expect(result.cohort).toEqual({
      requestedProfiles: 3,
      existingProfiles: 2,
      syncEnabledProfiles: 1,
    });
    expect(result.pendingSnapshots).toEqual({ cohort: 1, total: 1 });
    expect(result).toMatchObject({
      amazonApiCalls: 0,
      amazonWriteCalls: 0,
      migrationsApplied: 0,
    });
    expect(after).toEqual(before);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(enabledProfileId);
    expect(serialized).not.toContain(disabledProfileId);
    expect(serialized).not.toContain(UNKNOWN_PROFILE);
  });

  it('refuses an unbounded or duplicate cohort before catalog access', async () => {
    await expect(inspectCreativePilotDatabase(database, [])).rejects.toThrow(/UUID cohort/);
    await expect(inspectCreativePilotDatabase(database, [enabledProfileId, enabledProfileId]))
      .rejects.toThrow(/UUID cohort/);
  });
});

async function tableCounts(database: TestDatabase): Promise<Record<string, number>> {
  const [row] = await database.sql<{
    jobs: string | number;
    snapshots: string | number;
    assets: string | number;
    mappings: string | number;
    facts: string | number;
  }[]>`
    select (select count(*) from public.sync_jobs) as jobs,
           (select count(*) from public.creative_sync_snapshots) as snapshots,
           (select count(*) from public.creative_assets) as assets,
           (select count(*) from public.ad_creative_asset_mappings) as mappings,
           (select count(*) from public.fact_creative_daily) as facts
  `;
  if (row === undefined) throw new Error('count query returned no row');
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
}
