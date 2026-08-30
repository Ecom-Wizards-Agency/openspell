import { addDays, type Period } from '../../app/_lib/periods';

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

/** Presets end on the last complete day unless the surface observes current-day evidence. */
export function dateRangePresets(today: string, includeToday = false): DateRangePreset[] {
  const rangeEnd = includeToday ? today : addDays(today, -1);
  const monthStart = `${rangeEnd.slice(0, 8)}01`;
  const previousMonthEnd = addDays(monthStart, -1);
  const previousMonthStart = `${previousMonthEnd.slice(0, 8)}01`;
  const rolling = (days: number): Period => ({
    start: addDays(rangeEnd, -(days - 1)),
    end: rangeEnd,
  });

  return [
    { id: 'last_7', label: 'Last 7 days', period: rolling(7) },
    { id: 'last_14', label: 'Last 14 days', period: rolling(14) },
    { id: 'last_30', label: 'Last 30 days', period: rolling(30) },
    { id: 'last_60', label: 'Last 60 days', period: rolling(60) },
    { id: 'last_90', label: 'Last 90 days', period: rolling(90) },
    { id: 'month_to_date', label: 'Month to date', period: { start: monthStart, end: rangeEnd } },
    { id: 'previous_month', label: 'Previous month', period: { start: previousMonthStart, end: previousMonthEnd } },
  ];
}

export function selectedDateRangeLabel(
  period: Period,
  today: string,
  includeToday = false,
  selectedPresetId?: string,
): string {
  const presets = dateRangePresets(today, includeToday);
  const matches = (candidate: DateRangePreset): boolean =>
    candidate.period.start === period.start && candidate.period.end === period.end;
  const preset = presets.find(
    (candidate) => candidate.id === selectedPresetId && matches(candidate),
  ) ?? presets.find(
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
