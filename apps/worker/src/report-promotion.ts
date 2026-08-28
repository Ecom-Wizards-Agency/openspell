/**
 * Safe worker handoff from a parsed report range to complete report dates.
 *
 * The parser does not yet retain the date of every refused raw row, so callers
 * must supply exact per-date accounting derived from the source payload. This
 * helper refuses totals that do not reconcile and is intentionally not wired
 * into `fetchReport` until that source accounting exists for every report.
 */
import {
  stageReportDate,
  type PromotableReportFactBatch,
  type StagedReportDate,
} from '@wizard-ads/db';
import type { ReportDataSource, ReportType } from '@wizard-ads/shared';
import type { ParsedFactBatch } from './parsers.js';

export interface ReportDateAccounting {
  reportDate: string;
  sourceRows: number;
  parsedRows: number;
  refusedRows: number;
  /** Profile-local age of this report date at observation time. */
  eventDateAgeDays: number;
}

export interface StageParsedReportInput {
  orgId: string;
  profileId: string;
  reportType: ReportType;
  source: ReportDataSource;
  reportRequestId: string;
  requestedAt: Date;
  observedAt: Date;
  attributionWindowDays: number;
  batch: ParsedFactBatch;
  dates: readonly ReportDateAccounting[];
}

export function stageParsedReportDates(input: StageParsedReportInput): StagedReportDate[] {
  const accounting = new Map<string, ReportDateAccounting>();
  for (const date of input.dates) {
    if (accounting.has(date.reportDate)) {
      throw new Error(`duplicate report-date accounting for ${date.reportDate}`);
    }
    accounting.set(date.reportDate, date);
  }

  const sourceRows = sum(input.dates, (date) => date.sourceRows);
  const parsedRows = sum(input.dates, (date) => date.parsedRows);
  const refusedRows = sum(input.dates, (date) => date.refusedRows);
  if (sourceRows !== input.batch.sourceRows) {
    throw new Error(`per-date source rows ${sourceRows} do not match report total ${input.batch.sourceRows}`);
  }
  if (refusedRows !== input.batch.skipped.length) {
    throw new Error(
      `per-date refused rows ${refusedRows} do not match parser total ${input.batch.skipped.length}`,
    );
  }
  if (sourceRows !== parsedRows + refusedRows) {
    throw new Error(
      `report accounting does not reconcile: ${sourceRows} != ${parsedRows} parsed + ${refusedRows} refused`,
    );
  }
  if (input.batch.kind !== 'profile' && parsedRows !== input.batch.rows.length) {
    throw new Error(
      `${input.batch.kind} parsed ${parsedRows} source rows but produced ${input.batch.rows.length} facts`,
    );
  }

  const rowsByDate = groupRowsByDate(input.batch);
  for (const date of rowsByDate.keys()) {
    if (!accounting.has(date)) throw new Error(`parsed facts for ${date} have no source accounting`);
  }

  return input.dates.map((date) => stageReportDate({
    orgId: input.orgId,
    profileId: input.profileId,
    reportType: input.reportType,
    reportDate: date.reportDate,
    source: input.source,
    reportRequestId: input.reportRequestId,
    requestedAt: input.requestedAt,
    observedAt: input.observedAt,
    sourceRows: date.sourceRows,
    parsedRows: date.parsedRows,
    refusedRows: date.refusedRows,
    attribution: {
      attributionWindowDays: input.attributionWindowDays,
      eventDateAgeDays: date.eventDateAgeDays,
    },
    batch: rowsByDate.get(date.reportDate) ?? emptyBatch(input.batch.kind),
  }));
}

function groupRowsByDate(batch: ParsedFactBatch): Map<string, PromotableReportFactBatch> {
  switch (batch.kind) {
    case 'sp_target': return new Map(
      [...groupRows(batch.rows)].map(([date, rows]) => [date, { kind: 'sp_target', rows }]),
    );
    case 'search_term': return new Map(
      [...groupRows(batch.rows)].map(([date, rows]) => [date, { kind: 'search_term', rows }]),
    );
    case 'placement': return new Map(
      [...groupRows(batch.rows)].map(([date, rows]) => [date, { kind: 'placement', rows }]),
    );
    case 'profile': return new Map(
      [...groupRows(batch.rows)].map(([date, rows]) => [date, { kind: 'profile', rows }]),
    );
    case 'sb': return new Map(
      [...groupRows(batch.rows)].map(([date, rows]) => [date, { kind: 'sb', rows }]),
    );
    case 'sd': return new Map(
      [...groupRows(batch.rows)].map(([date, rows]) => [date, { kind: 'sd', rows }]),
    );
  }
}

function groupRows<R extends { date: string }>(
  rows: readonly R[],
): Map<string, R[]> {
  const result = new Map<string, R[]>();
  for (const row of rows) {
    const current = result.get(row.date);
    if (current) {
      current.push(row);
    } else {
      result.set(row.date, [row]);
    }
  }
  return result;
}

function emptyBatch(kind: PromotableReportFactBatch['kind']): PromotableReportFactBatch {
  switch (kind) {
    case 'sp_target': return { kind, rows: [] };
    case 'search_term': return { kind, rows: [] };
    case 'placement': return { kind, rows: [] };
    case 'profile': return { kind, rows: [] };
    case 'sb': return { kind, rows: [] };
    case 'sd': return { kind, rows: [] };
  }
}

function sum<T>(rows: readonly T[], value: (row: T) => number): number {
  return rows.reduce((total, row) => total + value(row), 0);
}
