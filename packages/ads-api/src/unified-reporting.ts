/**
 * Amazon Unified Reporting's request and indexed-response boundary.
 *
 * This is deliberately not a Reporting v3 adapter. Unified Reporting is
 * advertiser-account scoped inside the body, batches create and retrieve
 * operations, and returns one indexed success or error for every submitted
 * item. The prepared operation binds one defensive input snapshot to its
 * decoder so a response cannot be reconciled against the wrong batch.
 */
import { AdsApiConfigError, AdsApiParseError } from './errors.js';
import { isRecord, readString } from './read.js';

export const UNIFIED_CREATE_REPORTS_PATH = '/adsApi/v1/create/reports' as const;
export const UNIFIED_RETRIEVE_REPORTS_PATH = '/adsApi/v1/retrieve/reports' as const;

export type UnifiedReportFormat = 'CSV' | 'GZIP_JSON';

export type UnifiedReportJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly UnifiedReportJsonValue[]
  | { readonly [key: string]: UnifiedReportJsonValue };

export type UnifiedReportFilter = Readonly<Record<string, UnifiedReportJsonValue>>;

export interface UnifiedReportDatePeriod {
  readonly startDate: string;
  readonly endDate: string;
}

export interface UnifiedReportDefinition {
  readonly format: UnifiedReportFormat;
  readonly periods: readonly UnifiedReportDatePeriod[];
  readonly fields: readonly string[];
  /** Provider-owned expression. WP-173 validates JSON safety but invents no DSL. */
  readonly filter?: UnifiedReportFilter;
}

export interface CreateUnifiedReportsInput {
  readonly advertiserAccountIds: readonly string[];
  readonly reports: readonly UnifiedReportDefinition[];
}

export interface UnifiedReportProviderError {
  readonly code: string | null;
  /** Sanitized summary; Amazon's raw message may echo account/query input. */
  readonly message: string | null;
}

export interface UnifiedReportMetadata {
  readonly reportId: string;
  /** Kept open until a primary contract proves the complete lifecycle vocabulary. */
  readonly status: string;
  readonly format: UnifiedReportFormat;
  readonly periods: readonly UnifiedReportDatePeriod[];
  readonly fields: readonly string[];
  readonly filter: UnifiedReportFilter | null;
  readonly linkedAdvertiserAccountIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly currencyOfView: string | null;
  readonly locale: string | null;
  readonly timeZoneMode: string | null;
  readonly failureCode: string | null;
  readonly failureReason: string | null;
  /** The accessible primary fixture proves only `completedReportParts: null`. */
  readonly completedParts: { readonly kind: 'not-returned' };
}

export type UnifiedReportOutcome<TSubmitted> =
  | {
      readonly kind: 'success';
      readonly index: number;
      readonly submitted: TSubmitted;
      readonly report: UnifiedReportMetadata;
    }
  | {
      readonly kind: 'error';
      readonly index: number;
      readonly submitted: TSubmitted;
      readonly errors: readonly UnifiedReportProviderError[];
    };

export interface UnifiedReportBatchResult<TSubmitted> {
  /** Input count. `outcomes.length` always equals it. */
  readonly submittedCount: number;
  /** Sorted by input index; `outcomes[index].index === index`. */
  readonly outcomes: readonly UnifiedReportOutcome<TSubmitted>[];
}

/** Package-internal prepared operation. Not re-exported from the package root. */
export interface PreparedUnifiedReportOperation<TSubmitted> {
  readonly path: typeof UNIFIED_CREATE_REPORTS_PATH | typeof UNIFIED_RETRIEVE_REPORTS_PATH;
  readonly idempotent: boolean;
  readonly submittedCount: number;
  readonly body: string;
  decodeResponse(raw: unknown): UnifiedReportBatchResult<TSubmitted>;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function requiredTrimmed(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AdsApiConfigError(`${what} must be a non-empty string`);
  }
  return value.trim();
}

function isoDate(value: unknown, what: string): string {
  const date = requiredTrimmed(value, what);
  const match = ISO_DATE.exec(date);
  if (match === null) throw new AdsApiConfigError(`${what} must use YYYY-MM-DD`);
  const instant = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(instant.valueOf()) || instant.toISOString().slice(0, 10) !== date) {
    throw new AdsApiConfigError(`${what} is not a calendar date`);
  }
  return date;
}

