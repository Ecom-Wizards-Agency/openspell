import {
  SqpIngestionCounts,
  SqpWeeklyFact,
  type QueryCategory,
  type SqpIngestionCounts as SqpIngestionCountsType,
  type SqpWeeklyFact as SqpWeeklyFactType,
} from '@wizard-ads/shared';
import { SpApiParseError } from './errors.js';
import type { CreateReportInput } from './types.js';

export const SQP_REPORT_TYPE = 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT';
export const SQP_ASIN_OPTION_MAX_CHARS = 200;

function dateAtUtc(date: string): Date {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new SpApiParseError(`invalid calendar date: ${date}`);
  }
  return parsed;
}

export function assertWeeklyPeriod(weekStart: string, weekEnd: string): void {
  const start = dateAtUtc(weekStart);
  const end = dateAtUtc(weekEnd);
  if (start.getUTCDay() !== 0) throw new SpApiParseError('SQP week must start on Sunday');
  if (end.getUTCDay() !== 6) throw new SpApiParseError('SQP week must end on Saturday');
  if (end.valueOf() - start.valueOf() !== 6 * 86_400_000) {
    throw new SpApiParseError('SQP request must cover exactly one Sunday-Saturday week');
  }
}

export function batchSqpAsins(asins: readonly string[]): string[][] {
  const unique = [...new Set(asins.map((asin) => asin.trim()).filter((asin) => asin.length > 0))];
  const batches: string[][] = [];
  let current: string[] = [];
  let currentLength = 0;

  for (const asin of unique) {
    if (asin.length > SQP_ASIN_OPTION_MAX_CHARS) {
      throw new SpApiParseError('one ASIN exceeds the SQP report-option character limit');
    }
    const nextLength = currentLength + (current.length === 0 ? 0 : 1) + asin.length;
    if (current.length > 0 && nextLength > SQP_ASIN_OPTION_MAX_CHARS) {
      batches.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(asin);
    currentLength += (current.length === 1 ? 0 : 1) + asin.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function buildSqpReportRequests(input: {
  marketplaceId: string;
  asins: readonly string[];
  weekStart: string;
  weekEnd: string;
}): CreateReportInput[] {
  assertWeeklyPeriod(input.weekStart, input.weekEnd);
  return batchSqpAsins(input.asins).map((batch) => ({
    reportType: SQP_REPORT_TYPE,
    marketplaceId: input.marketplaceId,
    // Reports v2021-06-30 requires RFC 3339 date-times. Keep the public
    // builder week-shaped, then expand the verified Sunday-Saturday period to
    // the complete UTC days only at the transport boundary.
    dataStartTime: `${input.weekStart}T00:00:00.000Z`,
    dataEndTime: `${input.weekEnd}T23:59:59.999Z`,
    reportOptions: { reportPeriod: 'WEEK', asin: batch.join(' ') },
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numeric(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new SpApiParseError(`SQP row has invalid ${key}`);
  }
  return value;
}

function integer(record: Record<string, unknown>, key: string): number {
  const value = numeric(record, key);
  if (!Number.isInteger(value)) throw new SpApiParseError(`SQP row has non-integer ${key}`);
  return value;
}

function nested(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) throw new SpApiParseError(`SQP row has no ${key}`);
  return value;
}

function text(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new SpApiParseError(`SQP row has invalid ${key}`);
  }
  return value;
}

function normalizeQuery(query: string): string {
  return query.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
}

function parseRow(input: {
  row: Record<string, unknown>;
  profileId: string;
  marketplaceId: string;
  category: QueryCategory;
}): SqpWeeklyFactType {
  const search = nested(input.row, 'searchQueryData');
  const impression = nested(input.row, 'impressionData');
  const click = nested(input.row, 'clickData');
  const cart = nested(input.row, 'cartAddData');
  const purchase = nested(input.row, 'purchaseData');
  const searchQuery = text(search, 'searchQuery');

  return SqpWeeklyFact.parse({
    profileId: input.profileId,
    marketplaceId: input.marketplaceId,
    asin: text(input.row, 'asin'),
    weekStart: text(input.row, 'startDate'),
    weekEnd: text(input.row, 'endDate'),
    searchQuery,
    normalizedQuery: normalizeQuery(searchQuery),
    category: input.category,
    searchQueryScore:
      search['searchQueryScore'] === null || search['searchQueryScore'] === undefined
        ? null
        : numeric(search, 'searchQueryScore'),
    searchQueryVolume: integer(search, 'searchQueryVolume'),
    totalImpressions: integer(impression, 'totalQueryImpressionCount'),
    asinImpressions: integer(impression, 'asinImpressionCount'),
    asinImpressionShare: numeric(impression, 'asinImpressionShare'),
    totalClicks: integer(click, 'totalClickCount'),
    asinClicks: integer(click, 'asinClickCount'),
    asinClickShare: numeric(click, 'asinClickShare'),
    totalCartAdds: integer(cart, 'totalCartAddCount'),
    asinCartAdds: integer(cart, 'asinCartAddCount'),
    asinCartAddShare: numeric(cart, 'asinCartAddShare'),
    totalPurchases: integer(purchase, 'totalPurchaseCount'),
    asinPurchases: integer(purchase, 'asinPurchaseCount'),
    asinPurchaseShare: numeric(purchase, 'asinPurchaseShare'),
  });
}

export interface ParsedSqpReport {
  rows: SqpWeeklyFactType[];
  counts: SqpIngestionCountsType;
  refused: Array<{ index: number; reason: string }>;
}

export function parseSqpReport(
  document: unknown,
  context: { profileId: string; marketplaceId: string; category?: QueryCategory },
): ParsedSqpReport {
  if (!isRecord(document) || !Array.isArray(document['dataByAsin'])) {
    throw new SpApiParseError('SQP document has no dataByAsin array');
  }
  const source = document['dataByAsin'];
  const parsed: SqpWeeklyFactType[] = [];
  const refused: Array<{ index: number; reason: string }> = [];

  source.forEach((candidate, index) => {
    if (!isRecord(candidate)) {
      refused.push({ index, reason: 'row is not an object' });
      return;
    }
    try {
      parsed.push(
        parseRow({
          row: candidate,
          profileId: context.profileId,
          marketplaceId: context.marketplaceId,
          category: context.category ?? 'unreviewed',
        }),
      );
    } catch (error) {
      refused.push({
        index,
        reason: error instanceof Error ? error.message : 'unknown parse error',
      });
    }
  });

  const unique = new Map<string, SqpWeeklyFactType>();
  for (const row of parsed) {
    const key = [row.marketplaceId, row.asin, row.weekStart, row.normalizedQuery].join('\u0000');
    if (!unique.has(key)) unique.set(key, row);
  }
  const rows = [...unique.values()];
  const counts = SqpIngestionCounts.parse({
    sourceAsins: new Set(source.filter(isRecord).map((row) => row['asin']).filter((value): value is string => typeof value === 'string')).size,
    sourceRows: source.length,
    parsedRows: parsed.length,
    deduplicatedRows: rows.length,
    refusedRows: refused.length,
    upserts: rows.length,
  });
  if (counts.parsedRows + counts.refusedRows !== counts.sourceRows) {
    throw new SpApiParseError('SQP row reconciliation failed');
  }
  return { rows, counts, refused };
}
