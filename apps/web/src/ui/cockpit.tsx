'use client';

/**
 * The dashboard cockpit keeps four operator KPIs prominent while allowing up
 * to four metrics in one deliberately compact trend view.
 *
 * Chart buckets are built from base facts. Missing dates are completed only
 * between the first and last supplied fact, and ratios are derived after base
 * facts are summed into a week or month. We never average daily ratios.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { deriveMetric } from '@wizard-ads/ui';
import type { KpiTileModel } from '../optimizer/view';

export interface CockpitDay {
  date: string;
  impressions: number;
  clicks: number;
  spend: number;
  sales: number;
  orders: number;
}

export interface CockpitProps {
  days: readonly CockpitDay[];
  tiles: readonly KpiTileModel[];
  currencyCode: string;
  /** First day (inclusive) of the not-yet-settled attribution tail. */
  settlingStart: string | null;
  /** First day facts actually exist — the honest coverage boundary. */
  coverageStart: string | null;
  /** Stable account key used to restore this operator's chart view. */
  preferenceKey: string;
}

export type Granularity = 'D' | 'W' | 'M';
export type SeriesMark = 'line' | 'bar';
export type SeriesAxis = 'left' | 'right';

export interface SeriesPresentation {
  mark: SeriesMark;
  axis: SeriesAxis;
}

export interface CockpitPreferences {
  version: 1;
  selected: string[];
  granularity: Granularity;
  presentations: Record<string, SeriesPresentation>;
}

export interface SeriesPoint {
  /** Stable bucket key: date, Monday, or YYYY-MM. */
  date: string;
  periodStart: string;
  periodEnd: string;
  value: number | null;
  observedDays: number;
  calendarDays: number;
}

interface ChartSeries {
  metric: string;
  label: string;
  scale: KpiTileModel['scale'];
  color: string;
  presentation: SeriesPresentation;
  points: SeriesPoint[];
}

const DAY_MS = 86_400_000;
const PRIMARY_METRICS = ['spend', 'sales', 'orders', 'acos'] as const;
const SERIES_COLORS = [
  'var(--wa-viz-1)',
  'var(--wa-viz-2)',
  'var(--wa-viz-3)',
  'var(--wa-viz-4)',
] as const;
const GRANULARITY_LABELS: Record<Granularity, string> = {
  D: 'Daily',
  W: 'Weekly',
  M: 'Monthly',
};

export const MAX_CHART_SERIES = 4;
const PREFERENCE_VERSION = 1;
const PREFERENCE_PREFIX = 'openspell:performance-chart:v1';
const BAR_METRICS = new Set(['spend', 'orders', 'impressions', 'clicks']);
const RIGHT_AXIS_METRICS = new Set([
  'sales',
  'orders',
  'impressions',
  'clicks',
  'acos',
  'roas',
  'rpc',
  'ctr',
  'cpc',
  'aov',
  'cpa',
  'cvr',
  'cpm',
]);

function zeroDay(date: string): CockpitDay {
  return { date, impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0 };
}

function parseDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function addDays(date: string, amount: number): string {
  return new Date(parseDate(date).getTime() + amount * DAY_MS).toISOString().slice(0, 10);
}

function laterDate(a: string, b: string): string {
  return a > b ? a : b;
}

function earlierDate(a: string, b: string): string {
  return a < b ? a : b;
}

function lastDayOfMonth(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year as number, monthNumber as number, 0)).toISOString().slice(0, 10);
}

function addInto(target: CockpitDay, source: CockpitDay): void {
  target.impressions += source.impressions;
  target.clicks += source.clicks;
  target.spend += source.spend;
  target.sales += source.sales;
  target.orders += source.orders;
}

