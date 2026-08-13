/**
 * Port of `pacing.py`: month-to-date run-rate against a monthly ad budget.
 *
 * Run rate is a portfolio-level governor on top of the rank engine, not the
 * strategy itself. This module answers one question: are we pacing over or
 * under the month's budget, and if over, what gets cut first.
 *
 * The cut order is fixed method, not per-client judgement:
 *   waste -> discovery -> profit -> rank
 * with rank last and only on an explicit operator decision, because a
 * mid-flight rank push must never be cut silently.
 *
 * Two honesty rules are structural rather than cosmetic. With no monthly
 * budget the result is `null` rather than an invented budget, and with missing
 * days the pace is understated, so an under-pace verdict is withheld and a
 * note states the gap.
 */
import { formatFixed, formatMoney } from './num.js';
import type { GoalLens, PacingOverrides } from './flags.js';
import { SEVERITY_ALERT, SEVERITY_INFO, SEVERITY_WARN } from './flags.js';
import { dayOfMonth, daysInMonth, firstOfMonth } from './rows.js';
import { CATEGORY_UNKNOWN, type Flag, type Severity } from './types.js';

export interface PacingThresholds {
  warn_above: number;
  act_above: number;
  underpace_below: number;
}

export const DEFAULT_PACING_THRESHOLDS: PacingThresholds = {
  warn_above: 1.1,
  act_above: 1.25,
  underpace_below: 0.75,
};

export const CUT_ORDER = ['waste', 'discovery', 'profit', 'rank'] as const;

export const CUT_ORDER_GUIDANCE = [
  "1. Waste first: high-spend-no-sales targets (the optimizer's own bucket).",
  '2. Discovery: bids down, then budgets (share of spend must stay <= ~20% anyway).',
  '3. Profit: bid trims toward target ACOS; never pause converting targets for pacing.',
  '4. Rank LAST, and ONLY by explicit operator/client decision -- a mid-flight rank ' +
    'push is never cut silently by the governor.',
] as const;

export const UNDERPACE_GUIDANCE = [
  '1. Fund unfunded demand first (SUPA O1 flags).',
  '2. Scale proven winners (SUPA E1 / the weekly PUSH list).',
  '3. Raise budget-capped Rank/SKW campaigns.',
] as const;

export type PacingStatus = 'on_pace' | 'warn' | 'act' | 'underpace';

export const STATUS_ON_PACE: PacingStatus = 'on_pace';
export const STATUS_WARN: PacingStatus = 'warn';
export const STATUS_ACT: PacingStatus = 'act';
export const STATUS_UNDERPACE: PacingStatus = 'underpace';

export interface PacingResult {
  asOf: string;
  monthStart: string;
  dayOfMonth: number;
  daysInMonth: number;
  monthlyBudget: number;
  mtdSpend: number;
  /** `monthlyBudget * dayOfMonth / daysInMonth`. */
  budgetToDate: number;
  /** `mtdSpend / budgetToDate`. */
  pace: number | null;
  status: PacingStatus;
  daysWithData: number;
  /** Every day from month start through `asOf` had a spend figure. */
  coverageComplete: boolean;
  guidance: readonly string[];
  notes: string[];
}

/** A row the governor can read: it needs a date and a spend figure, nothing else. */
export interface SpendRow {
  date?: string | null;
  spend?: number | null;
}

export interface PacingConfig {
  pacing?: PacingOverrides;
}

/**
 * Same layering as the flag thresholds: toolkit defaults, goal-lens
 * `pacing_overrides`, then explicit per-account config. Config always wins.
 */
