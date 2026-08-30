import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AdCreativeAssetMapping,
  CreativeAsset,
  CreativeDailyFact,
  CreativeSyncSnapshot,
} from '@wizard-ads/shared';
import type { DbHandle } from '../client.js';
import { createTestDatabase, databaseAvailable } from '../testing/harness.js';
import type { TestDatabase } from '../testing/harness.js';
import {
  CreativePersistenceError,
  persistCreativePerformanceBatch,
  readLatestCreativeSyncSnapshot,
  readCreativePerformance,
  type CreativeMappingWrite,
  type CreativePerformanceWriteBatch,
} from './creative-performance.js';

const available = await databaseAvailable();
const OWNER = '60606060-6060-4060-8060-606060606060';

describe('creative persistence validation without a database', () => {
  const unusable = {
    get db(): never {
      throw new Error('validation touched the database');
    },
  } as unknown as DbHandle;

  it('rejects duplicate fact grains before opening a transaction', async () => {
    const batch = syntheticBatch('61616161-6161-4161-8161-616161616161', '62626262-6262-4262-8262-626262626262');
    batch.facts = [batch.facts[0]!, batch.facts[0]!];
    await expect(persistCreativePerformanceBatch(unusable, batch))
      .rejects.toBeInstanceOf(CreativePersistenceError);
  });

  it('rejects non-mapped facts that carry an Asset ID', async () => {
    const batch = syntheticBatch('61616161-6161-4161-8161-616161616161', '62626262-6262-4262-8262-626262626262');
    batch.facts = [{ ...batch.facts[0]!, attributionState: 'ambiguous' }];
    await expect(persistCreativePerformanceBatch(unusable, batch))
      .rejects.toThrow(/must not disguise ambiguous attribution/);
  });
});

