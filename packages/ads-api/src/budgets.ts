/**
 * Budget usage.
 *
 * The second documented gap in `SPAdsApiDataSource`: whether a campaign is
 * budget-capped is not in any report, so the reference left it `None`/`False`
 * and pacing had to guess. It comes from a separate endpoint, and it is the
 * difference between "this campaign is underperforming" and "this campaign
 * stopped serving at 11am".
 *
 * The budget *amount* is not here — it is an attribute of the campaign and
 * arrives with the entity list. This is the consumed fraction, which only
 * Amazon knows.
 *
 * Amazon answers with a `success`/`error` pair rather than failing the call, so
 * a caller that reads only `success` silently loses campaigns. Both arrays are
 * returned, and the fixture suite asserts their combined length against the
 * number of ids sent.
 */
import { isRecord, readId, readNumber, readString } from './read.js';

export const BUDGET_USAGE_PATH = '/budgets/usage/campaigns';
export const BUDGET_USAGE_MEDIA_TYPE = 'application/vnd.budgetusage.v1+json';

/** Amazon rejects oversized batches; the documented cap is 100 campaigns. */
export const BUDGET_USAGE_BATCH_SIZE = 100;

export interface BudgetUsage {
  campaignId: string;
  /** The campaign's configured budget, as Amazon reports it back. */
  budget: number | null;
  /** Percentage of the budget consumed, 0-100 as Amazon sends it. */
  budgetUsagePercent: number | null;
  /** When Amazon last recomputed usage. Can lag the current hour. */
  usageUpdatedTimestamp: string | null;
}

export interface BudgetUsageFailure {
  campaignId: string | null;
  code: string | null;
  details: string | null;
}

export interface BudgetUsageResult {
  usage: BudgetUsage[];
  failures: BudgetUsageFailure[];
  /** Campaign ids sent. `usage.length + failures.length` should equal it. */
  requested: number;
}

export function buildBudgetUsageBody(
  adProduct: string,
  campaignIds: readonly string[],
): Record<string, unknown> {
  return { adProduct, campaignIds: [...campaignIds] };
}

/** Split a large id list into batches Amazon will accept. */
export function batchCampaignIds(
  campaignIds: readonly string[],
  size = BUDGET_USAGE_BATCH_SIZE,
): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < campaignIds.length; i += size) {
    batches.push([...campaignIds.slice(i, i + size)]);
  }
  return batches;
}

export function parseBudgetUsageResponse(body: unknown): {
  usage: BudgetUsage[];
  failures: BudgetUsageFailure[];
} {
  const usage: BudgetUsage[] = [];
  const failures: BudgetUsageFailure[] = [];
  if (!isRecord(body)) return { usage, failures };

  const success = body['success'];
  if (Array.isArray(success)) {
    for (const entry of success) {
      if (!isRecord(entry)) continue;
      const campaignId = readId(entry, 'campaignId');
      if (campaignId === null) continue;
      usage.push({
        campaignId,
        budget: readNumber(entry, 'budget'),
        budgetUsagePercent: readNumber(entry, 'budgetUsagePercent'),
        usageUpdatedTimestamp: readString(entry, 'usageUpdatedTimestamp'),
      });
    }
  }

  const errors = body['error'] ?? body['errors'];
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (!isRecord(entry)) continue;
      failures.push({
        campaignId: readId(entry, 'campaignId'),
        code: readString(entry, 'code'),
        details: readString(entry, 'details') ?? readString(entry, 'message'),
      });
    }
  }

  return { usage, failures };
}