export function resolvePacingThresholds(
  lens?: GoalLens | null,
  config?: PacingConfig | null,
): PacingThresholds {
  const merged: PacingThresholds = { ...DEFAULT_PACING_THRESHOLDS };
  const known = Object.keys(DEFAULT_PACING_THRESHOLDS) as Array<keyof PacingThresholds>;
  if (lens?.pacing_overrides) {
    for (const key of known) {
      const value = lens.pacing_overrides[key];
      if (value !== undefined) merged[key] = value;
    }
  }
  if (config?.pacing) {
    for (const key of known) {
      const value = config.pacing[key];
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

/**
 * Month-to-date pace as of `asOf` inclusive. `null` when no monthly budget is
 * known: pacing simply does not apply, which the report states rather than
 * inventing a budget.
 */
export function computePacing(
  accountRows: SpendRow[],
  asOf: string,
  monthlyBudget: number | null | undefined,
  lens?: GoalLens | null,
  config?: PacingConfig | null,
): PacingResult | null {
  if (!monthlyBudget || monthlyBudget <= 0) return null;

  const thresholds = resolvePacingThresholds(lens, config);
  const monthStart = firstOfMonth(asOf);
  const totalDays = daysInMonth(asOf);
  const day = dayOfMonth(asOf);

  let mtdSpend = 0.0;
  let daysWithData = 0;
  const seen = new Set<string>();
  for (const row of accountRows) {
    const date = row.date ?? null;
    const spend = row.spend ?? null;
    if (date === null || spend === null) continue;
    if (!(monthStart <= date && date <= asOf) || seen.has(date)) continue;
    seen.add(date);
    mtdSpend += spend;
    daysWithData += 1;
  }

  const budgetToDate = (monthlyBudget * day) / totalDays;
  const pace = budgetToDate > 0 ? mtdSpend / budgetToDate : null;
  const coverageComplete = daysWithData >= day;

  const notes: string[] = [];
  if (!coverageComplete) {
    notes.push(
      `Only ${daysWithData} of ${day} month-to-date days have a spend figure -- ` +
        'the pace is understated; widen the Sellerboard window before acting on an under-pace read.',
    );
  }

  let status: PacingStatus = STATUS_ON_PACE;
  let guidance: readonly string[] = [];
  if (pace !== null) {
    if (pace > thresholds.act_above) {
      status = STATUS_ACT;
      guidance = CUT_ORDER_GUIDANCE;
    } else if (pace > thresholds.warn_above) {
      status = STATUS_WARN;
    } else if (pace < thresholds.underpace_below && coverageComplete) {
      status = STATUS_UNDERPACE;
      guidance = UNDERPACE_GUIDANCE;
    }
  }

  return {
    asOf,
    monthStart,
    dayOfMonth: day,
    daysInMonth: totalDays,
    monthlyBudget,
    mtdSpend,
    budgetToDate,
    pace,
    status,
    daysWithData,
    coverageComplete,
    guidance,
    notes,
  };
}

/**
 * One account-level flag for the daily/weekly flag sections. On pace produces
 * no flag at all; act produces an alert, because the governor is saying apply
 * the cut order.
 */
export function pacingFlag(pacing: PacingResult | null, lens?: GoalLens | null): Flag | null {
  if (pacing === null || pacing.pace === null || pacing.status === STATUS_ON_PACE) return null;
  const label = lens?.label;
  let severity: Severity;
  let cause: string;
  if (pacing.status === STATUS_ACT) {
    severity = SEVERITY_ALERT;
    cause =
      'Over pace: apply the fixed cut order (waste -> discovery -> profit; Rank last and only ' +
      'by explicit operator decision).';
  } else if (pacing.status === STATUS_WARN) {
    severity = SEVERITY_WARN;
    cause =
      'Slightly over pace: watch, no action yet. Check for event days (deal/holiday) before reading it as drift.';
  } else {
    severity = pacing.coverageComplete ? SEVERITY_WARN : SEVERITY_INFO;
    cause = 'Under pace: fund unfunded demand (O1), scale winners (E1), raise capped Rank budgets.';
  }
  if (label && label !== 'Neutral') {
    cause += ` (Read under the '${label}' goal lens.)`;
  }
  return {
    severity,
    metric: 'run_rate_pace',
    threshold: `pace ${formatFixed(pacing.pace, 2)} vs budget-to-date`,
    message:
      `MTD ad spend ${formatMoney(pacing.mtdSpend)} vs ${formatMoney(pacing.budgetToDate)} budget-to-date ` +
      `(day ${pacing.dayOfMonth}/${pacing.daysInMonth}, monthly budget ${formatMoney(pacing.monthlyBudget)}) ` +
      `-- pace ${formatFixed(pacing.pace, 2)}.`,
    likelyCause: cause,
    scope: 'account',
    category: CATEGORY_UNKNOWN,
    suppressed: false,
    suppressedReason: null,
  };
}
