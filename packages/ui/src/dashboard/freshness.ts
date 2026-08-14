/**
 * Data freshness, read from the report ledger and nowhere else.
 *
 * This is the one rule in the brief with a "NOT" in it: freshness comes from
 * `report_requests`, **not** from the facts. The reason is structural, not
 * stylistic. Amazon omits zero-impression rows, so "the newest fact row is from
 * Tuesday" is equally consistent with "the sync stopped on Tuesday" and "the
 * account has spent nothing since Tuesday". Only the ledger distinguishes them,
 * and the difference is the whole question an operator is asking when they look
 * at the banner.
 *
 * A profile can therefore be **fresh and wrong** (ledger green, numbers disagree
 * with the incumbent) or **stale and verified** (ledger red, last comparison
 * passed). That is why this banner and the crosscheck chip are two separate
 * things on the dashboard and must never be merged into one traffic light.
 */
import { formatInteger } from '../format.js';

export type FreshnessTone = 'good' | 'warn' | 'bad' | 'muted';

export interface ReportLedgerEntry {
  reportType: string;
  status: string;
  /** Newest day the report covers. */
  endDate: string;
  requestedAt: string;
  completedAt: string | null;
  rowsParsed: number | null;
  rowsLoaded: number | null;
  /** Generated column on `report_requests`; null when nothing has been loaded. */
  countsMatch: boolean | null;
  error: string | null;
}

export interface FreshnessAssessment {
  tone: FreshnessTone;
  headline: string;
  /** One line per report type, newest first. */
  details: string[];
  /** Report types whose newest successful load is older than the threshold. */
  staleTypes: string[];
  /** Report types whose last load parsed more rows than it wrote. */
  lossyTypes: string[];
  /** Newest end date across every completed report. */
  coversThrough: string | null;
}

export interface FreshnessOptions {
  /** Evaluation instant. Injected so the assessment is testable. */
  now: Date;
  /**
   * Hours after which a completed load counts as stale. 30 by default: a daily
   * sync that ran yesterday is fine, one that last ran the day before is not.
   */
  staleAfterHours?: number;
}

const HOUR_MS = 3_600_000;

export function assessFreshness(
  entries: readonly ReportLedgerEntry[],
  options: FreshnessOptions,
): FreshnessAssessment {
  if (entries.length === 0) {
    return {
      tone: 'muted',
      headline: 'No report has ever been requested for this profile.',
      details: [
        'Freshness is read from the report ledger, not from the fact tables: with no ledger row ' +
          'there is nothing to be fresh or stale.',
      ],
      staleTypes: [],
      lossyTypes: [],
      coversThrough: null,
    };
  }

  const staleAfter = (options.staleAfterHours ?? 30) * HOUR_MS;
  const byType = new Map<string, ReportLedgerEntry[]>();
  for (const entry of entries) {
    const bucket = byType.get(entry.reportType);
    if (bucket === undefined) byType.set(entry.reportType, [entry]);
    else bucket.push(entry);
  }

  const details: string[] = [];
  const staleTypes: string[] = [];
  const lossyTypes: string[] = [];
  const failedTypes: string[] = [];
  let coversThrough: string | null = null;

  for (const [reportType, rows] of [...byType].sort(([a], [b]) => a.localeCompare(b))) {
    const newest = [...rows].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
    const lastGood = [...rows]
      .filter((row) => row.status === 'completed' && row.completedAt !== null)
      .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))[0];

    if (lastGood === undefined) {
      failedTypes.push(reportType);
      details.push(
        `${reportType}: never completed — newest attempt ${newest?.status ?? 'unknown'}` +
          (newest?.error ? ` (${newest.error})` : ''),
      );
      continue;
    }

    if (coversThrough === null || lastGood.endDate > coversThrough) coversThrough = lastGood.endDate;

    const ageMs = options.now.getTime() - new Date(lastGood.completedAt as string).getTime();
    const stale = ageMs > staleAfter;
    if (stale) staleTypes.push(reportType);

    // Rule 45 surfaced where an operator sees it: a load that parsed more rows
    // than it wrote is a silent data loss, and the banner is the only place it
    // would ever be noticed.
    if (lastGood.countsMatch === false) lossyTypes.push(reportType);

    details.push(
      `${reportType}: loaded ${formatAge(ageMs)} ago, covers through ${lastGood.endDate}` +
        (lastGood.rowsLoaded === null ? '' : `, ${formatInteger(lastGood.rowsLoaded)} rows`) +
        (lastGood.countsMatch === false
          ? ` — parsed ${count(lastGood.rowsParsed)}, wrote ${count(lastGood.rowsLoaded)}`
          : '') +
        (newest !== undefined && newest.status !== 'completed' ? ` · newest attempt ${newest.status}` : ''),
    );
  }

  if (failedTypes.length > 0) {
    return {
      tone: 'bad',
      headline: `No completed load for ${failedTypes.join(', ')}. The figures below are older than this page.`,
      details,
      staleTypes,
      lossyTypes,
      coversThrough,
    };
  }
  if (lossyTypes.length > 0) {
    return {
      tone: 'bad',
      headline: `Row loss on ${lossyTypes.join(', ')}: the file held more rows than reached the fact tables.`,
      details,
      staleTypes,
      lossyTypes,
      coversThrough,
    };
  }
  if (staleTypes.length > 0) {
    return {
      tone: 'warn',
      headline: `Stale: ${staleTypes.join(', ')} has not loaded successfully in over ${options.staleAfterHours ?? 30} hours.`,
      details,
      staleTypes,
      lossyTypes,
      coversThrough,
    };
  }

  return {
    tone: 'good',
    headline: `Fresh${coversThrough === null ? '' : ` · covers through ${coversThrough}`}.`,
    details,
    staleTypes,
    lossyTypes,
    coversThrough,
  };
}

const count = (value: number | null): string => (value === null ? '?' : formatInteger(value));

function formatAge(ms: number): string {
  const hours = ms / HOUR_MS;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} days`;
}
