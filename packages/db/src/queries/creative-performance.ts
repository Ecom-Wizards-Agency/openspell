/**
 * Counted persistence and tenant-scoped reads for Creative Performance v1.
 *
 * Amazon Asset ID is the only asset identity used here. Content hashes remain
 * optional metadata and never participate in a conflict target or join. The
 * loader accepts ad-grain facts only; callers must resolve ad -> creative ->
 * asset before this boundary and retain non-attributable rows under their
 * explicit attribution state.
 */
import {
  and,
  eq,
  getTableColumns,
  getTableName,
  inArray,
  isNull,
  sql,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgTable, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import {
  AdCreativeAssetMapping,
  CreativeSyncSnapshot,
  type CreativeAsset,
  type CreativeAttributionState,
  type CreativeDailyFact,
  type CreativeMappingProvenance,
  type Placement,
} from '@wizard-ads/shared';
import type { DbHandle } from '../client.js';
import {
  adCreativeAssetMappings,
  creativeAssets,
  creativeSyncSnapshots,
  factCreativeDaily,
} from '../schema/index.js';
import { chunkForInsert } from './chunk.js';

export interface CreativeMappingWrite {
  /** Stable across revisions of one ad/creative/placement mapping. */
  sourceMappingKey: string;
  mapping: AdCreativeAssetMapping;
}

export interface CreativePerformanceWriteBatch {
  orgId: string;
  profileId: string;
  assets: readonly CreativeAsset[];
  mappings: readonly CreativeMappingWrite[];
  facts: readonly CreativeDailyFact[];
  snapshot?: CreativeSyncSnapshot;
}

export interface CreativePersistenceCounts {
  assetsUpserted: number;
  mappingsUpserted: number;
  factsUpserted: number;
  totalUpserts: number;
  assetsReadBack: number;
  mappingsReadBack: number;
  factsReadBack: number;
  snapshotsUpserted: number;
  snapshotsReadBack: number;
}

export class CreativePersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreativePersistenceError';
  }
}

/**
 * Persist a fully staged creative batch in one transaction.
 *
 * Every offered row must be returned by its upsert and found again by its exact
 * identity before commit. A retry updates the same three grains rather than
 * adding a second mapping or fact.
 */
