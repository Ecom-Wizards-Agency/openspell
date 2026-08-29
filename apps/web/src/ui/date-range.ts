import { addDays, defaultPeriod, type Period } from '../../app/_lib/periods';

export type DateRangePresetId =
  | 'last_7'
  | 'last_14'
  | 'last_30'
  | 'last_60'
  | 'last_90'
  | 'month_to_date'
  | 'previous_month';

export interface DateRangePreset {
  id: DateRangePresetId;
  label: string;
  period: Period;
}

/** Presets end on the last complete profile day; today is never implied complete. */
export function dateRangePresets(today: string): DateRangePreset[] {
  const lastCompleteDay = addDays(today, -1);
  const monthStart = `${lastCompleteDay.slice(0, 8)}01`;
  const previousMonthEnd = addDays(monthStart, -1);
  const previousMonthStart = `${previousMonthEnd.slice(0, 8)}01`;

  return [
    { id: 'last_7', label: 'Last 7 days', period: defaultPeriod(today, 7) },
    { id: 'last_14', label: 'Last 14 days', period: defaultPeriod(today, 14) },
    { id: 'last_30', label: 'Last 30 days', period: defaultPeriod(today, 30) },
    { id: 'last_60', label: 'Last 60 days', period: defaultPeriod(today, 60) },
    { id: 'last_90', label: 'Last 90 days', period: defaultPeriod(today, 90) },
    { id: 'month_to_date', label: 'Month to date', period: { start: monthStart, end: lastCompleteDay } },
    { id: 'previous_month', label: 'Previous month', period: { start: previousMonthStart, end: previousMonthEnd } },
  ];
}

export function selectedDateRangeLabel(period: Period, today: string): string {
  const preset = dateRangePresets(today).find(
    (candidate) => candidate.period.start === period.start && candidate.period.end === period.end,
  );
  return preset?.label ?? `${shortDate(period.start)} – ${shortDate(period.end)}`;
}

export function dateRangeHref(
  path: string,
  period: Period,
  preserved: Readonly<Record<string, string | undefined>>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(preserved)) {
    if (value !== undefined && key !== 'from' && key !== 'to') params.set(key, value);
  }
  params.set('from', period.start);
  params.set('to', period.end);
  return `${path}?${params.toString()}`;
}

function shortDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return value;
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
    year: 'numeric',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}
