/**
 * Pure historical-bootstrap and daily-coverage planning.
 *
 * Amazon availability is an input, never an assertion in this module. The
 * caller must probe or configure the authoritative boundary for a profile and
 * report dimension. That keeps a public maximum (for example a request span)
 * separate from a capability Wizard Ads has actually verified.
 */
import type { HistoricalBootstrapStatus, ReportDataSource } from '@wizard-ads/shared';

export interface HistoricalSourceCapability {
  source: ReportDataSource;
  reportType: string;
  grain: string;
  supported: boolean;
  /** Earliest date this exact profile/report/grain has authoritatively exposed. */
  availabilityStartDate: string | null;
  /** Inclusive calendar days accepted by one request. */
  maximumRequestDays: number;
}

export interface BootstrapWindow {
  startDate: string;
  endDate: string;
  days: number;
  /** Newest window is zero so the most useful history can load first. */
  priority: number;
}

export interface HistoricalBootstrapPlan {
  status: HistoricalBootstrapStatus;
  requestedStartDate: string | null;
  requestedEndDate: string | null;
  availabilityStartDate: string | null;
  truncatedByAvailability: boolean;
  windows: BootstrapWindow[];
}

export interface CoverageReconciliation {
  status: HistoricalBootstrapStatus;
  expectedDates: number;
  returnedDates: number;
  earliestReturnedDate: string | null;
  latestLoadedDate: string | null;
  latestSettledDate: string | null;
  missingDates: string[];
}

/**
 * Clamp a desired history range to verified availability and split it into
 * newest-first, gap-free request windows.
 */
export function planHistoricalBootstrap(input: {
  capability: HistoricalSourceCapability;
  desiredStartDate: string;
  latestCompleteDate: string;
}): HistoricalBootstrapPlan {
  const desiredStart = day(input.desiredStartDate, 'desiredStartDate');
  const latestComplete = day(input.latestCompleteDate, 'latestCompleteDate');
  assertPositiveInteger('maximumRequestDays', input.capability.maximumRequestDays);
  if (desiredStart > latestComplete) {
    throw new Error('desiredStartDate must not be after latestCompleteDate');
  }

  if (!input.capability.supported || input.capability.availabilityStartDate === null) {
    return {
      status: 'unavailable',
      requestedStartDate: null,
      requestedEndDate: null,
      availabilityStartDate: input.capability.availabilityStartDate,
      truncatedByAvailability: false,
      windows: [],
    };
  }

  const availabilityStart = day(input.capability.availabilityStartDate, 'availabilityStartDate');
  if (availabilityStart > latestComplete) {
    return {
      status: 'unavailable',
      requestedStartDate: null,
      requestedEndDate: null,
      availabilityStartDate: input.capability.availabilityStartDate,
      truncatedByAvailability: true,
      windows: [],
    };
  }

  const requestedStart = desiredStart < availabilityStart ? availabilityStart : desiredStart;
  const windows: BootstrapWindow[] = [];
  let end = latestComplete;
  while (end >= requestedStart) {
    const candidate = addDays(end, -(input.capability.maximumRequestDays - 1));
    const start = candidate < requestedStart ? requestedStart : candidate;
    windows.push({
      startDate: isoDay(start),
      endDate: isoDay(end),
      days: inclusiveDays(start, end),
      priority: windows.length,
    });
    end = addDays(start, -1);
  }

  return {
    status: windows.length === 0 ? 'complete' : 'pending',
    requestedStartDate: isoDay(requestedStart),
    requestedEndDate: input.latestCompleteDate,
    availabilityStartDate: input.capability.availabilityStartDate,
    truncatedByAvailability: requestedStart.getTime() !== desiredStart.getTime(),
    windows,
  };
}

/**
 * Reconcile exact daily coverage. Returned dates outside the requested window
 * are refused because accepting them would make source-to-output counts lie.
 */
export function reconcileDailyCoverage(input: {
  requestedStartDate: string;
  requestedEndDate: string;
  returnedDates: readonly string[];
  /** Profile-local cutoff; later dates remain loaded but not settled. */
  settledThroughDate?: string | null;
}): CoverageReconciliation {
  const start = day(input.requestedStartDate, 'requestedStartDate');
  const end = day(input.requestedEndDate, 'requestedEndDate');
  if (start > end) throw new Error('requestedStartDate must not be after requestedEndDate');
  const settledThrough = input.settledThroughDate == null
    ? null
    : day(input.settledThroughDate, 'settledThroughDate');

  const returned = new Set<string>();
  for (const value of input.returnedDates) {
    const parsed = day(value, 'returnedDate');
    if (parsed < start || parsed > end) {
      throw new Error(`returned date ${value} is outside the requested window`);
    }
    returned.add(isoDay(parsed));
  }

  const expected: string[] = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    expected.push(isoDay(cursor));
  }
  const returnedSorted = [...returned].sort();
  const settledReturned = settledThrough === null
    ? []
    : returnedSorted.filter((value) => day(value, 'returnedDate') <= settledThrough);
  const missingDates = expected.filter((value) => !returned.has(value));

  return {
    status: missingDates.length === 0 ? 'complete' : 'partial',
    expectedDates: expected.length,
    returnedDates: returned.size,
    earliestReturnedDate: returnedSorted[0] ?? null,
    latestLoadedDate: returnedSorted.at(-1) ?? null,
    latestSettledDate: settledReturned.at(-1) ?? null,
    missingDates,
  };
}

function day(value: string, name: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} must be YYYY-MM-DD`);
  const result = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(result.getTime()) || isoDay(result) !== value) {
    throw new Error(`${name} must be a real calendar date`);
  }
  return result;
}

function addDays(value: Date, amount: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + amount);
  return result;
}

function inclusiveDays(start: Date, end: Date): number {
  return Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

function isoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}