export async function persistCreativePerformanceBatch(
  handle: DbHandle,
  batch: CreativePerformanceWriteBatch,
): Promise<CreativePersistenceCounts> {
  validateWriteBatch(batch);

  return handle.db.transaction(async (tx) => {
    if (
      batch.snapshot !== undefined &&
      (batch.snapshot.status === 'mapping_only' || batch.snapshot.status === 'report_pending')
    ) {
      // A report-pending snapshot relies on the current-key mapping rows until
      // its report is promoted. Serialize observation starts for this profile,
      // then reject a different snapshot while that evidence is in flight.
      // This prevents even a mapping-only sync from moving those rows.
      await tx.execute(sql`
        select pg_advisory_xact_lock(
          hashtextextended(${`${batch.orgId}:${batch.profileId}:creative-sync`}, 0)
        )
      `);
      const pending = await tx
        .select({ id: creativeSyncSnapshots.id })
        .from(creativeSyncSnapshots)
        .where(and(
          eq(creativeSyncSnapshots.orgId, batch.orgId),
          eq(creativeSyncSnapshots.profileId, batch.profileId),
          eq(creativeSyncSnapshots.status, 'report_pending'),
        ))
        .limit(1);
      if (pending[0] !== undefined && pending[0].id !== batch.snapshot.id) {
        throw new CreativePersistenceError(
          `creative snapshot ${pending[0].id} still has a report pending; overlapping observations are disabled`,
        );
      }
    }

    let snapshotsUpserted = 0;
    if (batch.snapshot !== undefined) {
      const existing = await tx
        .select({ orgId: creativeSyncSnapshots.orgId, profileId: creativeSyncSnapshots.profileId })
        .from(creativeSyncSnapshots)
        .where(eq(creativeSyncSnapshots.id, batch.snapshot.id));
      if (
        existing[0] !== undefined &&
        (existing[0].orgId !== batch.orgId || existing[0].profileId !== batch.profileId)
      ) {
        throw new CreativePersistenceError('creative snapshot id already belongs to another tenant scope');
      }
      const written = await tx
        .insert(creativeSyncSnapshots)
        .values(snapshotValues(batch.orgId, batch.snapshot))
        .onConflictDoUpdate({
          target: creativeSyncSnapshots.id,
          set: conflictSet(creativeSyncSnapshots, [
            'startDate',
            'endDate',
            'observedAt',
            'mappingProvenance',
            'historicalValidity',
            'status',
            'paginationComplete',
            'factPromotionAllowed',
            'sourceAssets',
            'parsedAssets',
            'sourceAds',
            'parsedAds',
            'mapped',
            'legacy',
            'unsupported',
            'ambiguous',
            'unmapped',
            'reportSourceRows',
            'reportParsedRows',
            'reportRefusedRows',
            'mappedFactRows',
            'unpromotedReportRows',
            'updatedAt',
          ]),
        })
        .returning({ id: creativeSyncSnapshots.id });
      snapshotsUpserted = written.length;
      assertWriteCount('creative snapshots', 1, snapshotsUpserted);
    }

    let assetsUpserted = 0;
    for (const rows of chunkForInsert(
      batch.assets.map((asset) => ({
        orgId: batch.orgId,
        profileId: batch.profileId,
        amazonAssetId: asset.assetId,
        kind: asset.assetType,
        url: asset.thumbnailUrl,
        contentHash: asset.contentHash,
        name: asset.name,
        amazonCreatedAt: asset.amazonCreatedAt === undefined || asset.amazonCreatedAt === null
          ? null
          : new Date(asset.amazonCreatedAt),
        amazonUpdatedAt: asset.amazonUpdatedAt === undefined || asset.amazonUpdatedAt === null
          ? null
          : new Date(asset.amazonUpdatedAt),
      })),
      Object.keys(getTableColumns(creativeAssets)).length,
    )) {
      const written = await tx
        .insert(creativeAssets)
        .values(rows)
        .onConflictDoUpdate({
          target: [creativeAssets.profileId, creativeAssets.amazonAssetId],
          targetWhere: sql`${creativeAssets.profileId} is not null and ${creativeAssets.amazonAssetId} is not null`,
          set: conflictSet(creativeAssets, [
            'orgId',
            'kind',
            'url',
            'contentHash',
            'name',
            'amazonCreatedAt',
            'amazonUpdatedAt',
          ]),
        })
        .returning({ id: creativeAssets.id });
      assetsUpserted += written.length;
    }
    assertWriteCount('creative assets', batch.assets.length, assetsUpserted);

    const referencedAssetIds = unique(
      batch.mappings
        .map(({ mapping }) => mapping.assetId)
        .filter((value): value is string => value !== null),
    );
    const assetRows = referencedAssetIds.length === 0
      ? []
      : await tx
          .select({ id: creativeAssets.id, amazonAssetId: creativeAssets.amazonAssetId })
          .from(creativeAssets)
          .where(and(
            eq(creativeAssets.orgId, batch.orgId),
            eq(creativeAssets.profileId, batch.profileId),
            inArray(creativeAssets.amazonAssetId, referencedAssetIds),
          ));
    const assetUuidByAmazonId = new Map(
      assetRows.flatMap((row) => row.amazonAssetId === null ? [] : [[row.amazonAssetId, row.id] as const]),
    );
    for (const assetId of referencedAssetIds) {
      if (!assetUuidByAmazonId.has(assetId)) {
        throw new CreativePersistenceError(
          `mapped Amazon Asset ID ${assetId} is not present in the same profile`,
        );
      }
    }

    let mappingsUpserted = 0;
    const mappingValues = batch.mappings.map(({ sourceMappingKey, mapping }) => ({
      orgId: batch.orgId,
      profileId: batch.profileId,
      sourceMappingKey,
      adProduct: mapping.adProduct,
      campaignId: mapping.campaignId,
      adGroupId: mapping.adGroupId,
      adId: mapping.adId,
      creativeId: mapping.creativeId,
      creativeVersion: mapping.creativeVersion,
      creativeAssetId: mapping.assetId === null ? null : assetUuidByAmazonId.get(mapping.assetId) ?? null,
      amazonAssetId: mapping.assetId,
      placement: mapping.placement,
      attributionState: mapping.attributionState,
      mappingProvenance: mapping.mappingProvenance,
      creativeSyncSnapshotId: mapping.creativeSyncSnapshotId,
      observedAt: new Date(mapping.observedAt),
    }));
    for (const rows of chunkForInsert(
      mappingValues,
      Object.keys(getTableColumns(adCreativeAssetMappings)).length,
    )) {
      const written = await tx
        .insert(adCreativeAssetMappings)
        .values(rows)
        .onConflictDoUpdate({
          target: [
            adCreativeAssetMappings.profileId,
            adCreativeAssetMappings.sourceMappingKey,
          ],
          set: conflictSet(adCreativeAssetMappings, [
            'orgId',
            'adProduct',
            'campaignId',
            'adGroupId',
            'adId',
            'creativeId',
            'creativeVersion',
            'creativeAssetId',
            'amazonAssetId',
            'placement',
            'attributionState',
            'mappingProvenance',
            'creativeSyncSnapshotId',
            'observedAt',
          ]),
        })
        .returning({ id: adCreativeAssetMappings.id });
      mappingsUpserted += written.length;
    }
    assertWriteCount('creative mappings', batch.mappings.length, mappingsUpserted);

    let factsUpserted = 0;
    const factValues = batch.facts.map((fact) => ({
      orgId: batch.orgId,
      profileId: batch.profileId,
      date: fact.date,
      adProduct: fact.adProduct,
      campaignId: fact.campaignId,
      adGroupId: fact.adGroupId,
      adId: fact.adId,
      creativeId: fact.creativeId,
      creativeVersion: fact.creativeVersion,
      amazonAssetId: fact.assetId,
      placement: fact.placement,
      attributionState: fact.attributionState,
      mappingProvenance: fact.mappingProvenance,
      creativeSyncSnapshotId: fact.creativeSyncSnapshotId,
      impressions: fact.impressions,
      clicks: fact.clicks,
      cost: fact.cost,
      purchases: fact.purchases,
      sales: fact.sales,
      videoFirstQuartileViews: fact.videoFirstQuartileViews,
      videoMidpointViews: fact.videoMidpointViews,
      videoThirdQuartileViews: fact.videoThirdQuartileViews,
      videoCompleteViews: fact.videoCompleteViews,
      loadedAt: new Date(),
    }));
    const mappedAds = factValues.length === 0
      ? []
      : await tx
          .select({
            adProduct: adCreativeAssetMappings.adProduct,
            campaignId: adCreativeAssetMappings.campaignId,
            adGroupId: adCreativeAssetMappings.adGroupId,
            adId: adCreativeAssetMappings.adId,
            creativeId: adCreativeAssetMappings.creativeId,
            creativeVersion: adCreativeAssetMappings.creativeVersion,
            amazonAssetId: adCreativeAssetMappings.amazonAssetId,
            placement: adCreativeAssetMappings.placement,
            attributionState: adCreativeAssetMappings.attributionState,
            mappingProvenance: adCreativeAssetMappings.mappingProvenance,
            creativeSyncSnapshotId: adCreativeAssetMappings.creativeSyncSnapshotId,
          })
          .from(adCreativeAssetMappings)
          .where(and(
            eq(adCreativeAssetMappings.orgId, batch.orgId),
            eq(adCreativeAssetMappings.profileId, batch.profileId),
            inArray(adCreativeAssetMappings.adId, unique(factValues.map((fact) => fact.adId))),
          ));
    for (const [index, fact] of factValues.entries()) {
      const matches = mappedAds.filter((mapping) => mappingIdentity(mapping) === mappingIdentity(fact));
      if (matches.length !== 1) {
        throw new CreativePersistenceError(
          `fact ${index} has ${matches.length} explicit current ad/creative mappings; expected exactly one`,
        );
      }
      if (
        matches[0]!.amazonAssetId !== fact.amazonAssetId ||
        matches[0]!.attributionState !== fact.attributionState
      ) {
        throw new CreativePersistenceError(
          `fact ${index} disagrees with its explicit current mapping`,
        );
      }
    }

    // The source seam guarantees one authoritative performance row per
    // ad/date/placement. Replace that attribution grain before inserting so a
    // later asset correction cannot leave both the old and new Asset IDs in
    // canonical performance.
    for (const fact of factValues) {
      await tx
        .delete(factCreativeDaily)
        .where(and(
          eq(factCreativeDaily.orgId, batch.orgId),
          eq(factCreativeDaily.profileId, batch.profileId),
          eq(factCreativeDaily.date, fact.date),
          eq(factCreativeDaily.adProduct, fact.adProduct),
          eq(factCreativeDaily.campaignId, fact.campaignId),
          eq(factCreativeDaily.adGroupId, fact.adGroupId),
          eq(factCreativeDaily.adId, fact.adId),
          fact.placement === null
            ? isNull(factCreativeDaily.placement)
            : eq(factCreativeDaily.placement, fact.placement),
        ));
    }
    for (const rows of chunkForInsert(
      factValues,
      Object.keys(getTableColumns(factCreativeDaily)).length,
    )) {
      const written = await tx
        .insert(factCreativeDaily)
        .values(rows)
        .onConflictDoUpdate({
          target: [
            factCreativeDaily.profileId,
            factCreativeDaily.date,
            factCreativeDaily.adProduct,
            factCreativeDaily.campaignId,
            factCreativeDaily.adGroupId,
            factCreativeDaily.adId,
            factCreativeDaily.creativeId,
            factCreativeDaily.creativeVersion,
            factCreativeDaily.amazonAssetId,
            factCreativeDaily.placement,
          ],
          set: conflictSet(factCreativeDaily, [
            'orgId',
            'attributionState',
            'mappingProvenance',
            'creativeSyncSnapshotId',
            'impressions',
            'clicks',
            'cost',
            'purchases',
            'sales',
            'videoFirstQuartileViews',
            'videoMidpointViews',
            'videoThirdQuartileViews',
            'videoCompleteViews',
            'loadedAt',
          ]),
        })
        .returning({ profileId: factCreativeDaily.profileId });
      factsUpserted += written.length;
    }
    assertWriteCount('creative facts', batch.facts.length, factsUpserted);

    const assetsReadBack = batch.assets.length === 0
      ? 0
      : (await tx
          .select({ assetId: creativeAssets.amazonAssetId })
          .from(creativeAssets)
          .where(and(
            eq(creativeAssets.orgId, batch.orgId),
            eq(creativeAssets.profileId, batch.profileId),
            inArray(creativeAssets.amazonAssetId, batch.assets.map((asset) => asset.assetId)),
          ))).length;
    assertReadbackCount('creative assets', batch.assets.length, assetsReadBack);

    const mappingsReadBack = batch.mappings.length === 0
      ? 0
      : (await tx
          .select({ sourceMappingKey: adCreativeAssetMappings.sourceMappingKey })
          .from(adCreativeAssetMappings)
          .where(and(
            eq(adCreativeAssetMappings.orgId, batch.orgId),
            eq(adCreativeAssetMappings.profileId, batch.profileId),
            inArray(
              adCreativeAssetMappings.sourceMappingKey,
              batch.mappings.map((mapping) => mapping.sourceMappingKey),
            ),
          ))).length;
    assertReadbackCount('creative mappings', batch.mappings.length, mappingsReadBack);

    const factIdentitySet = new Set(batch.facts.map(factIdentity));
    const factDates = unique(batch.facts.map((fact) => fact.date));
    const readFacts = factDates.length === 0
      ? []
      : await tx
          .select({
            profileId: factCreativeDaily.profileId,
            date: factCreativeDaily.date,
            adProduct: factCreativeDaily.adProduct,
            campaignId: factCreativeDaily.campaignId,
            adGroupId: factCreativeDaily.adGroupId,
            adId: factCreativeDaily.adId,
            creativeId: factCreativeDaily.creativeId,
            creativeVersion: factCreativeDaily.creativeVersion,
            assetId: factCreativeDaily.amazonAssetId,
            placement: factCreativeDaily.placement,
            mappingProvenance: factCreativeDaily.mappingProvenance,
            creativeSyncSnapshotId: factCreativeDaily.creativeSyncSnapshotId,
          })
          .from(factCreativeDaily)
          .where(and(
            eq(factCreativeDaily.orgId, batch.orgId),
            eq(factCreativeDaily.profileId, batch.profileId),
            inArray(factCreativeDaily.date, factDates),
          ));
    const factsReadBack = readFacts.filter((fact) => factIdentitySet.has(factIdentity(fact))).length;
    assertReadbackCount('creative facts', batch.facts.length, factsReadBack);

    if (batch.snapshot !== undefined) {
      const updated = await tx
        .update(creativeSyncSnapshots)
        .set({
          assetsUpserted: sql`greatest(${creativeSyncSnapshots.assetsUpserted}, ${assetsUpserted})`,
          mappingsUpserted: sql`greatest(${creativeSyncSnapshots.mappingsUpserted}, ${mappingsUpserted})`,
          factsUpserted: sql`greatest(${creativeSyncSnapshots.factsUpserted}, ${factsUpserted})`,
          assetsReadBack: sql`greatest(${creativeSyncSnapshots.assetsReadBack}, ${assetsReadBack})`,
          mappingsReadBack: sql`greatest(${creativeSyncSnapshots.mappingsReadBack}, ${mappingsReadBack})`,
          factsReadBack: sql`greatest(${creativeSyncSnapshots.factsReadBack}, ${factsReadBack})`,
        })
        .where(and(
          eq(creativeSyncSnapshots.id, batch.snapshot.id),
          eq(creativeSyncSnapshots.orgId, batch.orgId),
          eq(creativeSyncSnapshots.profileId, batch.profileId),
        ))
        .returning({ id: creativeSyncSnapshots.id });
      assertWriteCount('creative snapshot count update', 1, updated.length);
    }
    const snapshotsReadBack = batch.snapshot === undefined
      ? 0
      : (await tx
          .select({ id: creativeSyncSnapshots.id })
          .from(creativeSyncSnapshots)
          .where(and(
            eq(creativeSyncSnapshots.id, batch.snapshot.id),
            eq(creativeSyncSnapshots.orgId, batch.orgId),
            eq(creativeSyncSnapshots.profileId, batch.profileId),
          ))).length;
    assertReadbackCount('creative snapshots', batch.snapshot === undefined ? 0 : 1, snapshotsReadBack);

    return {
      assetsUpserted,
      mappingsUpserted,
      factsUpserted,
      totalUpserts: assetsUpserted + mappingsUpserted + factsUpserted + snapshotsUpserted,
      assetsReadBack,
      mappingsReadBack,
      factsReadBack,
      snapshotsUpserted,
      snapshotsReadBack,
    };
  });
}

