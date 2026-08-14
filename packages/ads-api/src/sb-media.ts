/**
 * Sponsored Brands v4 media/creative seam.
 *
 * Creative Hub can compile against this interface now, while every runtime
 * method deliberately throws until the v4 media contract is implemented and
 * fixture-verified. No endpoint path is guessed here.
 */
import type { AmazonId } from '@wizard-ads/shared';

export type SbMediaType = 'IMAGE' | 'VIDEO';

export interface SbMediaUploadInput {
  name: string;
  mediaType: SbMediaType;
  contentType: string;
  fileName: string;
  bytes: Uint8Array;
}

export interface SbMediaAsset {
  mediaId: AmazonId;
  assetId: AmazonId | null;
  mediaType: SbMediaType;
  status: string;
  url: string | null;
}

export type SbCreativeType =
  | 'COLLECTION'
  | 'PRODUCT_COLLECTION'
  | 'VIDEO'
  | 'BRAND_VIDEO'
  | 'STORE_SPOTLIGHT';

export interface SbCreativeAssetRef {
  assetId: AmazonId;
  role: string;
}

export interface SbCreativeCreateInput {
  adGroupId: AmazonId;
  creativeType: SbCreativeType;
  assets: readonly SbCreativeAssetRef[];
  name?: string;
  headline?: string;
  landingPageUrl?: string;
  asins?: readonly string[];
}

/** Sparse patch; immutable creative changes require archive + recreate. */
export interface SbCreativeUpdateInput {
  creativeId: AmazonId;
  name?: string;
  state?: 'ENABLED' | 'PAUSED';
}

export interface SbCreative {
  creativeId: AmazonId;
  adGroupId: AmazonId;
  creativeType: SbCreativeType;
  state: string;
  assets: SbCreativeAssetRef[];
}

export interface SbV4MediaCreativeApi {
  uploadSbMedia(profileId: string, input: SbMediaUploadInput): Promise<SbMediaAsset>;
  getSbMedia(profileId: string, mediaId: AmazonId): Promise<SbMediaAsset>;
  createSbCreative(profileId: string, input: SbCreativeCreateInput): Promise<SbCreative>;
  updateSbCreative(profileId: string, input: SbCreativeUpdateInput): Promise<SbCreative>;
  archiveSbCreative(profileId: string, creativeId: AmazonId): Promise<void>;
}
