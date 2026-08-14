'use client';

/**
 * The trend chart.
 *
 * Built here rather than taken from `packages/ui` for two reasons, one of them
 * decisive. The decisive one is theming: WP-06's chart writes its palette into
 * inline `style` attributes, so it cannot follow a dark mode, and WP-21 does not
 * own that package. The other is the form itself — the version this replaces put
 * ACOS and CPC on one y-axis, two measures whose scales have nothing to do with
 * each other, which is the single most misleading thing a line chart can do.
 * Here one chart carries one axis; two measures of different scale get two
 * charts.
 *
 * The rest is the house data-viz spec, applied literally:
 *
 *  - Series colours are the validated categorical slots (blue, then orange),
 *    assigned in fixed order and never cycled — and re-stepped for the dark
 *    surface rather than flipped.
 *  - 2px lines, round joins, an ≥8px end marker carrying a 2px ring in the
 *    surface colour so it stays legible where two series cross.
 *  - Hairline gridlines one step off the surface, never dashed; axis text in
 *    muted ink, never in a series colour.
 *  - A legend whenever there are two series, direct labels at the line ends, and
 *    a crosshair + tooltip on hover, because an SVG chart in a browser that does
 *    not answer "what is this point" is a picture of data rather than data.
 *  - A table view under every chart, so nothing is gated behind colour or hover.
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { formatValue } from '@wizard-ads/ui';

export interface TrendPoint {
  date: string;
  value: number | null;
}

export interface TrendSeries {
  label: string;
  points: readonly TrendPoint[];
}

/**
 * A shaded window drawn behind the lines — WP-19's experiment overlay.
 *
 * A decoration layer, nothing more: it reads the same x-scale the series use and
 * paints a band from `start` to `end` (or to the right edge while `end` is
 * null). It never changes the data, the axis or the series, so a chart with no
 * windows renders exactly as it did before the prop existed.
 */
export interface ChartWindow {
  id?: string;
  label: string;
  start: string;
  end: string | null;
}

export type ValueScale = 'money' | 'percent' | 'ratio' | 'integer';

export type Granularity = 'D' | 'W' | 'M';

export interface TrendChartProps {
  title: string;
  ariaLabel: string;
  series: readonly TrendSeries[];
  scale: ValueScale;
  currencyCode: string;
  caption?: string;
  /**
   * Show the AdLabs-style daily / weekly / monthly granularity toggle.
   *
   * Only pass `true` for **additive** series (spend, sales, orders, clicks,
   * impressions), because weekly and monthly buckets are computed by *summing*
   * the days inside them. A ratio (ACOS, CPC, CVR) cannot be re-bucketed by
   * summing or averaging its daily values — it would have to be recomputed from
   * base sums, which this component does not carry — so the toggle stays off for
   * those and the chart is daily-only. This is the same discipline the grid's
   * group-by follows (`tools/recon/02-data-grid.md` §4).
   */
  aggregatable?: boolean;
  /**
   * Experiment windows to shade behind the series (WP-19). Additive: omitted or
   * empty means an unchanged chart.
   */
  windows?: readonly ChartWindow[];
}

const GRANULARITIES: readonly Granularity[] = ['D', 'W', 'M'];
const GRANULARITY_LABEL: Record<Granularity, string> = { D: 'Daily', W: 'Weekly', M: 'Monthly' };

/** Monday of the ISO date's week, as a YYYY-MM-DD label. */
function weekKey(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  const day = parsed.getUTCDay();
  const delta = (day + 6) % 7; // days since Monday
  parsed.setUTCDate(parsed.getUTCDate() - delta);
  return parsed.toISOString().slice(0, 10);
}

/**
 * Re-bucket daily points to weekly or monthly by summing.
 *
 * A bucket with no reported day stays `null`, not zero — the same rule the line
 * itself follows, so a quiet week reads as a gap rather than a floor.
 */
function bucketSeries(
  dates: readonly string[],
  series: readonly TrendSeries[],
  granularity: Granularity,
): { dates: string[]; series: TrendSeries[] } {
  if (granularity === 'D') return { dates: [...dates], series: series.map((s) => ({ ...s, points: [...s.points] })) };
  const keyOf = (date: string): string => (granularity === 'W' ? weekKey(date) : date.slice(0, 7));
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const date of dates) {
    const key = keyOf(date);
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  const bucketed = series.map((entry) => {
    const sums = new Map<string, number | null>();
    entry.points.forEach((point) => {
      const key = keyOf(point.date);
      const running = sums.get(key);
      if (point.value === null) {
        if (!sums.has(key)) sums.set(key, null);
      } else {
        sums.set(key, (running ?? 0) + point.value);
      }
    });
    return { label: entry.label, points: keys.map((key) => ({ date: key, value: sums.get(key) ?? null })) };
  });
  return { dates: keys, series: bucketed };
}

