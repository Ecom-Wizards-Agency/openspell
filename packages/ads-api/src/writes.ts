/**
 * Sponsored Products v3 mutation contracts.
 *
 * Amazon's write APIs are multi-status batch operations. A 207 is not an
 * all-success response: each submitted index appears under either `success`
 * or `error`. The parser below treats that accounting rule as part of the
 * protocol, so a renamed or dropped response field fails loudly instead of
 * looking like an empty successful write.
 */
import type { AmazonId } from '@wizard-ads/shared';
import { AdsApiParseError } from './errors.js';
import type { SpWriteEndpoint, SpWriteKind } from './endpoints.js';
import { isRecord, readId, readNumber, readRecord, readRecordArray, readString } from './read.js';

export const SP_WRITE_BATCH_SIZE = 100;

export type SpEntityState = 'ENABLED' | 'PAUSED';
export type SpKeywordMatchType = 'BROAD' | 'PHRASE' | 'EXACT';
export type SpNegativeKeywordMatchType = 'NEGATIVE_EXACT' | 'NEGATIVE_PHRASE';
export type SpTargetExpressionType = 'AUTO' | 'MANUAL';

export interface SpBudget {
  budget: number;
  budgetType: 'DAILY' | 'LIFETIME';
}

export interface SpPlacementBidAdjustment {
  placement:
    | 'PLACEMENT_TOP'
    | 'PLACEMENT_PRODUCT_PAGE'
    | 'PLACEMENT_REST_OF_SEARCH'
    | 'SITE_AMAZON_BUSINESS';
  percentage: number;
}

export interface SpShopperCohortBidAdjustment {
  shopperCohortType: string;
  percentage: number;
  audienceSegments?: readonly { audienceId: string; audienceSegmentType: string }[];
}

export interface SpDynamicBidding {
  strategy: 'LEGACY_FOR_SALES' | 'AUTO_FOR_SALES' | 'MANUAL' | 'RULE_BASED';
  placementBidding?: readonly SpPlacementBidAdjustment[];
  shopperCohortBidding?: readonly SpShopperCohortBidAdjustment[];
}

/**
 * Campaign-level control behind the bulk-sheet `Sites` column.
 *
 * Amazon introduced this enum independently of the original v3 contract and
 * can add values without a version bump, so the wire value remains a string.
 * Callers still cannot accidentally put it at the campaign root: the required
 * `offAmazonBudgetControlStrategy` property mirrors the API object exactly.
 */
export interface SpOffAmazonSettings {
  offAmazonBudgetControlStrategy: string;
}

export type SpSiteRestriction = 'AMAZON_BUSINESS' | 'AMAZON_HAUL';

export interface SpCampaignCreateInput {
  name: string;
  targetingType: 'MANUAL' | 'AUTO';
  state: SpEntityState;
  budget: SpBudget;
  startDate?: string;
  endDate?: string;
  portfolioId?: AmazonId;
  dynamicBidding?: SpDynamicBidding;
  offAmazonSettings?: SpOffAmazonSettings;
  /** Site selection is immutable after campaign creation. */
  siteRestrictions?: readonly SpSiteRestriction[];
  tags?: Readonly<Record<string, string>>;
  autoManageCampaign?: boolean;
}

/** Sparse patch. Omitted properties are not sent and remain unchanged. */
export interface SpCampaignUpdateInput {
  campaignId: AmazonId;
  name?: string;
  state?: SpEntityState;
  budget?: SpBudget;
  startDate?: string;
  endDate?: string;
  portfolioId?: AmazonId;
  dynamicBidding?: SpDynamicBidding;
  offAmazonSettings?: SpOffAmazonSettings;
  tags?: Readonly<Record<string, string>>;
  autoManageCampaign?: boolean;
}

/** A focused campaign patch for placement and off-Amazon controls. */
export interface SpCampaignPlacementUpdateInput {
  campaignId: AmazonId;
  strategy: SpDynamicBidding['strategy'];
  placementBidding: readonly SpPlacementBidAdjustment[];
  offAmazonSettings?: SpOffAmazonSettings;
}

export interface SpAdGroupCreateInput {
  campaignId: AmazonId;
  name: string;
  state: SpEntityState;
  defaultBid?: number;
}