export interface CreativePerformanceFilter {
  orgId: string;
  profileId: string;
  from: string;
  to: string;
}

export interface CreativeSyncSnapshotEvidence {
  snapshot: CreativeSyncSnapshot;
  mappings: CreativeMappingWrite[];
  persistence: Pick<
    CreativePersistenceCounts,
    | 'assetsUpserted'
    | 'mappingsUpserted'
    | 'factsUpserted'
    | 'assetsReadBack'
    | 'mappingsReadBack'
    | 'factsReadBack'
  >;
}

/** Read only mappings still attached to this exact observation snapshot. */
export async function readCreativeSyncSnapshotEvidence(
  handle: Pick<DbHandle, 'sql'>,
  scope: { orgId: string; profileId: string; snapshotId: string },
): Promise<CreativeSyncSnapshotEvidence> {
  const snapshots = await handle.sql<{
    id: string;
    profile_id: string;
    start_date: string;
    end_date: string;
    observed_at: Date | string;
    mapping_provenance: CreativeMappingProvenance;
    historical_validity: 'unproven_current_snapshot';
    status: CreativeSyncSnapshot['status'];
    pagination_complete: boolean;
    fact_promotion_allowed: boolean;
    source_assets: string | number;
    parsed_assets: string | number;
    source_ads: string | number;
    parsed_ads: string | number;
    mapped: string | number;
    legacy: string | number;
    unsupported: string | number;
    ambiguous: string | number;
    unmapped: string | number;
    report_source_rows: string | number | null;
    report_parsed_rows: string | number | null;
    report_refused_rows: string | number | null;
    mapped_fact_rows: string | number;
    unpromoted_report_rows: string | number;
    assets_upserted: string | number;
    mappings_upserted: string | number;
    facts_upserted: string | number;
    assets_read_back: string | number;
    mappings_read_back: string | number;
    facts_read_back: string | number;
  }[]>`
    select id, profile_id, start_date::text, end_date::text, observed_at,
           mapping_provenance, historical_validity, status, pagination_complete,
           fact_promotion_allowed, source_assets, parsed_assets, source_ads, parsed_ads,
           mapped, legacy, unsupported, ambiguous, unmapped,
           report_source_rows, report_parsed_rows, report_refused_rows,
           mapped_fact_rows, unpromoted_report_rows,
           assets_upserted, mappings_upserted, facts_upserted,
           assets_read_back, mappings_read_back, facts_read_back
      from public.creative_sync_snapshots
     where id = ${scope.snapshotId}
       and org_id = ${scope.orgId}
       and profile_id = ${scope.profileId}
  `;
  const row = snapshots[0];
  if (row === undefined) {
    throw new CreativePersistenceError(`creative snapshot ${scope.snapshotId} does not exist in scope`);
  }
  const snapshot = CreativeSyncSnapshot.parse({
    id: row.id,
    profileId: row.profile_id,
    startDate: row.start_date,
    endDate: row.end_date,
    observedAt: new Date(row.observed_at).toISOString(),
    mappingProvenance: row.mapping_provenance,
    historicalValidity: row.historical_validity,
    status: row.status,
    paginationComplete: row.pagination_complete,
    factPromotionAllowed: row.fact_promotion_allowed,
    sourceAssets: number(row.source_assets),
    parsedAssets: number(row.parsed_assets),
    sourceAds: number(row.source_ads),
    parsedAds: number(row.parsed_ads),
    mapped: number(row.mapped),
    legacy: number(row.legacy),
    unsupported: number(row.unsupported),
    ambiguous: number(row.ambiguous),
    unmapped: number(row.unmapped),
    reportSourceRows: nullableNumber(row.report_source_rows),
    reportParsedRows: nullableNumber(row.report_parsed_rows),
    reportRefusedRows: nullableNumber(row.report_refused_rows),
    mappedFactRows: number(row.mapped_fact_rows),
    unpromotedReportRows: number(row.unpromoted_report_rows),
  });
  const rows = await handle.sql<{
    source_mapping_key: string;
    ad_product: 'SB';
    campaign_id: string;
    ad_group_id: string;
    ad_id: string;
    creative_id: string | null;
    creative_version: string | null;
    amazon_asset_id: string | null;
    placement: Placement | null;
    attribution_state: CreativeAttributionState;
    mapping_provenance: CreativeMappingProvenance | null;
    creative_sync_snapshot_id: string | null;
    observed_at: Date | string;
  }[]>`
    select source_mapping_key, ad_product::text as ad_product, campaign_id, ad_group_id,
           ad_id, creative_id, creative_version, amazon_asset_id,
           placement::text as placement, attribution_state::text as attribution_state,
           mapping_provenance, creative_sync_snapshot_id, observed_at
      from public.ad_creative_asset_mappings
     where org_id = ${scope.orgId}
       and profile_id = ${scope.profileId}
       and creative_sync_snapshot_id = ${scope.snapshotId}
     order by source_mapping_key
  `;
  const mappings = rows.map((mapping): CreativeMappingWrite => ({
    sourceMappingKey: mapping.source_mapping_key,
    mapping: AdCreativeAssetMapping.parse({
      profileId: scope.profileId,
      adProduct: mapping.ad_product,
      campaignId: mapping.campaign_id,
      adGroupId: mapping.ad_group_id,
      adId: mapping.ad_id,
      creativeId: mapping.creative_id,
      creativeVersion: mapping.creative_version,
      assetId: mapping.amazon_asset_id,
      placement: mapping.placement,
      attributionState: mapping.attribution_state,
      mappingProvenance: mapping.mapping_provenance,
      creativeSyncSnapshotId: mapping.creative_sync_snapshot_id,
      observedAt: new Date(mapping.observed_at).toISOString(),
    }),
  }));
  return {
    snapshot,
    mappings,
    persistence: {
      assetsUpserted: number(row.assets_upserted),
      mappingsUpserted: number(row.mappings_upserted),
      factsUpserted: number(row.facts_upserted),
      assetsReadBack: number(row.assets_read_back),
      mappingsReadBack: number(row.mappings_read_back),
      factsReadBack: number(row.facts_read_back),
    },
  };
}