function cloneJson(value: UnifiedReportJsonValue, what: string): UnifiedReportJsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AdsApiConfigError(`${what} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => cloneJson(entry, `${what}[${index}]`));
  }
  if (!isRecord(value)) throw new AdsApiConfigError(`${what} is not JSON-safe`);
  const output: Record<string, UnifiedReportJsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol' || typeof entry === 'bigint') {
      throw new AdsApiConfigError(`${what}.${key} is not JSON-safe`);
    }
    output[key] = cloneJson(entry as UnifiedReportJsonValue, `${what}.${key}`);
  }
  return output;
}

function normalizePeriod(value: UnifiedReportDatePeriod, index: number): UnifiedReportDatePeriod {
  const startDate = isoDate(value.startDate, `reports[].periods[${index}].startDate`);
  const endDate = isoDate(value.endDate, `reports[].periods[${index}].endDate`);
  if (startDate > endDate) {
    throw new AdsApiConfigError(`reports[].periods[${index}] starts after it ends`);
  }
  return { startDate, endDate };
}

function normalizeDefinition(value: UnifiedReportDefinition, index: number): UnifiedReportDefinition {
  if (value.format !== 'CSV' && value.format !== 'GZIP_JSON') {
    throw new AdsApiConfigError(`reports[${index}].format is unsupported`);
  }
  if (!Array.isArray(value.periods) || value.periods.length === 0) {
    throw new AdsApiConfigError(`reports[${index}].periods must not be empty`);
  }
  if (!Array.isArray(value.fields) || value.fields.length === 0) {
    throw new AdsApiConfigError(`reports[${index}].fields must not be empty`);
  }
  const fields = value.fields.map((field, fieldIndex) =>
    requiredTrimmed(field, `reports[${index}].fields[${fieldIndex}]`),
  );
  if (new Set(fields).size !== fields.length) {
    throw new AdsApiConfigError(`reports[${index}].fields contains duplicates`);
  }
  const periods = value.periods.map(normalizePeriod);
  const filter = value.filter === undefined
    ? undefined
    : cloneJson(value.filter, `reports[${index}].filter`);
  if (filter !== undefined && !isRecord(filter)) {
    throw new AdsApiConfigError(`reports[${index}].filter must be a JSON object`);
  }
  return {
    format: value.format,
    periods,
    fields,
    ...(filter === undefined ? {} : { filter }),
  };
}

function nullableString(record: Record<string, unknown>, key: string, what: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AdsApiParseError(`${what} has an invalid ${key}`);
  }
  return value;
}

function requiredString(record: Record<string, unknown>, key: string, what: string): string {
  const value = readString(record, key);
  if (value === null) throw new AdsApiParseError(`${what} is missing ${key}`);
  return value;
}

function parseFormat(record: Record<string, unknown>, what: string): UnifiedReportFormat {
  const format = requiredString(record, 'format', what);
  if (format !== 'CSV' && format !== 'GZIP_JSON') {
    throw new AdsApiParseError(`${what} has an unsupported format`);
  }
  return format;
}

function parsePeriods(record: Record<string, unknown>, what: string): UnifiedReportDatePeriod[] {
  const values = record['periods'];
  if (!Array.isArray(values) || values.length === 0) {
    throw new AdsApiParseError(`${what} is missing periods[]`);
  }
  return values.map((value, index) => {
    if (!isRecord(value) || !isRecord(value['datePeriod'])) {
      throw new AdsApiParseError(`${what} period ${index} is missing datePeriod`);
    }
    const datePeriod = value['datePeriod'];
    const rawStartDate = readString(datePeriod, 'startDate');
    const rawEndDate = readString(datePeriod, 'endDate');
    if (rawStartDate === null || rawEndDate === null) {
      throw new AdsApiParseError(`${what} period ${index} is missing a date`);
    }
    let startDate: string;
    let endDate: string;
    try {
      startDate = isoDate(rawStartDate, `${what} period ${index} startDate`);
      endDate = isoDate(rawEndDate, `${what} period ${index} endDate`);
    } catch (cause) {
      throw new AdsApiParseError(`${what} period ${index} has an invalid date`, cause);
    }
    if (startDate > endDate) {
      throw new AdsApiParseError(`${what} period ${index} starts after it ends`);
    }
    return { startDate, endDate };
  });
}

function parseFields(query: Record<string, unknown>, what: string): string[] {
  const values = query['fields'];
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== 'string' || value === '')) {
    throw new AdsApiParseError(`${what} is missing query.fields[]`);
  }
  return [...values] as string[];
}

function parseFilter(query: Record<string, unknown>, what: string): UnifiedReportFilter | null {
  const filter = query['filter'];
  if (filter === null) return null;
  if (!isRecord(filter)) throw new AdsApiParseError(`${what} has an unsupported query.filter`);
  try {
    return cloneJson(filter as UnifiedReportFilter, `${what}.query.filter`) as UnifiedReportFilter;
  } catch (cause) {
    throw new AdsApiParseError(`${what} has a non-JSON query.filter`, cause);
  }
}

function parseLinkedAccounts(record: Record<string, unknown>, what: string): string[] {
  const values = record['linkedAccounts'];
  if (!Array.isArray(values)) throw new AdsApiParseError(`${what} is missing linkedAccounts[]`);
  return values.map((value, index) => {
    if (!isRecord(value)) throw new AdsApiParseError(`${what} linked account ${index} is not an object`);
    return requiredString(value, 'advertiserAccountId', `${what} linked account ${index}`);
  });
}

function parseMetadata(value: unknown, what: string): UnifiedReportMetadata {
  if (!isRecord(value)) throw new AdsApiParseError(`${what} is missing report`);
  if (value['completedReportParts'] !== null) {
    throw new AdsApiParseError(`${what} returned unproven completedReportParts`);
  }
  if (!isRecord(value['query'])) throw new AdsApiParseError(`${what} is missing query`);
  const query = value['query'];
  return {
    reportId: requiredString(value, 'reportId', what),
    status: requiredString(value, 'status', what),
    format: parseFormat(value, what),
    periods: parsePeriods(value, what),
    fields: parseFields(query, what),
    filter: parseFilter(query, what),
    linkedAdvertiserAccountIds: parseLinkedAccounts(value, what),
    createdAt: requiredString(value, 'creationDateTime', what),
    updatedAt: requiredString(value, 'lastUpdatedDateTime', what),
    completedAt: nullableString(value, 'completedDateTime', what),
    currencyOfView: nullableString(value, 'currencyOfView', what),
    locale: nullableString(value, 'locale', what),
    timeZoneMode: nullableString(value, 'timeZoneMode', what),
    failureCode: nullableString(value, 'failureCode', what),
    failureReason: nullableString(value, 'failureReason', what),
    completedParts: { kind: 'not-returned' },
  };
}

function bucket(body: Record<string, unknown>, key: 'success' | 'error'): unknown[] {
  const value = body[key];
  if (value === null) return [];
  if (!Array.isArray(value)) throw new AdsApiParseError(`Unified report response is missing ${key}[]`);
  return value;
}

function entryIndex(entry: Record<string, unknown>, submittedCount: number, what: string): number {
  const value = entry['index'];
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= submittedCount) {
    throw new AdsApiParseError(`Unified report ${what} has an invalid index`);
  }
  return value as number;
}

function parseProviderErrors(entry: Record<string, unknown>, index: number): UnifiedReportProviderError[] {
  const values = entry['errors'];
  if (!Array.isArray(values) || values.length === 0) {
    throw new AdsApiParseError(`Unified report error ${index} is missing errors[]`);
  }
  return values.map((value, errorIndex) => {
    if (!isRecord(value)) {
      throw new AdsApiParseError(`Unified report error ${index}.${errorIndex} is not an object`);
    }
    const code = value['code'] === null || value['code'] === undefined
      ? null
      : requiredString(value, 'code', `Unified report error ${index}.${errorIndex}`);
    const providerMessage = value['message'] === null || value['message'] === undefined
      ? null
      : requiredString(value, 'message', `Unified report error ${index}.${errorIndex}`);
    return {
      code,
      message: providerMessage === null ? null : 'Provider rejected this report definition',
    };
  });
}

function reconcile<TSubmitted>(
  raw: unknown,
  submitted: readonly TSubmitted[],
  expectedReportIds: readonly string[] | null,
): UnifiedReportBatchResult<TSubmitted> {
  if (!isRecord(raw)) throw new AdsApiParseError('Unified report response is not an object');
  const outcomes: Array<UnifiedReportOutcome<TSubmitted> | undefined> = Array.from({ length: submitted.length });
  const claim = (entry: Record<string, unknown>, kind: string): number => {
    const index = entryIndex(entry, submitted.length, kind);
    if (outcomes[index] !== undefined) {
      throw new AdsApiParseError(`Unified report response repeats index ${index}`);
    }
    return index;
  };

  for (const value of bucket(raw, 'success')) {
    if (!isRecord(value)) throw new AdsApiParseError('Unified report success is not an object');
    const index = claim(value, 'success');
    const submittedItem = submitted[index];
    if (submittedItem === undefined) throw new AdsApiParseError(`Unified report success ${index} has no input`);
    const report = parseMetadata(value['report'], `Unified report success ${index}`);
    if (expectedReportIds !== null && report.reportId !== expectedReportIds[index]) {
      throw new AdsApiParseError(`Unified report success ${index} does not match its requested report`);
    }
    outcomes[index] = { kind: 'success', index, submitted: submittedItem, report };
  }

  for (const value of bucket(raw, 'error')) {
    if (!isRecord(value)) throw new AdsApiParseError('Unified report error is not an object');
    const index = claim(value, 'error');
    const submittedItem = submitted[index];
    if (submittedItem === undefined) throw new AdsApiParseError(`Unified report error ${index} has no input`);
    outcomes[index] = {
      kind: 'error',
      index,
      submitted: submittedItem,
      errors: parseProviderErrors(value, index),
    };
  }

  if (outcomes.some((outcome) => outcome === undefined)) {
    throw new AdsApiParseError(
      `Unified report response accounted for ${outcomes.filter(Boolean).length} of ${submitted.length} submitted items`,
    );
  }
  return {
    submittedCount: submitted.length,
    outcomes: outcomes as UnifiedReportOutcome<TSubmitted>[],
  };
}

export function prepareUnifiedReportCreate(
  input: CreateUnifiedReportsInput,
): PreparedUnifiedReportOperation<UnifiedReportDefinition> {
  const reports = input.reports.map(normalizeDefinition);
  const advertiserAccountIds = input.advertiserAccountIds.map((value, index) =>
    requiredTrimmed(value, `advertiserAccountIds[${index}]`),
  );
  if (reports.length > 0 && advertiserAccountIds.length === 0) {
    throw new AdsApiConfigError('advertiserAccountIds must not be empty when reports are submitted');
  }
  if (new Set(advertiserAccountIds).size !== advertiserAccountIds.length) {
    throw new AdsApiConfigError('advertiserAccountIds contains duplicates');
  }
  const body = JSON.stringify({
    reports: reports.map((report) => ({
      format: report.format,
      periods: report.periods.map((period) => ({ datePeriod: { ...period } })),
      query: {
        fields: [...report.fields],
        ...(report.filter === undefined ? {} : { filter: report.filter }),
      },
    })),
    accessRequestedAccounts: advertiserAccountIds.map((advertiserAccountId) => ({
      advertiserAccountId,
    })),
  });
  return {
    path: UNIFIED_CREATE_REPORTS_PATH,
    idempotent: false,
    submittedCount: reports.length,
    body,
    decodeResponse: (raw) => reconcile(raw, reports, null),
  };
}

export function prepareUnifiedReportRetrieve(
  values: readonly string[],
): PreparedUnifiedReportOperation<string> {
  const reportIds = values.map((value, index) => requiredTrimmed(value, `reportIds[${index}]`));
  if (new Set(reportIds).size !== reportIds.length) {
    throw new AdsApiConfigError('reportIds contains duplicates');
  }
  return {
    path: UNIFIED_RETRIEVE_REPORTS_PATH,
    idempotent: true,
    submittedCount: reportIds.length,
    body: JSON.stringify({ reportIds }),
    decodeResponse: (raw) => reconcile(raw, reportIds, reportIds),
  };
}
