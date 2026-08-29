/**
 * Read-only Sponsored Brands ad and Creative Asset Library contract probe.
 *
 * Amazon's official Postman collection documents `POST /sb/v4/ads/list` and
 * `POST /assets/search`, but does not include a list-ads response example.
 * These parsers therefore fail closed and are intentionally page-scoped: a
 * live probe can prove the current response shape without writing or silently
 * normalizing an unexpected payload into production attribution.
 */
import type { AmazonId } from '@wizard-ads/shared';
import { AdsApiParseError } from './errors.js';
import { isRecord, readArray, readId, readNumber, readRecord, readString } from './read.js';

export const SB_AD_LIST_PATH = '/sb/v4/ads/list';
export const SB_AD_MEDIA_TYPE = 'application/vnd.sbadresource.v4+json';
export const CREATIVE_ASSET_SEARCH_PATH = '/assets/search';

export interface SbAdAssetReference {
  /** The exact reference returned on the ad creative, including a version suffix when present. */
  referenceId: AmazonId;
  /** Stable Amazon Asset ID used for joins to the asset library. */
  assetId: AmazonId;
  version: string | null;
  /** Legacy media ids remain visible and are never treated as Asset Library identities. */
  kind: 'asset_library' | 'legacy_media';
}

export interface SbAdProbeRow {
  adId: AmazonId | null;
  campaignId: AmazonId;
  adGroupId: AmazonId;
  creativePresent: boolean;
  creativeVersion: string | null;
  creativeType: string | null;
  name: string | null;
  state: string | null;
  videoAssets: SbAdAssetReference[];
  asins: string[];
  raw: Record<string, unknown>;
}

export interface SbAdProbePage {
  items: SbAdProbeRow[];
  sourceRows: number;
  totalResults: number | null;
  nextToken: string | null;
}

export interface CreativeAssetProbeRow {
  assetId: AmazonId;
  version: string | null;
  assetType: string;
  name: string | null;
  status: string | null;
  contentHash: string | null;
  defaultUrl: string | null;
  thumbnailUrl: string | null;
  raw: Record<string, unknown>;
}

export interface CreativeAssetProbePage {
  items: CreativeAssetProbeRow[];
  sourceRows: number;
  totalRecords: number | null;
  nextToken: string | null;
}

function stringArray(row: Record<string, unknown>, key: string, what: string): string[] {
  const value = row[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new AdsApiParseError(`${what} has an invalid ${key} array`);
  }
  return value;
}

function optionalId(row: Record<string, unknown>, key: string, what: string): AmazonId | null {
  if (row[key] === undefined) return null;
  const value = readId(row, key);
  if (value === null) throw new AdsApiParseError(`${what} has an invalid ${key}`);
  return value;
}

/** Split only Amazon's explicit version suffix; never truncate an arbitrary Asset ID. */
export function parseSbAssetReference(referenceId: string): SbAdAssetReference {
  const marker = referenceId.lastIndexOf(':version_');
  const kind = referenceId.startsWith('amzn1.assetlibrary.asset1.')
    ? 'asset_library'
    : 'legacy_media';
  if (marker <= 0) return { referenceId, assetId: referenceId, version: null, kind };
  const version = referenceId.slice(marker + 1);
  if (version.length <= 'version_'.length) {
    return { referenceId, assetId: referenceId, version: null, kind };
  }
  return { referenceId, assetId: referenceId.slice(0, marker), version, kind };
}

export function parseSbAdProbeRow(parsed: unknown, what: string): SbAdProbeRow {
  if (!isRecord(parsed)) throw new AdsApiParseError(`${what} is not an object`);
  const adId = optionalId(parsed, 'adId', what);
  const campaignId = readId(parsed, 'campaignId');
  const adGroupId = readId(parsed, 'adGroupId');
  const creative = readRecord(parsed, 'creative');
  if (parsed['creative'] !== undefined && creative === null) {
    throw new AdsApiParseError(`${what} has an invalid creative`);
  }
  const state = readString(parsed, 'state');
  if (campaignId === null || adGroupId === null || state === null) {
    throw new AdsApiParseError(`${what} is missing campaignId, adGroupId, or state`);
  }
  const videoAssetIds = creative === null
    ? []
    : stringArray(creative, 'videoAssetIds', `${what} creative`);
  return {
    adId,
    campaignId,
    adGroupId,
    creativePresent: creative !== null,
    creativeVersion: creative === null ? null : readString(creative, 'creativeVersion'),
    creativeType: creative === null ? null : readString(creative, 'type'),
    name: readString(parsed, 'name'),
    state,
    videoAssets: videoAssetIds.map(parseSbAssetReference),
    asins: creative === null ? [] : stringArray(creative, 'asins', `${what} creative`),
    raw: parsed,
  };
}

