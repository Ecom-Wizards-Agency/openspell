/**
 * One metric with one comparison line. Additional comparison detail belongs on
 * hover; the card keeps the scan path to label → value → delta.
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
  const trailingPct = props.trailing7PctChange ?? null;
  const trailingReference = props.trailing7Avg ?? null;
  const detail =
    props.trailing7PctChange === undefined && props.trailing7Avg === undefined
      ? undefined
      : `${formatDelta(trailingPct, 'percent', props.context)} vs trailing-7 avg${
          trailingReference === null ? '' : ` (${formatValue(trailingReference, scale, props.context)})`
        }`;

  return (
    <div style={tile} title={detail}>
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
  fontSize: tokens.font.size.eyebrow,
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
};

const tileValue: CSSProperties = {
  fontSize: tokens.font.size.kpi,
  fontVariantNumeric: 'tabular-nums',
  fontWeight: 800,
};

const tileDeltas: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.125rem' };

const deltaRow: CSSProperties = {
  display: 'flex',
  fontSize: tokens.font.size.xs,
  gap: tokens.space(1),
};
