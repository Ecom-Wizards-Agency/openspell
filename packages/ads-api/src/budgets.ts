/**
 * Sponsored-ads campaign budget usage.
 *
 * Amazon exposes one product-specific endpoint for each sponsored-ad product.
 * The request is a read despite being POST, so the shared HTTP layer may retry
 * throttles, transport failures, and 5xx responses safely.
 *
 * The response is an indexed `success`/`error` pair. Indexes are reconciled
 * against the exact request batch here. A malformed, duplicate, missing, or
 * mismatched row throws instead of silently turning an unknown campaign into
 * "not budget capped".
 */
import type { AdProduct } from '@wizard-ads/shared';
import { AdsApiParseError } from './errors.js';
import { isRecord, readId, readNumber, readString } from './read.js';

export interface BudgetUsageEndpoint {
  path: string;
  accept: string;
  contentType: string;
}

/** Product-specific paths verified against Amazon's pinned official collection. */
export const BUDGET_USAGE_ENDPOINTS: Readonly<Record<AdProduct, BudgetUsageEndpoint>> = {
  SP: {
    path: '/sp/campaigns/budget/usage',
    accept: 'application/vnd.spcampaignbudgetusage.v1+json',
    contentType: 'application/json',
  },
  SB: {
    path: '/sb/campaigns/budget/usage',
    accept: 'application/json',
    contentType: 'application/json',
  },
  SD: {
    path: '/sd/campaigns/budget/usage',
    accept: 'application/json',
    contentType: 'application/json',
  },
};

/**
 * Conservative local batch size. The pinned collection does not state a
 * provider maximum, so this must not be presented as Amazon's authoritative
 * limit until a live capability probe or newer primary specification proves it.
 */
export const BUDGET_USAGE_BATCH_SIZE = 100;

export interface BudgetUsage {
  campaignId: string;
  /** The campaign's configured budget, as Amazon reports it back. */
  budget: number;
  /** Percentage of the budget consumed, 0-100 as Amazon sends it. */
  budgetUsagePercent: number;
  /** When Amazon last recomputed usage. Can lag the current hour. */
  usageUpdatedTimestamp: string;
}

export interface BudgetUsageFailure {
  /** The requested id at Amazon's response index, even when Amazon omits it. */
  campaignId: string;
  code: string | null;
  details: string | null;
}

export interface BudgetUsageResult {
  usage: BudgetUsage[];
  failures: BudgetUsageFailure[];
  /** Campaign ids sent. `usage.length + failures.length` always equals it. */
  requested: number;
}

export function buildBudgetUsageBody(campaignIds: readonly string[]): Record<string, unknown> {
  return { campaignIds: [...campaignIds] };
}

/** Split a large id list into bounded batches without losing input order. */
export function batchCampaignIds(
  campaignIds: readonly string[],
  size = BUDGET_USAGE_BATCH_SIZE,
): string[][] {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new RangeError('budget usage batch size must be a positive integer');
  }
  const batches: string[][] = [];
  for (let i = 0; i < campaignIds.length; i += size) {
    batches.push([...campaignIds.slice(i, i + size)]);
  }
  return batches;
}

function requiredArray(body: Record<string, unknown>, key: 'success' | 'error'): unknown[] {
  const value = body[key];
  if (!Array.isArray(value)) {
    throw new AdsApiParseError(`budget usage response is missing ${key}[]`);
  }
  return value;
}

function responseIndex(entry: Record<string, unknown>, requested: readonly string[], kind: string): number {
  const value = entry['index'];
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= requested.length) {
    throw new AdsApiParseError(`budget usage ${kind} row has an invalid index`);
  }
  return value as number;
}

function requiredNumber(entry: Record<string, unknown>, key: string, index: number): number {
  const value = readNumber(entry, key);
  if (value === null || !Number.isFinite(value)) {
    throw new AdsApiParseError(`budget usage success row ${index} is missing ${key}`);
  }
  return value;
}

function requiredString(entry: Record<string, unknown>, key: string, index: number): string {
  const value = readString(entry, key);
  if (value === null || value.trim() === '') {
    throw new AdsApiParseError(`budget usage success row ${index} is missing ${key}`);
  }
  return value;
}

function firstNestedError(entry: Record<string, unknown>): Record<string, unknown> | null {
  const nested = entry['errors'];
  if (!Array.isArray(nested)) return null;
  const first = nested[0];
  return isRecord(first) ? first : null;
}

/**
 * Parse and reconcile one response against the exact ids sent in that batch.
 * This is an assertion boundary, not a permissive mapper.
 */
export function parseBudgetUsageResponse(
  body: unknown,
  requestedCampaignIds: readonly string[],
): { usage: BudgetUsage[]; failures: BudgetUsageFailure[] } {
  if (!isRecord(body)) {
    throw new AdsApiParseError('budget usage response is not an object');
  }

  const success = requiredArray(body, 'success');
  const errors = requiredArray(body, 'error');
  const usage: BudgetUsage[] = [];
  const failures: BudgetUsageFailure[] = [];
  const seenIndexes = new Set<number>();

  const claimIndex = (entry: Record<string, unknown>, kind: string): number => {
    const index = responseIndex(entry, requestedCampaignIds, kind);
    if (seenIndexes.has(index)) {
      throw new AdsApiParseError(`budget usage response repeats index ${index}`);
    }
    seenIndexes.add(index);
    return index;
  };

  for (const value of success) {
    if (!isRecord(value)) {
      throw new AdsApiParseError('budget usage success row is not an object');
    }
    const index = claimIndex(value, 'success');
    const campaignId = readId(value, 'campaignId');
    const expectedId = requestedCampaignIds[index];
    if (campaignId === null || expectedId === undefined || campaignId !== expectedId) {
      throw new AdsApiParseError(`budget usage success row ${index} does not match its requested campaign`);
    }
    usage.push({
      campaignId,
      budget: requiredNumber(value, 'budget', index),
      budgetUsagePercent: requiredNumber(value, 'budgetUsagePercent', index),
      usageUpdatedTimestamp: requiredString(value, 'usageUpdatedTimestamp', index),
    });
  }

  for (const value of errors) {
    if (!isRecord(value)) {
      throw new AdsApiParseError('budget usage error row is not an object');
    }
    const index = claimIndex(value, 'error');
    const expectedId = requestedCampaignIds[index];
    if (expectedId === undefined) {
      throw new AdsApiParseError(`budget usage error row ${index} has no requested campaign`);
    }
    const providerId = readId(value, 'campaignId');
    if (providerId !== null && providerId !== expectedId) {
      throw new AdsApiParseError(`budget usage error row ${index} does not match its requested campaign`);
    }
    const nested = firstNestedError(value);
    failures.push({
      campaignId: expectedId,
      code:
        readString(value, 'code') ??
        readString(value, 'errorType') ??
        (nested === null ? null : readString(nested, 'code')),
      details:
        readString(value, 'details') ??
        readString(value, 'message') ??
        (nested === null ? null : readString(nested, 'message')),
    });
  }

  if (seenIndexes.size !== requestedCampaignIds.length) {
    throw new AdsApiParseError(
      `budget usage response accounted for ${seenIndexes.size} of ${requestedCampaignIds.length} requested campaigns`,
    );
  }

  return { usage, failures };
}