export interface SpAdGroupUpdateInput {
  adGroupId: AmazonId;
  name?: string;
  state?: SpEntityState;
  defaultBid?: number;
}

export interface SpKeywordCreateInput {
  campaignId: AmazonId;
  adGroupId: AmazonId;
  keywordText: string;
  matchType: SpKeywordMatchType;
  state: SpEntityState;
  bid?: number;
  nativeLanguageKeyword?: string;
  nativeLanguageLocale?: string;
}

/** Keyword text and match type are immutable; archive and recreate to change either. */
export interface SpKeywordUpdateInput {
  keywordId: AmazonId;
  state?: SpEntityState;
  bid?: number;
}

export interface SpTargetExpression {
  type: string;
  value?: string;
}

export interface SpTargetCreateInput {
  campaignId: AmazonId;
  adGroupId: AmazonId;
  expression: readonly SpTargetExpression[];
  expressionType: SpTargetExpressionType;
  state: SpEntityState;
  bid?: number;
}

/** Target expressions are immutable; archive and recreate to change an expression. */
export interface SpTargetUpdateInput {
  targetId: AmazonId;
  state?: SpEntityState;
  bid?: number;
}

export interface SpNegativeKeywordCreateInput {
  campaignId: AmazonId;
  adGroupId: AmazonId;
  keywordText: string;
  matchType: SpNegativeKeywordMatchType;
  state: SpEntityState;
}

export interface SpNegativeKeywordUpdateInput {
  keywordId: AmazonId;
  state?: SpEntityState;
}

export interface SpCampaignNegativeKeywordCreateInput {
  campaignId: AmazonId;
  keywordText: string;
  matchType: SpNegativeKeywordMatchType;
  state: SpEntityState;
}

/** Campaign negative keywords cannot be paused; archive them instead. */
export interface SpCampaignNegativeKeywordUpdateInput {
  keywordId: AmazonId;
  state?: SpEntityState;
}

export interface SpNegativeTargetCreateInput {
  campaignId: AmazonId;
  adGroupId: AmazonId;
  expression: readonly SpTargetExpression[];
  state: SpEntityState;
}

export interface SpNegativeTargetUpdateInput {
  targetId: AmazonId;
  state?: SpEntityState;
  expression?: readonly SpTargetExpression[];
}

export interface SpCampaignNegativeTargetCreateInput {
  campaignId: AmazonId;
  expression: readonly SpTargetExpression[];
  state: SpEntityState;
}

export interface SpCampaignNegativeTargetUpdateInput {
  targetId: AmazonId;
  state?: SpEntityState;
  expression?: readonly SpTargetExpression[];
}

interface ProductIdentityBySku {
  sku: string;
  asin?: never;
}

interface ProductIdentityByAsin {
  asin: string;
  sku?: never;
}

export type SpProductAdCreateInput = {
  campaignId: AmazonId;
  adGroupId: AmazonId;
  state: SpEntityState;
} & (ProductIdentityBySku | ProductIdentityByAsin);

/** SKU and ASIN are immutable; archive and recreate to advertise another product. */
export interface SpProductAdUpdateInput {
  adId: AmazonId;
  state?: SpEntityState;
}

export interface SpWriteItem<K extends SpWriteKind = SpWriteKind> {
  kind: K;
  /** Zero-based index in the caller's entire submitted array, across HTTP batches. */
  index: number;
  id: AmazonId;
  /** Present when Amazon honors `Prefer: return=representation`; null otherwise. */
  entity: Record<string, unknown> | null;
  raw: Record<string, unknown>;
}

export interface SpWriteErrorDetail {
  errorType: string | null;
  errorValue: unknown;
}

export interface SpWriteError<K extends SpWriteKind = SpWriteKind> {
  kind: K;
  /** Zero-based index in the caller's entire submitted array, across HTTP batches. */
  index: number;
  code: string | null;
  details: string | null;
  errors: SpWriteErrorDetail[];
  raw: Record<string, unknown>;
}

export interface SpBatchWriteResult<K extends SpWriteKind = SpWriteKind> {
  items: SpWriteItem<K>[];
  errors: SpWriteError<K>[];
  submitted: number;
  /** Number of HTTP batches used. */
  batches: number;
}