export interface CreativePerformanceDrilldown {
  campaignId: string;
  adGroupId: string;
  adId: string;
  creativeId: string | null;
  creativeVersion: string | null;
  mappingProvenance: CreativeMappingProvenance | null;
  placement: Placement | null;
  impressions: number;
  clicks: number;
  cost: number;
  purchases: number;
  sales: number;
  videoFirstQuartileViews: number | null;
  videoMidpointViews: number | null;
  videoThirdQuartileViews: number | null;
  videoCompleteViews: number | null;
}

export interface CreativePerformanceAsset {
  assetId: string | null;
  attributionState: CreativeAttributionState;
  name: string | null;
  assetType: string | null;
  thumbnailUrl: string | null;
  campaignTypes: string[];
  mappingProvenances: CreativeMappingProvenance[];
  campaignCount: number;
  adGroupCount: number;
  adCount: number;
  placementCount: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  cost: number;
  purchases: number;
  sales: number;
  acos: number | null;
  roas: number | null;
  videoFirstQuartileViews: number | null;
  videoMidpointViews: number | null;
  videoThirdQuartileViews: number | null;
  videoCompleteViews: number | null;
  drilldown: CreativePerformanceDrilldown[];
}

interface AggregateRow {
  amazon_asset_id: string | null;
  attribution_state: CreativeAttributionState;
  name: string | null;
  asset_type: string | null;
  thumbnail_url: string | null;
  campaign_types: string[];
  mapping_provenances: CreativeMappingProvenance[];
  campaign_count: string | number;
  ad_group_count: string | number;
  ad_count: string | number;
  placement_count: string | number;
  impressions: string | number;
  clicks: string | number;
  cost: string | number;
  purchases: string | number;
  sales: string | number;
  video_first_quartile_views: string | number | null;
  video_midpoint_views: string | number | null;
  video_third_quartile_views: string | number | null;
  video_complete_views: string | number | null;
}