const W = 760;
const H = 230;
const PAD = { top: 14, right: 78, bottom: 26, left: 62 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

/** Categorical slots, in fixed order. Never generated, never cycled. */
const SERIES_VARS = ['var(--wa-viz-1)', 'var(--wa-viz-2)', 'var(--wa-viz-3)'] as const;

export function TrendChart({
  title,
  ariaLabel,
  series,
  scale,
  currencyCode,
  caption,
  aggregatable = false,
  windows = [],
}: TrendChartProps): ReactNode {
  const [hover, setHover] = useState<number | null>(null);
  const [gran, setGran] = useState<Granularity>('D');
  const context = useMemo(() => ({ currencyCode, locale: 'en-US' }), [currencyCode]);

  const rawDates = useMemo(() => series[0]?.points.map((point) => point.date) ?? [], [series]);
  const view = useMemo(
    () => bucketSeries(rawDates, series, aggregatable ? gran : 'D'),
    [rawDates, series, aggregatable, gran],
  );
  const dates = view.dates;
  const gseries = view.series;
  const values = gseries.flatMap((entry) =>
    entry.points.map((point) => point.value).filter((value): value is number => value !== null),
  );

  const head = (
    <ChartHead title={title} series={gseries}>
      {aggregatable ? <GranularityToggle value={gran} onChange={setGran} /> : null}
    </ChartHead>
  );

  if (dates.length === 0 || values.length === 0) {
    return (
      <figure style={{ margin: 0 }}>
        {head}
        <div className="wa-empty" style={{ padding: '2rem 1rem' }}>
          <p className="wa-empty__body">
            No day in this window carried a figure for {title.toLowerCase()}. Amazon omits
            zero-impression rows, so this is either a quiet period or a report that has not landed —
            the freshness banner above says which.
          </p>
        </div>
      </figure>
    );
  }

  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const ticks = niceTicks(min, max);
  const top = ticks[ticks.length - 1] ?? 1;
  const bottom = ticks[0] ?? 0;
  const span = top - bottom || 1;

  const x = (index: number): number =>
    dates.length === 1 ? PAD.left + PLOT_W / 2 : PAD.left + (index / (dates.length - 1)) * PLOT_W;
  const y = (value: number): number => PAD.top + PLOT_H - ((value - bottom) / span) * PLOT_H;

  const hovered = hover === null ? null : Math.min(Math.max(hover, 0), dates.length - 1);

  return (
    <figure style={{ margin: 0 }}>
      {head}

      <div style={{ position: 'relative' }}>
        <svg
          className="wa-chart"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={ariaLabel}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            const local = ((event.clientX - box.left) / box.width) * W;
            const ratio = (local - PAD.left) / PLOT_W;
            setHover(Math.round(ratio * (dates.length - 1)));
          }}
        >
          {/* Experiment windows, painted first so they sit behind everything. */}
          {windows.map((window, index) => {
            const band = windowBand(window, dates, x, PLOT_W);
            if (band === null) return null;
            return (
              <rect
                key={window.id ?? `${window.label}-${index}`}
                data-testid="experiment-window"
                data-window-label={window.label}
                x={band.x}
                y={PAD.top}
                width={band.width}
                height={PLOT_H}
                fill="var(--wa-accent-soft)"
                stroke="var(--wa-accent-border)"
                strokeWidth={1}
              >
                <title>{window.label}</title>
              </rect>
            );
          })}

          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={PAD.left}
                x2={PAD.left + PLOT_W}
                y1={y(tick)}
                y2={y(tick)}
                stroke="var(--wa-viz-grid)"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 8}
                y={y(tick) + 3.5}
                textAnchor="end"
                fill="var(--wa-viz-ink)"
                fontSize={10}
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {formatValue(tick, scale, context)}
              </text>
            </g>
          ))}

          <line
            x1={PAD.left}
            x2={PAD.left + PLOT_W}
            y1={PAD.top + PLOT_H}
            y2={PAD.top + PLOT_H}
            stroke="var(--wa-viz-axis)"
            strokeWidth={1}
          />

          <text x={PAD.left} y={H - 8} fill="var(--wa-viz-ink)" fontSize={10}>
            {dates[0]}
          </text>
          <text
            x={PAD.left + PLOT_W}
            y={H - 8}
            textAnchor="end"
            fill="var(--wa-viz-ink)"
            fontSize={10}
          >
            {dates[dates.length - 1]}
          </text>

          {hovered === null ? null : (
            <line
              x1={x(hovered)}
              x2={x(hovered)}
              y1={PAD.top}
              y2={PAD.top + PLOT_H}
              stroke="var(--wa-viz-axis)"
              strokeWidth={1}
            />
          )}

          {gseries.map((entry, index) => {
            const color = SERIES_VARS[index] ?? SERIES_VARS[0];
            const path = linePath(entry.points, x, y);
            const last = lastDefined(entry.points);
            return (
              <g key={entry.label}>
                {path === '' ? null : (
                  <path
                    d={path}
                    fill="none"
                    stroke={color}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )}
                {last === null ? null : (
                  <>
                    {/* The 2px ring is the surface, not a stroke of the mark. */}
                    <circle
                      cx={x(last.index)}
                      cy={y(last.value)}
                      r={6}
                      fill="var(--wa-viz-surface)"
                    />
                    <circle cx={x(last.index)} cy={y(last.value)} r={4} fill={color} />
                    <text
                      x={x(last.index) + 10}
                      y={y(last.value) + 3.5}
                      fill="var(--wa-viz-ink)"
                      fontSize={10}
                      style={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {formatValue(last.value, scale, context)}
                    </text>
                  </>
                )}
                {hovered === null || entry.points[hovered]?.value == null ? null : (
                  <>
                    <circle
                      cx={x(hovered)}
                      cy={y(entry.points[hovered]?.value ?? 0)}
                      r={5.5}
                      fill="var(--wa-viz-surface)"
                    />
                    <circle
                      cx={x(hovered)}
                      cy={y(entry.points[hovered]?.value ?? 0)}
                      r={3.5}
                      fill={color}
                    />
                  </>
                )}
              </g>
            );
          })}
        </svg>

        {hovered === null ? null : (
          <div
            role="presentation"
            style={{
              background: 'var(--wa-surface)',
              border: '1px solid var(--wa-border-strong)',
              borderRadius: 'var(--wa-radius)',
              boxShadow: 'var(--wa-shadow-2)',
              fontSize: 'var(--wa-fs-xs)',
              left: `${(x(hovered) / W) * 100}%`,
              padding: '0.375rem 0.5rem',
              pointerEvents: 'none',
              position: 'absolute',
              top: 0,
              transform: hovered > dates.length / 2 ? 'translateX(-105%)' : 'translateX(10px)',
              whiteSpace: 'nowrap',
            }}
          >
            <div style={{ color: 'var(--wa-text-muted)' }}>{dates[hovered]}</div>
            {gseries.map((entry, index) => (
              <div key={entry.label} className="wa-row" style={{ gap: '0.375rem' }}>
                <span
                  aria-hidden="true"
                  className="wa-chart-key"
                  style={{ background: SERIES_VARS[index] ?? SERIES_VARS[0] }}
                />
                {entry.label}
                <strong className="wa-num">
                  {formatValue(entry.points[hovered]?.value ?? null, scale, context)}
                </strong>
              </div>
            ))}
          </div>
        )}
      </div>

      <figcaption className="wa-hint" style={{ marginTop: '0.25rem' }}>
        {caption ?? ''}
      </figcaption>

      <details style={{ marginTop: '0.5rem' }}>
        <summary className="wa-hint" style={{ cursor: 'pointer' }}>
          Show the numbers
        </summary>
        <div className="wa-tablewrap" style={{ marginTop: '0.5rem', maxHeight: '16rem', overflowY: 'auto' }}>
          <table className="wa-table wa-table--numeric">
            <thead>
              <tr>
                <th scope="col">Date</th>
                {gseries.map((entry) => (
                  <th key={entry.label} scope="col">
                    {entry.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dates.map((date, index) => (
                <tr key={date}>
                  <td>{date}</td>
                  {gseries.map((entry) => (
                    <td key={entry.label}>
                      {formatValue(entry.points[index]?.value ?? null, scale, context)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

function ChartHead({
  title,
  series,
  children,
}: {
  title: string;
  series: readonly TrendSeries[];
  children?: ReactNode;
}): ReactNode {
  return (
    <>
      <div
        className="wa-row"
        style={{ alignItems: 'baseline', gap: '0.75rem', justifyContent: 'space-between' }}
      >
        <h3 className="wa-card__title" style={{ fontSize: 'var(--wa-fs-base)' }}>
          {title}
        </h3>
        {children}
      </div>
      {/* One series needs no legend: the title already names what is plotted. */}
      {series.length < 2 ? null : (
        <ul className="wa-chart-legend" style={{ marginTop: '0.375rem' }}>
          {series.map((entry, index) => (
            <li key={entry.label}>
              <span
                aria-hidden="true"
                className="wa-chart-key"
                style={{ background: SERIES_VARS[index] ?? SERIES_VARS[0] }}
              />
              {entry.label}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * The daily / weekly / monthly toggle, AdLabs' own chart control.
 *
 * A segmented control, not a dropdown: three mutually exclusive options are
 * faster to reach as buttons, and the current granularity is legible without
 * opening anything.
 */
function GranularityToggle({
  value,
  onChange,
}: {
  value: Granularity;
  onChange: (granularity: Granularity) => void;
}): ReactNode {
  return (
    <div className="wa-seg" role="group" aria-label="Chart granularity">
      {GRANULARITIES.map((granularity) => (
        <button
          key={granularity}
          type="button"
          className="wa-seg__btn"
          aria-pressed={granularity === value}
          aria-label={GRANULARITY_LABEL[granularity]}
          title={GRANULARITY_LABEL[granularity]}
          onClick={() => onChange(granularity)}
        >
          {granularity}
        </button>
      ))}
    </div>
  );
}

/**
 * Where an experiment window sits on the x-axis, or null when it falls entirely
 * outside the plotted date domain. Clamped to the plot and padded by half a step
 * so a single-day window is still a visible band rather than a hairline.
 */
function windowBand(
  window: ChartWindow,
  dates: readonly string[],
  x: (index: number) => number,
  plotWidth: number,
): { x: number; width: number } | null {
  if (dates.length === 0) return null;
  const first = dates[0] as string;
  const last = dates[dates.length - 1] as string;
  const startKey = window.start;
  const endKey = window.end ?? last;
  if (endKey < first || startKey > last) return null;

  let startIndex = dates.findIndex((date) => date >= startKey);
  if (startIndex < 0) startIndex = 0;
  let endIndex = -1;
  for (let index = dates.length - 1; index >= 0; index -= 1) {
    if ((dates[index] as string) <= endKey) {
      endIndex = index;
      break;
    }
  }
  if (endIndex < 0) endIndex = dates.length - 1;
  if (endIndex < startIndex) return null;

  const step = dates.length > 1 ? plotWidth / (dates.length - 1) : plotWidth;
  const pad = step / 2;
  const left = Math.max(PAD.left, x(startIndex) - pad);
  const right = Math.min(PAD.left + plotWidth, x(endIndex) + pad);
  return { x: left, width: Math.max(2, right - left) };
}

/** A gap in the data is a gap in the line, never a straight segment across it. */
function linePath(
  points: readonly TrendPoint[],
  x: (index: number) => number,
  y: (value: number) => number,
): string {
  const parts: string[] = [];
  let open = false;
  points.forEach((point, index) => {
    if (point.value === null) {
      open = false;
      return;
    }
    parts.push(`${open ? 'L' : 'M'}${x(index).toFixed(2)} ${y(point.value).toFixed(2)}`);
    open = true;
  });
  return parts.join(' ');
}

function lastDefined(points: readonly TrendPoint[]): { index: number; value: number } | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = points[index]?.value;
    if (value !== null && value !== undefined) return { index, value };
  }
  return null;
}

/**
 * Axis ticks on round numbers.
 *
 * The alternative — ticks at the data's own extremes — puts labels like
 * `$1,283.41` on a gridline, which reads as a data point rather than as a scale.
 */
function niceTicks(min: number, max: number): number[] {
  const lo = Math.min(0, min);
  const hi = max === lo ? lo + 1 : max;
  const raw = (hi - lo) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;
  const start = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= hi + step / 2; value += step) {
    ticks.push(Number(value.toFixed(10)));
  }
  return ticks;
}