export function partitionKpiTiles(tiles: readonly KpiTileModel[]): {
  primary: KpiTileModel[];
  supporting: KpiTileModel[];
} {
  const byMetric = new Map(tiles.map((tile) => [tile.metric, tile]));
  const primary = PRIMARY_METRICS.flatMap((metric) => {
    const tile = byMetric.get(metric);
    return tile === undefined ? [] : [tile];
  });
  const primarySet = new Set(PRIMARY_METRICS);
  return {
    primary,
    supporting: tiles.filter((tile) => !primarySet.has(tile.metric as (typeof PRIMARY_METRICS)[number])),
  };
}

/** Keep one metric selected and reject a fifth without silently replacing one. */
export function selectionAfterToggle(current: readonly string[], metric: string): string[] {
  if (current.includes(metric)) {
    return current.length === 1 ? [...current] : current.filter((candidate) => candidate !== metric);
  }
  return current.length >= MAX_CHART_SERIES ? [...current] : [...current, metric];
}

export function presentationAfterChange(
  current: Readonly<Record<string, SeriesPresentation>>,
  metric: string,
  patch: Partial<SeriesPresentation>,
): Record<string, SeriesPresentation> {
  const previous = current[metric] ?? defaultPresentation(metric);
  return { ...current, [metric]: { ...previous, ...patch } };
}

/**
 * Semantic preset for a readable first view: activity totals are bars, while
 * attributed sales, rates, and unit economics are lines on the comparison axis.
 * Operator changes are persisted separately and always win over these defaults.
 */
export function defaultPresentation(metric: string): SeriesPresentation {
  return {
    mark: BAR_METRICS.has(metric) ? 'bar' : 'line',
    axis: RIGHT_AXIS_METRICS.has(metric) ? 'right' : 'left',
  };
}

function isPresentation(value: unknown): value is SeriesPresentation {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SeriesPresentation>;
  return (candidate.mark === 'line' || candidate.mark === 'bar')
    && (candidate.axis === 'left' || candidate.axis === 'right');
}

export function parseCockpitPreferences(
  serialized: string | null,
  availableMetrics: readonly string[],
): CockpitPreferences | null {
  if (serialized === null) return null;
  try {
    const parsed = JSON.parse(serialized) as Partial<CockpitPreferences>;
    if (parsed.version !== PREFERENCE_VERSION) return null;
    if (!Array.isArray(parsed.selected)) return null;
    if (parsed.granularity !== 'D' && parsed.granularity !== 'W' && parsed.granularity !== 'M') return null;

    const available = new Set(availableMetrics);
    const selected = [...new Set(parsed.selected)]
      .filter((metric): metric is string => typeof metric === 'string' && available.has(metric))
      .slice(0, MAX_CHART_SERIES);
    if (selected.length === 0) return null;

    const supplied = parsed.presentations;
    const presentations = Object.fromEntries(
      selected.map((metric) => {
        const candidate = typeof supplied === 'object' && supplied !== null ? supplied[metric] : undefined;
        return [metric, isPresentation(candidate) ? candidate : defaultPresentation(metric)];
      }),
    );
    return { version: PREFERENCE_VERSION, selected, granularity: parsed.granularity, presentations };
  } catch {
    return null;
  }
}

function preferenceStorageKey(preferenceKey: string): string {
  return `${PREFERENCE_PREFIX}:${preferenceKey}`;
}

function readPreferences(preferenceKey: string): string | null {
  try {
    return window.localStorage?.getItem(preferenceStorageKey(preferenceKey)) ?? null;
  } catch {
    return null;
  }
}

function writePreferences(preferenceKey: string, preferences: CockpitPreferences): void {
  try {
    window.localStorage?.setItem(preferenceStorageKey(preferenceKey), JSON.stringify(preferences));
  } catch {
    // Storage may be disabled or unavailable. The chart remains fully usable in memory.
  }
}

function formatValue(value: number | null, scale: KpiTileModel['scale'], currency: string): string {
  if (value === null) return '—';
  if (scale === 'percent') return `${(value * 100).toFixed(1)}%`;
  if (scale === 'ratio') return value.toFixed(2);
  if (scale === 'integer') return Math.round(value).toLocaleString('en-US');
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: value >= 100 ? 0 : 2,
  });
}