interface DrilldownRow {
  amazon_asset_id: string | null;
  attribution_state: CreativeAttributionState;
  campaign_id: string;
  ad_group_id: string;
  ad_id: string;
  creative_id: string | null;
  creative_version: string | null;
  mapping_provenance: CreativeMappingProvenance | null;
  placement: Placement | null;
  impressions: string | number;
  clicks: string | number;
  cost: string | number;
  purchases: string | number;
  sales: string | number;
  video_first_quartile_views: string | number | null;
  video_midpoint_views: string | number | null;
  video_third_quartile_views: string | number | null;
  video_complete_views: string | number | null;
}

/** Aggregate by authoritative Asset ID while retaining exact ad-level drilldown. */
export async function readCreativePerformance(
  handle: Pick<DbHandle, 'sql'>,
  filter: CreativePerformanceFilter,
): Promise<CreativePerformanceAsset[]> {
  const aggregates = await handle.sql<AggregateRow[]>`
    select
      f.amazon_asset_id,
      f.attribution_state::text as attribution_state,
      max(a.name) as name,
      max(a.kind) as asset_type,
      max(a.url) as thumbnail_url,
      array_agg(distinct f.ad_product::text order by f.ad_product::text) as campaign_types,
      coalesce(
        array_agg(distinct f.mapping_provenance order by f.mapping_provenance)
          filter (where f.mapping_provenance is not null),
        '{}'::text[]
      ) as mapping_provenances,
      count(distinct f.campaign_id) as campaign_count,
      count(distinct (f.campaign_id, f.ad_group_id)) as ad_group_count,
      count(distinct (f.campaign_id, f.ad_group_id, f.ad_id)) as ad_count,
      count(distinct f.placement) as placement_count,
      sum(f.impressions) as impressions,
      sum(f.clicks) as clicks,
      sum(f.cost) as cost,
      sum(f.purchases) as purchases,
      sum(f.sales) as sales,
      case when count(f.video_first_quartile_views) = count(*)
           then sum(f.video_first_quartile_views) end as video_first_quartile_views,
      case when count(f.video_midpoint_views) = count(*)
           then sum(f.video_midpoint_views) end as video_midpoint_views,
      case when count(f.video_third_quartile_views) = count(*)
           then sum(f.video_third_quartile_views) end as video_third_quartile_views,
      case when count(f.video_complete_views) = count(*)
           then sum(f.video_complete_views) end as video_complete_views
    from public.fact_creative_daily f
    left join public.creative_assets a
      on a.org_id = f.org_id
     and a.profile_id = f.profile_id
     and a.amazon_asset_id = f.amazon_asset_id
    where f.org_id = ${filter.orgId}
      and f.profile_id = ${filter.profileId}
      and f.date between ${filter.from}::date and ${filter.to}::date
    group by f.amazon_asset_id, f.attribution_state
    order by sum(f.cost) desc, f.amazon_asset_id nulls last, f.attribution_state
  `;
  const details = await handle.sql<DrilldownRow[]>`
    select
      f.amazon_asset_id,
      f.attribution_state::text as attribution_state,
      f.campaign_id,
      f.ad_group_id,
      f.ad_id,
      f.creative_id,
      f.creative_version,
      f.mapping_provenance,
      f.placement::text as placement,
      sum(f.impressions) as impressions,
      sum(f.clicks) as clicks,
      sum(f.cost) as cost,
      sum(f.purchases) as purchases,
      sum(f.sales) as sales,
      case when count(f.video_first_quartile_views) = count(*)
           then sum(f.video_first_quartile_views) end as video_first_quartile_views,
      case when count(f.video_midpoint_views) = count(*)
           then sum(f.video_midpoint_views) end as video_midpoint_views,
      case when count(f.video_third_quartile_views) = count(*)
           then sum(f.video_third_quartile_views) end as video_third_quartile_views,
      case when count(f.video_complete_views) = count(*)
           then sum(f.video_complete_views) end as video_complete_views
    from public.fact_creative_daily f
    where f.org_id = ${filter.orgId}
      and f.profile_id = ${filter.profileId}
      and f.date between ${filter.from}::date and ${filter.to}::date
    group by f.amazon_asset_id, f.attribution_state, f.campaign_id,
             f.ad_group_id, f.ad_id, f.creative_id, f.creative_version,
             f.mapping_provenance, f.placement
    order by sum(f.cost) desc, f.campaign_id, f.ad_group_id, f.ad_id
  `;

  const detailsByIdentity = new Map<string, CreativePerformanceDrilldown[]>();
  for (const row of details) {
    const key = attributionIdentity(row.amazon_asset_id, row.attribution_state);
    const current = detailsByIdentity.get(key) ?? [];
    current.push({
      campaignId: row.campaign_id,
      adGroupId: row.ad_group_id,
      adId: row.ad_id,
      creativeId: row.creative_id,
      creativeVersion: row.creative_version,
      mappingProvenance: row.mapping_provenance,
      placement: row.placement,
      impressions: number(row.impressions),
      clicks: number(row.clicks),
      cost: number(row.cost),
      purchases: number(row.purchases),
      sales: number(row.sales),
      videoFirstQuartileViews: nullableNumber(row.video_first_quartile_views),
      videoMidpointViews: nullableNumber(row.video_midpoint_views),
      videoThirdQuartileViews: nullableNumber(row.video_third_quartile_views),
      videoCompleteViews: nullableNumber(row.video_complete_views),
    });
    detailsByIdentity.set(key, current);
  }

  return aggregates.map((row) => {
    const impressions = number(row.impressions);
    const clicks = number(row.clicks);
    const cost = number(row.cost);
    const sales = number(row.sales);
    return {
      assetId: row.amazon_asset_id,
      attributionState: row.attribution_state,
      name: row.name,
      assetType: row.asset_type,
      thumbnailUrl: row.thumbnail_url,
      campaignTypes: row.campaign_types,
      mappingProvenances: row.mapping_provenances,
      campaignCount: number(row.campaign_count),
      adGroupCount: number(row.ad_group_count),
      adCount: number(row.ad_count),
      placementCount: number(row.placement_count),
      impressions,
      clicks,
      ctr: impressions === 0 ? null : clicks / impressions,
      cost,
      purchases: number(row.purchases),
      sales,
      acos: sales === 0 ? null : cost / sales,
      roas: cost === 0 ? null : sales / cost,
      videoFirstQuartileViews: nullableNumber(row.video_first_quartile_views),
      videoMidpointViews: nullableNumber(row.video_midpoint_views),
      videoThirdQuartileViews: nullableNumber(row.video_third_quartile_views),
      videoCompleteViews: nullableNumber(row.video_complete_views),
      drilldown: detailsByIdentity.get(attributionIdentity(row.amazon_asset_id, row.attribution_state)) ?? [],
    };
  });
}

