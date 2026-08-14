/**
 * Phase 0: the profile timeline, normalised to `fact_profile_daily` shape.
 *
 * One `profile` fetch plus one `timeline` drill-down returns every profile on
 * the team for every day it has ever had, in a single file. That is the whole
 * of Phase 0: three MCP calls and one download buy every profile's complete
 * daily history, and it is the reference series every other grain reconciles
 * against.
 *
 * Three properties of that file drive everything here:
 *
 *  1. **The server zero-fills.** Ask for eight years and you get 2,922 rows per
 *     profile whether the account existed or not. "Earliest date with data" is
 *     therefore a local `min(date)` over rows with a nonzero ad metric, not a
 *     server capability. Zero-filled rows are dropped and counted.
 *  2. **The in-progress day is a trap.** On the profile's current local day the
 *     ad columns are populated while every `seller_*` and total column reads 0.
 *     That day is excluded here — never loaded, never compared. Which day it is
 *     depends on the profile's own timezone, not the machine's.
 *  3. **There is no currency column.** `currency_code` is a property of the
 *     profile, so the roster export is parsed alongside and the code attached
 *     at load time.
 *
 * The attribution window is the open question this grain sidesteps: AdLabs
 * exposes one `sales` and one `orders` with no window attached, and our fact
 * tables carry four. At profile grain there is exactly one sales column
 * (`sales_7d`) and one purchases column, so there is nothing to guess. Below
 * this grain there is, which is why Phase 2 is gated.
 */
import { isoDate, metric, parseNumber, parseProjected } from './csv.js';

/** The timeline columns Phase 0 reads. Everything else in the file is ignored. */
export const TIMELINE_COLUMNS = [
  'profile_id',
  'date',
  'impressions',
  'clicks',
  'spend',
  'orders',
  'sales',
  'units',
] as const;

/** The roster columns. Note what is absent: `profile_name`. */
export const ROSTER_COLUMNS = ['profile_id', 'currency_code'] as const;

export interface ProfileDayRow {
  amazonProfileId: string;
  date: string;
  impressions: number;
  clicks: number;
  cost: number;
  purchases7d: number;
  sales7d: number;
  unitsSold7d: number;
}

export interface ParsedTimeline {
  /** Data rows in the file. */
  rowsSeen: number;
  /** Rows dropped as zero-filled: no impressions, no clicks, no spend. */
  rowsZeroFilled: number;
  /** Nonzero days, grouped by Amazon profile id, oldest first. */
  byProfile: Map<string, ProfileDayRow[]>;
}

/**
 * Parse the timeline export.
 *
 * Nothing is filtered by date here. Which day is "in progress" is a per-profile
 * question the loader answers with the profile's timezone, and a normaliser
 * that silently dropped a day would hide the fact that it did.
 */
export function parseProfileTimeline(text: string): ParsedTimeline {
  const table = parseProjected(text, TIMELINE_COLUMNS);
  const byProfile = new Map<string, ProfileDayRow[]>();
  let rowsZeroFilled = 0;

  for (const [index, row] of table.rows.entries()) {
    const amazonProfileId = (row['profile_id'] ?? '').trim();
    if (amazonProfileId === '') continue;

    const impressions = metric(row['impressions'], table.delimiter);
    const clicks = metric(row['clicks'], table.delimiter);
    const cost = metric(row['spend'], table.delimiter);
    if (impressions === 0 && clicks === 0 && cost === 0) {
      rowsZeroFilled += 1;
      continue;
    }

    const day: ProfileDayRow = {
      amazonProfileId,
      date: isoDate(row['date'], `row ${index + 2}`),
      impressions,
      clicks,
      cost,
      purchases7d: metric(row['orders'], table.delimiter),
      sales7d: metric(row['sales'], table.delimiter),
      unitsSold7d: metric(row['units'], table.delimiter),
    };

    const days = byProfile.get(amazonProfileId);
    if (days) days.push(day);
    else byProfile.set(amazonProfileId, [day]);
  }

  for (const days of byProfile.values()) days.sort((left, right) => left.date.localeCompare(right.date));

  return { rowsSeen: table.rows.length, rowsZeroFilled, byProfile };
}

/** `profile_id` → `currency_code`, from the roster export. */
export function parseProfileRoster(text: string): Map<string, string> {
  const table = parseProjected(text, ROSTER_COLUMNS);
  const roster = new Map<string, string>();
  for (const row of table.rows) {
    const id = (row['profile_id'] ?? '').trim();
    const currency = (row['currency_code'] ?? '').trim().toUpperCase();
    if (id !== '' && /^[A-Z]{3}$/.test(currency)) roster.set(id, currency);
  }
  return roster;
}

export interface ProfileDepth {
  amazonProfileId: string;
  firstDate: string;
  lastDate: string;
  /** Days with a nonzero ad metric. Not `lastDate - firstDate`: accounts go quiet. */
  daysWithData: number;
  /** Whole months from `firstDate` to `asOf`. The number the research doc reports. */
  monthsBack: number;
}

/**
 * How deep each profile goes, relative to a reference date.
 *
 * Reported in months back rather than as dates because this is the number that
 * goes in a document: a public README may say "the deepest profile reaches ~25
 * months" and may not say which client that is or when they onboarded.
 */
export function measureDepth(parsed: ParsedTimeline, asOf: string): ProfileDepth[] {
  const depths: ProfileDepth[] = [];
  for (const [amazonProfileId, days] of parsed.byProfile) {
    const firstDate = days[0]?.date;
    const lastDate = days[days.length - 1]?.date;
    if (firstDate === undefined || lastDate === undefined) continue;
    depths.push({
      amazonProfileId,
      firstDate,
      lastDate,
      daysWithData: days.length,
      monthsBack: monthsBetween(firstDate, asOf),
    });
  }
  return depths.sort((left, right) => right.monthsBack - left.monthsBack);
}

/** Whole months between two ISO dates, rounded down. */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  const months = (ty - fy) * 12 + (tm - fm);
  return td >= fd ? months : months - 1;
}

/**
 * The profile's own calendar day.
 *
 * Dates in these exports are the profile's local day — the campaign-day fetch
 * and the profile timeline agree on the same boundary — so "is this day still
 * in progress" is a question about `ad_profiles.timezone`, not about where the
 * loader happens to be running.
 */
export function profileLocalToday(timezone: string, now: Date = new Date()): string {
  try {
    // en-CA formats as YYYY-MM-DD, which is the whole reason for the locale.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    throw new Error(`ad_profiles.timezone is not a timezone this runtime knows: "${timezone}"`);
  }
}

/** Exposed for the tests that assert the reader's null-not-zero behaviour. */
export const readNumber = parseNumber;