export function batchSpWrites<T>(items: readonly T[]): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += SP_WRITE_BATCH_SIZE) {
    batches.push(items.slice(index, index + SP_WRITE_BATCH_SIZE));
  }
  return batches;
}

export function buildSpWriteBody(
  endpoint: SpWriteEndpoint,
  items: readonly unknown[],
): Record<string, unknown> {
  return { [endpoint.requestKey]: [...items] };
}

export function buildSpArchiveBody(
  endpoint: SpWriteEndpoint,
  ids: readonly AmazonId[],
): Record<string, unknown> {
  return { [endpoint.idFilterKey]: { include: [...ids] } };
}

function requiredIndex(row: Record<string, unknown>, what: string): number {
  const index = readNumber(row, 'index');
  if (index === null || !Number.isInteger(index) || index < 0) {
    throw new AdsApiParseError(`${what} item has no non-negative integer index`);
  }
  return index;
}

function parseErrorDetails(row: Record<string, unknown>): SpWriteErrorDetail[] {
  return readRecordArray(row, 'errors').map((detail) => ({
    errorType: readString(detail, 'errorType') ?? readString(detail, 'code'),
    errorValue: detail['errorValue'] ?? detail['details'] ?? detail['message'] ?? null,
  }));
}

/** Parse one Amazon batch and prove that every submitted index was returned exactly once. */
export function parseSpWriteResponse<K extends SpWriteKind>(
  parsed: unknown,
  kind: K,
  endpoint: SpWriteEndpoint,
  submitted: number,
  indexOffset = 0,
): SpBatchWriteResult<K> {
  if (!isRecord(parsed)) {
    throw new AdsApiParseError(`${endpoint.path} write response is not an object`);
  }
  const envelope = readRecord(parsed, endpoint.responseKey);
  if (envelope === null) {
    throw new AdsApiParseError(
      `${endpoint.path} write response has no '${endpoint.responseKey}' object`,
    );
  }
  const success = readRecordArray(envelope, 'success');
  const singularErrors = readRecordArray(envelope, 'error');
  const pluralErrors = singularErrors.length === 0 ? readRecordArray(envelope, 'errors') : [];
  const failures = singularErrors.length === 0 ? pluralErrors : singularErrors;
  const what = `${endpoint.path} write response`;

  const localIndexes = new Set<number>();
  const items: SpWriteItem<K>[] = success.map((row) => {
    const localIndex = requiredIndex(row, what);
    if (localIndex >= submitted || localIndexes.has(localIndex)) {
      throw new AdsApiParseError(`${what} repeats or exceeds submitted index ${localIndex}`);
    }
    localIndexes.add(localIndex);
    const id = readId(row, endpoint.idKey);
    if (id === null) throw new AdsApiParseError(`${what} success index ${localIndex} has no ${endpoint.idKey}`);
    const representation = row[endpoint.entityKey];
    return {
      kind,
      index: indexOffset + localIndex,
      id,
      entity: isRecord(representation) ? representation : null,
      raw: row,
    };
  });

  const errors: SpWriteError<K>[] = failures.map((row) => {
    const localIndex = requiredIndex(row, what);
    if (localIndex >= submitted || localIndexes.has(localIndex)) {
      throw new AdsApiParseError(`${what} repeats or exceeds submitted index ${localIndex}`);
    }
    localIndexes.add(localIndex);
    const nested = parseErrorDetails(row);
    return {
      kind,
      index: indexOffset + localIndex,
      code: readString(row, 'code') ?? nested[0]?.errorType ?? null,
      details: readString(row, 'details') ?? readString(row, 'message'),
      errors: nested,
      raw: row,
    };
  });

  if (items.length + errors.length !== submitted || localIndexes.size !== submitted) {
    throw new AdsApiParseError(
      `${what} accounted for ${items.length + errors.length} of ${submitted} submitted items`,
    );
  }
  for (let index = 0; index < submitted; index += 1) {
    if (!localIndexes.has(index)) {
      throw new AdsApiParseError(`${what} omitted submitted index ${index}`);
    }
  }

  return { items, errors, submitted, batches: submitted === 0 ? 0 : 1 };
}
