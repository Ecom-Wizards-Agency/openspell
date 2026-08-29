/**
 * Safe worker handoff from a parsed report range to complete report dates.
 *
 * The strict Sponsored Products path derives exact per-date accounting from the
 * source payload before any canonical date is touched. Generic callers may still
 * supply their own accounting for future report sources.
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

export interface PrepareSponsoredProductsReportInput
  extends Omit<StageParsedReportInput, 'dates'> {
  rawRows: readonly unknown[];
  startDate: string;
  endDate: string;
  profileTimeZone: string;
}

export class UnsafeSponsoredProductsReport extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeSponsoredProductsReport';
  }
}

/** Build and stage a complete SP report window, including explicit empty days. */
export function prepareSponsoredProductsReportDates(
  input: PrepareSponsoredProductsReportInput,
): StagedReportDate[] {
  if (input.batch.kind === 'sb' || input.batch.kind === 'sd') {
    throw new UnsafeSponsoredProductsReport('Sponsored Products promotion cannot stage SB or SD facts');
  }
  if (input.batch.sourceRows !== input.rawRows.length) {
    throw new UnsafeSponsoredProductsReport(
      `parser source rows ${input.batch.sourceRows} do not match payload rows ${input.rawRows.length}`,
    );
  }

  const reportDates = inclusiveDateRange(input.startDate, input.endDate);
  const accounting = new Map<string, ReportDateAccounting>();
  const observedDate = profileDate(input.profileTimeZone, input.observedAt);
  for (const reportDate of reportDates) {
    accounting.set(reportDate, {
      reportDate,
      sourceRows: 0,
      parsedRows: 0,
      refusedRows: 0,
      eventDateAgeDays: daysBetween(reportDate, observedDate),
    });
  }

  const skipped = new Set<number>();
  for (const refusal of input.batch.skipped) {
    if (!Number.isSafeInteger(refusal.index) || refusal.index < 0 || refusal.index >= input.rawRows.length) {
      throw new UnsafeSponsoredProductsReport(`parser returned invalid skipped index ${refusal.index}`);
    }
    if (skipped.has(refusal.index)) {
      throw new UnsafeSponsoredProductsReport(`parser returned duplicate skipped index ${refusal.index}`);
    }
    skipped.add(refusal.index);
  }

  input.rawRows.forEach((row, index) => {
    const reportDate = sourceRowDate(row, index);
    const date = accounting.get(reportDate);
    if (!date) {
      throw new UnsafeSponsoredProductsReport(
        `source row ${index} belongs to ${reportDate}, outside ${input.startDate}..${input.endDate}`,
      );
    }
    date.sourceRows += 1;
    if (skipped.has(index)) date.refusedRows += 1;
    else date.parsedRows += 1;
  });

  if (skipped.size > 0) {
    throw new UnsafeSponsoredProductsReport(
      `replacement refused: parser rejected ${skipped.size} of ${input.rawRows.length} source rows`,
    );
  }

  return stageParsedReportDates({
    ...input,
    dates: reportDates.map((date) => accounting.get(date) as ReportDateAccounting),
  });
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

  return input.dates.map((date) => {
    const batch = rowsByDate.get(date.reportDate) ?? emptyBatch(input.batch.kind);
    if (batch.kind === 'profile') {
      const expectedFacts = date.parsedRows === 0 ? 0 : 1;
      if (batch.rows.length !== expectedFacts) {
        throw new Error(
          `profile source rows for ${date.reportDate} must produce ${expectedFacts} profile fact`,
        );
      }
    }
    return stageReportDate({
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
      batch,
    });
  });
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

function inclusiveDateRange(startDate: string, endDate: string): string[] {
  const start = isoDay(startDate, 'startDate');
  const end = isoDay(endDate, 'endDate');
  if (start > end) throw new UnsafeSponsoredProductsReport('startDate must not be after endDate');
  const dates: string[] = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) dates.push(cursor);
  return dates;
}

function sourceRowDate(value: unknown, index: number): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UnsafeSponsoredProductsReport(`source row ${index} is not an object with a daily date`);
  }
  const date = (value as Record<string, unknown>)['date'];
  if (typeof date !== 'string') {
    throw new UnsafeSponsoredProductsReport(`source row ${index} has no daily date`);
  }
  return isoDay(date, `source row ${index} date`);
}

function profileDate(timeZone: string, value: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(value);
    const read = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
      parts.find((part) => part.type === type)?.value;
    const year = read('year');
    const month = read('month');
    const day = read('day');
    if (!year || !month || !day) throw new Error('formatter omitted a calendar part');
    return `${year}-${month}-${day}`;
  } catch (cause) {
    throw new UnsafeSponsoredProductsReport(
      `invalid profile timezone: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function daysBetween(earlier: string, later: string): number {
  const difference = Date.parse(`${later}T00:00:00.000Z`) - Date.parse(`${earlier}T00:00:00.000Z`);
  const days = difference / 86_400_000;
  if (!Number.isSafeInteger(days) || days < 0) {
    throw new UnsafeSponsoredProductsReport(`${earlier} is after profile-local observation date ${later}`);
  }
  return days;
}

function isoDay(value: string, name: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new UnsafeSponsoredProductsReport(`${name} must be YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new UnsafeSponsoredProductsReport(`${name} must be a real calendar date`);
  }
  return value;
}

function addDays(value: string, amount: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