export function parseSbAdProbePage(parsed: unknown): SbAdProbePage {
  if (!isRecord(parsed)) throw new AdsApiParseError(`${SB_AD_LIST_PATH} response is not an object`);
  const values = readArray(parsed, 'ads');
  if (values === null) throw new AdsApiParseError(`${SB_AD_LIST_PATH} response has no ads array`);
  const totalResults = readNumber(parsed, 'totalResults');
  if (totalResults !== null && (!Number.isInteger(totalResults) || totalResults < values.length)) {
    throw new AdsApiParseError(`${SB_AD_LIST_PATH} has an invalid totalResults count`);
  }
  return {
    items: values.map((value, index) => parseSbAdProbeRow(value, `${SB_AD_LIST_PATH} item ${index}`)),
    sourceRows: values.length,
    totalResults,
    nextToken: readString(parsed, 'nextToken'),
  };
}

function processedThumbnail(storage: Record<string, unknown> | null): string | null {
  if (storage === null) return null;
  const processed = readRecord(storage, 'processedUrls');
  if (processed === null) return null;
  const preferred = [
    'IMAGE_THUMBNAIL_500',
    'VIDEO_DEFAULT_OPTIMIZED',
    'PRODUCT_VIDEO_OPTIMIZED',
  ];
  for (const key of preferred) {
    const value = readString(processed, key);
    if (value !== null) return value;
  }
  return null;
}

export function parseCreativeAssetProbeRow(parsed: unknown, what: string): CreativeAssetProbeRow {
  if (!isRecord(parsed)) throw new AdsApiParseError(`${what} is not an object`);
  const assetId = readId(parsed, 'assetId');
  const assetType = readString(parsed, 'assetType');
  if (assetId === null || assetType === null) {
    throw new AdsApiParseError(`${what} is missing assetId or assetType`);
  }
  const fileMetadata = readRecord(parsed, 'fileMetadata');
  const storage = readRecord(parsed, 'storageLocationUrls');
  return {
    assetId,
    version: readString(parsed, 'version'),
    assetType,
    name: readString(parsed, 'name'),
    status: readString(parsed, 'status'),
    contentHash: fileMetadata === null ? null : readString(fileMetadata, 'contentHash'),
    defaultUrl: storage === null ? null : readString(storage, 'defaultUrl'),
    thumbnailUrl: processedThumbnail(storage),
    raw: parsed,
  };
}

export function parseCreativeAssetProbePage(parsed: unknown): CreativeAssetProbePage {
  if (!isRecord(parsed)) {
    throw new AdsApiParseError(`${CREATIVE_ASSET_SEARCH_PATH} response is not an object`);
  }
  const values = readArray(parsed, 'assetList');
  if (values === null) {
    throw new AdsApiParseError(`${CREATIVE_ASSET_SEARCH_PATH} response has no assetList array`);
  }
  const totalRecords = readNumber(parsed, 'totalRecords');
  if (totalRecords !== null && (!Number.isInteger(totalRecords) || totalRecords < values.length)) {
    throw new AdsApiParseError(`${CREATIVE_ASSET_SEARCH_PATH} has an invalid totalRecords count`);
  }
  return {
    items: values.map((value, index) =>
      parseCreativeAssetProbeRow(value, `${CREATIVE_ASSET_SEARCH_PATH} item ${index}`)),
    sourceRows: values.length,
    totalRecords,
    nextToken: readString(parsed, 'token'),
  };
}