function validateWriteBatch(batch: CreativePerformanceWriteBatch): void {
  assertUnique('asset', batch.assets.map((asset) => asset.assetId));
  assertUnique('mapping source', batch.mappings.map((mapping) => mapping.sourceMappingKey));
  assertUnique('creative fact grain', batch.facts.map(factIdentity));
  assertUnique('ad-level performance grain', batch.facts.map(adFactIdentity));
  if (batch.snapshot !== undefined && batch.snapshot.profileId !== batch.profileId) {
    throw new CreativePersistenceError('creative snapshot belongs to another profile');
  }
  for (const [index, asset] of batch.assets.entries()) {
    if (asset.profileId !== batch.profileId) {
      throw new CreativePersistenceError(`asset ${index} belongs to another profile`);
    }
    if (!asset.assetType.toLowerCase().includes('video')) {
      throw new CreativePersistenceError(`asset ${index} is not a video asset`);
    }
  }
  for (const [index, { sourceMappingKey, mapping }] of batch.mappings.entries()) {
    if (sourceMappingKey.trim() === '') {
      throw new CreativePersistenceError(`mapping ${index} has an empty source key`);
    }
    if (mapping.profileId !== batch.profileId) {
      throw new CreativePersistenceError(`mapping ${index} belongs to another profile`);
    }
    if (mapping.adProduct !== 'SB') {
      throw new CreativePersistenceError(`mapping ${index} is not Sponsored Brands`);
    }
    assertAttributionIdentity(
      `mapping ${index}`,
      mapping.attributionState,
      mapping.creativeId,
      mapping.creativeVersion,
      mapping.assetId,
    );
    assertObservedProvenance(
      `mapping ${index}`,
      mapping.mappingProvenance,
      mapping.creativeSyncSnapshotId,
      batch.snapshot?.id,
    );
  }
  for (const [index, fact] of batch.facts.entries()) {
    if (fact.profileId !== batch.profileId) {
      throw new CreativePersistenceError(`fact ${index} belongs to another profile`);
    }
    if (fact.adProduct !== 'SB') {
      throw new CreativePersistenceError(`fact ${index} is not Sponsored Brands`);
    }
    assertAttributionIdentity(
      `fact ${index}`,
      fact.attributionState,
      fact.creativeId,
      fact.creativeVersion,
      fact.assetId,
    );
    assertObservedProvenance(
      `fact ${index}`,
      fact.mappingProvenance,
      fact.creativeSyncSnapshotId,
      batch.snapshot?.id,
    );
  }
}

