/**
 * One metric, with both of the comparisons that matter.
 *
 * Prior period answers "is today unusual"; trailing-7 answers "is this a
 * trend". The reference monitor reports both because either alone misleads --
 * a Monday against a Sunday looks like a collapse, and a trailing average alone
 * hides the day the budget doubled. So the tile carries both, always, and says
 * which is which.
 *
 * Colour is driven by the metric's `better` direction, never the sign: ACOS
 * down is green, spend down is grey.
 */
import type { CSSProperties, ReactNode } from 'react';
import { formatDelta, formatValue } from '../format.js';
import type { FormatContext } from '../format.js';
import { metricSpec } from '../metrics.js';
import type { MetricScale } from '../metrics.js';
import { deltaColor, tokens } from '../theme.js';

export interface StatTileProps {
  metric: string;
  value: number | null;
  priorValue?: number | null;
  priorPctChange?: number | null;
  trailing7Avg?: number | null;
  trailing7PctChange?: number | null;
  context: FormatContext;
  /** Overrides the registry label, for a tile that is not a registry metric. */
  label?: string;
  scale?: MetricScale;
}

export function StatTile(props: StatTileProps): ReactNode {
  const spec = metricSpec(props.metric);
  const scale = props.scale ?? spec?.scale ?? 'decimal';
  const label = props.label ?? spec?.label ?? props.metric;

  return (
    <div style={tile}>
      <div style={tileLabel}>{label}</div>
      <div style={tileValue}>{formatValue(props.value, scale, props.context)}</div>
      <div style={tileDeltas}>
        <DeltaLine
          caption="vs prior period"
          pct={props.priorPctChange ?? null}
          reference={props.priorValue ?? null}
          better={spec?.better ?? null}
          scale={scale}
          context={props.context}
        />
        <DeltaLine
          caption="vs trailing-7 avg"
          pct={props.trailing7PctChange ?? null}
          reference={props.trailing7Avg ?? null}
          better={spec?.better ?? null}
          scale={scale}
          context={props.context}
        />
      </div>
    </div>
  );
}

function DeltaLine({
  caption,
  pct,
  reference,
  better,
  scale,
  context,
}: {
  caption: string;
  pct: number | null;
  reference: number | null;
  better: 'higher' | 'lower' | null;
  scale: MetricScale;
  context: FormatContext;
}): ReactNode {
  return (
    <div style={deltaRow}>
      <span style={{ color: deltaColor(pct, better), fontWeight: 600 }}>
        {formatDelta(pct, 'percent', context)}
      </span>
      <span style={{ color: tokens.color.textMuted }}>
        {caption}
        {reference === null ? '' : ` (${formatValue(reference, scale, context)})`}
      </span>
    </div>
  );
}

const tile: CSSProperties = {
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  display: 'flex',
  flexDirection: 'column',
  fontFamily: tokens.font.sans,
  gap: tokens.space(1),
  minWidth: '11rem',
  padding: tokens.space(3),
};

const tileLabel: CSSProperties = {
  color: tokens.color.textMuted,
  fontSize: tokens.font.size.xs,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
};

const tileValue: CSSProperties = {
  fontSize: '1.375rem',
  fontVariantNumeric: 'tabular-nums',
  fontWeight: 600,
};

const tileDeltas: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.125rem' };

const deltaRow: CSSProperties = {
  display: 'flex',
  fontSize: tokens.font.size.xs,
  gap: tokens.space(1),
};