describe.skipIf(!available)('WP-58 creative performance database', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;

  beforeAll(async () => {
    database = await createTestDatabase('wp58_creative');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('creative-alpha', ${OWNER}, 'owner', '2026-08-29')
    `;
    orgId = org?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId} limit 1
    `;
    profileId = profile?.id ?? '';
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('upserts and reads back every asset, mapping and ad-level fact', async () => {
    const batch = syntheticBatch(orgId, profileId);
    const counts = await persistCreativePerformanceBatch(database, batch);
    expect(counts).toEqual({
      assetsUpserted: 2,
      mappingsUpserted: 3,
      factsUpserted: 3,
      totalUpserts: 8,
      assetsReadBack: 2,
      mappingsReadBack: 3,
      factsReadBack: 3,
      snapshotsUpserted: 0,
      snapshotsReadBack: 0,
    });

    const rows = await readCreativePerformance(database, {
      orgId,
      profileId,
      from: '2026-08-28',
      to: '2026-08-29',
    });
    // The tenant fixture also carries one legacy row. It remains separate from
    // both the mapped Asset ID and this batch's explicit ambiguous row.
    expect(rows).toHaveLength(3);
    const mapped = rows.find((row) => row.assetId === 'asset-one');
    expect(mapped).toMatchObject({
      attributionState: 'mapped',
      name: 'Synthetic video one',
      assetType: 'video',
      campaignTypes: ['SB'],
      campaignCount: 2,
      adGroupCount: 2,
      adCount: 2,
      placementCount: 2,
      impressions: 300,
      clicks: 30,
      ctr: 0.1,
      cost: 15,
      purchases: 3,
      sales: 60,
      acos: 0.25,
      roas: 4,
      videoCompleteViews: 60,
    });
    expect(mapped?.drilldown).toHaveLength(2);

    const ambiguous = rows.find((row) => row.attributionState === 'ambiguous');
    expect(ambiguous).toMatchObject({
      assetId: null,
      name: null,
      impressions: 20,
      cost: 2,
    });
  });

  it('allows null content hashes without collapsing unrelated Amazon Asset IDs', async () => {
    const assets = await database.sql<{ amazon_asset_id: string }[]>`
      select amazon_asset_id
        from public.creative_assets
       where org_id = ${orgId} and profile_id = ${profileId}
         and amazon_asset_id is not null
       order by amazon_asset_id
    `;
    expect(assets.map((row) => row.amazon_asset_id)).toEqual(['asset-one', 'asset-two']);
  });

  it('preserves creativeVersion with no fabricated creativeId and replaces a changed current mapping', async () => {
    const firstSnapshotId = '63636363-6363-4363-8363-636363636363';
    const secondSnapshotId = '64646464-6464-4464-8464-646464646464';
    const observed = observedBatch(orgId, profileId, firstSnapshotId, 'asset-observed-one');
    const first = await persistCreativePerformanceBatch(database, observed);
    expect(first).toMatchObject({
      assetsUpserted: 1,
      mappingsUpserted: 1,
      factsUpserted: 1,
      snapshotsUpserted: 1,
      totalUpserts: 4,
      snapshotsReadBack: 1,
    });
    const retry = await persistCreativePerformanceBatch(database, observed);
    expect(retry).toMatchObject({ totalUpserts: 4, factsReadBack: 1, snapshotsReadBack: 1 });

    const [stored] = await database.sql<{
      creative_id: string | null;
      creative_version: string | null;
      mapping_provenance: string | null;
      placement: string | null;
    }[]>`
      select creative_id, creative_version, mapping_provenance, placement::text
        from public.fact_creative_daily
       where profile_id = ${profileId} and ad_id = 'ad-observed'
    `;
    expect(stored).toEqual({
      creative_id: null,
      creative_version: 'version_v1',
      mapping_provenance: 'current_sb_ad_snapshot',
      placement: null,
    });

    await persistCreativePerformanceBatch(
      database,
      observedBatch(orgId, profileId, secondSnapshotId, 'asset-observed-two'),
    );
    const canonical = await database.sql<{ amazon_asset_id: string; rows: number }[]>`
      select max(amazon_asset_id) as amazon_asset_id, count(*)::int as rows
        from public.fact_creative_daily
       where profile_id = ${profileId}
         and date = '2026-08-28'
         and ad_id = 'ad-observed'
         and placement is null
    `;
    expect(canonical[0]).toEqual({ amazon_asset_id: 'asset-observed-two', rows: 1 });
  });

  it('reads the latest counted snapshot in the exact tenant and profile scope', async () => {
    const snapshotId = '6f6f6f6f-6f6f-4f6f-8f6f-6f6f6f6f6f6f';
    const batch = mappingOnlyObservedBatch(orgId, profileId, snapshotId, 'asset-latest');
    batch.snapshot = { ...batch.snapshot!, observedAt: '2099-08-30T01:00:00Z' };
    await persistCreativePerformanceBatch(database, batch);

    const latest = await readLatestCreativeSyncSnapshot(database, { orgId, profileId });
    expect(latest).toMatchObject({
      id: snapshotId,
      profileId,
      status: 'mapping_only',
      sourceAssets: 1,
      parsedAssets: 1,
      sourceAds: 1,
      parsedAds: 1,
      mapped: 1,
      mappedFactRows: 0,
    });
  });

  it('does not let an overlapping observation move a report-pending mapping', async () => {
    const firstSnapshotId = '65656565-6565-4565-8565-656565656565';
    const secondSnapshotId = '66666666-6666-4666-8666-666666666666';
    const first = pendingObservedBatch(orgId, profileId, firstSnapshotId, 'asset-pending-one');
    await persistCreativePerformanceBatch(database, first);

    try {
      await expect(persistCreativePerformanceBatch(
        database,
        mappingOnlyObservedBatch(orgId, profileId, secondSnapshotId, 'asset-pending-two'),
      )).rejects.toThrow(/still has a report pending/);
      const [stored] = await database.sql<{ creative_sync_snapshot_id: string | null }[]>`
        select creative_sync_snapshot_id
          from public.ad_creative_asset_mappings
         where profile_id = ${profileId} and source_mapping_key = 'observed-mapping'
      `;
      expect(stored?.creative_sync_snapshot_id).toBe(firstSnapshotId);
    } finally {
      await database.sql`
        update public.creative_sync_snapshots
           set status = 'blocked'
         where id = ${firstSnapshotId}
      `;
    }
  });

  it('is idempotent and updates metrics on an exact fact retry', async () => {
    const batch = syntheticBatch(orgId, profileId);
    batch.facts = batch.facts.map((row, index) => index === 0
      ? { ...row, impressions: 150, clicks: 15, cost: 9, sales: 30 }
      : row);
    const counts = await persistCreativePerformanceBatch(database, batch);
    expect(counts.totalUpserts).toBe(8);

    const [grain] = await database.sql<{ rows: number; impressions: number; cost: number }[]>`
      select count(*)::int as rows,
             max(impressions)::int as impressions,
             max(cost)::float8 as cost
        from public.fact_creative_daily
       where profile_id = ${profileId}
         and date = '2026-08-28'
         and ad_id = 'ad-one'
         and amazon_asset_id = 'asset-one'
    `;
    expect(grain).toEqual({ rows: 1, impressions: 150, cost: 9 });
  });

  it('revises one stable mapping key instead of appending another current mapping', async () => {
    const revised: CreativeMappingWrite = {
      sourceMappingKey: 'mapping-one',
      mapping: mapping(profileId, {
        assetId: 'asset-two',
        observedAt: '2026-08-30T01:00:00Z',
      }),
    };
    const counts = await persistCreativePerformanceBatch(database, {
      orgId,
      profileId,
      assets: [],
      mappings: [revised],
      facts: [],
    });
    expect(counts).toMatchObject({ totalUpserts: 1, mappingsReadBack: 1 });
    const rows = await database.sql<{ amazon_asset_id: string; observed_at: Date }[]>`
      select amazon_asset_id, observed_at
        from public.ad_creative_asset_mappings
       where profile_id = ${profileId} and source_mapping_key = 'mapping-one'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amazon_asset_id).toBe('asset-two');
    expect(new Date(rows[0]?.observed_at ?? 0).toISOString()).toBe('2026-08-30T01:00:00.000Z');

    const corrected = await persistCreativePerformanceBatch(database, {
      orgId,
      profileId,
      assets: [],
      mappings: [],
      facts: [fact(profileId, { assetId: 'asset-two', impressions: 90, clicks: 9 })],
    });
    expect(corrected).toMatchObject({ totalUpserts: 1, factsReadBack: 1 });
    const canonical = await database.sql<{ amazon_asset_id: string; rows: number }[]>`
      select max(amazon_asset_id) as amazon_asset_id, count(*)::int as rows
        from public.fact_creative_daily
       where profile_id = ${profileId}
         and date = '2026-08-28'
         and ad_id = 'ad-one'
         and placement = 'top_of_search'
    `;
    expect(canonical[0]).toEqual({ amazon_asset_id: 'asset-two', rows: 1 });
  });

  it('rolls back a mapped batch whose Asset ID is absent from the profile', async () => {
    const before = await database.sql<{ rows: number }[]>`
      select count(*)::int as rows from public.ad_creative_asset_mappings where profile_id = ${profileId}
    `;
    await expect(persistCreativePerformanceBatch(database, {
      orgId,
      profileId,
      assets: [],
      mappings: [{
        sourceMappingKey: 'missing-asset-mapping',
        mapping: mapping(profileId, { adId: 'ad-missing', assetId: 'asset-missing' }),
      }],
      facts: [],
    })).rejects.toThrow(/not present in the same profile/);
    const after = await database.sql<{ rows: number }[]>`
      select count(*)::int as rows from public.ad_creative_asset_mappings where profile_id = ${profileId}
    `;
    expect(after[0]?.rows).toBe(before[0]?.rows);
  });

  it('refuses a fact with no explicit current ad/creative mapping', async () => {
    await expect(persistCreativePerformanceBatch(database, {
      orgId,
      profileId,
      assets: [],
      mappings: [],
      facts: [fact(profileId, {
        adId: 'ad-without-mapping',
        creativeId: 'creative-without-mapping',
      })],
    })).rejects.toThrow(/0 explicit current ad\/creative mappings/);
  });

  it('requires both organisation and profile on aggregation reads', async () => {
    expect(await readCreativePerformance(database, {
      orgId: '00000000-0000-4000-8000-000000000000',
      profileId,
      from: '2026-08-28',
      to: '2026-08-29',
    })).toEqual([]);
  });
});

function syntheticBatch(orgId: string, profileId: string): CreativePerformanceWriteBatch {
  return {
    orgId,
    profileId,
    assets: [
      asset(profileId, 'asset-one', { name: 'Synthetic video one', contentHash: null }),
      asset(profileId, 'asset-two', { name: 'Synthetic video two', contentHash: null }),
    ],
    mappings: [
      { sourceMappingKey: 'mapping-one', mapping: mapping(profileId) },
      {
        sourceMappingKey: 'mapping-two',
        mapping: mapping(profileId, {
          campaignId: 'campaign-two',
          adGroupId: 'ad-group-two',
          adId: 'ad-two',
          creativeId: 'creative-two',
          placement: 'product_pages',
        }),
      },
      {
        sourceMappingKey: 'mapping-ambiguous',
        mapping: mapping(profileId, {
          campaignId: 'campaign-three',
          adGroupId: 'ad-group-three',
          adId: 'ad-three',
          creativeId: null,
          assetId: null,
          placement: null,
          attributionState: 'ambiguous',
        }),
      },
    ],
    facts: [
      fact(profileId),
      fact(profileId, {
        date: '2026-08-29',
        campaignId: 'campaign-two',
        adGroupId: 'ad-group-two',
        adId: 'ad-two',
        creativeId: 'creative-two',
        placement: 'product_pages',
        impressions: 200,
        clicks: 20,
        cost: 10,
        purchases: 2,
        sales: 40,
        videoCompleteViews: 40,
      }),
      fact(profileId, {
        date: '2026-08-29',
        campaignId: 'campaign-three',
        adGroupId: 'ad-group-three',
        adId: 'ad-three',
        creativeId: null,
        assetId: null,
        placement: null,
        attributionState: 'ambiguous',
        impressions: 20,
        clicks: 2,
        cost: 2,
        purchases: 0,
        sales: 0,
        videoFirstQuartileViews: null,
        videoMidpointViews: null,
        videoThirdQuartileViews: null,
        videoCompleteViews: null,
      }),
    ],
  };
}

function asset(
  profileId: string,
  assetId: string,
  overrides: Partial<CreativeAsset> = {},
): CreativeAsset {
  return {
    profileId,
    assetId,
    name: 'Synthetic video',
    assetType: 'video',
    contentHash: null,
    thumbnailUrl: null,
    ...overrides,
  };
}

function mapping(
  profileId: string,
  overrides: Partial<AdCreativeAssetMapping> = {},
): AdCreativeAssetMapping {
  return {
    profileId,
    adProduct: 'SB',
    campaignId: 'campaign-one',
    adGroupId: 'ad-group-one',
    adId: 'ad-one',
    creativeId: 'creative-one',
    creativeVersion: null,
    assetId: 'asset-one',
    placement: 'top_of_search',
    attributionState: 'mapped',
    mappingProvenance: null,
    creativeSyncSnapshotId: null,
    observedAt: '2026-08-29T01:00:00Z',
    ...overrides,
  };
}

function fact(
  profileId: string,
  overrides: Partial<CreativeDailyFact> = {},
): CreativeDailyFact {
  return {
    profileId,
    date: '2026-08-28',
    adProduct: 'SB',
    campaignId: 'campaign-one',
    adGroupId: 'ad-group-one',
    adId: 'ad-one',
    creativeId: 'creative-one',
    creativeVersion: null,
    assetId: 'asset-one',
    placement: 'top_of_search',
    attributionState: 'mapped',
    mappingProvenance: null,
    creativeSyncSnapshotId: null,
    impressions: 100,
    clicks: 10,
    cost: 5,
    purchases: 1,
    sales: 20,
    videoFirstQuartileViews: 80,
    videoMidpointViews: 60,
    videoThirdQuartileViews: 40,
    videoCompleteViews: 20,
    ...overrides,
  };
}

function observedBatch(
  orgId: string,
  profileId: string,
  snapshotId: string,
  assetId: string,
): CreativePerformanceWriteBatch {
  const snapshot: CreativeSyncSnapshot = {
    id: snapshotId,
    profileId,
    startDate: '2026-08-28',
    endDate: '2026-08-28',
    observedAt: '2026-08-29T03:00:00Z',
    mappingProvenance: 'current_sb_ad_snapshot',
    historicalValidity: 'unproven_current_snapshot',
    status: 'completed',
    paginationComplete: true,
    factPromotionAllowed: true,
    sourceAssets: 1,
    parsedAssets: 1,
    sourceAds: 1,
    parsedAds: 1,
    mapped: 1,
    legacy: 0,
    unsupported: 0,
    ambiguous: 0,
    unmapped: 0,
    reportSourceRows: 1,
    reportParsedRows: 1,
    reportRefusedRows: 0,
    mappedFactRows: 1,
    unpromotedReportRows: 0,
  };
  return {
    orgId,
    profileId,
    snapshot,
    assets: [asset(profileId, assetId, { contentHash: null })],
    mappings: [{
      sourceMappingKey: 'observed-mapping',
      mapping: mapping(profileId, {
        campaignId: 'campaign-observed',
        adGroupId: 'ad-group-observed',
        adId: 'ad-observed',
        creativeId: null,
        creativeVersion: 'version_v1',
        assetId,
        placement: null,
        mappingProvenance: 'current_sb_ad_snapshot',
        creativeSyncSnapshotId: snapshotId,
      }),
    }],
    facts: [fact(profileId, {
      campaignId: 'campaign-observed',
      adGroupId: 'ad-group-observed',
      adId: 'ad-observed',
      creativeId: null,
      creativeVersion: 'version_v1',
      assetId,
      placement: null,
      mappingProvenance: 'current_sb_ad_snapshot',
      creativeSyncSnapshotId: snapshotId,
    })],
  };
}

function pendingObservedBatch(
  orgId: string,
  profileId: string,
  snapshotId: string,
  assetId: string,
): CreativePerformanceWriteBatch {
  const batch = observedBatch(orgId, profileId, snapshotId, assetId);
  batch.snapshot = {
    ...batch.snapshot!,
    status: 'report_pending',
    reportSourceRows: null,
    reportParsedRows: null,
    reportRefusedRows: null,
    mappedFactRows: 0,
    unpromotedReportRows: 0,
  };
  batch.facts = [];
  return batch;
}

function mappingOnlyObservedBatch(
  orgId: string,
  profileId: string,
  snapshotId: string,
  assetId: string,
): CreativePerformanceWriteBatch {
  const batch = pendingObservedBatch(orgId, profileId, snapshotId, assetId);
  batch.snapshot = { ...batch.snapshot!, status: 'mapping_only', factPromotionAllowed: false };
  return batch;
}
