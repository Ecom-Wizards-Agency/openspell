/**
 * Read-only Sponsored Brands ad and Creative Asset Library contract probe.
 *
 * Amazon's official Postman collection documents `POST /sb/v4/ads/list` and
 * `POST /assets/search`, but does not include a list-ads response example.
 * These parsers therefore fail closed. The client walks every continuation
 * page and aggregates the parsed pages without dropping a provider row.
 */
import type { AmazonId } from '@wizard-ads/shared';
import { AdsApiParseError } from './errors.js';
import { isRecord, readArray, readId, readNumber, readRecord, readString } from './read.js';

export const SB_AD_LIST_PATH = '/sb/v4/ads/list';
export const SB_AD_MEDIA_TYPE = 'application/vnd.sbadresource.v4+json';
export const CREATIVE_ASSET_SEARCH_PATH = '/assets/search';
export const CREATIVE_ASSET_SEARCH_MEDIA_TYPE =
  'application/vnd.creativeassetssearchassetsresponse.v3+json';

export interface SbAdNameFilter {
  include: readonly string[];
  queryTermMatchType?: 'BROAD_MATCH' | 'EXACT_MATCH';
}

export interface SbAdProbeOptions {
  /** Amazon caps the v4 list at 100. Larger values are clamped by the client. */
  maxResults?: number;
  stateFilter?: readonly string[];
  campaignIdFilter?: readonly AmazonId[];
  adGroupIdFilter?: readonly AmazonId[];
  adIdFilter?: readonly AmazonId[];
  nameFilter?: SbAdNameFilter;
}

export interface CreativeAssetValueFilter {
  valueField: string;
  values: readonly string[];
}

export interface CreativeAssetRange {
  start: string;
  end: string;
}

export interface CreativeAssetRangeFilter {
  rangeField?: string;
  range: readonly CreativeAssetRange[];
}

export interface CreativeAssetProbeOptions {
  text?: string;
  filterCriteria?: {
    valueFilters?: readonly CreativeAssetValueFilter[];
    rangeFilters?: readonly CreativeAssetRangeFilter[];
  };
  sortCriteria?: {
    field: string;
    order: 'ASC' | 'DESC';
  };
  /** Creative Asset Library pages accept 1 through 500 rows. */
  pageSize?: number;
}

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

function includeFilter(values: readonly string[] | undefined): { include: string[] } | undefined {
  return values === undefined || values.length === 0 ? undefined : { include: [...values] };
}

/** Build one Sponsored Brands ads page request without losing caller filters. */
export function buildSbAdProbeBody(
  options: SbAdProbeOptions,
  nextToken: string | null,
  maxResults: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = { maxResults };
  const stateFilter = includeFilter(options.stateFilter);
  const campaignIdFilter = includeFilter(options.campaignIdFilter);
  const adGroupIdFilter = includeFilter(options.adGroupIdFilter);
  const adIdFilter = includeFilter(options.adIdFilter);
  if (stateFilter !== undefined) body['stateFilter'] = stateFilter;
  if (campaignIdFilter !== undefined) body['campaignIdFilter'] = campaignIdFilter;
  if (adGroupIdFilter !== undefined) body['adGroupIdFilter'] = adGroupIdFilter;
  if (adIdFilter !== undefined) body['adIdFilter'] = adIdFilter;
  if (options.nameFilter !== undefined) body['nameFilter'] = options.nameFilter;
  if (nextToken !== null) body['nextToken'] = nextToken;
  return body;
}

/**
 * Build one Asset Library search request. Amazon's response token is carried
 * into the next request under `pageCriteria.identifier` together with the
 * zero-based page number; the original search/filter/sort inputs survive every
 * page.
 */
export function buildCreativeAssetProbeBody(
  options: CreativeAssetProbeOptions,
  nextToken: string | null,
  pageNumber: number,
  pageSize: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (options.text !== undefined) body['text'] = options.text;
  if (options.filterCriteria !== undefined) body['filterCriteria'] = options.filterCriteria;
  if (options.sortCriteria !== undefined) body['sortCriteria'] = options.sortCriteria;
  body['pageCriteria'] = {
    size: pageSize,
    ...(nextToken === null
      ? {}
      : { identifier: { pageNumber, token: nextToken } }),
  };
  return body;
}

function continuationToken(
  parsed: Record<string, unknown>,
  key: string,
  what: string,
): string | null {
  const raw = parsed[key];
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    throw new AdsApiParseError(`${what} has an invalid ${key} continuation token`);
  }
  return raw;
}

function advertisedTotal(
  parsed: Record<string, unknown>,
  key: string,
  pageRows: number,
  what: string,
): number | null {
  const raw = parsed[key];
  if (raw === undefined || raw === null) return null;
  const total = readNumber(parsed, key);
  if (total === null || !Number.isInteger(total) || total < pageRows || total < 0) {
    throw new AdsApiParseError(`${what} has an invalid ${key} count`);
  }
  return total;
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
  const totalResults = advertisedTotal(parsed, 'totalResults', values.length, SB_AD_LIST_PATH);
  return {
    items: values.map((value, index) => parseSbAdProbeRow(value, `${SB_AD_LIST_PATH} item ${index}`)),
    sourceRows: values.length,
    totalResults,
    nextToken: continuationToken(parsed, 'nextToken', SB_AD_LIST_PATH),
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
  const totalRecords = advertisedTotal(
    parsed,
    'totalRecords',
    values.length,
    CREATIVE_ASSET_SEARCH_PATH,
  );
  return {
    items: values.map((value, index) =>
      parseCreativeAssetProbeRow(value, `${CREATIVE_ASSET_SEARCH_PATH} item ${index}`)),
    sourceRows: values.length,
    totalRecords,
    nextToken: continuationToken(parsed, 'token', CREATIVE_ASSET_SEARCH_PATH),
  };
}