function formatExactValue(value: number | null, scale: KpiTileModel['scale'], currency: string): string {
  if (value === null) return '—';
  if (scale === 'percent') return `${(value * 100).toFixed(2)}%`;
  if (scale === 'ratio') return value.toFixed(2);
  if (scale === 'integer') return Math.round(value).toLocaleString('en-US');
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatCompactAxis(value: number): string {
  return value.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
}

export function bucketKey(date: string, granularity: Granularity): string {
  if (granularity === 'D') return date;
  if (granularity === 'M') return date.slice(0, 7);
  const day = parseDate(date);
  const monday = new Date(day);
  monday.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

/** Complete internal calendar gaps without extending beyond supplied evidence. */
export function completeDailyFacts(days: readonly CockpitDay[]): {
  days: CockpitDay[];
  observedDates: ReadonlySet<string>;
} {
  if (days.length === 0) return { days: [], observedDates: new Set() };

  const byDate = new Map<string, CockpitDay>();
  for (const day of days) {
    const accumulated = byDate.get(day.date) ?? zeroDay(day.date);
    addInto(accumulated, day);
    byDate.set(day.date, accumulated);
  }

  const observedDates = new Set(byDate.keys());
  const sortedDates = [...observedDates].sort();
  const start = sortedDates[0] as string;
  const end = sortedDates.at(-1) as string;
  const complete: CockpitDay[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    complete.push(byDate.get(date) ?? zeroDay(date));
  }
  return { days: complete, observedDates };
}

function bucketPeriod(
  key: string,
  granularity: Granularity,
  coverageStart: string,
  coverageEnd: string,
): { start: string; end: string } {
  if (granularity === 'D') return { start: key, end: key };
  if (granularity === 'W') {
    return {
      start: laterDate(key, coverageStart),
      end: earlierDate(addDays(key, 6), coverageEnd),
    };
  }
  return {
    start: laterDate(`${key}-01`, coverageStart),
    end: earlierDate(lastDayOfMonth(key), coverageEnd),
  };
}

export function seriesFor(
  days: readonly CockpitDay[],
  metric: string,
  granularity: Granularity,
): SeriesPoint[] {
  const completed = completeDailyFacts(days);
  if (completed.days.length === 0) return [];

  const coverageStart = completed.days[0]?.date as string;
  const coverageEnd = completed.days.at(-1)?.date as string;
  const buckets = new Map<string, CockpitDay & { observedDays: number; calendarDays: number }>();
  for (const day of completed.days) {
    const key = bucketKey(day.date, granularity);
    const accumulated = buckets.get(key) ?? {
      ...zeroDay(key),
      observedDays: 0,
      calendarDays: 0,
    };
    addInto(accumulated, day);
    accumulated.calendarDays += 1;
    if (completed.observedDates.has(day.date)) accumulated.observedDays += 1;
    buckets.set(key, accumulated);
  }

  return [...buckets.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((bucket) => {
      const period = bucketPeriod(bucket.date, granularity, coverageStart, coverageEnd);
      return {
        date: bucket.date,
        periodStart: period.start,
        periodEnd: period.end,
        value: deriveMetric(metric, {
          impressions: bucket.impressions,
          clicks: bucket.clicks,
          spend: bucket.spend,
          sales: bucket.sales,
          orders: bucket.orders,
          units: bucket.orders,
        }),
        observedDays: bucket.observedDays,
        calendarDays: bucket.calendarDays,
      };
    });
}

function formatDate(date: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(parseDate(date));
}

export function formatPeriod(point: Pick<SeriesPoint, 'periodStart' | 'periodEnd'>): string {
  if (point.periodStart === point.periodEnd) {
    return formatDate(point.periodStart, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  const start = formatDate(point.periodStart, { month: 'short', day: 'numeric' });
  const end = formatDate(point.periodEnd, { month: 'short', day: 'numeric', year: 'numeric' });
  return `${start}–${end}`;
}

export function periodAriaLabel(
  point: SeriesPoint,
  series: readonly Pick<ChartSeries, 'label' | 'scale' | 'points'>[],
  pointIndex: number,
  currencyCode: string,
): string {
  const values = series.map((item) => {
    const value = item.points[pointIndex]?.value ?? null;
    return `${item.label}: ${formatExactValue(value, item.scale, currencyCode)}`;
  });
  const gapNote = point.observedDays === 0
    ? 'No source row; chart shows zero for continuity.'
    : null;
  return [formatPeriod(point), ...values, gapNote].filter((part): part is string => part !== null).join('. ');
}

export function Cockpit({
  days,
  tiles,
  currencyCode,
  settlingStart,
  coverageStart,
  preferenceKey,
}: CockpitProps): ReactNode {
  const initialSelection = useMemo(() => {
    const preferred = ['spend', 'sales'].filter((metric) => tiles.some((tile) => tile.metric === metric));
    return preferred.length > 0 ? preferred : tiles.slice(0, 1).map((tile) => tile.metric);
  }, [tiles]);
  const [selected, setSelected] = useState<string[]>(initialSelection);
  const [granularity, setGranularity] = useState<Granularity>('D');
  const [presentations, setPresentations] = useState<Record<string, SeriesPresentation>>(() =>
    Object.fromEntries(initialSelection.map((metric) => [metric, defaultPresentation(metric)])),
  );
  const [preferencesReady, setPreferencesReady] = useState(false);
  const tileGroups = useMemo(() => partitionKpiTiles(tiles), [tiles]);
  const availableMetrics = useMemo(() => tiles.map((tile) => tile.metric), [tiles]);

  useEffect(() => {
    const restored = parseCockpitPreferences(
      readPreferences(preferenceKey),
      availableMetrics,
    );
    if (restored === null) {
      setSelected(initialSelection);
      setGranularity('D');
      setPresentations(
        Object.fromEntries(initialSelection.map((metric) => [metric, defaultPresentation(metric)])),
      );
    } else {
      setSelected(restored.selected);
      setGranularity(restored.granularity);
      setPresentations(restored.presentations);
    }
    setPreferencesReady(true);
  }, [preferenceKey, availableMetrics, initialSelection]);

  useEffect(() => {
    if (!preferencesReady) return;
    const preferences: CockpitPreferences = {
      version: PREFERENCE_VERSION,
      selected,
      granularity,
      presentations: Object.fromEntries(
        selected.map((metric) => [metric, presentations[metric] ?? defaultPresentation(metric)]),
      ),
    };
    writePreferences(preferenceKey, preferences);
  }, [preferencesReady, preferenceKey, selected, granularity, presentations]);

  const toggle = (metric: string): void => {
    const next = selectionAfterToggle(selected, metric);
    if (!selected.includes(metric) && next.includes(metric)) {
      setPresentations((current) => ({
        ...current,
        [metric]: current[metric] ?? defaultPresentation(metric),
      }));
    }
    setSelected(next);
  };

  const configure = (metric: string, patch: Partial<SeriesPresentation>): void => {
    setPresentations((current) => presentationAfterChange(current, metric, patch));
  };

  const charted = useMemo<ChartSeries[]>(
    () =>
      selected.map((metric, index) => {
        const tile = tiles.find((candidate) => candidate.metric === metric);
        return {
          metric,
          label: tile?.label ?? metric,
          scale: tile?.scale ?? 'money',
          color: SERIES_COLORS[index] as string,
          presentation: presentations[metric] ?? defaultPresentation(metric),
          points: seriesFor(days, metric, granularity),
        };
      }),
    [selected, tiles, days, granularity, presentations],
  );

  return (
    <section aria-label="Performance cockpit" className="wa-cockpit">
      <div className="wa-cockpit__metric-head">
        <strong>Chart metrics</strong>
        <span>Choose up to four · saved for this account</span>
      </div>
      <div
        className="wa-cockpit__strip wa-cockpit__strip--primary"
        role="listbox"
        aria-multiselectable="true"
        aria-label="Primary metrics — select one to four to chart"
      >
        {tileGroups.primary.map((tile) => (
          <MetricTile
            key={tile.metric}
            tile={tile}
            currencyCode={currencyCode}
            selectedIndex={selected.indexOf(tile.metric)}
            selectionFull={selected.length >= MAX_CHART_SERIES}
            onSelect={() => toggle(tile.metric)}
          />
        ))}
      </div>

      {tileGroups.supporting.length === 0 ? null : (
        <details className="wa-cockpit__supporting">
          <summary>Supporting metrics · {tileGroups.supporting.length} · choose any to chart</summary>
          <div
            className="wa-cockpit__strip wa-cockpit__strip--supporting"
            role="listbox"
            aria-multiselectable="true"
            aria-label="Supporting metrics — select one to four to chart"
          >
            {tileGroups.supporting.map((tile) => (
              <MetricTile
                key={tile.metric}
                tile={tile}
                currencyCode={currencyCode}
                selectedIndex={selected.indexOf(tile.metric)}
                selectionFull={selected.length >= MAX_CHART_SERIES}
                onSelect={() => toggle(tile.metric)}
              />
            ))}
          </div>
        </details>
      )}

      <TrendChart
        charted={charted}
        selectedCount={selected.length}
        currencyCode={currencyCode}
        granularity={granularity}
        onGranularity={setGranularity}
        onConfigure={configure}
        onRemove={toggle}
        settlingStart={settlingStart}
        coverageStart={coverageStart}
      />
    </section>
  );
}

function MetricTile({
  tile,
  currencyCode,
  selectedIndex,
  selectionFull,
  onSelect,
}: {
  tile: KpiTileModel;
  currencyCode: string;
  selectedIndex: number;
  selectionFull: boolean;
  onSelect: () => void;
}): ReactNode {
  const color = selectedIndex >= 0 ? SERIES_COLORS[selectedIndex] : undefined;
  const unavailable = selectionFull && selectedIndex < 0;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selectedIndex >= 0}
      aria-disabled={unavailable}
      aria-label={`${tile.label}: ${selectedIndex >= 0 ? 'remove from' : 'add to'} performance chart`}
      className="wa-cockpit__tile"
      style={color === undefined ? undefined : { borderBottomColor: color }}
      title={unavailable ? 'Remove a selected metric before adding another.' : undefined}
      onClick={unavailable ? undefined : onSelect}
    >
      <span className="wa-cockpit__tile-head">
        <span className="wa-kpi__label">{tile.label}</span>
        {selectedIndex >= 0 ? <span className="wa-cockpit__charted">Charted</span> : null}
      </span>
      <span className="wa-cockpit__value">{formatValue(tile.value, tile.scale, currencyCode)}</span>
      <span className="wa-cockpit__prev">
        {tile.prev === null
          ? 'no comparison'
          : `${formatValue(tile.prev, tile.scale, currencyCode)} · ${
              tile.deltaPct === null
                ? '—'
                : `${tile.deltaPct >= 0 ? '+' : ''}${(tile.deltaPct * 100).toFixed(1)}%`
            }`}
      </span>
    </button>
  );
}

function TrendChart({
  charted,
  selectedCount,
  currencyCode,
  granularity,
  onGranularity,
  onConfigure,
  onRemove,
  settlingStart,
  coverageStart,
}: {
  charted: ChartSeries[];
  selectedCount: number;
  currencyCode: string;
  granularity: Granularity;
  onGranularity: (value: Granularity) => void;
  onConfigure: (metric: string, patch: Partial<SeriesPresentation>) => void;
  onRemove: (metric: string) => void;
  settlingStart: string | null;
  coverageStart: string | null;
}): ReactNode {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const width = 1160;
  const height = 328;
  const padding = { top: 18, right: 64, bottom: 34, left: 64 };
  const points = charted[0]?.points ?? [];
  const dates = points.map((point) => point.date);
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const step = dates.length === 0 ? innerWidth : innerWidth / dates.length;
  const x = (index: number): number => padding.left + step * (index + 0.5);

  const axisMaximum = (axis: SeriesAxis): number => {
    const values = charted
      .filter((series) => series.presentation.axis === axis)
      .flatMap((series) => series.points.map((point) => point.value))
      .filter((value): value is number => value !== null && Number.isFinite(value));
    if (values.length === 0) return 1;
    return Math.max(...values) * 1.08 || 1;
  };
  const maxima = { left: axisMaximum('left'), right: axisMaximum('right') };
  const y = (value: number, axis: SeriesAxis): number =>
    padding.top + innerHeight - (value / maxima[axis]) * innerHeight;

  const barSeries = charted.filter((series) => series.presentation.mark === 'bar');
  const barWidth = Math.min(22, Math.max(3, (step * 0.66) / Math.max(1, barSeries.length)));
  const barOffset = (metric: string): number => {
    const index = barSeries.findIndex((series) => series.metric === metric);
    return (index - (barSeries.length - 1) / 2) * barWidth;
  };

  const settlingIndex =
    settlingStart === null ? -1 : points.findIndex((point) => point.periodEnd >= settlingStart);
  const anyData = charted.some((series) => series.points.some((point) => point.value !== null));
  const coverage = points.length === 0
    ? null
    : {
        start: points[0]?.periodStart as string,
        end: points.at(-1)?.periodEnd as string,
      };

  const axisScale = (axis: SeriesAxis): KpiTileModel['scale'] | null => {
    const scales = new Set(
      charted.filter((series) => series.presentation.axis === axis).map((series) => series.scale),
    );
    return scales.size === 1 ? ([...scales][0] as KpiTileModel['scale']) : null;
  };
  const tickLabel = (axis: SeriesAxis, value: number): string => {
    const scale = axisScale(axis);
    return scale === null ? formatCompactAxis(value) : formatValue(value, scale, currencyCode);
  };

  const activePoint = activeIndex === null ? null : points[activeIndex] ?? null;
  const tooltipWidth = 236;
  const tooltipHeight = 34 + charted.length * 19;
  const tooltipX = activeIndex === null
    ? 0
    : Math.min(width - padding.right - tooltipWidth, Math.max(padding.left, x(activeIndex) - tooltipWidth / 2));
  const tooltipY = padding.top + 8;

  return (
    <figure className="wa-cockpit__chart">
      <div className="wa-cockpit__chart-head">
        <div>
          <div className="wa-cockpit__chart-titleline">
            <h2 className="wa-cockpit__chart-title">Performance trend</h2>
            <span className="wa-cockpit__selection-count" aria-live="polite">
              {selectedCount} of {MAX_CHART_SERIES} metrics
            </span>
          </div>
          <p className="wa-cockpit__coverage">
            {coverage === null
              ? 'No chart coverage yet'
              : `${formatPeriod({ periodStart: coverage.start, periodEnd: coverage.end })} · ${GRANULARITY_LABELS[granularity].toLowerCase()}`}
          </p>
        </div>
        <div className="wa-granularity" role="radiogroup" aria-label="Chart aggregation">
          {(['D', 'W', 'M'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-label={GRANULARITY_LABELS[value]}
              aria-checked={granularity === value}
              className={`wa-gran${granularity === value ? ' wa-gran--on' : ''}`}
              title={GRANULARITY_LABELS[value]}
              onClick={() => onGranularity(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      <div className="wa-cockpit__series-controls" aria-label="Selected chart series">
        {charted.map((series) => (
          <div key={series.metric} className="wa-cockpit__series-control">
            <span className="wa-legend-swatch" aria-hidden="true" style={{ background: series.color }} />
            <strong>{series.label}</strong>
            <label>
              <span className="wa-sr-only">{series.label} display</span>
              <select
                className="wa-select wa-select--sm wa-cockpit__series-select"
                aria-label={`${series.label} display`}
                value={series.presentation.mark}
                onChange={(event) => onConfigure(series.metric, { mark: event.target.value as SeriesMark })}
              >
                <option value="line">Line</option>
                <option value="bar">Bar</option>
              </select>
            </label>
            <label>
              <span className="wa-sr-only">{series.label} axis</span>
              <select
                className="wa-select wa-select--sm wa-cockpit__series-select"
                aria-label={`${series.label} axis`}
                value={series.presentation.axis}
                onChange={(event) => onConfigure(series.metric, { axis: event.target.value as SeriesAxis })}
              >
                <option value="left">Left</option>
                <option value="right">Right</option>
              </select>
            </label>
            <button
              type="button"
              className="wa-cockpit__series-remove"
              aria-label={`Remove ${series.label} from chart`}
              disabled={selectedCount === 1}
              onClick={() => onRemove(series.metric)}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {!anyData ? (
        <div className="wa-empty wa-cockpit__chart-empty">
          <p className="wa-empty__body">No values for the selected metrics in this window.</p>
        </div>
      ) : (
        <div className="wa-cockpit__plot">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            role="group"
            aria-label={`Performance trend: ${charted.map((series) => series.label).join(', ')}`}
            onMouseLeave={() => setActiveIndex(null)}
          >
            {settlingIndex >= 0 ? (
              <g aria-label={`Attribution settling from ${settlingStart as string}`}>
                <rect
                  x={x(settlingIndex) - step / 2}
                  y={padding.top}
                  width={padding.left + innerWidth - (x(settlingIndex) - step / 2)}
                  height={innerHeight}
                  fill="var(--wa-accent)"
                  opacity="0.06"
                />
                <text
                  x={x(settlingIndex) - step / 2 + 6}
                  y={padding.top + 14}
                  className="wa-cockpit__svg-label wa-cockpit__svg-label--settling"
                >
                  settling
                </text>
              </g>
            ) : null}

            {[0.25, 0.5, 0.75, 1].map((fraction) => (
              <line
                key={fraction}
                x1={padding.left}
                x2={padding.left + innerWidth}
                y1={padding.top + innerHeight * (1 - fraction)}
                y2={padding.top + innerHeight * (1 - fraction)}
                stroke="var(--wa-viz-grid)"
                strokeWidth="1"
              />
            ))}

            {(['left', 'right'] as const).map((axis) => {
              const hasAxis = charted.some((series) => series.presentation.axis === axis);
              if (!hasAxis) return null;
              return (
                <g key={axis} aria-label={`${axis} axis`}>
                  {[0.5, 1].map((fraction) => (
                    <text
                      key={fraction}
                      x={axis === 'left' ? padding.left - 8 : padding.left + innerWidth + 8}
                      y={y(maxima[axis] * fraction, axis) + 4}
                      className="wa-cockpit__svg-label"
                      textAnchor={axis === 'left' ? 'end' : 'start'}
                    >
                      {tickLabel(axis, maxima[axis] * fraction)}
                    </text>
                  ))}
                </g>
              );
            })}

            {charted.map((series) => {
              if (series.presentation.mark === 'bar') {
                return (
                  <g key={series.metric} data-series-mark="bar" aria-label={`${series.label} bars`}>
                    {series.points.map((point, index) => {
                      if (point.value === null) return null;
                      const top = y(point.value, series.presentation.axis);
                      return (
                        <rect
                          key={point.date}
                          x={x(index) + barOffset(series.metric) - barWidth / 2}
                          y={top}
                          width={barWidth}
                          height={Math.max(1, padding.top + innerHeight - top)}
                          rx="1.5"
                          fill={series.color}
                          opacity="0.82"
                        />
                      );
                    })}
                  </g>
                );
              }
              return (
                <g key={series.metric} data-series-mark="line" aria-label={`${series.label} line`}>
                  <path
                    fill="none"
                    stroke={series.color}
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d={series.points
                      .map((point, index) =>
                        point.value === null
                          ? null
                          : `${index === 0 || series.points[index - 1]?.value === null ? 'M' : 'L'}${x(index).toFixed(1)},${y(point.value, series.presentation.axis).toFixed(1)}`,
                      )
                      .filter((command): command is string => command !== null)
                      .join(' ')}
                  />
                </g>
              );
            })}

            <g aria-label="Chart periods">
              {points.map((point, index) => (
                <rect
                  key={point.date}
                  className="wa-cockpit__period-hit"
                  role="img"
                  tabIndex={0}
                  aria-label={periodAriaLabel(point, charted, index, currencyCode)}
                  x={x(index) - step / 2}
                  y={padding.top}
                  width={step}
                  height={innerHeight}
                  fill="transparent"
                  onMouseEnter={() => setActiveIndex(index)}
                  onFocus={() => setActiveIndex(index)}
                  onBlur={() => setActiveIndex(null)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setActiveIndex(null);
                  }}
                />
              ))}
            </g>

            {activePoint === null ? null : (
              <g className="wa-cockpit__tooltip" pointerEvents="none" aria-hidden="true">
                <line
                  x1={x(activeIndex as number)}
                  x2={x(activeIndex as number)}
                  y1={padding.top}
                  y2={padding.top + innerHeight}
                  stroke="var(--wa-viz-axis)"
                  strokeDasharray="3 3"
                />
                <rect
                  x={tooltipX}
                  y={tooltipY}
                  width={tooltipWidth}
                  height={tooltipHeight}
                  rx="6"
                  fill="var(--wa-surface-2)"
                  stroke="var(--wa-border-strong)"
                />
                <text x={tooltipX + 12} y={tooltipY + 19} className="wa-cockpit__tooltip-period">
                  {formatPeriod(activePoint)}
                </text>
                {charted.map((series, index) => (
                  <g key={series.metric}>
                    <circle cx={tooltipX + 15} cy={tooltipY + 37 + index * 19} r="3" fill={series.color} />
                    <text x={tooltipX + 25} y={tooltipY + 41 + index * 19} className="wa-cockpit__tooltip-label">
                      {series.label}
                    </text>
                    <text
                      x={tooltipX + tooltipWidth - 12}
                      y={tooltipY + 41 + index * 19}
                      textAnchor="end"
                      className="wa-cockpit__tooltip-value"
                    >
                      {formatExactValue(series.points[activeIndex as number]?.value ?? null, series.scale, currencyCode)}
                    </text>
                  </g>
                ))}
              </g>
            )}

            {points.length > 0 ? (
              <>
                <text x={x(0)} y={height - 9} className="wa-cockpit__svg-label" textAnchor="start">
                  {formatDate(points[0]?.periodStart as string, { month: 'short', day: 'numeric' })}
                </text>
                <text x={x(points.length - 1)} y={height - 9} className="wa-cockpit__svg-label" textAnchor="end">
                  {formatDate(points.at(-1)?.periodEnd as string, { month: 'short', day: 'numeric' })}
                </text>
              </>
            ) : null}
          </svg>
        </div>
      )}

      {coverage !== null ? (
        <figcaption className="wa-cockpit__note">
          Coverage {coverage.start} to {coverage.end}
          {coverageStart !== null && coverageStart > coverage.start
            ? `; synced facts begin ${coverageStart}`
            : ''}
          {' '}· Gaps within coverage show zero activity · Ratios without a denominator show —.
        </figcaption>
      ) : null}
    </figure>
  );
}
