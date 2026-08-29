import type { MarketingStreamHourlyFact } from '@wizard-ads/shared';

export const DAYPARTING_METRICS = [
  'roas',
  'conversion_rate',
  'acos',
  'ctr',
  'cpc',
  'spend',
  'sales',
  'orders',
] as const;

export type DaypartingMetric = (typeof DAYPARTING_METRICS)[number];

export interface DaypartingCell {
  dayOfWeek: number;
  hour: number;
  impressions: number;
  clicks: number;
  spend: number;
  orders: number;
  sales: number;
  settledFacts: number;
  settlingFacts: number;
  revisedFacts: number;
  cappedFacts: number;
  sourceEvents: number;
  value: number | null;
  strength: number;
}

export interface DaypartingSummary {
  firstLocalDate: string | null;
  lastLocalDate: string | null;
  timeZone: string | null;
  settledHours: number;
  settlingHours: number;
  revisedHours: number;
  cappedHours: number;
  campaigns: string[];
}

export function isDaypartingMetric(value: string | undefined): value is DaypartingMetric {
  return DAYPARTING_METRICS.some((candidate) => candidate === value);
}

export function summarizeDaypartingFacts(
  facts: readonly MarketingStreamHourlyFact[],
): DaypartingSummary {
  const dates = [...new Set(facts.map((fact) => fact.localDate))].sort();
  return {
    firstLocalDate: dates[0] ?? null,
    lastLocalDate: dates.at(-1) ?? null,
    timeZone: facts[0]?.profileTimeZone ?? null,
    settledHours: uniqueHours(facts.filter((fact) => fact.settlingState === 'settled')),
    settlingHours: uniqueHours(facts.filter((fact) => fact.settlingState === 'settling')),
    revisedHours: uniqueHours(facts.filter((fact) => fact.settlingState === 'revised')),
    cappedHours: uniqueHours(facts.filter((fact) => fact.budgetCapped)),
    campaigns: [...new Set(facts.map((fact) => fact.campaignId))].sort(),
  };
}

export function buildDaypartingHeatmap(
  facts: readonly MarketingStreamHourlyFact[],
  metric: DaypartingMetric,
): DaypartingCell[] {
  const cells = new Map<string, Omit<DaypartingCell, 'value' | 'strength'>>();
  for (const fact of facts) {
    const key = `${fact.localDayOfWeek}|${fact.localHour}`;
    const cell = cells.get(key) ?? {
      dayOfWeek: fact.localDayOfWeek,
      hour: fact.localHour,
      impressions: 0,
      clicks: 0,
      spend: 0,
      orders: 0,
      sales: 0,
      settledFacts: 0,
      settlingFacts: 0,
      revisedFacts: 0,
      cappedFacts: 0,
      sourceEvents: 0,
    };
    cell.impressions += fact.impressions;
    cell.clicks += fact.clicks;
    cell.spend += fact.cost;
    cell.orders += fact.purchases;
    cell.sales += fact.sales;
    cell.sourceEvents += fact.sourceEvents;
    cell.cappedFacts += fact.budgetCapped ? 1 : 0;
    if (fact.settlingState === 'settled') cell.settledFacts += 1;
    if (fact.settlingState === 'settling') cell.settlingFacts += 1;
    if (fact.settlingState === 'revised') cell.revisedFacts += 1;
    cells.set(key, cell);
  }

  const withValues = [...cells.values()].map((cell) => ({
    ...cell,
    value: metricValue(cell, metric),
    strength: 0,
  }));
  const finite = withValues
    .map((cell) => cell.value)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const maximum = finite.length === 0 ? 0 : Math.max(...finite);
  const minimum = finite.length === 0 ? 0 : Math.min(...finite);

  return withValues.map((cell) => ({
    ...cell,
    strength: cell.value === null || maximum === minimum
      ? (cell.value === null ? 0 : 0.5)
      : (cell.value - minimum) / (maximum - minimum),
  })).sort((left, right) => left.dayOfWeek - right.dayOfWeek || left.hour - right.hour);
}

export function formatDaypartingMetric(
  value: number | null,
  metric: DaypartingMetric,
  currencyCode: string,
): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (metric === 'roas') return `${value.toFixed(2)}×`;
  if (metric === 'conversion_rate' || metric === 'acos' || metric === 'ctr') {
    return `${(value * 100).toFixed(1)}%`;
  }
  if (metric === 'orders') return Math.round(value).toLocaleString('en-US');
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
    maximumFractionDigits: metric === 'cpc' ? 2 : 0,
  }).format(value);
}

function metricValue(
  cell: Pick<DaypartingCell, 'impressions' | 'clicks' | 'spend' | 'orders' | 'sales'>,
  metric: DaypartingMetric,
): number | null {
  if (metric === 'roas') return divide(cell.sales, cell.spend);
  if (metric === 'conversion_rate') return divide(cell.orders, cell.clicks);
  if (metric === 'acos') return divide(cell.spend, cell.sales);
  if (metric === 'ctr') return divide(cell.clicks, cell.impressions);
  if (metric === 'cpc') return divide(cell.spend, cell.clicks);
  if (metric === 'spend') return cell.spend;
  if (metric === 'sales') return cell.sales;
  return cell.orders;
}

function divide(numerator: number, denominator: number): number | null {
  return denominator <= 0 ? null : numerator / denominator;
}

function uniqueHours(facts: readonly MarketingStreamHourlyFact[]): number {
  return new Set(facts.map((fact) => fact.utcHour)).size;
}
