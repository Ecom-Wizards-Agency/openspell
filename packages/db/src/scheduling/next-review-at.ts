import {
  OptimizationReviewSchedule,
  type OptimizationWeekday,
} from '@wizard-ads/shared';

const WEEKDAYS: readonly OptimizationWeekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export interface NextReviewAtInput {
  /** The returned instant is always strictly later than this value. */
  after: Date;
  schedule: unknown;
  timeZone: string;
}

/**
 * Resolve the next selected profile-local weekday and wall-clock time.
 *
 * A spring-forward time that does not exist moves to the first valid local
 * minute after the gap. A repeated fall-back time runs at its first occurrence
 * only; asking again after that occurrence advances to the next selected day.
 * This gives a due scheduler one occurrence per selected local date.
 */
export function nextReviewAt(input: NextReviewAtInput): Date {
  if (!Number.isFinite(input.after.getTime())) throw new Error('after must be a valid date');
  const schedule = OptimizationReviewSchedule.parse(input.schedule);
  const formatter = localFormatter(input.timeZone);
  const localAfter = partsAt(formatter, input.after);
  const [hourText, minuteText] = schedule.localTime.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const selected = new Set(schedule.weekdays);

  for (let offset = 0; offset <= 7; offset += 1) {
    const date = addLocalDays(localAfter, offset);
    if (!selected.has(weekdayFor(date))) continue;
    const candidate = resolveWallClock(formatter, { ...date, hour, minute });
    if (candidate !== null && candidate.getTime() > input.after.getTime()) return candidate;
  }
  throw new Error('could not resolve a strictly future review occurrence');
}

function localFormatter(timeZone: string): Intl.DateTimeFormat {
  if (timeZone.trim().length === 0) throw new Error('timeZone is required');
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    throw new Error('timeZone must be a valid IANA timezone');
  }
}

function partsAt(formatter: Intl.DateTimeFormat, instant: Date): LocalParts {
  const values = new Map(
    formatter.formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  const year = values.get('year');
  const month = values.get('month');
  const day = values.get('day');
  const hour = values.get('hour');
  const minute = values.get('minute');
  if ([year, month, day, hour, minute].some((value) => value === undefined)) {
    throw new Error('could not resolve profile-local date parts');
  }
  return { year: year!, month: month!, day: day!, hour: hour!, minute: minute! };
}

function addLocalDays(date: Pick<LocalParts, 'year' | 'month' | 'day'>, offset: number): Pick<LocalParts, 'year' | 'month' | 'day'> {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + offset));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function weekdayFor(date: Pick<LocalParts, 'year' | 'month' | 'day'>): OptimizationWeekday {
  const sundayFirst = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return WEEKDAYS[(sundayFirst + 6) % 7]!;
}

function resolveWallClock(formatter: Intl.DateTimeFormat, desired: LocalParts): Date | null {
  const wallClockUtc = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
  );
  const approximate = new Date(wallClockUtc);
  const approximateLocal = partsAt(formatter, approximate);
  const offset = Date.UTC(
    approximateLocal.year,
    approximateLocal.month - 1,
    approximateLocal.day,
    approximateLocal.hour,
    approximateLocal.minute,
  ) - approximate.getTime();
  const center = wallClockUtc - offset;
  const exact: Date[] = [];
  let firstAfterGap: { instant: Date; wallMinute: number } | null = null;

  // Three hours covers modern DST changes, including Lord Howe's half-hour
  // transition. The center is already adjusted for the zone's ordinary UTC
  // offset, so this is not a scan across global timezone offsets.
  for (let deltaMinutes = -180; deltaMinutes <= 180; deltaMinutes += 1) {
    const instant = new Date(center + deltaMinutes * 60_000);
    const local = partsAt(formatter, instant);
    if (!sameLocalDate(local, desired)) continue;
    if (local.hour === desired.hour && local.minute === desired.minute) exact.push(instant);
    const wallMinute = local.hour * 60 + local.minute;
    const desiredMinute = desired.hour * 60 + desired.minute;
    if (
      wallMinute > desiredMinute
      && (firstAfterGap === null
        || wallMinute < firstAfterGap.wallMinute
        || (wallMinute === firstAfterGap.wallMinute && instant < firstAfterGap.instant))
    ) {
      firstAfterGap = { instant, wallMinute };
    }
  }
  if (exact.length > 0) {
    exact.sort((left, right) => left.getTime() - right.getTime());
    return exact[0]!;
  }
  return firstAfterGap?.instant ?? null;
}

function sameLocalDate(left: LocalParts, right: LocalParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day;
}
