/**
 * Sponsored Products suggested-bid reads.
 *
 * Amazon exposes keyword and product-target recommendations as separate read
 * resources even though both are POSTs. They are described as reads here (and
 * sent with `idempotent: true` by the client): fetching a daily corridor must
 * be safe to retry on a transport failure or 5xx.
 *
 * The target route is the current Ads API route documented by Amazon's manual
 * Sponsored Products workflow. Keeping both routes and media types in this
 * table prevents the v2 camel-case spelling from leaking back into callers.
 */
import type { AmazonId } from '@wizard-ads/shared';
import { AdsApiParseError } from './errors.js';
import { isRecord, readId, readNumber, readRecord, readRecordArray, readString } from './read.js';

export type SpBidRecommendationKind = 'keywords' | 'targets';

export interface SpBidRecommendationEndpoint {
  path: string;
  mediaType: string;
  requestKey: 'keywordIds' | 'targetIds';
  idKey: 'keywordId' | 'targetId';
}

export const SP_BID_RECOMMENDATION_ENDPOINTS: Readonly<
  Record<SpBidRecommendationKind, SpBidRecommendationEndpoint>
> = {
  keywords: {
    path: '/sp/keywords/bid/recommendations',
    mediaType: 'application/vnd.spKeywordBidRecommendation.v3+json',
    requestKey: 'keywordIds',
    idKey: 'keywordId',
  },
  targets: {
    path: '/sp/targets/bid/recommendations',
    mediaType: 'application/vnd.spTargetingClauseBidRecommendation.v3+json',
    requestKey: 'targetIds',
    idKey: 'targetId',
  },
};

/** Amazon caps the recommendation reads at the same 100-item batch size as SP writes. */
export const SP_BID_RECOMMENDATION_BATCH_SIZE = 100;

export interface SpSuggestedBid {
  kind: SpBidRecommendationKind;
  /** Zero-based index in the caller's entire submitted id array. */
  index: number;
  targetId: AmazonId;
  /** Low edge of Amazon's currently suggested corridor. */
  low: number;
  /** The 50th-percentile point, retained separately from Amazon's chosen suggestion. */
  median: number;
  /** High edge of Amazon's currently suggested corridor. */
  high: number;
  suggestedBid: number;
  raw: Record<string, unknown>;
}

export interface SpBidRecommendationError {
  kind: SpBidRecommendationKind;
  /** Zero-based index in the caller's entire submitted id array. */
  index: number;
  targetId: AmazonId;
  code: string | null;
  details: string | null;
  raw: Record<string, unknown>;
}

export interface SpBidRecommendationResult {
  items: SpSuggestedBid[];
  errors: SpBidRecommendationError[];
  submitted: number;
  batches: number;
}

export function batchSpBidRecommendationIds(ids: readonly AmazonId[]): AmazonId[][] {
  const batches: AmazonId[][] = [];
  for (let index = 0; index < ids.length; index += SP_BID_RECOMMENDATION_BATCH_SIZE) {
    batches.push(ids.slice(index, index + SP_BID_RECOMMENDATION_BATCH_SIZE));
  }
  return batches;
}

export function buildSpBidRecommendationBody(
  endpoint: SpBidRecommendationEndpoint,
  ids: readonly AmazonId[],
): Record<string, unknown> {
  return { [endpoint.requestKey]: [...ids] };
}

function firstNumber(
  sources: readonly (Record<string, unknown> | null)[],
  keys: readonly string[],
): number | null {
  for (const source of sources) {
    if (source === null) continue;
    for (const key of keys) {
      const value = readNumber(source, key);
      if (value !== null) return value;
    }
  }
  return null;
}

function localIndex(row: Record<string, unknown>, fallback: number): number {
  const index = readNumber(row, 'index');
  return index === null ? fallback : index;
}

function responseRows(parsed: Record<string, unknown>): {
  success: Record<string, unknown>[];
  errors: Record<string, unknown>[];
} {
  const envelope = readRecord(parsed, 'bidRecommendations');
  if (envelope !== null) {
    const success = readRecordArray(envelope, 'success');
    const singular = readRecordArray(envelope, 'error');
    return {
      success,
      errors: singular.length === 0 ? readRecordArray(envelope, 'errors') : singular,
    };
  }

  // Some regions return an unwrapped recommendation array. It contains only
  // successes; failures use the indexed multi-status envelope above.
  return { success: readRecordArray(parsed, 'bidRecommendations'), errors: [] };
}

