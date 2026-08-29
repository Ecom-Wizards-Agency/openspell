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
  assetId: AmazonId.nullable(),
  placement: Placement.nullable(),
  attributionState: CreativeAttributionState,
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
  assetId: AmazonId.nullable(),
  placement: Placement.nullable(),
  attributionState: CreativeAttributionState,
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