function assertAttributionIdentity(
  label: string,
  state: CreativeAttributionState,
  creativeId: string | null,
  creativeVersion: string | null,
  assetId: string | null,
): void {
  if (state === 'mapped' && ((creativeId === null && creativeVersion === null) || assetId === null)) {
    throw new CreativePersistenceError(
      `${label} is mapped without an explicit creative ID/version and Amazon Asset ID`,
    );
  }
  if (state !== 'mapped' && assetId !== null) {
    throw new CreativePersistenceError(`${label} must not disguise ${state} attribution as an asset`);
  }
}

function assertObservedProvenance(
  label: string,
  provenance: CreativeMappingProvenance | null,
  snapshotId: string | null,
  batchSnapshotId: string | undefined,
): void {
  if ((provenance === null) !== (snapshotId === null)) {
    throw new CreativePersistenceError(`${label} has incomplete mapping provenance`);
  }
  if (snapshotId !== null && batchSnapshotId === undefined) {
    throw new CreativePersistenceError(`${label} is missing its creative snapshot batch`);
  }
  if (snapshotId !== null && snapshotId !== batchSnapshotId) {
    throw new CreativePersistenceError(`${label} belongs to another creative snapshot`);
  }
}

function assertUnique(label: string, keys: readonly string[]): void {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) throw new CreativePersistenceError(`duplicate ${label} identity: ${key}`);
    seen.add(key);
  }
}

