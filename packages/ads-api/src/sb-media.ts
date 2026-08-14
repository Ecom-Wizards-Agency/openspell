/**
 * Sponsored Brands v4 media and creative contracts.
 *
 * Media is uploaded through Amazon's Creative Asset Library seam, then the
 * returned asset id is referenced by an SB v4 creative. Creative create and
 * update are indexed multi-status operations: every submitted index must
 * appear exactly once under success or error, including HTTP 207 responses.
 */
import type { AmazonId } from '@wizard-ads/shared';
import { AdsApiParseError } from './errors.js';
import { isRecord, readArray, readId, readNumber, readRecord, readRecordArray, readString } from './read.js';

export const SB_MEDIA_UPLOAD_PATH = '/media/upload';
export const SB_MEDIA_DESCRIBE_PATH = '/media/describe';
export const SB_CREATIVE_PATH = '/sb/v4/creatives';
export const SB_CREATIVE_LIST_PATH = '/sb/v4/creatives/list';
export const SB_CREATIVE_MEDIA_TYPE = 'application/vnd.sbcreativeresource.v4+json';
export const SB_CREATIVE_BATCH_SIZE = 100;
export const SB_MEDIA_MULTIPART_BOUNDARY = 'wizard-ads-sb-media-boundary';

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
  raw: Record<string, unknown>;
}

export interface SbMediaUploadBody {
  contentType: string;
  body: ArrayBuffer;
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
  name: string | null;
  headline: string | null;
  landingPageUrl: string | null;
  asins: string[];
  raw: Record<string, unknown>;
}

export interface SbCreativeMutationItem {
  index: number;
  creativeId: AmazonId;
  /** Null when Amazon returns only the id despite `return=representation`. */
  creative: SbCreative | null;
  raw: Record<string, unknown>;
}

export interface SbCreativeMutationError {
  index: number;
  code: string | null;
  details: string | null;
  raw: Record<string, unknown>;
}

export interface SbCreativeBatchResult {
  items: SbCreativeMutationItem[];
  errors: SbCreativeMutationError[];
  submitted: number;
  batches: number;
}

export interface SbCreativeListOptions {
  maxResults?: number;
  maxPages?: number;
  nextToken?: string;
  stateFilter?: readonly string[];
  adGroupIdFilter?: readonly AmazonId[];
}

export interface SbCreativeListResult {
  items: SbCreative[];
  pages: number;
  truncated: boolean;
  nextToken: string | null;
}

export interface SbV4MediaCreativeApi {
  uploadSbMedia(profileId: string, input: SbMediaUploadInput): Promise<SbMediaAsset>;
  getSbMedia(profileId: string, mediaId: AmazonId): Promise<SbMediaAsset>;
  createSbCreative(profileId: string, input: SbCreativeCreateInput): Promise<SbCreative>;
  updateSbCreative(profileId: string, input: SbCreativeUpdateInput): Promise<SbCreative>;
  createSbCreatives(profileId: string, inputs: readonly SbCreativeCreateInput[]): Promise<SbCreativeBatchResult>;
  updateSbCreatives(profileId: string, inputs: readonly SbCreativeUpdateInput[]): Promise<SbCreativeBatchResult>;
  listSbCreatives(profileId: string, options?: SbCreativeListOptions): Promise<SbCreativeListResult>;
  archiveSbCreative(profileId: string, creativeId: AmazonId): Promise<void>;
}

