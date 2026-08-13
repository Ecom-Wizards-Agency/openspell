/**
 * Port of `analyze.py`: delta and trend computation.
 *
 * For the report date, every metric gets its value, its change against the
 * prior day and against the trailing-7 average (absolute and percent), plus an
 * up/down/flat trend over that trailing window. Missing dates degrade to
 * `null` deltas rather than raising, because a report with no zero-impression
 * rows genuinely has holes and inventing zeros there would fabricate a trend.
 */
import { safeDiv } from './num.js';
import { addDays, metricValue } from './rows.js';
import {
  CATEGORY_UNKNOWN,
  METRICS,
  type AnalysisResult,
  type CampaignCategory,
  type DailyRow,
  type MetricDelta,
  type SeriesAnalysis,
  type Trend,
} from './types.js';

export const TREND_UP: Trend = 'up';
export const TREND_DOWN: Trend = 'down';
export const TREND_FLAT: Trend = 'flat';

/** A first-half-vs-second-half average change smaller than this counts as flat. */
export const TREND_TOLERANCE = 0.05;

function pctChange(next: number | null, old: number | null): number | null {
  if (next === null || old === null || old === 0) return null;
  return (next - old) / Math.abs(old);
}

function absChange(next: number | null, old: number | null): number | null {
  if (next === null || old === null) return null;
  return next - old;
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Classify a trend by first-half versus second-half average.
 *
 * `values` is the trailing window oldest first. Missing points are dropped
 * before averaging, so a week with two holes is still classified from the days
 * that exist rather than being called flat by default.
 */
export function classifyTrend(
  values: Array<number | null>,
  tolerance: number = TREND_TOLERANCE,
): Trend {
  const clean = values.filter((v): v is number => v !== null);
  if (clean.length < 2) return TREND_FLAT;
  const mid = Math.floor(clean.length / 2);
  const firstHalf = clean.slice(0, mid).length > 0 ? clean.slice(0, mid) : clean.slice(0, 1);
  const secondHalf = clean.slice(mid).length > 0 ? clean.slice(mid) : clean.slice(-1);
  const avgFirst = mean(firstHalf);
  const avgSecond = mean(secondHalf);
  if (avgFirst === 0) return avgSecond === 0 ? TREND_FLAT : TREND_UP;
  const change = (avgSecond - avgFirst) / Math.abs(avgFirst);
  if (change > tolerance) return TREND_UP;
  if (change < -tolerance) return TREND_DOWN;
  return TREND_FLAT;
}

export interface AnalyzeSeriesOptions {
  label: string;
  campaignId?: string | null;
  category?: CampaignCategory;
  metrics?: readonly string[];
}

/**
 * Analyze one series (the account overall, or a single campaign).
 *
 * `rowsByDate` should cover the report date, the prior day and the seven days
 * before it for full coverage; anything missing produces `null` deltas.
 */
export function analyzeSeries(
  rowsByDate: Map<string, DailyRow>,
  reportDate: string,
  options: AnalyzeSeriesOptions,
): SeriesAnalysis {
  const reportRow = rowsByDate.get(reportDate) ?? null;
  const priorRow = rowsByDate.get(addDays(reportDate, -1)) ?? null;
  const trailingNewestFirst: Array<DailyRow | null> = [];
  for (let d = 1; d <= 7; d += 1) {
    trailingNewestFirst.push(rowsByDate.get(addDays(reportDate, -d)) ?? null);
  }

  const deltas: Record<string, MetricDelta> = {};
  for (const metric of options.metrics ?? METRICS) {
    const value = metricValue(reportRow, metric);
    const priorValue = metricValue(priorRow, metric);
    const trailingValuesNewestFirst = trailingNewestFirst.map((row) => metricValue(row, metric));
    const trailingClean = trailingValuesNewestFirst.filter((v): v is number => v !== null);
    const trailingAvg = trailingClean.length > 0 ? mean(trailingClean) : null;
    deltas[metric] = {
      metric,
      value,
      priorValue,
      priorAbsChange: absChange(value, priorValue),
      priorPctChange: pctChange(value, priorValue),
      trailing7Avg: trailingAvg,
      trailing7AbsChange: absChange(value, trailingAvg),
      trailing7PctChange: pctChange(value, trailingAvg),
      trend: classifyTrend([...trailingValuesNewestFirst].reverse()),
    };
  }

  return {
    label: options.label,
    campaignId: options.campaignId ?? null,
    category: options.category ?? CATEGORY_UNKNOWN,
    reportRow,
    deltas,
  };
}

/**
 * Analyze an account plus every campaign under it.
 *
 * `metrics` applies to the account series and to every campaign series, the
 * same way the reference applies it.
 */
export function analyzeAccount(
  account: string,
  reportDate: string,
  accountRows: DailyRow[],
  campaignRows: DailyRow[],
  metrics?: readonly string[],
): AnalysisResult {
  const byDate = new Map<string, DailyRow>();
  for (const row of accountRows) byDate.set(row.date, row);
  const accountSeries = analyzeSeries(byDate, reportDate, {
    label: account,
    category: CATEGORY_UNKNOWN,
    metrics,
  });

  // Insertion order matters only up to the sort below, but it is preserved so
  // a tie in labels resolves the way the reference's dict iteration resolves it.
  const perCampaign = new Map<string, Map<string, DailyRow>>();
  for (const row of campaignRows) {
    const key = row.campaignId ?? '';
    let bucket = perCampaign.get(key);
    if (!bucket) {
      bucket = new Map<string, DailyRow>();
      perCampaign.set(key, bucket);
    }
    bucket.set(row.date, row);
  }

  const campaignSeries: SeriesAnalysis[] = [];
  for (const [campaignId, byDateForCampaign] of perCampaign) {
    const anyRow = byDateForCampaign.values().next().value as DailyRow;
    campaignSeries.push(
      analyzeSeries(byDateForCampaign, reportDate, {
        label: anyRow.campaignName || campaignId,
        campaignId,
        category: anyRow.category ?? CATEGORY_UNKNOWN,
        metrics,
      }),
    );
  }
  campaignSeries.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

  return { account, reportDate, accountSeries, campaignSeries };
}

// ---------------------------------------------------------------------------
// Weekly (week-over-week) aggregation.
//
// Additive metrics are summed over each 7-day window; ratio metrics are
// RECOMPUTED from those sums rather than averaged day by day, so one big day
// and one near-zero day do not get equal weight. `real_acos` is the exception:
// it is the source's own computed figure and may fold in costs this engine
// never sees, so its weekly value is the mean of the days that reported one.

export const WEEKLY_SUM_METRICS = [
  'total_sales',
  'sales',
  'spend',
  'orders',
  'units_organic',
  'units_ppc',
  'refunds',
  'gross_profit',
  'net_profit',
  'sessions',
] as const;
export const WEEKLY_AVG_METRICS = ['real_acos'] as const;
export const WEEKLY_RATIO_METRICS = ['acos', 'tacos', 'margin'] as const;
export const WEEKLY_METRICS = [
  'total_sales',
  'sales',
  'spend',
  'tacos',
  'real_acos',
  'acos',
  'orders',
  'units_organic',
  'units_ppc',
  'refunds',
  'gross_profit',
  'net_profit',
  'margin',
  'sessions',
] as const;

export interface WeeklyMetricDelta {
  metric: string;
  thisWeek: number | null;
  lastWeek: number | null;
  absChange: number | null;
  pctChange: number | null;
}

export interface WeeklyAnalysis {
  account: string;
  weekEnd: string;
  thisWeekStart: string;
  lastWeekStart: string;
  lastWeekEnd: string;
  deltas: Record<string, WeeklyMetricDelta>;
  thisWeekRows: DailyRow[];
  lastWeekRows: DailyRow[];
}

/** Raw-field sum, skipping days that did not report the metric. */
function sumMetric(rows: DailyRow[], metric: string): number | null {
  const values = rows
    .map((row) => metricValue(row, metric))
    .filter((v): v is number => v !== null);
  return values.length > 0 ? values.reduce((sum, v) => sum + v, 0) : null;
}

function avgMetric(rows: DailyRow[], metric: string): number | null {
  const values = rows
    .map((row) => metricValue(row, metric))
    .filter((v): v is number => v !== null);
  return values.length > 0 ? mean(values) : null;
}

/**
 * Aggregate account-level daily rows into this-week versus last-week totals.
 *
 * "This week" is the seven days ending `weekEnd` inclusive; "last week" is the
 * seven immediately before it. Missing days degrade to `null`.
 */
export function aggregateWeek(accountRows: DailyRow[], weekEnd: string): WeeklyAnalysis {
  const rowsByDate = new Map<string, DailyRow>();
  for (const row of accountRows) rowsByDate.set(row.date, row);
  const thisWeekStart = addDays(weekEnd, -6);
  const lastWeekEnd = addDays(thisWeekStart, -1);
  const lastWeekStart = addDays(lastWeekEnd, -6);

  const sortedDates = [...rowsByDate.keys()].sort();
  const thisWeekRows = sortedDates
    .filter((d) => d >= thisWeekStart && d <= weekEnd)
    .map((d) => rowsByDate.get(d) as DailyRow);
  const lastWeekRows = sortedDates
    .filter((d) => d >= lastWeekStart && d <= lastWeekEnd)
    .map((d) => rowsByDate.get(d) as DailyRow);

  const deltas: Record<string, WeeklyMetricDelta> = {};
  const add = (metric: string, thisVal: number | null, lastVal: number | null): void => {
    deltas[metric] = {
      metric,
      thisWeek: thisVal,
      lastWeek: lastVal,
      absChange: absChange(thisVal, lastVal),
      pctChange: pctChange(thisVal, lastVal),
    };
  };

  for (const metric of WEEKLY_SUM_METRICS) {
    add(metric, sumMetric(thisWeekRows, metric), sumMetric(lastWeekRows, metric));
  }
  for (const metric of WEEKLY_AVG_METRICS) {
    add(metric, avgMetric(thisWeekRows, metric), avgMetric(lastWeekRows, metric));
  }

  const get = (metric: string, which: 'thisWeek' | 'lastWeek'): number | null =>
    deltas[metric]?.[which] ?? null;

  add('acos', safeDiv(get('spend', 'thisWeek'), get('sales', 'thisWeek')), safeDiv(get('spend', 'lastWeek'), get('sales', 'lastWeek')));
  add('tacos', safeDiv(get('spend', 'thisWeek'), get('total_sales', 'thisWeek')), safeDiv(get('spend', 'lastWeek'), get('total_sales', 'lastWeek')));
  add('margin', safeDiv(get('net_profit', 'thisWeek'), get('total_sales', 'thisWeek')), safeDiv(get('net_profit', 'lastWeek'), get('total_sales', 'lastWeek')));

  return {
    account: accountRows.length > 0 ? (accountRows[0] as DailyRow).account : 'unknown',
    weekEnd,
    thisWeekStart,
    lastWeekStart,
    lastWeekEnd,
    deltas,
    thisWeekRows,
    lastWeekRows,
  };
}
