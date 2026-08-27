/**
 * A trend line, in SVG, with no charting library.
 *
 * Three series at most and one of them is always the trailing-7 average, which
 * is the shape every widget on this dashboard needs and roughly the only shape
 * it needs. A charting dependency for that is a hundred kilobytes and a theme
 * fight; sixty lines of path arithmetic is neither.
 *
 * Gaps are gaps. Amazon omits zero-impression rows, so a missing day is genuinely
 * missing and the line breaks rather than sloping through it -- interpolating
 * across a hole invents a trend that nothing measured.
 */
import type { ReactNode } from 'react';
import { tokens } from '../theme.js';

export interface TrendPoint {
  date: string;
  value: number | null;
}

export interface TrendSeries {
  label: string;
  points: readonly TrendPoint[];
  color: string;
  /** Dashed lines read as "reference", solid as "actual". */
  dashed?: boolean;
}

export interface TrendChartProps {
  series: readonly TrendSeries[];
  width?: number;
  height?: number;
  /** Rendered under the chart. Currency or unit, so the axis needs no label. */
  caption?: string;
  ariaLabel: string;
}

const PADDING = { top: 8, right: 8, bottom: 18, left: 8 };

export function TrendChart({
  series,
  width = 480,
  height = 140,
  caption,
  ariaLabel,
}: TrendChartProps): ReactNode {
  const values = series.flatMap((entry) =>
    entry.points.map((point) => point.value).filter((value): value is number => value !== null),
  );

  if (values.length === 0) {
    return (
      <div style={{ color: tokens.color.textMuted, fontSize: tokens.font.size.sm, padding: tokens.space(4) }}>
        No data in this window.
      </div>
    );
  }

  const max = Math.max(...values);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const length = Math.max(...series.map((entry) => entry.points.length));
  const innerWidth = width - PADDING.left - PADDING.right;
  const innerHeight = height - PADDING.top - PADDING.bottom;

  const x = (index: number): number =>
    PADDING.left + (length <= 1 ? innerWidth / 2 : (index / (length - 1)) * innerWidth);
  const y = (value: number): number =>
    PADDING.top + innerHeight - ((value - min) / span) * innerHeight;

  const first = series[0]?.points ?? [];
  const firstDate = first[0]?.date;
  const lastDate = first[first.length - 1]?.date;

  return (
    <figure style={{ margin: 0 }}>
      <svg
        width="100%"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel}
        style={{ display: 'block', overflow: 'visible' }}
      >
        <line
          x1={PADDING.left}
          x2={width - PADDING.right}
          y1={y(min)}
          y2={y(min)}
          stroke={tokens.color.border}
          strokeWidth={1}
        />
        {series.map((entry) => (
          <path
            key={entry.label}
            d={buildPath(entry.points, x, y)}
            fill="none"
            stroke={entry.color}
            strokeWidth={entry.dashed ? 1.5 : 2}
            strokeDasharray={entry.dashed ? '4 3' : undefined}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {firstDate === undefined ? null : (
          <text
            x={PADDING.left}
            y={height - 4}
            fontSize={12}
            fill={tokens.color.textMuted}
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {firstDate}
          </text>
        )}
        {lastDate === undefined ? null : (
          <text
            x={width - PADDING.right}
            y={height - 4}
            fontSize={12}
            textAnchor="end"
            fill={tokens.color.textMuted}
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {lastDate}
          </text>
        )}
      </svg>
      <figcaption
        style={{
          color: tokens.color.textMuted,
          display: 'flex',
          flexWrap: 'wrap',
          fontSize: tokens.font.size.xs,
          gap: tokens.space(3),
          marginTop: tokens.space(1),
        }}
      >
        {series.map((entry) => (
          <span key={entry.label} style={{ alignItems: 'center', display: 'inline-flex', gap: tokens.space(1) }}>
            <span
              aria-hidden
              style={{
                background: entry.dashed ? 'none' : entry.color,
                borderTop: entry.dashed ? `2px dashed ${entry.color}` : 'none',
                display: 'inline-block',
                height: entry.dashed ? 0 : '2px',
                width: '12px',
              }}
            />
            {entry.label}
          </span>
        ))}
        {caption === undefined ? null : <span>{caption}</span>}
      </figcaption>
    </figure>
  );
}

/** `M`/`L` runs, restarted after every gap, so a missing day is a visible break. */
function buildPath(
  points: readonly TrendPoint[],
  x: (index: number) => number,
  y: (value: number) => number,
): string {
  const parts: string[] = [];
  let penDown = false;
  points.forEach((point, index) => {
    if (point.value === null) {
      penDown = false;
      return;
    }
    parts.push(`${penDown ? 'L' : 'M'}${x(index).toFixed(2)} ${y(point.value).toFixed(2)}`);
    penDown = true;
  });
  return parts.join(' ');
}
