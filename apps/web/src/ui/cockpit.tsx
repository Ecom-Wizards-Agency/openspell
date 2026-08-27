'use client';

/**
 * The dashboard cockpit: an AdLabs-grade KPI strip whose tiles ARE the chart
 * controls. Up to two tiles are selected at once; each drives one axis of the
 * dual-axis trend below — indigo for the first, orange for the second — so an
 * operator reads a number and charts it in the same gesture.
 *
 * Granularity is honest for ratios: weekly and monthly buckets are built by
 * summing the BASE fields inside the bucket and deriving the metric from the
 * bucket sums, never by averaging daily ratios.
 */

import { useMemo, useState } from 'react';
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
}

const SERIES_COLORS = ['var(--wa-indigo)', 'var(--wa-accent)'] as const;
type Granularity = 'D' | 'W' | 'M';

function formatValue(value: number | null, scale: KpiTileModel['scale'], currency: string): string {
  if (value === null) return '—';
  if (scale === 'percent') return `${(value * 100).toFixed(1)}%`;
  if (scale === 'ratio') return value.toFixed(2);
  if (scale === 'integer') return Math.round(value).toLocaleString('en-US');
  return value.toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: value >= 100 ? 0 : 2 });
}

function bucketKey(date: string, gran: Granularity): string {
  if (gran === 'D') return date;
  if (gran === 'M') return date.slice(0, 7);
  const d = new Date(`${date}T00:00:00Z`);
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

function seriesFor(
  days: readonly CockpitDay[],
  metric: string,
  gran: Granularity,
): { date: string; value: number | null }[] {
  const buckets = new Map<string, CockpitDay>();
  for (const day of days) {
    const key = bucketKey(day.date, gran);
    const acc = buckets.get(key) ?? { date: key, impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0 };
    acc.impressions += day.impressions;
    acc.clicks += day.clicks;
    acc.spend += day.spend;
    acc.sales += day.sales;
    acc.orders += day.orders;
    buckets.set(key, acc);
  }
  return [...buckets.values()]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((bucket) => ({
      date: bucket.date,
      value: deriveMetric(metric, {
        impressions: bucket.impressions,
        clicks: bucket.clicks,
        spend: bucket.spend,
        sales: bucket.sales,
        orders: bucket.orders,
      }),
    }));
}

export function Cockpit({ days, tiles, currencyCode, settlingStart, coverageStart }: CockpitProps): ReactNode {
  const [selected, setSelected] = useState<string[]>(['spend', 'sales']);
  const [gran, setGran] = useState<Granularity>('D');

  const toggle = (metric: string): void => {
    setSelected((current) => {
      if (current.includes(metric)) {
        return current.length === 1 ? current : current.filter((m) => m !== metric);
      }
      return current.length < 2 ? [...current, metric] : [current[1] as string, metric];
    });
  };

  const charted = useMemo(
    () =>
      selected.map((metric, index) => {
        const tile = tiles.find((t) => t.metric === metric);
        return {
          metric,
          label: tile?.label ?? metric,
          scale: tile?.scale ?? 'money',
          color: SERIES_COLORS[index] as string,
          points: seriesFor(days, metric, gran),
        };
      }),
    [selected, tiles, days, gran],
  );

  return (
    <section aria-label="Performance cockpit" className="wa-cockpit">
      <div className="wa-cockpit__strip" role="listbox" aria-label="Metrics — select up to two to chart">
        {tiles.map((tile) => {
          const index = selected.indexOf(tile.metric);
          const color = index >= 0 ? SERIES_COLORS[index] : undefined;
          return (
            <button
              key={tile.metric}
              type="button"
              role="option"
              aria-selected={index >= 0}
              className="wa-cockpit__tile"
              style={color === undefined ? undefined : { boxShadow: `inset 0 -3px 0 0 ${color}` }}
              onClick={() => toggle(tile.metric)}
            >
              <span className="wa-kpi__label">{tile.label}</span>
              <span className="wa-cockpit__value">{formatValue(tile.value, tile.scale, currencyCode)}</span>
              <span className="wa-cockpit__prev">
                {tile.prev === null
                  ? 'no comparison'
                  : `${formatValue(tile.prev, tile.scale, currencyCode)} · ${
                      tile.deltaPct === null ? '—' : `${tile.deltaPct >= 0 ? '+' : ''}${(tile.deltaPct * 100).toFixed(1)}%`
                    }`}
              </span>
            </button>
          );
        })}
      </div>

      <DualAxisTrend
        charted={charted}
        currencyCode={currencyCode}
        gran={gran}
        onGran={setGran}
        settlingStart={settlingStart}
        coverageStart={coverageStart}
      />
    </section>
  );
}

function DualAxisTrend({
  charted,
  currencyCode,
  gran,
  onGran,
  settlingStart,
  coverageStart,
}: {
  charted: { metric: string; label: string; scale: KpiTileModel['scale']; color: string; points: { date: string; value: number | null }[] }[];
  currencyCode: string;
  gran: Granularity;
  onGran: (g: Granularity) => void;
  settlingStart: string | null;
  coverageStart: string | null;
}): ReactNode {
  const width = 1160;
  const height = 320;
  const pad = { top: 16, right: 64, bottom: 28, left: 64 };
  const dates = charted[0]?.points.map((p) => p.date) ?? [];
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const x = (i: number): number => pad.left + (dates.length <= 1 ? innerW / 2 : (i / (dates.length - 1)) * innerW);

  const axes = charted.map((series) => {
    const values = series.points.map((p) => p.value).filter((v): v is number => v !== null);
    const max = values.length === 0 ? 1 : Math.max(...values) * 1.08 || 1;
    return { ...series, max };
  });
  const y = (value: number, max: number): number => pad.top + innerH - (value / max) * innerH;

  const settlingIndex = settlingStart === null ? -1 : dates.findIndex((d) => d >= settlingStart);
  const anyData = axes.some((a) => a.points.some((p) => p.value !== null));

  return (
    <figure className="wa-cockpit__chart" style={{ margin: 0 }}>
      <div className="wa-cockpit__chart-head">
        <div className="wa-chart-legend" aria-hidden="true">
          {axes.map((a) => (
            <span key={a.metric} className="wa-legend-item">
              <span className="wa-legend-swatch" style={{ background: a.color }} />
              {a.label}
            </span>
          ))}
        </div>
        <div className="wa-granularity" role="radiogroup" aria-label="Granularity">
          {(['D', 'W', 'M'] as const).map((g) => (
            <button key={g} type="button" role="radio" aria-checked={gran === g}
              className={`wa-gran${gran === g ? ' wa-gran--on' : ''}`} onClick={() => onGran(g)}>
              {g}
            </button>
          ))}
        </div>
      </div>
      {!anyData ? (
        <div className="wa-empty" style={{ padding: '2rem 1rem' }}>
          <p className="wa-empty__body">No data in this window yet.</p>
        </div>
      ) : (
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Trend of ${axes.map((a) => a.label).join(' and ')}`}>
          {settlingIndex >= 0 ? (
            <>
              <rect x={x(settlingIndex)} y={pad.top} width={pad.left + innerW - x(settlingIndex)} height={innerH}
                fill="var(--wa-accent)" opacity="0.06" />
              <text x={x(settlingIndex) + 6} y={pad.top + 14} fontSize="11" fill="var(--wa-accent)">settling</text>
            </>
          ) : null}
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <line key={f} x1={pad.left} x2={pad.left + innerW} y1={pad.top + innerH * (1 - f)} y2={pad.top + innerH * (1 - f)}
              stroke="var(--wa-border)" strokeWidth="1" opacity="0.6" />
          ))}
          {axes.map((axis, ai) => (
            <g key={axis.metric}>
              {[0.5, 1].map((f) => (
                <text key={f} x={ai === 0 ? pad.left - 8 : pad.left + innerW + 8} y={y(axis.max * f, axis.max) + 4}
                  fontSize="11" fill={axis.color} textAnchor={ai === 0 ? 'end' : 'start'} style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {formatValue(axis.max * f, axis.scale, currencyCode)}
                </text>
              ))}
              <path
                fill="none" stroke={axis.color} strokeWidth="2"
                d={axis.points
                  .map((p, i) => (p.value === null ? null : `${i === 0 || axis.points[i - 1]?.value === null ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value, axis.max).toFixed(1)}`))
                  .filter(Boolean)
                  .join(' ')}
              />
            </g>
          ))}
          <text x={pad.left} y={height - 8} fontSize="11" fill="var(--wa-text-dim)">{dates[0]}</text>
          <text x={pad.left + innerW} y={height - 8} fontSize="11" fill="var(--wa-text-dim)" textAnchor="end">{dates.at(-1)}</text>
        </svg>
      )}
      {coverageStart !== null && dates[0] !== undefined && coverageStart > dates[0] ? (
        <figcaption className="wa-cockpit__note">Data coverage begins {coverageStart}; earlier days have no synced facts.</figcaption>
      ) : null}
    </figure>
  );
}