function safeDisposition(value: string): string {
  return value.replace(/[\r\n"]/g, '_');
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

/** Build the exact multipart body; no FormData dependency or implicit boundary mutation. */
export function buildSbMediaUploadBody(input: SbMediaUploadInput): SbMediaUploadBody {
  const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
  const field = (name: string, value: string): Uint8Array =>
    encode(
      `--${SB_MEDIA_MULTIPART_BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
        `${value}\r\n`,
    );
  const fileHeader = encode(
    `--${SB_MEDIA_MULTIPART_BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeDisposition(input.fileName)}"\r\n` +
      `Content-Type: ${input.contentType}\r\n\r\n`,
  );
  const closing = encode(`\r\n--${SB_MEDIA_MULTIPART_BOUNDARY}--\r\n`);
  return {
    contentType: `multipart/form-data; boundary=${SB_MEDIA_MULTIPART_BOUNDARY}`,
    body: concatBytes([
      field('name', input.name),
      field('mediaType', input.mediaType),
      fileHeader,
      new Uint8Array(input.bytes),
      closing,
    ]).buffer as ArrayBuffer,
  };
}

function mediaType(value: string | null, fallback?: SbMediaType): SbMediaType | null {
  const upper = value?.toUpperCase();
  if (upper === 'IMAGE' || upper === 'VIDEO') return upper;
  return fallback ?? null;
}

export function parseSbMediaAsset(
  parsed: unknown,
  what: string,
  fallbackType?: SbMediaType,
): SbMediaAsset {
  if (!isRecord(parsed)) throw new AdsApiParseError(`${what} returned no object`);
  const row = readRecord(parsed, 'media') ?? parsed;
  const mediaId = readId(row, 'mediaId');
  const resolvedType = mediaType(readString(row, 'mediaType') ?? readString(row, 'type'), fallbackType);
  const status = readString(row, 'status') ?? readString(row, 'mediaStatus');
  if (mediaId === null || resolvedType === null || status === null) {
    throw new AdsApiParseError(`${what} response is missing mediaId, mediaType, or status`);
  }
  return {
    mediaId,
    assetId: readId(row, 'assetId'),
    mediaType: resolvedType,
    status,
    url: readString(row, 'url') ?? readString(row, 'previewUrl'),
    raw: row,
  };
}

export function batchSbCreatives<T>(inputs: readonly T[]): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < inputs.length; index += SB_CREATIVE_BATCH_SIZE) {
    batches.push(inputs.slice(index, index + SB_CREATIVE_BATCH_SIZE));
  }
  return batches;
}

export function buildSbCreativeMutationBody(inputs: readonly unknown[]): Record<string, unknown> {
  return { creatives: [...inputs] };
}

export function buildSbCreativeListBody(
  maxResults: number,
  nextToken: string | null,
  options: Pick<SbCreativeListOptions, 'stateFilter' | 'adGroupIdFilter'>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { maxResults };
  if (nextToken !== null) body['nextToken'] = nextToken;
  if (options.stateFilter !== undefined && options.stateFilter.length > 0) {
    body['stateFilter'] = { include: [...options.stateFilter] };
  }
  if (options.adGroupIdFilter !== undefined && options.adGroupIdFilter.length > 0) {
    body['adGroupIdFilter'] = { include: [...options.adGroupIdFilter] };
  }
  return body;
}

function parseAssets(row: Record<string, unknown>, what: string): SbCreativeAssetRef[] {
  const raw = readArray(row, 'assets');
  if (raw === null) throw new AdsApiParseError(`${what} has no assets array`);
  return raw.map((value, index) => {
    if (!isRecord(value)) throw new AdsApiParseError(`${what} asset ${index} is not an object`);
    const asset = value;
    const assetId = readId(asset, 'assetId');
    const role = readString(asset, 'role');
    if (assetId === null || role === null) {
      throw new AdsApiParseError(`${what} asset ${index} is missing assetId or role`);
    }
    return { assetId, role };
  });
}

function parseCreativeType(value: string | null): SbCreativeType | null {
  switch (value?.toUpperCase()) {
    case 'COLLECTION':
    case 'PRODUCT_COLLECTION':
    case 'VIDEO':
    case 'BRAND_VIDEO':
    case 'STORE_SPOTLIGHT':
      return value.toUpperCase() as SbCreativeType;
    default:
      return null;
  }
}

export function parseSbCreative(parsed: unknown, what: string): SbCreative {
  if (!isRecord(parsed)) throw new AdsApiParseError(`${what} is not an object`);
  const creativeId = readId(parsed, 'creativeId');
  const adGroupId = readId(parsed, 'adGroupId');
  const creativeType = parseCreativeType(readString(parsed, 'creativeType'));
  const state = readString(parsed, 'state');
  if (creativeId === null || adGroupId === null || creativeType === null || state === null) {
    throw new AdsApiParseError(`${what} is missing creativeId, adGroupId, creativeType, or state`);
  }
  const rawAsins = parsed['asins'];
  if (rawAsins !== undefined && (!Array.isArray(rawAsins) || rawAsins.some((asin) => typeof asin !== 'string'))) {
    throw new AdsApiParseError(`${what} has an invalid asins array`);
  }
  const asins = rawAsins === undefined ? [] : rawAsins as string[];
  return {
    creativeId,
    adGroupId,
    creativeType,
    state,
    assets: parseAssets(parsed, what),
    name: readString(parsed, 'name'),
    headline: readString(parsed, 'headline'),
    landingPageUrl: readString(parsed, 'landingPageUrl'),
    asins,
    raw: parsed,
  };
}

function requiredIndex(row: Record<string, unknown>, what: string): number {
  const index = readNumber(row, 'index');
  if (index === null || !Number.isInteger(index) || index < 0) {
    throw new AdsApiParseError(`${what} item has no non-negative integer index`);
  }
  return index;
}

export function parseSbCreativeMutationResponse(
  parsed: unknown,
  submitted: number,
  indexOffset = 0,
): SbCreativeBatchResult {
  if (!isRecord(parsed)) throw new AdsApiParseError(`${SB_CREATIVE_PATH} response is not an object`);
  const envelope = readRecord(parsed, 'creatives');
  if (envelope === null) throw new AdsApiParseError(`${SB_CREATIVE_PATH} response has no creatives object`);
  const success = readRecordArray(envelope, 'success');
  const singular = readRecordArray(envelope, 'error');
  const failures = singular.length === 0 ? readRecordArray(envelope, 'errors') : singular;
  const seen = new Set<number>();
  const what = `${SB_CREATIVE_PATH} response`;

  const items = success.map((row): SbCreativeMutationItem => {
    const index = requiredIndex(row, what);
    if (index >= submitted || seen.has(index)) {
      throw new AdsApiParseError(`${what} repeats or exceeds submitted index ${index}`);
    }
    seen.add(index);
    const representation = readRecord(row, 'creative');
    const creativeId = readId(row, 'creativeId') ?? (representation === null ? null : readId(representation, 'creativeId'));
    if (creativeId === null) throw new AdsApiParseError(`${what} success index ${index} has no creativeId`);
    return {
      index: indexOffset + index,
      creativeId,
      creative: representation === null ? null : parseSbCreative(representation, `${what} success index ${index}`),
      raw: row,
    };
  });

  const errors = failures.map((row): SbCreativeMutationError => {
    const index = requiredIndex(row, what);
    if (index >= submitted || seen.has(index)) {
      throw new AdsApiParseError(`${what} repeats or exceeds submitted index ${index}`);
    }
    seen.add(index);
    const nested = readRecordArray(row, 'errors')[0];
    return {
      index: indexOffset + index,
      code: readString(row, 'code') ?? (nested === undefined ? null : readString(nested, 'errorType')),
      details:
        readString(row, 'details') ??
        readString(row, 'message') ??
        (nested === undefined ? null : readString(nested, 'message')),
      raw: row,
    };
  });

  if (items.length + errors.length !== submitted || seen.size !== submitted) {
    throw new AdsApiParseError(`${what} accounted for ${items.length + errors.length} of ${submitted} submitted items`);
  }
  return { items, errors, submitted, batches: submitted === 0 ? 0 : 1 };
}

export function parseSbCreativeListPage(parsed: unknown): {
  items: SbCreative[];
  nextToken: string | null;
} {
  if (!isRecord(parsed)) throw new AdsApiParseError(`${SB_CREATIVE_LIST_PATH} response is not an object`);
  const values = readArray(parsed, 'creatives');
  if (values === null) throw new AdsApiParseError(`${SB_CREATIVE_LIST_PATH} response has no creatives array`);
  const rows = values.map((value, index) => {
    if (!isRecord(value)) {
      throw new AdsApiParseError(`${SB_CREATIVE_LIST_PATH} item ${index} is not an object`);
    }
    return value;
  });
  return {
    items: rows.map((row, index) => parseSbCreative(row, `${SB_CREATIVE_LIST_PATH} item ${index}`)),
    nextToken: readString(parsed, 'nextToken'),
  };
}
