/** Contracts for authoritative ad-to-creative-to-asset attribution. */
import { z } from 'zod';
import { AdProduct, AmazonId, IsoDate, Placement, Uuid } from './primitives.js';

const count = z.number().int().nonnegative();
const money = z.number().nonnegative();

export const CreativeAttributionState = z.enum([
  'mapped',
  'legacy',
  'unsupported',
  'ambiguous',
  'unmapped',
]);
export type CreativeAttributionState = z.infer<typeof CreativeAttributionState>;

/**
 * A mapping observed on the current Sponsored Brands ad listing. This is
 * deliberately not named "historical": Amazon has not proved that a current
 * creative snapshot was valid on an earlier report date.
 */
export const CreativeMappingProvenance = z.enum(['current_sb_ad_snapshot']);
export type CreativeMappingProvenance = z.infer<typeof CreativeMappingProvenance>;

export const CreativeSyncSnapshotStatus = z.enum([
  'mapping_only',
  'report_pending',
  'completed',
  'blocked',
]);
export type CreativeSyncSnapshotStatus = z.infer<typeof CreativeSyncSnapshotStatus>;

/** Amazon Asset ID is the identity. A nullable content hash is never a key. */
export const CreativeAsset = z.object({
  profileId: Uuid,
  assetId: AmazonId,
  name: z.string().nullable(),
  assetType: z.string().min(1),
  contentHash: z.string().min(1).nullable(),
  thumbnailUrl: z.url().nullable(),
  amazonCreatedAt: z.iso.datetime().nullable().optional(),
  amazonUpdatedAt: z.iso.datetime().nullable().optional(),
});
export type CreativeAsset = z.infer<typeof CreativeAsset>;

/** Explicit placement mapping; an ad-group result is never assigned to one asset. */
export const AdCreativeAssetMapping = z.object({
  profileId: Uuid,
  adProduct: AdProduct,
  campaignId: AmazonId,
  adGroupId: AmazonId,
  adId: AmazonId,
  creativeId: AmazonId.nullable(),
  creativeVersion: z.string().min(1).nullable().default(null),
  assetId: AmazonId.nullable(),
  placement: Placement.nullable(),
  attributionState: CreativeAttributionState,
  mappingProvenance: CreativeMappingProvenance.nullable().default(null),
  creativeSyncSnapshotId: Uuid.nullable().default(null),
  observedAt: z.iso.datetime(),
});
export type AdCreativeAssetMapping = z.infer<typeof AdCreativeAssetMapping>;

export const CreativeDailyFact = z.object({
  profileId: Uuid,
  date: IsoDate,
  adProduct: AdProduct,
  campaignId: AmazonId,
  adGroupId: AmazonId,
  adId: AmazonId,
  creativeId: AmazonId.nullable(),
  creativeVersion: z.string().min(1).nullable().default(null),
  assetId: AmazonId.nullable(),
  placement: Placement.nullable(),
  attributionState: CreativeAttributionState,
  mappingProvenance: CreativeMappingProvenance.nullable().default(null),
  creativeSyncSnapshotId: Uuid.nullable().default(null),
  impressions: count,
  clicks: count,
  cost: money,
  purchases: count,
  sales: money,
  videoFirstQuartileViews: count.nullable(),
  videoMidpointViews: count.nullable(),
  videoThirdQuartileViews: count.nullable(),
  videoCompleteViews: count.nullable(),
});
export type CreativeDailyFact = z.infer<typeof CreativeDailyFact>;

/** Count reconciliation emitted by every creative ingestion batch. */
export const CreativeIngestionCounts = z.object({
  sourceAssets: count,
  parsedRows: count,
  mappedPlacements: count,
  unsupportedRows: count,
  refusedRows: count,
  upserts: count,
});
export type CreativeIngestionCounts = z.infer<typeof CreativeIngestionCounts>;

/**
 * Count-only evidence for one current SB ad/asset observation. Every parsed ad
 * belongs to exactly one coverage state; legacy rows without an ad ID stay in
 * the counts and never receive a fabricated identity.
 */
export const CreativeSyncSnapshot = z.object({
  id: Uuid,
  profileId: Uuid,
  startDate: IsoDate,
  endDate: IsoDate,
  observedAt: z.iso.datetime(),
  mappingProvenance: CreativeMappingProvenance,
  historicalValidity: z.literal('unproven_current_snapshot'),
  status: CreativeSyncSnapshotStatus,
  paginationComplete: z.boolean(),
  factPromotionAllowed: z.boolean(),
  sourceAssets: count,
  parsedAssets: count,
  sourceAds: count,
  parsedAds: count,
  mapped: count,
  legacy: count,
  unsupported: count,
  ambiguous: count,
  unmapped: count,
  reportSourceRows: count.nullable().default(null),
  reportParsedRows: count.nullable().default(null),
  reportRefusedRows: count.nullable().default(null),
  mappedFactRows: count,
  unpromotedReportRows: count,
}).superRefine((snapshot, context) => {
  const coverage = snapshot.mapped + snapshot.legacy + snapshot.unsupported
    + snapshot.ambiguous + snapshot.unmapped;
  if (coverage !== snapshot.parsedAds) {
    context.addIssue({
      code: 'custom',
      path: ['parsedAds'],
      message: `parsedAds ${snapshot.parsedAds} does not equal ${coverage} classified ads`,
    });
  }
  if (snapshot.parsedAssets > snapshot.sourceAssets || snapshot.parsedAds > snapshot.sourceAds) {
    context.addIssue({ code: 'custom', message: 'parsed counts cannot exceed source counts' });
  }
  if (
    snapshot.reportSourceRows !== null &&
    snapshot.reportParsedRows !== null &&
    snapshot.reportRefusedRows !== null &&
    snapshot.reportSourceRows !== snapshot.reportParsedRows + snapshot.reportRefusedRows
  ) {
    context.addIssue({ code: 'custom', message: 'report source counts do not reconcile' });
  }
  const reportCounts = [
    snapshot.reportSourceRows,
    snapshot.reportParsedRows,
    snapshot.reportRefusedRows,
  ];
  if (reportCounts.some((value) => value === null) && reportCounts.some((value) => value !== null)) {
    context.addIssue({ code: 'custom', message: 'report counts must be all present or all absent' });
  }
  if (
    reportCounts.every((value) => value === null) &&
    (snapshot.mappedFactRows !== 0 || snapshot.unpromotedReportRows !== 0)
  ) {
    context.addIssue({ code: 'custom', message: 'promotion counts require report counts' });
  }
  if (
    snapshot.reportParsedRows !== null &&
    snapshot.mappedFactRows + snapshot.unpromotedReportRows !== snapshot.reportParsedRows
  ) {
    context.addIssue({ code: 'custom', message: 'report promotion counts do not reconcile' });
  }
});
export type CreativeSyncSnapshot = z.infer<typeof CreativeSyncSnapshot>;
