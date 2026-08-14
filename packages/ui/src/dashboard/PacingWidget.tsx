/**
 * Month-to-date pace against the monthly ad budget.
 *
 * The view model is structurally the `PacingResult` `@wizard-ads/core` returns,
 * so `apps/web` hands the engine's output straight to this component with no
 * mapping layer -- and `packages/ui` still imports nothing, which is what keeps
 * it a presentation package.
 *
 * Two behaviours are carried over from the engine because they are the point of
 * the widget, not decoration:
 *
 *  - **No budget means no widget**, not a zero. A pacing read against an
 *    invented budget is worse than none.
 *  - **Incomplete coverage suppresses the under-pace verdict** and says so. If
 *    four of eleven month-to-date days have no spend figure, the pace is
 *    understated, and "you are under budget, spend more" is exactly the wrong
 *    advice to give from a hole in the data.
 *
 * The cut order is displayed verbatim, including that rank is last and only on
 * an explicit operator decision. A governor that silently cut a mid-flight rank
 * push would be worse than no governor.
 */
import type { CSSProperties, ReactNode } from 'react';
import { formatValue } from '../format.js';
import type { FormatContext } from '../format.js';
import { toneStyle, tokens } from '../theme.js';
import type { Tone } from '../theme.js';

export type PacingStatus = 'on_pace' | 'warn' | 'act' | 'underpace';

export interface PacingView {
  asOf: string;
  dayOfMonth: number;
  daysInMonth: number;
  monthlyBudget: number;
  mtdSpend: number;
  budgetToDate: number;
  pace: number | null;
  status: PacingStatus;
  daysWithData: number;
  coverageComplete: boolean;
  guidance: readonly string[];
  notes: readonly string[];
}

const STATUS_TONE: Record<PacingStatus, Tone> = {
  on_pace: 'good',
  warn: 'warn',
  act: 'bad',
  underpace: 'warn',
};

const STATUS_LABEL: Record<PacingStatus, string> = {
  on_pace: 'On pace',
  warn: 'Slightly over pace',
  act: 'Over pace — apply the cut order',
  underpace: 'Under pace',
};

export function PacingWidget({
  pacing,
  context,
}: {
  pacing: PacingView | null;
  context: FormatContext;
}): ReactNode {
  if (pacing === null) {
    return (
      <section style={card} aria-label="Pacing">
        <h3 style={heading}>Pacing</h3>
        <p style={muted}>
          No monthly ad budget is set for this profile, so there is nothing to pace against. Set one
          on the profile to turn this on — the widget will not invent a target.
        </p>
      </section>
    );
  }

  const tone = toneStyle[STATUS_TONE[pacing.status]];
  const fill = pacing.pace === null ? 0 : Math.min(1.5, Math.max(0, pacing.pace));

  return (
    <section style={card} aria-label="Pacing">
      <div style={{ alignItems: 'baseline', display: 'flex', gap: tokens.space(2) }}>
        <h3 style={heading}>Pacing</h3>
        <span
          style={{
            background: tone.background,
            border: `1px solid ${tone.border}`,
            borderRadius: tokens.radius.pill,
            color: tone.color,
            fontSize: tokens.font.size.xs,
            padding: `0.125rem ${tokens.space(2)}`,
          }}
        >
          {STATUS_LABEL[pacing.status]}
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: '1.25rem', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          {pacing.pace === null ? '—' : `${pacing.pace.toFixed(2)}×`}
        </span>
      </div>

      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={1.5}
        aria-valuenow={fill}
        aria-label="Month-to-date spend against budget-to-date"
        style={track}
      >
        <div style={{ ...trackFill, background: tone.color, width: `${(fill / 1.5) * 100}%` }} />
        {/* The 1.0 mark: budget-to-date, the line the pace is measured against. */}
        <div style={{ ...trackMark, left: `${(1 / 1.5) * 100}%` }} />
      </div>

      <dl style={figures}>
        <Figure label="MTD spend" value={formatValue(pacing.mtdSpend, 'money', context)} />
        <Figure label="Budget to date" value={formatValue(pacing.budgetToDate, 'money', context)} />
        <Figure label="Monthly budget" value={formatValue(pacing.monthlyBudget, 'money', context)} />
        <Figure label="Day" value={`${pacing.dayOfMonth} / ${pacing.daysInMonth}`} />
      </dl>

      {pacing.notes.map((note) => (
        <p key={note} style={{ ...muted, color: tokens.color.warn }}>
          {note}
        </p>
      ))}

      {pacing.guidance.length === 0 ? null : (
        <ol style={guidanceList}>
          {pacing.guidance.map((line) => (
            <li key={line}>{line.replace(/^\d+\.\s*/, '')}</li>
          ))}
        </ol>
      )}

      {pacing.coverageComplete ? null : (
        <p style={muted}>
          {pacing.daysWithData} of {pacing.dayOfMonth} month-to-date days carry a spend figure.
        </p>
      )}
    </section>
  );
}

function Figure({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div>
      <dt style={{ color: tokens.color.textMuted, fontSize: tokens.font.size.xs }}>{label}</dt>
      <dd style={{ fontVariantNumeric: 'tabular-nums', margin: 0 }}>{value}</dd>
    </div>
  );
}

const card: CSSProperties = {
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  display: 'flex',
  flexDirection: 'column',
  fontFamily: tokens.font.sans,
  fontSize: tokens.font.size.sm,
  gap: tokens.space(2),
  padding: tokens.space(3),
};

const heading: CSSProperties = { fontSize: tokens.font.size.lg, margin: 0 };

const muted: CSSProperties = { color: tokens.color.textMuted, fontSize: tokens.font.size.xs, margin: 0 };

const track: CSSProperties = {
  background: tokens.color.surfaceHover,
  borderRadius: tokens.radius.pill,
  height: '0.5rem',
  overflow: 'hidden',
  position: 'relative',
};

const trackFill: CSSProperties = { height: '100%' };

const trackMark: CSSProperties = {
  background: tokens.color.textFaint,
  height: '100%',
  position: 'absolute',
  top: 0,
  width: '1px',
};

const figures: CSSProperties = {
  display: 'grid',
  gap: tokens.space(2),
  gridTemplateColumns: 'repeat(auto-fit, minmax(7rem, 1fr))',
  margin: 0,
};

const guidanceList: CSSProperties = {
  fontSize: tokens.font.size.xs,
  margin: 0,
  paddingLeft: tokens.space(4),
};