/** Parse one batch and prove Amazon accounted for each submitted id exactly once. */
export function parseSpBidRecommendationResponse(
  parsed: unknown,
  kind: SpBidRecommendationKind,
  endpoint: SpBidRecommendationEndpoint,
  submittedIds: readonly AmazonId[],
  indexOffset = 0,
): SpBidRecommendationResult {
  if (!isRecord(parsed)) {
    throw new AdsApiParseError(`${endpoint.path} response is not an object`);
  }
  const rows = responseRows(parsed);
  const seen = new Set<number>();
  const what = `${endpoint.path} response`;

  const items = rows.success.map((row, fallbackIndex): SpSuggestedBid => {
    const index = localIndex(row, fallbackIndex);
    if (!Number.isInteger(index) || index < 0 || index >= submittedIds.length || seen.has(index)) {
      throw new AdsApiParseError(`${what} repeats or exceeds submitted index ${index}`);
    }
    seen.add(index);
    const expectedId = submittedIds[index];
    if (expectedId === undefined) throw new AdsApiParseError(`${what} has no submitted id at index ${index}`);
    const id = readId(row, endpoint.idKey) ?? readId(row, 'targetingClauseId') ?? readId(row, 'id');
    if (id !== null && id !== expectedId) {
      throw new AdsApiParseError(`${what} returned ${id} for submitted id ${expectedId}`);
    }

    const suggestion = readRecord(row, 'suggestedBid');
    const range =
      readRecord(row, 'bidRange') ??
      readRecord(row, 'range') ??
      (suggestion === null ? null : readRecord(suggestion, 'range'));
    const sources = [row, suggestion, range] as const;
    const low = firstNumber(sources, ['low', 'rangeStart', 'lowerBound', 'start']);
    const median = firstNumber(sources, ['median', 'rangeMedian', 'percentile50', 'mid']);
    const high = firstNumber(sources, ['high', 'rangeEnd', 'upperBound', 'end']);
    const suggestedBid = firstNumber(sources, ['suggestedBid', 'recommendedBid', 'recommended', 'value']);
    if (low === null || high === null || suggestedBid === null) {
      throw new AdsApiParseError(`${what} success index ${index} is missing low, high, or suggested bid`);
    }
    const resolvedMedian = median ?? suggestedBid;
    if (low < 0 || resolvedMedian < 0 || high < 0 || suggestedBid < 0 || low > high) {
      throw new AdsApiParseError(`${what} success index ${index} has an invalid bid corridor`);
    }
    return {
      kind,
      index: indexOffset + index,
      targetId: expectedId,
      low,
      median: resolvedMedian,
      high,
      suggestedBid,
      raw: row,
    };
  });

  const errors = rows.errors.map((row, errorIndex): SpBidRecommendationError => {
    const index = localIndex(row, items.length + errorIndex);
    if (!Number.isInteger(index) || index < 0 || index >= submittedIds.length || seen.has(index)) {
      throw new AdsApiParseError(`${what} repeats or exceeds submitted index ${index}`);
    }
    seen.add(index);
    const targetId = submittedIds[index];
    if (targetId === undefined) throw new AdsApiParseError(`${what} has no submitted id at index ${index}`);
    return {
      kind,
      index: indexOffset + index,
      targetId,
      code: readString(row, 'code') ?? readString(row, 'errorType'),
      details: readString(row, 'details') ?? readString(row, 'message'),
      raw: row,
    };
  });

  if (items.length + errors.length !== submittedIds.length || seen.size !== submittedIds.length) {
    throw new AdsApiParseError(
      `${what} accounted for ${items.length + errors.length} of ${submittedIds.length} submitted ids`,
    );
  }

  return {
    items,
    errors,
    submitted: submittedIds.length,
    batches: submittedIds.length === 0 ? 0 : 1,
  };
}
