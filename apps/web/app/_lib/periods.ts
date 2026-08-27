/**
 * Periods, and the comparison period every grid gets for free.
 *
 * The recon's best small idea (`02-data-grid.md` §2): the comparison period
 * defaults to *the immediately preceding period of the same length*, so every
 * grid can show a delta without the operator choosing a baseline. Copied
 * exactly, including the "same length" part -- comparing a 30-day window
 * against a calendar month would produce deltas nobody could reason about.
 *
 * Dates are `YYYY-MM-DD` strings in the profile's own calendar, arithmetic is
 * done in UTC. A `Date` here would invite a timezone to shift a profile's day
 * boundary, which is exactly the bug the fact tables were designed to avoid by
 * storing `date` rather than a timestamp.
 */
export interface Period {
  start: string;
  end: string;
}

export const DEFAULT_WINDOW_DAYS = 30;
/** Amazon can restate attributed sales for this many trailing days. */
export const ATTRIBUTION_SETTLING_DAYS = 14;

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(start: string, end: string): number {
  const toMs = (date: string): number => {
    const [y, m, d] = date.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toMs(end) - toMs(start)) / 86_400_000) + 1;
}

/** The window ending yesterday: today is provisional and would read as a collapse. */
export function defaultPeriod(today: string, windowDays = DEFAULT_WINDOW_DAYS): Period {
  const end = addDays(today, -1);
  return { start: addDays(end, -(windowDays - 1)), end };
}

/** The same number of days, immediately before. */
export function precedingPeriod(period: Period): Period {
  const length = daysBetween(period.start, period.end);
  const end = addDays(period.start, -1);
  return { start: addDays(end, -(length - 1)), end };
}

export interface SettledComparisonWindows {
  /** Selected-period dates old enough for their attributed sales to be stable. */
  current: Period | null;
  /** Equal-length period immediately before `current`. */
  comparison: Period | null;
  /** The trailing dates whose attributed sales may still restate. */
  settling: Period;
}

/**
 * Split a selected range into settled KPI evidence and the visible settling tail.
 *
 * The chart still shows the selected period. KPI values and deltas use `current`
 * and `comparison`, which are equal-length and never include one of Amazon's
 * trailing 14 restatement days.
 */
export function settledComparisonWindows(period: Period, today: string): SettledComparisonWindows {
  const settling: Period = {
    start: addDays(today, -ATTRIBUTION_SETTLING_DAYS),
    end: addDays(today, -1),
  };
  const settledEnd = period.end < settling.start ? period.end : addDays(settling.start, -1);
  if (settledEnd < period.start) return { current: null, comparison: null, settling };
  const current = { start: period.start, end: settledEnd };
  return { current, comparison: precedingPeriod(current), settling };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Read a period off the query string, falling back to the default window.
 *
 * An unparseable or inverted range falls back rather than erroring: a deep link
 * somebody hand-edited should show the default month, not a stack trace.
 */
export function periodFromParams(
  params: { from?: string; to?: string },
  today: string,
  windowDays = DEFAULT_WINDOW_DAYS,
): Period {
  const { from, to } = params;
  if (from === undefined || to === undefined) return defaultPeriod(today, windowDays);
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) return defaultPeriod(today, windowDays);
  return { start: from, end: to };
}

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