function assertWriteCount(label: string, offered: number, written: number): void {
  if (offered !== written) {
    throw new CreativePersistenceError(`${label}: offered ${offered}, upserted ${written}`);
  }
}

function assertReadbackCount(label: string, expected: number, actual: number): void {
  if (expected !== actual) {
    throw new CreativePersistenceError(`${label}: expected ${expected} after write, read back ${actual}`);
  }
}

function factIdentity(fact: {
  profileId: string;
  date: string;
  adProduct: string;
  campaignId: string;
  adGroupId: string;
  adId: string;
  creativeId: string | null;
  creativeVersion: string | null;
  assetId: string | null;
  placement: string | null;
  mappingProvenance?: CreativeMappingProvenance | null;
  creativeSyncSnapshotId?: string | null;
}): string {
  return JSON.stringify([
    fact.profileId,
    fact.date,
    fact.adProduct,
    fact.campaignId,
    fact.adGroupId,
    fact.adId,
    fact.creativeId,
    fact.creativeVersion,
    fact.assetId,
    fact.placement,
    fact.mappingProvenance ?? null,
    fact.creativeSyncSnapshotId ?? null,
  ]);
}

function adFactIdentity(fact: {
  profileId: string;
  date: string;
  adProduct: string;
  campaignId: string;
  adGroupId: string;
  adId: string;
  placement: string | null;
}): string {
  return JSON.stringify([
    fact.profileId,
    fact.date,
    fact.adProduct,
    fact.campaignId,
    fact.adGroupId,
    fact.adId,
    fact.placement,
  ]);
}

function mappingIdentity(mapping: {
  adProduct: string;
  campaignId: string;
  adGroupId: string;
  adId: string;
  creativeId: string | null;
  creativeVersion: string | null;
  placement: string | null;
  mappingProvenance: CreativeMappingProvenance | null;
  creativeSyncSnapshotId: string | null;
}): string {
  return JSON.stringify([
    mapping.adProduct,
    mapping.campaignId,
    mapping.adGroupId,
    mapping.adId,
    mapping.creativeId,
    mapping.creativeVersion,
    mapping.placement,
    mapping.mappingProvenance,
    mapping.creativeSyncSnapshotId,
  ]);
}

function snapshotValues(orgId: string, snapshot: CreativeSyncSnapshot) {
  return {
    id: snapshot.id,
    orgId,
    profileId: snapshot.profileId,
    startDate: snapshot.startDate,
    endDate: snapshot.endDate,
    observedAt: new Date(snapshot.observedAt),
    mappingProvenance: snapshot.mappingProvenance,
    historicalValidity: snapshot.historicalValidity,
    status: snapshot.status,
    paginationComplete: snapshot.paginationComplete,
    factPromotionAllowed: snapshot.factPromotionAllowed,
    sourceAssets: snapshot.sourceAssets,
    parsedAssets: snapshot.parsedAssets,
    sourceAds: snapshot.sourceAds,
    parsedAds: snapshot.parsedAds,
    mapped: snapshot.mapped,
    legacy: snapshot.legacy,
    unsupported: snapshot.unsupported,
    ambiguous: snapshot.ambiguous,
    unmapped: snapshot.unmapped,
    reportSourceRows: snapshot.reportSourceRows,
    reportParsedRows: snapshot.reportParsedRows,
    reportRefusedRows: snapshot.reportRefusedRows,
    mappedFactRows: snapshot.mappedFactRows,
    unpromotedReportRows: snapshot.unpromotedReportRows,
    updatedAt: new Date(),
  };
}

function attributionIdentity(assetId: string | null, state: CreativeAttributionState): string {
  return JSON.stringify([assetId, state]);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function number(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

function nullableNumber(value: string | number | null): number | null {
  return value === null ? null : number(value);
}

function conflictSet<T extends PgTable>(
  table: T,
  columns: readonly (keyof T['$inferInsert'] & string)[],
): PgUpdateSetSource<T> {
  const definitions = getTableColumns(table) as Record<string, { name: string }>;
  const set: Record<string, SQL> = {};
  for (const column of columns) {
    const definition = definitions[column];
    if (!definition) throw new Error(`no such column on ${getTableName(table)}: ${column}`);
    set[column] = sql`excluded.${sql.identifier(definition.name)}`;
  }
  return set as PgUpdateSetSource<T>;
}
